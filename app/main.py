import base64, datetime, hashlib, hmac, io, json, os, re, secrets, shutil, socket, tempfile, time, uuid, zipfile
from collections import defaultdict, deque
from pathlib import Path
from typing import Annotated
from urllib.parse import quote, urlsplit
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from PIL import Image, ImageOps
import segno
from app import db, jobs
from app.config import settings
from app.face_engine import borrow_engine, get_engine, pool_status
from app import photos as photos_mod
from app.photos import ALLOWED_EXTENSIONS, THUMB_DIR, make_thumbnail
from app.search_index import get_search_index

MAX_UPLOAD_BYTES=30*1024*1024
MAX_ZIP_PHOTOS=200
# scripts/serve.py 启动时写的状态档：现在是区网还是对外
RUNTIME_FILE=settings.photo_dir.parent/'runtime.json'
# 网址里的 token 就是档名 uuid，同一个网址内容永远不变，可以放心长期快取
CACHE_FOREVER={'Cache-Control':'private, max-age=31536000, immutable'}
REJECTED_THUMB_DIR=settings.photo_dir.parent/'thumbnails_rejected'
EVENT_TEXT_FIELDS=('name','date','venue','photographer','contact')
BAD_FILENAME_CHARS=re.compile(r'[\\/:*?"<>|\x00-\x1f]+')

app=FastAPI(title=settings.app_name)
templates=Jinja2Templates(directory='app/templates')
class NoCacheStatic(StaticFiles):
    """js/css 每次都跟伺服器确认一下有没有新版。

    预设的快取规则会让改过的 js/css 在手机上不生效，使用者只能猜要不要「下拉重新整理」。
    档案很小，而且没改的话回的是 304（不重传内容），代价可以忽略。
    """
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers['Cache-Control'] = 'no-cache'
        return response

app.mount('/static', NoCacheStatic(directory='app/static'), name='static')

@app.on_event('startup')
def startup():
    settings.photo_dir.mkdir(parents=True, exist_ok=True)
    db.init_db()
    # 上次伺服器是在批次跑到一半时结束的：把那些工作标成中断，暂存档清掉
    n_jobs=db.fail_orphan_jobs(); n_dirs=jobs.clean_incoming()
    if n_jobs or n_dirs: print(f'[startup] 中断的批次 {n_jobs} 个，清掉暂存资料夹 {n_dirs} 个')
    # 不是用启动器开的，就把上次留下的状态档清掉 —— 否则 /admin 会显示错误的模式，
    # 让人以为照片只在区网内传，其实通道还开着（或相反）。
    if not os.environ.get('EFM_LAUNCHER'):
        RUNTIME_FILE.unlink(missing_ok=True)
    get_engine(); get_search_index()

ACCESS_COOKIE = 'efm_access'

def constant_eq(a, b):
    """compare_digest 只吃 ASCII，来路不明的字串要先挡掉，不然会抛例外。"""
    try:
        return secrets.compare_digest(a, b)
    except (TypeError, ValueError):
        return False

def basic_ok(request:Request):
    """手机键盘会把第一个字母自动大写、贴上时常带空白，来宾因此一直被退回重输。
    所以帐号不分大小写、两边去掉前后空白；密码仍逐字比对。"""
    header=request.headers.get('authorization','')
    if not header.startswith('Basic '):
        return False, None
    try:
        user,_,pwd=base64.b64decode(header[6:]).decode('utf-8').partition(':')
    except Exception:
        return False, None
    ok=(constant_eq(user.strip().casefold(), settings.site_user.strip().casefold())
        and constant_eq(pwd.strip(), settings.site_password.strip()))
    return ok, user

def is_https(request:Request):
    return (request.headers.get('x-forwarded-proto','').split(',')[0].strip() == 'https'
            or request.url.scheme == 'https')

def client_ip(request:Request):
    return (request.headers.get('cf-connecting-ip')
            or request.headers.get('x-forwarded-for','').split(',')[0].strip()
            or (request.client.host if request.client else '?'))

@app.middleware('http')
async def site_password_gate(request:Request, call_next):
    """整站密码。设了 SITE_PASSWORD 之后，连 /admin 与照片网址都要先过这一关。

    来宾走的是另一条路：QR code 网址带 ?k=<钥匙>，认过就发一个 cookie，
    之后都不用再打任何东西 —— 婚礼现场不可能叫几十个人手打一串密码。
    """
    if not settings.site_password:
        return await call_next(request)

    ok, who = basic_ok(request)

    if not ok and settings.site_access_token:
        if constant_eq(request.cookies.get(ACCESS_COOKIE,''), settings.site_access_token):
            ok = True
        elif constant_eq(request.query_params.get('k',''), settings.site_access_token):
            # 钥匙对了：发 cookie，并把 ?k= 从网址上拿掉
            #（留在网址列会被截图、被分享、留在浏览纪录里）
            clean = request.url.remove_query_params('k')
            response = RedirectResponse(str(clean), status_code=303)
            response.set_cookie(ACCESS_COOKIE, settings.site_access_token,
                                max_age=settings.access_cookie_hours*3600,
                                httponly=True, samesite='lax', secure=is_https(request),
                                path='/')
            return response

    if not ok:
        # 只记帐号，绝不记密码 —— 卡在登入时才查得出是打错哪一个
        print(f'[auth] 401 path={request.url.path} ip={client_ip(request)} '
              f'帐号={"（没送）" if who is None else repr(who)}', flush=True)
        return Response(status_code=401,
                        headers={'WWW-Authenticate':'Basic realm="Event photos", charset="UTF-8"'})
    return await call_next(request)

_hits=defaultdict(deque)

def rate_limit(request:Request, bucket='search', per_min=None):
    """每个来源 IP 每分钟最多搜寻几次 —— 避免有人拿别人的照片大量试。
    bucket 分开计：来宾按「全部下载」不该吃掉他的搜寻次数。"""
    limit=per_min or settings.search_rate_per_min
    now=time.monotonic(); hits=_hits[(bucket, client_ip(request))]
    while hits and now-hits[0]>60: hits.popleft()
    if len(hits)>=limit:
        what='searches' if bucket=='search' else 'downloads'
        raise HTTPException(429,f'Too many {what}. Please wait a minute and try again.')
    hits.append(now)

TOKEN_RE=re.compile(r'^[0-9a-f]{32}$')

def find_photo(token):
    if not TOKEN_RE.match(token or ''): return None
    with db.connection() as con:
        return con.execute("SELECT id,filename,original_name,content_type FROM photos WHERE filename LIKE ?",
                           (token+'.%',)).fetchone()

def photo_by_token(token:str):
    """用档名（uuid）而不是流水号查照片：流水号可以从 1 一路猜下去，把整个相簿抓走。"""
    row=find_photo(token)
    if row is None: raise HTTPException(404,'Photo not found.')
    return row

def photo_urls(stem):
    """一张照片的各种尺寸网址，加上缩图宽高（前端排版要先知道比例）。"""
    size=photos_mod.thumb_size(stem)
    return {'token':stem,'thumb_url':f'/thumb/{stem}','view_url':f'/view/{stem}',
            'photo_url':f'/photo/{stem}','download_url':f'/photo/{stem}?dl=1',
            'w':size[0] if size else None,'h':size[1] if size else None}

def photo_row(row, cover=None):
    r=dict(row); stem=Path(r.pop('filename')).stem
    r.update(photo_urls(stem))
    if cover is not None: r['is_cover']=stem==cover
    return r

def download_name(row):
    """下载时的档名：原始档名 + 实际存档的副档名（HEIC 存档时已经转成 .jpg）。"""
    stem=BAD_FILENAME_CHARS.sub('_',Path(row['original_name'] or 'photo').stem)[:120] or 'photo'
    return stem+Path(row['filename']).suffix

def require_admin(key):
    if not key or not secrets.compare_digest(key, settings.admin_api_key):
        raise HTTPException(401, 'Invalid admin key.')

async def read_upload(upload):
    data=await upload.read()
    if not data: raise HTTPException(400,'Empty upload.')
    if len(data)>MAX_UPLOAD_BYTES: raise HTTPException(413,'Image is too large.')
    return data

def safe_extension(name):
    suffix=Path(name or '').suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS: raise HTTPException(400,'Unsupported image type.')
    return suffix

# ---- 活动资料（名称、日期、封面、来宾搜寻开关）-----------------------------------

def event_info():
    """来宾页（伺服器端直接画出来，不会闪）与管理页共用。"""
    ev=db.get_event()
    info={k:(ev.get(k) or '') for k in EVENT_TEXT_FIELDS}
    info['guest_open']=ev.get('guest_open','1')!='0'
    cover=ev.get('cover') or ''
    info['cover']=photo_urls(cover) if find_photo(cover) else None
    return info

def pretty_date(value):
    """'2026-10-12' -> '12 October 2026'（Windows 的 strftime 不支援 %-d，所以自己拼）"""
    try: d=datetime.date.fromisoformat(value or '')
    except ValueError: return ''
    return f'{d.day} {d:%B %Y}'

@app.get('/', response_class=HTMLResponse)
def home(request:Request):
    ev=event_info(); count=db.stats()['photos']
    title=ev['name'] or 'Event photos'
    meta=[x for x in (ev['venue'], pretty_date(ev['date'])) if x]
    cover=ev['cover']
    # 封面照片的长宽比先算好放进 CSS 变数：图还没载入前版面就定型，不会跳
    ratio=cover['w']/cover['h'] if cover and cover['w'] and cover['h'] else 1.5
    page={'title':title,'photoCount':count,'searchOpen':ev['guest_open'] and count>0}
    return templates.TemplateResponse(request=request,name='index.html',context={
        'app_name':settings.app_name,'event':ev,'title':title,'meta':meta,
        'cover':cover,'cover_style':f'--r: {ratio:.4f}',
        'cover_w':round(2048*min(1,ratio)),'cover_h':round(2048*min(1,1/ratio)),
        'photo_count':count,'photo_count_text':f'{count:,}','page':page})

@app.get('/admin', response_class=HTMLResponse)
def admin_page(request:Request):
    return templates.TemplateResponse(request=request,name='admin.html',context={'app_name':settings.app_name})

def runtime_mode():
    if not RUNTIME_FILE.exists():
        return {'mode':'unknown','public_url':None,'lan_url':None,
                'note':'不是用 scripts/serve.py 启动的，无法判断是否对外开放。'}
    try:
        return {'public_url':None,'lan_url':None,
                **json.loads(RUNTIME_FILE.read_text(encoding='utf-8-sig')),'note':None}
    except Exception:
        return {'mode':'unknown','public_url':None,'lan_url':None,'note':'状态档读不出来。'}

@app.get('/api/mode')
def mode():
    """目前是区网还是对外 —— /admin 的网路状态用的。"""
    return runtime_mode()

@app.get('/api/stats')
def stats(): return db.stats()

@app.get('/api/admin/engine')
def engine_info(x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    return pool_status()

def count_rejected():
    folder=photos_mod.REJECTED_DIR
    return sum(1 for f in folder.iterdir() if f.is_file()) if folder.is_dir() else 0

def access_config():
    """来宾怎么进得来：整站密码有没有开、QR 里的钥匙有没有开。
    没开整站密码时钥匙等於没作用（网站本来就不上锁）。"""
    locked=bool(settings.site_password)
    return {'password_required':locked,'token_enabled':locked and bool(settings.site_access_token),
            'site_user':settings.site_user,'cookie_hours':settings.access_cookie_hours}

@app.get('/api/admin/overview')
def overview(x_admin_key:Annotated[str|None,Header()]=None):
    """管理页一次拿齐：总览、侧栏上的数字、网路状态、目前的比对设定。"""
    require_admin(x_admin_key)
    _, latest=db.list_photos(14, 0)
    return {'app_name':settings.app_name,'event':event_info(),
            'stats':{**db.stats(),'not_searchable':count_rejected()},
            'latest':[photo_row(r) for r in latest],
            'batches':db.recent_batches(6),'mode':runtime_mode(),'access':access_config(),
            'activity':db.search_activity(),
            'matching':{'match_threshold':settings.match_threshold,'min_face_size':settings.min_face_size,
                        'max_results':settings.max_results,'search_rate_per_min':settings.search_rate_per_min}}

# ---- 来宾入口：QR code、网址、网路 -------------------------------------------

LOOPBACK={'127.0.0.1','localhost','::1'}

def lan_ip():
    """本机在区网里的位址（跟 scripts/serve.py 同一招：不会真的送出封包）。"""
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8',80)); return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()

def guest_base(request:Request, rt):
    """QR code 要带哪个网址：对外模式用通道网址，区网模式用区网网址。
    不是用启动器开的，就从这次连线推测 —— 在本机开管理页时换成区网 IP，否则手机扫了连不到。"""
    if rt.get('mode')=='public' and rt.get('public_url'): return rt['public_url']
    if rt.get('lan_url'): return rt['lan_url']
    if (request.url.hostname or '') in LOOPBACK:
        port=request.url.port
        return f'http://{lan_ip()}'+(f':{port}' if port else '')
    return str(request.base_url)

@app.get('/api/admin/access')
def guest_access(request:Request, x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    rt=runtime_mode(); cfg=access_config()
    base=guest_base(request, rt).rstrip('/')
    url=f'{base}/?k={settings.site_access_token}' if cfg['token_enabled'] else f'{base}/'
    qr=segno.make(url, error='m')
    return {'guest_url':url,'base_url':base,
            'local_only':(urlsplit(base).hostname or '') in LOOPBACK,
            'qr_svg':qr.svg_data_uri(scale=10,border=0,dark='#171717',light=None),
            'qr_png':qr.png_data_uri(scale=16,border=4,dark='#171717',light='#ffffff'),
            'mode':rt,**cfg,'activity':db.search_activity(),'event':event_info()}

class EventUpdate(BaseModel):
    name: str|None = Field(None, max_length=120)
    date: str|None = Field(None, max_length=10)
    venue: str|None = Field(None, max_length=120)
    photographer: str|None = Field(None, max_length=80)
    contact: str|None = Field(None, max_length=120)
    cover: str|None = Field(None, max_length=32)
    guest_open: bool|None = None

@app.get('/api/admin/event')
def read_event(x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    return event_info()

@app.put('/api/admin/event')
def update_event(body:EventUpdate, x_admin_key:Annotated[str|None,Header()]=None):
    """只改有送来的栏位：开关来宾搜寻、换封面，都不必把整张表单再送一次。"""
    require_admin(x_admin_key)
    values={}
    for k,v in body.model_dump(exclude_unset=True).items():
        if k=='guest_open':
            values[k]='0' if v is False else '1'; continue
        v=(v or '').strip()
        if k=='date' and v:
            try: datetime.date.fromisoformat(v)
            except ValueError: raise HTTPException(422,'Use a date like 2026-10-12.')
        if k=='cover' and v and find_photo(v) is None:
            raise HTTPException(422,'That photo is no longer in the library.')
        values[k]=v
    if values: db.set_event(values)
    return event_info()

# ---- 上传与建索引 ------------------------------------------------------------

@app.post('/api/admin/photos')
async def upload_photos(files:Annotated[list[UploadFile],File(...)], batch:Annotated[str|None,Form()]=None,
                        x_admin_key:Annotated[str|None,Header()]=None):
    """只负责把档案收下来存好，然后马上回话。

    人脸识别交给 app.jobs 的背景工人 —— 否则整批跑完之前，
    伺服器没空回应来宾的搜寻（200 张会冻结好几分钟）。

    管理页会把一大批切成好几次小上传（每次几 MB），各自是一个 job，用 batch 串成同一批。
    一次送 1 GB 的话，走 Cloudflare 通道 100 秒就会被切断（524）。
    """
    require_admin(x_admin_key)
    if batch is not None and not TOKEN_RE.match(batch): raise HTTPException(400,'Invalid batch id.')
    job_id=uuid.uuid4().hex; folder=jobs.job_dir(job_id); folder.mkdir(parents=True, exist_ok=True)
    manifest=[]; rejected=[]
    try:
        for i,upload in enumerate(files):
            try:
                suffix=safe_extension(upload.filename); data=await read_upload(upload)
            except HTTPException as exc:
                rejected.append({'filename':upload.filename,'error':exc.detail}); continue
            stored=f'{i:05d}{suffix}'
            await run_in_threadpool((folder/stored).write_bytes, data)
            manifest.append({'stored':stored,'original_name':upload.filename or stored,
                             'content_type':upload.content_type})
        if not manifest:
            shutil.rmtree(folder, ignore_errors=True)
            raise HTTPException(400, rejected[0]['error'] if rejected else 'No files uploaded.')
        (folder/jobs.MANIFEST_NAME).write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
    except HTTPException:
        raise
    except Exception:
        shutil.rmtree(folder, ignore_errors=True); raise
    db.create_job(job_id,len(manifest),batch); jobs.submit(job_id)
    return {'job_id':job_id,'batch':batch,'queued':len(manifest),'rejected':rejected,'stats':db.stats()}

def job_payload(row):
    d=dict(row)
    try: d['failures']=json.loads(d.get('failures') or '[]')
    except ValueError: d['failures']=[]
    return d

@app.get('/api/admin/jobs/{job_id}')
def job_status(job_id:str, x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    row=db.get_job(job_id)
    if row is None: raise HTTPException(404,'Job not found.')
    return {**job_payload(row),'stats':db.stats()}

@app.get('/api/admin/jobs')
def job_list(x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    return {'jobs':[job_payload(r) for r in db.recent_jobs()],'stats':db.stats()}

@app.get('/api/admin/batches')
def batch_list(x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    return {'batches':db.recent_batches(10)}

@app.get('/api/admin/batches/{batch_id}')
def batch_status(batch_id:str, x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    b=db.get_batch(batch_id)
    if b is None: raise HTTPException(404,'Batch not found.')
    return {**b,'stats':db.stats()}

# ---- 来宾搜寻与看照片 ----------------------------------------------------------

def run_search(data):
    """人脸识别是吃 CPU 的同步工作，放在 threadpool 里跑，事件圈才能继续接其他请求。

    跟引擎池借一份来算：池子有几份，就有几个人可以同时算，其余的人排队。
    """
    with borrow_engine() as engine:
        frame=engine.decode_image(data)
        query=engine.extract_query(frame)
    matches=get_search_index().search(query)
    db.record_search(len(matches))
    # 结果也在这里组好：第一次要读每张缩图的宽高（开档），别卡在事件圈上
    return [{
        'photo_id':m['photo_id'],'original_name':m['original_name'],
        **photo_urls(Path(m['filename']).stem),
        'similarity':round(float(m['similarity']),5),'matched_face':{'x':m['x'],'y':m['y'],'w':m['w'],'h':m['h']}
    } for m in matches]

@app.post('/api/search')
async def search(request:Request, image:Annotated[UploadFile,File(...)], biometric_consent:Annotated[bool,Form(...)]):
    rate_limit(request)
    if not biometric_consent: raise HTTPException(400,'Explicit biometric matching consent is required.')
    # 摄影师在管理页按了「暂停」（例如照片还没传完）
    if db.get_event().get('guest_open','1')=='0':
        raise HTTPException(403,'Search is paused right now. Please check back soon.')
    safe_extension(image.filename); data=await read_upload(image)
    try:
        matches=await run_in_threadpool(run_search,data)
    except ValueError as exc:
        msg=str(exc)
        if 'dimensionality' in msg:
            raise HTTPException(503,'Search index was built with a different face model. Run: python scripts/reindex.py') from exc
        raise HTTPException(422,msg) from exc
    return {'count':len(matches),'threshold':settings.match_threshold,'matches':matches}

@app.get('/photo/{token}')
def photo(token:str, dl:int=0):
    row=photo_by_token(token)
    path=settings.photo_dir/row['filename']
    if not path.exists(): raise HTTPException(404,'Photo file missing.')
    # dl=1：来宾按「下载」。附上原始档名，并明说是下载 —— iOS Safari 不一定理会 <a download>
    return FileResponse(path,media_type=row['content_type'] or 'application/octet-stream',
                        filename=download_name(row) if dl else None,headers=CACHE_FOREVER)

@app.get('/view/{token}')
def view(token:str):
    """全萤幕看照片用的中尺寸（长边 2048）。建索引时就做好了，旧照片第一次被看到时才补做。"""
    row=photo_by_token(token)
    stem=Path(row['filename']).stem; out=photos_mod.DISPLAY_DIR/f'{stem}.jpg'
    if not out.exists():
        src=settings.photo_dir/row['filename']
        if not src.exists(): raise HTTPException(404,'Photo file missing.')
        with Image.open(src) as im:
            # JPEG 可以直接用缩小的尺度解码，比整张解开再缩快好几倍
            im.draft('RGB',(photos_mod.DISPLAY_MAX_EDGE,photos_mod.DISPLAY_MAX_EDGE))
            photos_mod.make_display(ImageOps.exif_transpose(im).convert('RGB'),stem)
    return FileResponse(out,media_type='image/jpeg',headers=CACHE_FOREVER)

@app.get('/thumb/{token}')
def thumb(token:str):
    row=photo_by_token(token)
    stem=Path(row['filename']).stem; out=THUMB_DIR/f'{stem}.jpg'
    if not out.exists():
        # 旧照片（阶段 2 之前上传的）第一次被看到时才补做缩图
        src=settings.photo_dir/row['filename']
        if not src.exists(): raise HTTPException(404,'Photo file missing.')
        with Image.open(src) as im:
            make_thumbnail(ImageOps.exif_transpose(im).convert('RGB'),stem)
    return FileResponse(out,media_type='image/jpeg',headers=CACHE_FOREVER)

@app.post('/api/download')
def download_zip(request:Request, t:Annotated[list[str],Form()]):
    """来宾的「全部下载」：把他找到的原图打包成一个 zip。

    只收网址里的 token（本来就拿得到这些照片），不收流水号。
    """
    rate_limit(request, bucket='zip', per_min=6)
    stems=[s for s in dict.fromkeys(t) if TOKEN_RE.match(s)][:MAX_ZIP_PHOTOS]
    rows=db.photos_by_stems(stems)
    if not rows: raise HTTPException(404,'No photos to download.')
    tmp=tempfile.NamedTemporaryFile(prefix='efm_',suffix='.zip',delete=False); tmp.close()
    used=set()
    try:
        # JPEG 本来就压缩过了，zip 再压一次只是浪费 CPU，所以用 STORED
        with zipfile.ZipFile(tmp.name,'w',compression=zipfile.ZIP_STORED) as zf:
            for row in rows:
                src=settings.photo_dir/row['filename']
                if not src.exists(): continue
                name=download_name(row); base,ext=os.path.splitext(name); n=2
                while name.lower() in used:
                    name=f'{base} ({n}){ext}'; n+=1
                used.add(name.lower()); zf.write(src,name)
    except Exception:
        os.unlink(tmp.name); raise
    title=BAD_FILENAME_CHARS.sub('',db.get_event().get('name') or '').strip() or 'Event'
    return FileResponse(tmp.name,media_type='application/zip',filename=f'{title} photos.zip',
                        background=BackgroundTask(os.unlink,tmp.name))

# ---- 相簿管理（清单 / 删除 / 看被排除的照片）--------------------------------

SAFE_NAME = re.compile('^[^/\\\\:\\*\\?"<>\\|]{1,120}$')

def rejected_path(name):
    """被排除的照片放在 data/photos_rejected，档名是原始档名，所以要挡路径穿越。"""
    if not SAFE_NAME.match(name or '') or name in ('.', '..'):
        raise HTTPException(404, 'Not found.')
    folder = photos_mod.REJECTED_DIR.resolve()
    target = (folder / name).resolve()
    if target.parent != folder or not target.is_file():
        raise HTTPException(404, 'Not found.')
    return target

def rejected_sig(name):
    """被排除照片网址上的签章。这些档名是原始档名（IMG_0001.jpg 之类），猜得到；
    没有签章的话，任何进得了网站的来宾都能一张一张猜来看。<img> 送不了管理密钥，所以用签章。"""
    return hmac.new(settings.admin_api_key.encode(),('rejected:'+name).encode(),'sha256').hexdigest()[:24]

def check_sig(name, s):
    if not constant_eq(s or '', rejected_sig(name)): raise HTTPException(404,'Not found.')

def rejected_thumb_path(name):
    return REJECTED_THUMB_DIR/(hashlib.sha1(name.encode('utf-8')).hexdigest()[:24]+'.jpg')

def remove_rejected(name):
    rejected_path(name).unlink()
    rejected_thumb_path(name).unlink(missing_ok=True)
    db.delete_rejected_record(name)

def remove_photo(photo_id):
    """删掉一张：原图、缩图、大图、资料库纪录；是封面的话一并清掉封面。回传有没有删到。"""
    with db.connection() as con: row=con.execute('SELECT filename FROM photos WHERE id=?',(photo_id,)).fetchone()
    if row is None: return False
    stem=Path(row['filename']).stem
    (settings.photo_dir/row['filename']).unlink(missing_ok=True); (THUMB_DIR/f'{stem}.jpg').unlink(missing_ok=True)
    (photos_mod.DISPLAY_DIR/f'{stem}.jpg').unlink(missing_ok=True)
    db.delete_photo_record(photo_id)
    if db.get_event().get('cover')==stem: db.set_event({'cover':''})
    return True

@app.get('/api/admin/photos')
def list_photos(limit:int=50, offset:int=0, q:str='', x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    total, rows = db.list_photos(min(max(limit,1),200), max(offset,0), q.strip()[:100])
    cover = db.get_event().get('cover') or ''
    return {'total':total,'offset':offset,'photos':[photo_row(r, cover) for r in rows]}

@app.get('/api/admin/rejected')
def list_rejected(x_admin_key:Annotated[str|None,Header()]=None):
    """没进索引的照片 —— 摄影师要知道漏了哪几张、为什么，不然会以为系统吃掉了。"""
    require_admin(x_admin_key)
    folder = photos_mod.REJECTED_DIR
    if not folder.is_dir():
        return {'total':0,'files':[]}
    reasons=db.rejected_reasons(); items=[]
    for f in sorted((p for p in folder.iterdir() if p.is_file()), key=lambda x: x.stat().st_mtime, reverse=True):
        st=f.stat(); meta=reasons.get(f.name,{}); q=quote(f.name); s=rejected_sig(f.name)
        items.append({'name':f.name,'size_kb':round(st.st_size/1024),
                      # 跟 SQLite 的 CURRENT_TIMESTAMP 同格式（UTC），前端只要一种解析方式
                      'modified':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S'),
                      'reason':meta.get('reason','unknown'),'faces':meta.get('faces',0),
                      'largest':meta.get('largest'),'min_size':meta.get('min_size'),
                      'url':f'/rejected/{q}?s={s}','thumb_url':f'/rejected-thumb/{q}?s={s}',
                      'download_url':f'/rejected/{q}?s={s}&dl=1'})
    return {'total':len(items),'files':items}

@app.get('/rejected/{name}')
def rejected_file(name:str, s:str='', dl:int=0):
    check_sig(name, s)
    return FileResponse(rejected_path(name), filename=name if dl else None)

@app.get('/rejected-thumb/{name}')
def rejected_thumb(name:str, s:str=''):
    """被排除照片的缩图：常有 20 MB 的单眼原图（没有人的场景照），清单里不能直接载原图。"""
    check_sig(name, s)
    src=rejected_path(name); out=rejected_thumb_path(name)
    if not out.exists():
        try:
            with Image.open(src) as im:
                im.draft('RGB',(photos_mod.THUMB_MAX_EDGE,photos_mod.THUMB_MAX_EDGE))
                img=ImageOps.exif_transpose(im).convert('RGB')
            img.thumbnail((photos_mod.THUMB_MAX_EDGE,photos_mod.THUMB_MAX_EDGE))
            REJECTED_THUMB_DIR.mkdir(parents=True, exist_ok=True)
            img.save(out,'JPEG',quality=82)
        except Exception:
            raise HTTPException(404,'No preview for this file.')
    return FileResponse(out,media_type='image/jpeg',headers={'Cache-Control':'no-cache'})

@app.delete('/api/admin/rejected/{name}')
def delete_rejected(name:str, x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    remove_rejected(name)
    return {'deleted':True,'name':name}

class NameList(BaseModel):
    names: list[str] = Field(..., min_length=1, max_length=2000)

@app.post('/api/admin/rejected/delete')
def delete_rejected_many(body:NameList, x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    deleted=[]
    for name in dict.fromkeys(body.names):
        try:
            remove_rejected(name); deleted.append(name)
        except HTTPException:
            pass
    return {'deleted':deleted}

@app.delete('/api/admin/photo/{photo_id}')
def delete_photo(photo_id:int,x_admin_key:Annotated[str|None,Header()]=None):
    require_admin(x_admin_key)
    if not remove_photo(photo_id): raise HTTPException(404,'Photo not found.')
    get_search_index().reload()
    return {'deleted':True,'photo_id':photo_id}

class PhotoIds(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)

@app.post('/api/admin/photos/delete')
def delete_photos(body:PhotoIds, x_admin_key:Annotated[str|None,Header()]=None):
    """一次删多张。索引只重载一次 —— 一张一张删的话，每删一张都要把整个索引重读一遍。"""
    require_admin(x_admin_key)
    deleted=[pid for pid in dict.fromkeys(body.ids) if remove_photo(pid)]
    if deleted: get_search_index().reload()
    return {'deleted':deleted}

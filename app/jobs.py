"""背景建索引（阶段 3）。

阶段 3 之前：上传端点自己一张一张跑人脸识别，跑完才回话。
200 张 ≈ 4~7 分钟，这段时间整个网站没反应，来宾按搜寻像是坏了。

现在：上传端点只把档案落地到 data/incoming/<job_id>/，马上回一个 job_id；
真正的识别交给这里的「单一工人」慢慢跑，进度写进资料库供摄影师查询。
"""

import json
import shutil
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app import db, photos
from app.config import settings
from app.face_engine import borrow_engine, get_engine

INCOMING_DIR = settings.photo_dir.parent / 'incoming'
MANIFEST_NAME = 'manifest.json'
MAX_FAILURES_KEPT = 50

# 一次只有一个工人：人脸识别本来就吃满 CPU，同时跑两批只会一起变慢，
# 而且要留余裕给来宾的搜寻（引擎一次只跑一张，所以来宾最多等一张照片的时间）。
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='indexer')


def job_dir(job_id):
    return INCOMING_DIR / job_id


def submit(job_id):
    _pool.submit(_run, job_id)


def _run(job_id):
    folder = job_dir(job_id)
    try:
        manifest = json.loads((folder / MANIFEST_NAME).read_text(encoding='utf-8'))
    except Exception as exc:
        db.finish_job(job_id, 'error', f'Cannot read staged upload: {exc}')
        return

    db.update_job(job_id, status='running')
    get_engine()  # 确保模型已载入（启动时就做过了）
    indexed = failed = faces = 0
    failures = []

    for item in manifest:
        path = folder / item['stored']
        name = item.get('original_name') or item['stored']
        db.update_job(job_id, current=name)
        try:
            # 每张借一次：批次跑很久，不能整段霸占同一份引擎让来宾没得用
            with borrow_engine() as engine:
                result = photos.store_and_index(engine, path.read_bytes(), name,
                                                Path(item['stored']).suffix.lower(),
                                                item.get('content_type'))
            indexed += 1
            faces += result['faces']
        except photos.NoUsableFace as exc:
            failed += 1
            if len(failures) < MAX_FAILURES_KEPT:
                info = {k: v for k, v in exc.info.items() if k != 'message'}
                failures.append({'filename': name, 'error': str(exc), **info})
        except Exception as exc:
            # 单张坏档不中断整批
            failed += 1
            traceback.print_exc()
            # 打不开的档案也留一份在「没进索引」里：以前直接丢掉，摄影师根本不知道少了它
            reason = 'unreadable' if 'decode' in str(exc).lower() else 'error'
            try:
                kept = photos.save_rejected(path.read_bytes(), name, Path(item['stored']).suffix.lower())
                db.add_rejected(kept.name, name, reason)
            except Exception:
                traceback.print_exc()
            if len(failures) < MAX_FAILURES_KEPT:
                failures.append({'filename': name, 'error': str(exc), 'reason': reason})
        finally:
            path.unlink(missing_ok=True)
            db.update_job(job_id, done=indexed + failed, indexed=indexed, failed=failed,
                          faces=faces, failures=json.dumps(failures, ensure_ascii=False))

    shutil.rmtree(folder, ignore_errors=True)
    db.finish_job(job_id, 'done')


def clean_incoming():
    """伺服器启动时清掉上次没跑完留下的暂存档（对应的工作已标成 interrupted）。"""
    if not INCOMING_DIR.exists():
        return 0
    n = 0
    for folder in INCOMING_DIR.iterdir():
        if folder.is_dir():
            shutil.rmtree(folder, ignore_errors=True)
            n += 1
    return n

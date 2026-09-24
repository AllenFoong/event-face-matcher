"""照片落地 + 建索引。

上传端点与背景工人共用这一段，两边行为才会完全一致
（阶段 3 之前这段逻辑写在 main.py 的上传端点里）。
"""

import io
import mimetypes
import os
import uuid
from pathlib import Path

from PIL import Image

from app import db
from app.config import settings
from app.search_index import get_search_index

ALLOWED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif'}
# 浏览器无法显示 HEIC，存档时转成 JPEG；其他格式保留原档
BROWSER_UNFRIENDLY = {'.heic', '.heif', '.tif', '.tiff'}

# 缩图：结果页只载这个，点开才载原图。手机在活动现场 WiFi 下差别很大。
THUMB_DIR = settings.photo_dir.parent / 'thumbnails'
# 看大图用的中尺寸：原图常常 5~20 MB，全萤幕看只需要这个；「下载」才给原图
DISPLAY_DIR = settings.photo_dir.parent / 'display'
# 没有可用人脸的照片不会进索引，但也别直接丢掉 —— 存这里，摄影师才知道少了哪几张
REJECTED_DIR = settings.photo_dir.parent / 'photos_rejected'
THUMB_MAX_EDGE = 512
THUMB_QUALITY = 85
DISPLAY_MAX_EDGE = 2048
DISPLAY_QUALITY = 80


def make_thumbnail(image_rgb, stem):
    """image_rgb 必须已经转正。输出 data/thumbnails/<stem>.jpg。"""
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    thumb = image_rgb.copy()
    thumb.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
    out = THUMB_DIR / f'{stem}.jpg'
    thumb.save(out, 'JPEG', quality=THUMB_QUALITY, optimize=True)
    return out


def make_display(image_rgb, stem):
    """image_rgb 必须已经转正。输出 data/display/<stem>.jpg（长边 2048）。

    先写暂存档再改名：两个来宾同时点开同一张还没做好的大图时，
    其中一个才不会读到写到一半的档案。
    """
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    img = image_rgb
    if max(img.size) > DISPLAY_MAX_EDGE:
        img = img.copy()
        img.thumbnail((DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE), Image.Resampling.LANCZOS)
    out = DISPLAY_DIR / f'{stem}.jpg'
    tmp = DISPLAY_DIR / f'{stem}.{uuid.uuid4().hex[:8]}.tmp'
    # progressive：慢网路下先出现模糊的整张，再慢慢变清楚，而不是一条一条往下画
    img.save(tmp, 'JPEG', quality=DISPLAY_QUALITY, optimize=True, progressive=True)
    os.replace(tmp, out)
    return out


_SIZE_CACHE = {}


def thumb_size(stem):
    """缩图的 (宽, 高)，已经转正。来宾页排瀑布流要先知道每张的比例，图载入时版面才不会跳。

    只快取读得到的；缩图还没做好就回 None（前端先用 4:3 占位）。
    """
    size = _SIZE_CACHE.get(stem)
    if size is None:
        try:
            with Image.open(THUMB_DIR / f'{stem}.jpg') as im:
                size = im.size
        except OSError:
            return None
        if len(_SIZE_CACHE) > 50000:
            _SIZE_CACHE.clear()
        _SIZE_CACHE[stem] = size
    return size


class NoUsableFace(Exception):
    """照片里没有可用的人脸 —— 不是错误，只是这张不进索引。info 见 rejection_info()。"""

    def __init__(self, info):
        super().__init__(info['message'])
        self.info = info


def describe_rejection(faces):
    """讲清楚到底是「没看到脸」还是「看到了但不合格」。

    旧讯息一律写 'No usable faces detected.'，害人以为照片里没有人；
    实际上常常是脸侦测到了、只是太小（照片被转传压缩过）。
    """
    if not faces:
        return 'No faces found in this photo.'
    counts = {}
    for f in faces:
        for r in f.quality_reasons:
            counts[r] = counts.get(r, 0) + 1
    parts, advice = [], ''
    if counts.get('too_small'):
        biggest = max(min(f.w, f.h) for f in faces)
        parts.append(f"{counts['too_small']} too small (largest {biggest} px, "
                     f"minimum {settings.min_face_size} px)")
        advice = ' Probably a compressed copy; upload the original.'
    if counts.get('low_det_score'):
        best = max(f.detection_score for f in faces)
        parts.append(f"{counts['low_det_score']} unclear (best score {best:.2f}, "
                     f"minimum {settings.detection_score_threshold})")
    return f"Found {len(faces)} face(s), none usable: " + "; ".join(parts) + "." + advice


def rejection_info(faces):
    """同一件事的资料版：管理页用 reason 分类、用数字组句子，不必去解析讯息文字。

    reason：no_face（整张没有脸）/ too_small（有脸但太小，多半是压缩过的图）/
    low_confidence（有像脸的东西但太模糊、太暗、太侧）。
    """
    info = {'reason': 'no_face', 'faces': len(faces), 'largest': None,
            'min_size': settings.min_face_size, 'message': describe_rejection(faces)}
    if faces:
        info['largest'] = max(min(f.w, f.h) for f in faces)
        small = any('too_small' in f.quality_reasons for f in faces)
        info['reason'] = 'too_small' if small else 'low_confidence'
    return info


def save_rejected(data, original_name, suffix):
    """把不进索引的照片留一份，档名尽量维持原样。回传存到哪。"""
    REJECTED_DIR.mkdir(parents=True, exist_ok=True)
    stem = Path(original_name or 'photo').stem or 'photo'
    out = REJECTED_DIR / f'{stem}{suffix}'
    n = 2
    while out.exists():
        out = REJECTED_DIR / f'{stem}_{n}{suffix}'
        n += 1
    out.write_bytes(data)
    return out


def store_and_index(engine, data, original_name, suffix, content_type=None):
    """跑人脸识别、存档、写资料库、把新的脸直接加进搜寻索引。

    中途失败会把已经写下去的照片与资料库纪录清掉再抛出，不留半成品。
    回传 {'photo_id', 'filename', 'faces', 'faces_rejected'}。
    """
    image = engine.decode_image(data)
    faces = engine.extract_all(image)
    usable = [f for f in faces if f.quality_ok]
    if not usable:
        info = rejection_info(faces)
        kept = save_rejected(data, original_name, suffix)
        db.add_rejected(kept.name, original_name, info['reason'], info['faces'],
                        info['largest'], info['min_size'])
        raise NoUsableFace(info)

    if suffix in BROWSER_UNFRIENDLY:
        buf = io.BytesIO()
        Image.fromarray(image[:, :, ::-1]).save(buf, 'JPEG', quality=92)
        data, suffix, content_type = buf.getvalue(), '.jpg', 'image/jpeg'
    if not content_type:
        content_type = mimetypes.guess_type('x' + suffix)[0]

    stored_name = f'{uuid.uuid4().hex}{suffix}'
    stored_path = settings.photo_dir / stored_name
    photo_id = None
    try:
        settings.photo_dir.mkdir(parents=True, exist_ok=True)
        stored_path.write_bytes(data)
        photo_id = db.add_photo(stored_name, original_name or stored_name, content_type)
        rgb = Image.fromarray(image[:, :, ::-1])
        # 缩图与大图失败都不致命：/thumb、/view 会在第一次被看到时补做
        try:
            make_thumbnail(rgb, Path(stored_name).stem)
        except Exception:
            pass
        try:
            make_display(rgb, Path(stored_name).stem)
        except Exception:
            pass
        face_ids = db.add_faces(photo_id, [{
            'face_index': i, 'x': f.x, 'y': f.y, 'w': f.w, 'h': f.h,
            'detection_score': f.detection_score, 'embedding': f.embedding,
            'quality_ok': f.quality_ok, 'quality_reasons': f.reasons_text,
            'blur_score': f.blur_score,
        } for i, f in enumerate(faces)])

        # 直接把这张的脸接到索引后面：不必等整批跑完，来宾马上就搜得到
        embeddings, metadata = [], []
        for i, f in enumerate(faces):
            if not f.quality_ok:
                continue
            embeddings.append(f.embedding)
            metadata.append({
                'face_id': face_ids.get(i), 'photo_id': photo_id, 'face_index': i,
                'x': f.x, 'y': f.y, 'w': f.w, 'h': f.h,
                'detection_score': f.detection_score,
                'filename': stored_name, 'original_name': original_name or stored_name,
            })
        get_search_index().add(embeddings, metadata)
    except Exception:
        if photo_id is not None:
            db.delete_photo_record(photo_id)
        stored_path.unlink(missing_ok=True)
        raise

    return {'photo_id': photo_id, 'filename': original_name, 'stored_name': stored_name,
            'faces': len(usable), 'faces_rejected': len(faces) - len(usable)}

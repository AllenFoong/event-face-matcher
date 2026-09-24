"""用目前设定的人脸引擎，把 data/photos 里所有照片重新建索引。

换引擎或改动 MIN_FACE_SIZE / DET_SIZE 之后必须跑一次：
不同模型的向量不能放在同一个索引里比对。

安全措施：
  - 执行前自动备份资料库到 data/event_faces.before_reindex_<时间>.db
  - 不删除任何照片：新引擎找不到可用人脸的照片，搬到 data/photos_unindexed/

用法（在专案根目录）：
  .venv\\Scripts\\python.exe scripts\\reindex.py
"""

import shutil
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Windows 主控台 / 管线预设编码不支援中文，照 D:\Face Recognition\backend\cli.py 的做法强制 UTF-8
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
sys.path.insert(0, str(ROOT))

import os

os.chdir(ROOT)  # config 里的路径是相对专案根目录

from app import db  # noqa: E402
from app.config import settings  # noqa: E402
from app.face_engine import get_engine  # noqa: E402

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}


def main():
    photo_dir = settings.photo_dir
    unindexed_dir = photo_dir.parent / "photos_unindexed"
    db_path = settings.database_path

    files = sorted(p for p in photo_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    print(f"照片资料夹 {photo_dir.resolve()}：{len(files)} 张")

    # 保留原始档名与格式
    old_meta = {}
    if db_path.exists():
        backup = db_path.with_name(
            f"{db_path.stem}.before_reindex_{datetime.now():%Y%m%d_%H%M%S}{db_path.suffix}")
        shutil.copy2(db_path, backup)
        print(f"资料库已备份：{backup}")
        con = sqlite3.connect(db_path)
        try:
            old_meta = {r[0]: (r[1], r[2]) for r in
                        con.execute("SELECT filename, original_name, content_type FROM photos")}
        except sqlite3.OperationalError:
            pass
        con.close()

    db.init_db()
    with db.connection() as con:
        con.execute("DELETE FROM faces")
        con.execute("DELETE FROM photos")
        # 刻意不重设流水号：照片编号不重复使用，避免旧网址对到别张照片
    print("旧索引已清空\n")

    t0 = time.perf_counter()
    engine = get_engine()
    print(f"引擎载入 {time.perf_counter() - t0:.1f}s，provider={engine.providers[0]}\n")

    n_ok = n_faces = n_rejected = n_moved = n_error = 0
    t_start = time.perf_counter()
    for i, path in enumerate(files, 1):
        try:
            image = engine.decode_image(path.read_bytes())
            faces = engine.extract_all(image)
            usable = sum(1 for f in faces if f.quality_ok)
            if not usable:
                unindexed_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), unindexed_dir / path.name)
                n_moved += 1
                status = "无可用人脸 -> 搬到 photos_unindexed"
            else:
                original_name, content_type = old_meta.get(path.name, (path.name, None))
                photo_id = db.add_photo(path.name, original_name, content_type)
                db.add_faces(photo_id, [{
                    "face_index": k, "x": f.x, "y": f.y, "w": f.w, "h": f.h,
                    "detection_score": f.detection_score, "embedding": f.embedding,
                    "quality_ok": f.quality_ok, "quality_reasons": f.reasons_text,
                    "blur_score": f.blur_score,
                } for k, f in enumerate(faces)])
                n_ok += 1
                n_faces += usable
                n_rejected += len(faces) - usable
                status = f"{usable} 张脸" + (f"（另 {len(faces) - usable} 张不合格）"
                                            if len(faces) > usable else "")
        except Exception as exc:  # 单张坏档不中断整批
            n_error += 1
            status = f"错误：{exc}"
        if i % 25 == 0 or i == len(files) or "错误" in status or n_ok <= 40:
            name = old_meta.get(path.name, (path.name,))[0]
            print(f"  [{i:>4}/{len(files)}] {name[:40]:<40} {status}")

    elapsed = time.perf_counter() - t_start
    print("\n" + "=" * 60)
    print(f"建立索引的照片   {n_ok}")
    print(f"可搜寻的脸       {n_faces}（另有 {n_rejected} 张不合格，存库但不进索引）")
    print(f"搬到 unindexed   {n_moved}")
    print(f"错误             {n_error}")
    if files:
        print(f"耗时             {elapsed:.0f}s（{elapsed / len(files) * 1000:.0f} ms/张）")


if __name__ == "__main__":
    main()

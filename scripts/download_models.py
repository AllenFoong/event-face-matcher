"""下载人脸模型（buffalo_l）到 models/buffalo_l/。

来源是 InsightFace 官方 release：
  https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip

buffalo_l 整包有 5 个模型，但这个专案只用其中两个：
  det_10g.onnx    SCRFD-10GF 侦测器
  w600k_r50.onnx  ArcFace ResNet50，512 维特征
其余三个（3D 关键点、106 点、性别年龄）用不到，预设会删掉省空间；
想保留就加 --keep-all。

用法（在专案根目录）：
  .venv\Scripts\python.exe scripts\download_models.py
"""

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

NEEDED = ("det_10g.onnx", "w600k_r50.onnx")


def main():
    ap = argparse.ArgumentParser(description="下载 buffalo_l 模型")
    ap.add_argument("--keep-all", action="store_true", help="保留用不到的三个模型")
    ap.add_argument("--force", action="store_true", help="已经存在也重新下载")
    args = ap.parse_args()

    target = ROOT / "models" / "buffalo_l"
    missing = [n for n in NEEDED if not (target / n).is_file()]
    if not missing and not args.force:
        print(f"模型已经齐全：{target}")
        for n in NEEDED:
            print(f"  {n}  {(target / n).stat().st_size / 1048576:.1f} MB")
        print("要重新下载请加 --force")
        return 0

    from insightface.utils import storage

    print(f"下载中…（约 280 MB，来源 {storage.BASE_REPO_URL}）")
    # ensure_available 会解到 <root>/models/buffalo_l/，正好是这个专案要的位置
    path = storage.download("models", "buffalo_l", force=args.force, root=str(ROOT))
    print(f"解压到 {path}")

    zip_leftover = ROOT / "models" / "buffalo_l.zip"
    if zip_leftover.is_file():
        zip_leftover.unlink()

    still_missing = [n for n in NEEDED if not (target / n).is_file()]
    if still_missing:
        print(f"错误：下载后仍缺少 {still_missing}", file=sys.stderr)
        return 1

    if not args.keep_all:
        for f in sorted(target.iterdir()):
            if f.is_file() and f.suffix == ".onnx" and f.name not in NEEDED:
                size = f.stat().st_size / 1048576
                f.unlink()
                print(f"  删除用不到的 {f.name}（省下 {size:.1f} MB）")

    print("\n完成：")
    for n in NEEDED:
        print(f"  {n}  {(target / n).stat().st_size / 1048576:.1f} MB")
    print("\n商业散布前请先看 THIRD_PARTY_LICENSES.md。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

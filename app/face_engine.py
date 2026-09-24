"""人脸引擎：InsightFace buffalo_l（SCRFD-10GF 侦测 + ArcFace R50 辨识，512 维）。

对外介面沿用起始版本：get_engine() / decode_image() /
extract_all() / extract_query()，main.py 不需要知道底层换了。

以下几段移植自 D:\\Face Recognition\\backend\\services\\：
  - EXIF 转正、HEIC 解码       <- scanner.py load_image_upright()
  - CUDA -> CPU 自动降级       <- face_engine.py resolve_providers()
  - 模型缺档检查               <- face_engine.py check_model_files()
  - Laplacian 模糊度           <- face_engine.py compute_blur_score()
"""

import contextlib
import io
import logging
from dataclasses import dataclass, field
from pathlib import Path
import queue
from contextlib import contextmanager
from threading import RLock

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings

logger = logging.getLogger(__name__)

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # 没装就不支援 HEIC，其他格式照常
    pillow_heif = None

REQUIRED_MODEL_FILES = ("det_10g.onnx", "w600k_r50.onnx")
PROVIDER_PRIORITY = ("CUDAExecutionProvider", "CPUExecutionProvider")


class ModelNotFoundError(RuntimeError):
    pass


@dataclass
class DetectedFace:
    x: int
    y: int
    w: int
    h: int
    detection_score: float
    embedding: np.ndarray
    blur_score: float = 0.0
    quality_ok: bool = True
    quality_reasons: list[str] = field(default_factory=list)

    @property
    def reasons_text(self):
        return ",".join(self.quality_reasons) or None


def check_model_files(model_dir: Path) -> list[str]:
    if not model_dir.is_dir():
        return list(REQUIRED_MODEL_FILES)
    return [name for name in REQUIRED_MODEL_FILES if not (model_dir / name).is_file()]


def resolve_providers() -> list[str]:
    """依序尝试 CUDA、CPU。之后装了 onnxruntime-gpu 会自动用上 GPU，程式码不用改。"""
    import onnxruntime

    available = set(onnxruntime.get_available_providers())
    chosen = [p for p in PROVIDER_PRIORITY if p in available]
    return chosen or ["CPUExecutionProvider"]


def compute_blur_score(image_bgr: np.ndarray, x: int, y: int, w: int, h: int) -> float:
    """人脸区域的 Laplacian 变异数，越低越糊。"""
    ih, iw = image_bgr.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(iw, x + w), min(ih, y + h)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    gray = cv2.cvtColor(image_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def assess_quality(detection_score: float, w: int, h: int) -> list[str]:
    """回传挡掉这张脸的原因；空串列 = 可以进索引。

    刻意只挡两种：侦测信心不足、脸太小。模糊度与相对尺寸在离线相册里有用，
    但在活动搜寻里会误挡来宾最清楚的大脸与背景里的来宾，所以只记录不挡。
    """
    reasons = []
    if detection_score < settings.detection_score_threshold:
        reasons.append("low_det_score")
    if min(w, h) < settings.min_face_size:
        reasons.append("too_small")
    return reasons


class FaceEngine:
    def __init__(self, model_root: Path, model_name: str):
        model_dir = model_root / model_name
        missing = check_model_files(model_dir)
        # 必须在 import insightface 之前检查：insightface 找不到模型时会自己连网下载
        if missing:
            raise ModelNotFoundError(
                f"模型档不齐，缺少 {', '.join(missing)}（应位於 {model_dir}）。"
                f"请从 D:\\Face Recognition\\backend\\models\\buffalo_l\\ 复制过来。"
            )

        from insightface.app import FaceAnalysis

        self._lock = RLock()
        self.providers = resolve_providers()
        # insightface 会用 print 喷一堆载入讯息，导到 log 里
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.app = FaceAnalysis(
                name=model_name,
                # insightface 固定在 <root>/models/<name>/ 找模型，所以 root 是 models 的上一层
                root=str(model_root.resolve().parent),
                providers=self.providers,
                allowed_modules=["detection", "recognition"],
            )
            self.app.prepare(
                ctx_id=0 if "CUDAExecutionProvider" in self.providers else -1,
                det_thresh=settings.detection_score_threshold,
                det_size=(settings.det_size, settings.det_size),
            )
        logger.debug(buf.getvalue())
        logger.info("人脸引擎就绪：%s，provider=%s", model_name, self.providers[0])

    @staticmethod
    def decode_image(data: bytes) -> np.ndarray:
        """bytes -> 转正后的 BGR 阵列。手机照片必须先依 EXIF 转正，否则侦测率大跌。"""
        try:
            with Image.open(io.BytesIO(data)) as img:
                img.load()
                upright = ImageOps.exif_transpose(img).convert("RGB")
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ValueError("Could not decode image.") from exc
        return np.asarray(upright)[:, :, ::-1].copy()

    def _detect(self, image: np.ndarray):
        """侦测；找不到脸时补边重试一次，回传 (faces, 补边像素)。

        SCRFD 需要脸周围有背景。脸塞满整个画面时（近距离自拍、大头照）会完全侦测不到 ——
        实测 LFW 裁切图 20 张找到 0 张，四周补短边 50% 的边之后 20 张全中。
        """
        with self._lock:
            faces = self.app.get(image)
        if faces:
            return faces, 0
        pad = max(1, min(image.shape[:2]) // 2)
        padded = cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
        with self._lock:
            return self.app.get(padded), pad

    def extract_all(self, image: np.ndarray) -> list[DetectedFace]:
        """照片里所有侦测到的脸，含品质不合格的（标记起来，由呼叫端决定要不要进索引）。"""
        faces, pad = self._detect(image)
        ih, iw = image.shape[:2]

        output = []
        for face in faces:
            # 补过边的话，座标要扣回原图并裁在范围内
            x1, y1, x2, y2 = (int(round(v)) - pad for v in face.bbox)
            x1, y1 = min(max(0, x1), iw - 1), min(max(0, y1), ih - 1)
            x2, y2 = min(max(x1 + 1, x2), iw), min(max(y1 + 1, y2), ih)
            x, y = max(0, x1), max(0, y1)
            w, h = max(1, x2 - x), max(1, y2 - y)
            emb = getattr(face, "normed_embedding", None)
            if emb is None:
                continue
            emb = np.asarray(emb, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(emb))
            if norm <= 1e-12:
                continue
            score = float(face.det_score)
            reasons = assess_quality(score, w, h)
            output.append(DetectedFace(
                x=x, y=y, w=w, h=h, detection_score=score, embedding=emb / norm,
                blur_score=compute_blur_score(image, x, y, w, h),
                quality_ok=not reasons, quality_reasons=reasons,
            ))
        return output

    def extract_query(self, image: np.ndarray) -> np.ndarray:
        """自拍取最大的那张合格的脸。"""
        faces = [f for f in self.extract_all(image) if f.quality_ok]
        if not faces:
            raise ValueError("No usable face detected.")
        faces.sort(key=lambda f: f.w * f.h, reverse=True)
        return faces[0].embedding


_engine = None
_engine_lock = RLock()
_pool: "queue.Queue[FaceEngine]" = queue.Queue()
_created = 0


def _limited_session_threads(n: int):
    """让 insightface 建出来的 onnxruntime session 只用 n 个执行绪。

    insightface 没有把 SessionOptions 开放出来，所以在建立引擎的期间
    暂时包住 InferenceSession。开多份引擎时一定要限制：
    3 份引擎各自吃满 16 核，只会互相抢，总吞吐反而下降。
    """
    import onnxruntime as ort
    original = ort.InferenceSession

    class Limited(original):
        def __init__(self, *args, **kwargs):
            opts = kwargs.get("sess_options") or ort.SessionOptions()
            opts.intra_op_num_threads = n
            opts.inter_op_num_threads = 1
            kwargs["sess_options"] = opts
            super().__init__(*args, **kwargs)

    return original, Limited


def _new_engine() -> "FaceEngine":
    threads = int(getattr(settings, "engine_threads", 0) or 0)
    if threads <= 0:
        return FaceEngine(settings.model_root, settings.model_name)
    import onnxruntime as ort
    original, limited = _limited_session_threads(threads)
    ort.InferenceSession = limited
    try:
        return FaceEngine(settings.model_root, settings.model_name)
    finally:
        ort.InferenceSession = original


def get_engine() -> FaceEngine:
    """单一引擎。给启动检查、decode_image（不碰模型）与 reindex 用。"""
    global _engine, _created
    with _engine_lock:
        if _engine is None:
            _engine = _new_engine()
            _pool.put(_engine)
            _created = 1
        return _engine


@contextmanager
def borrow_engine():
    """借一份引擎来跑推论，用完自动还回去。

    池子空了而且还没到上限，就现场再开一份（第一次会慢十几秒，之后就常驻）；
    已经到上限就排队等别人还。
    """
    global _created
    get_engine()  # 确保至少有一份
    try:
        engine = _pool.get_nowait()
    except queue.Empty:
        engine = None
        with _engine_lock:
            if _created < max(1, int(getattr(settings, "engine_pool_size", 1))):
                _created += 1
                spawn = True
            else:
                spawn = False
        if spawn:
            try:
                engine = _new_engine()
            except Exception:
                with _engine_lock:
                    _created -= 1
                raise
        else:
            engine = _pool.get()
    try:
        yield engine
    finally:
        _pool.put(engine)


def pool_status():
    return {"created": _created, "idle": _pool.qsize(),
            "limit": int(getattr(settings, "engine_pool_size", 1)),
            "threads": int(getattr(settings, "engine_threads", 0) or 0)}

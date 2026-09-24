from threading import RLock
import numpy as np
from app import db
from app.config import settings

class FaceSearchIndex:
    def __init__(self):
        self._lock = RLock()
        self.embeddings = np.empty((0, 0), dtype=np.float32)
        self.metadata = []
        self.reload()

    def reload(self):
        embeddings, metadata = db.load_face_index()
        if embeddings.size:
            embeddings = embeddings / np.maximum(np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-12)
        with self._lock:
            self.embeddings = embeddings.astype(np.float32)
            self.metadata = metadata

    def add(self, embeddings, metadata):
        """把新照片的脸接到索引后面。

        阶段 3：上传是背景一张一张跑的，每跑完一张就接上去，
        来宾不用等整批结束就搜得到（整批 reload 会愈跑愈慢）。
        """
        metadata = list(metadata)
        if not metadata:
            return
        arr = np.asarray(embeddings, dtype=np.float32).reshape(len(metadata), -1)
        arr = arr / np.maximum(np.linalg.norm(arr, axis=1, keepdims=True), 1e-12)
        arr = arr.astype(np.float32)
        with self._lock:
            if self.embeddings.size == 0:
                self.embeddings, self.metadata = arr, metadata
                return
            if arr.shape[1] != self.embeddings.shape[1]:
                raise ValueError("Embedding dimensionality mismatch.")
            self.embeddings = np.vstack([self.embeddings, arr])
            self.metadata = self.metadata + metadata

    def size(self):
        with self._lock:
            return len(self.metadata)

    def search(self, query_embedding):
        q = np.asarray(query_embedding, dtype=np.float32).reshape(-1)
        q /= max(float(np.linalg.norm(q)), 1e-12)
        with self._lock:
            if self.embeddings.size == 0:
                return []
            if q.size != self.embeddings.shape[1]:
                raise ValueError("Embedding dimensionality mismatch.")
            scores = self.embeddings @ q
            order = np.argsort(scores)[::-1]
            best_by_photo = {}
            for idx in order:
                score = float(scores[idx])
                if score < settings.match_threshold:
                    break
                meta = self.metadata[int(idx)]
                pid = int(meta["photo_id"])
                if pid not in best_by_photo:
                    item = dict(meta); item["similarity"] = score; best_by_photo[pid] = item
                if len(best_by_photo) >= settings.max_results:
                    break
            return list(best_by_photo.values())

_index = None
_lock = RLock()
def get_search_index():
    global _index
    with _lock:
        if _index is None:
            _index = FaceSearchIndex()
        return _index

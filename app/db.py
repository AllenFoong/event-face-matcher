import json
import sqlite3
import threading
from contextlib import contextmanager
import numpy as np
from app.config import settings

_DB_LOCK = threading.RLock()

def _connect():
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(settings.database_path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    con.execute("PRAGMA foreign_keys=ON;")
    return con

@contextmanager
def connection():
    con = _connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()

def init_db():
    with connection() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            original_name TEXT NOT NULL,
            content_type TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS faces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_id INTEGER NOT NULL,
            face_index INTEGER NOT NULL,
            x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
            detection_score REAL NOT NULL,
            embedding BLOB NOT NULL,
            embedding_dim INTEGER NOT NULL,
            quality_ok INTEGER NOT NULL DEFAULT 1,
            quality_reasons TEXT,
            blur_score REAL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE,
            UNIQUE(photo_id, face_index)
        );
        CREATE INDEX IF NOT EXISTS idx_faces_photo_id ON faces(photo_id);
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            total INTEGER NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            indexed INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0,
            faces INTEGER NOT NULL DEFAULT 0,
            current TEXT,
            note TEXT,
            failures TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT
        );
        -- 活动资料（名称、日期、封面…）：在管理页改，不必动 .env 也不必重开
        CREATE TABLE IF NOT EXISTS event_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        -- 没进索引的照片「为什么」没进：档案本身在 data/photos_rejected/
        CREATE TABLE IF NOT EXISTS rejected (
            name TEXT PRIMARY KEY,
            original_name TEXT,
            reason TEXT NOT NULL,
            faces INTEGER NOT NULL DEFAULT 0,
            largest INTEGER,
            min_size INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        -- 只记「几点搜了一次、找到几张」，不记自拍、不记 IP
        CREATE TABLE IF NOT EXISTS searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            matches INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
        """)
        cols = {r[1] for r in con.execute("PRAGMA table_info(faces)")}
        for name, ddl in (("quality_ok", "INTEGER NOT NULL DEFAULT 1"),
                          ("quality_reasons", "TEXT"), ("blur_score", "REAL")):
            if name not in cols:
                con.execute(f"ALTER TABLE faces ADD COLUMN {name} {ddl}")
        # 一次上传会被切成好几个 job（每个几 MB），batch 把它们串回同一批
        if "batch" not in {r[1] for r in con.execute("PRAGMA table_info(jobs)")}:
            con.execute("ALTER TABLE jobs ADD COLUMN batch TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch)")

def add_photo(filename, original_name, content_type):
    with _DB_LOCK, connection() as con:
        cur = con.execute("INSERT INTO photos(filename, original_name, content_type) VALUES (?, ?, ?)",
                          (filename, original_name, content_type))
        return int(cur.lastrowid)

def delete_photo_record(photo_id):
    with _DB_LOCK, connection() as con:
        con.execute("DELETE FROM photos WHERE id = ?", (photo_id,))

def add_faces(photo_id, faces):
    rows = []
    for face in faces:
        emb = np.asarray(face["embedding"], dtype=np.float32).reshape(-1)
        rows.append((photo_id, int(face["face_index"]), int(face["x"]), int(face["y"]),
                     int(face["w"]), int(face["h"]), float(face["detection_score"]),
                     emb.tobytes(), int(emb.size),
                     1 if face.get("quality_ok", True) else 0,
                     face.get("quality_reasons"), face.get("blur_score")))
    with _DB_LOCK, connection() as con:
        con.executemany("""
        INSERT INTO faces(photo_id, face_index, x, y, w, h, detection_score, embedding, embedding_dim,
                          quality_ok, quality_reasons, blur_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        # 回传 {face_index: face_id}：搜寻索引要增量加人时需要
        return {int(r["face_index"]): int(r["id"]) for r in
                con.execute("SELECT id, face_index FROM faces WHERE photo_id = ?", (photo_id,))}

def load_face_index():
    with connection() as con:
        rows = con.execute("""
        SELECT f.id AS face_id, f.photo_id, f.face_index, f.x, f.y, f.w, f.h,
               f.detection_score, f.embedding, f.embedding_dim,
               p.filename, p.original_name
        FROM faces f JOIN photos p ON p.id = f.photo_id
        WHERE f.quality_ok = 1
        ORDER BY f.id
        """).fetchall()
    metadata, embeddings = [], []
    for row in rows:
        emb = np.frombuffer(row["embedding"], dtype=np.float32).copy()
        if emb.size != row["embedding_dim"]:
            continue
        embeddings.append(emb)
        metadata.append({k: row[k] for k in ["face_id","photo_id","face_index","x","y","w","h","detection_score","filename","original_name"]})
    if not embeddings:
        return np.empty((0, 0), dtype=np.float32), []
    return np.vstack(embeddings).astype(np.float32), metadata

def stats():
    with connection() as con:
        return {
            "photos": con.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
            "faces": con.execute("SELECT COUNT(*) FROM faces").fetchone()[0],
            "searchable_faces": con.execute("SELECT COUNT(*) FROM faces WHERE quality_ok = 1").fetchone()[0],
        }


# ---- 活动资料 --------------------------------------------------------------

def get_event():
    with connection() as con:
        return {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM event_settings")}


def set_event(values):
    with _DB_LOCK, connection() as con:
        con.executemany("""INSERT INTO event_settings(key, value) VALUES (?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                        list(values.items()))


# ---- 没进索引的照片 --------------------------------------------------------

def add_rejected(name, original_name, reason, faces=0, largest=None, min_size=None):
    with _DB_LOCK, connection() as con:
        con.execute("""INSERT OR REPLACE INTO rejected(name, original_name, reason, faces, largest, min_size)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (name, original_name, reason, int(faces or 0), largest, min_size))


def rejected_reasons():
    with connection() as con:
        return {r["name"]: dict(r) for r in con.execute("SELECT * FROM rejected")}


def delete_rejected_record(name):
    with _DB_LOCK, connection() as con:
        con.execute("DELETE FROM rejected WHERE name = ?", (name,))


# ---- 来宾搜寻次数（管理页「来宾」那一栏用）-----------------------------------

def record_search(matches):
    with _DB_LOCK, connection() as con:
        con.execute("INSERT INTO searches(matches) VALUES (?)", (int(matches),))


def search_activity():
    with connection() as con:
        day = con.execute("""SELECT COUNT(*), COALESCE(SUM(matches > 0), 0) FROM searches
                             WHERE created_at >= datetime('now', '-1 day')""").fetchone()
        hour = con.execute("""SELECT COUNT(*) FROM searches
                              WHERE created_at >= datetime('now', '-1 hour')""").fetchone()[0]
        last = con.execute("SELECT MAX(created_at) FROM searches").fetchone()[0]
    return {"searches_24h": day[0], "found_24h": day[1], "searches_1h": hour, "last_search_at": last}


# ---- 背景建索引的工作进度（阶段 3）----------------------------------------
# 进度放资料库而不是记忆体：摄影师可以关掉页面、换装置、之后再回来看。

_JOB_FIELDS = ("status", "done", "indexed", "failed", "faces", "current", "note", "failures")


def create_job(job_id, total, batch=None):
    with _DB_LOCK, connection() as con:
        con.execute("INSERT INTO jobs(id, status, total, batch) VALUES (?, 'queued', ?, ?)",
                    (job_id, int(total), batch))


def update_job(job_id, **fields):
    bad = set(fields) - set(_JOB_FIELDS)
    if bad:
        raise ValueError(f"unknown job fields: {sorted(bad)}")
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _DB_LOCK, connection() as con:
        con.execute(f"UPDATE jobs SET {sets} WHERE id = ?", (*fields.values(), job_id))


def finish_job(job_id, status, note=None):
    with _DB_LOCK, connection() as con:
        con.execute("""UPDATE jobs SET status = ?, note = COALESCE(?, note), current = NULL,
                       finished_at = CURRENT_TIMESTAMP WHERE id = ?""", (status, note, job_id))


def get_job(job_id):
    with connection() as con:
        return con.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()


def recent_jobs(limit=10):
    with connection() as con:
        return con.execute("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?",
                           (int(limit),)).fetchall()


def fail_orphan_jobs():
    """伺服器重开后，之前还在跑的工作已经没有工人了 —— 标成中断，别让进度条永远转。"""
    with _DB_LOCK, connection() as con:
        cur = con.execute("""UPDATE jobs SET status = 'interrupted', current = NULL,
                             note = 'Server restarted before this batch finished.',
                             finished_at = CURRENT_TIMESTAMP
                             WHERE status IN ('queued', 'running')""")
        return cur.rowcount


def list_photos(limit=50, offset=0, q=""):
    """相簿清单（新的在前）。usable = 进了索引的脸，total = 侦测到的全部。q = 依档名筛选。"""
    where, args = "", []
    if q:
        # LIKE 里的 % 与 _ 是万用字元，档名里常常有底线（DSC_0412），要跳脱
        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where, args = "WHERE p.original_name LIKE ? ESCAPE '\\'", [f"%{esc}%"]
    with connection() as con:
        total = con.execute(f"SELECT COUNT(*) FROM photos p {where}", args).fetchone()[0]
        rows = con.execute(f"""
        SELECT p.id, p.filename, p.original_name, p.created_at,
               COALESCE(SUM(CASE WHEN f.quality_ok = 1 THEN 1 ELSE 0 END), 0) AS usable,
               COUNT(f.id) AS faces_total
        FROM photos p LEFT JOIN faces f ON f.photo_id = p.id
        {where}
        GROUP BY p.id
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?
        """, (*args, int(limit), int(offset))).fetchall()
    return total, [dict(r) for r in rows]


def photos_by_stems(stems):
    """依网址里的 token（档名去掉副档名）一次查多张。回传的顺序跟 stems 一样。"""
    stems = list(stems)
    if not stems:
        return []
    marks = ",".join("?" * len(stems))
    with connection() as con:
        rows = con.execute(f"""SELECT id, filename, original_name, content_type FROM photos
                               WHERE substr(filename, 1, 32) IN ({marks})""", stems).fetchall()
    by_stem = {r["filename"][:32]: dict(r) for r in rows}
    return [by_stem[s] for s in stems if s in by_stem]


# ---- 一批上传（可能由好几个 job 组成）----------------------------------------

_BATCH_SQL = """
SELECT COALESCE(batch, id) AS batch_id, COUNT(*) AS jobs,
       SUM(total) AS total, SUM(done) AS done, SUM(indexed) AS indexed,
       SUM(failed) AS failed, SUM(faces) AS faces,
       MIN(created_at) AS created_at, MAX(finished_at) AS finished_at,
       SUM(status = 'running') AS running, SUM(status = 'queued') AS queued,
       SUM(status NOT IN ('queued', 'running', 'done')) AS broken,
       MAX(CASE WHEN status = 'running' THEN current END) AS current
FROM jobs {where}
GROUP BY COALESCE(batch, id)
ORDER BY MIN(created_at) DESC, MAX(rowid) DESC
LIMIT ?
"""


def _batch_row(row):
    d = dict(row)
    if d["running"]:
        d["status"] = "running"
    elif d["queued"]:
        d["status"] = "queued"
    elif d["broken"]:
        d["status"] = "interrupted"   # 伺服器中途重开过
    else:
        d["status"] = "done"
    for k in ("running", "queued", "broken"):
        del d[k]
    return d


def recent_batches(limit=8):
    with connection() as con:
        rows = con.execute(_BATCH_SQL.format(where=""), (int(limit),)).fetchall()
    return [_batch_row(r) for r in rows]


def get_batch(batch_id):
    with connection() as con:
        row = con.execute(_BATCH_SQL.format(where="WHERE COALESCE(batch, id) = ?"),
                          (batch_id, 1)).fetchone()
        if row is None:
            return None
        parts = con.execute("SELECT failures, note FROM jobs WHERE COALESCE(batch, id) = ? ORDER BY rowid",
                            (batch_id,)).fetchall()
    d = _batch_row(row)
    failures = []
    for p in parts:
        try:
            failures += json.loads(p["failures"] or "[]")
        except ValueError:
            pass
    d["failures"] = failures[:200]
    d["notes"] = [p["note"] for p in parts if p["note"]]
    return d

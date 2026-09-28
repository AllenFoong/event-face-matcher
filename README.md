# Event Face Matcher

Find yourself in event photos with one selfie. The photographer uploads the event photos in bulk; a guest takes a selfie and gets back every photo they appear in.

This is a **photo-finding tool, not an identity database**. It never knows anyone's name; it only compares numeric face features.

> **⚠️ Licence: the buffalo_l face models are for non-commercial research use only.**
> Personal use, testing and unpaid events are fine. If you charge money or run it for profit,
> you need a commercial licence from InsightFace or a commercially licensed model.
> See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

---

## Screenshots

**Guest page:** the event cover, and the notice guests see while the photographer has search paused.

![Guest page](docs/screenshots/home%20page.png)

**Admin Overview:** latest photos, library / guests / network status, and upload history.

![Admin overview](docs/screenshots/overview%20page.png)

**Admin Photos:** the searchable library, with file-name search and multi-select.

![Admin photos](docs/screenshots/photos%20page.png)

_Photos in the admin screenshots are blurred because they are third-party test images._

---

## What it runs on

| Part        | What                                                  | Notes                                   |
| ----------- | ----------------------------------------------------- | --------------------------------------- |
| Detection   | **SCRFD-10GF** (`det_10g.onnx`)                       | The detector from InsightFace buffalo_l |
| Recognition | **ArcFace ResNet50 @ WebFace600K** (`w600k_r50.onnx`) | 512-dimensional feature vector          |
| Matching    | NumPy dot product (cosine similarity)                 | Vectors are normalised                  |
| Storage     | SQLite (WAL)                                          | Photo records + features per face       |
| Web         | FastAPI + plain JavaScript                            | No front-end framework                  |

An earlier version used a lighter model pair (OpenCV YuNet + SFace, 128-d). In our tests buffalo_l found and recognised strictly more faces, so it replaced them, at the cost of the licence restriction above.

---

## Quick start (Windows)

### First install

```powershell
git clone https://github.com/AllenFoong/event-face-matcher.git
cd event-face-matcher
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env          # set at least ADMIN_API_KEY and SITE_PASSWORD
.venv\Scripts\python.exe scripts\download_models.py
```

The models go in `models\buffalo_l\`: `det_10g.onnx`, `w600k_r50.onnx` (plus the other files insightface checks for).

### Everyday start

Double-click one of these in the project folder:

| File              | Mode                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `启动.bat`        | **Public**: opens a Cloudflare tunnel so phones on mobile data can connect       |
| `启动-仅区网.bat` | **LAN only**: photos never leave this computer; guests must be on the same Wi-Fi |

(The file names are Chinese for "Start" and "Start – LAN only".)

The window prints the LAN address, the public address, the login, and a **QR code** that carries a key so guests can scan and get straight in. Closing the window stops the server and the tunnel together.

Or run it by hand:

```powershell
.venv\Scripts\python.exe scripts\serve.py --no-tunnel --port 8000
```

---

## The two pages

| URL      | For          | Needs                                                    |
| -------- | ------------ | -------------------------------------------------------- |
| `/`      | Guests       | Site password (or the key in the QR code) + consent tick |
| `/admin` | Photographer | Site password + `ADMIN_API_KEY` on the sign-in screen    |

**Guest page `/`** (phone-first): the cover photo shown like a white-bordered print, with the event name beside it. Tick consent → take a selfie → results in a masonry grid → tap to view full screen (swipe, pinch to zoom) → download the original, or "Download all" as one zip. When the photographer pauses search, guests see "Photos are on their way".

**Admin page `/admin`** (sidebar navigation):

| Section        | What it does                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview       | Pre-opening checklist, latest photos, library / guests / network status cards, upload history                                              |
| Upload         | Drag and drop. Large batches are sent in ~20 MB chunks so the public tunnel does not time out; one progress bar covers upload and indexing |
| Photos         | Library (even rows, no cropping), search by file name, multi-select delete, full-size view, set as cover                                   |
| Not searchable | Photos that were not indexed and **why** (no face / face too small / too blurry / unreadable); download or delete                          |
| Guest access   | Guest QR code (copy link, download PNG, **print a table card**), pause guest search, entry method, network mode, search counts             |
| Settings       | Event name, date, place, photographer, contact, cover photo; match threshold (read-only, set in `.env`)                                    |

Event details and the cover are stored in the database (`event_settings` table). Changes show up for guests on refresh, with no server restart.

---

## Key settings (`.env`)

| Setting                       | Value    | Why                                                                                                                                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH_THRESHOLD`             | **0.40** | Tested on a 191-photo library: 0.36 found 100% but matched 2 wrong photos; 0.40 had zero wrong matches and 92% recall. Better to miss a photo than show the wrong person. |
| `MIN_FACE_SIZE`               | **24**   | Faces smaller than this (pixels) are not indexed. 14–19 px faces produced a 0.476 cross-person false match in testing.                                                    |
| `DETECTION_SCORE_THRESHOLD`   | 0.50     | Detector confidence cut-off                                                                                                                                               |
| `DET_SIZE`                    | 640      | Finds about 40% more faces than 320                                                                                                                                       |
| `ENGINE_THREADS`              | **4**    | CPU threads per engine. Using all 16 cores was the slowest (search 0.79 s → 0.26 s with 4 threads).                                                                       |
| `ENGINE_POOL_SIZE`            | **3**    | How many searches can run at once. Engines start on demand; idle memory is one engine.                                                                                    |
| `SEARCH_RATE_PER_MIN`         | 20       | Searches per IP per minute                                                                                                                                                |
| `SITE_USER` / `SITE_PASSWORD` | —        | Site-wide password. **Blank = no lock**; only acceptable in LAN-only mode.                                                                                                |
| `SITE_ACCESS_TOKEN`           | —        | Key carried in the QR code so guests don't have to type. Blank = feature off.                                                                                             |
| `ADMIN_API_KEY`               | —        | Permission to upload and delete                                                                                                                                           |

---

## Measured performance (16-core CPU)

Library of 191 photos / 667 faces.

| Item                | Result                                           |
| ------------------- | ------------------------------------------------ |
| Indexing            | 0.81 s per photo (group photos, ~3.6 faces each) |
| One search          | 0.27 s                                           |
| 15 searches at once | All done in 6.7 s; slowest waited 6.6 s          |
| Recall              | 92% (threshold 0.40)                             |
| False matches       | 0 (none of 180 stranger photos leaked through)   |
| Memory              | 435 MB with one engine; 1058 MB with three       |

The accuracy sample is only 3 real people with 16 labelled faces, so **the direction is reliable, the exact numbers are not**.

---

## Known limitations

1. **Large uploads over the public link are slow.** Chunked uploads avoid the Cloudflare 100-second timeout (524), but home upload speed is still the bottleneck. Use `http://127.0.0.1:8000/admin` or the same Wi-Fi when you can.
2. **In public mode, photos pass through Cloudflare**, so they leave this computer. Use LAN-only mode if they must not.
3. **The free tunnel URL changes on every restart.** A fixed URL needs a Cloudflare account and your own domain.
4. **Guests can open `/admin`** (but cannot do anything without `ADMIN_API_KEY`).
5. **One QR key for everyone.** If it is forwarded, it cannot be revoked per person.
6. **No backups.** All data lives only in `data\` on this computer.
7. **Compressed photos get rejected.** Images forwarded through chat apps shrink faces to a dozen pixels, too small to match reliably. Upload originals.

---

## Project layout

```
app/
  main.py          Routes, site password, rate limit, upload/search/admin endpoints
  config.py        All settings (.env overrides the defaults here)
  face_engine.py   Model loading, detection, feature extraction, engine pool
  photos.py        Saving photos + indexing (shared by the upload endpoint and the worker)
  jobs.py          Background indexing worker and progress records
  search_index.py  In-memory vector index (supports incremental adds)
  db.py            SQLite schema and queries
  static/          base.css (shared colours and components), guest.css + app.js (guest page),
                   admin.css + admin.js (admin page), viewer.js (full-screen viewer, shared)
  templates/       index.html (guest), admin.html (admin), _icons.html, _viewer.html
scripts/
  serve.py         One-click start: server + tunnel + QR code
  reindex.py       Rebuild the whole index from data/photos after changing models or settings
  download_models.py
docs/screenshots/  README images
data/              Photos, thumbnails/, display/ (2048 px viewing copies), database (not in git)
models/buffalo_l/  Model files (~190 MB, fetched by download_models.py, not in git)
```

---

## After changing settings

Matching settings such as `MATCH_THRESHOLD` take effect **after a server restart**.

Changing `MIN_FACE_SIZE`, `DET_SIZE` or the model **requires a reindex**, otherwise old and new faces are measured differently:

```powershell
.venv\Scripts\python.exe scripts\reindex.py
```

It backs up the database first, re-runs every file in `data\photos`, and then **the server must be restarted** (the index lives in memory).

---

## Compliance notes

The consent tick on the guest page covers only **that guest's own** face search. It does **not** mean everyone else in the album has agreed to biometric processing; that has to be handled by your event and photography process.

Before any commercial use you would still need: separation between events, a real admin account system, HTTPS, expiring signed photo URLs, object storage, encrypted backups, retention and deletion policies, audit logs, and a consent and privacy flow reviewed by a lawyer.

Third-party licences are in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). The **non-commercial restriction on the models** is the one that matters most right now.

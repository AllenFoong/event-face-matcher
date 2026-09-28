# Third-party components and licences

This is a compliance reminder, not legal advice. Have a lawyer confirm before any commercial use.

---

## ⚠️ Most important: the face models are for non-commercial research use only

This project uses InsightFace's **buffalo_l** pretrained models:

| File             | Model                          | Purpose             |
| ---------------- | ------------------------------ | ------------------- |
| `det_10g.onnx`   | SCRFD-10GF                     | Face detection      |
| `w600k_r50.onnx` | ArcFace ResNet50 @ WebFace600K | 512-d face features |

Source: <https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip>

InsightFace is licensed in two **separate** parts:

| Part                                               | Licence                      | Commercial use |
| -------------------------------------------------- | ---------------------------- | -------------- |
| InsightFace **library** (the pip package)          | MIT                          | ✅ Yes         |
| InsightFace **pretrained models** (buffalo_l etc.) | Non-commercial research only | ❌ **No**      |

In short: **personal use, testing and research are fine; as soon as you charge money or use it for a for-profit event, you need a separate licence.**

Commercial licensing: `recognition-oss-pack@insightface.ai`
Details: <https://www.insightface.ai/solutions/face-recognition-licensing>

### Three ways forward for commercial use

1. **Buy a commercial licence from InsightFace** (simplest, same accuracy).
2. **Switch to commercially usable models**, e.g. OpenCV YuNet (MIT) + SFace (Apache-2.0), which an earlier version used. The cost is lower accuracy: in our tests buffalo_l found and recognised strictly more faces.
3. **Stay non-commercial** (your own wedding, a friend's event, no charge).

---

## Other components

| Component                                                         | Licence              | Notes                                            |
| ----------------------------------------------------------------- | -------------------- | ------------------------------------------------ |
| insightface (library)                                             | MIT                  | Models licensed separately, see above            |
| onnxruntime                                                       | MIT                  | Inference runtime                                |
| opencv-python                                                     | Apache-2.0           | Image processing (padding, resizing, blur check) |
| numpy                                                             | BSD-3-Clause         |                                                  |
| FastAPI / Starlette                                               | MIT                  |                                                  |
| uvicorn                                                           | BSD-3-Clause         |                                                  |
| Pillow                                                            | MIT-CMU              |                                                  |
| pillow-heif                                                       | BSD / LGPL (libheif) | Reads iPhone HEIC files                          |
| pydantic / pydantic-settings                                      | MIT                  |                                                  |
| jinja2                                                            | BSD-3-Clause         |                                                  |
| python-multipart                                                  | Apache-2.0           |                                                  |
| segno                                                             | BSD-3-Clause         | QR code generation                               |
| cloudflared (external program, not distributed with this project) | Apache-2.0           | Public tunnel                                    |

---

## Test data

Stress tests used the **WIDER FACE** validation set (The Chinese University of Hong Kong, CC-BY 4.0), only for local performance and false-match testing. It is **not** distributed with this project and never entered a real event album.

**PIPA** (People in Photo Albums) was considered and **deliberately not used**: it is a collection of private family photos gathered from Flickr without the subjects' consent, which contradicts this project's own consent design.

---

## Before every public release

Re-check the upstream model cards and repository licences, pin versions / commits and SHA-256 hashes, keep the matching LICENSE/NOTICE files, run a dependency licence scan, and have a lawyer review.

Also: the consent tick on the guest page covers only **that guest's own** face search. It does **not** mean everyone else in the album has agreed to biometric processing.

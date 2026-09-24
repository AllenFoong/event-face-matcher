# 第三方元件与授权

这是合规提醒，不是法律意见。正式商用前请自行请法务确认。

---

## ⚠️ 最重要的一条：目前使用的人脸模型「仅限非商业研究用途」

本专案使用 InsightFace 的 **buffalo_l** 预训练模型：

| 档案 | 模型 | 用途 |
|---|---|---|
| `det_10g.onnx` | SCRFD-10GF | 侦测人脸 |
| `w600k_r50.onnx` | ArcFace ResNet50 @ WebFace600K | 512 维特征 |

来源：<https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip>

InsightFace 的授权是**分开**的两件事：

| 部分 | 授权 | 可否商用 |
|---|---|---|
| InsightFace **程式库**（pip 装的那个套件） | MIT | ✅ 可以 |
| InsightFace **预训练模型**（buffalo_l 等） | 仅限非商业研究 | ❌ **不可以** |

也就是说：**自用、测试、研究没问题；只要开始收费或用於营利活动，就需要另外取得授权。**

商业授权洽询：`recognition-oss-pack@insightface.ai`
说明页：<https://www.insightface.ai/solutions/face-recognition-licensing>

### 如果要商用，有三条路

1. **向 InsightFace 买商业授权**（最省事，准确度不变）
2. **换成可商用的模型** —— 例如起始版本用的 OpenCV YuNet（MIT）+ SFace（Apache-2.0）。代价是准确度较差：2026-09-09 的实测中，buffalo_l 这组在侦测与辨识两端都是严格的超集合。
3. **维持非商业用途**（自己的婚礼、朋友的活动、不收费）

---

## 其他元件

| 元件 | 授权 | 备注 |
|---|---|---|
| insightface（程式库） | MIT | 模型另计，见上 |
| onnxruntime | MIT | 推论执行环境 |
| opencv-python | Apache-2.0 | 影像处理（补边、缩放、模糊度） |
| numpy | BSD-3-Clause | |
| FastAPI / Starlette | MIT | |
| uvicorn | BSD-3-Clause | |
| Pillow | MIT-CMU | |
| pillow-heif | BSD / LGPL（libheif） | 读 iPhone 的 HEIC |
| pydantic / pydantic-settings | MIT | |
| jinja2 | BSD-3-Clause | |
| python-multipart | Apache-2.0 | |
| segno | BSD-3-Clause | 产生 QR code |
| cloudflared（外部程式，非本专案散布） | Apache-2.0 | 对外通道 |

---

## 测试资料

压力测试使用 **WIDER FACE** 验证集（香港中文大学），授权 CC-BY 4.0，仅用於本机效能与误配测试，**没有**散布在本专案内，也没有进入正式相簿。

曾评估但**刻意不采用** PIPA（People in Photo Albums）：该资料集是未经当事人同意从 Flickr 蒐集的私人家庭照片，与本专案自身的同意设计相矛盾。

---

## 每次正式释出前应做

重新确认上游模型卡与仓库的授权、锁定版本/commit 与 SHA-256、保存对应的 LICENSE/NOTICE、跑一次相依套件授权扫描，并由法务审阅。

另外提醒：来宾页上的同意勾选只涵盖**该名来宾自己**的脸部搜寻，**不代表**相簿里其他入镜者同意被生物特征处理。

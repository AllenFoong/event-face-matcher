from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Event Face Matcher"
    database_path: Path = Path("data/event_faces.db")
    photo_dir: Path = Path("data/photos")

    # 引擎：InsightFace buffalo_l = SCRFD-10GF 侦测 + ArcFace R50 辨识（512 维）
    # 选型依据见 D:\facebench\out\detect_compare.html 与 recog_compare.html
    model_root: Path = Path("models")          # insightface 在 <model_root>/<model_name>/ 找模型
    model_name: str = "buffalo_l"
    det_size: int = 640                            # 实测 640 比 320 多找到约 40% 的脸
    # 同时可以有几个人在算：1 = 排队（原本的行为）。
    # 每多一份引擎就多吃一份模型的记忆体，所以不是愈多愈好。
    engine_pool_size: int = 3
    # 每份引擎用几个 CPU 执行绪；0 = 交给 onnxruntime 自己决定（会吃满所有核）。
    # 开多份引擎时要限制，否则它们会互相抢核心，反而更慢。
    # 2026-09-22 实测（16 核）：每份引擎限制 4~5 绪最快。
    # 绪=自动(16) 搜寻 0.79s / 建索引 1.63s一张；绪=4 变成 0.26s / 0.81s。
    # 执行绪开太多，同步成本反而吃掉平行的好处。
    engine_threads: int = 4

    # ArcFace 相似度门槛。实测（31 张真实照片、42 次查询）：
    #   0.27 找回 97.7% / 误配 20 次；0.36 找回 93.9% / 误配 2 次；0.40 找回 89.9% / 误配 0 次
    # 误配 = 把陌生人的照片给来宾，是隐私问题，所以取 0.36。
    # 注意：起始版本的 0.363 是给另一组模型用的，数字接近纯属巧合，不可互换。
    # 0.36 -> 0.40（2026-09-22 实测，191 张相簿 / 16 张已标注的脸）：
    # 0.36 找回率 100% 但有 2 张认错人；0.40 零认错、找回率 92%。
    # 最难认的同一人 0.391、唯一认错的不同人 0.393，两者重叠，
    # 没有任何门槛能两全 —— 选择少给几张，而不是给错人。
    match_threshold: float = 0.40
    max_results: int = 100

    # 真正会把脸挡在索引外的只有这两道
    detection_score_threshold: float = 0.50
    # 28 -> 24：实测 30.jpg 的脸宽 24 px 被挡；同批 14~19 px 的小脸互比会出现

    # 0.476 的跨人误配（门槛 0.36），所以放宽到 24 为止，不再往下。

    min_face_size: int = 24

    # 只记录、不挡：大而清楚的脸 Laplacian 变异数天生偏低，挡掉会让来宾找不到最清楚的照片
    blur_warn_threshold: float = 100.0

    admin_api_key: str = "change-me-before-production"

    # 整站密码（HTTP Basic）。放到网路上时必填：没有它，/admin 上传页与所有照片网址
    # 任何拿到网址的人都能打开。留空 = 不启用，只适合 localhost 或可信区网。
    site_user: str = "guest"
    site_password: str = ""
    # QR code 里带的钥匙：来宾扫了就进得去，不必打帐密。空白 = 关掉这个功能。
    site_access_token: str = ""
    access_cookie_hours: int = 12
    search_rate_per_min: int = 20
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

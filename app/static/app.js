/* app.js：来宾页。自拍 → 搜寻 → 瀑布流结果 → 全萤幕看、下载。
   找照片的卡片只有三种状态：start（同意 + 按钮）、camera（桌机的网页镜头）、searching。
   结果页推一笔 history，手机的「上一页」会回到首页，而不是离开网站。 */
(() => {
  "use strict";
  const EFM = window.EFM || {};
  const $ = (id) => document.getElementById(id);

  const landing = $("landing");
  const results = $("results");

  // ---------- 「怎么运作」说明 ----------
  const how = $("how");
  document.querySelectorAll("[data-open-how]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault(); // 连结在勾选框的 label 里：不要顺便勾到、也不要跳到 #how
      how.showModal();
    }),
  );
  how
    .querySelectorAll("[data-close]")
    .forEach((b) => b.addEventListener("click", () => how.close()));
  how.addEventListener("click", (e) => {
    // 点对话框外面（背景）就关
    const r = how.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      how.close();
  });

  const toastEl = $("toast");
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 3200);
  }

  if (!EFM.searchOpen) return; // 摄影师还没开放搜寻：页面只有「照片还在路上」

  const finder = $("finder");
  const consent = $("consent");
  const consentBox = $("consentBox");
  const takeBtn = $("takeSelfie");
  const chooseBtn = $("choosePhoto");
  const errorEl = $("finderError");
  const fileCamera = $("fileCamera");
  const fileLibrary = $("fileLibrary");
  const panels = {};
  finder
    .querySelectorAll("[data-panel]")
    .forEach((p) => (panels[p.dataset.panel] = p));

  function setPanel(name) {
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  // ---------- 怎么拍自拍 ----------
  // 手机：直接开原生相机（HTTP 下也能用）。电脑：网页里开镜头。
  // 电脑又不能开镜头（浏览器规定只有 HTTPS 或 localhost 才行，区网的 http://192.168.x.x 不行）：只留「选照片」。
  const touch = matchMedia("(pointer: coarse)").matches;
  const canWebcam = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  if (!touch && !canWebcam) {
    takeBtn.hidden = true;
    chooseBtn.className = "btn btn--primary btn--lg btn--block";
    chooseBtn.querySelector("span").textContent = "Choose a photo of yourself";
  }

  // ---------- 同意 ----------
  function syncConsent() {
    const ok = consent.checked;
    takeBtn.setAttribute("aria-disabled", String(!ok));
    chooseBtn.setAttribute("aria-disabled", String(!ok));
    if (ok) {
      consentBox.classList.remove("consent--nudge");
      hideError();
    }
  }
  consent.addEventListener("change", syncConsent);
  syncConsent();

  function needConsent() {
    if (consent.checked) return false;
    consentBox.classList.add("consent--nudge");
    showError(
      "Tick the box above first. It lets us use your selfie for this one search.",
    );
    consent.focus();
    return true;
  }

  takeBtn.addEventListener("click", () => {
    if (needConsent()) return;
    hideError();
    if (touch || !canWebcam) fileCamera.click();
    else openWebcam();
  });
  chooseBtn.addEventListener("click", () => {
    if (needConsent()) return;
    hideError();
    fileLibrary.click();
  });
  for (const input of [fileCamera, fileLibrary]) {
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.value = ""; // 同一张可以再选一次
      if (f) search(f);
    });
  }

  // ---------- 桌机的网页镜头 ----------
  const video = $("camVideo");
  let stream = null;
  async function openWebcam() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });
    } catch (e) {
      showError(
        e && e.name === "NotAllowedError"
          ? "Camera access is blocked. Allow it in your browser's address bar, or choose a photo instead."
          : "The camera couldn't start. Choose a photo instead.",
      );
      return;
    }
    video.srcObject = stream;
    setPanel("camera");
    $("camShutter").focus();
  }
  // 真的把镜头关掉：只清 srcObject 不够，要 stop() 每一条轨道，镜头的指示灯才会熄
  function stopWebcam() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }
  $("camCancel").addEventListener("click", () => {
    stopWebcam();
    setPanel("start");
    takeBtn.focus();
  });
  $("camShutter").addEventListener("click", () => {
    if (!video.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0); // 预览是镜像的，这里存的是原始画面
    stopWebcam();
    c.toBlob(
      (b) => b && search(new File([b], "selfie.jpg", { type: "image/jpeg" })),
      "image/jpeg",
      0.92,
    );
  });
  window.addEventListener("pagehide", stopWebcam);

  // ---------- 搜寻 ----------
  // 自拍上传前先缩到长边 1280px。辨识只需要这么大，手机原图常常 3~12 MB，
  // 在活动现场的 WiFi 下光上传就要等很久。
  const SELFIE_MAX_EDGE = 1280;
  const SELFIE_QUALITY = 0.9;
  async function shrinkImage(file) {
    try {
      // imageOrientation: 'from-image' = 依 EXIF 转正后再画，缩完就不会歪
      const bmp = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      const scale = Math.min(
        1,
        SELFIE_MAX_EDGE / Math.max(bmp.width, bmp.height),
      );
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
        bmp.close();
        return file;
      }
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const blob = await new Promise((res) =>
        c.toBlob(res, "image/jpeg", SELFIE_QUALITY),
      );
      return blob
        ? new File([blob], "selfie.jpg", { type: "image/jpeg" })
        : file;
    } catch (e) {
      // 浏览器解不开的格式（例如非 Safari 上的 HEIC）就原档送出，由伺服器处理
      return file;
    }
  }

  const MSG = {
    noFace:
      "We couldn't see a face in that photo. Try a selfie with your face clearly visible and in good light.",
    decode:
      "That photo couldn't be opened. Try a JPG or PNG, or take a new selfie.",
    rate: "That's a lot of searches in a short time. Wait a minute, then try again.",
    paused: "Search is paused right now. Check back soon.",
    tooBig: "That photo is too large. Try a different one.",
    type: "That file type isn't supported. Use a JPG, PNG or HEIC photo.",
    expired: "Your access has expired. Scan the event's QR code again.",
    network: "Couldn't connect. Check your Wi-Fi or signal and try again.",
    server:
      "Something went wrong on the gallery's side. Try again in a moment.",
  };
  function errorFor(status, detail) {
    detail = String(detail || "");
    if (status === 422) return /decode/i.test(detail) ? MSG.decode : MSG.noFace;
    if (status === 429) return MSG.rate;
    if (status === 403) return MSG.paused;
    if (status === 413) return MSG.tooBig;
    if (status === 400 && /unsupported/i.test(detail)) return MSG.type;
    if (status === 401) return MSG.expired;
    return MSG.server;
  }

  const OK_NAME = /\.(jpe?g|png|webp|bmp|tiff?|heic|heif)$/i;
  let ctrl = null;
  let runId = 0;
  let selfieUrl = "";

  async function search(file) {
    const run = ++runId;
    hideError();
    setPanel("searching");
    const small = await shrinkImage(file);
    if (run !== runId) return; // 缩图时按了取消
    if (selfieUrl) URL.revokeObjectURL(selfieUrl);
    selfieUrl = URL.createObjectURL(small);
    $("searchingSelfie").src = selfieUrl;

    const fd = new FormData();
    fd.append(
      "image",
      small,
      OK_NAME.test(small.name || "") ? small.name : "selfie.jpg",
    );
    // 送实际勾选状态，不写死 true：同意必须是真的有把关，直接打 API 也绕不过
    fd.append("biometric_consent", consent.checked ? "true" : "false");
    ctrl = new AbortController();
    let r;
    let d;
    try {
      r = await fetch("/api/search", {
        method: "POST",
        body: fd,
        signal: ctrl.signal,
      });
      d = await r.json().catch(() => ({}));
    } catch (e) {
      if (run === runId) {
        setPanel("start");
        if (e.name !== "AbortError") showError(MSG.network);
      }
      return;
    } finally {
      ctrl = null;
    }
    if (run !== runId) return;
    setPanel("start");
    if (!r.ok) {
      showError(errorFor(r.status, d.detail));
      return;
    }
    showResults(d.matches || []);
  }
  $("cancelSearch").addEventListener("click", () => {
    runId++;
    if (ctrl) ctrl.abort();
    setPanel("start");
  });

  // ---------- 结果 ----------
  const grid = $("grid");
  const viewer = window.PhotoViewer($("viewer"), {});
  let matches = null; // null = 这次开页面还没搜过
  // 在结果页按了重新整理：结果已经不在了，把那一笔「结果页」的记号拿掉，
  // 不然之后按「上一页／下一页」会跳到一个空的结果页
  if (history.state && history.state.efmView) history.replaceState(null, "");
  let tiles = [];
  let items = [];

  function showResults(list) {
    matches = list;
    items = list.map((m, i) => ({
      thumb: m.thumb_url,
      view: m.view_url,
      download: m.download_url,
      w: m.w,
      h: m.h,
      alt: `Photo ${i + 1} of ${list.length}`,
    }));
    const n = list.length;
    $("resultsSelfie").src = selfieUrl;
    $("resultsTitle").textContent =
      n === 0
        ? "No photos of you yet"
        : n === 1
          ? "You're in 1 photo."
          : `You're in ${n.toLocaleString()} photos.`;
    $("resultsLede").textContent =
      n === 0
        ? `We looked through all ${Number(EFM.photoCount || 0).toLocaleString()} photos and didn't find you this time.`
        : n === 1
          ? "Tap it to see it full size and save it."
          : "Tap any photo to see it full size and save it.";

    // 「全部下载」：把找到的照片 token 放进表单，交给伺服器打包成 zip
    const form = $("zipForm");
    form.querySelectorAll('input[name="t"]').forEach((x) => x.remove());
    for (const m of list) {
      const t = document.createElement("input");
      t.type = "hidden";
      t.name = "t";
      t.value = m.token;
      form.append(t);
    }
    form.hidden = n < 2;
    $("downloadAllText").textContent = `Download all ${n} (.zip)`;
    $("emptyBox").hidden = n !== 0;
    $("resultsFoot").hidden = n === 0;

    renderGrid(list);
    landing.hidden = true;
    results.hidden = false;
    if (!(history.state && history.state.efmView === "results")) {
      history.pushState({ efmView: "results" }, "");
    }
    window.scrollTo(0, 0);
    $("resultsTitle").focus({ preventScroll: true });
    layout(true);
  }

  $("zipForm").addEventListener("submit", () =>
    toast("Getting your photos ready…"),
  );

  function renderGrid(list) {
    grid.replaceChildren();
    tiles = list.map((m, i) => {
      const t = {
        el: document.createElement("a"),
        r: m.w && m.h ? m.h / m.w : 0.75,
      };
      const a = t.el;
      a.className = "tile";
      a.href = m.view_url;
      a.setAttribute("aria-label", `Photo ${i + 1} of ${list.length}`);
      if (i < 12) a.style.setProperty("--i", String(i)); // 前几张依序「显影」，后面的载入就出现
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      if (i >= 8) img.loading = "lazy";
      img.addEventListener(
        "load",
        () => {
          img.classList.add("is-in");
          // 伺服器没给比例（缩图当时还没做好）：用载入后的真实比例重排
          if (!(m.w && m.h) && img.naturalWidth) {
            t.r = img.naturalHeight / img.naturalWidth;
            scheduleLayout();
          }
        },
        { once: true },
      );
      img.addEventListener("error", () => img.classList.add("is-in"), {
        once: true,
      });
      img.src = m.thumb_url;
      a.append(img);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        viewer.open(items, i, a);
      });
      grid.append(a);
      return t;
    });
  }

  // 瀑布流：每张依序放进目前最短的那一栏。照片比例事先知道，所以不用等图载入。
  let lastW = 0;
  let raf = 0;
  function scheduleLayout() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => layout(true));
  }
  function layout(force) {
    const W = grid.clientWidth;
    if (!W || (!force && W === lastW)) return;
    lastW = W;
    if (!tiles.length) {
      grid.style.height = "0px";
      return;
    }
    const cols = W < 560 ? 2 : W < 900 ? 3 : 4;
    const gap = W < 560 ? 4 : 10;
    const cw = (W - gap * (cols - 1)) / cols;
    const hs = new Array(cols).fill(0);
    for (const t of tiles) {
      let c = 0;
      for (let k = 1; k < cols; k++) if (hs[k] < hs[c] - 1) c = k;
      const h = Math.round(cw * t.r);
      t.el.style.width = `${cw}px`;
      t.el.style.height = `${h}px`;
      t.el.style.transform = `translate(${c * (cw + gap)}px, ${hs[c]}px)`;
      hs[c] += h + gap;
    }
    grid.style.height = `${Math.max(...hs) - gap}px`;
  }
  new ResizeObserver(() => layout(false)).observe(grid);

  // ---------- 回首页 / 再搜一次 ----------
  function showLanding() {
    results.hidden = true;
    landing.hidden = false;
  }
  function backToStart() {
    showLanding();
    if (history.state && history.state.efmView === "results") history.back();
  }
  window.addEventListener("popstate", () => {
    const st = history.state || {};
    if (st.efmView === "results") {
      if (results.hidden && matches !== null) {
        landing.hidden = true;
        results.hidden = false;
        layout(true);
      }
    } else if (!results.hidden) {
      showLanding();
    }
  });
  $("backHome").addEventListener("click", backToStart);

  function retry() {
    // 已经同意过：直接开相机（一定要在这次点击里呼叫，手机才肯开）
    const ready = consent.checked;
    if (ready && touch) fileCamera.click();
    else if (ready && !canWebcam) fileLibrary.click();
    backToStart();
    if (ready && !touch && canWebcam) openWebcam();
    requestAnimationFrame(() => finder.scrollIntoView({ block: "center" }));
  }
  $("newSearch").addEventListener("click", retry);
  $("emptyRetry").addEventListener("click", retry);
  $("footRetry").addEventListener("click", retry);

  const topbar = $("topbar");
  window.addEventListener(
    "scroll",
    () => topbar.classList.toggle("is-stuck", window.scrollY > 4),
    {
      passive: true,
    },
  );
})();

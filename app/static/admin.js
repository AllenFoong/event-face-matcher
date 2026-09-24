/* admin.js：摄影师后台（单页；网址的 #hash 决定显示哪一区）。
   总览 / 上传 / 相簿 / 没进索引 / 来宾入口 / 设定。
   每个 API 都带 X-Admin-Key。密钥放 sessionStorage（关掉分页就忘），勾了「记住」才放 localStorage。 */
(() => {
  "use strict";

  // ======================= 小工具 =======================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const APP = document.title;

  /* 建 DOM 的小帮手。使用者上传的档名一律当文字（textContent），绝不当 HTML。 */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(
        kid instanceof Node ? kid : document.createTextNode(String(kid)),
      );
    }
    return el;
  }
  /* replaceChildren 会把 null 变成字面上的 "null"：先滤掉空的 */
  const fill = (el, ...kids) =>
    el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "ic");
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", `#i-${name}`);
    s.append(u);
    return s;
  }
  const n = (x) => Number(x || 0).toLocaleString("en-GB");
  const pl = (x, one, many) =>
    `${n(x)} ${Number(x) === 1 ? one : many || `${one}s`}`;
  const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtBytes(b) {
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(b / 1024))} KB`;
  }
  /* 伺服器的时间是 SQLite 的 CURRENT_TIMESTAMP（UTC，没有时区记号） */
  function parseUtc(s) {
    if (!s) return null;
    const d = new Date(`${String(s).replace(" ", "T")}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const TIME = { hour: "numeric", minute: "2-digit", hour12: true };
  function fmtWhen(d) {
    if (!d) return "";
    const now = new Date();
    const t = d.toLocaleTimeString("en-GB", TIME);
    if (d.toDateString() === now.toDateString()) return `today ${t}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `yesterday ${t}`;
    return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${t}`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function ago(d) {
    if (!d) return "";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return fmtWhen(d);
  }
  function fmtEventDate(iso) {
    if (!iso) return "";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
  }
  /* crypto.randomUUID 只有 HTTPS / localhost 能用；getRandomValues 在区网 http 下也能用 */
  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function safeGet(store, k) {
    try {
      return store.getItem(k) || "";
    } catch (e) {
      return "";
    }
  }
  function safeSet(store, k, v) {
    try {
      if (v) store.setItem(k, v);
      else store.removeItem(k);
    } catch (e) {
      /* 隐私模式 */
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), 3200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 区网 http 下没有 clipboard API：退回旧的复制方法
      const ta = h("textarea", {
        style: "position:fixed;top:0;left:0;opacity:0",
      });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  /* 删除之类不能复原的动作：自己的对话框，文字讲清楚会发生什么 */
  function confirmBox({ title, body, yes }) {
    const dlg = $("#confirm");
    $("#confirmTitle").textContent = title;
    $("#confirmBody").textContent = body;
    $("#confirmYes").textContent = yes;
    return new Promise((resolve) => {
      function done(v) {
        dlg.removeEventListener("click", onClick);
        dlg.removeEventListener("cancel", onCancel);
        dlg.close();
        resolve(v);
      }
      function onClick(e) {
        const b = e.target.closest("[data-answer]");
        if (b) done(b.dataset.answer === "yes");
      }
      function onCancel(e) {
        e.preventDefault();
        done(false);
      }
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("cancel", onCancel);
      dlg.showModal();
      $('[data-answer="no"]', dlg).focus();
    });
  }

  // ======================= API 与登入 =======================
  const KEY_STORE = "efm_admin_key";
  const BATCH_STORE = "efm_batch";
  let key = "";
  let appShown = false;
  let ov = null; // 最近一次 /api/admin/overview

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  function detailText(d) {
    if (!d) return "";
    if (typeof d === "string") return d;
    if (Array.isArray(d))
      return d
        .map((x) => x.msg || "")
        .filter(Boolean)
        .join(" ");
    return "";
  }
  async function api(path, { method = "GET", json, body } = {}) {
    const headers = { "X-Admin-Key": key };
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    let r;
    try {
      r = await fetch(path, { method, headers, body, cache: "no-store" });
    } catch (e) {
      throw new ApiError(
        0,
        "Can't reach the server. Check that it's still running.",
      );
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      const badKey = data.detail === "Invalid admin key.";
      if (badKey && appShown)
        signOut("Your admin key isn't accepted any more. Sign in again.");
      throw new ApiError(
        401,
        badKey
          ? "That admin key didn't work."
          : "Your site login expired. Reload the page.",
      );
    }
    if (!r.ok)
      throw new ApiError(
        r.status,
        detailText(data.detail) || `Something went wrong (error ${r.status}).`,
      );
    return data;
  }

  function showSignin(message) {
    appShown = false;
    $("#app").hidden = true;
    $("#signin").hidden = false;
    const err = $("#signinError");
    err.textContent = message || "";
    err.hidden = !message;
    document.title = `Sign in · ${APP}`;
    $("#keyInput").focus();
  }
  function signOut(message) {
    key = "";
    safeSet(sessionStorage, KEY_STORE, "");
    safeSet(localStorage, KEY_STORE, "");
    stopPolling();
    showSignin(message);
  }
  $("#signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const k = $("#keyInput").value.trim();
    const err = $("#signinError");
    if (!k) {
      err.textContent = "Enter the admin key.";
      err.hidden = false;
      return;
    }
    key = k;
    $("#signinBtn").disabled = true;
    try {
      await refresh();
    } catch (ex) {
      key = "";
      err.textContent =
        ex.status === 401 && ex.message.includes("admin key")
          ? "That key didn't work. Check the ADMIN_API_KEY line in the .env file."
          : ex.message;
      err.hidden = false;
      $("#signinBtn").disabled = false;
      return;
    }
    $("#signinBtn").disabled = false;
    $("#keyInput").value = "";
    safeSet(sessionStorage, KEY_STORE, k);
    safeSet(localStorage, KEY_STORE, $("#remember").checked ? k : "");
    showApp();
  });
  $("#signOut").addEventListener("click", () => signOut());

  function showApp() {
    appShown = true;
    $("#signin").hidden = true;
    $("#app").hidden = false;
    route();
    startPolling();
    resumeBatch();
  }

  // ======================= 外框：导览、网路状态、手机选单 =======================
  const NET = {
    lan: {
      dot: "dot--ok",
      title: "Same Wi-Fi only",
      short: "Photos stay on your network.",
      long: "Photos travel only over your local network and never leave this computer. Guests have to join the same Wi-Fi.",
    },
    public: {
      dot: "dot--accent",
      title: "Public link is on",
      short: "Photos pass through Cloudflare.",
      long: "Guests can connect from anywhere, even on mobile data. Photos pass through Cloudflare on the way, so they leave this computer.",
    },
    unknown: {
      dot: "",
      title: "Network unknown",
      short: "Started without the launcher.",
      long: "This server wasn't started with the launcher (启动.bat), so it can't tell whether it's reachable from outside.",
    },
  };
  const netOf = (m) => NET[(m && m.mode) || "unknown"] || NET.unknown;

  function renderChrome(d) {
    const ev = d.event;
    $("#sideEvent").textContent = ev.name || "Untitled event";
    $("#navPhotos").textContent = d.stats.photos ? n(d.stats.photos) : "";
    $("#navSkipped").textContent = d.stats.not_searchable
      ? n(d.stats.not_searchable)
      : "";
    $("#navAccess").textContent = ev.guest_open ? "" : "Paused";
    const net = netOf(d.mode);
    $("#netCard").replaceChildren(
      h("span", { class: `dot ${net.dot}` }),
      h("b", { text: net.title }),
      h("span", { text: net.short }),
    );
    $("#mobileDot").className = `dot ${net.dot}`;
    renderNavUpload();
  }

  function activeBatchSummary() {
    const b = up.batch;
    if (b && !b.finished)
      return { done: (b.server && b.server.done) || 0, total: b.total };
    const s =
      ov &&
      ov.batches.find((x) => x.status === "running" || x.status === "queued");
    return s ? { done: s.done, total: s.total } : null;
  }
  function renderNavUpload() {
    const el = $("#navUpload");
    const b = activeBatchSummary();
    if (b) {
      el.className = "nav__meta nav__meta--live";
      el.replaceChildren(
        h("span", { class: "dot dot--live" }),
        `${n(b.done)}/${n(b.total)}`,
      );
    } else {
      el.className = "nav__meta";
      el.replaceChildren();
    }
  }

  function openMenu() {
    $("#app").classList.add("is-menu");
    $("#scrim").hidden = false;
    $("#menuBtn").setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    $("#app").classList.remove("is-menu");
    $("#scrim").hidden = true;
    $("#menuBtn").setAttribute("aria-expanded", "false");
  }
  $("#menuBtn").addEventListener("click", openMenu);
  $("#scrim").addEventListener("click", closeMenu);

  // ======================= 路由 =======================
  const VIEWS = {
    overview: "Overview",
    upload: "Upload photos",
    photos: "Photos",
    skipped: "Not searchable",
    access: "Guest access",
    settings: "Settings",
  };
  let view = "";
  function route() {
    if (!appShown) return;
    let v = location.hash.slice(1);
    if (!VIEWS[v]) v = "overview";
    const changed = v !== view;
    view = v;
    $$(".view").forEach((s) => {
      s.hidden = s.dataset.view !== v;
    });
    $$("[data-nav]").forEach((a) => {
      if (a.dataset.nav === v) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.title = `${VIEWS[v]} · ${APP}`;
    $("#mobileTitle").textContent = VIEWS[v];
    closeMenu();
    if (changed) window.scrollTo(0, 0);
    const load = {
      overview: loadOverview,
      upload: loadUpload,
      photos: loadPhotos,
      skipped: loadSkipped,
      access: loadAccess,
      settings: loadSettings,
    }[v];
    Promise.resolve()
      .then(load)
      .catch((e) => toast(e.message));
  }
  window.addEventListener("hashchange", route);

  // ======================= 定时更新 =======================
  async function refresh() {
    const d = await api("/api/admin/overview");
    ov = d;
    renderChrome(d);
    if (appShown && view === "overview") renderOverview(d);
    if (appShown && view === "upload")
      $("#upBatches").replaceChildren(batchRows(d.batches));
    return d;
  }
  let pollTimer = 0;
  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (appShown && !document.hidden) {
        try {
          await refresh();
        } catch (e) {
          /* 下一轮再试 */
        }
      }
      pollTimer = setTimeout(tick, activeBatchSummary() ? 4000 : 15000);
    };
    pollTimer = setTimeout(tick, 4000);
  }
  function stopPolling() {
    clearTimeout(pollTimer);
  }

  // ======================= 总览 =======================
  async function loadOverview() {
    if (ov) renderOverview(ov);
    await refresh();
  }

  function statCard(el, { label, iconName, line, text, link }) {
    fill(
      el,
      h("div", { class: "stat__label" }, icon(iconName), label),
      h("p", { class: "stat__line" }, line),
      text ? h("p", { class: "stat__text", text }) : null,
      link
        ? h(
            "div",
            { class: "stat__foot" },
            h(
              "a",
              { class: "panel__link", href: link[1] },
              h("span", { text: link[0] }),
              icon("arrow-right"),
            ),
          )
        : null,
    );
  }

  function renderOverview(d) {
    const ev = d.event;
    const st = d.stats;
    $("#ovEvent").textContent = [
      ev.name || "Untitled event",
      fmtEventDate(ev.date),
      ev.venue,
    ]
      .filter(Boolean)
      .join(" · ");

    // 开放给来宾前的检查清单：全部做完就收起来
    const steps = [
      [st.photos > 0, "Upload photos", "#upload"],
      [!!ev.name, "Name the event", "#settings"],
      [!!ev.cover, "Choose a cover photo", "#settings"],
      [ev.guest_open, "Open guest search", "#access"],
    ];
    const setup = $("#ovSetup");
    setup.hidden = steps.every((s) => s[0]);
    if (!setup.hidden) {
      setup.replaceChildren(
        h("h2", { text: "Get ready for guests" }),
        h(
          "ol",
          null,
          steps.map(([done, label, href]) =>
            h(
              "li",
              { class: done ? "is-done" : "" },
              h(
                "a",
                { href },
                h("span", { class: "tick" }, done ? icon("check") : null),
                h("span", { text: label }),
              ),
            ),
          ),
        ),
      );
    }

    // 最新照片：一排，原比例
    const strip = $("#ovStrip");
    if (!d.latest.length) {
      strip.replaceChildren(
        h(
          "div",
          { class: "strip-empty" },
          h(
            "span",
            null,
            "No photos yet. ",
            h("a", {
              class: "textlink",
              href: "#upload",
              text: "Upload the first ones",
            }),
          ),
        ),
      );
    } else {
      const row = h("div", { class: "strip" });
      d.latest.forEach((p, i) => {
        const r = p.w && p.h ? p.w / p.h : 1.5;
        const a = h(
          "a",
          {
            href: p.view_url,
            style: `aspect-ratio:${r.toFixed(4)}`,
            "aria-label": `Open ${p.original_name}`,
          },
          h("img", {
            loading: "lazy",
            decoding: "async",
            src: p.thumb_url,
            alt: "",
          }),
        );
        a.addEventListener("click", (e) => {
          e.preventDefault();
          openPhotoViewer(d.latest, i, a);
        });
        row.append(a);
      });
      strip.replaceChildren(row);
    }

    statCard($("#ovLibrary"), {
      label: "Library",
      iconName: "photos",
      line: st.photos
        ? [
            h("span", { class: "num", text: n(st.photos) }),
            st.photos === 1 ? " photo is searchable" : " photos are searchable",
          ]
        : "No photos yet",
      text: st.photos
        ? `${pl(st.searchable_faces, "face")} in them can be matched to a guest's selfie.`
        : "Upload photos to get started.",
      link: st.not_searchable
        ? [`${pl(st.not_searchable, "photo")} not searchable`, "#skipped"]
        : ["See all photos", "#photos"],
    });

    const act = d.activity;
    statCard($("#ovGuests"), {
      label: "Guests",
      iconName: "qr",
      line: [
        h("span", {
          class: `dot ${ev.guest_open ? "dot--ok" : ""}`,
          style: "margin:0 10px 3px 0",
        }),
        ev.guest_open ? "Search is open" : "Search is paused",
      ],
      text: act.searches_24h
        ? `${pl(act.searches_24h, "search", "searches")} in the last 24 hours, ${n(act.found_24h)} of them found photos. Last one ${ago(parseUtc(act.last_search_at))}.`
        : ev.guest_open
          ? "No searches in the last 24 hours."
          : "Guests see “Photos are on their way” until you open search.",
      link: ["Show the QR code", "#access"],
    });

    const net = netOf(d.mode);
    statCard($("#ovNetwork"), {
      label: "Network",
      iconName: d.mode.mode === "public" ? "globe" : "wifi",
      line: [
        h("span", { class: `dot ${net.dot}`, style: "margin:0 10px 3px 0" }),
        net.title,
      ],
      text: net.long,
      link: ["Links and details", "#access"],
    });

    $("#ovBatches").replaceChildren(batchRows(d.batches, 4));
  }

  // 上传纪录（总览与上传页共用）
  function batchRows(list, limit) {
    if (!list || !list.length)
      return h("p", { class: "empty-line", text: "Nothing uploaded yet." });
    return h(
      "div",
      { class: "rows" },
      list.slice(0, limit || 10).map(batchRow),
    );
  }
  function batchRow(b) {
    const live = b.status === "running" || b.status === "queued";
    const stopped = b.status === "interrupted";
    const sub = [];
    if (live) sub.push(`Checking ${n(b.done)} of ${n(b.total)}`);
    else if (stopped)
      sub.push(
        `Stopped after ${n(b.done)} of ${n(b.total)}: the server restarted. Upload the rest again.`,
      );
    else sub.push(`${n(b.indexed)} ready`);
    if (b.failed)
      sub.push(
        " · ",
        h("a", { href: "#skipped", text: `${n(b.failed)} not searchable` }),
      );
    return h(
      "div",
      { class: "row" },
      h("span", {
        class: `dot ${live ? "dot--live" : stopped ? "dot--accent" : "dot--ok"}`,
      }),
      h(
        "div",
        { class: "row__main" },
        h("span", {
          class: "row__title",
          text: `${pl(b.total, "photo")} · ${cap(fmtWhen(parseUtc(b.created_at)))}`,
        }),
        h("span", { class: "row__sub" }, sub),
      ),
      live
        ? h(
            "div",
            { class: "bar" },
            h("span", { style: `width:${pct(b.done, b.total)}%` }),
          )
        : h("span", {
            class: `chip${stopped ? " chip--warn" : ""}`,
            text: stopped ? "Stopped" : "Done",
          }),
    );
  }

  // ======================= 上传 =======================
  const ALLOWED = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".heic",
    ".heif",
  ];
  const MAX_FILE = 30 * 1024 * 1024;
  // 一大批切成好几次小上传：走 Cloudflare 通道时，一次请求超过 100 秒会被切断（524）。
  // 切小也让伺服器边收边建索引，不用等全部传完。
  const CHUNK_BYTES = 20 * 1024 * 1024;
  const CHUNK_FILES = 10;
  const up = {
    files: [],
    skipped: [],
    urls: [],
    batch: null,
    timer: 0,
    samples: [],
  };
  const extOf = (name) => {
    const m = /\.[^.]+$/.exec(name || "");
    return m ? m[0].toLowerCase() : "";
  };
  const isUploading = () => !!(up.batch && up.batch.uploading);

  function addFiles(list) {
    const seen = new Set(
      up.files.map((f) => `${f.name}|${f.size}|${f.lastModified}`),
    );
    for (const f of list) {
      const id = `${f.name}|${f.size}|${f.lastModified}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!ALLOWED.includes(extOf(f.name)))
        up.skipped.push({ name: f.name, why: "not a photo" });
      else if (f.size > MAX_FILE)
        up.skipped.push({
          name: f.name,
          why: `${fmtBytes(f.size)}, over 30 MB`,
        });
      else if (!f.size) up.skipped.push({ name: f.name, why: "empty file" });
      else up.files.push(f);
    }
    renderSelection();
  }

  function renderSelection() {
    const box = $("#selection");
    up.urls.forEach((u) => URL.revokeObjectURL(u));
    up.urls = [];
    if (!up.files.length && !up.skipped.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const bytes = up.files.reduce((s, f) => s + f.size, 0);
    $("#selCount").textContent = up.files.length
      ? `${pl(up.files.length, "photo")} ready to upload`
      : "Nothing to upload";
    $("#selSize").textContent = up.files.length
      ? `${fmtBytes(bytes)} in total`
      : "";
    $("#selUploadText").textContent = `Upload ${pl(up.files.length, "photo")}`;
    $("#selUpload").disabled = !up.files.length || isUploading();
    $("#selUpload").hidden = !up.files.length;

    const peek = $("#selPeek");
    peek.replaceChildren();
    const first = up.files.slice(0, 9);
    for (const f of first) {
      if (/\.(heic|heif|tiff?)$/i.test(f.name)) {
        // 浏览器画不出 HEIC / TIFF，放一个写着格式的方块
        peek.append(
          h("div", {
            class: "peek__more",
            title: f.name,
            text: extOf(f.name).slice(1).toUpperCase(),
          }),
        );
        continue;
      }
      const u = URL.createObjectURL(f);
      up.urls.push(u);
      peek.append(
        h("img", {
          loading: "lazy",
          decoding: "async",
          src: u,
          alt: "",
          title: f.name,
        }),
      );
    }
    if (up.files.length > first.length)
      peek.append(
        h("div", {
          class: "peek__more",
          text: `+${n(up.files.length - first.length)}`,
        }),
      );
    peek.hidden = !up.files.length;

    const sk = $("#selSkipped");
    sk.hidden = !up.skipped.length;
    if (up.skipped.length) {
      const names = up.skipped
        .slice(0, 5)
        .map((s) => `${s.name} (${s.why})`)
        .join(", ");
      const more =
        up.skipped.length > 5 ? `, and ${n(up.skipped.length - 5)} more` : "";
      sk.replaceChildren(
        h("b", { text: `Leaving out ${pl(up.skipped.length, "file")}: ` }),
        `${names}${more}.`,
      );
    }
  }

  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((t) =>
    dz.addEventListener(t, (e) => {
      e.preventDefault();
      dz.classList.add("is-over");
    }),
  );
  dz.addEventListener("dragleave", (e) => {
    if (!dz.contains(e.relatedTarget)) dz.classList.remove("is-over");
  });
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("is-over");
    const fs = e.dataTransfer && e.dataTransfer.files;
    if (fs && fs.length) addFiles(fs);
  });
  // 丢在拖放区外面：别让浏览器直接把那张照片打开、离开这一页
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  $("#pickBtn").addEventListener("click", () => $("#filePick").click());
  $("#filePick").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
  $("#selClear").addEventListener("click", () => {
    up.files = [];
    up.skipped = [];
    renderSelection();
  });
  $("#selUpload").addEventListener("click", () => startUpload(up.files));

  function makeChunks(files) {
    const chunks = [];
    let cur = [];
    let bytes = 0;
    for (const f of files) {
      if (
        cur.length &&
        (cur.length >= CHUNK_FILES || bytes + f.size > CHUNK_BYTES)
      ) {
        chunks.push({ files: cur, bytes });
        cur = [];
        bytes = 0;
      }
      cur.push(f);
      bytes += f.size;
    }
    if (cur.length) chunks.push({ files: cur, bytes });
    return chunks;
  }

  function sendChunk(chunk, batchId, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const f of chunk.files) fd.append("files", f, f.name);
      fd.append("batch", batchId);
      // 用 XHR 而不是 fetch：只有 XHR 拿得到「上传了几 %」
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/photos");
      xhr.setRequestHeader("X-Admin-Key", key);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onerror = () => reject(new ApiError(0, "The connection dropped."));
      xhr.onload = () => {
        let d = {};
        try {
          d = JSON.parse(xhr.responseText);
        } catch (e) {
          d = {};
        }
        if (xhr.status === 200 && d.job_id) {
          resolve(d);
          return;
        }
        if (xhr.status === 401 && d.detail === "Invalid admin key.") {
          signOut("Your admin key isn't accepted any more. Sign in again.");
        }
        const msg =
          detailText(d.detail) ||
          (xhr.status === 524
            ? "The public link timed out."
            : `Upload failed (error ${xhr.status}).`);
        reject(new ApiError(xhr.status, msg));
      };
      xhr.send(fd);
    });
  }

  function warnLeave(e) {
    e.preventDefault();
    e.returnValue = "";
  }

  async function startUpload(files, again) {
    if (!files.length || isUploading()) return;
    let b = up.batch;
    if (!again || !b) {
      b = {
        id: randomHex(16),
        total: files.length,
        sent: 0,
        inflight: 0,
        failed: [],
        refused: [],
        started: Date.now(),
      };
      up.batch = b;
      up.samples = [];
    }
    b.uploading = true;
    b.finished = false;
    b.failed = [];
    up.files = [];
    up.skipped = [];
    renderSelection();
    safeSet(
      sessionStorage,
      BATCH_STORE,
      JSON.stringify({ id: b.id, total: b.total }),
    );
    window.addEventListener("beforeunload", warnLeave);
    renderBatch();
    watchBatch();

    for (const chunk of makeChunks(files)) {
      let ok = false;
      let err = null;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const res = await sendChunk(chunk, b.id, (frac) => {
            b.inflight = chunk.files.length * frac;
            renderBatch();
          });
          ok = true;
          const refused = res.rejected || [];
          b.sent += chunk.files.length - refused.length;
          b.refused.push(
            ...refused.map((x) => ({ name: x.filename, why: x.error })),
          );
        } catch (e) {
          err = e;
          if (e.status === 401) {
            b.uploading = false;
            window.removeEventListener("beforeunload", warnLeave);
            return;
          }
          // 4xx（524 除外）是请求本身的问题，重送也一样
          if (e.status >= 400 && e.status < 500) break;
          if (attempt < 3) await sleep(1500 * attempt);
        }
      }
      b.inflight = 0;
      if (!ok)
        b.failed.push(
          ...chunk.files.map((f) => ({
            file: f,
            why: err ? err.message : "Upload failed",
          })),
        );
      renderBatch();
    }
    b.uploading = false;
    window.removeEventListener("beforeunload", warnLeave);
    renderBatch();
    watchBatch();
  }

  function watchBatch() {
    clearTimeout(up.timer);
    const b = up.batch;
    if (!b) return;
    const tick = async () => {
      if (up.batch !== b) return;
      try {
        const s = await api(`/api/admin/batches/${b.id}`);
        b.server = s;
        up.samples.push([Date.now(), s.done]);
        if (up.samples.length > 30) up.samples.shift();
      } catch (e) {
        /* 第一包还没传完时伺服器还不认得这一批（404），下一轮再问 */
      }
      const s = b.server;
      const serverBusy = s && (s.status === "running" || s.status === "queued");
      const nothingSent = !b.uploading && !s && b.sent === 0;
      if (b.uploading || serverBusy || (!s && !nothingSent)) {
        renderBatch();
        renderNavUpload();
        up.timer = setTimeout(tick, 1500);
        return;
      }
      b.finished = true;
      safeSet(sessionStorage, BATCH_STORE, "");
      ph.stale = true;
      pk.items = [];
      renderBatch();
      refresh().catch(() => {});
      if (view === "photos") loadPhotos();
      if (view === "skipped") loadSkipped();
    };
    tick();
  }

  /* 重新整理页面之后：接回同一批的进度（上传本身接不回来，建索引可以） */
  function resumeBatch() {
    let saved = null;
    try {
      saved = JSON.parse(safeGet(sessionStorage, BATCH_STORE) || "null");
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.id || (up.batch && up.batch.id === saved.id)) return;
    up.batch = {
      id: saved.id,
      total: saved.total,
      sent: 0,
      inflight: 0,
      failed: [],
      refused: [],
      resumed: true,
      uploading: false,
    };
    watchBatch();
  }

  function etaText(b) {
    if (up.samples.length < 3 || !b.server) return "";
    const [t0, d0] = up.samples[Math.max(0, up.samples.length - 20)];
    const [t1, d1] = up.samples[up.samples.length - 1];
    const rate = (d1 - d0) / ((t1 - t0) / 1000);
    const left = b.total - b.server.done - b.failed.length - b.refused.length;
    if (!(rate > 0) || left <= 0) return "";
    const s = left / rate;
    return s < 60
      ? "less than a minute left"
      : `about ${Math.round(s / 60)} min left`;
  }

  function renderBatch() {
    const panel = $("#batchPanel");
    const b = up.batch;
    if (!b) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const s = b.server || {
      total: 0,
      done: 0,
      indexed: 0,
      failed: 0,
      status: "queued",
      current: null,
    };
    const total = Math.max(b.total, s.total || 0);
    const sent = Math.max(b.sent, s.total || 0);
    const uploaded = Math.min(total, sent + (b.inflight || 0));
    const done = Math.min(s.done, total);
    const lost = b.failed.length + b.refused.length;
    const toUpload = Math.max(0, total - Math.round(uploaded) - lost);
    const waiting = Math.max(0, Math.round(uploaded) - done);
    const live = !b.finished;
    const missing = b.resumed && !live && (s.total || 0) < b.total;

    let title;
    let dot;
    if (live) {
      title = b.uploading ? "Uploading and checking" : "Checking photos";
      dot = "dot--live";
    } else if (s.status === "interrupted") {
      title = "Stopped early";
      dot = "dot--accent";
    } else {
      title = "Batch finished";
      dot = "dot--ok";
    }

    const legend = h(
      "ul",
      { class: "legend" },
      h(
        "li",
        null,
        h("i", { class: "l-done" }),
        h("b", { text: n(s.indexed) }),
        " ready",
      ),
      s.failed
        ? h(
            "li",
            null,
            h("i", { class: "l-skip" }),
            h("b", { text: n(s.failed) }),
            " not searchable",
          )
        : null,
      live && waiting
        ? h(
            "li",
            null,
            h("i", { class: "l-up" }),
            h("b", { text: n(waiting) }),
            " uploaded, waiting",
          )
        : null,
      live && toUpload
        ? h(
            "li",
            null,
            h("i"),
            h("b", { text: n(toUpload) }),
            " still to upload",
          )
        : null,
    );

    let now = null;
    if (live && s.current) {
      const eta = etaText(b);
      now = h(
        "p",
        { class: "batch__now" },
        "Now checking ",
        h("code", { text: s.current }),
        eta ? ` · ${eta}` : "",
      );
    } else if (live && b.uploading && !s.current) {
      now = h("p", {
        class: "batch__now",
        text: "Sending photos to the server…",
      });
    }

    const issues = [];
    if (b.failed.length) {
      const retry = h(
        "button",
        {
          type: "button",
          class: "btn btn--secondary btn--sm",
          style: "margin-left:10px",
        },
        icon("refresh"),
        "Try again",
      );
      retry.addEventListener("click", () =>
        startUpload(
          b.failed.map((x) => x.file),
          true,
        ),
      );
      issues.push(
        h(
          "p",
          null,
          h("b", { text: `${pl(b.failed.length, "photo")} didn't upload. ` }),
          `${b.failed[0].why} `,
          b.uploading ? null : retry,
        ),
      );
    }
    if (b.refused.length) {
      issues.push(
        h(
          "p",
          null,
          h("b", {
            text: `The server refused ${pl(b.refused.length, "file")}: `,
          }),
          b.refused
            .slice(0, 4)
            .map((x) => `${x.name} (${x.why})`)
            .join(", "),
        ),
      );
    }
    if (missing) {
      issues.push(
        h(
          "p",
          null,
          h("b", {
            text: `Only ${n(s.total)} of ${pl(b.total, "photo")} were uploaded `,
          }),
          "before the page was closed. Choose the rest again.",
        ),
      );
    }

    let note = null;
    if (live && b.uploading) {
      note =
        "Keep this tab open until the upload finishes. After that you can close it: checking continues on the computer.";
    } else if (live) {
      note =
        "Everything is uploaded. You can close this page: checking continues on the computer, and each photo is searchable as soon as it's done.";
    }

    const foot = [];
    if (!live && s.failed) {
      foot.push(
        h(
          "a",
          { class: "btn btn--secondary btn--sm", href: "#skipped" },
          `See the ${pl(s.failed, "photo")} not searchable`,
        ),
      );
    }
    if (!live) {
      const close = h("button", {
        type: "button",
        class: "btn btn--quiet btn--sm",
        text: "Dismiss",
      });
      close.addEventListener("click", () => {
        up.batch = null;
        renderBatch();
      });
      foot.push(close);
    }

    fill(
      panel,
      h(
        "div",
        { class: "batch__top" },
        h(
          "div",
          { class: "batch__title" },
          h("span", { class: `dot ${dot}` }),
          `${title} · ${pl(total, "photo")}`,
        ),
        b.started
          ? h("span", {
              class: "muted",
              text: `Started ${fmtWhen(new Date(b.started))}`,
            })
          : null,
      ),
      h(
        "div",
        {
          class: "buffer",
          role: "progressbar",
          "aria-valuemin": "0",
          "aria-valuemax": String(total),
          "aria-valuenow": String(done),
          "aria-label": "Photos checked",
        },
        h("span", {
          class: "buffer__up",
          style: `width:${pct(uploaded, total)}%`,
        }),
        h("span", {
          class: "buffer__done",
          style: `width:${pct(s.indexed, total)}%`,
        }),
        h("span", {
          class: "buffer__skip",
          style: `left:${pct(s.indexed, total)}%;width:${pct(s.failed, total)}%`,
        }),
      ),
      legend,
      now,
      issues.length ? h("div", { class: "batch__issues" }, issues) : null,
      note ? h("p", { class: "batch__note", text: note }) : null,
      foot.length
        ? h("div", { class: "btnrow", style: "margin-top:16px" }, foot)
        : null,
    );
  }

  async function loadUpload() {
    renderSelection();
    renderBatch();
    if (!ov) await refresh();
    const m = ov.mode;
    const viaPublic = !!(
      m.public_url && location.origin === new URL(m.public_url).origin
    );
    $("#upPublic").hidden = !viaPublic;
    if (viaPublic && m.lan_url)
      $("#upLocalUrl").textContent = `${m.lan_url}/admin`;
    $("#upBatches").replaceChildren(batchRows(ov.batches));
  }

  // ======================= 看大图（相簿与没进索引共用） =======================
  const viewer = window.PhotoViewer($("#viewer"), {
    caption: (it) =>
      it.caption
        ? h("div", null, h("b", { text: it.caption[0] }), it.caption[1])
        : null,
    actions: (it, i, v) => (it.actions ? it.actions(it, i, v) : []),
  });

  function facesText(p) {
    const small = (p.faces_total || 0) - (p.usable || 0);
    return (
      pl(p.usable || 0, "face") + (small > 0 ? `, ${n(small)} too small` : "")
    );
  }

  const toViewerItem = (p) => ({
    id: p.id,
    token: p.token,
    thumb: p.thumb_url,
    view: p.view_url,
    download: p.download_url,
    w: p.w,
    h: p.h,
    alt: p.original_name,
    caption: [
      p.original_name,
      `${facesText(p)} · uploaded ${fmtWhen(parseUtc(p.created_at))}`,
    ],
    name: p.original_name,
    actions: photoActions,
  });

  function openPhotoViewer(list, index, trigger) {
    // 从相簿点开：计数用整个相簿的张数，快看完手上这包时再载下一包
    const library = list === ph.items;
    viewer.open(
      list.map(toViewerItem),
      index,
      trigger,
      library
        ? {
            total: ph.total,
            onNearEnd: () => {
              if (ph.loading || ph.done) return;
              fetchPhotos(false).then(() =>
                viewer.extend(ph.items.map(toViewerItem), ph.total),
              );
            },
          }
        : null,
    );
  }

  function photoActions(it, i, v) {
    const isCover = !!(
      ov &&
      ov.event.cover &&
      ov.event.cover.token === it.token
    );
    const coverBtn = h(
      "button",
      { type: "button", class: "btn btn--ghost", disabled: isCover },
      icon("star"),
      isCover ? "Cover photo" : "Set as cover",
    );
    coverBtn.addEventListener("click", async () => {
      coverBtn.disabled = true;
      try {
        await setCover(it.token);
        toast("Cover photo updated");
        v.refresh();
      } catch (e) {
        coverBtn.disabled = false;
        toast(e.message);
      }
    });
    const delBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn--ghost",
        "aria-label": "Delete this photo",
        title: "Delete",
      },
      icon("trash"),
    );
    delBtn.addEventListener("click", async () => {
      const ok = await confirmBox({
        title: "Delete this photo?",
        body: `${it.name} will be removed from the gallery and from guest search. This can't be undone.`,
        yes: "Delete photo",
      });
      if (!ok) return;
      try {
        await api(`/api/admin/photo/${it.id}`, { method: "DELETE" });
        afterDelete([it.id]);
        v.update(
          v.items.filter((x) => x.id !== it.id),
          i,
        );
        toast("Photo deleted");
      } catch (e) {
        toast(e.message);
      }
    });
    return [coverBtn, delBtn];
  }

  async function setCover(token) {
    const ev = await api("/api/admin/event", {
      method: "PUT",
      json: { cover: token },
    });
    if (ov) ov.event = ev;
    // 相簿格子上的「封面」小标签跟着换
    ph.items.forEach((p) => {
      p.is_cover = p.token === token;
    });
    $$(".ph__cover").forEach((x) => x.remove());
    const p = ph.items.find((x) => x.token === token);
    const tile = p && $(`.ph[data-id="${p.id}"]`);
    if (tile) tile.append(coverBadge());
    renderCoverPanel();
    return ev;
  }
  const coverBadge = () =>
    h("span", { class: "ph__cover" }, icon("star"), "Cover");

  // ======================= 相簿 =======================
  const ph = {
    items: [],
    total: 0,
    q: "",
    loading: false,
    done: false,
    stale: false,
    selecting: false,
    selected: new Set(),
    seq: 0,
  };
  let phObserver = null;

  async function loadPhotos() {
    if (!phObserver) {
      phObserver = new IntersectionObserver(
        (es) => {
          if (
            es.some((e) => e.isIntersecting) &&
            view === "photos" &&
            !ph.done &&
            !ph.loading
          )
            fetchPhotos(false);
        },
        { rootMargin: "800px" },
      );
      phObserver.observe($("#phMore"));
    }
    if (!ph.items.length || ph.stale) await fetchPhotos(true);
    else renderPhotoStatus();
  }

  async function fetchPhotos(reset) {
    const seq = ++ph.seq;
    if (reset) {
      ph.items = [];
      ph.done = false;
      ph.stale = false;
      $("#phGrid").replaceChildren();
    }
    ph.loading = true;
    $("#phMore").textContent = "Loading photos…";
    let d;
    try {
      d = await api(
        `/api/admin/photos?limit=60&offset=${ph.items.length}&q=${encodeURIComponent(ph.q)}`,
      );
    } catch (e) {
      if (seq === ph.seq) {
        ph.loading = false;
        $("#phMore").textContent = e.message;
      }
      return;
    }
    if (seq !== ph.seq) return; // 期间换了搜寻字：这一包作废
    ph.loading = false;
    ph.total = d.total;
    const start = ph.items.length;
    ph.items.push(...d.photos);
    const grid = $("#phGrid");
    d.photos.forEach((p, i) => grid.append(photoTile(p, start + i)));
    ph.done = !d.photos.length || ph.items.length >= d.total;
    renderPhotoStatus();
    // 一页还没填满（萤幕很高）：观察器不会再触发，自己再拿一包
    requestAnimationFrame(() => {
      const r = $("#phMore").getBoundingClientRect();
      if (
        !ph.done &&
        !ph.loading &&
        view === "photos" &&
        r.top < window.innerHeight + 800
      )
        fetchPhotos(false);
    });
  }

  function renderPhotoStatus() {
    $("#phCount").textContent = ph.total ? n(ph.total) : "";
    const more = $("#phMore");
    if (!ph.items.length) {
      more.replaceChildren(
        ph.q
          ? `No file names contain “${ph.q}”.`
          : h(
              "span",
              null,
              "No photos yet. ",
              h("a", {
                class: "textlink",
                href: "#upload",
                text: "Upload photos",
              }),
            ),
      );
    } else {
      more.textContent = ph.done ? "" : "Loading more…";
    }
  }

  function photoTile(p) {
    const r = p.w && p.h ? p.w / p.h : 1.5;
    const cb = h("input", {
      type: "checkbox",
      class: "checkbox",
      "aria-label": `Select ${p.original_name}`,
    });
    cb.checked = ph.selected.has(p.id);
    const open = h(
      "button",
      {
        type: "button",
        class: "ph__open",
        "aria-label": `Open ${p.original_name}`,
      },
      h("img", {
        loading: "lazy",
        decoding: "async",
        src: p.thumb_url,
        alt: "",
      }),
    );
    const tile = h(
      "div",
      {
        class: `ph${cb.checked ? " is-selected" : ""}`,
        style: `--r:${r.toFixed(4)}`,
        "data-id": String(p.id),
      },
      open,
      h("label", { class: "ph__sel", title: "Select" }, cb),
      h(
        "div",
        { class: "ph__meta" },
        h("span", { text: p.original_name }),
        h("span", { text: facesText(p) }),
      ),
      p.is_cover ? coverBadge() : null,
    );
    cb.addEventListener("change", () => toggleSelect(p.id, cb.checked));
    open.addEventListener("click", () => {
      if (ph.selecting || ph.selected.size) {
        toggleSelect(p.id, !ph.selected.has(p.id));
        return;
      }
      openPhotoViewer(ph.items, ph.items.indexOf(p), open);
    });
    return tile;
  }

  function toggleSelect(id, on) {
    if (on) ph.selected.add(id);
    else ph.selected.delete(id);
    const tile = $(`.ph[data-id="${id}"]`);
    if (tile) {
      tile.classList.toggle("is-selected", on);
      $("input", tile).checked = on;
    }
    renderSelbar();
  }
  function renderSelbar() {
    const k = ph.selected.size;
    $("#selbar").hidden = k === 0;
    $("#selbarCount").textContent = `${n(k)} selected`;
    $("#phGrid").classList.toggle("is-selecting", ph.selecting || k > 0);
  }
  function clearSelection() {
    [...ph.selected].forEach((id) => toggleSelect(id, false));
  }
  $("#phSelect").addEventListener("click", () => {
    ph.selecting = !ph.selecting;
    $("#phSelect").setAttribute("aria-pressed", String(ph.selecting));
    $("#phSelect span").textContent = ph.selecting ? "Done" : "Select";
    if (ph.selecting) renderSelbar();
    else clearSelection();
  });
  $("#selbarClear").addEventListener("click", clearSelection);
  $("#selbarDelete").addEventListener("click", async () => {
    const ids = [...ph.selected];
    if (!ids.length) return;
    const ok = await confirmBox({
      title: `Delete ${pl(ids.length, "photo")}?`,
      body: "They'll be removed from the gallery and from guest search. This can't be undone.",
      yes: `Delete ${pl(ids.length, "photo")}`,
    });
    if (!ok) return;
    try {
      const d = await api("/api/admin/photos/delete", {
        method: "POST",
        json: { ids },
      });
      afterDelete(d.deleted);
      toast(`Deleted ${pl(d.deleted.length, "photo")}`);
    } catch (e) {
      toast(e.message);
    }
  });

  function afterDelete(ids) {
    const gone = new Set(ids);
    ph.items = ph.items.filter((p) => !gone.has(p.id));
    ph.total = Math.max(0, ph.total - ids.length);
    ids.forEach((id) => {
      ph.selected.delete(id);
      const t = $(`.ph[data-id="${id}"]`);
      if (t) t.remove();
    });
    pk.items = [];
    renderSelbar();
    renderPhotoStatus();
    refresh().catch(() => {});
  }

  let searchTimer = 0;
  $("#phSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ph.q = e.target.value.trim();
      fetchPhotos(true);
    }, 250);
  });

  // ======================= 没进索引 =======================
  const minFace = () => (ov && ov.matching.min_face_size) || 24;
  const REASONS = {
    too_small: {
      label: "Faces too small",
      text: (f) =>
        f.largest
          ? `Found ${pl(f.faces, "face")}, but the largest is only ${f.largest} px across. Faces need to be at least ${f.min_size || minFace()} px. This is usually a compressed copy from a chat app, so upload the original file.`
          : "The faces in this photo are too small to match. Upload the original file instead of a compressed copy.",
    },
    low_confidence: {
      label: "Faces unclear",
      text: (f) =>
        `Found ${pl(f.faces, "possible face", "possible faces")}, but none clear enough to match. Very blurry, dark or turned-away faces can't be searched.`,
    },
    no_face: {
      label: "No faces found",
      calm: true,
      text: () =>
        "No faces in this photo. That's expected for details like rings, food or the venue, but guests can't find it with a selfie.",
    },
    unreadable: {
      label: "Couldn't open",
      text: () =>
        "This file couldn't be read as a photo. It may be damaged, or in a format the server can't open. Export it again as a JPG.",
    },
    error: {
      label: "Something went wrong",
      text: () =>
        "Checking this photo failed unexpectedly. Try uploading it again.",
    },
    unknown: {
      label: "Reason not recorded",
      calm: true,
      text: () =>
        "This photo was set aside before reasons were recorded. Upload the original file to try again.",
    },
  };
  const reasonOf = (f) => REASONS[f.reason] || REASONS.unknown;
  const sk = { files: [], filter: "all" };

  async function loadSkipped() {
    const d = await api("/api/admin/rejected");
    sk.files = d.files;
    renderSkipped();
  }

  function renderSkipped() {
    const counts = {};
    sk.files.forEach((f) => {
      const k = REASONS[f.reason] ? f.reason : "unknown";
      counts[k] = (counts[k] || 0) + 1;
    });
    if (sk.filter !== "all" && !counts[sk.filter]) sk.filter = "all";
    $("#skCount").textContent = sk.files.length ? n(sk.files.length) : "";

    const kinds = Object.keys(REASONS).filter((k) => counts[k]);
    const chips = $("#skChips");
    chips.hidden = kinds.length < 2;
    chips.replaceChildren(
      ...[
        ["all", "All", sk.files.length],
        ...kinds.map((k) => [k, REASONS[k].label, counts[k]]),
      ].map(([k, label, c]) => {
        const b = h(
          "button",
          { type: "button", "aria-pressed": String(sk.filter === k) },
          label,
          h("span", { class: "num", text: n(c) }),
        );
        b.addEventListener("click", () => {
          sk.filter = k;
          renderSkipped();
        });
        return b;
      }),
    );

    const shown = sk.files.filter(
      (f) =>
        sk.filter === "all" ||
        (REASONS[f.reason] ? f.reason : "unknown") === sk.filter,
    );
    const list = $("#skList");
    if (!sk.files.length) {
      list.replaceChildren(
        h("p", {
          class: "empty-line",
          style: "padding:18px 0",
          text: "Nothing here. Every photo you've uploaded can be found by guests.",
        }),
      );
    } else {
      list.replaceChildren(...shown.map((f, i) => skipRow(f, shown, i)));
    }
    const del = $("#skDeleteAll");
    del.hidden = !shown.length;
    $("#skDeleteAllText").textContent =
      sk.filter === "all"
        ? `Delete all ${n(shown.length)}`
        : `Delete these ${n(shown.length)}`;
  }

  function skipRow(f, list, i) {
    const R = reasonOf(f);
    const thumb = h(
      "button",
      { type: "button", class: "skip__thumb", "aria-label": `View ${f.name}` },
      h("img", { loading: "lazy", src: f.thumb_url, alt: "" }),
    );
    $("img", thumb).addEventListener(
      "error",
      () =>
        thumb.replaceWith(
          h(
            "div",
            { class: "skip__thumb skip__thumb--none", title: "No preview" },
            icon("image-off"),
          ),
        ),
      { once: true },
    );
    thumb.addEventListener("click", () => openSkippedViewer(list, i, thumb));
    const del = h(
      "button",
      {
        type: "button",
        class: "btn btn--quiet btn--sm",
        "aria-label": `Delete ${f.name}`,
        title: "Delete",
      },
      icon("trash"),
    );
    del.addEventListener("click", async () => {
      const ok = await confirmBox({
        title: "Delete this photo?",
        body: `${f.name} will be deleted from the server. This can't be undone.`,
        yes: "Delete",
      });
      if (!ok) return;
      try {
        await api(`/api/admin/rejected/${encodeURIComponent(f.name)}`, {
          method: "DELETE",
        });
        sk.files = sk.files.filter((x) => x !== f);
        renderSkipped();
        refresh().catch(() => {});
        toast("Deleted");
      } catch (e) {
        toast(e.message);
      }
    });
    return h(
      "div",
      { class: "skip" },
      thumb,
      h(
        "div",
        null,
        h("div", { class: "skip__name", text: f.name, title: f.name }),
        h("div", {
          class: `skip__why${R.calm ? " skip__why--calm" : ""}`,
          text: R.label,
        }),
        h("p", { class: "skip__text", text: R.text(f) }),
        h("p", {
          class: "skip__meta",
          text: `${n(f.size_kb)} KB · added ${fmtWhen(parseUtc(f.modified))}`,
        }),
      ),
      h(
        "div",
        { class: "skip__actions" },
        h(
          "a",
          {
            class: "btn btn--secondary btn--sm",
            href: f.download_url,
            download: "",
          },
          icon("download"),
          "Download",
        ),
        del,
      ),
    );
  }

  function openSkippedViewer(list, i, trigger) {
    const items = list.map((f) => ({
      thumb: f.thumb_url,
      // 浏览器画得出来的格式给原图（看得出脸到底多小），HEIC / TIFF 只能给缩图
      view: /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) ? f.url : f.thumb_url,
      download: f.download_url,
      alt: f.name,
      caption: [f.name, reasonOf(f).label],
    }));
    viewer.open(items, i, trigger);
  }

  $("#skDeleteAll").addEventListener("click", async () => {
    const shown = sk.files.filter(
      (f) =>
        sk.filter === "all" ||
        (REASONS[f.reason] ? f.reason : "unknown") === sk.filter,
    );
    if (!shown.length) return;
    const ok = await confirmBox({
      title: `Delete ${pl(shown.length, "photo")}?`,
      body: "They'll be deleted from the server. Guests couldn't find them anyway. This can't be undone.",
      yes: `Delete ${pl(shown.length, "photo")}`,
    });
    if (!ok) return;
    try {
      const d = await api("/api/admin/rejected/delete", {
        method: "POST",
        json: { names: shown.map((f) => f.name) },
      });
      const gone = new Set(d.deleted);
      sk.files = sk.files.filter((f) => !gone.has(f.name));
      renderSkipped();
      refresh().catch(() => {});
      toast(`Deleted ${pl(d.deleted.length, "photo")}`);
    } catch (e) {
      toast(e.message);
    }
  });

  // ======================= 来宾入口 =======================
  async function loadAccess() {
    renderAccess(await api("/api/admin/access"));
  }

  const fact = (label, ...dd) =>
    h("div", null, h("dt", { text: label }), h("dd", null, ...dd));
  const status = (dot, text) =>
    h("span", { class: "status" }, h("span", { class: `dot ${dot}` }), text);

  function renderAccess(d) {
    const ev = d.event;

    // QR code 卡
    const copyBtn = h(
      "button",
      { type: "button", class: "btn btn--secondary btn--sm" },
      icon("copy"),
      "Copy link",
    );
    copyBtn.addEventListener("click", async () => {
      toast(
        (await copyText(d.guest_url))
          ? "Link copied"
          : "Couldn't copy. Select the link and copy it by hand.",
      );
    });
    const pngBtn = h(
      "a",
      {
        class: "btn btn--secondary btn--sm",
        href: d.qr_png,
        download: "guest-qr-code.png",
      },
      icon("download"),
      "PNG",
    );
    const printBtn = h(
      "button",
      { type: "button", class: "btn btn--primary btn--sm" },
      icon("printer"),
      "Print table card",
    );
    printBtn.addEventListener("click", () => printCard(d));
    fill(
      $("#qrCard"),
      h(
        "div",
        { class: "qrcard__frame" },
        h("img", {
          src: d.qr_svg,
          alt: "QR code that opens the guest page",
          width: "216",
          height: "216",
        }),
      ),
      h("p", { class: "qrcard__title", text: ev.name || "Event photos" }),
      h("p", { class: "qrcard__sub", text: "Scan to find your photos" }),
      h(
        "div",
        { class: "linkbox" },
        icon("link"),
        h("code", { text: d.guest_url, title: d.guest_url }),
      ),
      h("div", { class: "btnrow" }, copyBtn, pngBtn, printBtn),
      d.local_only
        ? h(
            "div",
            { class: "notice" },
            icon("alert"),
            h(
              "p",
              null,
              h("b", { text: "Phones can't open this link. " }),
              "It only works on this computer. Start the gallery with 启动.bat (or 启动-仅区网.bat) so guests' phones can reach it.",
            ),
          )
        : null,
      d.mode.mode === "public"
        ? h("p", {
            class: "hint",
            style: "margin-top:12px",
            text: "The public link changes every time the gallery restarts. Print new cards after a restart.",
          })
        : null,
    );

    // 来宾搜寻开关
    const sw = h("button", {
      type: "button",
      class: "switch",
      role: "switch",
      "aria-checked": String(ev.guest_open),
      "aria-label": "Guest search",
    });
    sw.addEventListener("click", async () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.disabled = true;
      try {
        d.event = await api("/api/admin/event", {
          method: "PUT",
          json: { guest_open: next },
        });
        if (ov) {
          ov.event = d.event;
          renderChrome(ov);
        }
        renderAccess(d);
        toast(next ? "Guest search is open" : "Guest search is paused");
      } catch (e) {
        sw.disabled = false;
        toast(e.message);
      }
    });
    const noPhotos = ov && ov.stats.photos === 0;
    $("#acSearch").replaceChildren(
      h(
        "div",
        { class: "switchrow" },
        h(
          "div",
          null,
          h(
            "h2",
            null,
            h("span", { class: `dot ${ev.guest_open ? "dot--ok" : ""}` }),
            ev.guest_open ? "Guest search is open" : "Guest search is paused",
          ),
          h("p", {
            text: ev.guest_open
              ? noPhotos
                ? "There are no photos yet, so guests see “Photos are on their way” until you upload some."
                : "Guests can take a selfie and find their photos right now. Pause it if you'd rather they wait, for example until the first photos are in."
              : "Guests see “Photos are on their way” instead of the selfie button. Turn it on when you're ready.",
          }),
        ),
        sw,
      ),
    );

    // 来宾怎么进得来
    const entry = [];
    if (d.token_enabled) {
      entry.push(
        fact(
          "QR code key",
          status("dot--ok", "On"),
          h("p", {
            text: `Scanning the QR code lets guests straight in, with no password. It keeps working on their phone for ${pl(d.cookie_hours, "hour")}.`,
          }),
        ),
      );
    }
    if (d.password_required) {
      entry.push(
        fact(
          "Site password",
          status("dot--ok", "On"),
          h("p", {
            text: d.token_enabled
              ? `Anyone who opens the link without scanning is asked for the username “${d.site_user}” and the site password from the .env file.`
              : `Guests are asked for the username “${d.site_user}” and the site password from the .env file. Tell them both, or set SITE_ACCESS_TOKEN in .env so scanning is enough.`,
          }),
        ),
      );
    } else {
      entry.push(
        fact(
          "Site password",
          status("dot--accent", "Off"),
          h("p", {
            text: "Anyone with the link can open the gallery. That's only safe on your own Wi-Fi. Set SITE_PASSWORD in .env to lock it.",
          }),
        ),
      );
    }
    $("#acEntry").replaceChildren(
      h(
        "div",
        { class: "panel__head" },
        h("h2", { text: "How guests get in" }),
      ),
      h("dl", { class: "facts" }, entry),
    );

    // 网路
    const m = d.mode;
    const net = netOf(m);
    const nf = [
      fact("Mode", status(net.dot, net.title), h("p", { text: net.long })),
    ];
    if (m.public_url)
      nf.push(
        fact(
          "Public link",
          h("code", { text: m.public_url }),
          h("p", { text: "Changes every time the gallery restarts." }),
        ),
      );
    if (m.lan_url)
      nf.push(
        fact(
          "Same Wi-Fi link",
          h("code", { text: m.lan_url }),
          h("p", {
            text: "Faster for guests at the venue. Works only on the same network as this computer.",
          }),
        ),
      );
    if (m.started_at) {
      const since = new Date(String(m.started_at).replace(" ", "T"));
      nf.push(
        fact(
          "Running since",
          h("p", {
            text: Number.isNaN(since.getTime())
              ? m.started_at
              : cap(fmtWhen(since)),
          }),
        ),
      );
    }
    $("#acNetwork").replaceChildren(
      h("div", { class: "panel__head" }, h("h2", { text: "Network" })),
      h("dl", { class: "facts" }, nf),
    );

    // 使用情况：只有次数
    const a = d.activity;
    $("#acActivity").replaceChildren(
      h(
        "div",
        { class: "panel__head" },
        h("h2", { text: "Activity" }),
        h("p", { text: "Counts only. Selfies are never stored." }),
      ),
      h(
        "dl",
        { class: "facts" },
        fact(
          "Last 24 hours",
          h("p", {
            text: a.searches_24h
              ? `${pl(a.searches_24h, "search", "searches")}, ${n(a.found_24h)} of them found photos`
              : "No searches yet",
          }),
        ),
        fact(
          "Last hour",
          h("p", { text: pl(a.searches_1h, "search", "searches") }),
        ),
        fact(
          "Last search",
          h("p", {
            text: a.last_search_at
              ? cap(ago(parseUtc(a.last_search_at)))
              : "None yet",
          }),
        ),
      ),
    );
  }

  /* 桌卡：活动名称 + QR + 三个步骤，印出来放在每一桌 */
  function printCard(d) {
    const ev = d.event;
    $("#printCard").replaceChildren(
      h(
        "div",
        { class: "pc" },
        h("p", { class: "pc__kicker", text: "Find your photos" }),
        h("h1", { class: "pc__title", text: ev.name || "Event photos" }),
        h("img", { class: "pc__qr", src: d.qr_svg, alt: "" }),
        h(
          "ol",
          { class: "pc__steps" },
          h("li", { text: "Scan the code with your phone's camera." }),
          h("li", { text: "Take a selfie." }),
          h("li", { text: "See and save every photo you're in." }),
        ),
        h("p", {
          class: "pc__fine",
          text: "Your selfie is only used to find your photos. It isn't saved.",
        }),
        ev.photographer
          ? h("p", {
              class: "pc__by",
              text: `Photographs by ${ev.photographer}`,
            })
          : null,
      ),
    );
    document.body.classList.add("printing");
    const img = $("#printCard img");
    const go = () => setTimeout(() => window.print(), 60);
    if (img.complete) go();
    else img.addEventListener("load", go, { once: true });
  }
  window.addEventListener("afterprint", () =>
    document.body.classList.remove("printing"),
  );

  // ======================= 设定 =======================
  async function loadSettings() {
    const ev = await api("/api/admin/event");
    if (!ov) await refresh();
    ov.event = ev;
    fillEventForm(ev);
    renderCoverPanel();
    renderMatchPanel();
    renderAccountPanel();
  }

  function fillEventForm(ev) {
    $("#evName").value = ev.name;
    $("#evDate").value = ev.date;
    $("#evVenue").value = ev.venue;
    $("#evPhotographer").value = ev.photographer;
    $("#evContact").value = ev.contact;
    $("#evError").hidden = true;
  }

  $("#eventForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#evSave");
    btn.disabled = true;
    $("#evError").hidden = true;
    try {
      const ev = await api("/api/admin/event", {
        method: "PUT",
        json: {
          name: $("#evName").value,
          date: $("#evDate").value,
          venue: $("#evVenue").value,
          photographer: $("#evPhotographer").value,
          contact: $("#evContact").value,
        },
      });
      if (ov) {
        ov.event = ev;
        renderChrome(ov);
      }
      fillEventForm(ev);
      $("#evStatus").textContent =
        "Saved. Guests see it the next time they open the page.";
      toast("Changes saved");
    } catch (ex) {
      $("#evError").textContent = ex.message;
      $("#evError").hidden = false;
    }
    btn.disabled = false;
  });
  $("#eventForm").addEventListener("input", () => {
    $("#evStatus").textContent = "Unsaved changes";
  });

  function renderCoverPanel() {
    if (!ov) return;
    const c = ov.event.cover;
    const choose = h(
      "button",
      { type: "button", class: "btn btn--secondary" },
      icon("image"),
      c ? "Change cover" : "Choose a cover photo",
    );
    choose.addEventListener("click", openPicker);
    let remove = null;
    if (c) {
      remove = h("button", {
        type: "button",
        class: "btn btn--quiet",
        text: "Remove",
      });
      remove.addEventListener("click", async () => {
        try {
          await setCover("");
          toast("Cover photo removed");
        } catch (e) {
          toast(e.message);
        }
      });
    }
    $("#coverPanel").replaceChildren(
      c
        ? h(
            "div",
            { class: "print-mini" },
            h("img", {
              src: c.thumb_url,
              alt: "Current cover photo",
              style: `aspect-ratio:${c.w && c.h ? (c.w / c.h).toFixed(4) : 1.5}`,
            }),
          )
        : h("div", { class: "print-mini--empty", text: "No cover photo" }),
      h(
        "div",
        null,
        h("h2", { text: "Cover photo" }),
        h("p", {
          text: "The first thing guests see. It's shown whole, like a print with a white border, never cropped. Without one, the page opens with just the event name.",
        }),
        h("div", { class: "btnrow" }, choose, remove),
      ),
    );
  }

  function renderMatchPanel() {
    const m = ov && ov.matching;
    if (!m) return;
    const row = (label, value, note) =>
      fact(
        label,
        h("span", { class: "status num", text: value }),
        h("p", { text: note }),
      );
    $("#matchPanel").replaceChildren(
      h(
        "div",
        { class: "panel__head" },
        h("h2", { text: "Matching" }),
        h("p", {
          text: "Read-only here. Change them in the .env file, then restart the gallery.",
        }),
      ),
      h(
        "dl",
        { class: "facts" },
        row(
          "Match threshold",
          String(m.match_threshold),
          "How alike two faces must be to count as the same person. Higher means fewer wrong photos, but a few more missed ones.",
        ),
        row(
          "Smallest face",
          `${m.min_face_size} px`,
          "Faces smaller than this are ignored. They're too small to match reliably.",
        ),
        row(
          "Results per search",
          String(m.max_results),
          "The most photos one search can return.",
        ),
        row(
          "Searches per minute",
          String(m.search_rate_per_min),
          "Per guest. Slows down anyone trying lots of other people's photos.",
        ),
      ),
    );
  }

  function renderAccountPanel() {
    const remembered = !!safeGet(localStorage, KEY_STORE);
    const out = h(
      "button",
      { type: "button", class: "btn btn--secondary" },
      icon("logout"),
      "Sign out",
    );
    out.addEventListener("click", () => signOut());
    $("#accountPanel").replaceChildren(
      h(
        "div",
        { class: "switchrow" },
        h(
          "div",
          null,
          h("h2", { text: "This browser" }),
          h("p", {
            text: remembered
              ? "You stay signed in on this computer until you sign out."
              : "You stay signed in until you close this tab.",
          }),
        ),
        out,
      ),
    );
  }

  // 选封面
  const pk = { items: [], total: 0, chosen: "", loading: false };
  async function openPicker() {
    pk.chosen = ov && ov.event.cover ? ov.event.cover.token : "";
    $("#pickerUse").disabled = true;
    $("#coverPicker").showModal();
    if (!pk.items.length) await pickerLoad();
    else renderPicker();
  }
  async function pickerLoad() {
    if (pk.loading) return;
    pk.loading = true;
    $("#pickerMore").textContent = "Loading…";
    try {
      const d = await api(
        `/api/admin/photos?limit=90&offset=${pk.items.length}`,
      );
      pk.items.push(...d.photos);
      pk.total = d.total;
    } catch (e) {
      $("#pickerMore").textContent = e.message;
      pk.loading = false;
      return;
    }
    pk.loading = false;
    renderPicker();
  }
  function renderPicker() {
    const grid = $("#pickerGrid");
    const current = ov && ov.event.cover ? ov.event.cover.token : "";
    grid.replaceChildren(
      ...pk.items.map((p) => {
        const b = h(
          "button",
          {
            type: "button",
            "aria-pressed": String(p.token === pk.chosen),
            "aria-label": p.original_name,
            title: p.original_name,
          },
          h("img", {
            loading: "lazy",
            decoding: "async",
            src: p.thumb_url,
            alt: "",
          }),
        );
        b.addEventListener("click", () => {
          pk.chosen = p.token;
          $$("button", grid).forEach((x) =>
            x.setAttribute("aria-pressed", String(x === b)),
          );
          $("#pickerUse").disabled = p.token === current;
        });
        return b;
      }),
    );
    const more = $("#pickerMore");
    if (!pk.items.length) {
      more.textContent = "Upload photos first, then choose one here.";
    } else if (pk.items.length < pk.total) {
      const b = h("button", {
        type: "button",
        class: "btn btn--secondary btn--sm",
        text: "Show more photos",
      });
      b.addEventListener("click", pickerLoad);
      more.replaceChildren(b);
    } else {
      more.textContent = "";
    }
  }
  $("#pickerUse").addEventListener("click", async () => {
    const btn = $("#pickerUse");
    btn.disabled = true;
    try {
      await setCover(pk.chosen);
      $("#coverPicker").close();
      toast("Cover photo updated");
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  });
  $$("#coverPicker [data-close]").forEach((b) =>
    b.addEventListener("click", () => $("#coverPicker").close()),
  );

  // ======================= 开始 =======================
  (async function boot() {
    key =
      safeGet(sessionStorage, KEY_STORE) || safeGet(localStorage, KEY_STORE);
    if (!key) {
      showSignin();
      return;
    }
    try {
      await refresh();
      showApp();
    } catch (e) {
      if (e.status === 401) {
        key = "";
        safeSet(sessionStorage, KEY_STORE, "");
        safeSet(localStorage, KEY_STORE, "");
        showSignin(
          e.message.includes("admin key")
            ? "Your saved admin key no longer works. Sign in again."
            : e.message,
        );
      } else {
        showApp();
        toast(e.message);
      }
    }
  })();
})();

/* viewer.js：全萤幕看照片（来宾页与管理页共用）。
   手机：左右滑换张、往下滑关闭、两指或连点两下放大、点一下藏起按钮；
   电脑：方向键换张、Esc 关闭、点照片放大、点照片外面关闭。
   先放已经载好的缩图（模糊），中尺寸大图载完再盖上去 —— 点开的瞬间就有画面。
   手机的「上一页」也会关掉它（开的时候推了一笔 history）。 */
(function () {
  "use strict";

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function PhotoViewer(dialog, opts) {
    opts = opts || {};
    const stage = dialog.querySelector(".viewer__stage");
    const frame = dialog.querySelector(".viewer__frame");
    const zoomEl = dialog.querySelector(".viewer__zoom");
    const low = dialog.querySelector(".viewer__low");
    const img = dialog.querySelector(".viewer__img");
    const count = dialog.querySelector(".viewer__count");
    const caption = dialog.querySelector(".viewer__caption");
    const topEnd = dialog.querySelector(".viewer__top-end");
    const actions = dialog.querySelector(".viewer__actions");
    const dl = dialog.querySelector("[data-download]");
    const prevBtn = dialog.querySelector("[data-prev]");
    const nextBtn = dialog.querySelector("[data-next]");

    let items = [];
    let index = 0;
    let total = 0;
    let onNearEnd = null;
    let openId = "";
    let isOpen = false;
    let returnFocus = null;
    let extra = [];
    const preloaded = new Map();
    const z = { s: 1, x: 0, y: 0 };

    // ---------- 显示某一张 ----------
    function show(i) {
      index = clamp(i, 0, items.length - 1);
      const it = items[index];
      resetZoom(false);
      img.classList.remove("is-ready");
      img.onload = () => {
        if (items[index] === it) img.classList.add("is-ready");
      };
      low.src = it.thumb || it.view;
      img.src = it.view || it.thumb;
      img.alt = it.alt || "";
      if (it.download) {
        dl.hidden = false;
        dl.href = it.download;
      } else {
        dl.hidden = true;
      }
      syncNav();
      caption.replaceChildren();
      const cap = opts.caption && opts.caption(it, index);
      if (cap) caption.append(cap);
      extra.forEach((n) => n.remove());
      extra = (opts.actions && opts.actions(it, index, api)) || [];
      extra.forEach((n) => actions.insertBefore(n, dl));
      topEnd.replaceChildren();
      const top = opts.topActions && opts.topActions(it, index, api);
      if (top) topEnd.append(...top);
      preload(index + 1);
      preload(index - 1);
    }

    /* 相簿是分页载入的：total 是整个相簿的张数，快看到手上最后几张时请呼叫端再拿一包 */
    function syncNav() {
      const t = Math.max(total, items.length);
      count.textContent =
        t > 1 ? `${index + 1} of ${t.toLocaleString("en-GB")}` : "";
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === items.length - 1;
      if (onNearEnd && items.length < t && index >= items.length - 3)
        onNearEnd();
    }

    function preload(i) {
      const it = items[i];
      if (!it || !it.view || preloaded.has(it.view)) return;
      const p = new Image();
      p.src = it.view;
      preloaded.set(it.view, p);
      if (preloaded.size > 12) preloaded.delete(preloaded.keys().next().value);
    }

    // ---------- 开、关（跟浏览器的上一页连动）----------
    function open(list, i, trigger, more) {
      if (!list || !list.length) return;
      items = list;
      total = (more && more.total) || 0;
      onNearEnd = (more && more.onNearEnd) || null;
      returnFocus = trigger || document.activeElement;
      if (!isOpen) {
        isOpen = true;
        document.documentElement.classList.add("viewer-open");
        dialog.classList.remove("is-bare");
        dialog.style.setProperty("--fade", "1");
        frame.style.transition = "";
        frame.style.transform = "";
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
        openId = `${Date.now()}-${Math.random()}`;
        history.pushState(
          Object.assign({}, history.state, { efmViewer: openId }),
          "",
        );
      }
      show(i);
      dialog.querySelector("[data-close]").focus({ preventScroll: true });
    }

    function hide() {
      if (!isOpen) return;
      isOpen = false;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
      document.documentElement.classList.remove("viewer-open");
      img.removeAttribute("src");
      low.removeAttribute("src");
      if (returnFocus && document.contains(returnFocus))
        returnFocus.focus({ preventScroll: true });
      if (opts.onClose) opts.onClose();
    }

    // 每次打开都有自己的记号：只认「这一次」推进去的那一笔 history。
    // 只看有没有记号的话，开着大图时按了重新整理，留下来的旧记号会让之后怎么按都关不掉。
    const onOurEntry = () =>
      !!(history.state && history.state.efmViewer === openId);

    function close() {
      if (onOurEntry())
        history.back(); // popstate 会接着呼叫 hide()
      else hide();
    }

    window.addEventListener("popstate", () => {
      if (isOpen && !onOurEntry()) hide();
    });
    // 页面刚载入时不可能有开着的大图：把重新整理前留下的记号拿掉
    if (history.state && history.state.efmViewer) {
      const st = Object.assign({}, history.state);
      delete st.efmViewer;
      history.replaceState(st, "");
    }
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault(); // Esc：走同一条路关，history 才不会多一笔
      close();
    });
    dialog
      .querySelectorAll("[data-close]")
      .forEach((b) => b.addEventListener("click", close));
    prevBtn.addEventListener("click", () => go(-1));
    nextBtn.addEventListener("click", () => go(1));
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    });

    // ---------- 换张（滑动时照片先滑出去，新的从另一边进来）----------
    function go(dir, swiped) {
      const ni = index + dir;
      if (ni < 0 || ni >= items.length) {
        snapBack();
        return;
      }
      if (!swiped || reduceMotion) {
        show(ni);
        return;
      }
      const w = stage.clientWidth;
      frame.style.transition = "transform .17s ease-out";
      frame.style.transform = `translate3d(${-dir * w}px,0,0)`;
      setTimeout(() => {
        show(ni);
        frame.style.transition = "none";
        frame.style.transform = `translate3d(${dir * w * 0.3}px,0,0)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            frame.style.transition = "transform .26s cubic-bezier(.2,.7,.2,1)";
            frame.style.transform = "";
          }),
        );
      }, 170);
    }

    function snapBack() {
      frame.style.transition = "transform .22s cubic-bezier(.2,.7,.2,1)";
      frame.style.transform = "";
      dialog.style.setProperty("--fade", "1");
    }

    // ---------- 放大 ----------
    function fitted() {
      // 照片以 contain 放进 frame 后实际占的大小
      const W = frame.clientWidth;
      const H = frame.clientHeight;
      const it = items[index] || {};
      let r = it.w && it.h ? it.w / it.h : 0;
      if (!r && img.naturalWidth) r = img.naturalWidth / img.naturalHeight;
      if (!r) r = W / H;
      return W / H > r ? { w: H * r, h: H, W, H } : { w: W, h: W / r, W, H };
    }
    function center() {
      const rect = frame.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    function clampPan() {
      const f = fitted();
      const mx = Math.max(0, (f.w * z.s - f.W) / 2);
      const my = Math.max(0, (f.h * z.s - f.H) / 2);
      z.x = clamp(z.x, -mx, mx);
      z.y = clamp(z.y, -my, my);
    }
    function applyZoom(animate) {
      zoomEl.classList.toggle("is-animating", !!animate);
      zoomEl.style.transform =
        z.s === 1 && !z.x && !z.y
          ? ""
          : `translate3d(${z.x}px,${z.y}px,0) scale(${z.s})`;
      dialog.classList.toggle("is-zoomed", z.s > 1);
    }
    function resetZoom(animate) {
      z.s = 1;
      z.x = 0;
      z.y = 0;
      applyZoom(animate);
    }
    function zoomAt(px, py, s, animate) {
      // 让手指 / 滑鼠底下那一点在放大前后停在原位
      const c = center();
      const ix = (px - c.x - z.x) / z.s;
      const iy = (py - c.y - z.y) / z.s;
      z.s = clamp(s, 1, 4);
      z.x = px - c.x - ix * z.s;
      z.y = py - c.y - iy * z.s;
      if (z.s === 1) z.x = z.y = 0;
      clampPan();
      applyZoom(animate);
    }
    function onPhoto(px, py) {
      const f = fitted();
      const c = center();
      return (
        Math.abs(px - (c.x + z.x)) <= (f.w * z.s) / 2 &&
        Math.abs(py - (c.y + z.y)) <= (f.h * z.s) / 2
      );
    }

    // ---------- 手势 ----------
    const pts = new Map();
    let g = null;
    let lastTap = 0;
    let lastTapAt = { x: 0, y: 0 };
    let tapTimer = 0;

    stage.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        g = {
          kind: "drag",
          x0: e.clientX,
          y0: e.clientY,
          zx: z.x,
          zy: z.y,
          moved: false,
          axis: null,
          mouse: e.pointerType === "mouse",
        };
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = {
          kind: "pinch",
          d0: dist(a, b) || 1,
          s0: z.s,
          m0: mid(a, b),
          zx: z.x,
          zy: z.y,
        };
        snapBack();
      }
    });

    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && !g) {
        stage.style.cursor =
          z.s > 1
            ? "grab"
            : onPhoto(e.clientX, e.clientY)
              ? "zoom-in"
              : "default";
      }
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (g.kind === "pinch") {
        if (pts.size < 2) return;
        const [a, b] = [...pts.values()];
        const m = mid(a, b);
        const c = center();
        const ix = (g.m0.x - c.x - g.zx) / g.s0;
        const iy = (g.m0.y - c.y - g.zy) / g.s0;
        z.s = clamp((g.s0 * dist(a, b)) / g.d0, 1, 4);
        z.x = m.x - c.x - ix * z.s;
        z.y = m.y - c.y - iy * z.s;
        clampPan();
        applyZoom(false);
        return;
      }

      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
      if (!g.moved) return;
      if (z.s > 1) {
        // 放大中：拖曳是移动照片
        z.x = g.zx + dx;
        z.y = g.zy + dy;
        clampPan();
        applyZoom(false);
        return;
      }
      if (g.mouse) return; // 滑鼠拖曳不当成滑动换张
      if (!g.axis) g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      frame.style.transition = "none";
      if (g.axis === "x") {
        // 第一张再往右、最后一张再往左：加阻力，让人知道没有了
        const edge =
          (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1);
        frame.style.transform = `translate3d(${edge ? dx / 3 : dx}px,0,0)`;
      } else if (dy > 0) {
        frame.style.transform = `translate3d(0,${dy}px,0) scale(${1 - Math.min(dy / 1400, 0.12)})`;
        dialog.style.setProperty("--fade", String(1 - Math.min(dy / 520, 0.5)));
      }
    });

    function endPointer(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.kind === "pinch") {
        if (pts.size === 1) {
          // 放开一指：剩下那一指接着拖
          const [p] = [...pts.values()];
          g = {
            kind: "drag",
            x0: p.x,
            y0: p.y,
            zx: z.x,
            zy: z.y,
            moved: true,
            axis: null,
            mouse: false,
          };
        } else if (pts.size === 0) {
          g = null;
          if (z.s < 1.08) resetZoom(true);
        }
        return;
      }
      const gg = g;
      g = null;
      if (e.type === "pointercancel") {
        snapBack();
        return;
      }
      const dx = e.clientX - gg.x0;
      const dy = e.clientY - gg.y0;
      if (!gg.moved) {
        tap(e);
        return;
      }
      if (z.s > 1 || gg.mouse) return;
      if (
        gg.axis === "x" &&
        Math.abs(dx) > Math.min(80, stage.clientWidth * 0.18)
      )
        go(dx < 0 ? 1 : -1, true);
      else if (gg.axis === "y" && dy > 110) close();
      else snapBack();
    }
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);

    function tap(e) {
      if (e.pointerType === "mouse") {
        if (z.s > 1) resetZoom(true);
        else if (onPhoto(e.clientX, e.clientY))
          zoomAt(e.clientX, e.clientY, 2.5, true);
        else close();
        return;
      }
      const now = performance.now();
      if (
        now - lastTap < 300 &&
        Math.hypot(e.clientX - lastTapAt.x, e.clientY - lastTapAt.y) < 32
      ) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (z.s > 1) resetZoom(true);
        else zoomAt(e.clientX, e.clientY, 2.5, true);
        return;
      }
      lastTap = now;
      lastTapAt = { x: e.clientX, y: e.clientY };
      // 点一下：藏起 / 叫回上下的按钮（稍等一下，确定不是连点两下）
      tapTimer = setTimeout(() => dialog.classList.toggle("is-bare"), 300);
    }

    window.addEventListener("resize", () => {
      if (!isOpen) return;
      clampPan();
      applyZoom(false);
    });

    const api = {
      open,
      close,
      isOpen: () => isOpen,
      get index() {
        return index;
      },
      get items() {
        return items;
      },
      /* 删掉一张之后：换成新的清单，停在原位置（或前一张）；空了就关 */
      update(list, i) {
        // 少了几张，总数也跟着少几张
        if (total)
          total = Math.max(list.length, total - (items.length - list.length));
        items = list;
        if (!items.length) {
          close();
          return;
        }
        show(clamp(i, 0, items.length - 1));
      },
      refresh() {
        if (isOpen) show(index);
      },
      /* 同一份清单多载了一包：只更新张数与箭头，不重画目前这张 */
      extend(list, newTotal) {
        items = list;
        if (newTotal != null) total = newTotal;
        if (isOpen) {
          syncNav();
          preload(index + 1);
        }
      },
    };
    return api;
  }

  window.PhotoViewer = PhotoViewer;
})();

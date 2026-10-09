/* ============================================================================
 * llm-learn 学习站 · 标题粒子（重写版 2026-10-09 · 单一路径，无重复副本）
 *
 * 用途：把**标题文字**用粒子拼出来，放在标题原来的位置；普通文字隐藏（仅留无障碍/SEO）。
 *      关键字（如「数学地基」「推理部署」）用琥珀色粒子，与页面里 <em> 的高亮对应。
 *
 * 行为：
 *   · 平时：密实成形并静止（不闪）
 *   · 鼠标划过：光标附近形成小凹口（温和斥力），移开自动复原
 *   · prefers-reduced-motion：直接画成形结果
 *   · 容器滚出视口 / 标签页隐藏：暂停（省电）
 *
 * 健壮性（重写重点）：
 *   · 单一入口 —— 上一版残留三份 sample/frame，导致「改了没反应、回退也无效」
 *   · 异常一律吞掉并回退普通文字（装饰模块绝不允许影响业务渲染）
 *   · 挂载瞬间容器常未完成布局（尺寸 0）→ 逐帧自愈，约 2 秒后才放弃
 *   · 采样点数不足（字体/尺寸不对）→ 回退普通文字，绝不显示一团糊
 *
 * API：LLM.particles.attachTitle(h1Element, options) → stop()
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = (root.LLM = root.LLM || {});

  var DEFAULTS = {
    text: '',                 // 第一行
    sub: '',                  // 第二行（可空）
    accent: [],               // 关键字数组 → 琥珀色粒子（对应标题里的 <em>）
    mainPx: 54,
    subPx: 54,
    lineGap: 1.25,            // 行距（× mainPx）
    anchorX: 0.5,             // 文字中心在容器内的横向位置
    anchorY: 0.36,            // 第一行在容器内的纵向位置
    step: 1,                  // 采样步长（1 = 笔画连续）
    maxParticles: 9000,
    dot: 2.4,
    radius: 34,               // 斥力半径
    push: 0.3,                // 斥力强度（每帧位移 px）
    pull: 0.22,               // 回位速度（纯插值，无过冲 → 不闪）
    minPoints: 600,           // 采样点数下限，低于则回退普通文字
    bootMs: 2000,             // 等待布局的最长时间
    colorBase: '214,232,255',
    colorAccent: '255,176,60',
    colorHot: '255,208,64',
    fontMain: '900 %dpx system-ui, -apple-system, "PingFang SC", "Noto Sans SC", sans-serif',
    fontSub: '600 %dpx ui-monospace, SFMono-Regular, Menlo, monospace'
  };

  function noop() {}
  function warn(m) { if (root.console && root.console.warn) root.console.warn('[particles] ' + m); }
  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }

  /** 主入口：任何异常都退回普通文字，绝不影响页面 */
  function attachTitle(h1, options) {
    try { return start(h1, merge(DEFAULTS, options || {})); }
    catch (e) { warn('已跳过：' + (e && e.message)); return noop; }
  }

  function start(h1, cfg) {
    if (!h1 || h1.dataset.particles === '1') return noop;
    var host = h1.parentNode;
    if (!host) return noop;

    if (root.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var cv = document.createElement('canvas');
    cv.className = 'hero-title-particles';
    cv.setAttribute('aria-hidden', 'true');
    host.insertBefore(cv, h1.nextSibling);

    var ctx = cv.getContext('2d');
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var W = 0, H = 0, raf = 0, running = true, stopped = false, ready = false, waited = 0;
    var points = [], parts = [];
    var mouse = { x: -999, y: -999, active: false };
    var staticMode = reducedMotion();

    /** 以**容器**为盒子（标题区已留出高度），画布尺寸与之一致 */
    function fit() {
      var r = host.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      if (!W || !H) return false;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    /** 文字光栅化 → 网格采样目标点（acc=true 属于关键字） */
    function sample() {
      if (!W || !H) return [];
      var off = document.createElement('canvas');
      off.width = W; off.height = H;
      var o = off.getContext('2d');
      o.textAlign = 'center'; o.textBaseline = 'middle';
      var fsMain = Math.round(cfg.mainPx), fsSub = Math.round(cfg.subPx);
      var cx = W * cfg.anchorX, yMain = H * cfg.anchorY, ySub = yMain + fsMain * cfg.lineGap;
      var fontMain = cfg.fontMain.replace('%d', fsMain);
      var fontSub = cfg.fontSub.replace('%d', fsSub);

      // 关键字 x 区间：用 measureText 精确算（不能 parseFloat(ctx.font) —— 那会取到字重 900）
      var ranges = [];
      function collect(line, y, font, fs) {
        if (!line) return;
        o.font = font;
        var left = cx - o.measureText(line).width / 2;
        cfg.accent.forEach(function (word) {
          if (!word) return;
          var from = 0, i;
          while ((i = line.indexOf(word, from)) >= 0) {
            ranges.push({
              x0: left + o.measureText(line.slice(0, i)).width,
              x1: left + o.measureText(line.slice(0, i + word.length)).width,
              y0: y - fs * 0.75, y1: y + fs * 0.75
            });
            from = i + word.length;
          }
        });
      }

      o.fillStyle = '#fff';
      if (cfg.text) { o.font = fontMain; o.fillText(cfg.text, cx, yMain); collect(cfg.text, yMain, fontMain, fsMain); }
      if (cfg.sub) { o.font = fontSub; o.fillText(cfg.sub, cx, ySub); collect(cfg.sub, ySub, fontSub, fsSub); }

      var data;
      try { data = o.getImageData(0, 0, W, H).data; } catch (e) { return []; }

      var step = Math.max(1, cfg.step), out = [];
      for (var y = 0; y < H; y += step) {
        for (var x = 0; x < W; x += step) {
          if (data[(y * W + x) * 4 + 3] <= 120) continue;
          var acc = false;
          for (var r = 0; r < ranges.length; r++) {
            var g = ranges[r];
            if (x >= g.x0 - 2 && x <= g.x1 + 2 && y >= g.y0 && y <= g.y1) { acc = true; break; }
          }
          out.push({ x: x, y: y, acc: acc });
        }
      }
      if (out.length > cfg.maxParticles) {              // 等距抽稀：比随机抽稀均匀，笔画不易断
        var kept = [], stride = out.length / cfg.maxParticles;
        for (var k = 0; k < out.length; k += stride) kept.push(out[Math.floor(k)]);
        out = kept;
      }
      return out;
    }

    function seed() {
      parts = points.map(function (t) {
        return { x: Math.random() * W, y: Math.random() * H, tx: t.x, ty: t.y, acc: t.acc };
      });
    }

    /** 布局就绪后采样；点数不足判定失败 → 回退普通文字 */
    function boot() {
      if (!fit()) return false;
      points = sample();
      if (points.length < cfg.minPoints) return false;
      seed();
      host.classList.add('is-particles');               // 仅成功接管才隐藏文字
      ready = true;
      return true;
    }

    function fallback() {
      ready = false;
      host.classList.remove('is-particles');
      h1.style.visibility = '';
      if (cv.parentNode) cv.parentNode.removeChild(cv);
    }

    function onMove(e) {
      var r = cv.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      if (!p) return;
      mouse.x = p.clientX - r.left; mouse.y = p.clientY - r.top; mouse.active = true;
    }
    function onLeave() { mouse.active = false; mouse.x = mouse.y = -999; }

    /** 指数插值回位（无过冲 → 不闪）+ 半径内直接位移斥力（小凹口） */
    function paint() {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      var k = cfg.pull;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var dx = mouse.x - p.x, dy = mouse.y - p.y;
        var dd = Math.sqrt(dx * dx + dy * dy) || 1;
        var hot = mouse.active && dd < cfg.radius;
        if (hot) { p.x -= dx / dd * cfg.push; p.y -= dy / dd * cfg.push; }
        else { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
        ctx.fillStyle = hot ? 'rgba(' + cfg.colorHot + ',1)'
          : (p.acc ? 'rgba(' + cfg.colorAccent + ',.98)' : 'rgba(' + cfg.colorBase + ',.95)');
        ctx.fillRect(p.x, p.y, cfg.dot, cfg.dot);
      }
    }

    function paintStatic() {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        ctx.fillStyle = 'rgba(' + (p.acc ? cfg.colorAccent : cfg.colorBase) + ',.96)';
        ctx.fillRect(p.tx, p.ty, cfg.dot, cfg.dot);
      }
    }

    function frame() {
      if (stopped || !running) return;
      if (!cv.isConnected) { stop(); return; }           // 路由切换 → 自终止
      if (!ready) {
        if (boot()) { if (staticMode) paintStatic(); }
        else if (waited++ * 16 > cfg.bootMs) { fallback(); return; }
        raf = root.requestAnimationFrame(frame);
        return;
      }
      paint();
      raf = root.requestAnimationFrame(frame);
    }

    function stop() {
      stopped = true; running = false;
      root.cancelAnimationFrame(raf);
      root.removeEventListener('resize', onResize);
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('mouseleave', onLeave);
      host.removeEventListener('touchend', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      if (io) { try { io.disconnect(); } catch (e) {} }
      h1.dataset.particles = '';
      host.classList.remove('is-particles');
      if (cv.parentNode) cv.parentNode.removeChild(cv);
    }

    function onVisibility() {
      if (!ready || staticMode) return;
      running = !document.hidden;
      if (running) raf = root.requestAnimationFrame(frame);
    }

    host.addEventListener('mousemove', onMove);
    host.addEventListener('touchmove', onMove, { passive: true });
    host.addEventListener('mouseleave', onLeave);
    host.addEventListener('touchend', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    var onResize = (LLM.ui && LLM.ui.debounce) ? LLM.ui.debounce(function () {
      if (!ready) return;
      if (fit()) { points = sample(); seed(); if (staticMode) paintStatic(); }
    }, 200) : function () {};
    root.addEventListener('resize', onResize);

    var io = null;
    if (root.IntersectionObserver && !staticMode) {
      try {
        io = new root.IntersectionObserver(function (es) {
          es.forEach(function (en) {
            running = en.isIntersecting;
            if (running && ready) raf = root.requestAnimationFrame(frame);
          });
        }, { threshold: 0.05 });
        io.observe(host);
      } catch (e) { io = null; }
    }

    h1.dataset.particles = '1';
    if (boot()) { if (staticMode) paintStatic(); else raf = root.requestAnimationFrame(frame); }
    else { raf = root.requestAnimationFrame(frame); }   // 交给逐帧自愈（布局未就绪）

    return stop;
  }

  LLM.particles = { attachTitle: attachTitle, DEFAULTS: DEFAULTS };
})(typeof globalThis !== 'undefined' ? globalThis : this);

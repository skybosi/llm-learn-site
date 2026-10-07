/* ============================================================================
 * llm-learn 学习站 · UI 层：DOM 助手 / 提示 / 弹窗 / 灯箱 / Markdown 渲染
 * 依赖：vendored marked + KaTeX + highlight.js，以及 assets/math.js（window.MathView）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var fmt = LLM.fmt;

  /* ---------------- DOM 助手 ---------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function frag() { return document.createDocumentFragment(); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function on(node, ev, sel, fn) {
    if (typeof sel === 'function') { node.addEventListener(ev, sel); return; }
    node.addEventListener(ev, function (e) {
      var t = e.target.closest(sel);
      if (t && node.contains(t)) fn(e, t);
    });
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms || 200);
    };
  }

  /* ---------------- toast ---------------- */
  function toast(msg, kind, ms) {
    var box = $('#toasts');
    if (!box) return;
    var n = el('div', 'toast' + (kind ? ' toast--' + kind : ''));
    n.innerHTML = msg;
    box.appendChild(n);
    setTimeout(function () {
      n.style.transition = 'opacity .25s, transform .25s';
      n.style.opacity = '0';
      n.style.transform = 'translateY(6px)';
      setTimeout(function () { n.remove(); }, 260);
    }, ms || 2600);
  }

  /* ---------------- 弹窗 / 确认 ---------------- */
  function modal(opts) {
    var o = opts || {};
    var rootEl = $('#modal-root');
    return new Promise(function (resolve) {
      function close(val) {
        rootEl.hidden = true;
        clear(rootEl);
        document.removeEventListener('keydown', onKey);
        if (o.onClose) o.onClose(val);
        resolve(val);
      }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      clear(rootEl);
      var box = el('div', 'modal');
      var head = el('div', 'modal-head');
      head.appendChild(el('div', 'modal-title', o.title || ''));
      var x = el('button', 'icon-btn', '✕');
      x.title = '关闭';
      x.addEventListener('click', function () { close(null); });
      head.appendChild(x);
      var body = el('div', 'modal-body');
      if (typeof o.body === 'string') body.innerHTML = o.body;
      else if (o.body) body.appendChild(o.body);
      var foot = el('div', 'modal-foot');
      (o.actions || [{ label: '知道了', primary: true, value: true }]).forEach(function (a) {
        var b = el('button', 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' btn--danger' : ''), a.label);
        b.addEventListener('click', function () {
          if (a.onClick) { if (a.onClick(close) === false) return; }
          close(a.value === undefined ? true : a.value);
        });
        foot.appendChild(b);
      });
      box.appendChild(head);
      box.appendChild(body);
      if (foot.children.length) box.appendChild(foot);
      rootEl.appendChild(box);
      rootEl.hidden = false;
      document.addEventListener('keydown', onKey);
      rootEl.onclick = function (e) { if (e.target === rootEl) close(null); };
      var focusable = body.querySelector('input,textarea,select,button');
      if (focusable) setTimeout(function () { focusable.focus(); }, 30);
      o.after && o.after(body, close);
    });
  }
  function confirmBox(title, text, okLabel) {
    return modal({
      title: title,
      body: '<p>' + (text || '') + '</p>',
      actions: [{ label: '取消', value: false }, { label: okLabel || '确定', primary: true, value: true }],
    }).then(function (v) { return v === true; });
  }

  /* ---------------- 图片灯箱 ---------------- */
  function lightbox(list, index) {
    var items = (list || []).filter(function (x) { return x && x.src; });
    if (!items.length) return;
    var i = Math.max(0, Math.min(index || 0, items.length - 1));
    var box = el('div', 'lightbox');
    box.tabIndex = -1;
    function paint() {
      clear(box);
      var it = items[i];
      var img = el('img');
      img.src = it.src;
      img.alt = it.alt || '';
      box.appendChild(img);
      if (it.alt || it.cap) box.appendChild(el('div', 'lightbox-cap', it.cap || it.alt));
      var bar = el('div', 'lightbox-bar');
      var prev = el('button', 'icon-btn', '‹');
      var next = el('button', 'icon-btn', '›');
      prev.disabled = i === 0; next.disabled = i === items.length - 1;
      prev.addEventListener('click', function (e) { e.stopPropagation(); if (i > 0) { i--; paint(); } });
      next.addEventListener('click', function (e) { e.stopPropagation(); if (i < items.length - 1) { i++; paint(); } });
      var open = el('a', 'icon-btn', '↗');
      open.href = it.src; open.target = '_blank'; open.rel = 'noreferrer'; open.title = '新标签页打开原图';
      bar.appendChild(prev);
      bar.appendChild(el('span', null, (i + 1) + ' / ' + items.length));
      bar.appendChild(next);
      bar.appendChild(open);
      box.appendChild(bar);
      box.appendChild(el('div', 'lightbox-cap small', 'Esc 关闭 · ← → 切换 · 点击空白处关闭'));
    }
    paint();
    function close() {
      box.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && i > 0) { i--; paint(); }
      else if (e.key === 'ArrowRight' && i < items.length - 1) { i++; paint(); }
    }
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
  }

  /* ---------------- 进度环 / 条 ---------------- */
  function ring(done, total, opts) {
    var o = opts || {};
    var p = fmt.pct(done, total);
    var wrap = el('span', 'ring' + (o.size === 'sm' ? ' ring--sm' : '') + (o.chip ? ' ring--chip' : ''));
    wrap.title = o.title || (done + ' / ' + total + ' 课时已完成');
    var C = 2 * Math.PI * 15.5;
    wrap.innerHTML =
      '<svg viewBox="0 0 36 36" aria-hidden="true">' +
      '<circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>' +
      '<circle class="ring-fg" cx="18" cy="18" r="15.5" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - p / 100)).toFixed(1) + '"></circle>' +
      '</svg><span class="ring-label">' + (o.label != null ? o.label : p + '%') + '</span>';
    return wrap;
  }
  function bar(done, total, cls) {
    var p = fmt.pct(done, total);
    var w = el('div', 'bar' + (cls ? ' ' + cls : ''));
    w.innerHTML = '<i style="width:' + p + '%"></i>';
    return w;
  }

  /* ---------------- 图标（内联 SVG，跟随文字色；不引入图标库） ---------------- */
  var ICONS = {
    layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4"/><path d="M9 13h.01M15 13h.01"/><path d="M9.5 16h5"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    shield: '<path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
    gauge: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 7v8"/><path d="M4 19h16"/>',
    graph: '<circle cx="6" cy="18" r="2.2"/><circle cx="12" cy="6" r="2.2"/><circle cx="18" cy="15" r="2.2"/><path d="M7.6 16.4 10.6 8M13.6 7.6 16.6 13"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A2.5 2.5 0 0 1 11.5 3h1A2.5 2.5 0 0 1 15 5.5V7"/><path d="M3 12h18"/>',
    route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h5.5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/>',
    sigma: '<path d="M17 4H7l6 8-6 8h10"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14"/>',
    network: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M12 7.2 6.4 15.8M12 7.2l5.6 8.6M7.2 18h9.6"/>',
    brain: '<path d="M9 4.5A3.5 3.5 0 0 0 5.5 8v.5A3 3 0 0 0 4 11.2 3 3 0 0 0 6 14a3 3 0 0 0 1.5 3.4A3 3 0 0 0 12 19V6a2 2 0 0 0-3-1.5Z"/><path d="M15 4.5A3.5 3.5 0 0 1 18.5 8v.5A3 3 0 0 1 20 11.2 3 3 0 0 1 18 14a3 3 0 0 1-1.5 3.4A3 3 0 0 1 12 19"/>',
    tune: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
    share: '<circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    zap: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
    boxes: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    tag: '<path d="M3 12.5V5a2 2 0 0 1 2-2h7.5L21 11.5 12.5 20 3 12.5Z"/><circle cx="8" cy="8" r="1.4"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 1 0 4.9 4.9L21 13v3l-4 4H14l-8.5-8.5A4 4 0 0 1 9 5l2.5 2.5"/>',
  };
  function iconSvg(name, size) {
    var body = ICONS[name] || ICONS.spark;
    var n = size || 20;
    return '<svg class="ico" viewBox="0 0 24 24" width="' + n + '" height="' + n + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  /* ---------------- Markdown（实现见 assets/render.js，构建期与运行期共用同一份） ---------------- */
  var MARKED_OPTS = { gfm: true, breaks: false };
  function md(mdText, opts) {
    if (LLM.render && LLM.render.md) return LLM.render.md(mdText, opts);
    // 极端情况下 render.js 没加载：退化成纯 marked（没有公式与图片包装）
    try { return new root.marked.Marked(MARKED_OPTS).parse(String(mdText == null ? '' : mdText)); }
    catch (e) { return '<pre>' + String(mdText == null ? '' : mdText) + '</pre>'; }
  }
  function resolveRel(fromFile, href) {
    return LLM.render ? LLM.render.resolveRel(fromFile, href) : href;
  }

  /** 代码高亮（映射语言别名；超长块跳过；cuda/nginx 等不在 common bundle 里就降级为纯文本） */
  // 语言别名：正文里有 cuda / dockerfile / nginx / py 这些写法，highlight.js 的 common bundle 里没有这些名字
  var hlAlias = { cuda: 'cpp', 'c++': 'cpp', dockerfile: 'bash', nginx: 'ini', sh: 'bash', shell: 'bash', py: 'python', js: 'javascript', ts: 'typescript', yml: 'yaml' };
  function highlightCode(scope) {
    var hljs = root.hljs;
    if (!hljs) return;
    $$('pre > code', scope).forEach(function (codeEl) {
      if (codeEl.dataset.hl) return;
      codeEl.dataset.hl = '1';
      var pre = codeEl.parentElement;
      var m = /language-([\w+#-]+)/.exec(codeEl.className || '');
      var lang = m ? m[1].toLowerCase() : '';
      lang = hlAlias[lang] || lang;
      var text = codeEl.textContent || '';
      if (text.length > 60000) return;
      try {
        if (lang && hljs.getLanguage(lang)) {
          codeEl.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
          codeEl.classList.add('hljs');
        } else if (!lang) {
          codeEl.classList.add('hljs');
        }
      } catch (e) { /* 高亮失败不影响阅读 */ }
    });
  }

  /** 给正文加交互：图片灯箱、代码复制、表格、外链、TOC 采集 */
  function enhance(article) {
    var imgs = $$('img.md-img', article).map(function (im) {
      return { src: im.getAttribute('src'), alt: im.getAttribute('alt') || '' };
    });
    $$('img.md-img', article).forEach(function (im, idx) {
      im.addEventListener('click', function () { lightbox(imgs, idx); });
      im.addEventListener('error', function () {
        var box = el('div', 'img-missing', '配图缺失：' + (im.getAttribute('src') || ''));
        im.replaceWith(box);
      });
    });
    $$('pre', article).forEach(function (pre) {
      if (pre.querySelector('.code-copy')) return;
      var btn = el('button', 'code-copy', '复制');
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.innerText : pre.innerText;
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1200); })
          .catch(function () { toast('复制失败，请手动选择', 'warn'); });
      });
      pre.appendChild(btn);
    });
    highlightCode(article);
    return imgs;
  }

  /** 从正文里采集 TOC（h2/h3/h4） */
  function toc(article) {
    return $$('h2, h3, h4', article).map(function (h) {
      return { id: h.id, level: Number(h.tagName[1]), text: h.textContent.replace(/#$/, '').trim() };
    });
  }

  LLM.ui = {
    el: el, frag: frag, clear: clear, $: $, $$: $$, on: on, debounce: debounce,
    toast: toast, modal: modal, confirm: confirmBox, lightbox: lightbox,
    ring: ring, bar: bar, md: md, enhance: enhance, toc: toc, resolveRel: resolveRel,
    hashId: function (text) { return LLM.render ? LLM.render.hashId(text, {}) : String(text); },
    iconSvg: iconSvg,
    icon: function (name) {
      var ico = { search: '⌕', note: '✎', done: '✓', next: '→', prev: '←', up: '↑', dl: '⤓', up2: '⤒', trash: '🗑', star: '★' };
      return ico[name] || name;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

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
    icon: function (name) {
      var ico = { search: '⌕', note: '✎', done: '✓', next: '→', prev: '←', up: '↑', dl: '⤓', up2: '⤒', trash: '🗑', star: '★' };
      return ico[name] || name;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

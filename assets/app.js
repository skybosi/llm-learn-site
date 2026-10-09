/* ============================================================================
 * llm-learn 学习站 · 应用外壳：主题 / 路由 / 搜索 / 进度 / 快捷键
 * 纯静态：没有任何 /api 调用，所有数据来自 data/*.json 与 content/**
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;

  LLM.views = LLM.views || {};

  /* ---------------- 事件总线 ---------------- */
  var listeners = {};
  LLM.on = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { LLM.off(ev, fn); }; };
  LLM.off = function (ev, fn) { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; }); };
  LLM.emit = function (ev, payload) { (listeners[ev] || []).forEach(function (f) { try { f(payload); } catch (e) { console.error(e); } }); };

  /* ---------------- 主题 ---------------- */
  var THEME_KEY = 'llmlearn.site.theme';
  function preferredTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
      if (LLM.store && LLM.store.settings) {
        var s = LLM.store.settings();
        if (s && (s.theme === 'light' || s.theme === 'dark')) return s.theme;
      }
    } catch (e) { /* 隐私模式下忽略 */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0e1118' : '#1b2559');
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    if (LLM.store && LLM.store.setSetting) { try { LLM.store.setSetting('theme', t, true); } catch (e) {} }
  }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var qIdx = h.indexOf('?');
    var query = {};
    if (qIdx >= 0) {
      h.slice(qIdx + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      h = h.slice(0, qIdx);
    }
    var seg = h.split('/').filter(Boolean).map(decodeURIComponent);
    if (!seg.length) return { name: 'home', seg: [], query: query };
    var head = seg[0];
    if (head === 'l' && seg[1]) return { name: 'lessonById', seg: seg, query: query };
    if (head === 'learn' && seg[3]) return { name: 'lesson', seg: seg, query: query };
    if (head === 'course' && seg[1]) return { name: 'course', seg: seg, query: query };
    if (head === 'courses') return { name: 'courses', seg: seg, query: query };
    if (head === 'paths') return { name: 'paths', seg: seg, query: query };
    if (head === 'figures') return { name: 'figures', seg: seg, query: query };
    if (head === 'glossary') return { name: 'glossary', seg: seg, query: query };
    if (head === 'me') return { name: 'me', seg: seg, query: query };
    if (head === 'search') return { name: 'search', seg: seg, query: query };
    return { name: 'notfound', seg: seg, query: query };
  }

  var cleanup = null;
  var currentRoute = null;

  function setNav(name) {
    var map = { home: 'home', paths: 'paths', courses: 'courses', course: 'courses', lesson: 'courses', lessonById: 'courses', figures: 'figures', glossary: 'glossary', me: 'me', search: 'courses' };
    var want = map[name] || '';
    ui.$$('.navlink').forEach(function (a) { a.classList.toggle('active', a.dataset.nav === want); });
    var nav = ui.$('#navlinks');
    if (nav) nav.classList.remove('open');
  }

  LLM.setTitle = function (t) {
    document.title = t ? t + ' · llm-learn 学习站' : 'llm-learn · 大模型系统学习站';
  };

  function render() {
    var route = parseHash();
    currentRoute = route;
    var viewRoot = ui.$('#view');
    if (typeof cleanup === 'function') { try { cleanup(); } catch (e) {} cleanup = null; }
    setNav(route.name);

    // 兜底：视图名与路由名不完全一致时（如 lessonById → lesson）也找得到，别静默变 404
    var view = LLM.views[route.name] ||
      (route.name === 'lessonById' ? LLM.views.lesson : null) ||
      LLM.views.notfound;
    ui.clear(viewRoot);
    var done = function () {
      LLM.emit('route', route);
      if (!(route.query && route.query.keepScroll)) {
        // 切页**瞬时**回顶部（用户反馈平滑滚动"晃眼"）。
        // ⚠️ 只传 behavior:'instant' 不够：CSS 里的 html{scroll-behavior:smooth} 会盖过它（Chromium 实测仍平滑）。
        //    可靠做法：临时把内联 scroll-behavior 设为 auto（内联 > 样式表），滚完再还原（页面内锚点仍保留平滑）。
        var _de = document.documentElement, _prev = _de.style.scrollBehavior;
        _de.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
        _de.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
        _de.style.scrollBehavior = _prev;
      }
    };
    try {
      // ②/③（CDN + 按需加载）已回退：CDN 在本机不可达、异步渲染路径也不稳 → 恢复本地 eager（defer，不阻塞首绘）
      var r = view ? view.render(viewRoot, route) : null;
      // 视觉升级要在 DOM 就绪后跑：等 render 的 Promise 落地（或同步渲染后下一帧）
      var afterRender = function () { try { enhanceVisuals(viewRoot); } catch (e) {} };
      if (r && typeof r.then === 'function') r.then(afterRender, afterRender);
      else setTimeout(afterRender, 0);
      if (r && typeof r.then === 'function') {
        r.then(function (c) { cleanup = c || null; done(); })
         .catch(function (e) { showError(viewRoot, e); done(); });
      } else {
        cleanup = (typeof r === 'function' ? r : null);
        done();
      }
    } catch (e) {
      showError(viewRoot, e);
      done();
    }
  }

  function showError(viewRoot, e) {
    console.error(e);
    ui.clear(viewRoot);
    var box = ui.el('div', 'container container--narrow');
    box.innerHTML = '<div class="empty"><strong>这个页面没能渲染出来</strong>' +
      '<p class="small">' + fmt.esc(e && e.message ? e.message : String(e)) + '</p>' +
      '<p><a class="btn btn--primary" href="#/">回到首页</a></p></div>';
    viewRoot.appendChild(box);
  }

  LLM.go = function (hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  };
  LLM.route = function () { return currentRoute; };

  /* ---------------- 顶栏进度 / 阅读进度条 ---------------- */
  function paintProgress() {
    if (!LLM.store || !LLM.store.stats) return;
    var st;
    try { st = LLM.store.stats(); } catch (e) { return; }
    var p = st.totalLessons ? Math.round((st.doneLessons / st.totalLessons) * 100) : 0;
    var fg = ui.$('#mini-ring-fg');
    if (fg) {
      var C = 2 * Math.PI * 15.5;
      fg.setAttribute('stroke-dasharray', C.toFixed(1));
      fg.setAttribute('stroke-dashoffset', (C * (1 - p / 100)).toFixed(1));
    }
    var txt = ui.$('#mini-text');
    if (txt) txt.textContent = p + '%';
    var mini = ui.$('#mini-progress');
    if (mini) mini.title = '已完成 ' + st.doneLessons + ' / ' + st.totalLessons + ' 课时 · 笔记 ' + (st.notes || 0) + ' 条';
  }
  function paintReadbar() {
    var bar = ui.$('#readbar');
    if (!bar) return;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var p = h > 0 ? Math.min(100, Math.max(0, (window.scrollY / h) * 100)) : 0;
    if (!bar.firstChild) bar.appendChild(document.createElement('i'));
    bar.firstChild.style.width = p + '%';
  }

  /* ---------------- 全站搜索浮层 ---------------- */
  var overlay, input, results, scopeEl;
  var searchIndex = null;   // {lessons:[], terms:[], courses:[]}
  var activeIdx = -1;
  var lastResults = [];

  var indexPromise = null;

  /**
   * 建搜索索引：**先出快索引**（课时标题 + 小标题 + 课程名，只要 2 个请求），
   * 词条（22 个分片、1.4MB）在后台补齐后再刷一次结果。
   * 为什么：一上来就等 23 个请求，用户敲完关键词会看到「没找到」——这是最伤的假空态。
   */
  function buildIndex() {
    if (searchIndex) return Promise.resolve(searchIndex);
    if (indexPromise) return indexPromise;
    indexPromise = Promise.all([data.search(), data.courses()]).then(function (res) {
      var items = res[0] || [];
      var courses = res[1] || [];
      searchIndex = {
        lessons: items.map(function (it) {
          return { kind: 'lesson', id: it[0], slug: it[1], title: it[2], chapter: it[3], heads: it[4] || '', snippet: it[5] || '' };
        }),
        courses: courses.map(function (c) { return { kind: 'course', slug: c.slug, title: c.title, desc: c.description, line: c.line }; }),
        terms: [],
      };
      // 后台补词条：补完广播一次，打开着的搜索浮层会重刷
      data.glossaryIndex().then(function (gIdx) {
        var layers = (gIdx.layers || []).slice(0, 40);
        return Promise.all(layers.map(function (l) {
          return data.glossaryLayer(l.id).then(function (d) { return { layer: l, terms: d.terms || [] }; }).catch(function () { return null; });
        }));
      }).then(function (all) {
        all.filter(Boolean).forEach(function (L) {
          L.terms.forEach(function (t) {
            searchIndex.terms.push({ kind: 'term', key: t.key, layer: L.layer.id, layerName: L.layer.name, zh: t.zh, en: t.en, def: t.def, aliases: t.aliases || [] });
          });
        });
        LLM.emit('search-index', searchIndex);
      }).catch(function () { /* 词条补不上不影响课时搜索 */ });
      return searchIndex;
    });
    return indexPromise;
  }

  function score(hay, needle) {    var i = hay.toLowerCase().indexOf(needle);
    if (i < 0) return -1;
    return i === 0 ? 100 : (i < 8 ? 60 - i : 30 - Math.min(i, 20));
  }

  function runSearch(q) {
    if (!searchIndex) return [];
    var needle = q.trim().toLowerCase();
    if (!needle) return [];
    var out = [];
    searchIndex.courses.forEach(function (c) {
      var s = Math.max(score(c.title, needle), score(c.desc || '', needle) * 0.4);
      if (s > 0) out.push({ kind: 'course', score: s + 5, item: c });
    });
    searchIndex.lessons.forEach(function (l) {
      var s = Math.max(score(l.title, needle), score(l.heads, needle) * 0.7, score(l.snippet, needle) * 0.3);
      if (s > 0) out.push({ kind: 'lesson', score: s, item: l });
    });
    searchIndex.terms.forEach(function (t) {
      var s = Math.max(score(t.zh, needle), score(t.en || '', needle) * 0.8, score(t.def || '', needle) * 0.4);
      if (s <= 0) {
        for (var i = 0; i < t.aliases.length; i++) { if (score(t.aliases[i], needle) > 0) { s = 20; break; } }
      }
      if (s > 0) out.push({ kind: 'term', score: s, item: t });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 40);
  }

  function paintSearch(q) {
    ui.clear(results);
    lastResults = runSearch(q);
    activeIdx = lastResults.length ? 0 : -1;
    if (!q.trim()) {
      results.innerHTML = '<div class="sr-empty">输入关键词：课程名、课时标题、正文小标题、百科词条都能搜到。<br>' +
        '按 <kbd>Shift</kbd>+<kbd>Enter</kbd> 可以连正文一起搜（稍慢一些）。</div>';
      return;
    }
    if (!lastResults.length) {
      results.innerHTML = '<div class="sr-empty">没找到「' + fmt.esc(q) + '」<br><span class="small">按 Shift+Enter 试试全文深搜</span></div>';
      return;
    }
    var groups = { course: '课程', lesson: '课时', term: '关键词' };
    var curKind = null;
    lastResults.forEach(function (r, i) {
      if (r.kind !== curKind) {
        curKind = r.kind;
        results.appendChild(ui.el('div', 'sr-group', groups[r.kind] || r.kind));
      }
      var row = ui.el('div', 'sr-item' + (i === activeIdx ? ' active' : ''));
      row.dataset.idx = i;
      if (r.kind === 'course') {
        row.innerHTML = '<div class="sr-main"><div class="sr-title">' + fmt.highlight(r.item.title, q) + '</div>' +
          '<div class="sr-sub">' + fmt.esc(r.item.line || '') + ' · ' + fmt.esc(fmt.clamp(r.item.desc || '', 70)) + '</div></div>' +
          '<span class="sr-kind">课程</span>';
      } else if (r.kind === 'lesson') {
        row.innerHTML = '<div class="sr-main"><div class="sr-title">' + fmt.highlight(r.item.title, q) + '</div>' +
          '<div class="sr-sub">' + fmt.esc(r.item.slug) + ' › ' + fmt.highlight(r.item.chapter || '', q) + '</div></div>' +
          '<span class="sr-kind">课时</span>';
      } else {
        row.innerHTML = '<div class="sr-main"><div class="sr-title">' + fmt.highlight(r.item.zh, q) + '</div>' +
          '<div class="sr-sub">' + fmt.esc(r.item.layerName || '') + ' · ' + fmt.esc(fmt.clamp(r.item.def || '', 70)) + '</div></div>' +
          '<span class="sr-kind">词条</span>';
      }
      row.addEventListener('click', function () { openResult(r); });
      row.addEventListener('mousemove', function () { setActive(i); });
      results.appendChild(row);
    });
  }

  function setActive(i) {
    activeIdx = i;
    ui.$$('.sr-item', results).forEach(function (n, k) { n.classList.toggle('active', k === i); });
    var el = ui.$('.sr-item.active', results);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function openResult(r) {
    closeSearch();
    if (r.kind === 'course') LLM.go('#/course/' + r.item.slug);
    else if (r.kind === 'lesson') LLM.go('#/l/' + r.item.id);
    else LLM.go('#/glossary/t/' + r.item.key);
  }

  function openSearch(prefill) {
    overlay = overlay || ui.$('#search-overlay');
    input = input || ui.$('#search-input');
    results = results || ui.$('#search-results');
    scopeEl = scopeEl || ui.$('#search-scope');
    overlay.hidden = false;
    document.body.classList.add('no-scroll');
    var st = LLM.store && LLM.store.stats ? LLM.store.stats() : null;
    if (scopeEl) scopeEl.textContent = st ? ('你的进度：已完成 ' + st.doneLessons + ' / ' + st.totalLessons + ' 课时') : '';
    buildIndex().then(function () {
      if (prefill) input.value = prefill;
      paintSearch(input.value || '');
      input.focus();
      input.select();
    }).catch(function (e) { toast('搜索索引加载失败：' + fmt.esc(e.message), 'err'); });
  }
  function closeSearch() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  /**
   * 版本守望：记住这次打开时的构建时间，之后每次页面重新可见时（复用标签页/切回来）
   * 拉一次 data/build-info.json（no-store），变了就提示刷新。
   */
  /** ISO 时间 → 本地时区可读串（页脚不要显示 UTC，会让人以为构建时间不对） */
  function localTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var lastBuildAt = null;
  var lastCheck = 0;
  function watchForNewBuild(builtAt) {
    if (!builtAt) return;
    lastBuildAt = builtAt;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < 120000) return;      // 两分钟内不重复查
      lastCheck = Date.now();
      fetch('data/build-info.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (!info || !info.builtAt || info.builtAt === lastBuildAt) return;
          lastBuildAt = info.builtAt;
          var box = ui.$('#toasts');
          if (!box) return;
          var n = ui.el('div', 'toast toast--ok');
          n.innerHTML = '站点有更新（#' + fmt.esc(info.sourceCommit || '') + '）<br><a href="#" id="reload-new">点这里刷新</a>';
          box.appendChild(n);
          var a = n.querySelector('#reload-new');
          if (a) a.addEventListener('click', function (e) { e.preventDefault(); location.reload(); });
        })
        .catch(function () { /* 离线/失败就算了 */ });
    });
  }

  /* 页内锚点（目录）保留平滑滚动：全局 smooth 已关，这里按需平滑 */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]:not([href^="#/"])') : null;
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  });

  /* ---------------- 按需加载（KaTeX / highlight 只在课时与百科路由加载）----------------
     首页/课程/图表库等页面不需要这 ~392KB，之前是全局 <script> 无条件加载 → 首屏变慢。 */
  var _libsPromise = null;
  // 国内 CDN 优先（GitHub Pages 跨境 RTT 4–9 秒），失败自动回落仓库内文件 → 离线仍可用
  var CDN = 'https://cdn.staticfile.net/';
  // ⚠️ 必须带超时：CDN 不可达时 onerror 常常**不触发**（连接挂着）→ 只靠 onerror 会让课时页永远渲染不出来
  var CDN_TIMEOUT = 2500;
  function loadFirst(urls) {
    return new Promise(function (resolve, reject) {
      (function tryAt(i) {
        if (i >= urls.length) { reject(new Error('全部来源失败')); return; }
        var s = document.createElement('script');
        var done = false;
        var timer = setTimeout(function () { if (!done) { done = true; s.remove(); tryAt(i + 1); } }, CDN_TIMEOUT);
        s.src = urls[i]; s.async = false;
        s.onload = function () { if (done) return; done = true; clearTimeout(timer); resolve(); };
        s.onerror = function () { if (done) return; done = true; clearTimeout(timer); s.remove(); tryAt(i + 1); };
        document.head.appendChild(s);
      })(0);
    });
  }
  // 记录 CDN 是否可用：不可用则本次会话直接用本地，避免每个课时页都白等 2.5 秒
  function cdnUsable() {
    try { return sessionStorage.getItem('cdn-ok') !== '0'; } catch (e) { return true; }
  }
  function markCdn(ok) { try { sessionStorage.setItem('cdn-ok', ok ? '1' : '0'); } catch (e) {} }
  function loadLibs() {
    if (_libsPromise) return _libsPromise;
    var css = CDN + 'katex/0.16.47/katex.min.css', cssLocal = 'assets/vendor/katex/katex.min.css';
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = css;
    l.onerror = function () { l.href = cssLocal; };
    document.head.appendChild(l);
    var katexSrc = cdnUsable() ? [CDN + 'katex/0.16.47/katex.min.js', 'assets/vendor/katex/katex.min.js'] : ['assets/vendor/katex/katex.min.js'];
    var hljsSrc = cdnUsable() ? [CDN + 'highlight.js/11.9.0/highlight.min.js', 'assets/vendor/highlight/highlight.min.js'] : ['assets/vendor/highlight/highlight.min.js'];
    _libsPromise = loadFirst(katexSrc)
      .then(function () { markCdn(!!root.katex && katexSrc.length > 1); return loadFirst(hljsSrc); })
      .catch(function () { markCdn(false); return null; });   // 失败也不阻塞（公式退化为纯文本）
    return _libsPromise;
  }
  function loadStyle(href) {
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  function loadLibs() {
    if (_libsPromise) return _libsPromise;
    loadStyle('assets/vendor/katex/katex.min.css');
    _libsPromise = loadScript('assets/vendor/katex/katex.min.js')
      .then(function () { return loadScript('assets/vendor/highlight/highlight.min.js'); })
      .catch(function () { return null; });      // 失败也不阻塞页面（公式退化为纯文本）
    return _libsPromise;
  }
  function routeNeedsLibs(route) {
    var n = (route && route.name) || '';
    return n === 'lesson' || n === 'lessonById' || n === 'glossary';
  }

  /* ---------------- 视觉升级：扫描线 / 滚动进入 / 指针光晕 ---------------- */
  var REDUCED = false;
  try { REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function enhanceVisuals(view) {
    var hero = view.querySelector ? view.querySelector('.hero') : null;
    if (hero && !REDUCED) {
      // 扫描线已按用户要求移除（2026-10-09「从上到下的光线不要」）
      hero.addEventListener('mousemove', function (e) {
        var r = hero.getBoundingClientRect();
        hero.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        hero.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    }
    if (REDUCED || !root.IntersectionObserver) return;
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    // ⚠️ 首屏元素**不能**加入场动画：opacity:0 会把首屏藏住，导致首绘被推迟（实测首次绘制 3.4s、hero 空白）
    var vh = window.innerHeight || 800;
    view.querySelectorAll('.section, .card-grid').forEach(function (el) {
      if (el.classList.contains('in') || el.classList.contains('hero')) return;
      if (el.getBoundingClientRect().top < vh * 0.9) { el.classList.add('in'); return; }   // 已在首屏 → 直接显示
      el.classList.add('reveal');
      io.observe(el);
    });
  }

  /* ---------------- 启动 ---------------- */
  // 供其它视图复用（搜索页要同一份索引，避免重复加载）
  LLM.search = { build: buildIndex, run: runSearch, open: openSearch, close: closeSearch, index: function () { return searchIndex; } };

  function initShell() {
    applyTheme(preferredTheme());
    ui.$('#btn-theme').addEventListener('click', toggleTheme);
    paintProgress();

    ui.$('#btn-menu').addEventListener('click', function () { ui.$('#navlinks').classList.toggle('open'); });
    ui.$('#btn-search').addEventListener('click', function () { openSearch(''); });
    ui.$('#btn-search-close').addEventListener('click', closeSearch);
    ui.$('#search-overlay').addEventListener('click', function (e) { if (e.target === ui.$('#search-overlay')) closeSearch(); });

    if (input == null) input = ui.$('#search-input');
    input.addEventListener('input', ui.debounce(function () { paintSearch(input.value || ''); }, 90));
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, lastResults.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) { var q = input.value.trim(); closeSearch(); LLM.go('#/search/' + encodeURIComponent(q)); }
        else if (lastResults[activeIdx]) openResult(lastResults[activeIdx]);
      } else if (e.key === 'Escape') { closeSearch(); }
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.key === '/' && !typing) { e.preventDefault(); openSearch(''); }
      else if (e.key === 'Escape') { closeSearch(); var n = ui.$('.notes-drawer.open'); if (n) n.classList.remove('open'); }
      else if ((e.key === 'd' || e.key === 'D') && !typing) { toggleTheme(); }
    });

    window.addEventListener('scroll', ui.debounce(paintReadbar, 60), { passive: true });
    window.addEventListener('hashchange', render);

    LLM.on('search-index', function () {
      if (overlay && !overlay.hidden && input) paintSearch(input.value || '');
    });
    LLM.on('progress', paintProgress);
    LLM.on('route', paintReadbar);

    // 首屏：站点统计（页脚 + 首页 hero 共用）
    data.site().then(function (s) {
      LLM.site = s;
      var f = ui.$('#footer-stats');
      if (f) {
        f.innerHTML = '<strong>内容规模</strong><p class="small muted">' +
          s.counts.courses + ' 门课 · ' + s.counts.chapters + ' 章 · ' + s.counts.lessons + ' 课时 · ' +
          fmt.num(s.counts.figures) + ' 张图表 · ' + fmt.num(s.counts.glossaryTerms) + ' 条关键词</p>';
      }
      var b = ui.$('#footer-bottom');
      if (b) {
        b.textContent = '共 ' + s.counts.courses + ' 门课 / ' + s.counts.chapters + ' 章 / ' + s.counts.lessons +
          ' 课时 · ' + fmt.num(s.counts.figures) + ' 张图表 · ' + fmt.num(s.counts.glossaryTerms) + ' 条关键词';
      }
      // 版本信息单独一栏（放 footer 里，位置固定；点 commit 可看完整 build-info.json）
      var v = ui.$('#footer-version');
      if (v) {
        ui.clear(v);
        var head = ui.el('span', 'fv-label', '站点版本');
        v.appendChild(head);
        if (s.build && s.build.sourceCommit) {
          var code = ui.el('a', 'fv-code mono', '#' + s.build.sourceCommit);
          code.href = 'data/build-info.json';
          code.target = '_blank';
          code.rel = 'noreferrer';
          code.title = '源仓 commit ' + (s.build.sourceCommitFull || '') +
            (s.build.sourceDirty ? '（构建时源仓有未提交改动）' : '') +
            '\n内容版本 ' + (s.build.contentVersion || '') +
            '\n构建于 ' + localTime(s.build.builtAt);
          v.appendChild(code);
          var dot = function () { v.appendChild(ui.el('span', 'fv-dot', '·')); };
          dot();
          v.appendChild(ui.el('span', 'fv-item', '构建于 ' + localTime(s.build.builtAt)));
          dot();
          v.appendChild(ui.el('span', 'fv-item', '内容版本 ' + (s.build.contentVersion || '—')));
        } else {
          v.appendChild(ui.el('span', 'fv-item', '内容更新于 ' + String(s.generated).slice(0, 10)));
        }
      }
      // 页面一直开着时，若线上已经换了一版，提示刷新（静态站最常见的困惑：我看到的到底是不是最新）
      watchForNewBuild(s.build && s.build.builtAt);
      LLM.emit('site', s);
    }).catch(function (e) {
      console.warn('site.json 加载失败', e);
    });

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initShell);
  else initShell();
})(typeof globalThis !== 'undefined' ? globalThis : this);

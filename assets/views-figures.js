/* ============================================================================
 * llm-learn 学习站 · 图表库视图（#/figures、#/figures/<courseSlug>）
 *
 * 为什么单独成文件：全站 1000+ 张图，一次插 1000 个 <img> 会把首屏拖死，
 * 所以这里的核心是「过滤 → 排序 → 分批渲染（默认 60）→ 滚到底自动加载」。
 *
 * 路径口径（最容易搞错的一点，集中在本文件的 src / thumb 两个函数里）：
 *   data/figures.json 的 key 已经是**站点根相对**路径：courses/<slug>/assets/chapter-1-figure-01.svg
 *   但图片本体在仓库的 content/ 下，构建时被搬到站点根的 content/ 目录，
 *   所以展示 URL = 'content/' + src（= content/courses/<slug>/assets/x.svg）。
 *   全部相对路径、不以 / 开头 —— 这样站点丢到子路径也能跑。
 *
 * 依赖：LLM.ui（el/clear/$/on/lightbox）、LLM.fmt（esc/num）、LLM.data（site/courses/figures）
 *       LLM.setTitle / LLM.go（app.js 提供）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  var PAGE = 60;                       // 每批渲染张数：首屏 60 个 <img> 是「够看又不卡」的平衡点
  var FALLBACK_AR = '914 / 474';       // 数据缺 w/h 时的兜底宽高比（与 site.css 里 .fig-item img 默认一致）

  /* ---------------- 路径 / 命名解析 ---------------- */

  /** 站点根相对路径 → 展示 URL（见文件头「路径口径」） */
  function src(url) { return 'content/' + String(url || ''); }

  /** 缩略图与外链同源：同目录同名，只用于语义清晰的调用点 */
  function thumb(url) { return src(url); }

  /** courses/<slug>/assets/chapter-3-figure-07.svg → 3（取不到返回 0，用于排序兜底） */
  function chapterNo(url) {
    var m = /(?:chapter|ch)-?(\d+)/i.exec(String(url || ''));
    return m ? Number(m[1]) : 0;
  }

  /** 同上 → 7（「第 k 张」的 k = 文件名末尾序号） */
  function figureNo(url) {
    var m = /(?:figure|fig)-?(\d+)/i.exec(String(url || ''));
    return m ? Number(m[1]) : 0;
  }

  /** 文件名：courses/x/assets/chapter-1-figure-01.svg → chapter-1-figure-01.svg */
  function baseName(url) {
    var p = String(url || '').split('/');
    return p[p.length - 1] || '';
  }

  /** 图注左侧文案：chapter-1 · 第 1 张（无章节号时退回文件名，绝不显示「chapter-0」） */
  function posLabel(f) {
    return f.chapter ? 'chapter-' + f.chapter + ' · 第 ' + (f.figNo || 1) + ' 张' : baseName(f.url);
  }

  /** 灯箱/alt 用的完整描述：课程名 · 章节 · 序号 */
  function fullLabel(f) {
    var course = f.courseTitle || f.slug;
    return course + ' · ' + posLabel(f);
  }

  /* ---------------- 数据 → 视图模型 ---------------- */

  /**
   * 把三份数据拼成扁平列表。
   * 为什么扁平：过滤/排序/分组都只需在这一个数组上做，渲染阶段不再查表，逻辑简单且好测。
   * @param {object} figuresMap data/figures.json：{slug:[{src,w,h}]}
   * @param {Array}  courseCards data/courses.json 的 courses（**不含 chapters**）
   * @param {Array}  siteLines   data/site.json 的 lines
   * @param {object} fullCourse  单课视图额外取到的 data/course/<slug>.json（有 chapters，用于章标题）
   * @returns {{items:Array, total:number, lineNames:Array, chaptersOf:function}}
   */
  function buildModel(figuresMap, courseCards, siteLines, fullCourse) {
    var meta = {};
    (courseCards || []).forEach(function (c) { meta[c.slug] = c; });

    // slug → 方向线：data/site.json 的 lines[].slugs 是构建期从 course-tracks.json 派生的
    var lineOf = {}, lineNames = [];
    (siteLines || []).forEach(function (l) {
      if (lineNames.indexOf(l.name) < 0) lineNames.push(l.name);
      (l.slugs || []).forEach(function (s) { if (!lineOf[s]) lineOf[s] = l.name; });
    });

    // slug → {章号: 章标题}：课程卡里没有 chapters，只有单课 JSON 有，所以可能查不到 → 退化成空标题
    var chapterTitles = {};
    function rememberChapters(slug, list) {
      var map = chapterTitles[slug] = chapterTitles[slug] || {};
      (list || []).forEach(function (ch) {
        var n = chapterNo(ch.slug || ch.title || '');
        if (n && !map[n]) map[n] = ch.title || '';
      });
    }
    (courseCards || []).forEach(function (c) { rememberChapters(c.slug, c.chapters); });
    if (fullCourse && fullCourse.slug) rememberChapters(fullCourse.slug, fullCourse.chapters);

    var items = [];
    Object.keys(figuresMap || {}).forEach(function (slug) {
      var course = meta[slug] || {};
      (figuresMap[slug] || []).forEach(function (fig, i) {
        var url = fig && fig.src ? fig.src : (fig && fig.url) || '';
        if (!url) return;                                 // 没有 src 的条目直接丢，避免渲染坏图
        var ch = chapterNo(url);
        items.push({
          url: url,
          slug: slug,
          courseTitle: course.title || slug,
          line: course.line || lineOf[slug] || '',
          chapter: ch,
          chapterTitle: (chapterTitles[slug] || {})[ch] || '',
          figNo: figureNo(url) || (i + 1),
          w: Number(fig.w) || 0,
          h: Number(fig.h) || 0,
          cap: '',
        });
      });
    });
    items.forEach(function (f) { f.cap = fullLabel(f); f.hay = (f.slug + ' ' + f.courseTitle + ' ' + baseName(f.url) + ' ' + posLabel(f) + ' ' + f.line).toLowerCase(); });

    return {
      items: items,
      total: items.length,
      lineNames: lineNames,
      chaptersOf: function (slug) { return chapterTitles[slug] || {}; },
    };
  }

  /* ---------------- 过滤 / 排序 ---------------- */

  /**
   * @param {Array} items buildModel 的扁平列表
   * @param {{course?:string, line?:string, q?:string, sort?:string}} st
   *   course：'' 或 'all' = 全部课程；sort：'course' 按课程 / 'chapter' 按章节顺序
   */
  function applyFilters(items, st) {
    var q = String(st.q || '').trim().toLowerCase();
    var out = items.filter(function (f) {
      if (st.course && st.course !== 'all' && f.slug !== st.course) return false;
      if (st.line && st.line !== 'all' && f.line !== st.line) return false;
      if (q && f.hay.indexOf(q) < 0) return false;
      return true;
    });
    return sortItems(out, st.course && st.course !== 'all' ? 'chapter' : (st.sort || 'course'));
  }

  /** 排序：章节顺序 = 先课程名再章号再序号，保证同课同章连成块（分组渲染的前提） */
  function sortItems(items, sort) {
    var byChapter = sort === 'chapter';
    return items.slice().sort(function (a, b) {
      if (byChapter) {
        if (a.courseTitle !== b.courseTitle) return a.courseTitle < b.courseTitle ? -1 : 1;
      } else if (a.slug !== b.slug) {
        return a.slug < b.slug ? -1 : 1;
      }
      if (a.chapter !== b.chapter) return a.chapter - b.chapter;
      return a.figNo - b.figNo;
    });
  }

  /* ---------------- DOM 片段 ---------------- */

  function breadcrumbs() {
    var bc = ui.el('div', 'breadcrumbs');
    bc.innerHTML = '<a href="#/">首页</a><span>›</span><a href="#/courses">全部课程</a><span>›</span><span>图表库</span>';
    return bc;
  }

  /**
   * 页面头：全站版用真实数据报总数；单课版放封面小图 + 标题（链回课程页）。
   * @param {number} ownCount 该课实际索引到的图数（由 render 传入，避免在这里回查模型）
   */
  function head(figureTotal, course, ownCount) {
    var box = ui.el('div', 'page-head');
    var h1 = ui.el('h1');
    if (!course) {
      h1.textContent = '图表库';
      box.appendChild(h1);
      box.appendChild(ui.el('p', null, '全站 ' + fmt.num(figureTotal) + ' 张课程图表，点开可放大、可新标签页看原图。'));
      return box;
    }
    var link = ui.el('a', null, course.title);
    link.href = '#/course/' + course.slug;
    h1.appendChild(link);
    h1.appendChild(ui.el('span', 'muted small', ' · 图表库'));
    box.appendChild(h1);
    box.appendChild(ui.el('p', null, (course.line ? course.line + ' · ' : '') +
      '本课共 ' + fmt.num(ownCount) + ' 张图表' +
      (course.chapterCount ? '，按 ' + course.chapterCount + ' 章分组' : '') + '。'));
    var cover = (LLM.data && LLM.data.coverOf) ? LLM.data.coverOf(course) : course.cover;
    if (cover) {
      var c = ui.el('img', 'fig-course-cover');
      c.src = cover; c.alt = course.title + ' 封面';
      c.setAttribute('loading', 'lazy');
      c.setAttribute('decoding', 'async');
      c.width = 240; c.height = 120;                     // 显式尺寸，避免头部图片撑动布局
      c.style.cssText = 'width:240px;height:auto;border:1px solid var(--border);border-radius:10px;margin-top:10px;background:#fff';
      box.appendChild(c);
    }
    return box;
  }

  /** 可点的一张图：整块 click 由网格统一委派（省 1000 个监听器） */
  function card(f, idx) {
    var it = ui.el('div', 'fig-item');
    it.dataset.idx = String(idx);
    it.tabIndex = 0;
    it.setAttribute('role', 'button');
    it.setAttribute('aria-label', f.cap);
    var img = ui.el('img');
    img.src = thumb(f.url);
    img.dataset.slug = f.slug;                         // 灯箱里「跳到该课」要用
    img.alt = f.cap;
    // 用 setAttribute 而不是 img.loading = 'lazy'：属性写法在任何浏览器里都真的写进 HTML 属性，
    // 「view source / 静态工具检查」时能看到，符合本文件「避免一次插 1000 个立即下载的 img」的意图
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.width = f.w || 914;
    img.height = f.h || 474;
    // 用数据里的真实 w/h 定宽高比，图片没到之前就占好位，避免滚动抖动
    img.style.aspectRatio = (f.w && f.h) ? (f.w + ' / ' + f.h) : FALLBACK_AR;
    var cap = ui.el('div', 'fig-cap');
    cap.style.cssText = 'display:flex;gap:10px;justify-content:space-between';  // 本文件不许改 css，左文案/右课程名靠内联布局
    cap.appendChild(ui.el('span', null, posLabel(f)));
    cap.appendChild(ui.el('span', 'fig-course', f.courseTitle));
    it.appendChild(img);
    it.appendChild(cap);
    return it;
  }

  /** 分组组头：单课视图 = 「第 N 章 · 标题 · 共 M 张」；全站视图 = 「课程名 · 共 M 张」 */
  function groupHead(label, title, n) {
    var g = ui.el('div', 'section-head');
    var t = title ? (label + ' · ' + title) : label;
    g.appendChild(ui.el('h2', 'section-title', t + ' · 共 ' + n + ' 张'));
    return g;
  }

  /* ---------------- 分批渲染 + 滚到底自动加载 ---------------- */

  /**
   * 把可见项按批追加进网格。
   * 单课视图按 chapter-N 分组插组头；全站视图按「课程」分组插组头，长列表才有路标。
   * @param {string|null} lastKey 上一批最后一个组键：**必须跨批传入**，否则恰好跨批的课程会重复出组头
   * @returns {{shown:number, lastGroup:string|null}}
   */
  function appendBatch(box, list, from, to, groupBy, lastKey) {
    var frag = ui.frag();
    var last = lastKey == null ? null : lastKey;
    for (var i = from; i < to && i < list.length; i++) {
      var f = list[i];
      var key = groupBy === 'chapter' ? f.slug + '#' + f.chapter : (groupBy === 'course' ? f.slug : '');
      if (key && key !== last) {
        last = key;
        if (groupBy === 'chapter') {
          var n = list.filter(function (x) { return x.slug === f.slug && x.chapter === f.chapter; }).length;
          frag.appendChild(groupHead('第 ' + f.chapter + ' 章', f.chapterTitle, n));
        } else {
          frag.appendChild(groupHead(f.courseTitle, '', list.filter(function (x) { return x.slug === f.slug; }).length));
        }
      }
      frag.appendChild(card(f, i));
    }
    box.appendChild(frag);
    return { shown: Math.min(to, list.length), lastGroup: last };
  }

  /** 分批渲染状态机：渲染下一批 + 结束后重挂 sentinel（数据变了必须重新 observe） */
  function makePager(box, list, groupBy, onGrow) {
    var st = { shown: 0, done: false, obs: null, lastGroup: null };
    st.grow = function () {
      if (st.done) return;
      var r = appendBatch(box, list, st.shown, st.shown + PAGE, groupBy, st.lastGroup);
      st.shown = r.shown;
      st.lastGroup = r.lastGroup;
      st.done = st.shown >= list.length;
      if (st.obs) { st.obs.disconnect(); st.obs = null; }
      if (st.done) { if (st.tail) st.tail.remove(); st.tail = null; }
      else { if (st.tail) box.appendChild(st.tail); st.observe(); }   // 挪到底部，否则 observer 会一直命中
      if (onGrow) onGrow(st);
    };
    st.observe = function () {
      if (!st.tail || typeof IntersectionObserver === 'undefined') return;   // 无 IO 时靠按钮兜底
      st.obs = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) { st.grow(); return; }
      }, { rootMargin: '600px 0px' });                                        // 提前 600px 预取，滚动时不空白
      st.obs.observe(st.tail);
    };
    st.stop = function () { if (st.obs) { st.obs.disconnect(); st.obs = null; } };
    return st;
  }

  function makeTail(pager, remaining) {
    var wrap = ui.el('div', 'fig-more');
    wrap.style.cssText = 'text-align:center;padding:18px 0 6px';
    var btn = ui.el('button', 'btn btn--sm', '加载更多（还有 ' + remaining + ' 张）');
    btn.addEventListener('click', function () { pager.grow(); });
    wrap.appendChild(btn);
    pager.tail = wrap;
    return wrap;
  }

  /* ---------------- 工具条 ---------------- */

  /**
   * `.filters`：课程下拉（全部 + N 门，带每门图数）+ 方向线 chip + 搜索 + 排序。
   * 全部控件都走 onChange 回写 state → reload()，不自己改数据。
   */
  function toolbar(m, courseList, st, onChange) {
    var bar = ui.el('div', 'filters');

    var f1 = ui.el('div', 'field');
    f1.appendChild(ui.el('label', 'small muted', '课程'));
    var sel = ui.el('select');
    var oAll = ui.el('option', null, '全部课程（' + fmt.num(m.total) + ' 张）');
    oAll.value = 'all';
    sel.appendChild(oAll);
    courseList.forEach(function (c) {
      if (!c.figures) return;                    // 没图的课不进下拉，免得选了是空态
      var o = ui.el('option', null, c.title + '（' + c.figures + ' 张）');
      o.value = c.slug;
      sel.appendChild(o);
    });
    sel.value = st.course || 'all';
    sel.addEventListener('change', function () { onChange({ course: sel.value }); });
    f1.appendChild(sel);
    bar.appendChild(f1);

    var f2 = ui.el('div', 'field');
    f2.appendChild(ui.el('label', 'small muted', '方向线'));
    var row = ui.el('div', 'chip-row');
    var lineOpts = [{ v: 'all', t: '全部' }];
    m.lineNames.forEach(function (n) {
      if (m.items.some(function (f) { return f.line === n; })) lineOpts.push({ v: n, t: n });
    });
    lineOpts.forEach(function (o) {
      var chip = ui.el('button', 'chip' + ((st.line || 'all') === o.v ? ' on' : ''), o.t);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        ui.$$('.chip', row).forEach(function (c) { c.classList.remove('on'); });
        chip.classList.add('on');
        onChange({ line: o.v });
      });
      row.appendChild(chip);
    });
    f2.appendChild(row);
    bar.appendChild(f2);

    var f3 = ui.el('div', 'field');
    f3.appendChild(ui.el('label', 'small muted', '搜索'));
    var q = ui.el('input');
    q.type = 'search';
    q.placeholder = '课程名或文件名序号，如 chapter-3';
    q.value = st.q || '';
    q.setAttribute('autocomplete', 'off');
    var fire = ui.debounce(function () { onChange({ q: q.value }); }, 160);   // 防抖：别每敲一个字就重排 1000 条
    q.addEventListener('input', fire);
    f3.appendChild(q);
    bar.appendChild(f3);

    var f4 = ui.el('div', 'field');
    f4.appendChild(ui.el('label', 'small muted', '排序'));
    var sort = ui.el('select');
    [['course', '按课程'], ['chapter', '按章节顺序']].forEach(function (p) {
      var o = ui.el('option', null, p[1]);
      o.value = p[0];
      sort.appendChild(o);
    });
    sort.value = st.sort || 'course';
    sort.disabled = !!(st.course && st.course !== 'all');    // 单课视图本就是章节顺序
    sort.addEventListener('change', function () { onChange({ sort: sort.value }); });
    f4.appendChild(sort);
    bar.appendChild(f4);

    bar.appendChild(ui.el('span', 'filter-count', ''));
    return bar;
  }

  function setCount(bar, shown, hit, cap) {
    var n = ui.$('.filter-count', bar);
    if (n) n.textContent = '命中 ' + fmt.num(hit) + ' 张 · 已显示 ' + fmt.num(shown) + ' / ' + fmt.num(cap);
  }

  function emptyState(text) {
    var e = ui.el('div', 'empty');
    e.appendChild(ui.el('strong', null, '没有符合条件的图表'));
    e.appendChild(ui.el('p', 'small', text || '换个关键词，或把方向线切回「全部」。'));
    return e;
  }

  /* ---------------- 主渲染 ---------------- */

  function readState(route, slug) {
    var q = (route && route.query) || {};
    return {
      course: slug || (q.course && q.course !== 'all' ? q.course : 'all'),
      line: q.line || 'all',
      q: q.q || '',
      sort: (q.sort === 'chapter' || q.sort === 'course') ? q.sort : (slug ? 'chapter' : 'course'),
    };
  }

  /** 把筛选状态写回地址栏（history.replaceState：不触发 hashchange，避免整页重渲染） */
  function syncHash(slug, st) {
    var parts = [];
    if (!slug && st.course && st.course !== 'all') parts.push('course=' + encodeURIComponent(st.course));
    if (st.line && st.line !== 'all') parts.push('line=' + encodeURIComponent(st.line));
    if (st.q) parts.push('q=' + encodeURIComponent(st.q));
    if (st.sort && st.sort !== (slug ? 'chapter' : 'course')) parts.push('sort=' + st.sort);
    var hash = '#/figures' + (slug ? '/' + slug : '') + (parts.length ? '?' + parts.join('&') : '');
    if (location.hash === hash) return;
    try { history.replaceState(history.state, '', hash); } catch (e) { /* file:// 下可能不允许，忽略 */ }
  }

  /** 灯箱注入「跳到该课」：ui.lightbox 只支持 prev/next/原图，所以在自己的根节点上补一个按钮 */
  function onDocClick(e) {
    var box = e.target && e.target.closest ? e.target.closest('.lightbox') : null;
    if (!box || ui.$('.lb-jump', box)) return;
    var img = ui.$('img', box);
    if (!img) return;
    var cap = ui.$('.lightbox-cap', box);
    var a = ui.el('a', 'btn btn--sm lb-jump', '跳到该课');
    a.href = '#/course/' + (img.dataset.slug || '');
    a.rel = 'noreferrer';
    if (cap && cap.parentNode) cap.parentNode.insertBefore(a, cap);
    else box.appendChild(a);
  }

  /** 把当前已渲染的 .fig-item 收集成灯箱要的列表（下标与 DOM 严格一致） */
  function lightboxList(grid) {
    return ui.$$('.fig-item', grid).map(function (n) {
      var im = n.querySelector('img');
      var capEl = n.querySelector('.fig-cap');
      return {
        src: im ? im.getAttribute('src') : '',
        alt: im ? (im.getAttribute('alt') || '') : '',
        cap: capEl ? capEl.textContent : '',
        slug: (im && im.dataset) ? im.dataset.slug : '',
      };
    });
  }

  /** 网格点击 → 灯箱（next/prev 翻的就是「已渲染」的那些图） */
  function onGridClick(grid, e) {
    var it = e.target.closest ? e.target.closest('.fig-item') : null;
    if (!it) return;
    var dom = ui.$$('.fig-item', grid);
    var idx = dom.indexOf(it);
    if (idx < 0) return;
    ui.lightbox(lightboxList(grid), idx);
  }

  /**
   * 组装页面骨架：返回重新挂工具条/网格所需的引用（reload 时只换这两块）
   * @param {object} m buildModel 的结果（只有 count 用）
   */
  function sheet(root, total, self, m) {
    ui.clear(root);
    var wrap = ui.el('div', 'container');
    wrap.appendChild(breadcrumbs());
    var info = self ? {
      slug: self.slug, title: self.title, line: self.line, cover: self.cover, coverPlain: self.coverPlain,
      figures: self.figures,
      chapterCount: m ? Object.keys(m.chaptersOf(self.slug)).length : 0,
    } : null;
    wrap.appendChild(head(total, info, info ? info.figures : 0));
    var slot = ui.el('div');                       // 工具条挂载点：每次 reload 只换这里
    var grid = ui.el('div', 'fig-grid');
    wrap.appendChild(slot);
    wrap.appendChild(grid);
    root.appendChild(wrap);
    return { slot: slot, grid: grid };
  }

  /**
   * 接好「工具条 → 过滤 → 分批渲染」这条线。
   * 每次筛选都重挂工具条：控件选中态、命中数都跟着新状态走，比逐个同步控件更不容易出错。
   */
  function wire(sheetRefs, m, courseList, st, slug) {
    var slot = sheetRefs.slot, grid = sheetRefs.grid;
    var bar = null, pager = null;
    function reload() {
      if (pager) pager.stop();
      var list = applyFilters(m.items, st);
      if (bar) bar.remove();
      bar = toolbar(m, courseList, st, function (patch) {
        Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
        syncHash(slug, st);
        reload();
      });
      slot.appendChild(bar);
      ui.clear(grid);
      if (!list.length) {
        grid.appendChild(emptyState(st.q
          ? '没找到包含「' + fmt.esc(st.q) + '」的图表。'
          : (slug ? '这门课（' + fmt.esc(slug) + '）没有图表，或课程不存在。' : '这个筛选组合下没有图表。')));
        setCount(bar, 0, 0, 0);
        return;
      }
      pager = makePager(grid, list, slug ? 'chapter' : 'course', function (p) {
        setCount(bar, p.shown, list.length, list.length);
      });
      pager.grow();
      if (!pager.done) grid.appendChild(makeTail(pager, list.length - pager.shown));
      pager.observe();
    }
    return { reload: reload, stop: function () { if (pager) pager.stop(); } };
  }

  function render(root, route) {
    var slug = (route && route.seg && route.seg[1]) || '';
    var st = readState(route, slug);

    return Promise.all([
      data.figures(),
      data.courses(),
      data.site().catch(function () { return null; }),   // site.json 只用来取方向线，挂了不影响主功能
      // 单课视图：data/courses.json 的课程卡**不含 chapters**（构建期只留在单课 JSON 里），
      // 所以想看章标题与「按 N 章分组」，得再取一次 data/course/<slug>.json；取不到就退化为无标题分组
      (slug && data.course) ? data.course(slug).catch(function () { return null; }) : Promise.resolve(null),
    ]).then(function (res) {
      var full = res[3] || {};
      var m = buildModel(res[0] || {}, res[1] || [], (res[2] && res[2].lines) || [], full);
      var courseList = (res[1] || []).map(function (c) {
        return {
          slug: c.slug, title: c.title, line: c.line, counts: c.counts, chapters: c.chapters || [],
          cover: c.cover, coverPlain: c.coverPlain, figures: (c.counts && c.counts.figures) || 0,
        };
      });
      var self = slug ? courseList.filter(function (c) { return c.slug === slug; })[0] : null;
      var refs = sheet(root, m.total, self, m);
      var view = wire(refs, m, courseList, st, slug);

      view.reload();
      syncHash(slug, st);
      LLM.setTitle((self ? self.title + ' · ' : '') + '图表库');

      refs.grid.addEventListener('click', function (e) { onGridClick(refs.grid, e); });
      document.addEventListener('click', onDocClick);   // 灯箱里补「跳到该课」（见 onDocClick）

      return function cleanup() {
        view.stop();
        document.removeEventListener('click', onDocClick);
      };
    }).catch(function (e) {
      ui.clear(root);
      var box = ui.el('div', 'container');
      box.appendChild(emptyState('图表数据加载失败：' + fmt.esc(e && e.message ? e.message : String(e))));
      root.appendChild(box);
      throw e;
    });
  }

  views.figures = { render: render };

  // 便于 node 侧自测（jsdom/纯 mock）：暴露纯函数，不污染运行时的 LLM 命名空间
  LLM._figuresInternals = {
    src: src, thumb: thumb, chapterNo: chapterNo, figureNo: figureNo, baseName: baseName,
    posLabel: posLabel, fullLabel: fullLabel, buildModel: buildModel, applyFilters: applyFilters,
    sortItems: sortItems, readState: readState, PAGE: PAGE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

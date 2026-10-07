/* ============================================================================
 * llm-learn 学习站 · 视图：「关键词百科」
 *
 * 路由：#/glossary（总览）· #/glossary/<layerId>（某一层）· #/glossary/t/<termKey>（词条）
 *
 * 为什么这样写：
 *   1. 数据分片 —— index.json 只有层信息（~10KB），1331 条词条散在 22 个 <层id>.json 里。
 *      一上来就全量拉 ≈ 1.5MB，所以**按需加载**：先画骨架（.skeleton），切层时才请求那一层。
 *   2. 层内切换不走路由 —— 切层只是换右栏内容，左栏/搜索框要保留，所以复用同一层 DOM，
 *      由 syncHash() 用 replaceState 把地址栏写对（用 replaceState 而不是改 location.hash：
 *      后者会触发 app.js 的 hashchange → 整页重渲染，输入焦点和滚动位置都会丢）。
 *   3. 词条详情要"定层" —— 词条 key 里不含层 id，进入详情时若缓存里没有，就逐层扫（最多 22 次），
 *      并把命中结果记进 KEY_LAYER，避免来回切词条反复扫。
 *   4. 所有 URL 都是相对的（GitHub Pages 子路径也能跑），课时跳转统一 #/l/<lessonId>。
 * ==========================================================================*/
(function (root) {
  'use strict';

  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt;
  var VIEW_NAME = 'glossary';

  /* ---------------- 模块级状态（都在 render 里重置，避免切页残留） ---------------- */
  var TOKEN = 0;                    // 每次 render +1：异步回调靠它判断"我还是当前页吗"
  var IDX = null;                   // index.json 缓存：{version, terms, layers:[...]}
  var LAYERS = Object.create(null); // id → terms[]（已加载的层）
  var LOADERS = Object.create(null);// id → Promise（去重：同一层只请求一次）
  var KEY_LAYER = Object.create(null); // termKey → layerId（详情定层缓存）
  var CUR_LAYER = null;             // 左栏高亮：null = 总览（全部）
  var TERMS = [];                   // 右栏当前可过滤的词条（本地过滤的数据源）
  var query = '';                   // 当前搜索词（切层/刷新要保留）
  var searchInput = null;
  var rootEl = null;

  /* ---------------- 小工具 ---------------- */
  function alive(tok) { return tok === TOKEN && !!(rootEl && rootEl.isConnected); }
  function clear(node) { ui.clear(node); }

  function go(hash) {
    if (LLM.go) LLM.go(hash);
    else location.hash = hash;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = ui.el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('execCommand 不支持'));
  }

  /** 层数据加载（带缓存 + 并发去重）；data.js 里有 glossaryLayer()，这里兜一层以备 mock */
  function loadLayer(id) {
    if (LAYERS[id]) return Promise.resolve(LAYERS[id]);
    if (LOADERS[id]) return LOADERS[id];
    var p = (LLM.data.glossaryLayer
      ? LLM.data.glossaryLayer(id)
      : LLM.data.get('data/glossary/' + id + '.json'))
      .then(function (d) {
        var terms = (d && d.terms) || [];
        LAYERS[id] = terms;
        delete LOADERS[id];
        return terms;
      })
      .catch(function (e) { delete LOADERS[id]; throw e; });
    LOADERS[id] = p;
    return p;
  }

  function layerMeta(id) {
    var ls = IDX.layers || [];
    for (var i = 0; i < ls.length; i++) { if (ls[i].id === id) return ls[i]; }
    return null;
  }

  /**
   * 词条定位：词条 key 本身不含层 id，所以先查 key→layer 缓存；没有就逐层扫（最多 22 次）。
   * 提示层（URL 里的当前层）排在最前，命中即记住归属 —— 之后翻上一条/下一条就不用再扫。
   */
  function findTerm(key, hint) {
    if (!key) return Promise.resolve(null);
    var known = KEY_LAYER[key];
    if (known && LAYERS[known] && hasKey(LAYERS[known], key)) {
      return Promise.resolve({ layer: layerMeta(known), terms: LAYERS[known] });
    }
    var ls = IDX.layers || [];
    var order = [];
    function push(id) {
      if (!id || order.indexOf(id) >= 0) return;
      for (var i = 0; i < ls.length; i++) { if (ls[i].id === id) { order.push(id); return; } }
    }
    push(hint); push(known);
    ls.forEach(function (L) { push(L.id); });
    var k = 0;
    function step() {
      if (k >= order.length) return Promise.resolve(null);
      var id = order[k++];
      return loadLayer(id).then(function (terms) {
        if (hasKey(terms, key)) {
          KEY_LAYER[key] = id;
          return { layer: layerMeta(id), terms: terms };
        }
        return step();
      });
    }
    return step();
  }

  function hasKey(terms, key) {
    for (var i = 0; i < terms.length; i++) { if (terms[i].key === key) return true; }
    return false;
  }

  function indexOfTerm(terms, key) {
    for (var i = 0; i < terms.length; i++) { if (terms[i].key === key) return i; }
    return -1;
  }

  /* ---------------- 通用片段 ---------------- */
  function crumb(items) {
    var nav = ui.el('nav', 'breadcrumbs');
    items.forEach(function (it, i) {
      if (i) nav.appendChild(ui.el('span', 'crumb-sep', '›'));
      if (it.href) {
        var a = ui.el('a', null, it.text);
        a.href = it.href;
        nav.appendChild(a);
      } else {
        nav.appendChild(ui.el('span', null, it.text));
      }
    });
    return nav;
  }

  function emptyBox(title, hint, actionText, href) {
    var box = ui.el('div', 'empty');
    box.appendChild(ui.el('strong', null, title));
    if (hint) box.appendChild(ui.el('p', 'small muted', hint));
    if (actionText) {
      var a = ui.el('a', 'btn btn--primary btn--sm', actionText);
      a.href = href || '#/glossary';
      var p = ui.el('p');
      p.appendChild(a);
      box.appendChild(p);
    }
    return box;
  }

  /** 课时指针 → 一行链接（标题 + 课slug › 章 + 命中方式） */
  function lessonLink(p, idx) {
    var body = (p.c || '') + ' › ' + (p.ct || p.ch || '');
    var node = ui.el('a', 'ptr-item');
    node.href = '#/l/' + p.id;
    node.dataset.lesson = p.id;
    if (idx != null) node.appendChild(ui.el('span', 'badge badge--ghost', String(idx)));
    var main = ui.el('div', 'p-main');
    main.appendChild(ui.el('div', 'p-title', p.t || p.id));
    main.appendChild(ui.el('div', 'small muted', body));
    if (p.why) main.appendChild(ui.el('div', 'p-why', '命中方式：' + p.why));
    node.appendChild(main);
    return node;
  }

  function aliasChips(list) {
    var row = ui.el('div', 'term-aliases');
    (list || []).forEach(function (a) { row.appendChild(ui.el('span', 'tag', a)); });
    return row;
  }

  /* ---------------- 搜索（本地过滤已加载词条） ---------------- */
  function termHay(t) {
    var s = (t.zh || '') + ' ' + (t.en || '') + ' ' + (t.def || '');
    (t.aliases || []).forEach(function (a, i) { if (i < 24) s += ' ' + a; });
    return s.toLowerCase();
  }

  function matches(t, q) {
    if (!q) return true;
    var hay = termHay(t);
    var terms = q.toLowerCase().split(/\s+/);
    for (var i = 0; i < terms.length; i++) { if (terms[i] && hay.indexOf(terms[i]) < 0) return false; }
    return true;
  }

  function onSearch(v) {
    query = String(v || '').trim();
    syncHash();
    paintGrid();
  }

  /** 把层/搜索词写回地址栏（replaceState：不触发 hashchange，所以右栏不会被整页重渲染） */
  function syncHash() {
    if (!root.history || !root.history.replaceState) return;
    var hash = '#/glossary' + (CUR_LAYER ? '/' + CUR_LAYER : '') + (query ? '?q=' + encodeURIComponent(query) : '');
    if (location.hash === hash) return;
    try { root.history.replaceState(null, '', location.pathname + location.search + hash); } catch (e) { /* file:// 下忽略 */ }
  }

  /* ---------------- 布局骨架 ---------------- */
  /**
   * 页头（标题 + 说明）。IDX 是异步来的，所以这里对 null 兜底：
   * 先给一句中性说明，索引到了再 paintHead() 补上「N 层链路 / M 条词条」的真实数字。
   */
  function paintHead() {
    var head = ui.$('#gloss-head', rootEl);
    if (!head) return;
    clear(head);
    head.appendChild(ui.el('h1', null, '关键词百科'));
    var p = ui.el('p');
    if (IDX) {
      var n = (IDX.layers || []).length;
      p.textContent = '按大模型完整链路的 ' + n + ' 层整理，共 ' + fmt.num(IDX.terms || 0) +
        ' 条词条：每条给出定义、详解与工程提醒，并挂到讲它的那几节课上 —— 卡住时先来这里查概念。';
    } else {
      p.className = 'muted';
      p.textContent = '正在读取百科目录…';
    }
    head.appendChild(p);
  }

  function paintShell() {
    var wrap = ui.el('div', 'container');
    var head = ui.el('div', 'page-head');
    head.id = 'gloss-head';
    wrap.appendChild(head);

    var layout = ui.el('div', 'gloss-layout');
    var side = ui.el('aside', 'gloss-layers');
    side.id = 'gloss-layers';
    layout.appendChild(side);
    var main = ui.el('div', 'gloss-main');
    main.id = 'gloss-main';
    layout.appendChild(main);
    wrap.appendChild(layout);

    rootEl.appendChild(wrap);
    paintHead();
    paintSide();
    return main;
  }

  /**
   * 层图标：方块里放**线性 SVG**，而不是一个汉字。
   * 汉字当图标看着像占位符（用户反馈：「图标是文字感觉很奇怪」），所以按层 id 映射到图形语义。
   */
  var LAYER_ICONS = {
    math: 'sigma', code: 'code', ml: 'graph', dl: 'brain', transformer: 'share', llm: 'book',
    tune: 'tune', kernel: 'cpu', 'train-sys': 'network', hw: 'chip', infer: 'zap', net: 'globe',
    os: 'terminal', serve: 'server', data: 'database', rag: 'search', agent: 'bot', eval: 'gauge',
    safety: 'shield', mm: 'image', domain: 'globe', project: 'briefcase', tags: 'tag',
  };
  function layerIcon(L) {
    L = L || {};
    if (LAYER_ICONS[L.id]) return LAYER_ICONS[L.id];
    var hay = String((L.name || '') + ' ' + (L.id || '')).toLowerCase();
    var rules = [
      [/数学|math|概率|线代|微积分/, 'sigma'], [/代码|编程|code|python/, 'code'],
      [/内核|kernel|cuda|gpu/, 'cpu'], [/训练|并行|分布/, 'network'],
      [/推理|部署|服务/, 'server'], [/数据|存储/, 'database'], [/检索|rag/, 'search'],
      [/安全|对齐|风险/, 'shield'], [/多模态|生成|图像|语音|视频/, 'image'],
      [/评测|指标|基准/, 'gauge'], [/工具|agent|智能体/, 'bot'], [/网络|协议/, 'globe'],
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(hay)) return rules[i][1];
    return 'boxes';
  }

  function layerLink(id, label, count, isAll, note) {
    var a = ui.el('a', 'gloss-layer');
    a.href = '#/glossary' + (id ? '/' + id : '');
    a.dataset.layer = id || '';
    if (isAll) a.dataset.all = '1';
    // 图标由层 id 决定（线性 SVG）；不再把一个汉字塞进方块当图标
    var g = ui.el('span', 'gl-glyph');
    g.innerHTML = ui.iconSvg(isAll ? 'boxes' : layerIcon({ id: id, name: label }), 15);
    a.appendChild(g);
    a.appendChild(ui.el('span', 'gl-name', label));
    if (note) a.title = note;
    if (count != null) a.appendChild(ui.el('span', 'gl-count', String(count)));
    a.addEventListener('click', function (e) {
      e.preventDefault();
      openLayer(id || null);
    });
    return a;
  }

  function paintSide() {
    var side = ui.$('#gloss-layers', rootEl);
    if (!side) return;
    clear(side);
    var ls = (IDX && IDX.layers) || [];
    if (!ls.length) {
      side.appendChild(ui.el('div', 'small muted', '层目录加载中…'));
      return;
    }
    side.appendChild(layerLink(null, '全部', fmt.num((IDX && IDX.terms) || 0), true, '所有层的词条'));
    ls.forEach(function (L) {
      side.appendChild(layerLink(L.id, L.name, L.count, false, L.note));
    });
  }

  function markActive() {
    if (!rootEl) return;
    ui.$$('.gloss-layer', rootEl).forEach(function (a) {
      a.classList.toggle('active', (a.dataset.layer || null) === (CUR_LAYER || null));
    });
  }

  function layerHead(meta) {
    var box = ui.el('div', 'gloss-layer-head');
    if (meta) {
      var h2 = ui.el('h2', 'gloss-layer-title');
      h2.innerHTML = ui.iconSvg(layerIcon(meta), 20) + ' ' + fmt.esc(meta.name);
      box.appendChild(h2);
      if (meta.note) box.appendChild(ui.el('p', 'small muted', meta.note));
      var bits = [];
      if (meta.line) bits.push(meta.line);
      if (meta.family) bits.push(meta.family);
      box.appendChild(ui.el('p', 'small muted', bits.join(' · ') + ' · ' + meta.count + ' 条词条'));
    } else {
      box.appendChild(ui.el('h2', 'gloss-layer-title', '全部词条'));
      box.appendChild(ui.el('p', 'small muted', '按层浏览，或用上面的搜索框过滤。全站搜索（顶栏 ⌕ 或按 /）也能直接搜词条。'));
    }
    return box;
  }

  /** 搜索框 + 结果计数 + 词条网格容器 */
  function mainBody(meta) {
    var box = ui.el('div', 'gloss-body');
    box.appendChild(layerHead(meta));

    var filters = ui.el('div', 'filters');
    var field = ui.el('div', 'field');
    field.appendChild(ui.el('span', 'search-ico', '⌕'));
    var input = ui.el('input');
    input.type = 'search';
    input.id = 'gloss-search';
    input.placeholder = '在本层词条里过滤：中文 / 英文 / 别名 / 释义…';
    input.autocomplete = 'off';
    input.value = query;
    input.addEventListener('input', ui.debounce(function () { onSearch(input.value); }, 120));
    field.appendChild(input);
    filters.appendChild(field);
    var count = ui.el('span', 'filter-count');
    count.id = 'gloss-count';
    filters.appendChild(count);
    box.appendChild(filters);
    searchInput = input;

    var grid = ui.el('div', 'term-grid');
    grid.id = 'gloss-grid';
    box.appendChild(grid);
    return box;
  }

  function gridCount(n, loaded) {
    var c = ui.$('#gloss-count', rootEl);
    if (!c) return;
    var scope = CUR_LAYER ? '本层' : (loaded === 0 ? '全部层' : '已加载层');
    c.textContent = query ? ('匹配 ' + n + ' 条（' + scope + '）') : (n + ' 条词条');
  }

  function termCard(t) {
    var card = ui.el('a', 'card term-card');
    card.href = '#/glossary/t/' + t.key;
    card.dataset.term = t.key;
    card.appendChild(ui.el('h3', null, t.zh || t.key));
    if (t.en) card.appendChild(ui.el('div', 'term-en', t.en));
    if (t.def) card.appendChild(ui.el('p', 'term-def', fmt.clamp(t.def, 130)));
    if (t.aliases && t.aliases.length) {
      var row = ui.el('div', 'term-aliases chip-row');
      t.aliases.slice(0, 4).forEach(function (a) { row.appendChild(ui.el('span', 'tag', a)); });
      card.appendChild(row);
    }
    var n = (t.ptr || []).length;
    var meta = ui.el('div', 'card-meta');
    meta.appendChild(ui.el('span', 'badge' + (n ? ' badge--line' : ' badge--ghost'), n ? (n + ' 个相关课时') : '暂无定位课时'));
    card.appendChild(meta);
    return card;
  }

  /** 只重画词条网格（搜索/计数）——不动搜索框，输入焦点不丢 */
  function paintGrid() {
    var grid = ui.$('#gloss-grid', rootEl);
    if (!grid) return;
    clear(grid);
    var list = TERMS.filter(function (t) { return matches(t, query); });
    gridCount(list.length, TERMS.length);
    if (!list.length) {
      var box = ui.el('div', 'empty');
      box.appendChild(ui.el('strong', null, query ? ('没有匹配「' + query + '」的词条') : '这一层还没有词条'));
      box.appendChild(ui.el('p', 'small muted', query ? '试试更短的关键词，或用顶栏 ⌕ 全站搜索（含课程正文）。' : '换一层看看，或回到总览。'));
      grid.appendChild(box);
      return;
    }
    list.forEach(function (t) { grid.appendChild(termCard(t)); });
  }

  /* ---------------- 页面：总览 / 某层 ---------------- */
  function layerBody(meta) {
    var body = ui.el('div', 'gloss-body');
    body.appendChild(layerHead(meta));
    var box = ui.el('div', 'empty');
    box.appendChild(ui.el('strong', null, '词条按层分片存放'));
    box.appendChild(ui.el('p', 'small muted',
      '第一次进来只加载了层目录（很小）。要看内容就选一层 —— 只请求那一层的 JSON。'));
    var btn = ui.el('button', 'btn btn--primary', '加载全部 ' + fmt.num(IDX.terms || 0) + ' 条');
    btn.addEventListener('click', function () { openLayer(null); });
    var p = ui.el('p');
    p.appendChild(btn);
    box.appendChild(p);
    body.appendChild(box);
    return body;
  }

  function skeletonGrid(main, n) {
    clear(main);
    var box = ui.el('div', 'term-grid');
    for (var i = 0; i < n; i++) {
      var c = ui.el('div', 'card term-card');
      var l1 = ui.el('div', 'skeleton');
      l1.style.height = '18px';
      l1.style.width = '52%';
      var l2 = ui.el('div', 'skeleton');
      l2.style.height = '12px';
      l2.style.width = '36%';
      l2.style.marginTop = '8px';
      var l3 = ui.el('div', 'skeleton');
      l3.style.height = '46px';
      l3.style.marginTop = '12px';
      c.appendChild(l1); c.appendChild(l2); c.appendChild(l3);
      box.appendChild(c);
    }
    main.appendChild(box);
  }

  function openLayer(id) {
    var tok = TOKEN;
    CUR_LAYER = id || null;
    if (query && searchInput) searchInput.value = query;
    markActive();
    paintSide();
    markActive();
    syncHash();
    var main = ui.$('#gloss-main', rootEl);
    if (!main) return Promise.resolve();
    if (IDX) paintHead();   // 页头数字跟着"全部/某层"的语境刷新（首屏可能还没拿到索引）
    clear(main);
    if (!id) {
      // 「全部」= 22 个分片全拉（用户主动点才付这份流量）
      if (rootEl && LLM.setTitle) LLM.setTitle('关键词百科');
      skeletonGrid(main, 12);
      return Promise.all((IDX.layers || []).map(function (L) { return loadLayer(L.id).catch(function () { return []; }); }))
        .then(function (lists) {
          if (!alive(tok)) return;
          TERMS = [];
          lists.forEach(function (ts) { TERMS = TERMS.concat(ts); });
          clear(main);
          main.appendChild(mainBody(null));
          paintGrid();
        });
    }
    var meta = layerMeta(id);
    if (meta) LLM.setTitle(meta.name + ' · 关键词百科');
    skeletonGrid(main, 6);
    return loadLayer(id).then(function (terms) {
      if (!alive(tok)) return;
      TERMS = terms;
      clear(main);
      main.appendChild(mainBody(meta));
      paintGrid();
    }).catch(function (e) {
      if (!alive(tok)) return;
      TERMS = [];
      clear(main);
      main.appendChild(emptyBox('这一层没加载成功', e && e.message ? e.message : String(e), '回到总览', '#/glossary'));
    });
  }

  /* ---------------- 页面：词条详情 ---------------- */
  function detailHeader(t, meta) {
    var head = ui.el('div', 'term-head');
    head.appendChild(ui.el('h1', null, t.zh || t.key));
    if (t.en) head.appendChild(ui.el('div', 'term-en', t.en));
    if (t.aliases && t.aliases.length) head.appendChild(aliasChips(t.aliases));
    if (meta) {
      var a = ui.el('a', 'badge badge--level');
      a.innerHTML = ui.iconSvg(layerIcon(meta), 13) + ' ' + fmt.esc(meta.name);
      a.href = '#/glossary/' + meta.id;
      a.title = '回到本层';
      head.appendChild(a);
    }
    return head;
  }

  function appendText(parent, text) {
    if (!text) return 0;
    var paras = String(text).split(/\n{2,}/);
    var n = 0;
    paras.forEach(function (p) {
      if (!p.trim()) return;
      parent.appendChild(ui.el('p', null, p.trim()));
      n++;
    });
    return n;
  }

  function appendDetail(parent, text) {
    var body = ui.el('div', 'article');
    var n = 0;
    var hasMd = LLM.ui && LLM.ui.md && root.marked;
    if (hasMd) {
      try { body.innerHTML = LLM.ui.md(String(text)); n = body.children.length; } catch (e) { n = 0; }
    }
    if (!n) { clear(body); n = appendText(body, text); }
    if (!n) body.appendChild(ui.el('p', 'muted', '（暂无详解）'));
    parent.appendChild(body);
    return body;
  }

  /** 详解可能很长（最长 400 字/条，多半 1 段）：超过 3 段先折叠，避免详情页被一段独白淹掉 */
  function collapseLong(body) {
    var kids = Array.prototype.slice.call(body.children);
    if (kids.length <= 3) return;
    var hidden = kids.slice(3);
    hidden.forEach(function (n) { n.hidden = true; });
    var btn = ui.el('button', 'btn btn--ghost btn--sm', '展开全部（还有 ' + hidden.length + ' 段）');
    btn.addEventListener('click', function () {
      var open = hidden[0].hidden;
      hidden.forEach(function (n) { n.hidden = !open; });
      btn.textContent = open ? '收起' : '展开全部（还有 ' + hidden.length + ' 段）';
    });
    body.appendChild(btn);
  }

  function section(title, child) {
    var sec = ui.el('div', 'term-section');
    sec.appendChild(ui.el('h3', null, title));
    sec.appendChild(child);
    return sec;
  }

  function seeList(see, known) {
    var row = ui.el('div', 'chip-row');
    (see || []).forEach(function (k) {
      if (known[k]) {
        var a = ui.el('a', 'chip', known[k]);
        a.href = '#/glossary/t/' + k;
        row.appendChild(a);
      } else {
        var s = ui.el('span', 'chip muted', k + '（未收录）');
        s.title = '本百科里没有这个 key，无法跳转';
        s.style.opacity = '.55';
        row.appendChild(s);
      }
    });
    return row;
  }

  function seeMap(t, terms) {
    var map = Object.create(null);
    (t.see || []).forEach(function (k) {
      for (var i = 0; i < terms.length; i++) {
        if (terms[i].key === k) { map[k] = terms[i].zh || k; break; }
      }
    });
    return map;
  }

  function ptrSection(t) {
    var box = ui.el('div');
    var list = ui.el('div', 'ptr-list');
    var ptr = t.ptr || [];
    if (!ptr.length) {
      box.appendChild(ui.el('p', 'small muted', '构建期没在正文里定位到讲它的课时（可能只在图表/附录里出现过）。'));
      return box;
    }
    ptr.forEach(function (p, i) { list.appendChild(lessonLink(p, i + 1)); });
    box.appendChild(ui.el('p', 'small muted', '共 ' + ptr.length + ' 个课时提到它（构建期按标题/正文自动定位）：'));
    box.appendChild(list);
    return box;
  }

  function navTerms(t, terms) {
    var row = ui.el('div', 'term-nav');
    var i = indexOfTerm(terms, t.key);
    if (i < 0) return row;
    var prev = terms[i - 1], next = terms[i + 1];
    if (prev) {
      var a = ui.el('a', 'btn btn--ghost btn--sm', '← ' + (prev.zh || prev.key));
      a.href = '#/glossary/t/' + prev.key;
      row.appendChild(a);
    }
    if (next) {
      var b = ui.el('a', 'btn btn--ghost btn--sm', (next.zh || next.key) + ' →');
      b.href = '#/glossary/t/' + next.key;
      row.appendChild(b);
    }
    var copy = ui.el('button', 'btn btn--sm', '复制词条链接');
    copy.addEventListener('click', function () {
      copyText(location.href)
        .then(function () { ui.toast('已复制词条链接', 'ok'); })
        .catch(function () { ui.toast('复制失败，请手动复制地址栏', 'warn'); });
    });
    row.appendChild(copy);
    return row;
  }

  function detailNodes(t, res) {
    var box = ui.el('div', 'term-detail');
    box.dataset.term = t.key;
    box.appendChild(detailHeader(t, res.layer));
    if (t.def) {
      var def = ui.el('p', 'term-def');
      def.textContent = t.def;
      box.appendChild(def);
    }
    if (t.detail) {
      var body = appendDetail(box, t.detail);
      collapseLong(body);
    }
    if (t.how) box.appendChild(section('工程提醒', appendBody(t.how)));
    if (t.see && t.see.length) box.appendChild(section('相关词条', seeList(t.see, seeMap(t, res.terms))));
    box.appendChild(section('相关课时', ptrSection(t)));
    box.appendChild(navTerms(t, res.terms));
    return box;
  }

  function appendBody(text) {
    var d = ui.el('div', 'how-body');
    appendText(d, text);
    if (!d.children.length) d.textContent = String(text);
    return d;
  }

  function openTerm(key) {
    var tok = TOKEN;
    var main = ui.$('#gloss-main', rootEl);
    if (!main) return Promise.resolve();
    clear(main);
    skeletonGrid(main, 1);
    return findTerm(key, CUR_LAYER).then(function (res) {
      if (!alive(tok)) return;
      var t = null;
      if (res && res.layer) {
        var i = indexOfTerm(res.terms, key);
        if (i >= 0) t = res.terms[i];
      }
      if (!t) {
        clear(main);
        if (LLM.setTitle) LLM.setTitle('词条不存在 · 关键词百科');
        main.appendChild(emptyBox('没有这个词条：' + key, '词条 key 可能拼错了，或它已被重命名。', '回到关键词百科', '#/glossary'));
        return;
      }
      if (LLM.setTitle) LLM.setTitle((t.zh || t.key) + ' · 关键词百科');
      clear(main);
      var wrap = ui.el('div', 'term-detail-wrap');
      wrap.appendChild(crumb([
        { text: '关键词百科', href: '#/glossary' },
        { text: res.layer.name, href: '#/glossary/' + res.layer.id },
        { text: t.zh || t.key },
      ]));
      wrap.appendChild(detailNodes(t, res));
      main.appendChild(wrap);
    }).catch(function (e) {
      if (!alive(tok)) return;
      clear(main);
      main.appendChild(emptyBox('词条没加载成功', e && e.message ? e.message : String(e), '回到总览', '#/glossary'));
    });
  }

  /* ---------------- 入口 ---------------- */
  function paintGlossary(route) {
    var tok = TOKEN;
    var seg = route.seg || [];
    var kind = seg[1] === 't' ? 'term' : (seg[1] ? 'layer' : 'index');
    var key = kind === 'term' ? seg[2] : null;
    var id = kind === 'layer' ? seg[1] : null;
    query = route.query && route.query.q ? String(route.query.q) : '';

    if (kind === 'term') { if (LLM.setTitle) LLM.setTitle('词条 · 关键词百科'); }
    else if (kind === 'layer') { if (LLM.setTitle) LLM.setTitle('关键词百科'); }
    else if (LLM.setTitle) LLM.setTitle('关键词百科');

    var main = paintShell();
    skeletonGrid(main, 8);

    var p = IDX ? Promise.resolve(IDX) : Promise.resolve(LLM.data.glossaryIndex()).then(function (d) {
      IDX = d || { layers: [], terms: 0 };   // 缓存：层目录很小，且左栏每次都要用
      return IDX;
    });
    return p.then(function () {
      if (!alive(tok)) return;
      if (!(IDX.layers || []).length) {       // index.json 说没有层（构建时没跑 build-glossary.py）
        clear(main);
        main.appendChild(emptyBox('百科数据还没构建', 'data/glossary/index.json 里没有任何层 —— 先跑 python3 tools/build-glossary.py 再构建站点。', '回首页', '#/'));
        return;
      }
      paintHead();                            // 索引到手 → 页头换成真实数字（N 层 / M 条）
      paintSide();
      // 侧栏高亮：详情页按已知归属高亮，未知时不高亮（不影响内容）
      CUR_LAYER = kind === 'layer' ? id : (kind === 'term' ? (KEY_LAYER[key] || null) : null);
      markActive();
      if (searchInput) searchInput.value = query;
      if (kind === 'term') return openTerm(key);
      if (kind === 'layer') {
        if (!layerMeta(id)) {
          clear(main);
          main.appendChild(emptyBox('没有这一层：' + id, '层 id 可能拼错了。', '回到关键词百科', '#/glossary'));
          if (LLM.setTitle) LLM.setTitle('关键词百科');
          return;
        }
        return openLayer(id);
      }
      TERMS = [];
      clear(main);
      main.appendChild(layerBody(null));
    }).catch(function (e) {
      if (!alive(tok)) return;
      var m = ui.$('#gloss-main', rootEl);
      if (!m) return;
      clear(m);
      m.appendChild(emptyBox('百科数据没加载成功', e && e.message ? e.message : String(e), '回首页', '#/'));
    });
  }

  function render(el, route) {
    var tok = ++TOKEN;
    rootEl = el;
    // 重置模块状态：避免上一次访问的词条/层残留到新页面
    CUR_LAYER = null; TERMS = []; query = ''; searchInput = null;
    var p = paintGlossary(route || { seg: [] });
    var cleanup = function () {
      if (tok === TOKEN) TOKEN++;   // 让所有在飞的异步回调失效
      rootEl = null;
      searchInput = null;
    };
    p.catch(function () { /* 错误已在 paintGlossary 里渲染 */ });
    return cleanup;
  }

  LLM.views = LLM.views || {};
  LLM.views[VIEW_NAME] = { render: render };

  /** 测试/调试用：暴露一点内部状态（不影响线上） */
  LLM.views[VIEW_NAME]._internals = {
    index: function () { return IDX; },
    layers: function () { return LAYERS; },     // 注意：reset() 会换新对象，所以用函数取当前值
    keys: function () { return KEY_LAYER; },
    /** 清掉模块缓存，模拟"刚打开站点"（自测里用来验证懒加载/扫描次数） */
    reset: function () {
      IDX = null;
      LAYERS = Object.create(null);
      LOADERS = Object.create(null);
      KEY_LAYER = Object.create(null);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ===== assets/math.js ===== */
/**
 * llm-learn doc-viewer · 本地公式渲染（KaTeX，纯静态：无网络请求、无服务端参与）
 *
 * 口径与**端上小程序完全一致**（`llm-paper-miniprogram/framework/deps/katex/render.js`）：
 *   同一版本 KaTeX 0.16.47 · `strict:false` · 解析失败**不报错**，直接显示原始 LaTeX 源。
 * 资源全部随仓库入库（`public/vendor/katex/`），离线可用；`server.js` 不参与、不新增依赖。
 *
 * 为什么必须在 marked **之前**把公式挖出来：
 *   正文里是 LaTeX 源（`$...$` / `$$...$$`），直接交给 marked 会被当普通 markdown 处理 ——
 *   `}_{`/`_{...}` 被解释成强调（插进 `<em>`）、`\,` `\;` `\ ` 这类转义被吃掉、`<` `&` 被转义。
 *   所以先换成占位符 `%%MATH<n>%%`，marked 跑完再把 KaTeX 的 HTML 填回去（实测修复前 49% 的块级公式被破坏）。
 *
 * 扫描规则（顺序扫描，代码优先于公式）：
 *   围栏代码块 ``` / ~~~ 与行内代码 `…` → 原样保留（里面的 `$` 不当公式）
 *   `\$` 转义 → 原样保留
 *   `$$…$$` → 块级公式（跨行；括号深度感知，`\text{价格 $5}` 里的 `$` 不会误判成结束）
 *   `$…$`   → 行内公式（不跨行；开闭两端紧邻非空白，避免把正文里的美元金额当成公式）
 *
 * API：
 *   MathView.render(md)          md → HTML（内部调用 marked，供 app.js 一处调用）
 *   MathView.tokenize(src)       → { masked, restore(html), count }（tokenize 单独暴露，便于 node 侧回归统计）
 *   MathView.renderMath(tex, displayMode) → KaTeX HTML / 降级 span
 */
(function (root) {
  'use strict';

  // 与端上 BASE_OPTIONS 对齐：strict:false（正文里的 `\text{中文}`、全角括号、①② 照常渲染）
  // throwOnError:true 是**故意的** —— 这样解析失败会抛，我们接住后按端上口径降级成「原始 LaTeX 源」
  var KATEX_OPTS = { throwOnError: true, strict: false, trust: false, output: 'html' };
  var MARKED_OPTS = { gfm: true, breaks: false };
  var TOKEN_RE = /%%MATH(\d+)%%/g;
  var TOKEN_OPEN = '%%MATH';

  /* ---------------- 依赖：浏览器取全局，node 侧取同目录 vendor（便于回归脚本直接 require） ---------------- */
  var _deps = null;
  function deps() {
    // 浏览器：root.katex；构建期(node)：require 同目录 vendor。
    // ⚠️ 只有 katex 已就位才缓存 —— 否则（按需加载/构建期时序）会把"当时没有"永久缓存，
    //    导致公式全部退化成纯文本（曾因此让 358 个预渲染课时丢失 KaTeX）。
    if (_deps && _deps.katex) return _deps;
    var katex = root.katex, marked = root.marked;
    if (!katex && typeof require === 'function') {
      try { katex = require('./vendor/katex/katex.min.js'); } catch (e) { katex = null; }
    }
    _deps = { katex: katex, marked: marked };
    return _deps;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 解析失败的降级：**直接显示原文字符串**（与端上同一口径：不报错、不裂图、不加“失败”字样） */
  function fallback(tex, display) {
    var source = String(tex == null ? '' : tex).trim();
    if (!source) return '';
    return '<span class="math-fallback' + (display ? ' math-fallback--block' : '') + '">'
      + escapeHtml(source) + '</span>';
  }

  /** 单条公式 → HTML（浏览器版 KaTeX 直接出 HTML 字符串，不再需要端上那层 rich-text 翻译） */
  function renderMath(tex, displayMode) {
    var source = String(tex == null ? '' : tex).trim();
    if (!source) return '';
    try {
      var katex = deps().katex;
      if (!katex) return fallback(source, displayMode);
      var opts = { throwOnError: KATEX_OPTS.throwOnError, strict: KATEX_OPTS.strict, trust: KATEX_OPTS.trust, output: KATEX_OPTS.output };
      opts.displayMode = !!displayMode;
      return katex.renderToString(source, opts);
    } catch (e) {
      return fallback(source, displayMode);
    }
  }

  /* ---------------- 扫描器 ---------------- */

  /** 位置 i 是否处于行首（允许前置空白，兼容列表内缩进的围栏代码块与公式） */
  function atLineStart(src, i) {
    var j = i - 1;
    while (j >= 0 && (src.charAt(j) === ' ' || src.charAt(j) === '\t')) j--;
    return j < 0 || src.charAt(j) === '\n';
  }

  /** 位置 j 之后（跳过空白）是否就是行尾 —— 块级公式按口径「独占成行」 */
  function atLineEnd(src, j) {
    while (j < src.length && (src.charAt(j) === ' ' || src.charAt(j) === '\t')) j++;
    return j >= src.length || src.charAt(j) === '\n';
  }

  /** 从 from 起找「行尾的那个 $$」（括号不平衡时的兜底配对，保证坏公式仍被看到而不是吞掉正文） */
  function findCloseAtLineEnd(src, from) {
    for (var i = from; i < src.length; i++) {
      if (src.substr(i, 2) === '$$' && atLineEnd(src, i + 2)) return i;
    }
    return -1;
  }

  /** 跳过整个围栏代码块（i 指向 ``` / ~~~），返回块结束后的下标 */
  function skipFence(src, i) {
    var marker = src.substr(i, 3);
    var j = src.indexOf('\n', i);
    if (j === -1) return src.length;
    j += 1;
    while (j < src.length) {
      var nl = src.indexOf('\n', j);
      var lineEnd = nl === -1 ? src.length : nl;
      if (src.slice(j, lineEnd).trim().indexOf(marker) === 0) return nl === -1 ? src.length : nl + 1;
      if (nl === -1) return src.length;
      j = nl + 1;
    }
    return src.length;
  }

  /**
   * 从 from 起找右定界符的位置；括号深度感知（`_{a$b}` 里的 `$` 不算结束），`\x` 跳过。
   * inline=true 时遇到换行即放弃（行内公式不跨行）。
   */
  function findClose(src, right, from, inline) {
    var depth = 0;
    for (var i = from; i < src.length; i++) {
      var c = src.charAt(i);
      if (depth <= 0 && src.substr(i, right.length) === right) return i;
      if (c === '\\') i++;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (inline && c === '\n') return -1;
    }
    return -1;
  }

  /**
   * 把正文里的公式换成占位符。
   * @param {string} src
   * @param {function({src:string, display:boolean, start:number, end:number}):void} [onCapture]
   *        每挖出一条公式回调一次（回归脚本用它定位错配，正常渲染不需要）
   * @returns {{masked:string, restore:function(string):string, count:number}}
   */
  function tokenize(src, onCapture) {
    // 统一换行：仓库里有 CRLF 文件，CR 混进公式会被 KaTeX 当成控制序列的一部分
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var store = [];
    var out = '';
    var i = 0;
    var n = text.length;

    var pushMath = function (tex, display, start, end) {
      out += TOKEN_OPEN + store.length + '%%';
      store.push(renderMath(tex, display));
      if (onCapture) onCapture({ src: tex, display: display, start: start, end: end });
    };

    while (i < n) {
      var ch = text.charAt(i);

      // ① 围栏代码块：整块原样保留
      if ((ch === '`' || ch === '~') && text.substr(i, 3) === ch + ch + ch && atLineStart(text, i)) {
        var fenceEnd = skipFence(text, i);
        out += text.slice(i, fenceEnd);
        i = fenceEnd;
        continue;
      }
      // ② 行内代码：同行的下一个 ` 之前原样保留
      if (ch === '`') {
        var tick = text.indexOf('`', i + 1);
        var lineEnd = text.indexOf('\n', i);
        if (tick !== -1 && (lineEnd === -1 || tick < lineEnd)) {
          out += text.slice(i, tick + 1);
          i = tick + 1;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      // ③ 转义（含 `\$`）：连字符一起原样保留
      if (ch === '\\') {
        out += text.substr(i, 2);
        i += 2;
        continue;
      }
      // ④ 块级公式 $$…$$（口径：独占成行 —— 行首开、行尾闭）
      if (text.substr(i, 2) === '$$' && atLineStart(text, i)) {
        var closeBlock = findClose(text, '$$', i + 2, false);
        // 括号不平衡（作者侧漏写 `}`）时退一步：按「行尾的 $$」配对，让它照样被 KaTeX 判失败 →
        // 降级成原始 LaTeX 源显示，而不是把后面的正文当公式吞进去
        if (closeBlock === -1 || !atLineEnd(text, closeBlock + 2)) {
          closeBlock = findCloseAtLineEnd(text, i + 2);
        }
        if (closeBlock > i + 2 && atLineEnd(text, closeBlock + 2)) {
          pushMath(text.slice(i + 2, closeBlock), true, i, closeBlock + 2);
          i = closeBlock + 2;
          continue;
        }
        out += '$$';
        i += 2;
        continue;
      }
      // ⑤ 行内公式 $…$（不跨行；开闭两端紧邻非空白，且不与 $$ 相邻）
      if (ch === '$') {
        var next = text.charAt(i + 1);
        if (next && next !== '$' && !/\s/.test(next) && text.charAt(i - 1) !== '$') {
          var closeInline = findClose(text, '$', i + 1, true);
          if (closeInline > i + 1 && !/\s/.test(text.charAt(closeInline - 1))
            && text.charAt(closeInline + 1) !== '$') {
            pushMath(text.slice(i + 1, closeInline), false, i, closeInline + 1);
            i = closeInline + 1;
            continue;
          }
        }
        out += ch;
        i++;
        continue;
      }

      out += ch;
      i++;
    }

    return {
      masked: out,
      count: store.length,
      restore: function (html) {
        return String(html).replace(TOKEN_RE, function (m, k) {
          var hit = store[Number(k)];
          return hit === undefined ? m : hit;
        });
      },
    };
  }

  /** md → HTML（公式先挖出来、marked 之后再填回） */
  function render(md, markedImpl) {
    var marked = markedImpl || deps().marked;
    var t = tokenize(md);
    if (!marked) return t.restore(escapeHtml(String(md == null ? '' : md)));
    return t.restore(marked.parse(t.masked, MARKED_OPTS));
  }

  var api = {
    render: render,
    tokenize: tokenize,
    renderMath: renderMath,
    fallback: fallback,
    MARKED_OPTS: MARKED_OPTS,
    KATEX_OPTS: KATEX_OPTS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MathView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/format.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 小工具：格式化
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 千分位 */
  function num(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function pct(done, total) {
    if (!total) return 0;
    return Math.round((done / total) * 100);
  }

  /** 分钟 → 「1 小时 20 分」/「35 分钟」 */
  function minutes(m) {
    m = Math.max(0, Math.round(m || 0));
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }

  function date(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 相对时间：刚刚 / 5 分钟前 / 3 天前 / 2026-10-01 */
  function rel(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return date(ts).slice(0, 10);
  }

  function clamp(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /** 「第 3 章 · 第 2 课」 */
  function lessonPos(seq, total, chapterSeq, chapterTotal) {
    var a = chapterSeq && chapterTotal ? '本章第 ' + chapterSeq + ' / ' + chapterTotal + ' 课 · ' : '';
    return a + '第 ' + seq + ' / ' + total + ' 课';
  }

  /** 关键词高亮（用于搜索结果/列表；只转义一次） */
  function highlight(text, q) {
    var s = esc(text);
    if (!q) return s;
    var needle = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return s.replace(new RegExp('(' + needle + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) {
      return s;
    }
  }

  LLM.fmt = { esc: esc, num: num, pct: pct, minutes: minutes, date: date, rel: rel, clamp: clamp, lessonPos: lessonPos, highlight: highlight };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/render.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 正文渲染（纯函数：md 字符串 → HTML 字符串，不碰 DOM）
 *
 * 为什么单独一个文件：同一段渲染逻辑有**两个调用方**
 *   ① 构建期（tools/build-site.js，Node）：把每节课渲染成 HTML 存进产物 ——
 *      **发布出去的站点里没有 .md 源文件**，只有渲染结果（详见 site/README.md）
 *   ② 运行期（浏览器）：用户笔记的 Markdown 预览、百科词条详解
 * 两边必须产出**完全一致**的 HTML（尤其是标题 id，右侧目录靠它对齐），所以只有这一份实现。
 *
 * 依赖（都由调用方先挂到全局）：root.marked（vendored marked 12）、root.MathView（本地 KaTeX 包装）、
 * LLM.fmt.esc。Node 侧见 tools/build-site.js 顶部的 shim。
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var MARKED_OPTS = { gfm: true, breaks: false };

  function esc(s) {
    if (LLM.fmt && LLM.fmt.esc) return LLM.fmt.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 把作者写在正文里的 HTML 实体解回字符（内容里确实有 `&quot;` 这种写法，直接转义会让读者看到实体） */
  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(nbsp|amp|lt|gt|quot|#39|#x27|hellip|mdash);/g, function (m, k) {
      return { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", hellip: '…', mdash: '—' }[k];
    });
  }

  /** 把 md 里的相对路径（相对 md 文件自身）解析成站点根相对路径 */
  function resolveRel(fromFile, href) {
    if (!href) return href;
    if (/^(https?:|data:|mailto:|#|\/)/i.test(href)) return href;
    var base = String(fromFile || '').split('/').slice(0, -1).join('/');
    var parts = (base ? base.split('/') : []).concat(href.split('/'));
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.' || p === '') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  }

  /* 标题 id：同一篇里重名时加序号（-2、-3）；中文保留，其余字符丢掉 */
  function hashId(text, seq) {
    var s = String(text).toLowerCase().replace(/[\s]+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 42);
    if (!s) s = 'sec';
    seq[s] = (seq[s] || 0) + 1;
    return seq[s] > 1 ? s + '-' + seq[s] : s;
  }

  /**
   * 课时 id 链接 / md 链接 → 站内路由（正文里 `[下一课](agent-ch1-l2)` 这类要能点）
   * 构建期与运行期共用，保证两边链接一致。
   */
  function linkResolver(lessonIndex) {
    var idx = lessonIndex || {};
    return function (href, text) {
      if (!href) return null;
      var h = String(href).trim();
      var bare = h.replace(/^#/, '').replace(/\.md$/, '').split('#')[0];
      if (idx[bare]) return '<a href="#/l/' + bare + '">' + text + '</a>';
      if (/\.md$/i.test(h) && !/^https?:/i.test(h)) {
        var m = /(?:^|\/)([^/]+)\/chapter-(\d+)\/lesson-(\d+)\.md$/i.exec(h);
        if (m) return '<a href="#/learn/' + m[1] + '/chapter-' + m[2] + '/lesson-' + m[3] + '">' + text + '</a>';
      }
      return null;
    };
  }

  /**
   * 预处理：**粗体** → `<strong>`（只补 CommonMark 的死角，不改常态行为）
   *
   * 为什么需要：markdown 的 `**` 有一套「flanking」规则，当定界符紧邻**标点**时不成立，例如
   *   `但它的**"下一步做什么"不由模型决定**，`
   * 中文正文里引号、括号、顿号到处都是，于是这些粗体**原样漏成字面 `**`**（全站曾有 5491 处，读者看到星号）。
   * 端上小程序换解析器未必有这个问题，但本地站点用的是 marked，必须自己补。
   *
   * 安全守卫（宁可漏转，不可错转）：
   *   - 先挖掉代码（``` 与 `…`）与公式（math.js 已先换成占位符）—— `2**2`（幂运算）多在公式/代码里，天然免疫
   *   - 开定界符前**不能是 ASCII 词字符**：`x**2`、`10**9` 这类幂运算不会被误当粗体
   *   - 成对内容不允许跨行、不允许含 `|`（表格分隔）或反引号，长度上限 400
   */
  var CODE_TOKEN = '\u0000';
  function emphasize(text) {
    var codes = [];
    var keep = function (m) { return CODE_TOKEN + (codes.push(m) - 1) + CODE_TOKEN; };
    var out = String(text)
      .replace(/```[^\n]*\n[\s\S]*?```/g, keep)
      .replace(/~~~[^\n]*\n[\s\S]*?~~~/g, keep)
      .replace(/`[^`\n]*`/g, keep);
    out = out.replace(/(?<![\w*])\*\*(?=[^\s|`])([^\n|`*]{1,400}?[^\s|`*])\*\*(?![\w*])/g, '<strong>$1</strong>');
    return out.replace(/\u0000(\d+)\u0000/g, function (m, i) { return codes[Number(i)]; });
  }

  /**
   * md → HTML
   * @param {string} mdText
   * @param {{file?:string, link?:function(string,string):(string|null), seq?:object}} opts
   *        file：md 在站点内的路径（解析相对图片）；link：链接解析器；seq：标题 id 去重表
   *        （构建期一课一个 seq；浏览器里不传则每次渲染重置）
   */
  function md(mdText, opts) {
    var o = opts || {};
    var src = String(mdText == null ? '' : mdText);
    var MV = root.MathView;
    var t = (MV && MV.tokenize) ? MV.tokenize(src) : { masked: src, restore: function (h) { return h; } };
    var seq = o.seq || {};

    var renderer = new root.marked.Renderer();
    renderer.heading = function (text, level, raw) {
      var lv = Math.min(level + 1, 6);                 // 正文里的 # 当节用 → 页面里降一级，H1 留给课时标题
      var plain = String(raw || text).replace(/<[^>]*>/g, '').trim();
      var id = 'h-' + hashId(plain, seq);
      return '<h' + lv + ' id="' + id + '">' + text +
        '<a class="anchor" href="#' + id + '" aria-label="本节链接">#</a></h' + lv + '>\n';
    };
    renderer.image = function (href, title, text) {
      var src2 = resolveRel(o.file, href);
      var cap = decodeEntities(text || title || '');
      return '<figure><img class="md-img" src="' + esc(src2) + '" alt="' + esc(cap) + '" loading="lazy" decoding="async">' +
        (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') + '</figure>\n';
    };
    renderer.code = function (code, info) {
      var lang = String(info || '').trim().split(/\s+/)[0].toLowerCase();
      var cls = lang ? ' class="language-' + esc(lang) + '"' : '';
      var attr = lang ? ' data-lang="' + esc(lang) + '"' : '';
      return '<pre' + attr + '><code' + cls + '>' + esc(code) + '</code></pre>\n';
    };
    renderer.link = function (href, title, text) {
      if (o.link) {
        var custom = o.link(href, text);
        if (custom) return custom;
      }
      var external = /^https?:/i.test(href);
      return '<a href="' + esc(href) + '"' + (title ? ' title="' + esc(title) + '"' : '') +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + text + '</a>';
    };

    var inst = new root.marked.Marked(MARKED_OPTS);
    inst.use({ renderer: renderer });
    return t.restore(inst.parse(emphasize(t.masked)));
  }

  LLM.render = { md: md, resolveRel: resolveRel, hashId: hashId, linkResolver: linkResolver, emphasize: emphasize };
  if (typeof module !== 'undefined' && module.exports) module.exports = LLM.render;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/store.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 本地学习数据层（进度 / 笔记 / 收藏 / 导入导出）
 *
 * 为什么长这样：
 *   站点是**纯静态**的（没有账号、没有服务端），用户的学习痕迹只能落在自己的浏览器里。
 *   所以全部状态收在**一个** localStorage 键（llmlearn.site.v1）里，读写都走这一个 JSON，
 *   序列化/反序列化只有一处逻辑；导出/导入存在的唯一理由，就是让「只在本机可见」的
 *   数据能换设备、能备份。
 *
 * 加载顺序的坑（index.html 是 classic script）：
 *   store.js 排在 ui.js / data.js / app.js **之前**，所以本文件里 LLM.ui / LLM.data / LLM.on
 *   在求值那一刻可能都还不存在。因此凡是跨文件的依赖都走「等一等再试」（waitFor / hookEvent），
 *   而不是在顶层直接取。
 *
 * 依赖（全部可选，缺了也不抛）：LLM.data（课时索引 / 课程目录）、LLM.fmt、LLM.ui.toast、LLM.emit
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};

  /* ---------------- 常量 ---------------- */
  var VERSION = 1;
  var KEY = 'llmlearn.site.v1';                 // 单一存储键：整个学习数据就是一个 JSON
  var CORRUPT_KEY = KEY + '.corrupt';           // 解析失败时的备份位（宁可留证据，也别静默丢笔记）
  var SAVE_DEBOUNCE = 150;
  var VISIT_EMIT_GAP = 30 * 1000;               // 同一课反复进入时节流广播，避免「渲染→记录→渲染」打转
  var WARN_BACKEND = '浏览器不允许本地存储（隐私模式 / 空间不足）：这次的学习进度只留在当前页面，关闭后会丢。';
  var WARN_CORRUPT = '本机学习数据无法解析，已备份到「' + CORRUPT_KEY + '」并重置。';

  /* ---------------- 通用小工具 ---------------- */
  function now() { return Date.now(); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function s(v) { return v == null ? '' : String(v); }
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function keys(o) { return o ? Object.keys(o) : []; }
  function copy(o) {
    if (o == null) return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
  }
  function stamp(ts) {
    if (LLM.fmt && LLM.fmt.date) return LLM.fmt.date(ts || now());
    var d = new Date(ts || now());
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /** 跨文件依赖（LLM.data / LLM.on / LLM.ui）可能比本文件晚加载：有限次轮询 */
  function waitFor(cond, tries, ms) {
    return new Promise(function (resolve) {
      var k = 0;
      (function attempt() {
        var v = null;
        try { v = cond(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (++k >= (tries || 40)) return resolve(null);
        setTimeout(attempt, ms || 25);
      })();
    });
  }

  /* ---------------- toast 提示（ui.js 可能还没加载，先记下） ---------------- */
  var pendingWarn = null;
  var warnTries = 0;
  function warnOnce(msg) {
    if (pendingWarn == null) pendingWarn = msg;
    showWarn();
  }
  function showWarn() {
    if (!pendingWarn) return;
    var u = LLM.ui;
    if (u && typeof u.toast === 'function') {
      var msg = pendingWarn;
      pendingWarn = null;
      try { u.toast(msg, 'warn'); } catch (e) { /* 提示失败不能影响数据 */ }
      return;
    }
    if (++warnTries > 60) { pendingWarn = null; return; }   // 约 1.5s 后放弃，别无限重试
    setTimeout(showWarn, 25);
  }

  /* ---------------- 存储后端：localStorage 不可用就降级为内存 ---------------- */
  var mem = Object.create(null);
  var backend = null;

  function memBackend() {
    if (!memBackend.inst) {
      memBackend.inst = {
        getItem: function (k) { return has(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
      };
    }
    return memBackend.inst;
  }
  function storage() {
    if (backend) return backend;
    try {
      var ls = root.localStorage;
      if (!ls) throw new Error('no localStorage');
      // 隐私模式下 localStorage 存在但一写就抛：探一次再决定用哪个后端
      var probe = KEY + '.probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      backend = ls;
    } catch (e) {
      backend = memBackend();
      warnOnce(WARN_BACKEND);
    }
    return backend;
  }
  function rawGet(k) {
    try { return storage().getItem(k); } catch (e) { return null; }
  }
  function rawSet(k, v) {
    try { storage().setItem(k, v); return true; }
    catch (e) {
      // 超配额也要保住这次的数据：整体转内存，别把异常抛给调用方
      backend = memBackend();
      mem[k] = String(v);
      warnOnce(WARN_BACKEND);
      return false;
    }
  }
  function rawRemove(k) { try { storage().removeItem(k); } catch (e) {} }

  /* ---------------- 状态形状 ---------------- */
  function blankSettings() { return { theme: '', fontScale: 1, hideDone: false, lastCourse: '' }; }
  function blankState() {
    return {
      version: VERSION,
      updatedAt: 0,
      progress: {},     // id → {at}
      notes: {},        // id → {text, updatedAt}
      bookmarks: {},    // id → at
      settings: blankSettings(),
      lastVisited: null,
    };
  }
  var state = blankState();

  function normProgress(src) {
    var out = {};
    if (!isObj(src)) return out;
    keys(src).forEach(function (k) {
      var v = src[k];
      if (v === true || v === 1) { out[k] = { at: 0 }; return; }         // 老格式：progress[id] = true
      if (isObj(v)) {
        if (v.at || v.ts || v.updatedAt || v.time) {
          out[k] = { at: n(v.at || v.ts || v.updatedAt || v.time) };
          return;
        }
        // 更老的站点是 progress[课程slug][课时id] 的两层结构，这里拍平
        keys(v).forEach(function (id) { if (v[id]) out[id] = { at: 0 }; });
        return;
      }
      if (v) out[k] = { at: 0 };
    });
    return out;
  }
  function normNotes(src) {
    var out = {};
    if (!isObj(src)) return out;
    keys(src).forEach(function (id) {
      var v = src[id];
      if (typeof v === 'string') { if (v.trim()) out[id] = { text: v, updatedAt: 0 }; return; }
      if (!isObj(v)) return;
      var text = s(v.text != null ? v.text : v.note);
      if (!text.trim()) return;
      out[id] = { text: text, updatedAt: n(v.updatedAt || v.at || v.ts) };
    });
    return out;
  }
  function normBookmarks(src) {
    var out = {};
    if (Array.isArray(src)) { src.forEach(function (id) { if (id) out[s(id)] = 0; }); return out; }
    if (!isObj(src)) return out;
    keys(src).forEach(function (id) {
      var v = src[id];
      if (v === false || v == null) return;
      out[id] = isObj(v) ? n(v.at || v.ts || v.updatedAt) : (v === true ? 0 : n(v));
    });
    return out;
  }
  function normSettings(src) {
    var out = blankSettings();
    if (!isObj(src)) return out;
    keys(src).forEach(function (k) {
      if (k === 'fontScale') { out.fontScale = Math.min(1.6, Math.max(0.8, n(src[k]) || 1)); return; }
      if (k === 'hideDone') { out.hideDone = !!src[k]; return; }
      out[k] = src[k];                          // 未知键保留：新版本加的偏好不该被旧代码吃掉
    });
    return out;
  }
  function normalize(obj) {
    var st = blankState();
    st.updatedAt = n(obj.updatedAt);
    st.progress = normProgress(obj.progress || obj.done);
    st.notes = normNotes(obj.notes);
    st.bookmarks = normBookmarks(obj.bookmarks || obj.stars);
    st.settings = normSettings(obj.settings);
    var lv = obj.lastVisited || obj.last;
    if (lv) st.lastVisited = { id: s(isObj(lv) ? (lv.id || lv.lesson) : lv), ts: n(isObj(lv) ? (lv.ts || lv.at) : 0) };
    if (st.lastVisited && !st.lastVisited.id) st.lastVisited = null;
    return st;
  }

  function load() {
    var raw = rawGet(KEY);
    if (!raw) return;
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!isObj(obj)) {
      rawSet(CORRUPT_KEY, raw);                 // 先备份再重置
      rawRemove(KEY);
      warnOnce(WARN_CORRUPT);
      return;
    }
    state = normalize(obj);
  }

  /* ---------------- 保存（150ms 防抖 + 立即 flush） ---------------- */
  var saveTimer = null;
  var dirty = false;
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    dirty = false;
    state.version = VERSION;
    state.updatedAt = now();
    rawSet(KEY, JSON.stringify(state));
  }
  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE);
    if (saveTimer && saveTimer.unref) saveTimer.unref();   // node 下自测时别拖住进程
  }
  function persist() { dirty = true; flush(); }

  /* ---------------- 广播：本地监听 + LLM 事件总线 ---------------- */
  var listeners = [];
  function fire(kind) {
    listeners.slice().forEach(function (fn) { try { fn(kind); } catch (e) { if (root.console) console.error(e); } });
    if (typeof LLM.emit === 'function') {
      try { LLM.emit('progress'); } catch (e) {}            // 顶栏进度环靠它刷新
      if (kind === 'notes') { try { LLM.emit('notes'); } catch (e) {} }
      if (kind === 'bookmarks') { try { LLM.emit('bookmarks'); } catch (e) {} }
      if (kind === 'settings') { try { LLM.emit('settings'); } catch (e) {} }
    }
    showWarn();                                             // 顺手把没弹出来的降级提示补上
  }
  function commit(kind) { scheduleSave(); fire(kind); }

  /* ---------------- 元数据：站点 / 课时索引 / 课程目录（懒加载 + 缓存） ---------------- */
  var siteInfo = null;
  var siteCounts = {};
  var siteLines = [];
  var siteFamilies = [];
  var lessonIndex = {};        // 课时 id → {c,ch,l,t,p,seq,ct}
  var cards = [];              // 课程卡（顺序 = 学习路径顺序）
  var cardBySlug = {};
  var detailBySlug = {};       // 课程 slug → 课程明细（含每课 minutes）
  var detailPending = {};
  var minutesById = {};        // 课时 id → minutes（来自课程明细）
  var titleById = {};          // 课时 id → 标题（明细兜底）
  var chapterTitles = {};      // 课程 slug → {章 slug: 章标题}
  var readyP = null;

  function waitForData() {
    return waitFor(function () {
      var d = LLM.data;
      return (d && typeof d.lessons === 'function' && typeof d.courses === 'function') ? d : null;
    });
  }
  function fetchJSON(rel) {
    var d = LLM.data;
    if (d && typeof d.get === 'function') return d.get(rel);
    if (typeof root.fetch === 'function') {
      return root.fetch(rel, { cache: 'force-cache' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    return Promise.reject(new Error('没有可用的数据加载方式'));
  }
  /** app.js 会在 data/site.json 到达后 emit('site')，但它自己也可能比我们晚加载 */
  function hookEvent(name, fn) {
    var done = false;
    function attempt() {
      if (done) return true;
      if (typeof LLM.on !== 'function') return false;
      try { LLM.on(name, fn); done = true; return true; } catch (e) { return false; }
    }
    if (attempt()) return;
    if (root.document && root.document.addEventListener) root.document.addEventListener('DOMContentLoaded', attempt);
    var tries = 0;
    (function loop() {
      if (attempt()) return;
      if (++tries > 60) return;
      setTimeout(loop, 25);
    })();
  }

  var siteResolve = null;
  var siteP = null;
  function finishSite() {
    if (siteResolve) { var r = siteResolve; siteResolve = null; r(siteInfo); }
  }
  function adoptSite(site) {
    if (!site || !site.counts) return false;
    var changed = n(site.counts.lessons) !== n(siteCounts.lessons) || n(site.counts.minutes) !== n(siteCounts.minutes);
    siteInfo = site;
    siteCounts = site.counts;
    if (site.lines && site.lines.length) siteLines = site.lines;
    if (site.families) siteFamilies = site.families;
    finishSite();
    if (changed) fire('progress');              // 总量晚到 → 让顶栏/统计按真实分母重算
    return true;
  }
  function loadSite() {
    if (siteP) return siteP;
    siteP = new Promise(function (resolve) {
      siteResolve = resolve;
      if (LLM.site && adoptSite(LLM.site)) return;
      hookEvent('site', function (site) { adoptSite(site); });
      var p = null;
      try { p = LLM.data.site(); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') p.then(adoptSite).catch(finishSite);
      else setTimeout(finishSite, 0);           // 连 fetch 都没有（极端环境）也别让 ready() 挂住
    });
    return siteP;
  }
  function loadLessonIndex() {
    return waitForData().then(function (d) {
      if (d && typeof d.lessons === 'function') return d.lessons();
      return fetchJSON('data/lessons.json').then(function (j) { return (j && j.lessons) || {}; });
    }).then(function (map) {
      if (isObj(map) && keys(map).length) lessonIndex = map;
      return lessonIndex;
    }).catch(function () { return lessonIndex; });
  }
  function loadCards() {
    return waitForData().then(function (d) {
      if (d && typeof d.courses === 'function') return d.courses();
      return fetchJSON('data/courses.json').then(function (j) { return (j && j.courses) || []; });
    }).then(function (list) {
      if (Array.isArray(list) && list.length) {
        cards = list;
        cardBySlug = {};
        list.forEach(function (c) { if (c && c.slug) cardBySlug[c.slug] = c; });
      }
      return cards;
    }).catch(function () { return cards; });
  }
  function ready() {
    // 课时索引（34KB gzip）**不进 ready 链**：它只用于显示进度，
    // 延后到首绘/空闲时再拉（首次访问无本地进度时干脆不拉），避免拖住首屏。
    // 课时索引（lessons.json，34KB gzip）：**有本地进度时必须在启动链里** ——
    // 首页「继续学习」要靠它把 id 映射成课时标题（否则会显示裸 id，如 dinf-ch5-l4 ✗）。
    // 首次访问（无进度）则完全不拉，省掉一次跨境请求 ✓
    var hasLocal = false;
    try { hasLocal = !!root.localStorage.getItem(KEY); } catch (e) { hasLocal = false; }
    if (!readyP) {
      var chain = [loadSite(), loadCards()];
      if (hasLocal) chain.push(loadLessonIndex());
      readyP = Promise.all(chain).then(function () { return true; });
    }
    return readyP;
  }

  function indexDetail(detail) {
    if (!detail || !detail.slug) return false;
    detailBySlug[detail.slug] = detail;
    var chan = chapterTitles[detail.slug] = chapterTitles[detail.slug] || {};
    var gained = false;
    (detail.chapters || []).forEach(function (ch) {
      if (!ch) return;
      if (ch.slug) chan[ch.slug] = ch.title || chan[ch.slug] || '';
      (ch.lessons || []).forEach(function (l) {
        if (!l || !l.id) return;
        if (l.title) titleById[l.id] = l.title;
        if (!has(minutesById, l.id)) gained = true;
        minutesById[l.id] = n(l.minutes);
      });
    });
    return gained;
  }
  function loadDetail(slug) {
    slug = s(slug);
    if (!slug) return Promise.resolve(null);
    if (detailBySlug[slug]) return Promise.resolve(detailBySlug[slug]);
    if (detailPending[slug]) return detailPending[slug];
    detailPending[slug] = waitForData().then(function (d) {
      if (d && typeof d.course === 'function') return d.course(slug);
      return fetchJSON('data/course/' + slug + '.json');
    }).then(function (detail) {
      delete detailPending[slug];
      if (detail) indexDetail(detail);
      return detail || null;
    }).catch(function () { delete detailPending[slug]; return null; });
    return detailPending[slug];
  }
  function touchedIds() {
    var ids = keys(state.progress).concat(keys(state.notes), keys(state.bookmarks));
    if (state.lastVisited && state.lastVisited.id) ids.push(state.lastVisited.id);
    return ids;
  }
  /** 只为「有痕迹的那几门课」补 minutes：全量加载 41 门课的明细没必要 */
  function enrichMinutes() {
    return ready().then(function () {
      var slugs = {};
      touchedIds().forEach(function (id) {
        var c = s((lessonIndex[id] || {}).c);
        if (c && !detailBySlug[c]) slugs[c] = true;
      });
      var list = keys(slugs);
      if (!list.length) return false;
      return Promise.all(list.map(loadDetail)).then(function (res) {
        var gained = res.some(function (d) { return !!d; });
        if (gained) fire('progress');           // 时长/分钟数补齐了，统计可以重画
        return gained;
      });
    });
  }
  var enrichTimer = null;
  function scheduleEnrich() {
    if (enrichTimer) return;
    enrichTimer = setTimeout(function () { enrichTimer = null; enrichMinutes(); }, 400);
    if (enrichTimer && enrichTimer.unref) enrichTimer.unref();
  }

  /** 课时 id → 列表项需要的全部字段（元数据缺失时退化为 id 与 #/l/<id> 路由） */
  function entry(id) {
    id = s(id);
    var li = lessonIndex[id] || {};
    var c = s(li.c);
    var card = cardBySlug[c] || {};
    var detail = detailBySlug[c];
    var chan = chapterTitles[c] || {};
    var chapter = s(li.ch);
    var route = (c && chapter && li.l) ? ('#/learn/' + c + '/' + chapter + '/' + li.l) : ('#/l/' + id);
    return {
      id: id,
      title: s(li.t) || titleById[id] || id,
      course: c,
      courseTitle: card.title || (detail && detail.title) || c,
      chapter: chapter,
      chapterTitle: s(li.ct) || chan[chapter] || '',
      route: route,
      minutes: n(minutesById[id]),
      seq: n(li.seq),
      line: card.line || '',
      family: card.family || '',
      cover: card.cover || '',
    };
  }
  function courseOrder() {
    var out = [], seen = {};
    siteLines.forEach(function (l) {
      ((l && l.slugs) || []).forEach(function (sl) { if (sl && !seen[sl]) { seen[sl] = 1; out.push(sl); } });
    });
    cards.forEach(function (c) { if (c && c.slug && !seen[c.slug]) { seen[c.slug] = 1; out.push(c.slug); } });
    return out;
  }
  function lessonOrder(slug) {
    var ids = [];
    var detail = detailBySlug[slug];
    if (detail && detail.chapters) {
      detail.chapters.forEach(function (ch) { ((ch && ch.lessons) || []).forEach(function (l) { if (l && l.id) ids.push(l.id); }); });
      if (ids.length) return ids;
    }
    keys(lessonIndex).forEach(function (id) { if (s((lessonIndex[id] || {}).c) === slug) ids.push(id); });
    // lessons.json 的 seq 是「课内序号」，跨章也连续 → 直接用它排
    ids.sort(function (a, b) { return n((lessonIndex[a] || {}).seq) - n((lessonIndex[b] || {}).seq); });
    return ids;
  }

  /* ---------------- 进度 ---------------- */
  function isDone(id) { return !!state.progress[s(id)]; }
  function setDone(id, done) {
    id = s(id);
    if (!id) return false;
    if (done) {
      if (!state.progress[id]) {
        state.progress[id] = { at: now() };
        commit('progress');
        scheduleEnrich();
      }
    } else if (state.progress[id]) {
      delete state.progress[id];
      commit('progress');
    }
    return !!state.progress[id];
  }
  function toggleDone(id) { return setDone(id, !isDone(id)); }
  function doneIds() { return keys(state.progress); }
  /** 统计用的「有效课时」：索引就绪后，忽略不属于本站的脏 id（旧版本 / 手改的数据） */
  function doneIdList() {
    var ids = keys(state.progress);
    if (!keys(lessonIndex).length) return ids;
    return ids.filter(function (id) { return has(lessonIndex, id); });
  }

  /* ---------------- 笔记 ---------------- */
  function note(id) {
    var e = state.notes[s(id)];
    return e ? { text: e.text, updatedAt: e.updatedAt } : null;
  }
  function setNote(id, text) {
    id = s(id);
    if (!id) return null;
    text = s(text);
    if (!text.trim()) { deleteNote(id); return null; }          // 清空 = 删除，别留空笔记
    var e = state.notes[id];
    if (e && e.text === text) return { text: text, updatedAt: e.updatedAt };
    var at = now();
    state.notes[id] = { text: text, updatedAt: at };
    commit('notes');
    scheduleEnrich();
    return { text: text, updatedAt: at };
  }
  function deleteNote(id) {
    id = s(id);
    if (state.notes[id]) { delete state.notes[id]; commit('notes'); }
  }
  function notes() { return copy(state.notes) || {}; }
  function notesList() {
    return keys(state.notes).map(function (id) {
      var e = state.notes[id];
      var it = entry(id);
      it.text = e.text;
      it.updatedAt = n(e.updatedAt);
      return it;
    }).sort(function (a, b) { return n(b.updatedAt) - n(a.updatedAt); });
  }

  /* ---------------- 收藏 ---------------- */
  function isBookmarked(id) { return has(state.bookmarks, s(id)); }
  function toggleBookmark(id) {
    id = s(id);
    if (!id) return false;
    if (has(state.bookmarks, id)) { delete state.bookmarks[id]; commit('bookmarks'); return false; }
    state.bookmarks[id] = now();
    commit('bookmarks');
    scheduleEnrich();
    return true;
  }
  function bookmarks() {
    return keys(state.bookmarks).sort(function (a, b) { return n(state.bookmarks[b]) - n(state.bookmarks[a]); });
  }
  function bookmarkList() {
    return keys(state.bookmarks).map(function (id) {
      var it = entry(id);
      var nt = state.notes[id];
      it.text = nt ? nt.text : '';
      it.updatedAt = n(state.bookmarks[id]);
      it.bookmarkedAt = it.updatedAt;
      it.hasNote = !!nt;
      return it;
    }).sort(function (a, b) { return n(b.bookmarkedAt) - n(a.bookmarkedAt); });
  }

  /* ---------------- 设置 / 最近访问 ---------------- */
  function settings() { return copy(state.settings) || blankSettings(); }
  function setSetting(k, v, silent) {
    k = s(k);
    if (!k) return;
    if (has(state.settings, k) && state.settings[k] === v) return;   // 值没变就别写盘（app.js 每次应用主题都会调）
    state.settings[k] = k === 'fontScale' ? Math.min(1.6, Math.max(0.8, n(v) || 1)) : v;
    scheduleSave();
    if (!silent) fire('settings');
  }
  var lastVisitEmit = 0;
  function setLastVisited(lessonId) {
    lessonId = s(lessonId);
    if (!lessonId) return;
    var prev = state.lastVisited;
    state.lastVisited = { id: lessonId, ts: now() };
    var c = s((lessonIndex[lessonId] || {}).c);
    if (c) state.settings.lastCourse = c;
    scheduleSave();
    // 同一课在 30s 内重复记录（渲染 → 记录 → 再渲染）不广播，避免事件打转
    if (!prev || prev.id !== lessonId || now() - lastVisitEmit > VISIT_EMIT_GAP) {
      lastVisitEmit = now();
      fire('visit');
      scheduleEnrich();
    }
  }
  function lastVisited() {
    return state.lastVisited ? { id: state.lastVisited.id, ts: n(state.lastVisited.ts) } : null;
  }

  /* ---------------- 统计 ---------------- */
  function stats() {
    var ids = doneIdList();
    var doneMinutes = 0;
    ids.forEach(function (id) { doneMinutes += n(minutesById[id]); });
    var totalLessons = n(siteCounts.lessons);
    var totalMinutes = n(siteCounts.minutes);
    var pct = totalLessons ? Math.round((ids.length / totalLessons) * 100) : 0;
    return {
      doneLessons: ids.length,
      totalLessons: totalLessons,
      doneMinutes: doneMinutes,
      totalMinutes: totalMinutes,
      notes: keys(state.notes).length,
      bookmarks: keys(state.bookmarks).length,
      pct: Math.max(0, Math.min(100, pct)),
    };
  }

  function statsByCourse() {
    return ready().then(enrichMinutes).then(function () {
      var bySlug = {};
      doneIdList().forEach(function (id) {
        var c = s((lessonIndex[id] || {}).c);
        if (!c) return;
        var b = bySlug[c] || (bySlug[c] = { done: 0, doneMinutes: 0 });
        b.done += 1;
        b.doneMinutes += n(minutesById[id]);
      });
      var list = cards.map(function (card) {
        var cnt = card.counts || {};
        var b = bySlug[card.slug] || { done: 0, doneMinutes: 0 };
        var total = n(cnt.lessons);
        return {
          slug: card.slug,
          title: card.title,
          line: card.line || '',
          family: card.family || '',
          done: b.done,
          total: total,
          pct: total ? Math.round((b.done / total) * 100) : 0,
          minutes: n(cnt.minutes),
          figures: n(cnt.figures),
          cover: card.cover || '',
          doneMinutes: b.doneMinutes,
        };
      });
      function agg(keyOf, orderHint) {
        var map = {}, order = [];
        list.forEach(function (c) {
          var name = keyOf(c) || '其他';
          if (!map[name]) { map[name] = { name: name, done: 0, total: 0, pct: 0 }; order.push(name); }
          map[name].done += c.done;
          map[name].total += c.total;
        });
        if (orderHint && orderHint.length) {
          order.sort(function (a, b) {
            var ia = orderHint.indexOf(a), ib = orderHint.indexOf(b);
            return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
          });
        }
        return order.map(function (name) {
          var o = map[name];
          o.pct = o.total ? Math.round((o.done / o.total) * 100) : 0;
          return o;
        });
      }
      var lineOrder = siteLines.map(function (l) { return l && l.name; }).filter(Boolean);
      var recent = doneIdList().map(function (id) {
        return { id: id, ts: n((state.progress[id] || {}).at) };
      }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 10).map(function (r) {
        var it = entry(r.id);
        it.ts = r.ts;
        return it;
      });
      // 首页「继续学习」会按 id 回查课时信息，这里只放被引用到的少数几条，别整表搬过去
      var lessonMap = {};
      recent.forEach(function (r) { lessonMap[r.id] = r; });
      if (state.lastVisited && state.lastVisited.id) lessonMap[state.lastVisited.id] = entry(state.lastVisited.id);
      return {
        courses: list,
        lines: agg(function (c) { return c.line; }, lineOrder),
        families: agg(function (c) { return c.family; }, siteFamilies.map(function (f) { return isObj(f) ? (f.name || f.title) : f; })),
        recent: recent,
        lessons: lessonMap,
      };
    });
  }

  /* ---------------- 下一课 ---------------- */
  function infoOf(id) {
    var it = entry(id);
    return {
      id: it.id, title: it.title, course: it.course, courseTitle: it.courseTitle,
      chapter: it.chapter, chapterTitle: it.chapterTitle, route: it.route, minutes: it.minutes,
    };
  }
  function firstUndoneIn(slug) {
    return loadDetail(slug).then(function () {
      var ids = lessonOrder(slug);
      for (var i = 0; i < ids.length; i++) if (!isDone(ids[i])) return infoOf(ids[i]);
      return null;
    });
  }
  function firstLessonOf(slug) {
    return loadDetail(slug).then(function () {
      var ids = lessonOrder(slug);
      return ids.length ? infoOf(ids[0]) : null;
    });
  }
  function walkCourses(slugs, i) {
    if (i >= slugs.length) return Promise.resolve(null);
    return firstUndoneIn(slugs[i]).then(function (r) { return r || walkCourses(slugs, i + 1); });
  }
  function nextInCourse(id) {
    var li = lessonIndex[id];
    if (!li || !li.c) return Promise.resolve(null);
    var slug = s(li.c);
    return loadDetail(slug).then(function () {
      var ids = lessonOrder(slug);
      var i = ids.indexOf(id);
      if (i >= 0) {
        for (var k = i + 1; k < ids.length; k++) if (!isDone(ids[k])) return infoOf(ids[k]);
      }
      // 本课之后（或整门课）再没有未完成的课时 → 顺着学习路径找下一门还有未完成课时的课；
      // 找不到就返回 null，由 nextLesson 兜底到「第一门课第一课」（学完全部时的去处）
      var order = courseOrder();
      var ci = order.indexOf(slug);
      return walkCourses(ci >= 0 ? order.slice(ci + 1) : order, 0);
    });
  }
  function nextLesson() {
    return ready().then(function () {
      var order = courseOrder();
      var last = state.lastVisited && state.lastVisited.id;
      if (last && !isDone(last)) {                    // 上次那课还没打勾 → 接着学它
        var it = infoOf(last);
        if (it && (it.course || it.id)) return it;
      }
      var chain = [];
      if (last) chain.push(last);
      doneIdList().sort(function (a, b) { return n((state.progress[b] || {}).at) - n((state.progress[a] || {}).at); })
        .forEach(function (id) { if (chain.indexOf(id) < 0) chain.push(id); });
      function walk(i) {
        if (i >= chain.length) return Promise.resolve(null);
        return nextInCourse(chain[i]).then(function (r) { return r || walk(i + 1); });
      }
      return walk(0).then(function (r) {
        if (r) return r;
        return walkCourses(order, 0);
      }).then(function (r) {
        if (r) return r;
        return order.length ? firstLessonOf(order[0]) : null;   // 全学完了也给个去处
      });
    });
  }

  /* ---------------- 导出 ---------------- */
  function exportObject() {
    flush();                                     // 导出前必须先落盘，否则丢最近 150ms 的改动
    return {
      app: 'llm-learn',
      site: 'llm-learn 大模型系统学习站',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      counts: {
        progress: keys(state.progress).length,
        notes: keys(state.notes).length,
        bookmarks: keys(state.bookmarks).length,
      },
      progress: copy(state.progress) || {},
      notes: copy(state.notes) || {},
      bookmarks: copy(state.bookmarks) || {},
      settings: copy(state.settings) || blankSettings(),
      lastVisited: state.lastVisited ? copy(state.lastVisited) : null,
    };
  }
  function exportJSON() { return JSON.stringify(exportObject(), null, 2); }

  function exportMarkdown() {
    flush();
    var list = notesList();
    var st = stats();
    var L = [];
    L.push('# llm-learn 学习笔记');
    L.push('');
    L.push('> 导出时间：' + stamp() + ' · 来源：llm-learn 大模型系统学习站');
    L.push('> 笔记 ' + st.notes + ' 条 · 进度 ' + st.doneLessons + ' / ' + (st.totalLessons || '—') + ' 课时');
    L.push('> 本文件只含**笔记原文**（按 课程 → 章节 → 课时 组织）。进度与收藏请用页面的「导出 JSON」备份。');
    L.push('');
    if (!list.length) {
      L.push('_还没有任何笔记。_');
      return L.join('\n') + '\n';
    }
    var order = courseOrder();
    var groups = [], gmap = {};
    list.forEach(function (it) {
      var key = it.course || '_';
      if (!gmap[key]) {
        gmap[key] = { slug: it.course, title: it.courseTitle || it.course || '未归类的课时', items: [] };
        groups.push(gmap[key]);
      }
      gmap[key].items.push(it);
    });
    groups.sort(function (a, b) {
      var ia = order.indexOf(a.slug), ib = order.indexOf(b.slug);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
    groups.forEach(function (g) {
      L.push('## ' + g.title + (g.slug ? '（`' + g.slug + '`）' : ''));
      L.push('');
      g.items.sort(function (a, b) { return n(a.seq) - n(b.seq); });
      var curCh = null, curChTitle = '';
      g.items.forEach(function (it) {
        var chKey = it.chapter || '';
        if (chKey !== curCh) {
          curCh = chKey;
          curChTitle = it.chapterTitle || chKey || '未分章';
          L.push('### ' + curChTitle);
          L.push('');
        }
        L.push('#### ' + (it.title || it.id));
        L.push('');
        L.push('- 位置：`' + it.route + '`' + (it.minutes ? ' · 约 ' + it.minutes + ' 分钟' : ''));
        L.push('- 笔记更新：' + stamp(it.updatedAt));
        L.push('');
        L.push(it.text);
        L.push('');
      });
    });
    return L.join('\n');
  }

  /* ---------------- 导入 ---------------- */
  function importJSON(text, opts) {
    var mode = (opts && opts.mode) === 'replace' ? 'replace' : 'merge';
    var res = { ok: false, mode: mode, added: 0, updated: 0, skipped: 0 };
    var obj = null;
    try { obj = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (e) { res.error = '不是合法的 JSON：' + s(e && e.message); return res; }
    if (!isObj(obj)) { res.error = '顶层不是一个 JSON 对象'; return res; }
    var looksLikeOurs = ['progress', 'done', 'notes', 'bookmarks', 'stars', 'settings', 'lastVisited', 'last']
      .some(function (k) { return obj[k] != null; });
    if (!looksLikeOurs) { res.error = '没找到 progress / notes / bookmarks 字段，可能不是本站导出的文件'; return res; }
    var inc = normalize(obj);

    if (mode === 'replace') {
      var keepTheme = state.settings.theme;      // 主题是本机偏好，不该被别人的数据覆盖
      state = inc;
      state.settings.theme = keepTheme;
      res.added = keys(state.progress).length + keys(state.notes).length + keys(state.bookmarks).length;
      res.ok = true;
      persist();
      fire('notes');
      return res;
    }

    // merge：进度取并集，笔记按 updatedAt 取新者，收藏取并集
    keys(inc.progress).forEach(function (id) {
      var cur = state.progress[id], add = inc.progress[id];
      if (!cur) { state.progress[id] = { at: n(add.at) || now() }; res.added++; return; }
      if (n(add.at) > n(cur.at)) { cur.at = n(add.at); res.updated++; return; }
      res.skipped++;
    });
    keys(inc.notes).forEach(function (id) {
      var cur = state.notes[id], add = inc.notes[id];
      if (!cur) { state.notes[id] = { text: add.text, updatedAt: n(add.updatedAt) || now() }; res.added++; return; }
      if (cur.text === add.text) { res.skipped++; return; }
      if (n(add.updatedAt) >= n(cur.updatedAt)) { state.notes[id] = { text: add.text, updatedAt: n(add.updatedAt) || now() }; res.updated++; return; }
      res.skipped++;
    });
    keys(inc.bookmarks).forEach(function (id) {
      if (has(state.bookmarks, id)) { res.skipped++; return; }
      state.bookmarks[id] = n(inc.bookmarks[id]) || now();
      res.added++;
    });
    // 导入**不合并** settings：主题/字号是这台设备的显示偏好，别人的偏好不该改你的界面（replace 也只保留 theme）
    if (inc.lastVisited && (!state.lastVisited || n(inc.lastVisited.ts) > n(state.lastVisited.ts))) state.lastVisited = inc.lastVisited;
    res.ok = true;
    persist();
    fire('notes');
    return res;
  }

  function clearAll() {
    var keep = copy(state.settings) || blankSettings();
    state = blankState();                        // 进度/笔记/收藏/最近访问全清，主题等本机偏好保留
    state.settings = keep;
    persist();
    fire('notes');
    return true;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  /* ---------------- 对外 API ---------------- */
  var api = {
    VERSION: VERSION,
    KEY: KEY,
    isDone: isDone,
    setDone: setDone,
    toggleDone: toggleDone,
    doneIds: doneIds,
    note: note,
    setNote: setNote,
    deleteNote: deleteNote,
    notes: notes,
    notesList: notesList,
    isBookmarked: isBookmarked,
    toggleBookmark: toggleBookmark,
    bookmarks: bookmarks,
    bookmarkList: bookmarkList,
    settings: settings,
    setSetting: setSetting,
    setLastVisited: setLastVisited,
    lastVisited: lastVisited,
    stats: stats,
    statsByCourse: statsByCourse,
    nextLesson: nextLesson,
    exportObject: exportObject,
    exportJSON: exportJSON,
    exportMarkdown: exportMarkdown,
    importJSON: importJSON,
    clearAll: clearAll,
    onChange: onChange,
    // 下面是契约之外的补充（给其它视图用的）：flush 落盘、ready 等元数据就绪
    flush: flush,
    ready: ready,
  };
  LLM.store = api;

  /* ---------------- 启动 ---------------- */
  try {
    load();
    // 预热元数据（site/lessons/courses 都是小文件，首屏本来也要用）并补齐已记录课时的时长
    ready();
    scheduleEnrich();
    if (root.addEventListener) {
      root.addEventListener('pagehide', flush);
      root.addEventListener('beforeunload', flush);
    }
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.hidden) flush();
      });
    }
  } catch (e) {
    if (root.console) console.error('store 初始化失败（降级为空数据继续跑）', e);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/ui.js ===== */
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

;
/* ===== assets/data.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 数据层：静态 JSON（无服务端）
 * 所有路径都是**相对站点根**的，因此可直接放在 GitHub Pages 的子路径下
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};

  var cache = Object.create(null);
  var pending = Object.create(null);

  /** 带缓存戳的 URL（同一路径，绕过浏览器里可能被缓存住的 404 / 旧内容） */
  function bust(rel) {
    return rel + (rel.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
  }

  function once(rel, url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('加载失败 ' + rel + '（HTTP ' + r.status + '）');
      return r.json();
    });
  }

  function fetchJSON(rel) {
    if (cache[rel]) return Promise.resolve(cache[rel]);
    if (pending[rel]) return pending[rel];
    pending[rel] = once(rel, rel)
      // 自愈：之前那次加载（比如构建中途 / 打开错目录）可能在浏览器里留下了 404 缓存，
      // 带时间戳重试一次 —— 文件在就正常了，用户不用去手动清缓存。
      .catch(function (firstErr) {
        if (!/HTTP 404/.test(String(firstErr.message))) throw firstErr;
        console.warn('[llm-learn] ' + rel + ' 首次加载 404，带缓存戳重试一次…');
        return once(rel, bust(rel)).then(function (data) {
          console.warn('[llm-learn] ' + rel + ' 重试成功（之前那次多半是缓存住的 404）');
          return data;
        }).catch(function () { throw firstErr; });
      })
      .then(function (data) {
        cache[rel] = data;
        delete pending[rel];
        return data;
      })
      .catch(function (e) {
        delete pending[rel];
        throw e;
      });
    return pending[rel];
  }

  var lessonIndexCache = null;

  /* 启动数据合并（data/boot.json）：一次请求拿到 site/courses/figures/figureMeta。
     跨境 RTT 高时，4 次请求 → 1 次是最大的一笔收益；缺文件/老产物自动回退分片。 */
  var bootCache = null, bundleCache = null;
  function boot() {
    if (!bootCache) bootCache = fetchJSON('data/boot.json').catch(function () { return null; });
    return bootCache;
  }

  var api = {
    get: fetchJSON,
    site: function () { return boot().then(function (b) { return (b && b.site) || fetchJSON('data/site.json'); }); },
    courses: function () { return boot().then(function (b) { return (b && b.courses) ? b.courses.courses : fetchJSON('data/courses.json').then(function (d) { return d.courses; }); }); },
    course: function (slug) { return fetchJSON('data/course/' + slug + '.json'); },
    search: function () { return fetchJSON('data/search.json').then(function (d) { return d.items; }); },
    text: function (slug) { return fetchJSON('data/text/' + slug + '.json').then(function (d) { return d.lessons; }); },
    figures: function () { return api.figuresBundle().then(function (b) { return (b && b.figures) || fetchJSON('data/figures.json'); }); },
    /** 图表库包（figures + figureMeta）：只在图表库页拉一次，避免首页/课程页多背 348KB */
    figuresBundle: function () {
      if (!bundleCache) bundleCache = fetchJSON('data/figures-bundle.json').catch(function () { return null; });
      return bundleCache;
    },
    figureMeta: function () {
      return api.figuresBundle().then(function (b) { return (b && b.figureMeta) || fetchJSON('data/figure-meta.json'); });
    },
    /** 课时 → 本课涉及的关键词（构建期从百科指针反转而来） */
    lessonTerms: function () { return fetchJSON('data/lesson-terms.json').then(function (d) { return d.lessons || {}; }); },
    glossaryIndex: function () { return fetchJSON('data/glossary/index.json'); },
    glossaryLayer: function (id) { return fetchJSON('data/glossary/' + id + '.json'); },

    /** 全站课时索引：id → {c,ch,l,t,ct,seq,p}（构建期从 dist/lessons.json 拷来） */
    lessons: function () {
      if (lessonIndexCache) return Promise.resolve(lessonIndexCache);
      return boot().then(function (b) {
        if (b && b.lessons) { lessonIndexCache = b.lessons.lessons || {}; return lessonIndexCache; }
        return fetchJSON('data/lessons.json').then(function (d) { lessonIndexCache = d.lessons || {}; return lessonIndexCache; });
      });
    },

    /** 课时 → 路由 */
    routeOf: function (lessonIdOrMeta) {
      var m = lessonIdOrMeta;
      if (typeof m === 'string') return '#/l/' + m;
      if (!m) return '#/courses';
      return '#/learn/' + m.c + '/' + m.ch + '/' + m.l;
    },

    /** 课时 → 正文文件（站点内路径） */
    fileOf: function (meta) {
      if (!meta) return '';
      return meta.p ? 'content/' + meta.p.replace(/^courses\//, 'courses/') : ('content/courses/' + meta.c + '/' + meta.ch + '/' + meta.l + '.md');
    },

    /** 课程封面（缺失时退化为普通封面） */
    coverOf: function (card) {
      return (card && (card.cover || card.coverPlain)) || '';
    },
  };

  LLM.data = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-home.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 首页
 * 一屏说清「这是什么 / 我该从哪学 / 学完能做什么」，然后给完整课程地图
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  /** 课程卡（首页/课程页共用）：封面 + 标题 + 元信息 + 进度环 */
  function courseCard(card, opts) {
    var o = opts || {};
    // 紧凑行（课程地图用）：无封面、单行 —— 首页原来把 41 门课全用带封面大卡铺开，整页 10600px
    if (o.compact) {
      var row = ui.el('a', 'course-row');
      row.href = '#/course/' + card.slug;
      row.title = card.title + (card.line ? '（' + card.line + '）' : '') + '：' + card.counts.lessons + ' 课时';
      // 克制路线：只留「序号 + 标题 + 参数」，不铺色块/缩略图
      row.appendChild(ui.el('span', 'course-row-idx', o.index ? o.index : ''));
      var main = ui.el('div', 'course-row-main');
      main.appendChild(ui.el('span', 'course-row-title', card.title));
      // 不再重复方向线名（分组标题已写）→ 参数能完整显示
      main.appendChild(ui.el('span', 'course-row-meta',
        [card.counts.lessons + ' 课时', card.counts.figures + ' 图', card.difficulty].filter(Boolean).join(' · ')));
      row.appendChild(main);
      if (o.progress) {
        var pct = o.progress.total ? Math.round(o.progress.done / o.progress.total * 100) : 0;
        var bar = ui.el('span', 'course-row-bar');
        bar.innerHTML = '<i style="width:' + pct + '%"></i>';
        row.appendChild(bar);
        row.appendChild(ui.el('span', 'course-row-pct', pct ? pct + '%' : '—'));
      }
      return row;
    }
    if (o.medium) {
      // 课程站做法：封面 + 标题 + 参数 + 难度 + 进度，一屏能扫完
      var m = ui.el('a', 'card course-card course-card--medium');
      m.href = '#/course/' + card.slug;
      if (card.cover) {
        var mc = ui.el('img', 'card-cover');
        mc.src = card.cover; mc.alt = card.title + ' 封面'; mc.loading = 'lazy'; mc.decoding = 'async';
        m.appendChild(mc);
      }
      m.setAttribute('aria-label', card.title);
      var mb = ui.el('div', 'card-body');   // 封面里已有课程名 → 卡体不再重复标题
      if (card.description) {
        var md = ui.el('p', 'card-desc'); md.textContent = card.description; mb.appendChild(md);
      }
      var mm = ui.el('div', 'card-meta');
      mm.appendChild(ui.el('span', null, card.counts.lessons + ' 课时'));
      mm.appendChild(ui.el('span', null, '·'));
      mm.appendChild(ui.el('span', null, card.counts.figures + ' 图'));
      if (card.difficulty) mm.appendChild(ui.el('span', 'badge badge--level', card.difficulty));
      mb.appendChild(mm);
      if (o.progress && o.progress.total) {
        var pw = ui.el('div', 'card-progressbar');
        pw.innerHTML = '<i style="width:' + Math.round(o.progress.done / o.progress.total * 100) + '%"></i>';
        mb.appendChild(pw);
      }
      m.appendChild(mb);
      return m;
    }
    var a = ui.el('a', 'card course-card');
    a.href = '#/course/' + card.slug;
    var top = ui.el('div', 'card-top');
    if (card.cover) {
      var img = ui.el('img', 'card-cover');
      img.src = card.cover;
      img.alt = card.title + ' 封面';
      img.loading = 'lazy';
      img.decoding = 'async';
      top.appendChild(img);
    } else {
      var ph = ui.el('div', 'card-cover skeleton');
      top.appendChild(ph);
    }
    var flags = ui.el('div', 'card-flags');
    if (card.difficulty) flags.appendChild(ui.el('span', 'badge badge--level', card.difficulty));
    top.appendChild(flags);
    if (LLM.store && LLM.store.statsByCourse && o.progress) {
      var p = o.progress;
      var ring = ui.ring(p.done, p.total, { size: 'sm', chip: true });
      ring.classList.add('card-progress');
      top.appendChild(ring);
    }
    a.appendChild(top);

    var body = ui.el('div', 'card-body');
    var h = ui.el('h3', 'card-title');
    h.textContent = card.title;
    body.appendChild(h);
    if (card.description) body.appendChild(ui.el('p', 'card-desc', card.description));
    var meta = ui.el('div', 'card-meta');
    meta.appendChild(ui.el('span', null, card.counts.lessons + ' 课时'));
    meta.appendChild(ui.el('span', null, '·'));
    meta.appendChild(ui.el('span', null, card.counts.figures + ' 图'));
    meta.appendChild(ui.el('span', null, '·'));
    meta.appendChild(ui.el('span', null, fmt.minutes(card.counts.minutes)));
    body.appendChild(meta);
    if (card.line) {
      var tags = ui.el('div', 'tags');
      tags.style.marginTop = '10px';
      tags.appendChild(ui.el('span', 'badge badge--line', card.line));
      (card.top_tags || []).slice(0, 2).forEach(function (t) { tags.appendChild(ui.el('span', 'tag', t)); });
      body.appendChild(tags);
    }
    a.appendChild(body);
    return a;
  }
  views.courseCard = courseCard;

  /** 学习路径卡：为什么学 + 课程链 + 进度 */
  function pathCard(p, bySlug, progressMap) {
    var card = ui.el('div', 'card path-card');
    var head = ui.el('div', 'path-head');
    var glyph = ui.el('div', 'path-glyph');
    glyph.innerHTML = (views.pathIcon ? ui.iconSvg(views.pathIcon(p), 22) : ui.iconSvg('route', 22));
    head.appendChild(glyph);
    var tw = ui.el('div');
    tw.appendChild(ui.el('h3', null, p.name));
    if (p.group) tw.appendChild(ui.el('div', 'small muted', p.group));
    head.appendChild(tw);
    card.appendChild(head);
    card.appendChild(ui.el('p', 'path-why', p.why || ''));

    var chain = ui.el('div', 'path-chain');
    (p.courses || []).forEach(function (c, i) {
      if (i) chain.appendChild(ui.el('span', 'chain-arrow', '→'));
      var item = ui.el('a', 'chain-item', c.title || c.slug);
      item.href = '#/course/' + c.slug;
      item.title = (c.lessons ? c.lessons + ' 课时' : '');
      chain.appendChild(item);
    });
    card.appendChild(chain);

    var done = 0, total = 0;
    (p.courses || []).forEach(function (c) {
      var pr = progressMap && progressMap[c.slug];
      if (pr) { done += pr.done; total += pr.total; }
      else total += c.lessons || 0;
    });
    if (!total) (p.courses || []).forEach(function (c) { total += c.lessons || 0; });
    var foot = ui.el('div', 'path-foot');
    foot.appendChild(ui.ring(done, total, { size: 'sm', title: '这条路径的完成度' }));
    var right = ui.el('div', 'small muted', done + ' / ' + total + ' 课时');
    foot.appendChild(right);
    var goal = (p.courses || [])[p.courses.length - 1];
    if (goal) {
      var go = ui.el('a', 'btn btn--sm btn--primary', '开始这条路径');
      go.href = '#/course/' + goal.slug;
      foot.appendChild(go);
    }
    card.appendChild(foot);
    return card;
  }

  /** 「继续学习」：上次学到哪 + 下一课 */
  function resumeBlock(st) {
    if (!st) return null;
    var last = LLM.store.lastVisited();
    var extra = [];
    if (last && last.id) {
      var m = st.lessons && st.lessons[last.id];
      if (m) extra.push(m);
    }
    return ui.ring ? LLM.store.nextLesson().then(function (next) {
      if (!next) return null;
      var box = ui.el('div', 'resume');
      var ring = ui.ring(st.doneLessons, st.totalLessons, { title: '总进度' });
      box.appendChild(ring);
      var main = ui.el('div', 'resume-main');
      main.appendChild(ui.el('b', null, last ? '继续学习：' + next.title : '从第一课开始：' + next.title));
      main.appendChild(ui.el('span', null, (next.course || next.courseTitle || '') + ' › ' + (next.chapterTitle || '')));
      box.appendChild(main);
      var btn = ui.el('a', 'btn btn--primary', last ? '继续' : '开始学习');
      btn.href = next.route;
      box.appendChild(btn);
      if (st.notes) {
        var me = ui.el('a', 'btn btn--ghost', '我的笔记（' + st.notes + '）');
        me.href = '#/me/notes';
        box.appendChild(me);
      }
      return box;
    }) : null;
  }

  views.home = {
    render: function (rootEl) {
      LLM.setTitle('');
      var box = ui.el('div');
      rootEl.appendChild(box);
      var progressP = (LLM.store && LLM.store.statsByCourse)
        ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
        : Promise.resolve({ courses: [] });
      var stops = [];
      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], courses = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        {
          var bySlug = {};
          courses.forEach(function (c) { bySlug[c.slug] = c; });

          /* ---------- hero ---------- */
          var hero = ui.el('section', 'hero');
          // 2026-10-09 用户指定：特效用在**标题本身**，不再做背景粒子文字
          var stopParticles = null;
          var inner = ui.el('div', 'hero-inner');
          var left = ui.el('div');
          left.appendChild(ui.el('span', 'hero-eyebrow', '9 条方向线 · 从零基础到能部署大模型'));
          var h1 = ui.el('h1');
          h1.innerHTML = '把大模型从<em>数学地基</em>学到<em>推理部署</em>';
          // 标题区做粒子背景：包一层容器，粒子场铺在里面、标题文字照常可读
          var titleWrap = ui.el('div', 'hero-title-wrap');
          titleWrap.appendChild(h1);
          left.appendChild(titleWrap);
          // 标题 = 粒子拼出的文字（成功后模块自己隐藏普通文字；关键字用琥珀色，与 <em> 对应）
          if (LLM.particles && LLM.particles.attachTitle) {
            stopParticles = LLM.particles.attachTitle(h1, {
              text: '把大模型从数学地基',
              sub: '学到推理部署',
              accent: ['数学地基', '推理部署'],
              mainPx: 54, subPx: 54, lineGap: 1.25,
              anchorX: 0.5, anchorY: 0.36,
              step: 1, maxParticles: 9000,
              radius: 34, push: 0.3, pull: 0.22
            });
          }
          left.appendChild(ui.el('p', 'hero-lead',
            site.counts.courses + ' 门课 · ' + site.counts.chapters + ' 章 · ' + site.counts.lessons +
            ' 个课时：每个概念都从「为什么需要」讲到「怎么算、怎么调、代价是什么」，' +
            '配 ' + fmt.num(site.counts.figures) + ' 张图表与 ' + fmt.num(site.counts.glossaryTerms) + ' 条关键词百科。'));
          var actions = ui.el('div', 'hero-actions');
          var a1 = ui.el('a', 'btn btn--primary btn--lg', '开始学习');
          a1.href = '#/paths';
          var a2 = ui.el('a', 'btn btn--lg', '浏览全部课程');
          a2.href = '#/courses';
          var a3 = ui.el('a', 'btn btn--lg', '关键词百科');
          a3.href = '#/glossary';
          actions.appendChild(a1); actions.appendChild(a2); actions.appendChild(a3);
          left.appendChild(actions);
          inner.appendChild(left);

          var right = ui.el('div');
          var stats = ui.el('div', 'hero-stats');
          [['lessons', '个课时'], ['courses', '门课程'], ['figures', '张图表'], ['minutes', '分钟内容']].forEach(function (pair) {
            var s = ui.el('div', 'hero-stat');
            var v = site.counts[pair[0]] || 0;
            s.appendChild(ui.el('b', null, pair[0] === 'minutes' ? Math.round(v / 60) + 'h' : fmt.num(v)));
            s.appendChild(ui.el('span', null, pair[0] === 'minutes' ? '预计学习时长' : pair[1]));
            stats.appendChild(s);
          });
          right.appendChild(stats);
          var covers = ui.el('div', 'hero-covers');
          ['attention-transformer', 'llm-inference-optimization', 'agent-systems', 'pytorch-fundamentals', 'multimodal-diffusion', 'distributed-training-systems']
            .forEach(function (slug) {
              if (!bySlug[slug] || !bySlug[slug].cover) return;
              var im = ui.el('img');
              im.src = bySlug[slug].cover;
              im.alt = bySlug[slug].title;
              im.loading = 'lazy';
              covers.appendChild(im);
            });
          right.appendChild(covers);
          inner.appendChild(right);
          hero.appendChild(inner);
          box.appendChild(hero);

          var wrap = ui.el('div', 'container');

          /* ---------- 继续学习 ---------- */
          var st = LLM.store && LLM.store.stats ? LLM.store.stats() : null;
          var resumePromise = resumeBlock(st);
          if (resumePromise) {
            resumePromise.then(function (node) {
              if (!node) return;
              var slot = ui.el('div', 'section');
              slot.appendChild(node);
              wrap.insertBefore(slot, wrap.firstChild);
            });
          }

          /* ---------- 学习路径 ---------- */
          var paths = site.paths || [];
          if (paths.length) {
            var sec = ui.el('section', 'section');
            var head = ui.el('div', 'section-head');
            var hl = ui.el('div');
            hl.appendChild(ui.el('h2', 'section-title', '学习路径：先想清楚「要达成什么」'));
            hl.appendChild(ui.el('p', 'section-sub', paths.length + ' 条目标路径，每条只写目标课，前置链按课程依赖自动展开；点进任一门课都能继续往下走。'));
            head.appendChild(hl);
            var more = ui.el('a', 'btn btn--ghost btn--sm', '看全部路径与岗位 →');
            more.href = '#/paths';
            head.appendChild(more);
            sec.appendChild(head);
            var pg = ui.el('div', 'paths-grid');
            paths.forEach(function (p) { pg.appendChild(pathCard(p, bySlug, pm)); });
            sec.appendChild(pg);
            wrap.appendChild(sec);
          }

          /* ---------- 推荐先看 ---------- */
          var picks = [];
          var pickSlugs = ['python-basics', 'linear-algebra', 'neural-networks', 'attention-transformer', 'rag-systems', 'distributed-inference'];
          pickSlugs.forEach(function (s) { if (bySlug[s]) picks.push(bySlug[s]); });
          if (picks.length) {
            var sec2 = ui.el('section', 'section');
            var h2 = ui.el('div', 'section-head');
            var l2 = ui.el('div');
            l2.appendChild(ui.el('h2', 'section-title', '不确定从哪开始？这条主线最稳'));
            l2.appendChild(ui.el('p', 'section-sub', '数学与编程地基 → 机器学习 → 深度学习 → Transformer → 应用 → 部署。'));
            h2.appendChild(l2);
            sec2.appendChild(h2);
            var g2 = ui.el('div', 'grid grid--cards');
            picks.forEach(function (c) { g2.appendChild(courseCard(c, { progress: pm[c.slug] })); });
            sec2.appendChild(g2);
            wrap.appendChild(sec2);
          }

          /* ---------- 课程地图（按大类 → 方向线） ---------- */
          var mapSec = ui.el('section', 'section course-map');   // ⚠️ 必须带 course-map 类，否则网格/卡片样式选择器不生效
          var mh = ui.el('div', 'section-head');
          var mhl = ui.el('div');
          mhl.appendChild(ui.el('h2', 'section-title', '课程地图'));
          mhl.appendChild(ui.el('p', 'section-sub', '6 个大类 / 9 条方向线 / ' + site.counts.courses + ' 门课。每门课的封面、难度、课时数与图表数一眼可见。'));
          mh.appendChild(mhl);
          var allBtn = ui.el('a', 'btn btn--ghost btn--sm', '进筛选页 →');
          allBtn.href = '#/courses';
          mh.appendChild(allBtn);
          mapSec.appendChild(mh);

          var byLine = {};
          courses.forEach(function (c) { (byLine[c.line] = byLine[c.line] || []).push(c); });
          (site.families || []).forEach(function (fam) {
            var famBox = ui.el('div');
            var ft = ui.el('div', 'family-title');
            ft.appendChild(ui.el('h2', null, fam.name));
            var famLessons = (fam.lines || []).reduce(function (n, ln) {
              return n + (byLine[ln] || []).reduce(function (m, c) { return m + c.counts.lessons; }, 0); }, 0);
            var famCourses = (fam.lines || []).reduce(function (n, ln) { return n + (byLine[ln] || []).length; }, 0);
            ft.appendChild(ui.el('span', 'line-kind', famCourses + ' 门课 · ' + famLessons + ' 课时'));
            famBox.appendChild(ft);
            (fam.lines || []).forEach(function (lineName) {
              var list = byLine[lineName] || [];
              if (!list.length) return;
              var lb = ui.el('div', 'line-block');
              var totalLessons = list.reduce(function (n, c) { return n + c.counts.lessons; }, 0);
              // 方向线名与大类名相同（多数如此）→ 不再重复一行标题，只把统计并进大类标题
              var oneLine = (fam.lines || []).length <= 1;
              if (!oneLine && lineName !== fam.name) {
                var lh = ui.el('div', 'line-head');
                lh.appendChild(ui.el('h3', null, lineName));
                lh.appendChild(ui.el('span', 'line-kind', list.length + ' 门课 · ' + totalLessons + ' 课时'));
                lb.appendChild(lh);
              }
              var g = ui.el('div', 'grid grid--wide');
              list.forEach(function (c) { g.appendChild(courseCard(c, { progress: pm[c.slug], medium: true })); });
              lb.appendChild(g);
              famBox.appendChild(lb);
            });
            mapSec.appendChild(famBox);
          });
          wrap.appendChild(mapSec);

          /* ---------- 特色入口 ---------- */
          var feat = ui.el('section', 'section');
          var fg = ui.el('div', 'grid card-grid-2');
          [{
            title: '关键词百科 · ' + fmt.num(site.counts.glossaryTerms) + ' 条',
            desc: '按大模型完整链路的 22 层编目：每个词条有定义、详解、工程提醒，并自动挂到讲它的那几节课上。',
            href: '#/glossary', btn: '打开百科',
          }, {
            title: '图表库 · ' + fmt.num(site.counts.figures) + ' 张',
            desc: '全站课程插图与流程图，可放大、可看原图，按课程与章节归类 —— 复习时直接翻图最快。',
            href: '#/figures', btn: '浏览图表',
          }].forEach(function (f) {
            var c = ui.el('div', 'card');
            var b = ui.el('div', 'card-body');
            b.appendChild(ui.el('h3', 'card-title', f.title));
            b.appendChild(ui.el('p', 'card-desc', f.desc));
            var a = ui.el('a', 'btn btn--primary btn--sm', f.btn);
            a.href = f.href;
            b.appendChild(a);
            c.appendChild(b);
            fg.appendChild(c);
          });
          feat.appendChild(fg);
          wrap.appendChild(feat);

          box.appendChild(wrap);

          return null;
        }
      }).catch(function (e) {
        ui.clear(rootEl);
        var msg = String(e && e.message || e);
        var isFile = /^file:/i.test(location.protocol);
        var is404 = /404/.test(msg);
        var why = isFile
          ? '你是用 <code>file://</code> 直接打开的：浏览器会拦截 <code>data/*.json</code> 的请求（CORS），必须走本地静态服务。'
          : (is404
            ? '请求 <code>data/site.json</code> 返回 404 —— 你打开的**多半是站点源码目录 <code>site/</code>**（它只有 <code>assets/</code>，<code>data/</code> 是构建产物）。请打开构建出来的 <code>site-dist/</code>。'
            : '数据请求失败：' + fmt.esc(msg));
        // 强制重载（带时间戳）：把浏览器缓存整个绕过去
        var retryUrl = location.origin + location.pathname + '?r=' + Date.now() + (location.hash || '#/');
        var c = ui.el('div', 'container container--narrow');
        c.innerHTML = '<div class="empty"><strong>站点数据加载失败</strong>' +
          '<p class="small mono" style="word-break:break-all">当前地址：' + fmt.esc(location.href) + '</p>' +
          '<p class="small mono" style="word-break:break-all">失败请求：' + fmt.esc(msg) + '</p>' +
          '<p class="small">' + why + '</p>' +
          '<p class="small muted" style="margin-top:14px">正确的本地预览方式（二选一）：</p>' +
          '<pre style="text-align:left;max-width:560px;margin:0 auto"><code>cd llm-learn\n' +
          '# ① 根路径（＝直接打开站点根）\npython3 -m http.server 4010 --directory site-dist\n' +
          '# ② 子路径（＝GitHub Pages 的真实形态）\nmkdir -p /tmp/pages && ln -sfn "$PWD/site-dist" /tmp/pages/llm-learn-site\npython3 -m http.server 4011 --directory /tmp/pages</code></pre>' +
          '<p class="small muted" style="margin-top:10px">打开：<code>http://127.0.0.1:4010/</code> 或 <code>http://127.0.0.1:4011/llm-learn-site/</code></p>' +
          '<p style="margin-top:14px">' +
          '<button class="btn btn--primary" id="hard-reload">强制重载（绕过缓存）</button> ' +
          '<a class="btn" href="#/">重试</a></p></div>';
        rootEl.appendChild(c);
        var hr = c.querySelector('#hard-reload');
        if (hr) hr.addEventListener('click', function () { location.replace(retryUrl); });
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-courses.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 全部课程（筛选 / 排序 / 进度）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  // 筛选状态放在模块里：切页面回来还在（不做 hash 同步，避免每敲一个字就重渲染）
  var state = { q: '', line: '', family: '', level: '', sort: 'default', onlyUndone: false };

  function matches(c) {
    if (state.q) {
      var hay = (c.title + ' ' + (c.description || '') + ' ' + (c.top_tags || []).join(' ') + ' ' + c.slug).toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
    }
    if (state.line && c.line !== state.line) return false;
    if (state.family && c.family !== state.family) return false;
    if (state.level && c.difficulty !== state.level) return false;
    return true;
  }

  views.courses = {
    render: function (rootEl, route) {
      LLM.setTitle('全部课程');
      if (route.query && route.query.q) state.q = route.query.q;
      if (route.query && route.query.line) state.line = route.query.line;

      var wrap = ui.el('div', 'container');
      var head = ui.el('div', 'page-head');
      head.appendChild(ui.el('h1', null, '全部课程'));
      head.appendChild(ui.el('p', null, '按方向线、大类与难度筛选。课程之间是「前置 → 进阶」的关系，可以直接从任意一门开始，卡住时用关键词百科回查。'));
      wrap.appendChild(head);
      rootEl.appendChild(wrap);

      var sk = ui.el('div', 'grid grid--cards');
      for (var k = 0; k < 6; k++) {
        var s = ui.el('div', 'card');
        s.appendChild(ui.el('div', 'card-cover skeleton'));
        var sb = ui.el('div', 'card-body');
        sb.appendChild(ui.el('div', 'skeleton', '　'));
        s.appendChild(sb);
        sk.appendChild(s);
      }
      wrap.appendChild(sk);

      var progressP = (LLM.store && LLM.store.statsByCourse)
        ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
        : Promise.resolve({ courses: [] });

      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], courses = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        ui.clear(wrap);

        /* ---------- 筛选条 ---------- */
        var filters = ui.el('div', 'filters');
        var fq = ui.el('div', 'field');
        var qInput = ui.el('input');
        qInput.type = 'search';
        qInput.placeholder = '搜课程名 / 简介 / 标签…';
        qInput.value = state.q;
        fq.appendChild(qInput);
        filters.appendChild(fq);

        var famSel = ui.el('select');
        [{ v: '', t: '全部大类' }].concat((site.families || []).map(function (f) { return { v: f.name, t: f.name }; }))
          .forEach(function (o) { var op = ui.el('option', null, o.t); op.value = o.v; famSel.appendChild(op); });
        famSel.value = state.family;
        filters.appendChild(famSel);

        var lvlSel = ui.el('select');
        ['全部难度', '入门', '进阶', '专家级'].forEach(function (t, i) {
          var op = ui.el('option', null, t); op.value = i ? t : ''; lvlSel.appendChild(op);
        });
        lvlSel.value = state.level;
        filters.appendChild(lvlSel);

        var sortSel = ui.el('select');
        [['default', '默认顺序'], ['lessons', '课时数多→少'], ['figures', '图表多→少'], ['progress', '我的进度高→低'], ['title', '名称']]
          .forEach(function (o) { var op = ui.el('option', null, o[1]); op.value = o[0]; sortSel.appendChild(op); });
        sortSel.value = state.sort;
        filters.appendChild(sortSel);

        var count = ui.el('span', 'filter-count', '');
        filters.appendChild(count);
        wrap.appendChild(filters);

        /* ---------- 方向线 chips ---------- */
        var chipBox = ui.el('div', 'chip-row');
        chipBox.style.margin = '14px 0 18px';
        function chip(label, value, current, onPick) {
          var c = ui.el('button', 'chip' + (current === value ? ' on' : ''), label);
          c.addEventListener('click', function () { onPick(value); paint(); });
          return c;
        }
        function paintChips() {
          ui.clear(chipBox);
          chipBox.appendChild(chip('全部方向线', '', state.line, function (v) { state.line = v; }));
          (site.lines || []).forEach(function (l) {
            chipBox.appendChild(chip(l.name, l.name, state.line, function (v) { state.line = v; }));
          });
          var undo = ui.el('button', 'chip' + (state.onlyUndone ? ' on' : ''), '只看没学完的');
          undo.addEventListener('click', function () { state.onlyUndone = !state.onlyUndone; paintChips(); paint(); });
          chipBox.appendChild(undo);
        }

        /* ---------- 结果网格 ---------- */
        var grid = ui.el('div', 'grid grid--cards');
        var emptyBox = ui.el('div');
        function paint() {
          var list = courses.filter(matches).filter(function (c) {
            if (!state.onlyUndone) return true;
            var p = pm[c.slug];
            return !p || p.done < p.total;
          });
          if (state.sort === 'lessons') list.sort(function (a, b) { return b.counts.lessons - a.counts.lessons; });
          else if (state.sort === 'figures') list.sort(function (a, b) { return b.counts.figures - a.counts.figures; });
          else if (state.sort === 'title') list.sort(function (a, b) { return a.title.localeCompare(b.title, 'zh-Hans-CN'); });
          else if (state.sort === 'progress') {
            list.sort(function (a, b) {
              var pa = pm[a.slug] ? pm[a.slug].pct : 0, pb = pm[b.slug] ? pm[b.slug].pct : 0;
              return pb - pa;
            });
          }
          count.textContent = list.length + ' / ' + courses.length + ' 门课';
          ui.clear(grid);
          ui.clear(emptyBox);
          if (!list.length) {
            emptyBox.innerHTML = '<div class="empty"><strong>没有匹配的课程</strong><p class="small">换个关键词，或点「全部方向线」重置筛选。</p></div>';
            return;
          }
          var frag = ui.frag();
          list.forEach(function (c) { frag.appendChild(views.courseCard(c, { progress: pm[c.slug] })); });
          grid.appendChild(frag);
        }

        qInput.addEventListener('input', ui.debounce(function () { state.q = qInput.value.trim(); paint(); }, 120));
        famSel.addEventListener('change', function () { state.family = famSel.value; paint(); });
        lvlSel.addEventListener('change', function () { state.level = lvlSel.value; paint(); });
        sortSel.addEventListener('change', function () { state.sort = sortSel.value; paint(); });

        paintChips();
        wrap.appendChild(chipBox);
        wrap.appendChild(grid);
        wrap.appendChild(emptyBox);
        paint();
        return null;
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-course.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 课程详情页
 * 一页看清：这门课解决什么问题 / 学完能做到什么 / 每一章每一课 / 我的进度
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  function lessonSlugOf(file) {
    return String(file || '').split('/').pop().replace(/\.md$/, '');
  }
  function routeOfLesson(course, chapter, lesson) {
    return '#/learn/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file);
  }

  /** 扁平课时序列（跨章），用于「继续学习」与上一课/下一课 */
  function flatLessons(course) {
    var out = [];
    course.chapters.forEach(function (ch) {
      ch.lessons.forEach(function (ls, i) {
        out.push({
          id: ls.id, title: ls.title, chapter: ch, lesson: ls,
          route: routeOfLesson(course, ch, ls),
          chapterSeq: i + 1, chapterTotal: ch.lessons.length,
        });
      });
    });
    return out;
  }
  views.flatLessons = flatLessons;
  views.routeOfLesson = routeOfLesson;
  views.lessonSlugOf = lessonSlugOf;

  views.course = {
    render: function (rootEl, route) {
      var slug = route.seg[1];
      var wrap = ui.el('div');
      rootEl.appendChild(wrap);
      var skeleton = ui.el('div', 'container');
      skeleton.innerHTML = '<div class="skeleton" style="height:34px;width:280px"></div>' +
        '<div class="skeleton" style="height:120px;margin-top:14px"></div>' +
        '<div class="skeleton" style="height:260px;margin-top:14px"></div>';
      wrap.appendChild(skeleton);

      return data.course(slug).then(function (course) {
        LLM.setTitle(course.title);
        var flat = flatLessons(course);
        var progressP = (LLM.store && LLM.store.statsByCourse)
          ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
          : Promise.resolve({ courses: [] });
        return progressP.then(function (st) {
          var mine = null;
          (st.courses || []).forEach(function (c) { if (c.slug === slug) mine = c; });
          var doneMap = {};
          flat.forEach(function (f) {
            doneMap[f.id] = LLM.store && LLM.store.isDone ? LLM.store.isDone(f.id) : false;
          });
          var done = flat.filter(function (f) { return doneMap[f.id]; }).length;

          ui.clear(wrap);

          /* ---------- hero ---------- */
          var hero = ui.el('section', 'course-hero');
          // 背景用 **无文字版封面**（`_plain.svg`）：带标题的封面当背景会透出巨字压住 H1
          var bgSrc = course.coverPlain || course.cover;
          if (bgSrc) {
            var bg = ui.el('div', 'course-hero-bg');
            bg.style.backgroundImage = 'url("' + bgSrc + '")';
            hero.appendChild(bg);
          }
          var inner = ui.el('div', 'course-hero-inner');
          var left = ui.el('div');
          var crumb = ui.el('div', 'course-crumb');
          var home = ui.el('a', null, '首页'); home.href = '#/';
          var all = ui.el('a', null, '全部课程'); all.href = '#/courses';
          crumb.appendChild(home);
          crumb.appendChild(ui.el('span', null, '›'));
          crumb.appendChild(all);
          if (course.family) {
            crumb.appendChild(ui.el('span', null, '›'));
            crumb.appendChild(ui.el('span', null, course.family));
          }
          left.appendChild(crumb);
          left.appendChild(ui.el('h1', 'course-h1', course.title));
          left.appendChild(ui.el('p', 'course-lead', course.description || ''));
          // 前置课程（由课时级前置推导）：系统学习的关键提示
          if ((course.prereqCourses || []).length) {
            var preBox = ui.el('div', 'course-prereq');
            preBox.appendChild(ui.el('span', 'prereq-label', '建议先学'));
            course.prereqCourses.forEach(function (p) {
              var a = ui.el('a', 'chip', p.title);
              a.href = '#/course/' + p.slug;
              a.title = '有 ' + p.hits + ' 处前置依赖指向这门课';
              preBox.appendChild(a);
            });
            left.appendChild(preBox);
          }

          var badges = ui.el('div', 'row row--wrap');
          if (course.difficulty) badges.appendChild(ui.el('span', 'badge badge--level', course.difficulty));
          if (course.line) badges.appendChild(ui.el('span', 'badge badge--line', course.line));
          badges.appendChild(ui.el('span', 'badge', course.counts.chapters + ' 章'));
          badges.appendChild(ui.el('span', 'badge', course.counts.lessons + ' 课时'));
          badges.appendChild(ui.el('span', 'badge', course.counts.figures + ' 图'));
          badges.appendChild(ui.el('span', 'badge', fmt.minutes(course.counts.minutes)));
          (course.top_tags || []).forEach(function (t) { badges.appendChild(ui.el('span', 'tag', t)); });
          left.appendChild(badges);

          var actions = ui.el('div', 'row row--wrap');
          actions.style.marginTop = '18px';
          var next = flat.filter(function (f) { return !doneMap[f.id]; })[0] || flat[0];
          var go = ui.el('a', 'btn btn--primary', done ? '继续学习' : '开始学习');
          go.href = next ? next.route : '#/courses';
          actions.appendChild(go);
          if (done) {
            var first = ui.el('a', 'btn btn--ghost', '从第一课重看');
            first.href = flat.length ? flat[0].route : '#/courses';
            actions.appendChild(first);
          }
          var figs = ui.el('a', 'btn btn--ghost', '本课图表（' + course.counts.figures + '）');
          figs.href = '#/figures/' + course.slug;
          actions.appendChild(figs);
          var copy = ui.el('button', 'btn btn--ghost btn--sm', '复制链接');
          copy.addEventListener('click', function () {
            var url = location.href;
            (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
              .then(function () { ui.toast('课程链接已复制', 'ok'); })
              .catch(function () { ui.toast('复制失败，请手动复制地址栏', 'warn'); });
          });
          actions.appendChild(copy);
          left.appendChild(actions);
          inner.appendChild(left);

          var right = ui.el('div', 'course-side');
          if (course.cover) {
            var coverCard = ui.el('div', 'course-cover-card');
            var im = ui.el('img');
            im.src = course.cover;
            im.alt = course.title + ' 封面';
            im.loading = 'lazy';
            coverCard.appendChild(im);
            right.appendChild(coverCard);
          }
          var pb = ui.el('div', 'side-box');
          var ph = ui.el('div', 'spread');
          ph.appendChild(ui.ring(done, flat.length, { title: '本课进度' }));
          var ptext = ui.el('div');
          ptext.style.textAlign = 'right';
          ptext.appendChild(ui.el('div', 'small muted', '已完成'));
          ptext.appendChild(ui.el('div', null, done + ' / ' + flat.length + ' 课时'));
          ph.appendChild(ptext);
          pb.appendChild(ph);
          pb.appendChild(ui.el('div', 'bar bar--ok')).appendChild(ui.el('i'));
          var barEl = pb.querySelector('.bar > i');
          if (barEl) barEl.style.width = fmt.pct(done, flat.length) + '%';
          pb.appendChild(ui.el('h4', null, '学习统计'));
          [['章节', course.counts.chapters + ' 章'], ['课时', course.counts.lessons + ' 课时'],
           ['预计时长', fmt.minutes(course.counts.minutes)], ['图表', course.counts.figures + ' 张'],
           ['公式', flat.filter(function (f) { return f.lesson.math; }).length + ' 课含公式']].forEach(function (kv) {
            var row = ui.el('div', 'kv');
            row.appendChild(ui.el('span', 'muted', kv[0]));
            row.appendChild(ui.el('b', null, kv[1]));
            pb.appendChild(row);
          });
          right.appendChild(pb);
          inner.appendChild(right);
          hero.appendChild(inner);
          wrap.appendChild(hero);

          var body = ui.el('div', 'container');

          /* ---------- 学完能做到 ---------- */
          if ((course.grants || []).length) {
            var gsec = ui.el('section', 'section');
            gsec.appendChild(ui.el('h2', 'section-title', '学完这门课，你应该能做到'));
            var ul = ui.el('ul', 'grants');
            course.grants.forEach(function (g) { ul.appendChild(ui.el('li', null, g)); });
            gsec.appendChild(ul);
            body.appendChild(gsec);
          }

          /* ---------- 章节与课时 ---------- */
          var csec = ui.el('section', 'section');
          var ch = ui.el('div', 'section-head');
          var chl = ui.el('div');
          chl.appendChild(ui.el('h2', 'section-title', '章节目录'));
          chl.appendChild(ui.el('p', 'section-sub', '点任意课时开始；左侧（手机上是抽屉）会跟着你所在的课程走。'));
          ch.appendChild(chl);
          var expand = ui.el('button', 'btn btn--ghost btn--sm', '展开全部');
          ch.appendChild(expand);
          csec.appendChild(ch);

          var acc = ui.el('div', 'chapter-acc');
          var openState = {};
          course.chapters.forEach(function (chapter, ci) {
            var hasNext = chapter.lessons.some(function (ls) { return flat.filter(function (f) { return !doneMap[f.id]; })[0] &&
              flat.filter(function (f) { return !doneMap[f.id]; })[0].id === ls.id; });
            openState[chapter.slug] = ci === 0 || hasNext;
            var boxCh = ui.el('div', 'chapter' + (openState[chapter.slug] ? ' open' : ''));
            var head = ui.el('div', 'chapter-head');
            head.appendChild(ui.el('div', 'chapter-idx', String(ci + 1)));
            head.appendChild(ui.el('div', 'chapter-title', chapter.title));
            var cdone = chapter.lessons.filter(function (ls) { return doneMap[ls.id]; }).length;
            head.appendChild(ui.el('div', 'chapter-meta',
              cdone + ' / ' + chapter.lessons.length + ' 完成 · ' +
              fmt.minutes(chapter.lessons.reduce(function (n, ls) { return n + ls.minutes; }, 0))));
            head.appendChild(ui.el('div', 'chapter-caret', '›'));
            head.addEventListener('click', function () { boxCh.classList.toggle('open'); });
            boxCh.appendChild(head);

            var cbody = ui.el('div', 'chapter-body');
            chapter.lessons.forEach(function (ls, li) {
              var isDone = !!doneMap[ls.id];
              var row = ui.el('a', 'lesson-row' + (isDone ? ' done' : ''));
              row.href = routeOfLesson(course, chapter, ls);
              row.appendChild(ui.el('span', 'lesson-tick', '✓'));
              var main = ui.el('div', 'lr-main');
              main.appendChild(ui.el('div', 'lr-title', ls.order + '. ' + ls.title));
              var meta = ui.el('div', 'lr-meta');
              meta.appendChild(ui.el('span', null, fmt.minutes(ls.minutes)));
              if (ls.figures) meta.appendChild(ui.el('span', null, ls.figures + ' 图'));
              if (ls.math) meta.appendChild(ui.el('span', null, '公式'));
              if (ls.difficulty) meta.appendChild(ui.el('span', null, ls.difficulty));
              if (LLM.store && LLM.store.note && LLM.store.note(ls.id)) meta.appendChild(ui.el('span', 'badge badge--warn', '有笔记'));
              main.appendChild(meta);
              row.appendChild(main);
              cbody.appendChild(row);
            });
            boxCh.appendChild(cbody);
            acc.appendChild(boxCh);
          });
          csec.appendChild(acc);
          expand.addEventListener('click', function () {
            var anyClosed = ui.$$('.chapter', acc).some(function (n) { return !n.classList.contains('open'); });
            ui.$$('.chapter', acc).forEach(function (n) { n.classList.toggle('open', anyClosed); });
            expand.textContent = anyClosed ? '收起全部' : '展开全部';
          });
          body.appendChild(csec);

          /* ---------- 接下来 / 相关课程 ---------- */
          var rel = [];
          (course.alsoTry || []).forEach(function (s) { rel.push(s); });
          var rsec = ui.el('section', 'section');
          var rh = ui.el('div');
          rh.appendChild(ui.el('h2', 'section-title', '学完之后'));
          if (course.nextHint) rh.appendChild(ui.el('p', 'section-sub', course.nextHint));
          rsec.appendChild(rh);
          if (rel.length) {
            return data.courses().then(function (cards) {
              var bySlug = {};
              cards.forEach(function (c) { bySlug[c.slug] = c; });
              var g = ui.el('div', 'grid grid--cards');
              rel.forEach(function (s) { if (bySlug[s]) g.appendChild(views.courseCard(bySlug[s])); });
              rsec.appendChild(g);
              body.appendChild(rsec);
              wrap.appendChild(body);
              return null;
            });
          }
          body.appendChild(rsec);
          wrap.appendChild(body);
          return null;
        });
      }).catch(function (e) {
        ui.clear(wrap);
        var c = ui.el('div', 'container');
        c.innerHTML = '<div class="empty"><strong>找不到这门课</strong><p class="small">' + fmt.esc(e.message) +
          '</p><p><a class="btn btn--primary" href="#/courses">回全部课程</a></p></div>';
        wrap.appendChild(c);
        return null;
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-lesson.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 课时页（学习主场景）
 * 左：本课章节目录（含完成勾）  中：正文（公式/代码/图片灯箱）  右：本页目录
 * 底部：上一课 / 下一课 / 标记完成；笔记抽屉（本地保存）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  var FONT_STEPS = [0.94, 1, 1.08, 1.18, 1.3];

  function lessonSlugOf(file) { return String(file || '').split('/').pop().replace(/\.md$/, ''); }
  function routeOf(course, chapter, lesson) {
    return '#/learn/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file);
  }
  function fileOf(course, chapter, lesson) {
    return 'content/courses/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file) + '.md';
  }

  /** 链接解析器：与构建期同一份实现（assets/render.js），保证两边 href 完全一致 */
  function makeLinkResolver(lessonIndex) {
    return LLM.render.linkResolver(lessonIndex);
  }

  views.lesson = {
    render: function (rootEl, route) {
      var wrap = ui.el('div');
      rootEl.appendChild(wrap);
      wrap.innerHTML = '<div class="container"><div class="skeleton" style="height:300px"></div></div>';

      // #/l/<lessonId> → 解析成规范路由（保证 URL 可分享、上下课导航一致）
      if (route.name === 'lessonById') {
        var id = route.seg[1];
        return data.lessons().then(function (idx) {
          var m = idx[id];
          if (!m) {
            ui.clear(wrap);
            wrap.innerHTML = '<div class="container"><div class="empty"><strong>没有这个课时</strong>' +
              '<p class="small">id：' + fmt.esc(id) + '</p><p><a class="btn btn--primary" href="#/courses">回全部课程</a></p></div></div>';
            return null;
          }
          location.replace('#/learn/' + m.c + '/' + m.ch + '/' + m.l);
          return null;
        });
      }

      var slug = route.seg[1], chapterSlug = route.seg[2], lessonSlug = route.seg[3];
      var state = { fontScale: 1, drawer: null, cleanupFns: [] };

      return Promise.all([data.course(slug), data.lessons()]).then(function (res) {
        var course = res[0], lessonIndex = res[1];
        var chapter = null, lesson = null;
        course.chapters.forEach(function (ch) {
          if (ch.slug === chapterSlug) {
            chapter = ch;
            ch.lessons.forEach(function (ls) { if (lessonSlugOf(ls.file) === lessonSlug) lesson = ls; });
          }
        });
        if (!chapter || !lesson) throw new Error('这门课里没有 ' + chapterSlug + '/' + lessonSlug);

        // 扁平序列（上一课 / 下一课 / 位置）
        var flat = [];
        course.chapters.forEach(function (ch) {
          ch.lessons.forEach(function (ls, i) {
            flat.push({ id: ls.id, title: ls.title, chapter: ch, lesson: ls, route: routeOf(course, ch, ls),
              chapterSeq: i + 1, chapterTotal: ch.lessons.length, math: ls.math, figures: ls.figures, minutes: ls.minutes });
          });
        });
        var pos = -1;
        flat.forEach(function (f, i) { if (f.id === lesson.id) pos = i; });
        var prev = pos > 0 ? flat[pos - 1] : null;
        var next = pos >= 0 && pos < flat.length - 1 ? flat[pos + 1] : null;

        if (LLM.store && LLM.store.setLastVisited) LLM.store.setLastVisited(lesson.id);
        if (LLM.store && LLM.store.settings) {
          var s = LLM.store.settings();
          state.fontScale = s && s.fontScale ? s.fontScale : 1;
        }

        ui.clear(wrap);
        var layout = ui.el('div', 'learn-layout');
        wrap.appendChild(layout);

        /* ---------- 左侧：本课目录 ---------- */
        var side = ui.el('aside', 'learn-side');
        var sideBack = ui.el('a', 'side-course', course.title);
        sideBack.href = '#/course/' + course.slug;
        side.appendChild(sideBack);
        side.appendChild(ui.el('div', 'side-sub', course.counts.chapters + ' 章 · ' + course.counts.lessons + ' 课时 · ' + fmt.minutes(course.counts.minutes)));
        var progBox = ui.el('div', 'side-progress');
        side.appendChild(progBox);
        var chaptersBox = ui.el('div');
        side.appendChild(chaptersBox);

        function doneCount() {
          return flat.filter(function (f) { return LLM.store && LLM.store.isDone && LLM.store.isDone(f.id); }).length;
        }
        function paintSide() {
          var d = doneCount();
          ui.clear(progBox);
          var row = ui.el('div', 'row');
          row.appendChild(ui.ring(d, flat.length, { size: 'sm' }));
          var t = ui.el('div', 'small muted', d + ' / ' + flat.length + ' 完成');
          row.appendChild(t);
          progBox.appendChild(row);
          progBox.appendChild(ui.el('div', 'small muted', '已学 ' + fmt.minutes(flat.filter(function (f) {
            return LLM.store && LLM.store.isDone && LLM.store.isDone(f.id);
          }).reduce(function (n, f) { return n + (f.minutes || 0); }, 0))));
        }
        function paintChapters() {
          ui.clear(chaptersBox);
          course.chapters.forEach(function (ch, ci) {
            var isCur = ch.slug === chapterSlug;
            var box = ui.el('div', 'side-chapter' + (isCur ? ' open' : ''));
            var head = ui.el('div', 'side-chapter-title');
            head.appendChild(ui.el('span', 'chapter-idx', String(ci + 1)));
            head.appendChild(ui.el('span', null, fmt.clamp(ch.title, 18)));
            var chDone = ch.lessons.filter(function (ls) { return LLM.store && LLM.store.isDone && LLM.store.isDone(ls.id); }).length;
            head.appendChild(ui.el('span', 'muted tiny', chDone + '/' + ch.lessons.length));
            head.addEventListener('click', function () { box.classList.toggle('open'); });
            box.appendChild(head);
            var list = ui.el('div', 'side-lessons');
            ch.lessons.forEach(function (ls) {
              var isDone = LLM.store && LLM.store.isDone && LLM.store.isDone(ls.id);
              var a = ui.el('a', 'side-lesson' + (isDone ? ' done' : '') + (ls.id === lesson.id ? ' active' : ''));
              a.href = routeOf(course, ch, ls);
              a.appendChild(ui.el('span', 'sl-dot', '✓'));
              a.appendChild(ui.el('span', null, ls.title));
              list.appendChild(a);
            });
            box.appendChild(list);
            chaptersBox.appendChild(box);
          });
        }
        paintSide();
        paintChapters();
        layout.appendChild(side);

        /* ---------- 中间：正文 ---------- */
        var main = ui.el('div', 'learn-main');

        var mobileBar = ui.el('div', 'lesson-mobilebar');
        var btnSide = ui.el('button', 'icon-btn', '☰');
        btnSide.title = '本课目录';
        var sideBackdrop = null;
        function closeSide() {
          side.classList.remove('open');
          if (sideBackdrop) { sideBackdrop.remove(); sideBackdrop = null; }
          document.body.classList.remove('no-scroll');
        }
        function toggleSide() {
          if (side.classList.contains('open')) { closeSide(); return; }
          side.classList.add('open');
          // 手机上抽屉是浮层：必须有遮罩 + 锁滚动，否则手指会滑到背后的正文（也会让点击目标漂移）
          sideBackdrop = ui.el('div', 'drawer-backdrop');
          sideBackdrop.addEventListener('click', closeSide);
          document.body.appendChild(sideBackdrop);
          document.body.classList.add('no-scroll');
        }
        btnSide.addEventListener('click', toggleSide);
        // 点了某一课就收起抽屉（移动端）
        ui.on(side, 'click', '.side-lesson', function () { closeSide(); });
        mobileBar.appendChild(btnSide);
        mobileBar.appendChild(ui.el('div', 'mb-title', lesson.title));
        var btnDoneM = ui.el('button', 'btn btn--sm', LLM.store && LLM.store.isDone(lesson.id) ? '已完成' : '标记完成');
        mobileBar.appendChild(btnDoneM);
        main.appendChild(mobileBar);

        var head = ui.el('div', 'lesson-head');
        var crumb = ui.el('div', 'crumb');
        var c1 = ui.el('a', null, course.title); c1.href = '#/course/' + course.slug;
        crumb.appendChild(c1);
        crumb.appendChild(ui.el('span', null, '›'));
        crumb.appendChild(ui.el('span', null, '第 ' + (course.chapters.indexOf(chapter) + 1) + ' 章 · ' + chapter.title));
        head.appendChild(crumb);
        head.appendChild(ui.el('h1', 'lesson-h1', lesson.title));
        var meta = ui.el('div', 'lesson-metabar');
        meta.appendChild(ui.el('span', null, fmt.lessonPos(lesson.order, flat.length, flat[pos] ? flat[pos].chapterSeq : 0, flat[pos] ? flat[pos].chapterTotal : 0)));
        meta.appendChild(ui.el('span', null, '·'));
        meta.appendChild(ui.el('span', null, fmt.minutes(lesson.minutes)));
        if (lesson.figures) { meta.appendChild(ui.el('span', null, '·')); meta.appendChild(ui.el('span', null, lesson.figures + ' 张图')); }
        if (lesson.math) { meta.appendChild(ui.el('span', null, '·')); meta.appendChild(ui.el('span', null, '含公式')); }
        if (lesson.difficulty) meta.appendChild(ui.el('span', 'badge badge--level', lesson.difficulty));
        (lesson.tags || []).slice(0, 3).forEach(function (t) { meta.appendChild(ui.el('span', 'tag', t)); });
        head.appendChild(meta);

        // 前置课时：这门课/这条学习路径的「该先学什么」，系统学习的入口
        if ((lesson.prerequisites || []).length) {
          var pre = ui.el('div', 'prereq');
          pre.appendChild(ui.el('span', 'prereq-label', '前置课时'));
          (lesson.prerequisites || []).forEach(function (pid) {
            var m = lessonIndex[pid];
            var a = ui.el('a', 'chip', m ? m.t : pid);
            a.href = '#/l/' + pid;
            a.title = m ? (m.ct + ' · ' + m.t) : pid;
            if (m) a.textContent = fmt.clamp(m.t, 26);
            pre.appendChild(a);
          });
          head.appendChild(pre);
        }
        main.appendChild(head);

        var article = ui.el('article', 'article');
        article.style.fontSize = (16 * state.fontScale).toFixed(2) + 'px';
        main.appendChild(article);
        article.innerHTML = '<div class="skeleton" style="height:220px"></div>';

        /* ---------- 右侧：本页目录 ---------- */
        var tocBox = ui.el('nav', 'toc');
        tocBox.appendChild(ui.el('div', 'toc-title', '本页目录'));
        var tocList = ui.el('div');
        tocBox.appendChild(tocList);

        /* ---------- 课时尾部 ---------- */
        var foot = ui.el('div', 'lesson-foot');
        var nav = ui.el('div', 'lesson-nav');
        if (prev) {
          var pb = ui.el('a', 'btn btn--ghost', '← ' + fmt.clamp(prev.title, 22));
          pb.href = prev.route; pb.title = prev.title;
          nav.appendChild(pb);
        } else nav.appendChild(ui.el('span'));
        if (next) {
          var nb = ui.el('a', 'btn btn--primary', fmt.clamp(next.title, 22) + ' →');
          nb.href = next.route; nb.title = next.title;
          nav.appendChild(nb);
        } else {
          var fin = ui.el('a', 'btn btn--primary', '这门课学完了 → 回课程页');
          fin.href = '#/course/' + course.slug;
          nav.appendChild(fin);
        }
        foot.appendChild(nav);

        // 本课关键词（构建期从「词条 → 课时」指针反转而来）：读完这一课顺手回查概念
        data.lessonTerms().then(function (map) {
          var terms = map[lesson.id] || [];
          if (!terms.length) return;
          var box = ui.el('div', 'keyterms');
          var kh = ui.el('div', 'section-sub');
          kh.textContent = '本课关键词（' + terms.length + ' 个，点击查百科）';
          box.appendChild(kh);
          var row = ui.el('div', 'chip-row');
          terms.forEach(function (t) {
            var a = ui.el('a', 'chip', t.zh);
            a.href = '#/glossary/t/' + t.k;
            a.title = t.layerName + ' · ' + t.zh;
            row.appendChild(a);
          });
          box.appendChild(row);
          foot.insertBefore(box, nav.nextSibling);
        }).catch(function () { /* 关键词索引没有也能读 */ });

        main.appendChild(foot);
        layout.appendChild(main);      // 正文（第 2 列，最宽）
        layout.appendChild(tocBox);    // 本页目录（第 3 列）—— 顺序不能颠倒，grid 按 DOM 顺序落列

        /* ---------- 操作按钮（正文上方 + 底部） ---------- */
        var actions = ui.el('div', 'lesson-actions');
        var btnDone = ui.el('button', 'btn btn--sm' + (LLM.store && LLM.store.isDone(lesson.id) ? ' btn--primary' : ''));
        function paintDone() {
          var d = LLM.store && LLM.store.isDone(lesson.id);
          btnDone.textContent = d ? '✓ 已完成（点击取消）' : '标记为已完成';
          btnDone.className = 'btn btn--sm' + (d ? ' btn--primary' : '');
          btnDoneM.textContent = d ? '已完成' : '标记完成';
        }
        btnDone.addEventListener('click', function () {
          if (LLM.store && LLM.store.toggleDone) {
            var now = LLM.store.toggleDone(lesson.id);
            paintDone(); paintSide(); paintChapters();
            ui.toast(now ? '已标记完成 ✓' : '已取消完成标记', now ? 'ok' : null, 1400);
          }
        });
        btnDoneM.addEventListener('click', function () { btnDone.click(); });
        paintDone();
        actions.appendChild(btnDone);

        var btnNote = ui.el('button', 'btn btn--sm', '✎ 记笔记');
        btnNote.addEventListener('click', function () { openDrawer(); });
        actions.appendChild(btnNote);

        var btnBook = ui.el('button', 'btn btn--sm', LLM.store && LLM.store.isBookmarked && LLM.store.isBookmarked(lesson.id) ? '★ 已收藏' : '☆ 收藏');
        btnBook.addEventListener('click', function () {
          if (!LLM.store || !LLM.store.toggleBookmark) return;
          var on = LLM.store.toggleBookmark(lesson.id);
          btnBook.textContent = on ? '★ 已收藏' : '☆ 收藏';
          ui.toast(on ? '已加入收藏' : '已取消收藏', null, 1200);
        });
        actions.appendChild(btnBook);

        var fontBtn = ui.el('button', 'btn btn--sm', 'A± 字号');
        fontBtn.title = '调整正文字号（会记住）';
        fontBtn.addEventListener('click', function () {
          var i = FONT_STEPS.indexOf(state.fontScale);
          i = (i + 1) % FONT_STEPS.length;
          state.fontScale = FONT_STEPS[i];
          article.style.fontSize = (16 * state.fontScale).toFixed(2) + 'px';
          if (LLM.store && LLM.store.setSetting) LLM.store.setSetting('fontScale', state.fontScale);
          ui.toast('字号 ' + Math.round(state.fontScale * 100) + '%', null, 1000);
        });
        actions.appendChild(fontBtn);

        var copyBtn = ui.el('button', 'btn btn--sm', '复制本课链接');
        copyBtn.addEventListener('click', function () {
          (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject())
            .then(function () { ui.toast('链接已复制', 'ok'); })
            .catch(function () { ui.toast('复制失败，请手动复制地址栏', 'warn'); });
        });
        actions.appendChild(copyBtn);

        head.appendChild(actions);

        /* ---------- 笔记抽屉 ---------- */
        var drawer = null, backdrop = null, noteArea = null, noteStatus = null, previewBox = null;
        function noteSupported() { return !!(LLM.store && LLM.store.setNote); }
        function openDrawer() {
          if (!noteSupported()) { ui.toast('笔记模块没加载出来（store.js）', 'err'); return; }
          if (drawer) { drawer.classList.add('open'); noteArea && noteArea.focus(); return; }
          backdrop = ui.el('div', 'drawer-backdrop');
          backdrop.addEventListener('click', closeDrawer);
          drawer = ui.el('div', 'notes-drawer open');
          var dh = ui.el('div', 'notes-head');
          dh.appendChild(ui.el('b', null, '✎ 本课笔记'));
          var hint = ui.el('span', 'note-hint', '自动保存到本机');
          dh.appendChild(hint);
          var spacer = ui.el('div'); spacer.style.flex = '1'; dh.appendChild(spacer);
          var close = ui.el('button', 'icon-btn', '✕');
          close.addEventListener('click', closeDrawer);
          dh.appendChild(close);
          drawer.appendChild(dh);

          var dbody = ui.el('div', 'notes-body');
          var existing = LLM.store && LLM.store.note ? LLM.store.note(lesson.id) : null;
          noteArea = ui.el('textarea', 'notes-editor');
          noteArea.placeholder = '写下你的理解、疑问、踩坑记录…（支持 Markdown，公式用 $...$）\n\n例：\n- 这里的 σ 指每元素字节数\n- 与第 3 章的 $2L\\cdot 2\\frac{N-1}{N}bh$ 对照';
          noteArea.value = existing ? existing.text : '';
          dbody.appendChild(noteArea);

          var btns = ui.el('div', 'io-actions');
          var save = ui.el('button', 'btn btn--primary btn--sm', '保存');
          save.addEventListener('click', function () {
            LLM.store.setNote(lesson.id, noteArea.value);
            noteStatus.textContent = '已保存 · ' + fmt.rel(Date.now());
            ui.toast('笔记已保存（本机）', 'ok', 1300);
            refreshNoteFlags();
          });
          var prevBtn = ui.el('button', 'btn btn--sm', '预览');
          prevBtn.addEventListener('click', function () {
            previewBox.innerHTML = '<div class="article">' + ui.md(noteArea.value, { file: fileOf(course, chapter, lesson) }) + '</div>';
            previewBox.classList.toggle('hidden');
          });
          var del = ui.el('button', 'btn btn--sm btn--danger', '删除');
          del.addEventListener('click', function () {
            ui.confirm('删除这条笔记？', '删除后无法恢复。', '删除').then(function (ok) {
              if (!ok) return;
              LLM.store.deleteNote(lesson.id);
              noteArea.value = '';
              noteStatus.textContent = '已删除';
              ui.toast('笔记已删除', null, 1200);
              refreshNoteFlags();
            });
          });
          btns.appendChild(save); btns.appendChild(prevBtn); btns.appendChild(del);
          dbody.appendChild(btns);
          noteStatus = ui.el('div', 'note-hint', existing ? '上次修改：' + fmt.rel(existing.updatedAt) : '还没有笔记');
          dbody.appendChild(noteStatus);
          previewBox = ui.el('div', 'notes-preview hidden');
          dbody.appendChild(previewBox);
          drawer.appendChild(dbody);

          var autosave = ui.debounce(function () {
            LLM.store.setNote(lesson.id, noteArea.value);
            noteStatus.textContent = '已自动保存 · ' + fmt.rel(Date.now());
            refreshNoteFlags();
          }, 900);
          noteArea.addEventListener('input', autosave);
          noteArea.addEventListener('keydown', function (e) {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
          });

          document.body.appendChild(backdrop);
          document.body.appendChild(drawer);
          noteArea.focus();
        }
        function closeDrawer() {
          if (drawer) drawer.classList.remove('open');
          if (backdrop) backdrop.remove();
        }
        state.closeDrawer = closeDrawer;

        function refreshNoteFlags() {
          // 目录上的「有笔记」标记 + 「我的学习」数字都靠事件刷新
          LLM.emit('progress');
        }

        /* ---------- 载入正文：构建期已渲染好的 HTML 片段（站点里不存在 .md 源文件） ---------- */
        var bodyPath = 'data/lesson/' + lesson.id + '.html';
        return fetch(bodyPath, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('正文加载失败：' + bodyPath + '（HTTP ' + r.status + '）');
          return r.text();
        }).then(function (html) {
          article.innerHTML = html;
          ui.enhance(article);

          // 本页目录 + 滚动高亮
          var heads = ui.toc(article);
          if (!heads.length) tocBox.classList.add('hidden');
          heads.forEach(function (h) {
            var a = ui.el('a', 'toc-link lv' + h.level, fmt.clamp(h.text, 26));
            a.href = '#' + h.id;
            a.addEventListener('click', function (e) {
              e.preventDefault();
              var target = article.querySelector('#' + CSS.escape(h.id));
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            tocList.appendChild(a);
          });
          var links = ui.$$('.toc-link', tocList);
          var spy = [];
          heads.forEach(function (h, i) {
            var node = article.querySelector('#' + CSS.escape(h.id));
            if (node) spy.push({ node: node, link: links[i] });
          });
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              if (!en.isIntersecting) return;
              var hit = spy.filter(function (s) { return s.node === en.target; })[0];
              if (!hit) return;
              links.forEach(function (l) { l.classList.remove('active'); });
              hit.link.classList.add('active');
            });
          }, { rootMargin: '-70px 0px -70% 0px', threshold: 0 });
          spy.forEach(function (s) { io.observe(s.node); });
          state.cleanupFns.push(function () { io.disconnect(); });

          // 回到顶部：正文常有一万多字，手机上尤其需要（滚动超过 700px 才出现）
          var toTop = ui.el('button', 'to-top', '↑');
          toTop.title = '回到顶部';
          toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
          document.body.appendChild(toTop);
          var onScroll = function () { toTop.classList.toggle('show', window.scrollY > 700); };
          window.addEventListener('scroll', onScroll, { passive: true });
          onScroll();
          state.cleanupFns.push(function () { window.removeEventListener('scroll', onScroll); toTop.remove(); });

          // 选中正文 → 浮出「摘录到笔记」：读长文时最常用的动作，直接落到本课笔记里
          var pop = null;
          function hidePop() { if (pop) { pop.remove(); pop = null; } }
          function showPop(excerpt, rect) {
            hidePop();
            pop = ui.el('button', 'excerpt-btn', '✎ 摘录到笔记');
            pop.style.top = Math.max(8, rect.top - 42 + window.scrollY) + 'px';
            pop.style.left = Math.min(window.innerWidth - 150, Math.max(12, rect.left + rect.width / 2 - 70)) + 'px';
            pop.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 别把选区弄丢
            pop.addEventListener('click', function () {
              hidePop();
              openDrawer();
              var cur = noteArea.value ? noteArea.value.replace(/\s*$/, '') + '\n\n' : '';
              noteArea.value = cur + '> 摘录：' + excerpt.replace(/\n+/g, ' ') + '\n';
              LLM.store.setNote(lesson.id, noteArea.value);
              if (noteStatus) noteStatus.textContent = '已摘录 · ' + fmt.rel(Date.now());
              ui.toast('已摘录到本课笔记', 'ok', 1500);
              refreshNoteFlags();
              noteArea.focus();
            });
            document.body.appendChild(pop);
          }
          function onSelect() {
            var sel = root.getSelection ? root.getSelection() : null;
            if (!sel || sel.isCollapsed || !sel.rangeCount) { hidePop(); return; }
            var text = String(sel).trim();
            if (text.length < 6) { hidePop(); return; }
            var node = sel.anchorNode;
            if (!node || !article.contains(node.nodeType === 1 ? node : node.parentNode)) { hidePop(); return; }
            var rect = sel.getRangeAt(0).getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height)) { hidePop(); return; }
            showPop(text.length > 400 ? text.slice(0, 400) + '…' : text, rect);
          }
          var selectTimer = null;
          var onUp = function () { clearTimeout(selectTimer); selectTimer = setTimeout(onSelect, 60); };
          document.addEventListener('mouseup', onUp);
          document.addEventListener('touchend', onUp);
          document.addEventListener('scroll', hidePop, { passive: true });
          state.cleanupFns.push(function () {
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchend', onUp);
            document.removeEventListener('scroll', hidePop);
            hidePop();
          });

          // 键盘：← → 上一课/下一课；n 记笔记
          function onKey(e) {
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if (e.key === 'ArrowLeft' && prev) location.hash = prev.route;
            else if (e.key === 'ArrowRight' && next) location.hash = next.route;
            else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openDrawer(); }
          }
          document.addEventListener('keydown', onKey);
          state.cleanupFns.push(function () { document.removeEventListener('keydown', onKey); });

          return function cleanup() {
            state.cleanupFns.forEach(function (f) { try { f(); } catch (err) {} });
            closeDrawer();
            if (drawer) drawer.remove();
            if (sideBackdrop) { sideBackdrop.remove(); sideBackdrop = null; }
            document.body.classList.remove('no-scroll');
          };
        }).then(function (cleanupFn) {
          LLM.setTitle(lesson.title);
          return cleanupFn;
        });
      }).catch(function (e) {
        ui.clear(wrap);
        var c = ui.el('div', 'container');
        c.innerHTML = '<div class="empty"><strong>这个课时打不开</strong><p class="small">' + fmt.esc(e.message) +
          '</p><p><a class="btn btn--primary" href="#/course/' + fmt.esc(slug) + '">回课程页</a> <a class="btn" href="#/courses">全部课程</a></p></div>';
        wrap.appendChild(c);
        return null;
      });
    },
  };

  /* 路由别名：`#/l/<课时id>` 与 `#/learn/<课>/<章>/<课时>` 是同一个视图（内部按 route.name 分支）。
   * ⚠️ 之前只注册了 lesson，`#/l/…` 就落到 404 —— 正文里的「下一课」与百科的课时指针全都点不通。 */
  views.lessonById = views.lesson;

  /* 供课程页/搜索复用 */
  views.lessonRoute = function (slug, chapter, lessonFile) {
    return '#/learn/' + slug + '/' + chapter + '/' + lessonSlugOf(lessonFile);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-paths.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 学习路径（可视化版）
 *
 * 这一页回答三件事：**我要去哪**（目标路径）、**我适合什么岗**（岗位）、**链路长什么样**（方向线）。
 * 三块都用「图」而不是「一串文字」来表达：
 *   · 目标路径 = 横向流程图（课程节点 + 连接线 + 每门课的进度条 + 目标课标记）
 *   · 岗位     = 卡片（覆盖率环 + 课程/课时数 + 课程清单）
 *   · 方向线   = 泳道（进度条 + 已学/总课时 + 主干线标记）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  /* ---------------- 小零件 ---------------- */

  /**
   * 目标路径的图标：用**线性 SVG**而不是把一个汉字塞进方块里（那样看着像占位符）。
   * 按路径名/目标课关键词匹配；匹配不到给一个中性的「路线」图标。
   */
  function iconOf(p) {
    var hay = ((p.name || '') + ' ' + (p.why || '') + ' ' + (p.goal || '')).toLowerCase();
    var rules = [
      [/rag|检索|知识库/, 'search'],
      [/agent|工具|智能体/, 'bot'],
      [/推理|部署|服务/, 'server'],
      [/编译|系统|内核|gpu/, 'chip'],
      [/多模态|生成|图像|语音|视频/, 'image'],
      [/评测|安全|对齐|红队/, 'shield'],
      [/岗位|面试/, 'briefcase'],
      [/地基|数学|编程|基础|入门/, 'layers'],
      [/路径|目标/, 'route'],
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(hay)) return rules[i][1];
    return 'route';
  }
  views.pathIcon = iconOf;

  /** 一门课的节点：序号/勾 + 课程名 + 课时数 + 该课进度条；目标课高亮 */
  function step(slug, idx, bySlug, pm, opts) {
    var o = opts || {};
    var c = bySlug[slug] || {};
    var p = pm[slug] || { done: 0, total: (c.counts && c.counts.lessons) || 0 };
    var finished = p.total && p.done >= p.total;
    var a = ui.el('a', 'step' + (finished ? ' done' : '') + (p.done && !finished ? ' doing' : '') + (o.goal ? ' goal' : ''));
    a.href = '#/course/' + slug;
    a.title = (c.title || slug) + '：' + (p.done || 0) + ' / ' + (p.total || 0) + ' 课时';
    a.appendChild(ui.el('span', 'step-node', finished ? '✓' : String(idx)));
    a.appendChild(ui.el('span', 'step-name', c.title || slug));
    a.appendChild(ui.el('span', 'step-meta', (p.total || 0) + ' 课时' + (o.goal ? ' · 🎯 目标' : '')));
    var bar = ui.el('span', 'step-bar');
    bar.innerHTML = '<i style="width:' + (p.total ? Math.round((p.done / p.total) * 100) : 0) + '%"></i>';
    a.appendChild(bar);
    return a;
  }

  /** 一条目标路径：卡头 + 进度 + 横向流程图 */
  function pathFlow(path, bySlug, pm) {
    var card = ui.el('div', 'path-card path-flow');
    var courses = path.courses || [];
    var done = 0, total = 0;
    courses.forEach(function (c) {
      var p = pm[c.slug];
      done += p ? p.done : 0;
      total += p ? p.total : (c.lessons || 0);
    });
    var pct = total ? Math.round((done / total) * 100) : 0;

    var head = ui.el('div', 'path-flow-head');
    var left = ui.el('div', 'path-head');
    var glyph = ui.el('div', 'path-glyph');
    glyph.innerHTML = ui.iconSvg(iconOf(path), 22);
    left.appendChild(glyph);
    var tw = ui.el('div');
    tw.appendChild(ui.el('h3', null, path.name));
    tw.appendChild(ui.el('div', 'small muted',
      [path.group, path.lessons ? path.lessons + ' 课时' : '', path.hours ? '约 ' + path.hours + ' 小时' : ''].filter(Boolean).join(' · ')));
    left.appendChild(tw);
    head.appendChild(left);

    var right = ui.el('div', 'path-flow-actions');
    right.appendChild(ui.ring(done, total, { size: 'sm', title: '这条路径已完成 ' + done + ' / ' + total + ' 课时' }));
    var nextCourse = courses.filter(function (c) {
      var p = pm[c.slug];
      return !p || p.done < p.total;
    })[0] || courses[courses.length - 1];
    var go = ui.el('a', 'btn btn--sm' + (pct ? '' : ' btn--primary'), pct >= 100 ? '再复习一遍' : (pct ? '继续这条路径' : '开始这条路径'));
    go.href = nextCourse ? '#/course/' + nextCourse.slug : '#/courses';
    right.appendChild(go);
    head.appendChild(right);
    card.appendChild(head);

    card.appendChild(ui.el('p', 'path-why', path.why || ''));

    var prog = ui.el('div', 'path-progress');
    prog.appendChild(ui.bar(done, total));
    prog.appendChild(ui.el('div', 'small muted', done + ' / ' + total + ' 课时已完成' + (pct ? '（' + pct + '%）' : '')));
    card.appendChild(prog);

    // 横向流程图：节点 + 连接线；窄屏可左右滑（CSS 控制）
    var flow = ui.el('div', 'stepper');
    var goalSlug = path.goal || (courses[courses.length - 1] || {}).slug;
    courses.forEach(function (c, i) {
      if (i) flow.appendChild(ui.el('span', 'step-conn'));
      flow.appendChild(step(c.slug, i + 1, bySlug, pm, { goal: c.slug === goalSlug }));
    });
    card.appendChild(flow);
    return card;
  }

  /** 岗位卡：覆盖率 + 课程清单 */
  function roleCard(role, bySlug, pm) {
    var card = ui.el('div', 'card role-card');
    var box = ui.el('div', 'card-body');
    var done = 0, total = 0, lessons = 0;
    (role.slugs || []).forEach(function (slug) {
      var p = pm[slug];
      var c = bySlug[slug] || {};
      done += p ? p.done : 0;
      total += p ? p.total : ((c.counts && c.counts.lessons) || 0);
      lessons += (c.counts && c.counts.lessons) || 0;
    });
    var head = ui.el('div', 'spread');
    var hl = ui.el('div');
    hl.appendChild(ui.el('h3', 'card-title', role.name));
    hl.appendChild(ui.el('div', 'small muted', (role.slugs || []).length + ' 门课 · ' + lessons + ' 课时'));
    head.appendChild(hl);
    head.appendChild(ui.ring(done, total, { size: 'sm' }));
    box.appendChild(head);
    var bar = ui.el('div', 'bar');
    bar.innerHTML = '<i style="width:' + (total ? Math.round((done / total) * 100) : 0) + '%"></i>';
    box.appendChild(bar);
    var row = ui.el('div', 'chip-row');
    row.style.marginTop = '12px';
    (role.slugs || []).forEach(function (slug) {
      var c = bySlug[slug] || {};
      var p = pm[slug];
      var a = ui.el('a', 'chip' + (p && p.total && p.done >= p.total ? ' on' : ''), c.title || slug);
      a.href = '#/course/' + slug;
      a.title = (c.title || slug) + '：' + ((c.counts && c.counts.lessons) || 0) + ' 课时' + (p ? '（已学 ' + p.done + '）' : '');
      row.appendChild(a);
    });
    box.appendChild(row);
    card.appendChild(box);
    return card;
  }

  /** 方向线泳道 */
  function lane(line, bySlug, pm) {
    var box = ui.el('div', 'lane');
    var done = 0, total = 0;
    (line.slugs || []).forEach(function (slug) {
      var p = pm[slug];
      var c = bySlug[slug] || {};
      done += p ? p.done : 0;
      total += p ? p.total : ((c.counts && c.counts.lessons) || 0);
    });
    var head = ui.el('div', 'lane-head');
    head.appendChild(ui.el('h3', null, line.name));
    if (line.kind === 'spine') head.appendChild(ui.el('span', 'badge badge--warn', '主干线'));
    head.appendChild(ui.el('span', 'line-kind', (line.slugs || []).length + ' 门课 · ' + total + ' 课时 · 已学 ' + done));
    box.appendChild(head);
    var bar = ui.el('div', 'lane-bar');
    bar.appendChild(ui.bar(done, total));
    box.appendChild(bar);
    var row = ui.el('div', 'chip-row');
    (line.slugs || []).forEach(function (slug) {
      var c = bySlug[slug] || {};
      var p = pm[slug];
      var a = ui.el('a', 'chip' + (p && p.total && p.done >= p.total ? ' on' : ''), c.title || slug);
      a.href = '#/course/' + slug;
      a.title = (c.title || slug) + '：' + (p ? p.done + ' / ' + p.total : ((c.counts && c.counts.lessons) || 0)) + ' 课时';
      row.appendChild(a);
    });
    box.appendChild(row);
    return box;
  }

  /**
   * 「学习主干」流程图：5 条主干线按顺序串起来，4 条应用/领域线作为「按需插入」的分支。
   * 这是整页最先要回答的问题：**我该沿着什么顺序走**。
   */
  function backbone(site, bySlug, pm) {
    var box = ui.el('div', 'backbone');
    function lineStats(line) {
      var done = 0, total = 0;
      (line.slugs || []).forEach(function (slug) {
        var p = pm[slug];
        var c = bySlug[slug] || {};
        done += p ? p.done : 0;
        total += p ? p.total : ((c.counts && c.counts.lessons) || 0);
      });
      return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
    }
    function node(line, idx) {
      var st = lineStats(line);
      var a = ui.el('a', 'bb-node' + (st.pct >= 100 ? ' done' : (st.done ? ' doing' : '')));
      a.href = '#/courses';
      a.title = line.name + '：' + st.done + ' / ' + st.total + ' 课时';
      a.appendChild(ui.el('span', 'bb-idx', String(idx)));
      a.appendChild(ui.el('span', 'bb-name', line.name));
      a.appendChild(ui.el('span', 'bb-meta', (line.slugs || []).length + ' 门 · ' + st.total + ' 课时'));
      var bar = ui.el('span', 'step-bar');
      bar.innerHTML = '<i style="width:' + st.pct + '%"></i>';
      a.appendChild(bar);
      return a;
    }
    var spine = (site.lines || []).filter(function (l) { return l.kind === 'spine'; });
    var branch = (site.lines || []).filter(function (l) { return l.kind !== 'spine'; });

    var row = ui.el('div', 'stepper bb-row');
    spine.forEach(function (l, i) {
      if (i) row.appendChild(ui.el('span', 'step-conn'));
      row.appendChild(node(l, i + 1));
    });
    box.appendChild(row);
    if (branch.length) {
      var bh = ui.el('div', 'bb-branch-head');
      bh.appendChild(ui.el('span', 'badge', '按需插入'));
      bh.appendChild(ui.el('span', 'small muted', '下面 4 条线不必按顺序，等主干走到一半再挑着学更省力'));
      box.appendChild(bh);
      var brow = ui.el('div', 'stepper bb-row bb-row--branch');
      branch.forEach(function (l, i) {
        if (i) brow.appendChild(ui.el('span', 'step-conn'));
        brow.appendChild(node(l, i + 1));
      });
      box.appendChild(brow);
    }
    return box;
  }

  /** 全站进度热力条：41 门课一格，颜色 = 完成度；一眼看出哪里学过、哪里还是空白 */
  function heat(cards, pm) {
    var box = ui.el('div', 'heat');
    cards.forEach(function (c) {
      var p = pm[c.slug] || { done: 0, total: (c.counts && c.counts.lessons) || 0, pct: 0 };
      var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      var a = ui.el('a', 'heat-cell' + (pct >= 100 ? ' full' : (pct ? ' part' : '')));
      a.href = '#/course/' + c.slug;
      a.title = c.title + '：' + p.done + ' / ' + p.total + ' 课时' + (pct ? '（' + pct + '%）' : '（未开始）');
      a.appendChild(ui.el('span', 'sr-only', c.title));
      box.appendChild(a);
    });
    return box;
  }

  views.paths = {
    render: function (rootEl) {
      LLM.setTitle('学习路径');
      var wrap = ui.el('div', 'container');
      rootEl.appendChild(wrap);
      wrap.innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:260px;margin-top:14px"></div>';

      var progressP = (LLM.store && LLM.store.statsByCourse)
        ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
        : Promise.resolve({ courses: [] });

      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], cards = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        var bySlug = {};
        cards.forEach(function (c) { bySlug[c.slug] = c; });
        var st = (LLM.store && LLM.store.stats) ? LLM.store.stats()
          : { doneLessons: 0, totalLessons: site.counts.lessons, doneMinutes: 0 };
        ui.clear(wrap);

        /* ---------- ① 头部：我的总进度 ---------- */
        var hero = ui.el('div', 'paths-hero');
        var hl = ui.el('div', 'paths-hero-main');
        hl.appendChild(ui.el('h1', null, '学习路径'));
        hl.appendChild(ui.el('p', null, '路径只规定「目标课」，前置链按课程依赖自动展开。选一条最接近你目标的，按顺序走；' +
          '途中想深挖某个主题，随时用关键词百科或课程地图插队。'));
        var stats = ui.el('div', 'paths-hero-stats');
        [['已学课时', st.doneLessons + ' / ' + st.totalLessons],
         ['剩余时长', fmt.minutes(Math.max(0, (site.counts.minutes || 0) - (st.doneMinutes || 0)))],
         ['课程 / 章节', cards.length + ' 门 · ' + site.counts.chapters + ' 章'],
         ['图表 / 关键词', fmt.num(site.counts.figures) + ' / ' + fmt.num(site.counts.glossaryTerms)]].forEach(function (pair) {
          var s = ui.el('div', 'paths-stat');
          s.appendChild(ui.el('b', null, pair[1]));
          s.appendChild(ui.el('span', null, pair[0]));
          stats.appendChild(s);
        });
        hl.appendChild(stats);
        hero.appendChild(hl);
        hero.appendChild(ui.ring(st.doneLessons, st.totalLessons, { title: '全站进度' }));
        wrap.appendChild(hero);

        /* ---------- ①b 全站进度热力条 ---------- */
        var heatSec = ui.el('section', 'section');
        var hh = ui.el('div', 'section-head');
        var hhl = ui.el('div');
        hhl.appendChild(ui.el('h2', 'section-title', '课程进度一览'));
        hhl.appendChild(ui.el('p', 'section-sub', '41 门课一格，颜色越深学得越多；悬停看具体课时数，点格直接进课。'));
        hh.appendChild(hhl);
        heatSec.appendChild(hh);
        heatSec.appendChild(heat(cards, pm));
        wrap.appendChild(heatSec);

        /* ---------- ①c 学习主干：先看顺序 ---------- */
        var bbSec = ui.el('section', 'section');
        var bh = ui.el('div', 'section-head');
        var bhl = ui.el('div');
        bhl.appendChild(ui.el('h2', 'section-title', '学习主干：建议的顺序'));
        bhl.appendChild(ui.el('p', 'section-sub', '5 条主干线是一条有先后的链（每个概念都建立在前一条线上）；4 条应用/领域线可以按需插入。'));
        bh.appendChild(bhl);
        bbSec.appendChild(bh);
        bbSec.appendChild(backbone(site, bySlug, pm));
        wrap.appendChild(bbSec);

        /* ---------- ② 目标路径：流程图 ---------- */
        var sec = ui.el('section', 'section');
        var sh = ui.el('div', 'section-head');
        var shl = ui.el('div');
        shl.appendChild(ui.el('h2', 'section-title', (site.paths || []).length + ' 条目标路径'));
        shl.appendChild(ui.el('p', 'section-sub', '按「学完要做什么」选，而不是按课程名选。节点上的进度条就是你在这门课上的完成度。'));
        sh.appendChild(shl);
        sec.appendChild(sh);
        var grid = ui.el('div', 'paths-grid paths-grid--flow');
        (site.paths || []).forEach(function (p) { grid.appendChild(pathFlow(p, bySlug, pm)); });
        sec.appendChild(grid);
        wrap.appendChild(sec);

        /* ---------- ③ 岗位 ---------- */
        if ((site.roles || []).length) {
          var rsec = ui.el('section', 'section');
          var rh = ui.el('div', 'section-head');
          var rhh = ui.el('div');
          rhh.appendChild(ui.el('h2', 'section-title', '按岗位看：学完能应聘什么'));
          rhh.appendChild(ui.el('p', 'section-sub', '每个岗位列出它需要的课程集合 —— 之间可能有重叠，重叠部分就是通用地基。'));
          rh.appendChild(rhh);
          rsec.appendChild(rh);
          var rg = ui.el('div', 'grid card-grid-2');
          (site.roles || []).forEach(function (r) { rg.appendChild(roleCard(r, bySlug, pm)); });
          rsec.appendChild(rg);
          wrap.appendChild(rsec);
        }

        /* ---------- ④ 方向线：泳道 ---------- */
        var lsec = ui.el('section', 'section');
        var lh2 = ui.el('div', 'section-head');
        var lhh = ui.el('div');
        lhh.appendChild(ui.el('h2', 'section-title', '9 条方向线'));
        lhh.appendChild(ui.el('p', 'section-sub', '主干线 5 条（线内有前置链）+ 应用与领域 4 条；按 6 个大类分组。'));
        lh2.appendChild(lhh);
        lsec.appendChild(lh2);
        (site.families || []).forEach(function (fam) {
          var ft = ui.el('div', 'family-title');
          ft.appendChild(ui.el('h2', null, fam.name));
          lsec.appendChild(ft);
          (fam.lines || []).forEach(function (lineName) {
            var line = (site.lines || []).filter(function (l) { return l.name === lineName; })[0];
            if (line) lsec.appendChild(lane(line, bySlug, pm));
          });
        });
        wrap.appendChild(lsec);
        return null;
      });
    },
  };

  /* ---------------- 404 ---------------- */
  views.notfound = {
    render: function (rootEl, route) {
      LLM.setTitle('页面不存在');
      var wrap = ui.el('div', 'container container--narrow');
      ui.clear(rootEl);
      rootEl.appendChild(wrap);
      return data.site().then(function () {
        var box = ui.el('div', 'empty');
        box.innerHTML = '<strong>这个地址没有内容</strong>' +
          '<p class="small">你访问的是 <code>#/' + fmt.esc((route.seg || []).join('/')) + '</code>，站点里没有对应页面。</p>';
        var row = ui.el('div', 'row');
        row.style.justifyContent = 'center';
        row.style.marginTop = '14px';
        [['#/', '回首页'], ['#/paths', '学习路径'], ['#/courses', '全部课程'], ['#/glossary', '关键词百科'], ['#/figures', '图表库']]
          .forEach(function (p) {
            var a = ui.el('a', 'btn btn--sm' + (p[0] === '#/' ? ' btn--primary' : ''), p[1]);
            a.href = p[0];
            row.appendChild(a);
          });
        box.appendChild(row);
        wrap.appendChild(box);
        return null;
      }).catch(function () { return null; });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-figures.js ===== */
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
  function buildModel(figuresMap, courseCards, siteLines, fullCourse, figureMeta) {
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
          title: (figureMeta[url] && figureMeta[url].t) || '',
          lessons: (figureMeta[url] && figureMeta[url].k) || [],
          w: Number(fig.w) || 0,
          h: Number(fig.h) || 0,
          cap: '',
        });
      });
    });
    items.forEach(function (f) {
      f.cap = f.title || fullLabel(f);
      // 搜索词里带上**图题**（正文里那句描述）与所属课时标题 —— 这才是「找那张讲 XX 的图」的用法
      f.hay = (f.slug + ' ' + f.courseTitle + ' ' + baseName(f.url) + ' ' + posLabel(f) + ' ' + f.line + ' ' +
        (f.title || '') + ' ' + f.lessons.map(function (k) { return k.t + ' ' + k.ct; }).join(' ')).toLowerCase();
    });

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
    var img = ui.el('img')

    img.src = thumb(f.url);
    img.dataset.slug = f.slug;                         // 灯箱里「跳到该课」要用
    // ⚠️ 目标是**这一课**（#/l/<课时 id>），不是课程页：图上挂的第一个课时指针
    img.dataset.lesson = (f.lessons && f.lessons[0] && (f.lessons[0].id || f.lessons[0].l)) || '';
    SRC_MAP[img.getAttribute('src')] = { slug: f.slug || '', lesson: img.dataset.lesson };
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
    cap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    var top = ui.el('div');
    top.style.cssText = 'display:flex;gap:10px;justify-content:space-between';
    top.appendChild(ui.el('span', null, posLabel(f)));
    top.appendChild(ui.el('span', 'fig-course', f.courseTitle));
    cap.appendChild(top);
    if (f.title) {
      var t = ui.el('div', 'fig-title', f.title);
      t.style.cssText = 'font-size:12.5px;line-height:1.5;color:var(--text-soft)';
      t.title = f.title;
      cap.appendChild(t);
    }
    if (f.lessons && f.lessons.length) {
      // 图 → 讲它的那一课：图表库的意义就落在这里
      var go = ui.el('a', 'fig-go', '去这一课：' + fmt.clamp(f.lessons[0].t, 22) + ' →');
      go.href = '#/l/' + f.lessons[0].id;
      go.style.cssText = 'font-size:12px;color:var(--accent)';
      go.title = f.lessons[0].ct + ' · ' + f.lessons[0].t;
      go.addEventListener('click', function (e) { e.stopPropagation(); });   // 别触发外层的灯箱
      cap.appendChild(go);
    }
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
    q.placeholder = '搜图题（如「KV 头」「缩放律」）或课程 / 章节';
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

  var SRC_MAP = {};      // 图片 src → 所属课程/课时（灯箱的 <img> 不带 dataset，只能靠 src 反查）

  /** 灯箱注入「跳到该课」：ui.lightbox 只支持 prev/next/原图，所以在自己的根节点上补一个按钮 */
  function injectJump() {
    var box = ui.$('.lightbox');
    if (!box || ui.$('.lb-jump', box)) return;
    var img = ui.$('img', box);
    if (!img) return;
    var cap = ui.$('.lightbox-cap', box);
    var a = ui.el('a', 'btn btn--sm lb-jump', '跳到该课');
    var meta = SRC_MAP[img.getAttribute('src')] || { slug: img.dataset.slug || '', lesson: img.dataset.lesson || '' };
    a.href = meta.lesson ? ('#/l/' + meta.lesson) : ('#/course/' + meta.slug);
    a.title = meta.lesson ? '跳到这张图所在的课时' : '跳到这门课';
    // ⚠️ 灯箱是遮罩：不先关掉，跳转就发生在遮罩后面 → 用户看着「点了没反应」
    a.addEventListener('click', function () {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(function () {
        var lb = ui.$('.lightbox');
        if (lb && lb.parentNode) lb.parentNode.removeChild(lb);      // 兜底：Esc 没被监听时直接移除
        document.body.classList.remove('no-scroll');
      }, 60);
    });
    a.rel = 'noreferrer';
    if (cap && cap.parentNode) cap.parentNode.insertBefore(a, cap);
    else box.appendChild(a);
  }

  /** 文档任意点击：既处理「灯箱内点击」，也覆盖「这次点击刚创建灯箱」的情况 */
  function onDocClick() {
    injectJump();
    setTimeout(injectJump, 0);
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
      data.figureMeta().catch(function () { return { meta: {} }; }),   // 图题 + 图→课时
    ]).then(function (res) {
      var full = res[3] || {};
      var meta = (res[4] && res[4].meta) || {};
      var m = buildModel(res[0] || {}, res[1] || [], (res[2] && res[2].lines) || [], full, meta);
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

;
/* ===== assets/views-glossary.js ===== */
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

;
/* ===== assets/views-me.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 我的学习（#/me、#/me/notes、#/me/data）
 *
 * 这一页自己不存任何数据：数字全部现算自 LLM.store（本机 localStorage）。
 * 所以每次 store 写操作后只重画「会变的容器」，页面骨架（tabs / 筛选框 / 表格头 /
 * 导入导出的表单）只建一次 —— 否则用户正在输入搜索词或粘贴 JSON 时会被重画清空。
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt;
  var views = LLM.views = LLM.views || {};

  var TABS = [
    { key: '', id: 'me-overview', label: '概览' },
    { key: 'notes', id: 'me-notes', label: '我的笔记' },
    { key: 'data', id: 'me-data', label: '学习数据' },
  ];
  var CHIPS = [
    { key: 'all', label: '全部' },
    { key: 'doing', label: '进行中' },
    { key: 'done', label: '已完成' },
    { key: 'todo', label: '未开始' },
  ];
  var RECENT_N = 5;

  /* ---------------- 小工具 ---------------- */
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function ymd() {
    var d = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function toast(msg, kind) { if (ui.toast) ui.toast(fmt.esc(msg), kind); }
  function subTitle(it) {
    return (it.courseTitle || it.course || '') + (it.chapterTitle ? ' › ' + it.chapterTitle : '');
  }
  function section(id, title, sub) {
    var sec = ui.el('section', 'section');
    if (id) sec.id = id;
    var head = ui.el('div', 'section-head');
    head.appendChild(ui.el('h2', 'section-title', title));
    sec.appendChild(head);
    if (sub) sec.appendChild(ui.el('p', 'section-sub', sub));
    return sec;
  }
  function btnEl(cls, label) {
    var b = ui.el('button', cls, label);
    b.type = 'button';
    return b;
  }
  function linkTo(cls, label, href) {
    var a = ui.el('a', cls, label);
    a.href = href;
    return a;
  }

  /** 下载：Blob + a[download]，纯前端，不经过任何服务端 */
  function download(name, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      return true;
    } catch (e) {
      toast('浏览器不允许下载文件，请改用「复制到剪贴板」', 'err');
      return false;
    }
  }
  /** 剪贴板：优先异步 API，失败退到 textarea + execCommand（http 下 clipboard 常常不可用） */
  function copyText(text) {
    var clip = root.navigator && navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      return clip.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }
  function mdHtml(src) {
    try {
      var html = ui.md ? ui.md(src) : '';
      return html || '<p class="muted small">（空）</p>';
    } catch (e) {
      return '<pre class="small">' + fmt.esc(src) + '</pre>';   // marked 没加载也要能看原文
    }
  }

  /* ========================== 页面 ========================== */
  function render(rootEl, route) {
    LLM.setTitle('我的学习');
    var store = LLM.store;
    var wrap = ui.el('div', 'container');
    rootEl.appendChild(wrap);

    if (!store) {
      var bad = ui.el('div', 'empty');
      bad.innerHTML = '<strong>学习数据层没有加载</strong><p class="small">assets/store.js 没随页面一起加载，进度与笔记不可用。</p>';
      wrap.appendChild(bad);
      return;
    }

    var seg = (route && route.seg) || [];
    var want = (seg[1] === 'notes' || seg[1] === 'data') ? seg[1] : '';

    /* ---------- 标题 ---------- */
    var head = ui.el('div', 'page-head');
    head.appendChild(ui.el('h1', null, '我的学习'));
    head.appendChild(ui.el('p', null, '学习记录保存在这台设备的浏览器里：换设备或换浏览器时，用下面的「导出 / 导入」把进度与笔记带走。'));
    wrap.appendChild(head);

    /* ---------- 子页锚点（点 tab 由 app.js 的 hash 路由重渲染，所以是 link 不是 button） ---------- */
    var tabs = ui.el('div', 'tabs');
    var tabEls = {};
    TABS.forEach(function (t) {
      var a = ui.el('a', 'tab' + (want === t.key ? ' on' : ''), t.label);
      a.href = t.key ? '#/me/' + t.key : '#/me';
      a.dataset.tab = t.key;
      tabEls[t.key] = a;
      tabs.appendChild(a);
    });
    wrap.appendChild(tabs);

    /* ---------- 空态（没有任何痕迹时只留它 + 导入导出） ---------- */
    var banner = ui.el('div', 'empty');
    banner.innerHTML = '<strong>还没有任何学习记录</strong>' +
      '<p class="small">进度、笔记与收藏都只存在这台设备的浏览器里。从学习路径挑一门课开始，这里就会长出你的学习档案。</p>' +
      '<p><a class="btn btn--primary" href="#/paths">从学习路径开始</a> ' +
      '<a class="btn btn--ghost" href="#/courses">浏览全部课程</a></p>';
    wrap.appendChild(banner);

    /* ---------- ① 概览：统计卡 + 总进度条 ---------- */
    var secOverview = section('me-overview', '总览');
    var cardsBox = ui.el('div', 'stat-cards');
    secOverview.appendChild(cardsBox);
    var barBox = ui.el('div');
    secOverview.appendChild(barBox);
    wrap.appendChild(secOverview);

    /* ---------- ② 最近学习 ---------- */
    var secRecent = section(null, '最近学习');
    var resumeBox = ui.el('div');
    var recentBox = ui.el('div', 'note-list');
    secRecent.appendChild(resumeBox);
    secRecent.appendChild(recentBox);
    wrap.appendChild(secRecent);

    /* ---------- ③ 按课程进度 ---------- */
    var secTable = section(null, '按课程进度', '点表头可按课程 / 已完成 / 进度 / 时长排序；筛选与搜索只影响这张表。');
    var S = { chip: 'all', q: '', sort: 'pct', dir: -1 };
    var BY = { courses: [], lines: [], families: [], recent: [], next: null };

    var filters = ui.el('div', 'filters');
    var chipRow = ui.el('div', 'chip-row');
    CHIPS.forEach(function (c) {
      var chip = btnEl('chip' + (c.key === S.chip ? ' on' : ''), c.label);
      chip.dataset.chip = c.key;
      chip.addEventListener('click', function () {
        S.chip = c.key;
        ui.$$('.chip', chipRow).forEach(function (x) { x.classList.toggle('on', x.dataset.chip === c.key); });
        paintTable();
      });
      chipRow.appendChild(chip);
    });
    filters.appendChild(chipRow);
    var field = ui.el('div', 'field');
    var qInput = document.createElement('input');
    qInput.type = 'search';
    qInput.placeholder = '搜课程 / 方向线';
    qInput.setAttribute('aria-label', '搜索课程');
    qInput.addEventListener('input', ui.debounce(function () {
      S.q = qInput.value || '';
      paintTable();
    }, 120));
    field.appendChild(qInput);
    filters.appendChild(field);
    var counter = ui.el('span', 'filter-count');
    filters.appendChild(counter);
    secTable.appendChild(filters);

    var COLS = [
      { key: 'title', label: '课程', sortable: true },
      { key: 'line', label: '方向线', sortable: false },
      { key: 'done', label: '已完成', sortable: true },
      { key: 'pct', label: '进度', sortable: true },
      { key: 'minutes', label: '时长', sortable: true },
    ];
    var table = ui.el('table', 'progress-table');
    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    var thEls = {};
    COLS.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.label;
      thEls[c.key] = th;
      if (c.key !== 'title' && c.key !== 'line') { th.classList.add('num'); th.style.textAlign = 'right'; }
      if (c.sortable) {
        th.style.cursor = 'pointer';
        th.title = '点击按「' + c.label + '」排序';
        th.addEventListener('click', function () {
          if (S.sort === c.key) S.dir = -S.dir;
          else { S.sort = c.key; S.dir = c.key === 'title' ? 1 : -1; }
          paintTable();
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    table.appendChild(tbody);
    secTable.appendChild(table);
    wrap.appendChild(secTable);

    /* ---------- ④ 我的笔记 + 收藏 ---------- */
    var secNotes = section('me-notes', '我的笔记');
    var notesBox = ui.el('div', 'note-list');
    secNotes.appendChild(notesBox);
    var bmHead = ui.el('div', 'section-head');
    bmHead.appendChild(ui.el('h3', 'section-title', '收藏的课时'));
    secNotes.appendChild(bmHead);
    var bmBox = ui.el('div', 'note-list');
    secNotes.appendChild(bmBox);
    wrap.appendChild(secNotes);

    /* ---------- ⑤ 学习数据（导入导出 + 危险区） ---------- */
    var ioSummary = ui.el('p', 'small muted');
    wrap.appendChild(ioSection());

    /* ========================== 各块重画 ========================== */
    function paintOverview() {
      var st = store.stats();
      var total = n(st.totalLessons);
      ui.clear(cardsBox);
      var c1 = ui.el('div', 'stat-card');
      c1.innerHTML = '<b>' + fmt.num(st.doneLessons) + '<span class="muted"> / ' + (total ? fmt.num(total) : '—') + '</span></b>' +
        '<span>已完成课时' + (total ? '（' + st.pct + '%）' : '') + '</span>';
      cardsBox.appendChild(c1);
      var c2 = ui.el('div', 'stat-card');
      c2.innerHTML = '<b>' + fmt.esc(fmt.minutes(st.doneMinutes)) + '</b><span>学习时长（按已完成课时估算）</span>';
      cardsBox.appendChild(c2);
      var c3 = ui.el('div', 'stat-card');
      c3.innerHTML = '<b>' + fmt.num(st.notes) + '</b><span>笔记</span>';
      cardsBox.appendChild(c3);
      var c4 = ui.el('div', 'stat-card');
      c4.innerHTML = '<b>' + fmt.num(st.bookmarks) + '</b><span>收藏</span>';
      cardsBox.appendChild(c4);

      ui.clear(barBox);
      barBox.appendChild(ui.bar(st.doneLessons, total));
      var cap = ui.el('p', 'muted small');
      cap.textContent = '总进度 ' + st.pct + '% · 已完成 ' + st.doneLessons + ' / ' + (total || '—') + ' 课时 · 全部课程约 ' +
        fmt.minutes(st.totalMinutes) + (total ? '（还剩约 ' + fmt.minutes(Math.max(0, st.totalMinutes - st.doneMinutes)) + '）' : '');
      barBox.appendChild(cap);
    }

    function rowMain(it, extra) {
      var main = ui.el('div', 'nr-main');
      var line = ui.el('div');
      line.appendChild(linkTo(null, it.title || it.id, it.route));
      main.appendChild(line);
      main.appendChild(ui.el('div', 'muted small', subTitle(it) + (extra ? ' · ' + extra : '')));
      return main;
    }

    function paintRecent() {
      ui.clear(resumeBox);
      ui.clear(recentBox);
      var st = store.stats();
      var last = store.lastVisited();
      var next = BY.next;
      var goLabel = (last && last.id) ? '继续' : '开始学习';

      if (next) {
        var box = ui.el('div', 'resume');
        if (ui.ring) box.appendChild(ui.ring(st.doneLessons, st.totalLessons, { title: '总进度' }));
        var main = ui.el('div', 'resume-main');
        main.appendChild(ui.el('b', null, ((last && last.id) ? '继续学习：' : '从第一课开始：') + next.title));
        main.appendChild(ui.el('span', null, (next.courseTitle || next.course || '') + (next.chapterTitle ? ' › ' + next.chapterTitle : '')));
        box.appendChild(main);
        if (next.minutes) box.appendChild(ui.el('span', 'muted small', '约 ' + next.minutes + ' 分钟'));
        box.appendChild(linkTo('btn btn--primary', goLabel, next.route));
        resumeBox.appendChild(box);
      } else if (last && last.id) {
        // 元数据还没到：至少给一个能点的去处
        var fallback = ui.el('div', 'resume');
        var fm = ui.el('div', 'resume-main');
        fm.appendChild(ui.el('b', null, '回到上次学的课时'));
        fm.appendChild(ui.el('span', null, '已记录 ' + fmt.rel(last.ts)));
        fallback.appendChild(fm);
        fallback.appendChild(linkTo('btn btn--primary', '继续', '#/l/' + last.id));
        resumeBox.appendChild(fallback);
      }

      var recent = (BY.recent || []).slice(0, RECENT_N);
      if (!recent.length) {
        recentBox.appendChild(ui.el('p', 'muted small', '还没有完成的课时：学完一课（课时页底部的「标记完成」）就会出现在这里。'));
        return;
      }
      recent.forEach(function (it) {
        var row = ui.el('div', 'note-row');
        row.appendChild(rowMain(it, null));
        row.appendChild(ui.el('span', 'badge badge--done', '已完成'));
        row.appendChild(ui.el('span', 'muted small', fmt.rel(it.ts)));
        recentBox.appendChild(row);
      });
    }

    function sortRows(rows) {
      var key = S.sort;
      return rows.sort(function (a, b) {
        if (key === 'title') return S.dir * String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
        var va = n(a[key]), vb = n(b[key]);
        if (va === vb) return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
        return S.dir * (va - vb);
      });
    }

    function paintTable() {
      COLS.forEach(function (c) {
        var th = thEls[c.key];
        if (!th) return;
        th.textContent = c.label + (c.sortable && S.sort === c.key ? (S.dir > 0 ? ' ↑' : ' ↓') : '');
      });
      var all = BY.courses || [];
      var q = S.q.trim().toLowerCase();
      var rows = sortRows(all.filter(function (c) {
        if (S.chip === 'doing' && !(c.done > 0 && c.done < c.total)) return false;
        if (S.chip === 'done' && !(c.total > 0 && c.done >= c.total)) return false;
        if (S.chip === 'todo' && c.done !== 0) return false;
        if (q) {
          var hay = (c.title + ' ' + c.line + ' ' + c.family + ' ' + c.slug).toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      }));
      counter.textContent = rows.length + ' / ' + all.length + ' 门课';

      ui.clear(tbody);
      if (!rows.length) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = COLS.length;
        td.className = 'muted small';
        td.textContent = all.length ? '没有符合条件的课程。' : '课程目录还没加载出来（检查 data/courses.json 是否可访问）。';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      rows.forEach(function (c) {
        var tr = document.createElement('tr');
        var tdTitle = document.createElement('td');
        tdTitle.appendChild(linkTo(null, c.title || c.slug, '#/course/' + c.slug));
        if (c.doneMinutes) tdTitle.appendChild(ui.el('div', 'muted small', '已学 ' + fmt.minutes(c.doneMinutes)));
        tr.appendChild(tdTitle);

        var tdLine = ui.el('td', 'small muted', c.line || '—');
        tr.appendChild(tdLine);

        var tdDone = ui.el('td', 'num', c.done + ' / ' + c.total);
        tr.appendChild(tdDone);

        var tdPct = ui.el('td', 'num');
        tdPct.appendChild(ui.el('span', null, c.pct + '%'));
        var bar = ui.bar(c.done, c.total);
        tdPct.appendChild(bar);
        tr.appendChild(tdPct);

        var tdMin = ui.el('td', 'num small', c.minutes ? fmt.minutes(c.minutes) : '—');
        tr.appendChild(tdMin);
        tbody.appendChild(tr);
      });
    }

    function openEditor(it) {
      if (!ui.modal) return;
      var box = ui.el('div');
      box.appendChild(ui.el('p', 'small muted', subTitle(it) + ' · 支持 Markdown，⌘/Ctrl + S 直接保存'));
      var ta = document.createElement('textarea');
      ta.className = 'notes-editor';
      ta.value = it.text || '';
      ta.placeholder = '这节课的笔记…';
      box.appendChild(ta);
      var preview = ui.el('div', 'notes-preview hidden');
      box.appendChild(preview);
      var bar = ui.el('div', 'row');
      var bPreview = btnEl('btn btn--sm btn--ghost', '预览');
      var bEdit = btnEl('btn btn--sm btn--ghost hidden', '回到编辑');
      bar.appendChild(bPreview);
      bar.appendChild(bEdit);
      box.appendChild(bar);
      bPreview.addEventListener('click', function () {
        preview.innerHTML = mdHtml(ta.value);
        preview.classList.remove('hidden');
        ta.classList.add('hidden');
        bPreview.classList.add('hidden');
        bEdit.classList.remove('hidden');
      });
      bEdit.addEventListener('click', function () {
        preview.classList.add('hidden');
        ta.classList.remove('hidden');
        bPreview.classList.remove('hidden');
        bEdit.classList.add('hidden');
        ta.focus();
      });
      ta.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          var save = document.querySelector('#modal-root .modal-foot .btn--primary');
          if (save) save.click();
        }
      });
      setTimeout(function () { ta.focus(); }, 40);

      ui.modal({
        title: '编辑笔记 · ' + (it.title || it.id),
        body: box,
        actions: [
          { label: '删除', danger: true, value: 'delete' },
          { label: '取消', value: null },
          { label: '保存', primary: true, value: 'save' },
        ],
      }).then(function (v) {
        if (v === 'save') {
          var text = ta.value;
          if (!text.trim() && (it.text || '').trim()) {
            ui.confirm('保存空内容？', '保存空内容会删除这条笔记，确定吗？', '删除笔记').then(function (ok) {
              if (!ok) return;
              store.deleteNote(it.id);
              toast('已删除笔记');
              refresh();
            });
            return;
          }
          store.setNote(it.id, text);
          toast('笔记已保存');
          refresh();
        } else if (v === 'delete') {
          removeNote(it);
        }
      });
    }

    function removeNote(it) {
      ui.confirm('删除这条笔记？', '「' + fmt.esc(fmt.clamp(it.title || it.id, 40)) + '」的笔记会被删除，且不可撤销。', '删除').then(function (ok) {
        if (!ok) return;
        store.deleteNote(it.id);
        toast('已删除笔记');
        refresh();
      });
    }

    function paintNotes() {
      var list = store.notesList();
      ui.clear(notesBox);
      if (!list.length) {
        notesBox.appendChild(ui.el('p', 'muted small', '还没有笔记：在任意课时页右侧的「笔记」里写下想法，就会汇总到这里。'));
      }
      list.forEach(function (it) {
        var row = ui.el('div', 'note-row');
        var main = rowMain(it, '更新于 ' + fmt.rel(it.updatedAt) + (it.minutes ? ' · 约 ' + it.minutes + ' 分钟' : ''));
        main.appendChild(ui.el('div', 'nr-text', fmt.clamp(it.text, 240)));
        row.appendChild(main);
        var acts = ui.el('div', 'row');
        var edit = btnEl('btn btn--sm btn--ghost', '编辑');
        edit.addEventListener('click', function () { openEditor(it); });
        var del = btnEl('btn btn--sm btn--danger', '删除');
        del.addEventListener('click', function () { removeNote(it); });
        acts.appendChild(edit);
        acts.appendChild(del);
        row.appendChild(acts);
        notesBox.appendChild(row);
      });

      var bms = store.bookmarkList();
      ui.clear(bmBox);
      if (!bms.length) {
        bmBox.appendChild(ui.el('p', 'muted small', '还没有收藏的课时：课时页的「收藏」按钮会把它加到这里。'));
      }
      bms.forEach(function (it) {
        var row = ui.el('div', 'note-row');
        row.appendChild(rowMain(it, '收藏于 ' + fmt.rel(it.bookmarkedAt)));
        row.appendChild(ui.el('span', 'badge', '收藏'));
        row.appendChild(linkTo('btn btn--sm btn--ghost', '打开', it.route));
        bmBox.appendChild(row);
      });

      var none = !list.length && !bms.length;
      if (tabEls.notes) tabEls.notes.classList.toggle('hidden', none);
      secNotes.classList.toggle('hidden', none);
    }

    /* ---------- 学习数据：导出 / 导入 / 危险区 ---------- */
    function ioSection() {
      var sec = section('me-data', '学习数据', '纯前端文件读写：数据不出浏览器。导入前建议先导出一份 JSON 做备份。');
      var grid = ui.el('div', 'io-grid');

      /* 导出 */
      var c1 = ui.el('div', 'io-card');
      c1.appendChild(ui.el('h3', null, '导出'));
      c1.appendChild(ui.el('p', 'small muted', 'JSON 含进度 / 笔记 / 收藏，可在另一台设备导入；Markdown 只有笔记原文，方便贴进其它笔记软件。'));
      c1.appendChild(ioSummary);
      var acts1 = ui.el('div', 'io-actions');
      var bJson = btnEl('btn btn--primary', '导出 JSON');
      var bMd = btnEl('btn', '导出 Markdown 笔记');
      var bCopy = btnEl('btn btn--ghost', '复制到剪贴板');
      acts1.appendChild(bJson);
      acts1.appendChild(bMd);
      acts1.appendChild(bCopy);
      c1.appendChild(acts1);
      bJson.addEventListener('click', function () {
        var text = store.exportJSON();
        if (download('llm-learn-学习数据-' + ymd() + '.json', text, 'application/json')) {
          toast('已导出 JSON（' + store.stats().notes + ' 条笔记）');
        }
      });
      bMd.addEventListener('click', function () {
        var md = store.exportMarkdown();
        if (download('llm-learn-学习笔记-' + ymd() + '.md', md, 'text/markdown')) toast('已导出 Markdown 笔记');
      });
      bCopy.addEventListener('click', function () {
        copyText(store.exportJSON()).then(function (ok) {
          if (ok) toast('学习数据 JSON 已复制到剪贴板');
          else toast('复制失败，请用「导出 JSON」下载文件', 'warn');
        });
      });

      /* 导入 */
      var c2 = ui.el('div', 'io-card');
      c2.appendChild(ui.el('h3', null, '导入'));
      c2.appendChild(ui.el('p', 'small muted', '选择本站导出的 JSON 文件，或把 JSON 文本粘贴到下面。'));
      var fileRow = ui.el('div', 'row');
      var file = document.createElement('input');
      file.type = 'file';
      file.accept = '.json,application/json';
      file.setAttribute('aria-label', '选择学习数据 JSON 文件');
      fileRow.appendChild(file);
      c2.appendChild(fileRow);
      var ta = document.createElement('textarea');
      ta.className = 'notes-editor';
      ta.placeholder = '…或把 JSON 粘贴到这里';
      c2.appendChild(ta);
      var modeRow = ui.el('div', 'row');
      modeRow.appendChild(ui.el('span', 'small muted', '导入方式：'));
      var modeInputs = {};
      [['merge', '合并（推荐）'], ['replace', '覆盖']].forEach(function (m) {
        var lab = ui.el('label', 'small');
        var r = document.createElement('input');
        r.type = 'radio';
        r.name = 'me-import-mode';
        r.value = m[0];
        if (m[0] === 'merge') r.checked = true;
        modeInputs[m[0]] = r;
        lab.appendChild(r);
        lab.appendChild(document.createTextNode(' ' + m[1]));
        modeRow.appendChild(lab);
      });
      c2.appendChild(modeRow);
      var acts2 = ui.el('div', 'io-actions');
      var bImport = btnEl('btn btn--primary', '导入');
      acts2.appendChild(bImport);
      c2.appendChild(acts2);
      c2.appendChild(ui.el('p', 'small muted', '合并 = 进度取并集、笔记按更新时间取新者；覆盖 = 用文件整体替换本机数据（主题保留）。'));

      function doImport(text) {
        var mode = modeInputs.replace && modeInputs.replace.checked ? 'replace' : 'merge';
        var go = mode === 'replace'
          ? ui.confirm('覆盖导入？', '覆盖会丢弃本机现有的进度、笔记与收藏（主题保留），且不可撤销。', '覆盖导入')
          : Promise.resolve(true);
        go.then(function (ok) {
          if (!ok) return;
          var res = store.importJSON(text, { mode: mode });
          if (!res.ok) { toast('导入失败：' + (res.error || '未知错误'), 'err'); return; }
          toast('导入完成（' + (mode === 'replace' ? '覆盖' : '合并') + '）：新增 ' + res.added + ' · 更新 ' + res.updated + ' · 跳过 ' + res.skipped);
          ta.value = '';
          refresh();
        });
      }
      bImport.addEventListener('click', function () {
        var text = (ta.value || '').trim();
        if (!text) { toast('先选择文件或粘贴 JSON', 'warn'); return; }
        doImport(text);
      });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { file.value = ''; doImport(String(fr.result || '')); };
        fr.onerror = function () { toast('读取文件失败', 'err'); };
        fr.readAsText(f);
      });

      /* 危险区 */
      var c3 = ui.el('div', 'io-card');
      c3.appendChild(ui.el('h3', null, '危险区'));
      c3.appendChild(ui.el('p', 'small muted', '清空本机的进度 / 笔记 / 收藏（主题与显示偏好保留）。不可撤销，建议先导出 JSON。'));
      var acts3 = ui.el('div', 'io-actions');
      var bClear = btnEl('btn btn--danger', '清空学习数据');
      acts3.appendChild(bClear);
      c3.appendChild(acts3);
      bClear.addEventListener('click', function () {
        ui.confirm('清空学习数据？', '本机保存的<b>全部进度、笔记与收藏</b>都会被删除，且无法恢复。', '清空').then(function (ok) {
          if (!ok) return;
          store.clearAll();
          toast('已清空学习数据');
          refresh();
        });
      });

      grid.appendChild(c1);
      grid.appendChild(c2);
      grid.appendChild(c3);
      sec.appendChild(grid);
      return sec;
    }

    /* ---------- 编排 ---------- */
    function paint() {
      var st = store.stats();
      var empty = !st.doneLessons && !st.notes && !st.bookmarks;
      banner.classList.toggle('hidden', !empty);
      secOverview.classList.toggle('hidden', empty);
      secRecent.classList.toggle('hidden', empty);
      secTable.classList.toggle('hidden', empty);
      if (ioSummary) {
        ioSummary.textContent = '当前本机数据：已完成 ' + st.doneLessons + ' 课时 · ' + st.notes + ' 条笔记 · ' + st.bookmarks + ' 个收藏。';
      }
      paintOverview();
      paintRecent();
      paintTable();
      paintNotes();
    }
    function load() {
      return Promise.all([
        store.statsByCourse ? store.statsByCourse() : Promise.resolve(null),
        store.nextLesson ? store.nextLesson() : Promise.resolve(null),
      ]).then(function (res) {
        BY = res[0] || BY;
        BY.next = res[1] || null;
      }).catch(function () { /* 元数据失败也要能看笔记与导出 */ });
    }
    function refresh() {
      return load().then(paint).catch(function (e) {
        if (root.console) console.error('我的学习：重画失败', e);
      });
    }

    var unsub = null;
    var repaintTimer = null;
    return refresh().then(function () {
      if (store.onChange) {
        unsub = store.onChange(function () {
          if (repaintTimer) clearTimeout(repaintTimer);
          repaintTimer = setTimeout(function () { repaintTimer = null; refresh(); }, 150);
        });
      }
      // 子页锚点：等 app.js 的「回到顶部」跑完再滚，否则会被它拉回去
      if (want) {
        setTimeout(function () {
          var tab = TABS.filter(function (t) { return t.key === want; })[0];
          var target = tab && document.getElementById(tab.id);
          if (target && !target.classList.contains('hidden') && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
        }, 40);
      }
      return function cleanup() {
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
      };
    });
  }

  views.me = { render: render };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/views-search.js ===== */
/* ============================================================================
 * llm-learn 学习站 · 搜索页（#/search/<q>）
 * ① 先出「标题/小标题/词条」级结果（秒回，用紧凑索引）
 * ② 用户点「全文深搜」再逐课加载正文分片（20MB 不该在首屏就下载）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  function snippet(text, q, width) {
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return fmt.esc(fmt.clamp(text, width || 160));
    var start = Math.max(0, i - 60);
    var seg = (start > 0 ? '…' : '') + text.slice(start, start + (width || 200)) + '…';
    return fmt.highlight(seg, q);
  }

  views.search = {
    render: function (rootEl, route) {
      var q = decodeURIComponent(route.seg[1] || route.query.q || '').trim();
      LLM.setTitle(q ? '搜索：' + q : '搜索');

      var wrap = ui.el('div', 'container');
      rootEl.appendChild(wrap);

      var head = ui.el('div', 'page-head');
      head.appendChild(ui.el('h1', null, q ? '搜索「' + q + '」' : '搜索'));
      head.appendChild(ui.el('p', null, '先匹配课程名、课时标题与小标题；要翻正文内容，点「搜正文」。'));
      wrap.appendChild(head);

      var form = ui.el('div', 'filters');
      var input = ui.el('input');
      input.type = 'search';
      input.value = q;
      input.placeholder = '输入关键词后回车';
      form.appendChild(input);
      var goBtn = ui.el('button', 'btn btn--primary btn--sm', '搜索');
      form.appendChild(goBtn);
      var deepBtn = ui.el('button', 'btn btn--sm', '搜正文（慢一点）');
      form.appendChild(deepBtn);
      var deepInfo = ui.el('span', 'deep-progress');
      form.appendChild(deepInfo);
      wrap.appendChild(form);

      var list = ui.el('div', 'result-list');
      var status = ui.el('div', 'section-sub');
      status.style.margin = '16px 0 10px';
      wrap.appendChild(status);
      wrap.appendChild(list);

      var cancelled = false;
      var deepCache = null;

      function go() {
        var v = input.value.trim();
        LLM.go('#/search/' + encodeURIComponent(v));
      }
      goBtn.addEventListener('click', go);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

      function renderQuick() {
        ui.clear(list);
        if (!q) {
          status.textContent = '输入关键词开始搜索';
          return;
        }
        status.textContent = '正在索引…';
        (LLM.search ? LLM.search.build() : Promise.reject(new Error('搜索索引未就绪')))
          .then(function () {
            var res = LLM.search.run(q).filter(function (r) { return r.kind !== 'term' || true; });
            status.textContent = '标题 / 小标题 / 词条 命中 ' + res.length + ' 条';
            if (!res.length) {
              list.innerHTML = '<div class="empty"><strong>没有命中</strong><p class="small">试试更短的关键词，或用「全文深搜」翻正文。</p>' +
                '<p><button class="btn btn--primary" id="deep-cta">全文深搜</button></p></div>';
              var cta = list.querySelector('#deep-cta');
              if (cta) cta.addEventListener('click', deep);
              return;
            }
            res.slice(0, 60).forEach(function (r) {
              var a = ui.el('a', 'result');
              if (r.kind === 'lesson') {
                a.href = '#/l/' + r.item.id;
                a.innerHTML = '<div class="r-title">' + fmt.highlight(r.item.title, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.slug) + ' › ' + fmt.esc(r.item.chapter || '') + '</div>' +
                  (r.item.heads ? '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.heads, 150), q) + '</div>' : '');
              } else if (r.kind === 'course') {
                a.href = '#/course/' + r.item.slug;
                a.innerHTML = '<div class="r-title">课程：' + fmt.highlight(r.item.title, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.line || '') + '</div>' +
                  '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.desc || '', 150), q) + '</div>';
              } else {
                a.href = '#/glossary/t/' + r.item.key;
                a.innerHTML = '<div class="r-title">词条：' + fmt.highlight(r.item.zh, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.layerName || '') + ' · ' + fmt.esc(r.item.en || '') + '</div>' +
                  '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.def || '', 150), q) + '</div>';
              }
              list.appendChild(a);
            });
          })
          .catch(function (e) {
            status.textContent = '';
            list.innerHTML = '<div class="empty"><strong>搜索索引加载失败</strong><p class="small">' + fmt.esc(e.message) + '</p></div>';
          });
      }

      /** 全文深搜：逐课加载 data/text/<slug>.json，边加载边出结果 */
      function deep() {
        if (!q) return;
        ui.clear(list);
        deepBtn.disabled = true;
        status.textContent = '全文深搜中…';
        var needle = q.toLowerCase();
        var hits = [];
        var loaded = 0, totalCourses = 0;
        deepCache = deepCache || null;

        function loadOne(slug) {
          return data.text(slug).then(function (lessons) {
            lessons.forEach(function (ls) {
              var x = String(ls.x || '');
              if (x.toLowerCase().indexOf(needle) < 0) return;
              hits.push({ id: ls.id, title: ls.t, text: x, slug: slug });
            });
          }).catch(function () { return null; });
        }

        data.courses().then(function (courses) {
          totalCourses = courses.length;
          var chain = Promise.resolve();
          courses.forEach(function (c) {
            chain = chain.then(function () {
              if (cancelled) return null;
              return loadOne(c.slug).then(function () {
                loaded++;
                deepInfo.innerHTML = '<span class="spinner"></span> 已扫 ' + loaded + ' / ' + totalCourses + ' 门课 · 命中 ' + hits.length + ' 条';
                if (loaded % 6 === 0) paintDeep();
              });
            });
          });
          return chain.then(function () {
            if (cancelled) return;
            deepBtn.disabled = false;
            deepInfo.textContent = '';
            status.textContent = '全文命中 ' + hits.length + ' 条（扫描了 ' + totalCourses + ' 门课的正文）';
            paintDeep();
          });
        });

        function paintDeep() {
          ui.clear(list);
          if (!hits.length) {
            list.innerHTML = '<div class="empty"><strong>正文里也没有出现「' + fmt.esc(q) + '」</strong></div>';
            return;
          }
          hits.slice(0, 200).forEach(function (h) {
            var idx = (LLM.search && LLM.search.index && LLM.search.index()) || {};
            var m = (idx.lessons || []).filter(function (l) { return l.id === h.id; })[0];
            var a = ui.el('a', 'result');
            a.href = '#/l/' + h.id;
            a.innerHTML = '<div class="r-title">' + fmt.highlight(h.title, q) + '</div>' +
              '<div class="r-path">' + fmt.esc(h.slug) + (m ? ' › ' + fmt.esc(m.chapter || '') : '') + '</div>' +
              '<div class="r-snippet">' + snippet(h.text, q) + '</div>';
            list.appendChild(a);
          });
          if (hits.length > 200) {
            var more = ui.el('div', 'section-sub', '只显示前 200 条，共 ' + hits.length + ' 条命中');
            list.appendChild(more);
          }
        }
      }
      deepBtn.addEventListener('click', deep);

      renderQuick();
      return function cleanup() { cancelled = true; };
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* ===== assets/particles.js ===== */
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

;
/* ===== assets/app.js ===== */
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


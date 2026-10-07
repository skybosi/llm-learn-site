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

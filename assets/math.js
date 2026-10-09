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

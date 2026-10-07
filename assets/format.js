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

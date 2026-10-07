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

  var api = {
    get: fetchJSON,
    site: function () { return fetchJSON('data/site.json'); },
    courses: function () { return fetchJSON('data/courses.json').then(function (d) { return d.courses; }); },
    course: function (slug) { return fetchJSON('data/course/' + slug + '.json'); },
    search: function () { return fetchJSON('data/search.json').then(function (d) { return d.items; }); },
    text: function (slug) { return fetchJSON('data/text/' + slug + '.json').then(function (d) { return d.lessons; }); },
    figures: function () { return fetchJSON('data/figures.json'); },
    /** 课时 → 本课涉及的关键词（构建期从百科指针反转而来） */
    lessonTerms: function () { return fetchJSON('data/lesson-terms.json').then(function (d) { return d.lessons || {}; }); },
    glossaryIndex: function () { return fetchJSON('data/glossary/index.json'); },
    glossaryLayer: function (id) { return fetchJSON('data/glossary/' + id + '.json'); },

    /** 全站课时索引：id → {c,ch,l,t,ct,seq,p}（构建期从 dist/lessons.json 拷来） */
    lessons: function () {
      if (lessonIndexCache) return Promise.resolve(lessonIndexCache);
      return fetchJSON('data/lessons.json').then(function (d) {
        lessonIndexCache = d.lessons || {};
        return lessonIndexCache;
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

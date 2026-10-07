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
      try { p = fetchJSON('data/site.json'); } catch (e) { p = null; }
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
    if (!readyP) readyP = Promise.all([loadSite(), loadLessonIndex(), loadCards()]).then(function () { return true; });
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

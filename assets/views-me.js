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
    head.appendChild(ui.el('p', null, '进度与笔记只保存在本机浏览器（localStorage），换设备请用导出/导入。'));
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

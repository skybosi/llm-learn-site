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

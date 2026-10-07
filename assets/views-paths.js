/* ============================================================================
 * llm-learn 学习站 · 学习路径页 + 岗位/方向线总览 + 404
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  function chipsFor(slugs, bySlug) {
    var box = ui.el('div', 'path-chain');
    slugs.forEach(function (s, i) {
      var c = bySlug[s];
      if (i) box.appendChild(ui.el('span', 'chain-arrow', '→'));
      var a = ui.el('a', 'chain-item', c ? c.title : s);
      a.href = '#/course/' + s;
      if (c) a.title = c.counts.lessons + ' 课时 · ' + fmt.minutes(c.counts.minutes);
      box.appendChild(a);
    });
    return box;
  }

  views.paths = {
    render: function (rootEl) {
      LLM.setTitle('学习路径');
      var wrap = ui.el('div', 'container');
      rootEl.appendChild(wrap);
      wrap.innerHTML = '<div class="skeleton" style="height:200px"></div>' +
        '<div class="skeleton" style="height:200px;margin-top:14px"></div>';

      var progressP = (LLM.store && LLM.store.statsByCourse)
        ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
        : Promise.resolve({ courses: [] });

      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], courses = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        var bySlug = {};
        courses.forEach(function (c) { bySlug[c.slug] = c; });
        ui.clear(wrap);

        var head = ui.el('div', 'page-head');
        head.appendChild(ui.el('h1', null, '学习路径'));
        head.appendChild(ui.el('p', null, '路径只规定「目标课」，前置链按课程依赖自动展开。选一条最接近你目标的，按顺序走；' +
          '途中想深挖某个主题，随时用关键词百科或课程地图插队。'));
        wrap.appendChild(head);

        /* ---------- 目标路径 ---------- */
        var sec = ui.el('section', 'section');
        var sh = ui.el('div', 'section-head');
        var shl = ui.el('div');
        shl.appendChild(ui.el('h2', 'section-title', (site.paths || []).length + ' 条目标路径'));
        shl.appendChild(ui.el('p', 'section-sub', '按「学完要做什么」选，而不是按课程名选。'));
        sh.appendChild(shl);
        sec.appendChild(sh);
        var grid = ui.el('div', 'paths-grid');
        (site.paths || []).forEach(function (p) {
          grid.appendChild(LLM.views.home ? pathCardFromHome(p, bySlug, pm) : ui.el('div'));
        });
        sec.appendChild(grid);
        wrap.appendChild(sec);

        /* ---------- 岗位 ---------- */
        if ((site.roles || []).length) {
          var rsec = ui.el('section', 'section');
          var rh = ui.el('div', 'section-head');
          var rhh = ui.el('div');
          rhh.appendChild(ui.el('h2', 'section-title', '按岗位看：学完能应聘什么'));
          rhh.appendChild(ui.el('p', 'section-sub', '每个岗位列出它需要的课程集合 —— 之间可能有重叠，重叠部分就是通用地基。'));
          rh.appendChild(rhh);
          rsec.appendChild(rh);
          (site.roles || []).forEach(function (r) {
            var box = ui.el('div', 'line-block');
            var lh = ui.el('div', 'line-head');
            lh.appendChild(ui.el('h3', null, r.name));
            var totalLessons = (r.slugs || []).reduce(function (n, s) { return n + (bySlug[s] ? bySlug[s].counts.lessons : 0); }, 0);
            lh.appendChild(ui.el('span', 'line-kind', (r.slugs || []).length + ' 门课 · ' + totalLessons + ' 课时'));
            box.appendChild(lh);
            box.appendChild(chipsFor(r.slugs || [], bySlug));
            rsec.appendChild(box);
          });
          wrap.appendChild(rsec);
        }

        /* ---------- 方向线 ---------- */
        var lsec = ui.el('section', 'section');
        var lh2 = ui.el('div', 'section-head');
        var lhh = ui.el('div');
        lhh.appendChild(ui.el('h2', 'section-title', '9 条方向线'));
        lhh.appendChild(ui.el('p', 'section-sub', '主干 5 条（线内有前置链）+ 应用与领域 4 条。'));
        lh2.appendChild(lhh);
        lsec.appendChild(lh2);
        (site.families || []).forEach(function (fam) {
          var ft = ui.el('div', 'family-title');
          ft.appendChild(ui.el('h2', null, fam.name));
          lsec.appendChild(ft);
          (fam.lines || []).forEach(function (lineName) {
            var line = (site.lines || []).filter(function (l) { return l.name === lineName; })[0];
            if (!line) return;
            var box = ui.el('div', 'line-block');
            var lh = ui.el('div', 'line-head');
            lh.appendChild(ui.el('h3', null, lineName));
            var lessonsTotal = (line.slugs || []).reduce(function (n, s) { return n + (bySlug[s] ? bySlug[s].counts.lessons : 0); }, 0);
            var doneTotal = (line.slugs || []).reduce(function (n, s) { return n + (pm[s] ? pm[s].done : 0); }, 0);
            lh.appendChild(ui.el('span', 'line-kind', (line.slugs || []).length + ' 门课 · ' + lessonsTotal + ' 课时 · 已学 ' + doneTotal));
            if (line.kind === 'spine') lh.appendChild(ui.el('span', 'badge badge--warn', '主干线'));
            box.appendChild(lh);
            box.appendChild(chipsFor(line.slugs || [], bySlug));
            lsec.appendChild(box);
          });
        });
        wrap.appendChild(lsec);
        return null;
      });
    },
  };

  /** 复用首页的路径卡（views-home 先加载） */
  function pathCardFromHome(p, bySlug, pm) {
    var card = ui.el('div', 'card path-card');
    var head = ui.el('div', 'path-head');
    head.appendChild(ui.el('div', 'path-glyph', p.glyph || '学'));
    var tw = ui.el('div');
    tw.appendChild(ui.el('h3', null, p.name));
    if (p.group) tw.appendChild(ui.el('div', 'small muted', p.group));
    head.appendChild(tw);
    card.appendChild(head);
    card.appendChild(ui.el('p', 'path-why', p.why || ''));
    card.appendChild(chipsFor((p.courses || []).map(function (c) { return c.slug; }), bySlug));
    var done = 0, total = 0;
    (p.courses || []).forEach(function (c) {
      if (pm[c.slug]) { done += pm[c.slug].done; total += pm[c.slug].total; }
      else total += c.lessons || 0;
    });
    var foot = ui.el('div', 'path-foot');
    foot.appendChild(ui.ring(done, total, { size: 'sm' }));
    foot.appendChild(ui.el('div', 'small muted', done + ' / ' + total + ' 课时'));
    var goal = (p.courses || [])[p.courses.length - 1];
    if (goal) {
      var go = ui.el('a', 'btn btn--sm btn--primary', '开始这条路径');
      go.href = '#/course/' + goal.slug;
      foot.appendChild(go);
    }
    card.appendChild(foot);
    return card;
  }

  /* ---------------- 404 ---------------- */
  views.notfound = {
    render: function (rootEl, route) {
      LLM.setTitle('页面不存在');
      var wrap = ui.el('div', 'container container--narrow');
      ui.clear(rootEl);
      rootEl.appendChild(wrap);
      return data.site().then(function (site) {
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

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

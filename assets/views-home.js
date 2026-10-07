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
    head.appendChild(ui.el('div', 'path-glyph', p.glyph || '学'));
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
      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], courses = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        {
          var bySlug = {};
          courses.forEach(function (c) { bySlug[c.slug] = c; });

          /* ---------- hero ---------- */
          var hero = ui.el('section', 'hero');
          var inner = ui.el('div', 'hero-inner');
          var left = ui.el('div');
          left.appendChild(ui.el('span', 'hero-eyebrow', '纯静态学习站 · 无需登录 · 进度与笔记存在你自己的浏览器'));
          var h1 = ui.el('h1');
          h1.innerHTML = '把大模型从<em>数学地基</em>学到<em>推理部署</em>';
          left.appendChild(h1);
          left.appendChild(ui.el('p', 'hero-lead',
            site.counts.courses + ' 门课 · ' + site.counts.chapters + ' 章 · ' + site.counts.lessons +
            ' 个课时，按 9 条方向线组织：每个概念都从「为什么需要」讲到「怎么算、怎么调、代价是什么」。' +
            '公式本地渲染、' + fmt.num(site.counts.figures) + ' 张图表、' + fmt.num(site.counts.glossaryTerms) + ' 条关键词百科。'));
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
          var mapSec = ui.el('section', 'section');
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
            famBox.appendChild(ft);
            (fam.lines || []).forEach(function (lineName) {
              var list = byLine[lineName] || [];
              if (!list.length) return;
              var lb = ui.el('div', 'line-block');
              var lh = ui.el('div', 'line-head');
              var lh3 = ui.el('h3', null, lineName);
              lh.appendChild(lh3);
              var totalLessons = list.reduce(function (n, c) { return n + c.counts.lessons; }, 0);
              lh.appendChild(ui.el('span', 'line-kind', list.length + ' 门课 · ' + totalLessons + ' 课时'));
              lb.appendChild(lh);
              var g = ui.el('div', 'grid grid--wide');
              list.forEach(function (c) { g.appendChild(courseCard(c, { progress: pm[c.slug] })); });
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
        var c = ui.el('div', 'container');
        c.innerHTML = '<div class="empty"><strong>站点数据加载失败</strong><p class="small">' +
          fmt.esc(e.message) + '</p><p class="small">如果你是从本地文件直接打开（file://），浏览器会拦截数据请求：请用本地静态服务预览（例如 <code>python3 -m http.server</code>）。</p></div>';
        rootEl.appendChild(c);
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

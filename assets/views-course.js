/* ============================================================================
 * llm-learn 学习站 · 课程详情页
 * 一页看清：这门课解决什么问题 / 学完能做到什么 / 每一章每一课 / 我的进度
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  function lessonSlugOf(file) {
    return String(file || '').split('/').pop().replace(/\.md$/, '');
  }
  function routeOfLesson(course, chapter, lesson) {
    return '#/learn/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file);
  }

  /** 扁平课时序列（跨章），用于「继续学习」与上一课/下一课 */
  function flatLessons(course) {
    var out = [];
    course.chapters.forEach(function (ch) {
      ch.lessons.forEach(function (ls, i) {
        out.push({
          id: ls.id, title: ls.title, chapter: ch, lesson: ls,
          route: routeOfLesson(course, ch, ls),
          chapterSeq: i + 1, chapterTotal: ch.lessons.length,
        });
      });
    });
    return out;
  }
  views.flatLessons = flatLessons;
  views.routeOfLesson = routeOfLesson;
  views.lessonSlugOf = lessonSlugOf;

  views.course = {
    render: function (rootEl, route) {
      var slug = route.seg[1];
      var wrap = ui.el('div');
      rootEl.appendChild(wrap);
      var skeleton = ui.el('div', 'container');
      skeleton.innerHTML = '<div class="skeleton" style="height:34px;width:280px"></div>' +
        '<div class="skeleton" style="height:120px;margin-top:14px"></div>' +
        '<div class="skeleton" style="height:260px;margin-top:14px"></div>';
      wrap.appendChild(skeleton);

      return data.course(slug).then(function (course) {
        LLM.setTitle(course.title);
        var flat = flatLessons(course);
        var progressP = (LLM.store && LLM.store.statsByCourse)
          ? LLM.store.statsByCourse().catch(function () { return { courses: [] }; })
          : Promise.resolve({ courses: [] });
        return progressP.then(function (st) {
          var mine = null;
          (st.courses || []).forEach(function (c) { if (c.slug === slug) mine = c; });
          var doneMap = {};
          flat.forEach(function (f) {
            doneMap[f.id] = LLM.store && LLM.store.isDone ? LLM.store.isDone(f.id) : false;
          });
          var done = flat.filter(function (f) { return doneMap[f.id]; }).length;

          ui.clear(wrap);

          /* ---------- hero ---------- */
          var hero = ui.el('section', 'course-hero');
          // 背景用 **无文字版封面**（`_plain.svg`）：带标题的封面当背景会透出巨字压住 H1
          var bgSrc = course.coverPlain || course.cover;
          if (bgSrc) {
            var bg = ui.el('div', 'course-hero-bg');
            bg.style.backgroundImage = 'url("' + bgSrc + '")';
            hero.appendChild(bg);
          }
          var inner = ui.el('div', 'course-hero-inner');
          var left = ui.el('div');
          var crumb = ui.el('div', 'course-crumb');
          var home = ui.el('a', null, '首页'); home.href = '#/';
          var all = ui.el('a', null, '全部课程'); all.href = '#/courses';
          crumb.appendChild(home);
          crumb.appendChild(ui.el('span', null, '›'));
          crumb.appendChild(all);
          if (course.family) {
            crumb.appendChild(ui.el('span', null, '›'));
            crumb.appendChild(ui.el('span', null, course.family));
          }
          left.appendChild(crumb);
          left.appendChild(ui.el('h1', 'course-h1', course.title));
          left.appendChild(ui.el('p', 'course-lead', course.description || ''));
          var badges = ui.el('div', 'row row--wrap');
          if (course.difficulty) badges.appendChild(ui.el('span', 'badge badge--level', course.difficulty));
          if (course.line) badges.appendChild(ui.el('span', 'badge badge--line', course.line));
          badges.appendChild(ui.el('span', 'badge', course.counts.chapters + ' 章'));
          badges.appendChild(ui.el('span', 'badge', course.counts.lessons + ' 课时'));
          badges.appendChild(ui.el('span', 'badge', course.counts.figures + ' 图'));
          badges.appendChild(ui.el('span', 'badge', fmt.minutes(course.counts.minutes)));
          (course.top_tags || []).forEach(function (t) { badges.appendChild(ui.el('span', 'tag', t)); });
          left.appendChild(badges);

          var actions = ui.el('div', 'row row--wrap');
          actions.style.marginTop = '18px';
          var next = flat.filter(function (f) { return !doneMap[f.id]; })[0] || flat[0];
          var go = ui.el('a', 'btn btn--primary', done ? '继续学习' : '开始学习');
          go.href = next ? next.route : '#/courses';
          actions.appendChild(go);
          if (done) {
            var first = ui.el('a', 'btn btn--ghost', '从第一课重看');
            first.href = flat.length ? flat[0].route : '#/courses';
            actions.appendChild(first);
          }
          var figs = ui.el('a', 'btn btn--ghost', '本课图表（' + course.counts.figures + '）');
          figs.href = '#/figures/' + course.slug;
          actions.appendChild(figs);
          var copy = ui.el('button', 'btn btn--ghost btn--sm', '复制链接');
          copy.addEventListener('click', function () {
            var url = location.href;
            (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
              .then(function () { ui.toast('课程链接已复制', 'ok'); })
              .catch(function () { ui.toast('复制失败，请手动复制地址栏', 'warn'); });
          });
          actions.appendChild(copy);
          left.appendChild(actions);
          inner.appendChild(left);

          var right = ui.el('div', 'course-side');
          if (course.cover) {
            var coverCard = ui.el('div', 'course-cover-card');
            var im = ui.el('img');
            im.src = course.cover;
            im.alt = course.title + ' 封面';
            im.loading = 'lazy';
            coverCard.appendChild(im);
            right.appendChild(coverCard);
          }
          var pb = ui.el('div', 'side-box');
          var ph = ui.el('div', 'spread');
          ph.appendChild(ui.ring(done, flat.length, { title: '本课进度' }));
          var ptext = ui.el('div');
          ptext.style.textAlign = 'right';
          ptext.appendChild(ui.el('div', 'small muted', '已完成'));
          ptext.appendChild(ui.el('div', null, done + ' / ' + flat.length + ' 课时'));
          ph.appendChild(ptext);
          pb.appendChild(ph);
          pb.appendChild(ui.el('div', 'bar bar--ok')).appendChild(ui.el('i'));
          var barEl = pb.querySelector('.bar > i');
          if (barEl) barEl.style.width = fmt.pct(done, flat.length) + '%';
          pb.appendChild(ui.el('h4', null, '学习统计'));
          [['章节', course.counts.chapters + ' 章'], ['课时', course.counts.lessons + ' 课时'],
           ['预计时长', fmt.minutes(course.counts.minutes)], ['图表', course.counts.figures + ' 张'],
           ['公式', flat.filter(function (f) { return f.lesson.math; }).length + ' 课含公式']].forEach(function (kv) {
            var row = ui.el('div', 'kv');
            row.appendChild(ui.el('span', 'muted', kv[0]));
            row.appendChild(ui.el('b', null, kv[1]));
            pb.appendChild(row);
          });
          right.appendChild(pb);
          inner.appendChild(right);
          hero.appendChild(inner);
          wrap.appendChild(hero);

          var body = ui.el('div', 'container');

          /* ---------- 学完能做到 ---------- */
          if ((course.grants || []).length) {
            var gsec = ui.el('section', 'section');
            gsec.appendChild(ui.el('h2', 'section-title', '学完这门课，你应该能做到'));
            var ul = ui.el('ul', 'grants');
            course.grants.forEach(function (g) { ul.appendChild(ui.el('li', null, g)); });
            gsec.appendChild(ul);
            body.appendChild(gsec);
          }

          /* ---------- 章节与课时 ---------- */
          var csec = ui.el('section', 'section');
          var ch = ui.el('div', 'section-head');
          var chl = ui.el('div');
          chl.appendChild(ui.el('h2', 'section-title', '章节目录'));
          chl.appendChild(ui.el('p', 'section-sub', '点任意课时开始；左侧（手机上是抽屉）会跟着你所在的课程走。'));
          ch.appendChild(chl);
          var expand = ui.el('button', 'btn btn--ghost btn--sm', '展开全部');
          ch.appendChild(expand);
          csec.appendChild(ch);

          var acc = ui.el('div', 'chapter-acc');
          var openState = {};
          course.chapters.forEach(function (chapter, ci) {
            var hasNext = chapter.lessons.some(function (ls) { return flat.filter(function (f) { return !doneMap[f.id]; })[0] &&
              flat.filter(function (f) { return !doneMap[f.id]; })[0].id === ls.id; });
            openState[chapter.slug] = ci === 0 || hasNext;
            var boxCh = ui.el('div', 'chapter' + (openState[chapter.slug] ? ' open' : ''));
            var head = ui.el('div', 'chapter-head');
            head.appendChild(ui.el('div', 'chapter-idx', String(ci + 1)));
            head.appendChild(ui.el('div', 'chapter-title', chapter.title));
            var cdone = chapter.lessons.filter(function (ls) { return doneMap[ls.id]; }).length;
            head.appendChild(ui.el('div', 'chapter-meta',
              cdone + ' / ' + chapter.lessons.length + ' 完成 · ' +
              fmt.minutes(chapter.lessons.reduce(function (n, ls) { return n + ls.minutes; }, 0))));
            head.appendChild(ui.el('div', 'chapter-caret', '›'));
            head.addEventListener('click', function () { boxCh.classList.toggle('open'); });
            boxCh.appendChild(head);

            var cbody = ui.el('div', 'chapter-body');
            chapter.lessons.forEach(function (ls, li) {
              var isDone = !!doneMap[ls.id];
              var row = ui.el('a', 'lesson-row' + (isDone ? ' done' : ''));
              row.href = routeOfLesson(course, chapter, ls);
              row.appendChild(ui.el('span', 'lesson-tick', '✓'));
              var main = ui.el('div', 'lr-main');
              main.appendChild(ui.el('div', 'lr-title', ls.order + '. ' + ls.title));
              var meta = ui.el('div', 'lr-meta');
              meta.appendChild(ui.el('span', null, fmt.minutes(ls.minutes)));
              if (ls.figures) meta.appendChild(ui.el('span', null, ls.figures + ' 图'));
              if (ls.math) meta.appendChild(ui.el('span', null, '公式'));
              if (ls.difficulty) meta.appendChild(ui.el('span', null, ls.difficulty));
              if (LLM.store && LLM.store.note && LLM.store.note(ls.id)) meta.appendChild(ui.el('span', 'badge badge--warn', '有笔记'));
              main.appendChild(meta);
              row.appendChild(main);
              cbody.appendChild(row);
            });
            boxCh.appendChild(cbody);
            acc.appendChild(boxCh);
          });
          csec.appendChild(acc);
          expand.addEventListener('click', function () {
            var anyClosed = ui.$$('.chapter', acc).some(function (n) { return !n.classList.contains('open'); });
            ui.$$('.chapter', acc).forEach(function (n) { n.classList.toggle('open', anyClosed); });
            expand.textContent = anyClosed ? '收起全部' : '展开全部';
          });
          body.appendChild(csec);

          /* ---------- 接下来 / 相关课程 ---------- */
          var rel = [];
          (course.alsoTry || []).forEach(function (s) { rel.push(s); });
          var rsec = ui.el('section', 'section');
          var rh = ui.el('div');
          rh.appendChild(ui.el('h2', 'section-title', '学完之后'));
          if (course.nextHint) rh.appendChild(ui.el('p', 'section-sub', course.nextHint));
          rsec.appendChild(rh);
          if (rel.length) {
            return data.courses().then(function (cards) {
              var bySlug = {};
              cards.forEach(function (c) { bySlug[c.slug] = c; });
              var g = ui.el('div', 'grid grid--cards');
              rel.forEach(function (s) { if (bySlug[s]) g.appendChild(views.courseCard(bySlug[s])); });
              rsec.appendChild(g);
              body.appendChild(rsec);
              wrap.appendChild(body);
              return null;
            });
          }
          body.appendChild(rsec);
          wrap.appendChild(body);
          return null;
        });
      }).catch(function (e) {
        ui.clear(wrap);
        var c = ui.el('div', 'container');
        c.innerHTML = '<div class="empty"><strong>找不到这门课</strong><p class="small">' + fmt.esc(e.message) +
          '</p><p><a class="btn btn--primary" href="#/courses">回全部课程</a></p></div>';
        wrap.appendChild(c);
        return null;
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

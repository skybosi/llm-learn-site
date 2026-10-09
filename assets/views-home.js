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
    // 紧凑行（课程地图用）：无封面、单行 —— 首页原来把 41 门课全用带封面大卡铺开，整页 10600px
    if (o.compact) {
      var row = ui.el('a', 'course-row');
      row.href = '#/course/' + card.slug;
      row.title = card.title + (card.line ? '（' + card.line + '）' : '') + '：' + card.counts.lessons + ' 课时';
      // 克制路线：只留「序号 + 标题 + 参数」，不铺色块/缩略图
      row.appendChild(ui.el('span', 'course-row-idx', o.index ? o.index : ''));
      var main = ui.el('div', 'course-row-main');
      main.appendChild(ui.el('span', 'course-row-title', card.title));
      // 不再重复方向线名（分组标题已写）→ 参数能完整显示
      main.appendChild(ui.el('span', 'course-row-meta',
        [card.counts.lessons + ' 课时', card.counts.figures + ' 图', card.difficulty].filter(Boolean).join(' · ')));
      row.appendChild(main);
      if (o.progress) {
        var pct = o.progress.total ? Math.round(o.progress.done / o.progress.total * 100) : 0;
        var bar = ui.el('span', 'course-row-bar');
        bar.innerHTML = '<i style="width:' + pct + '%"></i>';
        row.appendChild(bar);
        row.appendChild(ui.el('span', 'course-row-pct', pct ? pct + '%' : '—'));
      }
      return row;
    }
    if (o.medium) {
      // 课程站做法：封面 + 标题 + 参数 + 难度 + 进度，一屏能扫完
      var m = ui.el('a', 'card course-card course-card--medium');
      m.href = '#/course/' + card.slug;
      if (card.cover) {
        var mc = ui.el('img', 'card-cover');
        mc.src = card.cover; mc.alt = card.title + ' 封面'; mc.loading = 'lazy'; mc.decoding = 'async';
        m.appendChild(mc);
      }
      m.setAttribute('aria-label', card.title);
      var mb = ui.el('div', 'card-body');   // 封面里已有课程名 → 卡体不再重复标题
      if (card.description) {
        var md = ui.el('p', 'card-desc'); md.textContent = card.description; mb.appendChild(md);
      }
      var mm = ui.el('div', 'card-meta');
      mm.appendChild(ui.el('span', null, card.counts.lessons + ' 课时'));
      mm.appendChild(ui.el('span', null, '·'));
      mm.appendChild(ui.el('span', null, card.counts.figures + ' 图'));
      if (card.difficulty) mm.appendChild(ui.el('span', 'badge badge--level', card.difficulty));
      mb.appendChild(mm);
      if (o.progress && o.progress.total) {
        var pw = ui.el('div', 'card-progressbar');
        pw.innerHTML = '<i style="width:' + Math.round(o.progress.done / o.progress.total * 100) + '%"></i>';
        mb.appendChild(pw);
      }
      m.appendChild(mb);
      return m;
    }
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
    var glyph = ui.el('div', 'path-glyph');
    glyph.innerHTML = (views.pathIcon ? ui.iconSvg(views.pathIcon(p), 22) : ui.iconSvg('route', 22));
    head.appendChild(glyph);
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
      var stops = [];
      return Promise.all([data.site(), data.courses(), progressP]).then(function (res) {
        var site = res[0], courses = res[1];
        var pm = {};
        (res[2].courses || []).forEach(function (c) { pm[c.slug] = c; });
        {
          var bySlug = {};
          courses.forEach(function (c) { bySlug[c.slug] = c; });

          /* ---------- hero ---------- */
          var hero = ui.el('section', 'hero');
          // 2026-10-09 用户指定：特效用在**标题本身**，不再做背景粒子文字
          var stopParticles = null;
          var inner = ui.el('div', 'hero-inner');
          var left = ui.el('div');
          left.appendChild(ui.el('span', 'hero-eyebrow', '9 条方向线 · 从零基础到能部署大模型'));
          var h1 = ui.el('h1');
          h1.innerHTML = '把大模型从<em>数学地基</em>学到<em>推理部署</em>';
          // 标题区做粒子背景：包一层容器，粒子场铺在里面、标题文字照常可读
          var titleWrap = ui.el('div', 'hero-title-wrap');
          titleWrap.appendChild(h1);
          left.appendChild(titleWrap);
          // 标题 = 粒子拼出的文字（成功后模块自己隐藏普通文字；关键字用琥珀色，与 <em> 对应）
          if (LLM.particles && LLM.particles.attachTitle) {
            stopParticles = LLM.particles.attachTitle(h1, {
              text: '把大模型从数学地基',
              sub: '学到推理部署',
              accent: ['数学地基', '推理部署'],
              mainPx: 54, subPx: 54, lineGap: 1.25,
              anchorX: 0.5, anchorY: 0.36,
              step: 1, maxParticles: 9000,
              radius: 34, push: 0.3, pull: 0.22
            });
          }
          left.appendChild(ui.el('p', 'hero-lead',
            site.counts.courses + ' 门课 · ' + site.counts.chapters + ' 章 · ' + site.counts.lessons +
            ' 个课时：每个概念都从「为什么需要」讲到「怎么算、怎么调、代价是什么」，' +
            '配 ' + fmt.num(site.counts.figures) + ' 张图表与 ' + fmt.num(site.counts.glossaryTerms) + ' 条关键词百科。'));
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
          var mapSec = ui.el('section', 'section course-map');   // ⚠️ 必须带 course-map 类，否则网格/卡片样式选择器不生效
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
            var famLessons = (fam.lines || []).reduce(function (n, ln) {
              return n + (byLine[ln] || []).reduce(function (m, c) { return m + c.counts.lessons; }, 0); }, 0);
            var famCourses = (fam.lines || []).reduce(function (n, ln) { return n + (byLine[ln] || []).length; }, 0);
            ft.appendChild(ui.el('span', 'line-kind', famCourses + ' 门课 · ' + famLessons + ' 课时'));
            famBox.appendChild(ft);
            (fam.lines || []).forEach(function (lineName) {
              var list = byLine[lineName] || [];
              if (!list.length) return;
              var lb = ui.el('div', 'line-block');
              var totalLessons = list.reduce(function (n, c) { return n + c.counts.lessons; }, 0);
              // 方向线名与大类名相同（多数如此）→ 不再重复一行标题，只把统计并进大类标题
              var oneLine = (fam.lines || []).length <= 1;
              if (!oneLine && lineName !== fam.name) {
                var lh = ui.el('div', 'line-head');
                lh.appendChild(ui.el('h3', null, lineName));
                lh.appendChild(ui.el('span', 'line-kind', list.length + ' 门课 · ' + totalLessons + ' 课时'));
                lb.appendChild(lh);
              }
              var g = ui.el('div', 'grid grid--wide');
              list.forEach(function (c) { g.appendChild(courseCard(c, { progress: pm[c.slug], medium: true })); });
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
        var msg = String(e && e.message || e);
        var isFile = /^file:/i.test(location.protocol);
        var is404 = /404/.test(msg);
        var why = isFile
          ? '你是用 <code>file://</code> 直接打开的：浏览器会拦截 <code>data/*.json</code> 的请求（CORS），必须走本地静态服务。'
          : (is404
            ? '请求 <code>data/site.json</code> 返回 404 —— 你打开的**多半是站点源码目录 <code>site/</code>**（它只有 <code>assets/</code>，<code>data/</code> 是构建产物）。请打开构建出来的 <code>site-dist/</code>。'
            : '数据请求失败：' + fmt.esc(msg));
        // 强制重载（带时间戳）：把浏览器缓存整个绕过去
        var retryUrl = location.origin + location.pathname + '?r=' + Date.now() + (location.hash || '#/');
        var c = ui.el('div', 'container container--narrow');
        c.innerHTML = '<div class="empty"><strong>站点数据加载失败</strong>' +
          '<p class="small mono" style="word-break:break-all">当前地址：' + fmt.esc(location.href) + '</p>' +
          '<p class="small mono" style="word-break:break-all">失败请求：' + fmt.esc(msg) + '</p>' +
          '<p class="small">' + why + '</p>' +
          '<p class="small muted" style="margin-top:14px">正确的本地预览方式（二选一）：</p>' +
          '<pre style="text-align:left;max-width:560px;margin:0 auto"><code>cd llm-learn\n' +
          '# ① 根路径（＝直接打开站点根）\npython3 -m http.server 4010 --directory site-dist\n' +
          '# ② 子路径（＝GitHub Pages 的真实形态）\nmkdir -p /tmp/pages && ln -sfn "$PWD/site-dist" /tmp/pages/llm-learn-site\npython3 -m http.server 4011 --directory /tmp/pages</code></pre>' +
          '<p class="small muted" style="margin-top:10px">打开：<code>http://127.0.0.1:4010/</code> 或 <code>http://127.0.0.1:4011/llm-learn-site/</code></p>' +
          '<p style="margin-top:14px">' +
          '<button class="btn btn--primary" id="hard-reload">强制重载（绕过缓存）</button> ' +
          '<a class="btn" href="#/">重试</a></p></div>';
        rootEl.appendChild(c);
        var hr = c.querySelector('#hard-reload');
        if (hr) hr.addEventListener('click', function () { location.replace(retryUrl); });
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

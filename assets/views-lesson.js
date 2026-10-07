/* ============================================================================
 * llm-learn 学习站 · 课时页（学习主场景）
 * 左：本课章节目录（含完成勾）  中：正文（公式/代码/图片灯箱）  右：本页目录
 * 底部：上一课 / 下一课 / 标记完成；笔记抽屉（本地保存）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  var FONT_STEPS = [0.94, 1, 1.08, 1.18, 1.3];

  function lessonSlugOf(file) { return String(file || '').split('/').pop().replace(/\.md$/, ''); }
  function routeOf(course, chapter, lesson) {
    return '#/learn/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file);
  }
  function fileOf(course, chapter, lesson) {
    return 'content/courses/' + course.slug + '/' + chapter.slug + '/' + lessonSlugOf(lesson.file) + '.md';
  }

  /** 链接解析器：与构建期同一份实现（assets/render.js），保证两边 href 完全一致 */
  function makeLinkResolver(lessonIndex) {
    return LLM.render.linkResolver(lessonIndex);
  }

  views.lesson = {
    render: function (rootEl, route) {
      var wrap = ui.el('div');
      rootEl.appendChild(wrap);
      wrap.innerHTML = '<div class="container"><div class="skeleton" style="height:300px"></div></div>';

      // #/l/<lessonId> → 解析成规范路由（保证 URL 可分享、上下课导航一致）
      if (route.name === 'lessonById') {
        var id = route.seg[1];
        return data.lessons().then(function (idx) {
          var m = idx[id];
          if (!m) {
            ui.clear(wrap);
            wrap.innerHTML = '<div class="container"><div class="empty"><strong>没有这个课时</strong>' +
              '<p class="small">id：' + fmt.esc(id) + '</p><p><a class="btn btn--primary" href="#/courses">回全部课程</a></p></div></div>';
            return null;
          }
          location.replace('#/learn/' + m.c + '/' + m.ch + '/' + m.l);
          return null;
        });
      }

      var slug = route.seg[1], chapterSlug = route.seg[2], lessonSlug = route.seg[3];
      var state = { fontScale: 1, drawer: null, cleanupFns: [] };

      return Promise.all([data.course(slug), data.lessons()]).then(function (res) {
        var course = res[0], lessonIndex = res[1];
        var chapter = null, lesson = null;
        course.chapters.forEach(function (ch) {
          if (ch.slug === chapterSlug) {
            chapter = ch;
            ch.lessons.forEach(function (ls) { if (lessonSlugOf(ls.file) === lessonSlug) lesson = ls; });
          }
        });
        if (!chapter || !lesson) throw new Error('这门课里没有 ' + chapterSlug + '/' + lessonSlug);

        // 扁平序列（上一课 / 下一课 / 位置）
        var flat = [];
        course.chapters.forEach(function (ch) {
          ch.lessons.forEach(function (ls, i) {
            flat.push({ id: ls.id, title: ls.title, chapter: ch, lesson: ls, route: routeOf(course, ch, ls),
              chapterSeq: i + 1, chapterTotal: ch.lessons.length, math: ls.math, figures: ls.figures, minutes: ls.minutes });
          });
        });
        var pos = -1;
        flat.forEach(function (f, i) { if (f.id === lesson.id) pos = i; });
        var prev = pos > 0 ? flat[pos - 1] : null;
        var next = pos >= 0 && pos < flat.length - 1 ? flat[pos + 1] : null;

        if (LLM.store && LLM.store.setLastVisited) LLM.store.setLastVisited(lesson.id);
        if (LLM.store && LLM.store.settings) {
          var s = LLM.store.settings();
          state.fontScale = s && s.fontScale ? s.fontScale : 1;
        }

        ui.clear(wrap);
        var layout = ui.el('div', 'learn-layout');
        wrap.appendChild(layout);

        /* ---------- 左侧：本课目录 ---------- */
        var side = ui.el('aside', 'learn-side');
        var sideBack = ui.el('a', 'side-course', course.title);
        sideBack.href = '#/course/' + course.slug;
        side.appendChild(sideBack);
        side.appendChild(ui.el('div', 'side-sub', course.counts.chapters + ' 章 · ' + course.counts.lessons + ' 课时 · ' + fmt.minutes(course.counts.minutes)));
        var progBox = ui.el('div', 'side-progress');
        side.appendChild(progBox);
        var chaptersBox = ui.el('div');
        side.appendChild(chaptersBox);

        function doneCount() {
          return flat.filter(function (f) { return LLM.store && LLM.store.isDone && LLM.store.isDone(f.id); }).length;
        }
        function paintSide() {
          var d = doneCount();
          ui.clear(progBox);
          var row = ui.el('div', 'row');
          row.appendChild(ui.ring(d, flat.length, { size: 'sm' }));
          var t = ui.el('div', 'small muted', d + ' / ' + flat.length + ' 完成');
          row.appendChild(t);
          progBox.appendChild(row);
          progBox.appendChild(ui.el('div', 'small muted', '已学 ' + fmt.minutes(flat.filter(function (f) {
            return LLM.store && LLM.store.isDone && LLM.store.isDone(f.id);
          }).reduce(function (n, f) { return n + (f.minutes || 0); }, 0))));
        }
        function paintChapters() {
          ui.clear(chaptersBox);
          course.chapters.forEach(function (ch, ci) {
            var isCur = ch.slug === chapterSlug;
            var box = ui.el('div', 'side-chapter' + (isCur ? ' open' : ''));
            var head = ui.el('div', 'side-chapter-title');
            head.appendChild(ui.el('span', 'chapter-idx', String(ci + 1)));
            head.appendChild(ui.el('span', null, fmt.clamp(ch.title, 18)));
            var chDone = ch.lessons.filter(function (ls) { return LLM.store && LLM.store.isDone && LLM.store.isDone(ls.id); }).length;
            head.appendChild(ui.el('span', 'muted tiny', chDone + '/' + ch.lessons.length));
            head.addEventListener('click', function () { box.classList.toggle('open'); });
            box.appendChild(head);
            var list = ui.el('div', 'side-lessons');
            ch.lessons.forEach(function (ls) {
              var isDone = LLM.store && LLM.store.isDone && LLM.store.isDone(ls.id);
              var a = ui.el('a', 'side-lesson' + (isDone ? ' done' : '') + (ls.id === lesson.id ? ' active' : ''));
              a.href = routeOf(course, ch, ls);
              a.appendChild(ui.el('span', 'sl-dot', '✓'));
              a.appendChild(ui.el('span', null, ls.title));
              list.appendChild(a);
            });
            box.appendChild(list);
            chaptersBox.appendChild(box);
          });
        }
        paintSide();
        paintChapters();
        layout.appendChild(side);

        /* ---------- 中间：正文 ---------- */
        var main = ui.el('div', 'learn-main');

        var mobileBar = ui.el('div', 'lesson-mobilebar');
        var btnSide = ui.el('button', 'icon-btn', '☰');
        btnSide.title = '本课目录';
        var sideBackdrop = null;
        function closeSide() {
          side.classList.remove('open');
          if (sideBackdrop) { sideBackdrop.remove(); sideBackdrop = null; }
          document.body.classList.remove('no-scroll');
        }
        function toggleSide() {
          if (side.classList.contains('open')) { closeSide(); return; }
          side.classList.add('open');
          // 手机上抽屉是浮层：必须有遮罩 + 锁滚动，否则手指会滑到背后的正文（也会让点击目标漂移）
          sideBackdrop = ui.el('div', 'drawer-backdrop');
          sideBackdrop.addEventListener('click', closeSide);
          document.body.appendChild(sideBackdrop);
          document.body.classList.add('no-scroll');
        }
        btnSide.addEventListener('click', toggleSide);
        // 点了某一课就收起抽屉（移动端）
        ui.on(side, 'click', '.side-lesson', function () { closeSide(); });
        mobileBar.appendChild(btnSide);
        mobileBar.appendChild(ui.el('div', 'mb-title', lesson.title));
        var btnDoneM = ui.el('button', 'btn btn--sm', LLM.store && LLM.store.isDone(lesson.id) ? '已完成' : '标记完成');
        mobileBar.appendChild(btnDoneM);
        main.appendChild(mobileBar);

        var head = ui.el('div', 'lesson-head');
        var crumb = ui.el('div', 'crumb');
        var c1 = ui.el('a', null, course.title); c1.href = '#/course/' + course.slug;
        crumb.appendChild(c1);
        crumb.appendChild(ui.el('span', null, '›'));
        crumb.appendChild(ui.el('span', null, '第 ' + (course.chapters.indexOf(chapter) + 1) + ' 章 · ' + chapter.title));
        head.appendChild(crumb);
        head.appendChild(ui.el('h1', 'lesson-h1', lesson.title));
        var meta = ui.el('div', 'lesson-metabar');
        meta.appendChild(ui.el('span', null, fmt.lessonPos(lesson.order, flat.length, flat[pos] ? flat[pos].chapterSeq : 0, flat[pos] ? flat[pos].chapterTotal : 0)));
        meta.appendChild(ui.el('span', null, '·'));
        meta.appendChild(ui.el('span', null, fmt.minutes(lesson.minutes)));
        if (lesson.figures) { meta.appendChild(ui.el('span', null, '·')); meta.appendChild(ui.el('span', null, lesson.figures + ' 张图')); }
        if (lesson.math) { meta.appendChild(ui.el('span', null, '·')); meta.appendChild(ui.el('span', null, '含公式')); }
        if (lesson.difficulty) meta.appendChild(ui.el('span', 'badge badge--level', lesson.difficulty));
        (lesson.tags || []).slice(0, 3).forEach(function (t) { meta.appendChild(ui.el('span', 'tag', t)); });
        head.appendChild(meta);

        // 前置课时：这门课/这条学习路径的「该先学什么」，系统学习的入口
        if ((lesson.prerequisites || []).length) {
          var pre = ui.el('div', 'prereq');
          pre.appendChild(ui.el('span', 'prereq-label', '前置课时'));
          (lesson.prerequisites || []).forEach(function (pid) {
            var m = lessonIndex[pid];
            var a = ui.el('a', 'chip', m ? m.t : pid);
            a.href = '#/l/' + pid;
            a.title = m ? (m.ct + ' · ' + m.t) : pid;
            if (m) a.textContent = fmt.clamp(m.t, 26);
            pre.appendChild(a);
          });
          head.appendChild(pre);
        }
        main.appendChild(head);

        var article = ui.el('article', 'article');
        article.style.fontSize = (16 * state.fontScale).toFixed(2) + 'px';
        main.appendChild(article);
        article.innerHTML = '<div class="skeleton" style="height:220px"></div>';

        /* ---------- 右侧：本页目录 ---------- */
        var tocBox = ui.el('nav', 'toc');
        tocBox.appendChild(ui.el('div', 'toc-title', '本页目录'));
        var tocList = ui.el('div');
        tocBox.appendChild(tocList);

        /* ---------- 课时尾部 ---------- */
        var foot = ui.el('div', 'lesson-foot');
        var nav = ui.el('div', 'lesson-nav');
        if (prev) {
          var pb = ui.el('a', 'btn btn--ghost', '← ' + fmt.clamp(prev.title, 22));
          pb.href = prev.route; pb.title = prev.title;
          nav.appendChild(pb);
        } else nav.appendChild(ui.el('span'));
        if (next) {
          var nb = ui.el('a', 'btn btn--primary', fmt.clamp(next.title, 22) + ' →');
          nb.href = next.route; nb.title = next.title;
          nav.appendChild(nb);
        } else {
          var fin = ui.el('a', 'btn btn--primary', '这门课学完了 → 回课程页');
          fin.href = '#/course/' + course.slug;
          nav.appendChild(fin);
        }
        foot.appendChild(nav);

        // 本课关键词（构建期从「词条 → 课时」指针反转而来）：读完这一课顺手回查概念
        data.lessonTerms().then(function (map) {
          var terms = map[lesson.id] || [];
          if (!terms.length) return;
          var box = ui.el('div', 'keyterms');
          var kh = ui.el('div', 'section-sub');
          kh.textContent = '本课关键词（' + terms.length + ' 个，点击查百科）';
          box.appendChild(kh);
          var row = ui.el('div', 'chip-row');
          terms.forEach(function (t) {
            var a = ui.el('a', 'chip', t.zh);
            a.href = '#/glossary/t/' + t.k;
            a.title = t.layerName + ' · ' + t.zh;
            row.appendChild(a);
          });
          box.appendChild(row);
          foot.insertBefore(box, nav.nextSibling);
        }).catch(function () { /* 关键词索引没有也能读 */ });

        main.appendChild(foot);
        layout.appendChild(main);      // 正文（第 2 列，最宽）
        layout.appendChild(tocBox);    // 本页目录（第 3 列）—— 顺序不能颠倒，grid 按 DOM 顺序落列

        /* ---------- 操作按钮（正文上方 + 底部） ---------- */
        var actions = ui.el('div', 'lesson-actions');
        var btnDone = ui.el('button', 'btn btn--sm' + (LLM.store && LLM.store.isDone(lesson.id) ? ' btn--primary' : ''));
        function paintDone() {
          var d = LLM.store && LLM.store.isDone(lesson.id);
          btnDone.textContent = d ? '✓ 已完成（点击取消）' : '标记为已完成';
          btnDone.className = 'btn btn--sm' + (d ? ' btn--primary' : '');
          btnDoneM.textContent = d ? '已完成' : '标记完成';
        }
        btnDone.addEventListener('click', function () {
          if (LLM.store && LLM.store.toggleDone) {
            var now = LLM.store.toggleDone(lesson.id);
            paintDone(); paintSide(); paintChapters();
            ui.toast(now ? '已标记完成 ✓' : '已取消完成标记', now ? 'ok' : null, 1400);
          }
        });
        btnDoneM.addEventListener('click', function () { btnDone.click(); });
        paintDone();
        actions.appendChild(btnDone);

        var btnNote = ui.el('button', 'btn btn--sm', '✎ 记笔记');
        btnNote.addEventListener('click', function () { openDrawer(); });
        actions.appendChild(btnNote);

        var btnBook = ui.el('button', 'btn btn--sm', LLM.store && LLM.store.isBookmarked && LLM.store.isBookmarked(lesson.id) ? '★ 已收藏' : '☆ 收藏');
        btnBook.addEventListener('click', function () {
          if (!LLM.store || !LLM.store.toggleBookmark) return;
          var on = LLM.store.toggleBookmark(lesson.id);
          btnBook.textContent = on ? '★ 已收藏' : '☆ 收藏';
          ui.toast(on ? '已加入收藏' : '已取消收藏', null, 1200);
        });
        actions.appendChild(btnBook);

        var fontBtn = ui.el('button', 'btn btn--sm', 'A± 字号');
        fontBtn.title = '调整正文字号（会记住）';
        fontBtn.addEventListener('click', function () {
          var i = FONT_STEPS.indexOf(state.fontScale);
          i = (i + 1) % FONT_STEPS.length;
          state.fontScale = FONT_STEPS[i];
          article.style.fontSize = (16 * state.fontScale).toFixed(2) + 'px';
          if (LLM.store && LLM.store.setSetting) LLM.store.setSetting('fontScale', state.fontScale);
          ui.toast('字号 ' + Math.round(state.fontScale * 100) + '%', null, 1000);
        });
        actions.appendChild(fontBtn);

        var copyBtn = ui.el('button', 'btn btn--sm', '复制本课链接');
        copyBtn.addEventListener('click', function () {
          (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject())
            .then(function () { ui.toast('链接已复制', 'ok'); })
            .catch(function () { ui.toast('复制失败，请手动复制地址栏', 'warn'); });
        });
        actions.appendChild(copyBtn);

        head.appendChild(actions);

        /* ---------- 笔记抽屉 ---------- */
        var drawer = null, backdrop = null, noteArea = null, noteStatus = null, previewBox = null;
        function noteSupported() { return !!(LLM.store && LLM.store.setNote); }
        function openDrawer() {
          if (!noteSupported()) { ui.toast('笔记模块没加载出来（store.js）', 'err'); return; }
          if (drawer) { drawer.classList.add('open'); noteArea && noteArea.focus(); return; }
          backdrop = ui.el('div', 'drawer-backdrop');
          backdrop.addEventListener('click', closeDrawer);
          drawer = ui.el('div', 'notes-drawer open');
          var dh = ui.el('div', 'notes-head');
          dh.appendChild(ui.el('b', null, '✎ 本课笔记'));
          var hint = ui.el('span', 'note-hint', '自动保存到本机');
          dh.appendChild(hint);
          var spacer = ui.el('div'); spacer.style.flex = '1'; dh.appendChild(spacer);
          var close = ui.el('button', 'icon-btn', '✕');
          close.addEventListener('click', closeDrawer);
          dh.appendChild(close);
          drawer.appendChild(dh);

          var dbody = ui.el('div', 'notes-body');
          var existing = LLM.store && LLM.store.note ? LLM.store.note(lesson.id) : null;
          noteArea = ui.el('textarea', 'notes-editor');
          noteArea.placeholder = '写下你的理解、疑问、踩坑记录…（支持 Markdown，公式用 $...$）\n\n例：\n- 这里的 σ 指每元素字节数\n- 与第 3 章的 $2L\\cdot 2\\frac{N-1}{N}bh$ 对照';
          noteArea.value = existing ? existing.text : '';
          dbody.appendChild(noteArea);

          var btns = ui.el('div', 'io-actions');
          var save = ui.el('button', 'btn btn--primary btn--sm', '保存');
          save.addEventListener('click', function () {
            LLM.store.setNote(lesson.id, noteArea.value);
            noteStatus.textContent = '已保存 · ' + fmt.rel(Date.now());
            ui.toast('笔记已保存（本机）', 'ok', 1300);
            refreshNoteFlags();
          });
          var prevBtn = ui.el('button', 'btn btn--sm', '预览');
          prevBtn.addEventListener('click', function () {
            previewBox.innerHTML = '<div class="article">' + ui.md(noteArea.value, { file: fileOf(course, chapter, lesson) }) + '</div>';
            previewBox.classList.toggle('hidden');
          });
          var del = ui.el('button', 'btn btn--sm btn--danger', '删除');
          del.addEventListener('click', function () {
            ui.confirm('删除这条笔记？', '删除后无法恢复。', '删除').then(function (ok) {
              if (!ok) return;
              LLM.store.deleteNote(lesson.id);
              noteArea.value = '';
              noteStatus.textContent = '已删除';
              ui.toast('笔记已删除', null, 1200);
              refreshNoteFlags();
            });
          });
          btns.appendChild(save); btns.appendChild(prevBtn); btns.appendChild(del);
          dbody.appendChild(btns);
          noteStatus = ui.el('div', 'note-hint', existing ? '上次修改：' + fmt.rel(existing.updatedAt) : '还没有笔记');
          dbody.appendChild(noteStatus);
          previewBox = ui.el('div', 'notes-preview hidden');
          dbody.appendChild(previewBox);
          drawer.appendChild(dbody);

          var autosave = ui.debounce(function () {
            LLM.store.setNote(lesson.id, noteArea.value);
            noteStatus.textContent = '已自动保存 · ' + fmt.rel(Date.now());
            refreshNoteFlags();
          }, 900);
          noteArea.addEventListener('input', autosave);
          noteArea.addEventListener('keydown', function (e) {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
          });

          document.body.appendChild(backdrop);
          document.body.appendChild(drawer);
          noteArea.focus();
        }
        function closeDrawer() {
          if (drawer) drawer.classList.remove('open');
          if (backdrop) backdrop.remove();
        }
        state.closeDrawer = closeDrawer;

        function refreshNoteFlags() {
          // 目录上的「有笔记」标记 + 「我的学习」数字都靠事件刷新
          LLM.emit('progress');
        }

        /* ---------- 载入正文：构建期已渲染好的 HTML 片段（站点里不存在 .md 源文件） ---------- */
        var bodyPath = 'data/lesson/' + lesson.id + '.html';
        return fetch(bodyPath, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('正文加载失败：' + bodyPath + '（HTTP ' + r.status + '）');
          return r.text();
        }).then(function (html) {
          article.innerHTML = html;
          ui.enhance(article);

          // 本页目录 + 滚动高亮
          var heads = ui.toc(article);
          if (!heads.length) tocBox.classList.add('hidden');
          heads.forEach(function (h) {
            var a = ui.el('a', 'toc-link lv' + h.level, fmt.clamp(h.text, 26));
            a.href = '#' + h.id;
            a.addEventListener('click', function (e) {
              e.preventDefault();
              var target = article.querySelector('#' + CSS.escape(h.id));
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            tocList.appendChild(a);
          });
          var links = ui.$$('.toc-link', tocList);
          var spy = [];
          heads.forEach(function (h, i) {
            var node = article.querySelector('#' + CSS.escape(h.id));
            if (node) spy.push({ node: node, link: links[i] });
          });
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              if (!en.isIntersecting) return;
              var hit = spy.filter(function (s) { return s.node === en.target; })[0];
              if (!hit) return;
              links.forEach(function (l) { l.classList.remove('active'); });
              hit.link.classList.add('active');
            });
          }, { rootMargin: '-70px 0px -70% 0px', threshold: 0 });
          spy.forEach(function (s) { io.observe(s.node); });
          state.cleanupFns.push(function () { io.disconnect(); });

          // 回到顶部：正文常有一万多字，手机上尤其需要（滚动超过 700px 才出现）
          var toTop = ui.el('button', 'to-top', '↑');
          toTop.title = '回到顶部';
          toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
          document.body.appendChild(toTop);
          var onScroll = function () { toTop.classList.toggle('show', window.scrollY > 700); };
          window.addEventListener('scroll', onScroll, { passive: true });
          onScroll();
          state.cleanupFns.push(function () { window.removeEventListener('scroll', onScroll); toTop.remove(); });

          // 选中正文 → 浮出「摘录到笔记」：读长文时最常用的动作，直接落到本课笔记里
          var pop = null;
          function hidePop() { if (pop) { pop.remove(); pop = null; } }
          function showPop(excerpt, rect) {
            hidePop();
            pop = ui.el('button', 'excerpt-btn', '✎ 摘录到笔记');
            pop.style.top = Math.max(8, rect.top - 42 + window.scrollY) + 'px';
            pop.style.left = Math.min(window.innerWidth - 150, Math.max(12, rect.left + rect.width / 2 - 70)) + 'px';
            pop.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 别把选区弄丢
            pop.addEventListener('click', function () {
              hidePop();
              openDrawer();
              var cur = noteArea.value ? noteArea.value.replace(/\s*$/, '') + '\n\n' : '';
              noteArea.value = cur + '> 摘录：' + excerpt.replace(/\n+/g, ' ') + '\n';
              LLM.store.setNote(lesson.id, noteArea.value);
              if (noteStatus) noteStatus.textContent = '已摘录 · ' + fmt.rel(Date.now());
              ui.toast('已摘录到本课笔记', 'ok', 1500);
              refreshNoteFlags();
              noteArea.focus();
            });
            document.body.appendChild(pop);
          }
          function onSelect() {
            var sel = root.getSelection ? root.getSelection() : null;
            if (!sel || sel.isCollapsed || !sel.rangeCount) { hidePop(); return; }
            var text = String(sel).trim();
            if (text.length < 6) { hidePop(); return; }
            var node = sel.anchorNode;
            if (!node || !article.contains(node.nodeType === 1 ? node : node.parentNode)) { hidePop(); return; }
            var rect = sel.getRangeAt(0).getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height)) { hidePop(); return; }
            showPop(text.length > 400 ? text.slice(0, 400) + '…' : text, rect);
          }
          var selectTimer = null;
          var onUp = function () { clearTimeout(selectTimer); selectTimer = setTimeout(onSelect, 60); };
          document.addEventListener('mouseup', onUp);
          document.addEventListener('touchend', onUp);
          document.addEventListener('scroll', hidePop, { passive: true });
          state.cleanupFns.push(function () {
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchend', onUp);
            document.removeEventListener('scroll', hidePop);
            hidePop();
          });

          // 键盘：← → 上一课/下一课；n 记笔记
          function onKey(e) {
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if (e.key === 'ArrowLeft' && prev) location.hash = prev.route;
            else if (e.key === 'ArrowRight' && next) location.hash = next.route;
            else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openDrawer(); }
          }
          document.addEventListener('keydown', onKey);
          state.cleanupFns.push(function () { document.removeEventListener('keydown', onKey); });

          return function cleanup() {
            state.cleanupFns.forEach(function (f) { try { f(); } catch (err) {} });
            closeDrawer();
            if (drawer) drawer.remove();
            if (sideBackdrop) { sideBackdrop.remove(); sideBackdrop = null; }
            document.body.classList.remove('no-scroll');
          };
        }).then(function (cleanupFn) {
          LLM.setTitle(lesson.title);
          return cleanupFn;
        });
      }).catch(function (e) {
        ui.clear(wrap);
        var c = ui.el('div', 'container');
        c.innerHTML = '<div class="empty"><strong>这个课时打不开</strong><p class="small">' + fmt.esc(e.message) +
          '</p><p><a class="btn btn--primary" href="#/course/' + fmt.esc(slug) + '">回课程页</a> <a class="btn" href="#/courses">全部课程</a></p></div>';
        wrap.appendChild(c);
        return null;
      });
    },
  };

  /* 供课程页/搜索复用 */
  views.lessonRoute = function (slug, chapter, lessonFile) {
    return '#/learn/' + slug + '/' + chapter + '/' + lessonSlugOf(lessonFile);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

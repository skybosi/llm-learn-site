/* ============================================================================
 * llm-learn 学习站 · 搜索页（#/search/<q>）
 * ① 先出「标题/小标题/词条」级结果（秒回，用紧凑索引）
 * ② 用户点「全文深搜」再逐课加载正文分片（20MB 不该在首屏就下载）
 * ==========================================================================*/
(function (root) {
  'use strict';
  var LLM = root.LLM = root.LLM || {};
  var ui = LLM.ui, fmt = LLM.fmt, data = LLM.data;
  var views = LLM.views = LLM.views || {};

  function snippet(text, q, width) {
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return fmt.esc(fmt.clamp(text, width || 160));
    var start = Math.max(0, i - 60);
    var seg = (start > 0 ? '…' : '') + text.slice(start, start + (width || 200)) + '…';
    return fmt.highlight(seg, q);
  }

  views.search = {
    render: function (rootEl, route) {
      var q = decodeURIComponent(route.seg[1] || route.query.q || '').trim();
      LLM.setTitle(q ? '搜索：' + q : '搜索');

      var wrap = ui.el('div', 'container');
      rootEl.appendChild(wrap);

      var head = ui.el('div', 'page-head');
      head.appendChild(ui.el('h1', null, q ? '搜索「' + q + '」' : '搜索'));
      head.appendChild(ui.el('p', null, '先匹配课程名、课时标题与小标题；要翻正文内容，点「搜正文」。'));
      wrap.appendChild(head);

      var form = ui.el('div', 'filters');
      var input = ui.el('input');
      input.type = 'search';
      input.value = q;
      input.placeholder = '输入关键词后回车';
      form.appendChild(input);
      var goBtn = ui.el('button', 'btn btn--primary btn--sm', '搜索');
      form.appendChild(goBtn);
      var deepBtn = ui.el('button', 'btn btn--sm', '搜正文（慢一点）');
      form.appendChild(deepBtn);
      var deepInfo = ui.el('span', 'deep-progress');
      form.appendChild(deepInfo);
      wrap.appendChild(form);

      var list = ui.el('div', 'result-list');
      var status = ui.el('div', 'section-sub');
      status.style.margin = '16px 0 10px';
      wrap.appendChild(status);
      wrap.appendChild(list);

      var cancelled = false;
      var deepCache = null;

      function go() {
        var v = input.value.trim();
        LLM.go('#/search/' + encodeURIComponent(v));
      }
      goBtn.addEventListener('click', go);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

      function renderQuick() {
        ui.clear(list);
        if (!q) {
          status.textContent = '输入关键词开始搜索';
          return;
        }
        status.textContent = '正在索引…';
        (LLM.search ? LLM.search.build() : Promise.reject(new Error('搜索索引未就绪')))
          .then(function () {
            var res = LLM.search.run(q).filter(function (r) { return r.kind !== 'term' || true; });
            status.textContent = '标题 / 小标题 / 词条 命中 ' + res.length + ' 条';
            if (!res.length) {
              list.innerHTML = '<div class="empty"><strong>没有命中</strong><p class="small">试试更短的关键词，或用「全文深搜」翻正文。</p>' +
                '<p><button class="btn btn--primary" id="deep-cta">全文深搜</button></p></div>';
              var cta = list.querySelector('#deep-cta');
              if (cta) cta.addEventListener('click', deep);
              return;
            }
            res.slice(0, 60).forEach(function (r) {
              var a = ui.el('a', 'result');
              if (r.kind === 'lesson') {
                a.href = '#/l/' + r.item.id;
                a.innerHTML = '<div class="r-title">' + fmt.highlight(r.item.title, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.slug) + ' › ' + fmt.esc(r.item.chapter || '') + '</div>' +
                  (r.item.heads ? '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.heads, 150), q) + '</div>' : '');
              } else if (r.kind === 'course') {
                a.href = '#/course/' + r.item.slug;
                a.innerHTML = '<div class="r-title">课程：' + fmt.highlight(r.item.title, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.line || '') + '</div>' +
                  '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.desc || '', 150), q) + '</div>';
              } else {
                a.href = '#/glossary/t/' + r.item.key;
                a.innerHTML = '<div class="r-title">词条：' + fmt.highlight(r.item.zh, q) + '</div>' +
                  '<div class="r-path">' + fmt.esc(r.item.layerName || '') + ' · ' + fmt.esc(r.item.en || '') + '</div>' +
                  '<div class="r-snippet">' + fmt.highlight(fmt.clamp(r.item.def || '', 150), q) + '</div>';
              }
              list.appendChild(a);
            });
          })
          .catch(function (e) {
            status.textContent = '';
            list.innerHTML = '<div class="empty"><strong>搜索索引加载失败</strong><p class="small">' + fmt.esc(e.message) + '</p></div>';
          });
      }

      /** 全文深搜：逐课加载 data/text/<slug>.json，边加载边出结果 */
      function deep() {
        if (!q) return;
        ui.clear(list);
        deepBtn.disabled = true;
        status.textContent = '全文深搜中…';
        var needle = q.toLowerCase();
        var hits = [];
        var loaded = 0, totalCourses = 0;
        deepCache = deepCache || null;

        function loadOne(slug) {
          return data.text(slug).then(function (lessons) {
            lessons.forEach(function (ls) {
              var x = String(ls.x || '');
              if (x.toLowerCase().indexOf(needle) < 0) return;
              hits.push({ id: ls.id, title: ls.t, text: x, slug: slug });
            });
          }).catch(function () { return null; });
        }

        data.courses().then(function (courses) {
          totalCourses = courses.length;
          var chain = Promise.resolve();
          courses.forEach(function (c) {
            chain = chain.then(function () {
              if (cancelled) return null;
              return loadOne(c.slug).then(function () {
                loaded++;
                deepInfo.innerHTML = '<span class="spinner"></span> 已扫 ' + loaded + ' / ' + totalCourses + ' 门课 · 命中 ' + hits.length + ' 条';
                if (loaded % 6 === 0) paintDeep();
              });
            });
          });
          return chain.then(function () {
            if (cancelled) return;
            deepBtn.disabled = false;
            deepInfo.textContent = '';
            status.textContent = '全文命中 ' + hits.length + ' 条（扫描了 ' + totalCourses + ' 门课的正文）';
            paintDeep();
          });
        });

        function paintDeep() {
          ui.clear(list);
          if (!hits.length) {
            list.innerHTML = '<div class="empty"><strong>正文里也没有出现「' + fmt.esc(q) + '」</strong></div>';
            return;
          }
          hits.slice(0, 200).forEach(function (h) {
            var idx = (LLM.search && LLM.search.index && LLM.search.index()) || {};
            var m = (idx.lessons || []).filter(function (l) { return l.id === h.id; })[0];
            var a = ui.el('a', 'result');
            a.href = '#/l/' + h.id;
            a.innerHTML = '<div class="r-title">' + fmt.highlight(h.title, q) + '</div>' +
              '<div class="r-path">' + fmt.esc(h.slug) + (m ? ' › ' + fmt.esc(m.chapter || '') : '') + '</div>' +
              '<div class="r-snippet">' + snippet(h.text, q) + '</div>';
            list.appendChild(a);
          });
          if (hits.length > 200) {
            var more = ui.el('div', 'section-sub', '只显示前 200 条，共 ' + hits.length + ' 条命中');
            list.appendChild(more);
          }
        }
      }
      deepBtn.addEventListener('click', deep);

      renderQuick();
      return function cleanup() { cancelled = true; };
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

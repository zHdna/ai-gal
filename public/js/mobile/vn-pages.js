/* =============================================================================
   AI-GAL 移动端 · 数据面板（vn-pages.js）
   -----------------------------------------------------------------------------
   状态 / 名册 / 画廊 / 记忆 / 世界状态 / 控制台 六个全屏页的取数与渲染。
   数据来源优先复用 app.js 的全局能力，其次直接调用既有 REST API。
   ============================================================================= */
(function () {
  'use strict';

  var VN = window.VN = window.VN || {};
  var P = VN.pages = VN.pages || {};

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function api(path, opts) {
    var cfg = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {});
    if (cfg.body && typeof cfg.body === 'object') cfg.body = JSON.stringify(cfg.body);
    // 复用 app.js 的 api.js 封装（若存在），保证鉴权/错误处理一致
    if (window.API && typeof window.API.request === 'function') return window.API.request(path, cfg);
    return fetch('/api' + path, cfg).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (r.status === 204) return null;
      return r.json();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function currentConv() {
    try {
      var st = window.AppState;
      if (st && st.currentConversation) return st.currentConversation;
    }
    catch (e) { }
    return null;
  }
  function currentSave() {
    var c = currentConv();
    return c ? (c.save_id || c.saveId || c.id) : (localStorage.getItem('mobile-lastConv') || '');
  }

  /* ---------------- 状态页 ---------------- */
  function renderStatus() {
    var box = $('#vnStatusBody');
    if (!box) return;
    var c = currentConv();
    if (!c) { box.innerHTML = '<div class="vn-empty">请先选择一个角色开始对话。</div>'; return; }
    box.innerHTML = '<div class="vn-empty">正在读取状态…</div>';

    resolveSaveRecordId().then(function (sid) {
      return Promise.all([
        api('/saves/' + encodeURIComponent(sid) + '/status').catch(function () { return null; }),
        api('/conversations/' + encodeURIComponent(c.id) + '/world-state').catch(function () { return null; })
      ]);
    }).then(function (res) {
      var status = res[0], ws = res[1];
      var html = '';

      // 状态变量
      var vars = [];
      if (status) {
        if (Array.isArray(status)) vars = status;
        else if (status.variables) vars = status.variables;
        else if (typeof status === 'object') {
          Object.keys(status).forEach(function (k) {
            if (k === 'id' || k === 'save_id') return;
            vars.push({ name: k, value: status[k] });
          });
        }
      }
      if (vars.length) {
        html += '<div class="vn-card"><h5>状态变量 <span>' + vars.length + ' 项</span></h5>';
        vars.slice(0, 60).forEach(function (v) {
          var name = v.name || v.key || v['变量名'] || '';
          var val = v.value != null ? v.value : (v['值'] != null ? v['值'] : '');
          var num = parseFloat(String(val).replace(/[^\d.\-/]/g, '').split('/')[0]);
          var max = parseFloat(String(val).split('/')[1]);
          html += '<div class="vn-kv"><span class="k">' + esc(name) + '</span><span class="v">' + esc(val) + '</span></div>';
          if (!isNaN(num) && !isNaN(max) && max > 0) {
            html += '<div class="vn-meter"><i style="width:' + Math.max(0, Math.min(100, num / max * 100)) + '%"></i></div>';
          }
        });
        html += '</div>';
      }

      // MVU 世界状态
      if (ws && (ws.variables || ws.state || typeof ws === 'object')) {
        var wsv = ws.variables || ws.state || ws;
        var keys = Object.keys(wsv || {});
        if (keys.length) {
          html += '<div class="vn-card"><h5>世界状态 (MVU) <span>' + keys.length + ' 项</span></h5>';
          keys.slice(0, 60).forEach(function (k) {
            var v = wsv[k];
            var val = (v && typeof v === 'object') ? (v.value != null ? v.value : JSON.stringify(v)) : v;
            html += '<div class="vn-kv"><span class="k">' + esc(k) + '</span><span class="v cyan">' + esc(val) + '</span></div>';
          });
          html += '</div>';
        }
      }

      // Token / 稳定度
      var ctx = document.getElementById('tokenContext');
      var tot = document.getElementById('tokenTotal');
      if (ctx && tot) {
        html += '<div class="vn-card"><h5>上下文 <span>token</span></h5>' +
          '<div class="vn-kv"><span class="k">已用</span><span class="v cyan">' + esc(ctx.textContent) + '</span></div>' +
          '<div class="vn-kv"><span class="k">上限</span><span class="v">' + esc(tot.textContent) + '</span></div></div>';
      }

      box.innerHTML = html || '<div class="vn-empty">当前没有可显示的状态数据。</div>';
    });
  }

  /* ---------------- 名册页 ---------------- */
  P.roster = {};         // name -> entry（对白头像也依赖它）
  P._rosterSaveId = '';
  var _rosterP = null;   // 正在进行的请求

  /** 只取数据不渲染：对白头像/名册页共用同一份，避免重复请求 */
  P.fetchRoster = function (force) {
    if (_rosterP && !force) return _rosterP;
    var c = currentConv();
    _rosterP = resolveSaveRecordId().then(function (sid) {
      P._rosterSaveId = sid || '';
      var req = c
        ? api('/saves/' + encodeURIComponent(sid) + '/roster').catch(function () { return null; })
        : Promise.resolve(null);
      return req.then(function (res) {
        // 兼容两种形态：{ roster: {...} } 与直接 {...}
        var inner = (res && res.roster) ? res.roster : res;
        if (!inner || !Object.keys(inner).length) {
          if (c) return api('/conversations/' + encodeURIComponent(c.id) + '/roster').catch(function () { return null; });
          return null;
        }
        return res;
      });
    }).then(function (data) {
      var roster = (data && data.roster) ? data.roster : (data || {});
      P.roster = roster;
      return roster;
    }).catch(function () { P.roster = P.roster || {}; return P.roster; });
    return _rosterP;
  };

  function renderRoster() {
    var box = $('#vnRosterBody');
    if (!box) return;
    box.innerHTML = '<div class="vn-empty">正在读取名册…</div>';

    P.fetchRoster(true).then(function (roster) {
      roster = roster || P.roster || {};

      // 过滤掉解析产生的占位/垃圾条目：
      //  · 正常条目带 id 或 generated_at
      //  · 名字里出现 【】、冒号、模板词（角色名/format 等）的一律丢弃
      var JUNK = /[【】\[\]{}]|角色名|dialogue|format|placeholder|示例/i;
      var keys = Object.keys(roster).filter(function (k) {
        var e = roster[k] || {};
        if (!k || !String(k).trim()) return false;
        if (JUNK.test(k) || String(k).length > 24) return false;
        if (e.id || e.generated_at) return true;
        return false;   // 没有生成记录的条目不作为名册展示
      });
      if (!keys.length) { box.innerHTML = '<div class="vn-empty">还没有名册记录。<br>开始对话后，管家 AI 会自动整理登场人物。</div>'; return; }

      var html = '';
      keys.forEach(function (name) {
        var e = roster[name] || {};
        var avUrl = rosterAvatarUrl(e, name);
        var bits = [];
        var g = e['种族性别'] || e.gender || '';
        if (g) bits.push(genderZh(g));
        var age = e['年龄'] || e.age || '';
        if (age) bits.push(String(age).replace(/_/g, ' '));
        if (e.relation || e['关系']) bits.push(e.relation || e['关系']);
        var intro = e['简要介绍'] || e.intro || '';
        html += '<div class="vn-roster" data-name="' + esc(name) + '"' + (avUrl ? ' data-av="' + esc(avUrl) + '"' : '') + '>' +
          '<div class="av"' + (avUrl ? ' style="background-image:url(' + esc(avUrl) + ')"' : '') + '>' +
          (avUrl ? '' : esc((name || '?').charAt(0))) + '</div>' +
          '<div class="info"><b>' + esc(name) + '</b><p>' + esc(bits.join(' · ') || intro || '—') + '</p></div>' +
          (avUrl ? '<span class="tag">看大图</span>' : '') +
          '</div>';
      });
      box.innerHTML = html;

      $$('.vn-roster', box).forEach(function (row) {
        row.addEventListener('click', function () {
          var name = row.dataset.name;
          var av = row.dataset.av || '';
          if (av) VN.openViewer(av, name, '轻点任意处关闭');
          else VN.shell && VN.shell.toast && VN.shell.toast(name + ' 暂无头像');
        });
      });
    });
  }

  /** 名册头像地址：统一走 /api/saves/:id/avatar/:name（app.js 也是这么取的） */
  function rosterAvatarUrl(entry, name) {
    if (!entry) return '';
    var av = entry.avatar;
    if (!av || av === 'pending' || av === '已有头像') return '';
    if (/^(\/|https?:|data:)/.test(av)) return av;          // 已是完整地址
    // 注意：后端按「角色名」找生成的头像文件，而不是按 avatar 里的文件名
    var sid = P._rosterSaveId || saveRecordId() || '';
    if (!sid) return '';
    return '/api/saves/' + encodeURIComponent(sid) + '/avatar/' + encodeURIComponent(name);
  }

  function genderZh(g) {
    var s = String(g);
    if (/girl|female/i.test(s)) return '女';
    if (/boy|male/i.test(s)) return '男';
    return s;
  }

  /* ---------------- 画廊页 ---------------- */
  P._latestCG = '';
  P.latestCG = function () { return P._latestCG; };

  /**
   * 预取当前存档的 CG 列表（只为舞台背景服务）。
   * 桌面版在 loadConversation() 里就会拉 cgGallery，移动端同样在对话载入后预取，
   * 这样「背景 = 最新 CG」无需先打开画廊页。
   */
  P.fetchLatestCG = function () {
    var c = currentConv();
    if (!c) return Promise.resolve('');
    return resolveSaveRecordId().then(function (sid) {
      return api('/saves/' + encodeURIComponent(sid) + '/cg-gallery').catch(function () { return null; });
    }).then(function (res) {
      var list = (res && Array.isArray(res.gallery)) ? res.gallery : [];
      if (!list.length) { P._latestCG = ''; return ''; }
      var first = list[0];
      var file = first.filename || first.file || first.name || '';
      if (!file) { P._latestCG = ''; return ''; }
      // 需要 sid，这里从闭包再取一次（已在上一段解析过）
      return resolveSaveRecordId().then(function (sid2) {
        var url = /^(\/|https?:)/.test(file)
          ? file
          : ('/api/saves/' + encodeURIComponent(sid2) + '/images/' + encodeURIComponent(file));
        P._latestCG = url;
        return url;
      });
    }).catch(function () { return P._latestCG || ''; });
  };

  /**
   * 取当前存档的「存档记录 id」。
   * 注意：CG / 名册 / 状态等接口用的是 saves 表的**记录 id**，
   * 不是 conversations.save_id（那是 save 目录名，也是存档显示名）。
   * app.js 用 AppState._currentSaveId 保存的是记录 id，这里按同样语义实现。
   */
  var _saveRecCache = { convId: '', id: '' };
  function saveRecordId() {
    var c = currentConv();
    if (!c) return '';
    // 1) app.js 已经解析过就直接用
    try {
      if (window.AppState && window.AppState._currentSaveId) return window.AppState._currentSaveId;
    } catch (e) { }
    if (_saveRecCache.convId === c.id && _saveRecCache.id) return _saveRecCache.id;
    return '';   // 需要异步解析，见 resolveSaveRecordId()
  }

  /** 异步解析存档记录 id（找不到时回落到 save_id，接口会按目录名兜底） */
  function resolveSaveRecordId() {
    var c = currentConv();
    if (!c) return Promise.resolve('');
    var direct = saveRecordId();
    if (direct) return Promise.resolve(direct);
    return fetch('/api/saves', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        var arr = Array.isArray(list) ? list : (list && list.saves) || [];
        var hit = arr.filter(function (s) { return s.conversation_id === c.id; })[0];
        var id = hit ? hit.id : (c.save_id || c.id);
        _saveRecCache = { convId: c.id, id: id };
        try { if (window.AppState) window.AppState._currentSaveId = id; } catch (e) { }
        return id;
      })
      .catch(function () { return c.save_id || c.id; });
  }
  P.saveRecordId = resolveSaveRecordId;

  function renderGallery() {
    var box = $('#vnGalleryBody');
    if (!box) return;
    var c = currentConv();
    if (!c) { box.innerHTML = '<div class="vn-empty">请先开始对话后再查看 CG 画廊。</div>'; return; }
    box.innerHTML = '<div class="vn-empty">正在读取画廊…</div>';

    resolveSaveRecordId().then(function (sid) {
      // 与原版一致：CG 列表来自 cg_gallery.json
      return api('/saves/' + encodeURIComponent(sid) + '/cg-gallery')
        .catch(function () { return null; })
        .then(function (res) {
          var list = (res && Array.isArray(res.gallery)) ? res.gallery : [];
          if (!list.length) {
            box.innerHTML = '<div class="vn-empty">本存档还没有 CG。<br>让管家 AI 触发生图后，这里会出现画面。</div>';
            P._latestCG = '';
            return;
          }
          var html = '<div class="vn-grid2">';
          list.forEach(function (cg) {
            var file = cg.filename || cg.file || cg.name || '';
            if (!file) return;
            var url = /^(\/|https?:)/.test(file)
              ? file
              : ('/api/saves/' + encodeURIComponent(sid) + '/images/' + encodeURIComponent(file));
            var cap = cg.character ? (cg.character + ' · NSFW场景') : (/^\d+$/.test(String(cg.index)) ? ('CG ' + cg.index) : 'CG');
            html += '<div class="vn-cg" data-url="' + esc(url) + '" data-cap="' + esc(cap) + '">' +
              '<img src="' + esc(url) + '" alt="' + esc(cap) + '" loading="lazy" ' +
              'onerror="this.style.display=\'none\';this.parentNode.classList.add(\'missing\')">' +
              '<span class="cap">' + esc(cap) + '</span></div>';
          });
          html += '</div>';
          box.innerHTML = html;
          // 最新一张作为舞台背景（单张图：新 CG 取代原背景）
          var first = $('.vn-cg', box);
          P._latestCG = first ? (first.dataset.url || '') : '';

          $$('.vn-cg', box).forEach(function (el) {
            el.addEventListener('click', function () {
              VN.openViewer(el.dataset.url, '', 'CG · 轻点任意处关闭');
            });
          });
        });
    });
  }

  /* ---------------- 记忆页 ---------------- */
  function renderMemory() {
    var box = $('#vnMemoryBody');
    if (!box) return;
    box.innerHTML = '<div class="vn-empty">正在读取记忆…</div>';
    var entries = window._memoryEntries;

    // app.js 会把记忆表挂在 window._memoryEntries（对象或数组）
    function paint(obj) {
      var keys = Array.isArray(obj) ? obj.map(function (_, i) { return String(i); }) : Object.keys(obj || {});
      if (!keys.length) { box.innerHTML = '<div class="vn-empty">还没有记忆条目。<br>管家 AI 会在对话若干轮后自动整理。</div>'; return; }
      var html = '<div class="vn-card"><h5>记忆表格 <span>' + keys.length + ' 条</span></h5>';
      keys.forEach(function (k) {
        var v = Array.isArray(obj) ? obj[Number(k)] : obj[k];
        var val = (v && typeof v === 'object') ? JSON.stringify(v) : v;
        html += '<div class="vn-kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(val) + '</span></div>';
      });
      html += '</div>';
      box.innerHTML = html;
    }

    if (entries && (Array.isArray(entries) ? entries.length : Object.keys(entries).length)) {
      paint(entries);
      return;
    }
    var c = currentConv();
    if (!c) { box.innerHTML = '<div class="vn-empty">请先开始对话。</div>'; return; }
    api('/conversations/' + encodeURIComponent(c.id)).then(function (conv) {
      var mem = (conv && (conv.memory || conv.memory_table)) || null;
      if (!mem) { box.innerHTML = '<div class="vn-empty">还没有记忆条目。</div>'; return; }
      try { paint(typeof mem === 'string' ? JSON.parse(mem) : mem); }
      catch (e) { paint({ memory: mem }); }
    }).catch(function () {
      box.innerHTML = '<div class="vn-empty">读取记忆失败。</div>';
    });
  }

  /* ---------------- 世界状态页 ---------------- */
  function renderWorld() {
    var box = $('#vnWorldBody');
    if (!box) return;
    var c = currentConv();
    if (!c) { box.innerHTML = '<div class="vn-empty">请先开始对话。</div>'; return; }
    box.innerHTML = '<div class="vn-empty">正在读取世界状态…</div>';
    api('/conversations/' + encodeURIComponent(c.id) + '/world-state').then(function (ws) {
      var wsv = (ws && (ws.variables || ws.state || ws)) || null;
      var keys = Object.keys(wsv || {});
      var html = '';
      if (keys.length) {
        html += '<div class="vn-card"><h5>变量 <span>' + keys.length + ' 项</span></h5>';
        keys.forEach(function (k) {
          var v = wsv[k];
          var val = (v && typeof v === 'object') ? (v.value != null ? v.value : JSON.stringify(v)) : v;
          html += '<div class="vn-kv"><span class="k">' + esc(k) + '</span><span class="v cyan">' + esc(val) + '</span></div>';
        });
        html += '</div>';
      } else {
        html += '<div class="vn-empty">当前角色不是 engine 卡，或还没有世界状态变量。</div>';
      }
      html += '<div class="vn-card"><h5>维护操作 <span>与桌面版一致</span></h5>' +
        '<div class="vn-kv"><span class="k">重新读取初始变量</span><span class="v cyan" data-ws="seed">↺ 执行</span></div>' +
        '<div class="vn-kv"><span class="k">重新处理全部变量</span><span class="v cyan" data-ws="reprocess">⟳ 执行</span></div>' +
        '<div class="vn-kv"><span class="k">清除楼层变量</span><span class="v rose" data-ws="clear">🗑 执行</span></div>' +
        '</div>';
      box.innerHTML = html;

      $$('[data-ws]', box).forEach(function (el) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function () {
          var act = el.dataset.ws;
          var btn = document.querySelector('.ws-act[data-ws-action="' + act + '"]');
          if (btn) { btn.click(); VN.shell.toast('已触发：' + el.parentNode.querySelector('.k').textContent); }
          else VN.shell.toast('该操作需要 engine 卡支持');
        });
      });
    }).catch(function () {
      box.innerHTML = '<div class="vn-empty">读取失败。</div>';
    });
  }

  /* ---------------- 控制台页 ---------------- */
  function renderConsole() {
    var box = $('#vnConsoleBody');
    if (!box) return;
    // 直接把 app.js 调试抽屉的两个内容区搬进来展示
    var src = $('#debugMainAgentContent');
    var src2 = $('#debugButlerContent');
    var html = '<div class="vn-card"><h5>主 Agent 输出 <span>思维链 / 完整输出</span></h5><div id="vnConsoleMain"></div></div>' +
      '<div class="vn-card"><h5>管家 AI 处理 <span>portrait / CG 判定</span></h5><div id="vnConsoleButler"></div></div>';
    if (!src && !src2) {
      box.innerHTML = '<div class="vn-empty">调试内容尚未生成。</div>';
      return;
    }
    box.innerHTML = html;
    if (src) $('#vnConsoleMain').innerHTML = src.innerHTML;
    if (src2) $('#vnConsoleButler').innerHTML = src2.innerHTML;
  }

  /* ---------------- 卡片 / 头像 ---------------- */
  /** 当前角色卡卡面：无 CG 时作为舞台背景 */
  P.cardFace = function () {
    var st = window.AppState;
    if (st && st.currentCharacter) {
      var c = st.currentCharacter;
      if (c.avatar) return c.avatar;
    }
    // 退回到 DOM 里的当前角色头像
    var el = document.querySelector('.vn-cast-av.active');
    if (el) {
      var bg = getComputedStyle(el).backgroundImage;
      var m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) return m[1];
    }
    return '/home.jpeg';
  };

  /** 当前角色立绘（engine 卡 <pic> 资源） */
  P.portrait = function () {
    var st = window.AppState;
    var c = st && st.currentCharacter;
    if (c && c.id) return '/api/characters/' + encodeURIComponent(c.id) + '/asset/portrait';
    return '';
  };

  /* ---------------- 初始化 ---------------- */
  P.init = function () {
    P.refreshAll();
    // 切页时按需刷新
    document.addEventListener('vn:page', function (e) {
      var p = e.detail;
      if (p === 'status') renderStatus();
      else if (p === 'roster') renderRoster();
      else if (p === 'gallery') renderGallery();
      else if (p === 'memory') renderMemory();
      else if (p === 'world') renderWorld();
      else if (p === 'console') renderConsole();
    });
    // 对话更新后，状态类数据延迟刷新（避免频繁请求）
    var t = null;
    setInterval(function () {
      var active = document.querySelector('.vn-tab.active');
      if (!active) return;
      var p = active.dataset.page;
      if (p === 'status' || p === 'roster' || p === 'gallery') {
        clearTimeout(t);
        t = setTimeout(function () {
          if (p === 'status') renderStatus();
          else if (p === 'roster') renderRoster();
          else renderGallery();
        }, 400);
      }
    }, 8000);
  };

  P.refreshAll = function () {
    // 初始渲染：会话可能还没载入，先只渲染状态/画廊等；
    // 名册等与当前对话强相关的数据会在对话载入后再拉（vn-shell 负责触发）。
    renderStatus();
    renderGallery();
    renderMemory();
  };
})();

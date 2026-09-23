/* =============================================================================
   AI-GAL 移动端 · 外壳（vn-shell.js）
   -----------------------------------------------------------------------------
   职责：顶栏 HUD、底部标签与页面路由、侧滑抽屉（全量菜单）、主题（明/暗）、
        字号调节、角色/存档入口、切回桌面版、toast。
   ============================================================================= */
(function () {
  'use strict';

  var VN = window.VN = window.VN || {};

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('#vnToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { }
  }

  /* ---------------- 主题（仅明 / 暗） ---------------- */
  var THEME_KEY = 'mobile-theme';
  function applyTheme(t) {
    t = (t === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var b = $('#vnBtnTheme');
    if (b) {
      b.textContent = t === 'light' ? '☀' : '☾';
      b.classList.toggle('gold', t === 'dark');
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
  }
  function initTheme() {
    var saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { }
    applyTheme(saved);
    var b = $('#vnBtnTheme');
    if (b) b.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      toast(next === 'light' ? '已切换到亮色主题' : '已切换到暗色主题');
    });
  }

  /* ---------------- 字号调节（0.85 – 1.6） ----------------
     注意：app.js 的 applyThemeVars() 会执行
       document.documentElement.removeAttribute('style')
     来清空主题变量，所以**不能**把 --fs 写在 html 的行内 style 上
     （会被抹掉，表现就是「设置里仍显示 120%，实际字号已回到 100%」）。
     改为注入一个专用 <style> 承载 --fs —— 只更新它的文本，永不被清除。
  ------------------------------------------------------------------ */
  var FS_KEY = 'mobile-font-scale', FS_MIN = 0.85, FS_MAX = 1.6, FS_STEP = 0.1,
    /* 默认字号：比原基准（1 ≈ 14px）加大两号，适配竖屏阅读。
       用户手动调过的值仍以 localStorage 为准，不受影响。 */
    FS_DEFAULT = 1.15;

  function applyFontScale(v) {
    v = Math.min(FS_MAX, Math.max(FS_MIN, Math.round((parseFloat(v) || 1) * 100) / 100));
    var tag = document.getElementById('vnFsStyle');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'vnFsStyle';
      (document.head || document.documentElement).appendChild(tag);
    }
    tag.textContent = ':root{--fs:' + v + '}';
    document.documentElement.setAttribute('data-fs', v >= 1.3 ? 'xl' : (v >= 1.15 ? 'lg' : 'md'));
    var lbl = $('#vnFsVal');
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
    try { localStorage.setItem(FS_KEY, String(v)); } catch (e) { }
    return v;
  }

  /** 当前生效的字号倍率（从注入的样式表读取，行内 style 已被 app.js 清除） */
  function currentFs() {
    var tag = document.getElementById('vnFsStyle');
    var m = tag && /--fs:\s*([0-9.]+)/.exec(tag.textContent || '');
    if (m) return parseFloat(m[1]);
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs'));
    return isNaN(v) ? 1 : v;
  }

  function initFontScale() {
    var v = FS_DEFAULT;
    try {
      var qp = new URLSearchParams(location.search);
      // ?fs= 深链：顺手写入偏好（便于验证「关闭再打开」是否记住）
      if (qp.get('fs')) { try { localStorage.setItem(FS_KEY, String(parseFloat(qp.get('fs')) || FS_DEFAULT)); } catch (e) { } }
      var p = qp.get('fs');
      v = p ? parseFloat(p) : (parseFloat(localStorage.getItem(FS_KEY)) || FS_DEFAULT);
    } catch (e) { }
    applyFontScale(v);
    var minus = $('#vnFsMinus'), plus = $('#vnFsPlus'), reset = $('#vnFsVal');
    if (minus) minus.addEventListener('click', function () {
      applyFontScale(currentFs() - FS_STEP); toast('字号 ' + $('#vnFsVal').textContent);
    });
    if (plus) plus.addEventListener('click', function () {
      applyFontScale(currentFs() + FS_STEP); toast('字号 ' + $('#vnFsVal').textContent);
    });
    if (reset) reset.addEventListener('click', function () {
      applyFontScale(FS_DEFAULT); toast('字号已重置为默认');
    });
  }

  /* ---------------- 软键盘遮挡：把指令条顶到键盘上方 ----------------
     用户报「手动输入时输入框被输入法挡住」。第一版只处理了下面模型 ①，
     第二版（本轮）用户反馈「输入框还是被挡住，但下方菜单会自动移到键盘上方」。

     移动端软键盘只有两种模型，iOS 与 Android 各占一个：
     ① 【只缩视觉视口】（iOS Safari 等）：布局视口不动，innerHeight 不变，
        visualViewport.height 变小 → kb > 0，用 --kb-inset 把内容盒压到键盘上方。
     ② 【直接缩布局视口】（Android Chrome / 多数 WebView）：innerHeight 与
        visualViewport.height【一起】变小 → 差值恒为 0 → 第一版判成"没有键盘"：
        · .kb-open 不加 → 舞台仍占着 min-height:130px，页面装不下；
        · pinCmd() 不调 → 溢出的指令条不会被滚进可视区。
        而 #vnRoot 是 position:fixed;inset:0，会跟着被缩小的布局视口走 →
        底部标签因此"自动上移"（看着像我们的占位生效了，其实是浏览器干的），
        夹在中间的指令条则被滚出可视区 —— 用户看到的"被挤掉"。

     修法（对两种模型都成立）：
     A. 「键盘模式」的判据改成【输入框正在编辑】，kb>0 只决定要不要再加 --kb-inset；
     B. vn.css 的 #vnRoot.kb-open .vn-cmd 改成 sticky 吸底 —— 只要在编辑，指令条
        必然停在滚动区下沿（= 底部标签正上方），与浏览器缩哪个视口无关；
     C. 编辑期间补几拍 pinCmd()（键盘动画期间高度会连续变化，单拍常落在动画中段）。

     两个仍必须的守卫：
     ① 只在【输入框聚焦】时才算 —— Android 地址栏伸缩同样会让两个视口差出几十像素；
     ② 差值小于 120px 一律当 0（只用于 --kb-inset）—— 地址栏 <120px，软键盘 >200px。 */
  var KB_MIN = 120;

  function initKeyboardInset() {
    var root = document.getElementById('vnRoot');
    var vv = window.visualViewport;
    if (!root || !vv) return;   // 老浏览器：不支持就不做（不会更差）

    var raf = 0;
    var pinTimer = 0;

    function editing() {
      var a = document.activeElement;
      if (!a) return false;
      var t = a.tagName;
      return t === 'TEXTAREA' || t === 'INPUT' || a.isContentEditable === true;
    }

    /* 键盘占位后页面可能不够高（小屏 + 大字号，或模型②下布局视口被浏览器缩掉）→ 滚到底，
       保证指令条确实落在可视区最下方，而不是被顶出容器。
       挂点：#vnPageChat（vn.css 里 overflow-y:auto 的那个），取不到就退回 data-page 选择器。 */
    function pinCmd() {
      var page = document.getElementById('vnPageChat') ||
        document.querySelector('.vn-page[data-page="chat"]');
      if (!page || page.scrollHeight <= page.clientHeight) return;   // 装得下就不动它
      requestAnimationFrame(function () { page.scrollTop = page.scrollHeight; });
    }

    /* 编辑期间用同一个定时器句柄补拍：键盘弹出的动画约 150~300ms，期间高度连续变化，
       只看第一帧会把指令条留在半路（连续事件也只会留下一个待执行回调，不会堆积）。 */
    function pinSoon() {
      pinCmd();
      if (pinTimer) clearTimeout(pinTimer);
      pinTimer = setTimeout(function () {
        pinTimer = 0;
        pinCmd();
      }, 260);
    }

    function apply() {
      raf = 0;
      var ed = editing();
      var kb = 0;
      if (ed) {
        kb = (window.innerHeight || 0) - vv.height - vv.offsetTop;
        if (kb < KB_MIN) kb = 0; else kb = Math.round(kb);
      }
      root.style.setProperty('--kb-inset', kb + 'px');
      /* ⚠️ 键盘模式的判据是【正在编辑】，不是 kb > 0 —— 模型②下 kb 恒为 0 而键盘确实弹着。
         反向也不会误伤：不聚焦时一律关掉，布局与没加这套东西之前完全一致。 */
      root.classList.toggle('kb-open', ed);
      if (ed) pinSoon();
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    }

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    // 聚焦/失焦各补一拍：键盘动画期间 vv 会连续变化，这里只负责兜底最后一次状态
    document.addEventListener('focusin', function () { setTimeout(schedule, 60); });
    document.addEventListener('focusout', function () { setTimeout(schedule, 60); });
    apply();
  }

  /* ---------------- 页面路由 ---------------- */
  var pages = [];
  function showPage(name) {
    $$('.vn-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.page === name); });
    $$('.vn-page').forEach(function (p) { p.classList.toggle('show', p.dataset.page === name); });
    document.dispatchEvent(new CustomEvent('vn:page', { detail: name }));
  }

  /* ---------------- 抽屉 ---------------- */
  function openDrawer(on) {
    var d = $('#vnDrawer'), s = $('#vnScrim');
    if (!d) return;
    d.classList.toggle('show', !!on);
    if (s) s.classList.toggle('show', !!on);
  }

  /* ---------------- 切回桌面版 ---------------- */
  function switchToDesktop() {
    try { localStorage.setItem('forceDesktop', '1'); } catch (e) { }
    toast('已切换：下次访问直接进入普通版');
    setTimeout(function () { location.href = '/?desktop=1'; }, 350);
  }

  /* ---------------- 角色 / 存档：复用 app.js 的能力 ---------------- */
  function openCharacterList() {
    openDrawer(false);
    renderCharacterSheet();
  }

  function renderCharacterSheet() {
    var body = $('#vnSheetBody'), sheet = $('#vnSheet'), title = $('#vnSheetTitle');
    if (!sheet || !body) return;
    if (title) title.textContent = '游戏列表';
    body.innerHTML = '<div class="vn-empty">正在读取角色卡…</div>';
    sheet.classList.add('show');
    $('#vnScrim').classList.add('show');

    var st = window.AppState;
    var list = (st && st.characters) || null;
    var p = list ? Promise.resolve(list) : fetch('/api/characters').then(function (r) { return r.json(); });
    p.then(function (chars) {
      chars = chars || [];
      if (!chars.length) {
        body.innerHTML = '<div class="vn-empty">还没有角色卡。<br>点右上角「＋」新建，或用桌面版导入 SillyTavern 角色卡。</div>';
        return;
      }
      var html = '';
      chars.forEach(function (c) {
        var tag = '';
        try {
          var tags = typeof c.tags === 'string' ? JSON.parse(c.tags) : c.tags;
          if (Array.isArray(tags) && tags.length) tag = tags.slice(0, 3).join(' · ');
        } catch (e) { }
        html += '<div class="vn-roster" data-id="' + c.id + '">' +
          '<div class="av"' + (c.avatar ? ' style="background-image:url(' + c.avatar + ')"' : '') + '></div>' +
          '<div class="info"><b>' + c.name + '</b><p>' + (tag || (c.description || '').slice(0, 40) || '—') + '</p></div>' +
          '</div>';
      });
      body.innerHTML = html;
      $$('.vn-roster', body).forEach(function (row) {
        row.addEventListener('click', function () {
          var id = row.dataset.id;
          closeSheet();
          startCharacter(id);
        });
      });
    });
  }

  /** 选择角色并开始对话（复用 app.js 的角色卡片点击流程） */
  function startCharacter(id) {
    // app.js 的 #characterList 里的条目自带点击处理：走它可保证会话创建/开场白逻辑一致
    var el = document.querySelector('#characterList [data-id="' + id + '"]');
    if (el) {
      el.click();
      toast('正在载入角色…');
      return;
    }
    try {
      if (typeof window.selectCharacter === 'function') { window.selectCharacter(id); return; }
    } catch (e) { }
    toast('请稍候，角色列表尚未就绪');
  }

  /* ---------------- 通用 Sheet（列表类浮层） ---------------- */
  function closeSheet() {
    var s = $('#vnSheet');
    if (s) s.classList.remove('show');
    $('#vnScrim').classList.remove('show');
  }

  /* ---------------- 弹窗（复用 app.js 的 modal） ---------------- */
  function openAppModal(id) {
    var el = document.getElementById(id);
    if (!el) { toast('该面板不可用'); return; }
    el.classList.remove('hidden');
  }
  function closeAllModals() {
    $$('.modal').forEach(function (m) { m.classList.add('hidden'); });
    $$('.slide-panel').forEach(function (m) { m.classList.add('hidden'); });
  }

  /* ---------------- 供应商切换（移动端原生选择器） ----------------
     app.js 的设置页把供应商做成 <select>，在移动端弹窗里手感和命中都不稳。
     这里用一个纯移动端的「点选」列表直接完成切换：点击即写库并同步回 <select>，
     保证与桌面版走同一条保存路径（派发 change 事件复用 app.js 的处理器）。
  ------------------------------------------------------------------ */
  var ROLE_KEYS = [
    { key: 'main_ai_provider_id', label: '主 AI', sel: 'mainAIProvider', empty: '默认供应商', desc: '负责叙事正文' },
    { key: 'butler_provider_id', label: '管家 AI', sel: 'butlerAIProvider', empty: '与主 AI 相同', desc: '属性整理 / BGM / 生图触发' },
    { key: 'painter_provider_id', label: '画家 AI', sel: 'painterAIProvider', empty: '与管家 AI 相同', desc: '负责生成头像与 CG' }
  ];
  var provRole = 'main_ai_provider_id';

  function openProviderPicker() {
    var sheet = $('#vnSheet'), body = $('#vnSheetBody'), title = $('#vnSheetTitle');
    if (!sheet || !body) return;
    title.textContent = 'AI 供应商';
    body.innerHTML = '<div class="vn-empty">正在读取供应商…</div>';
    sheet.classList.add('show');
    $('#vnScrim').classList.add('show');
    renderProviderPicker();
  }

  function renderProviderPicker() {
    var body = $('#vnSheetBody');
    if (!body) return;
    var providers = (window.AppState && window.AppState.providers) || [];
    var role = ROLE_KEYS.filter(function (r) { return r.key === provRole; })[0] || ROLE_KEYS[0];

    fetch('/api/themes/settings', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var cur = s[role.key] || '';
        var html = '';

        // 角色切换
        html += '<div class="vn-dr-group">为哪个角色切换</div>';
        html += '<div class="vn-role-tabs">';
        ROLE_KEYS.forEach(function (r) {
          html += '<button class="vn-role-tab' + (r.key === role.key ? ' on' : '') + '" data-role="' + r.key + '">' + r.label + '</button>';
        });
        html += '</div>';

        html += '<div class="vn-dr-group">' + role.label + ' 当前使用</div>';
        html += '<div class="vn-prov-cur">' + (function () {
          var p = providers.filter(function (x) { return x.id === cur; })[0];
          return p ? (p.name + ' <small>' + (p.model || '') + '</small>') : (role.empty + ' <small>' + role.desc + '</small>');
        })() + '</div>';

        html += '<div class="vn-dr-group">选择供应商</div>';
        // 「跟随上一级 / 默认」选项
        html += '<button class="vn-prov-item' + (cur ? '' : ' on') + '" data-id="">' +
          '<span class="nm">' + role.empty + '</span><span class="md">' + role.desc + '</span>' +
          '<span class="ck">' + (cur ? '' : '✓') + '</span></button>';

        providers.forEach(function (p) {
          var on = p.id === cur;
          html += '<button class="vn-prov-item' + (on ? ' on' : '') + '" data-id="' + p.id + '">' +
            '<span class="nm">' + escapeHtml(p.name) + (p.is_default ? ' <em>默认</em>' : '') + '</span>' +
            '<span class="md">' + escapeHtml(p.model || p.base_url || '') + '</span>' +
            '<span class="ck">' + (on ? '✓' : '') + '</span></button>';
        });

        body.innerHTML = html;

        $$('.vn-role-tab', body).forEach(function (b) {
          b.addEventListener('click', function () { provRole = b.dataset.role; renderProviderPicker(); });
        });
        $$('.vn-prov-item', body).forEach(function (b) {
          b.addEventListener('click', function () { pickProvider(role, b.dataset.id || ''); });
        });
      })
      .catch(function () {
        body.innerHTML = '<div class="vn-empty">读取供应商失败，请稍后重试。</div>';
      });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 选定供应商：同步 <select> 并派发 change（复用 app.js 的保存逻辑）
   *  注意两点（移动端切不动的根因）：
   *   1) app.js 只在「打开设置弹窗」时才填充 <select> 的 option 并绑定 change；
   *   2) 若 option 不存在，sel.value 会被静默忽略，change 也不会触发。
   *  因此这里先按 AppState 完整重建 option，再赋值、派发 change。 */
  function pickProvider(role, id) {
    var sel = document.getElementById(role.sel);
    var providers = (window.AppState && window.AppState.providers) || [];
    var p = providers.filter(function (x) { return x.id === id; })[0];

    if (sel) {
      // 1) 重建 option（默认项 + 全部供应商），保证 value 一定可赋值
      var html = '<option value="">' + role.empty + '</option>' +
        providers.map(function (x) { return '<option value="' + x.id + '">' + escapeHtml(x.name) + '</option>'; }).join('');
      sel.innerHTML = html;
      // 2) 赋值并校验
      sel.value = id;
      if (sel.value !== id) return putSetting(role, id);
      // 3) 派发 change —— 若 app.js 已绑定处理器，会走它的保存链路；
      //    未绑定（尚未打开过设置弹窗）时由下面的 PUT 兜底保存。
      var bound = false;
      try {
        // app.js 的处理器会在保存成功后 showToast('主 AI 供应商已更新' 等)
        var before = Date.now();
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        bound = true;
      } catch (e) { }
      if (!bound) return putSetting(role, id);
      // 兜底：无论 app.js 是否绑定，都保证落库（幂等）
      setTimeout(function () { putSetting(role, id, true); }, 400);
      toast(role.label + ' 已切换为：' + (p ? p.name : role.empty));
      setTimeout(renderProviderPicker, 400);
      return;
    }
    putSetting(role, id);
  }

  function putSetting(role, id, silent) {
    var payload = {};
    payload[role.key] = id;
    fetch('/api/themes/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function () {
      if (!silent) toast(role.label + ' 已更新');
      setTimeout(renderProviderPicker, 220);
    }).catch(function () { if (!silent) toast('切换失败，请重试'); });
  }

  /* ---------------- 游戏存档（同一角色卡多存档并行） ----------------
     与原前端一致：一个角色卡下可以有多份存档（conversation + save 目录），
     各自独立互不干扰。桌面的入口是侧栏角色卡的手风琴存档列表；
     移动端用「游戏存档」面板复刻同一能力：
       · 每个角色卡可展开，列出它的全部存档
       · 点存档 → 载入；「＋ 新对话」→ 生成新存档
       · 每个存档可删除 / 导出 Markdown
     载入/新建都直接调用 app.js 的 loadConversation / ConversationAPI，
     保证与桌面版走同一条链路。
  ------------------------------------------------------------------ */

  var SAVE_LAST_KEY = 'mobile-lastConv';

  function loadSave(convId) {
    if (!convId) return;
    closeSheet();
    try { localStorage.setItem(SAVE_LAST_KEY, convId); } catch (e) { }
    if (typeof window.loadConversation !== 'function') { toast('载入失败：逻辑未就绪'); return; }
    toast('正在载入存档…');
    // 标记：载入后从第 1 段开始阅读（而不是跳到最新一段）
    if (VN.stage) { VN.stage.forceFirst = true; VN.stage.lastBlockId = null; }
    window.loadConversation(convId).then(function () {
      toast('存档已载入');
      if (VN.stage) { VN.stage.forceFirst = true; VN.stage.lastBlockId = null; }
      if (VN.pages && VN.pages.fetchRoster) VN.pages.fetchRoster(true);  // 对白头像需要名册
      updateUserCard();
    }).catch(function () { toast('载入存档失败'); });
  }

  function newSave(charId) {
    closeSheet();
    // 优先触发 app.js 自己的「+ 新对话」处理器，行为与桌面完全一致
    var btn = document.querySelector('#characterList .char-conv-item[data-action="new-conv"][data-char-id="' + charId + '"]');
    if (btn) { btn.click(); toast('已新建存档'); return; }
    if (typeof window.ConversationAPI === 'undefined') { toast('新建失败：逻辑未就绪'); return; }
    window.ConversationAPI.create({ character_id: charId }).then(function (result) {
      if (result.save_id) {
        try { window.AppState._currentSaveId = result.save_id; } catch (e) { }
      }
      return window.loadConversation(result.id);
    }).then(function () {
      toast('已新建存档');
      // 刷新 app.js 的侧栏缓存，保证后续存档列表完整
      if (typeof window.renderCharacterList === 'function') window.renderCharacterList();
    }).catch(function () { toast('新建存档失败'); });
  }

  function deleteSave(convId) {
    if (!confirm('删除这个存档？该存档的对话记录会被清除（不影响同一角色的其它存档）。')) return;
    fetch('/api/conversations/' + encodeURIComponent(convId), { method: 'DELETE', credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return true; })
      .then(function () {
        toast('存档已删除');
        return (window.ConversationAPI ? window.ConversationAPI.list() : Promise.resolve([]));
      })
      .then(function (list) {
        if (window.AppState) window.AppState.conversations = list || [];
        renderSaveSheet();
      })
      .catch(function () { toast('删除失败'); });
  }

  function exportSave(saveId) {
    var url = '/api/saves/' + encodeURIComponent(saveId) + '/export-md';
    toast('正在准备导出…');
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (saveId || 'save') + '.md';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        toast('已导出 Markdown');
      })
      .catch(function () { toast('导出失败'); });
  }

  var saveExpanded = {};

  function renderSaveSheet() {
    var sheet = $('#vnSheet'), body = $('#vnSheetBody'), title = $('#vnSheetTitle');
    if (!sheet || !body) return;
    title.textContent = '游戏存档';
    body.innerHTML = '<div class="vn-empty">正在读取存档…</div>';
    sheet.classList.add('show');
    $('#vnScrim').classList.add('show');

    var chars = (window.AppState && window.AppState.characters) || [];
    // 直接用 REST 取会话列表，避免依赖 app.js 内部封装的返回形态
    var convsP = fetch('/api/conversations', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    Promise.resolve(convsP).then(function (convs) {
      convs = Array.isArray(convs) ? convs : (convs && convs.conversations) || [];
      if (window.AppState) window.AppState.conversations = convs;
      var cur = (window.AppState && window.AppState.currentConversation) || null;
      var curCharId = (window.AppState && window.AppState.currentCharacter && window.AppState.currentCharacter.id) || '';

      if (!chars.length) {
        body.innerHTML = '<div class="vn-empty">还没有角色卡。<br>先在「游戏列表」里新建或导入一张角色卡。</div>';
        return;
      }

      var html = '';
      chars.forEach(function (c) {
        var mine = convs.filter(function (x) { return x.character_id === c.id; })
          .sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
        var open = !!saveExpanded[c.id] || (c.id === curCharId && mine.length > 0);
        html += '<div class="vn-save-char' + (c.id === curCharId ? ' active' : '') + '" data-char="' + c.id + '">' +
          '<div class="head">' +
          '<div class="av"' + (c.avatar ? ' style="background-image:url(' + c.avatar + ')"' : '') + '></div>' +
          '<div class="nm">' + escapeHtml(c.name) + '<small>' + mine.length + ' 个存档</small></div>' +
          '<div class="caret">' + (open ? '▾' : '▸') + '</div>' +
          '</div>' +
          '<div class="list"' + (open ? '' : ' style="display:none"') + '>' +
          mine.map(function (cv) {
            var isCur = cur && cur.id === cv.id;
            var label = cv.save_id || cv.title || cv.id;
            return '<div class="vn-save-item' + (isCur ? ' on' : '') + '" data-conv="' + cv.id + '">' +
              '<span class="t">' + escapeHtml(label) + (isCur ? ' <em>进行中</em>' : '') + '</span>' +
              '<span class="acts">' +
              (cv.save_id ? '<button class="mi-btn" data-export="' + cv.save_id + '" title="导出 Markdown">📥</button>' : '') +
              '<button class="mi-btn del" data-del="' + cv.id + '" title="删除存档">✕</button>' +
              '</span></div>';
          }).join('') +
          '<div class="vn-save-item new" data-new="' + c.id + '"><span class="t">＋ 新对话（新存档）</span></div>' +
          '</div></div>';
      });
      body.innerHTML = html;

      // 展开 / 收起
      $$('.vn-save-char .head', body).forEach(function (h) {
        h.addEventListener('click', function () {
          var card = h.parentElement;
          var id = card.dataset.char;
          var list = $('.list', card);
          var open = list.style.display !== 'none';
          list.style.display = open ? 'none' : '';
          $('.caret', card).textContent = open ? '▸' : '▾';
          saveExpanded[id] = !open;
        });
      });
      $$('.vn-save-item', body).forEach(function (it) {
        it.addEventListener('click', function (e) {
          var exp = e.target.closest('[data-export]');
          if (exp) { e.stopPropagation(); exportSave(exp.dataset.export); return; }
          var del = e.target.closest('[data-del]');
          if (del) { e.stopPropagation(); deleteSave(del.dataset.del); return; }
          if (it.dataset.new) { newSave(it.dataset.new); return; }
          if (it.dataset.conv) { loadSave(it.dataset.conv); return; }
        });
      });
    }).catch(function () {
      body.innerHTML = '<div class="vn-empty">读取存档失败，请稍后重试。</div>';
    });
  }

  function openSaveSheet() {
    openDrawer(false);
    renderSaveSheet();
  }

  /** 首次进入时恢复上次使用的存档，让「同一个存档继续玩」 */
  function restoreLastSave() {
    if (new URLSearchParams(location.search).get('conv')) return; // 深链优先，由 app.js 处理
    var last = '';
    try { last = localStorage.getItem(SAVE_LAST_KEY) || ''; } catch (e) { }
    if (!last) return;
    if (typeof window.loadConversation !== 'function') return;
    if (VN.stage) { VN.stage.forceFirst = true; VN.stage.lastBlockId = null; }
    if (VN.stage) { VN.stage.forceFirst = true; VN.stage.lastBlockId = null; }
    setTimeout(function () {
      window.loadConversation(last).then(function () {
        if (VN.pages && VN.pages.fetchRoster) VN.pages.fetchRoster(true);
        setTimeout(updateUserCard, 300);
      }).catch(function () { });
    }, 900);
  }

  function updateUserCard() {
    var st = window.AppState || {};
    var u = st.userProfile || {};
    var av = $('#vnUserAv'), nm = $('#vnUserName'), sub = $('#vnUserSub');
    if (av) {
      if (u.avatar) { av.style.backgroundImage = 'url(' + u.avatar + ')'; av.textContent = ''; }
      else av.textContent = (u.name || '我').charAt(0);
    }
    if (nm) nm.textContent = u.name || '我';
    if (sub) {
      var c = st.currentCharacter;
      sub.textContent = c ? ('当前角色：' + c.name) : '点击可切换用户';
    }
    // 顶栏显示当前存档名（点击可切换存档）
    var title = $('#vnTitle');
    var conv = st.currentConversation;
    if (title && conv) {
      var label = conv.save_id || conv.title || '';
      if (label) {
        title.textContent = label;
        title.hidden = false;
        title.title = '当前存档：' + label + '（点击切换）';
        var rounds = $('#vnRounds');
        if (rounds) {
          var cur = rounds.textContent || '';
          var m = cur.match(/第\s*\d+\s*轮/);
          rounds.textContent = (conv.character_name || '') + (m ? ' · ' + m[0] : '');
        }
      }
    }
    // 场景条改为显示当前角色
    var loc = $('#vnLoc');
    if (loc && st.currentCharacter) {
      loc.innerHTML = '<i></i>' + st.currentCharacter.name;
    }
  }

  /* ---------------- 抽屉菜单动作 ---------------- */
  function bindDrawer() {
    $$('[data-act]').forEach(function (el) {
      el.addEventListener('click', function () {
        var act = el.dataset.act;
        openDrawer(false);
        switch (act) {
          case 'characters': renderCharacterSheet(); break;
          case 'saves': openSaveSheet(); break;
          case 'conversations': openSaveSheet(); break;
          case 'status': showPage('status'); break;
          case 'roster': showPage('roster'); break;
          case 'gallery': showPage('gallery'); break;
          case 'memory': showPage('memory'); break;
          case 'world': showPage('world'); break;
          case 'console': showPage('console'); break;
          case 'tts': openAppModal('ttsModal'); break;
          case 'providers': openProviderPicker(); break;
          case 'settings': openAppModal('settingsModal'); break;
          case 'user': openAppModal('gameSettingsModal'); break;
          case 'providers': openAppModal('settingsModal'); break;
          case 'presets': openAppModal('apiPresetsModal'); break;
          case 'import':
            var fi = document.getElementById('characterFileInput');
            if (fi) fi.click();
            break;
          case 'export':
            var ex = document.getElementById('btnExport');
            if (ex) ex.click();
            break;
          case 'imagegen': openAppModal('settingsModal'); break;
          case 'bgm':
            var bg = document.getElementById('btnToggleAudio');
            if (bg) bg.click();
            toast('已切换 BGM');
            break;
          default: toast('功能：' + act);
        }
      });
    });

    var sw = $('#vnSwitchDesktop');
    if (sw) sw.addEventListener('click', function () {
      if (confirm('切换到普通版（桌面）界面？')) switchToDesktop();
    });
  }

  /* ---------------- 底部标签 ---------------- */
  function bindTabs() {
    $$('.vn-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var p = t.dataset.page;
        if (p === 'menu') { openDrawer(true); return; }
        showPage(p);
      });
    });
  }

  /* ---------------- 角色快捷条（舞台右上） ---------------- */
  function renderCastStrip() {
    var box = $('#vnCast');
    if (!box) return;
    var st = window.AppState;
    var chars = (st && st.characters) || [];
    var cur = (st && st.currentCharacter) || null;
    box.innerHTML = '';
    chars.slice(0, 3).forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'vn-cast-av' + (cur && cur.id === c.id ? ' active' : '');
      if (c.avatar) d.style.backgroundImage = 'url(' + c.avatar + ')';
      else d.textContent = (c.name || '?').charAt(0);
      d.title = c.name;
      d.addEventListener('click', function () { startCharacter(c.id); });
      box.appendChild(d);
    });
    var add = document.createElement('div');
    add.className = 'vn-cast-av add';
    add.textContent = '＋';
    add.title = '新建 / 导入角色卡';
    add.addEventListener('click', function () {
      if (typeof window.openCharacterModal === 'function') window.openCharacterModal();
      else renderCharacterSheet();
    });
    box.appendChild(add);
  }

  /* ---------------- 顶栏按钮 ---------------- */
  function bindTop() {
    var auto = $('#vnBtnAuto'), skip = $('#vnBtnSkip');
    if (auto) auto.addEventListener('click', function () {
      auto.classList.toggle('on');
      toast('自动推进 ' + (auto.classList.contains('on') ? '开' : '关'));
    });
    if (skip) skip.addEventListener('click', function () {
      skip.classList.toggle('on');
      toast('快速跳过 ' + (skip.classList.contains('on') ? '开' : '关'));
    });
    var hist = $('#vnBtnHistory');
    if (hist) hist.addEventListener('click', function () {
      if (VN.showHistory) VN.showHistory();
      else toast('历史记录不可用');
    });
    var histClose = $('#vnHistoryClose');
    if (histClose) histClose.addEventListener('click', function () { VN.closeHistory && VN.closeHistory(); });
    var backLatest = $('#vnBackLatest');
    if (backLatest) backLatest.addEventListener('click', function () { VN.backToLatest && VN.backToLatest(); });
    var drawer = $('#vnBtnDrawer');
    if (drawer) drawer.addEventListener('click', function () { openDrawer(true); });

    // 顶部标题 → 角色列表
    var title = $('#vnTitle');
    if (title) title.addEventListener('click', openSaveSheet);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    initTheme();
    initFontScale();
    initKeyboardInset();
    bindTabs();
    bindDrawer();
    bindTop();
    bindScrim();

    var scrim = $('#vnScrim');
    if (scrim) scrim.addEventListener('click', function () { openDrawer(false); closeSheet(); });
    var sheetClose = $('#vnSheetClose');
    if (sheetClose) sheetClose.addEventListener('click', closeSheet);
    var plus = $('#vnBtnPlus');
    if (plus) plus.addEventListener('click', function () {
      var fi = document.getElementById('characterFileInput');
      if (fi) fi.click();
      toast('选择角色卡文件以导入');
    });
    var tts = $('#vnBtnTTS');
    if (tts) tts.addEventListener('click', function () { openAppModal('ttsModal'); });

    // 欢迎引导
    var pick = $('#vnWelcomePick');
    if (pick) pick.addEventListener('click', renderCharacterSheet);
    var imp = $('#vnWelcomeImport');
    if (imp) imp.addEventListener('click', function () {
      var fi = document.getElementById('characterFileInput');
      if (fi) fi.click();
    });
    // 页面内刷新按钮
    $$('[data-refresh]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.dispatchEvent(new CustomEvent('vn:page', { detail: b.dataset.refresh }));
      });
    });

    // 观察顶栏标题（app.js 会写入会话标题）→ 同步到移动端顶栏
    var src = document.getElementById('conversationTitle');
    if (src) {
      var mo = new MutationObserver(function () {
        var t = $('#vnTitle');
        if (t && src.textContent) t.textContent = src.textContent;
      });
      mo.observe(src, { childList: true, characterData: true, subtree: true });
    }

    // 观察 AppState 变化，刷新角色条（低频）
    setInterval(function () {
      var st = window.AppState;
      var key = st && st.currentCharacter ? st.currentCharacter.id : '';
      if (key !== renderCastStrip._key) { renderCastStrip._key = key; renderCastStrip(); }
      // 有角色 / 有对话后隐藏欢迎引导
      var w = document.getElementById('vnWelcome');
      if (w) {
        var has = !!(st && (st.currentCharacter || st.currentConversation));
        w.classList.toggle('hidden', has);
      }
    }, 1200);

    if (window.VN && VN.pages && VN.pages.init) VN.pages.init();
    showPage('chat');

    // 恢复上次使用的存档（同一存档继续玩），并刷新身份卡
    restoreLastSave();
    setTimeout(updateUserCard, 1200);
    setInterval(updateUserCard, 5000);

    // app.js 载入对话后（含深链 ?conv=），补拉名册并刷新顶栏
    var convWatch = '';
    setInterval(function () {
      var c = window.AppState && window.AppState.currentConversation;
      var id = c ? (c.save_id || c.id) : '';
      if (id !== convWatch) {
        convWatch = id;
        if (id && VN.pages && VN.pages.fetchRoster) VN.pages.fetchRoster(true);
        if (id && VN.refreshBackground) VN.refreshBackground();     // 背景 = 最新 CG
        if (id) setTimeout(updateUserCard, 300);
      }
    }, 1000);

    // 深链：?page=roster 等直接打开某个页面（也便于验收）
    try {
      var pg = new URLSearchParams(location.search).get('page');
      if (pg) setTimeout(function () { showPage(pg); }, 1500);
    } catch (e) { }

    // 深链：?char=<角色id> 直接进入该角色的对话；?conv=<会话id> 由 app.js 处理
    try {
      var charId = new URLSearchParams(location.search).get('char');
      if (charId) {
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          var el = document.querySelector('#characterList [data-id="' + charId + '"]');
          if (el) { clearInterval(timer); el.click(); toast('正在载入角色…'); }
          else if (tries > 20) {
            clearInterval(timer);
            toast('未找到该角色卡');
          }
        }, 400);
      }
    } catch (e) { }
  }

  function bindScrim() {
    // 关掉 app.js 弹窗时同步关闭遮罩状态（保持 body 可滚动）
    var mo = new MutationObserver(function () {
      var anyOpen = document.querySelector('.modal:not(.hidden), .slide-panel:not(.hidden)');
      document.body.classList.toggle('vn-sheet-open', !!anyOpen);
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  VN.shell = { toast: toast, vibrate: vibrate, showPage: showPage, openDrawer: openDrawer, switchToDesktop: switchToDesktop };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ===========================================================================
   桌面 VN 外壳（desktop visual-novel shell）
   ---------------------------------------------------------------------------
   桌面 VN 外壳：DOM/CSS 均在本仓库内直接维护
   旧桌面 DOM（app.js 的 DOM 契约）整块藏在 #vnLegacyDom 里，display:none 但完全可用：
   .click() 照常派发，innerHTML 照常写入，getElementById 取「文档序最前」= 外壳元素。

   分工：
     外壳负责  → 舞台 / 对话框 / 逐段演出 / 行动选项 / HUD / 数据悬浮窗 / 回顾 / 控制台 / 设置
     app.js 负责 → 会话、消息、流式生成、角色卡、存档、TTS 引擎、BGM 播放、世界状态、画廊数据

   因此这里只做两件事：
     1) 把 app.js 写进隐藏 DOM 的真实数据搬到画面上（.story-block / AppState / 隐藏面板）
     2) 用外壳上真实存在的按钮接管交互（#messageInput / #btnSend / #btnToggleAudio /
        #bgmVolume / #leftSidebar / #characterList / #btnImportCharacter ... 都被 app.js 绑定）
   =========================================================================== */
(function () {
  'use strict';

  var app = document.getElementById('app');
  if (!app) return;
  var html = document.documentElement;
  var body = document.body;

  /* 逃生门：?legacy=1 直接回到旧桌面界面（旧 DOM 一直在 #vnLegacyDom 里，随时可用） */
  if (/[?&]legacy=1(&|$)/.test(location.search)) {
    html.classList.add('legacy');
    var legacy = document.getElementById('vnLegacyDom');
    if (legacy) { legacy.removeAttribute('hidden'); legacy.removeAttribute('aria-hidden'); }
    return;
  }

  var App = window.AppState || {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function st(id) { return document.getElementById(id); }
  function byId(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  /* 捕获阶段监听：比 app.js 绑在元素/容器上的处理器更早，用来拦掉不想要的默认行为 */
  function onCap(el, ev, fn) { if (el) el.addEventListener(ev, fn, true); }
  function txt(el, v) { if (el && v != null) el.textContent = v; }
  function clampFs(v) { return Math.min(1.5, Math.max(0.85, Math.round(v * 20) / 20)); }
  function firstChar(name) { return String(name || '?').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').charAt(0) || '?'; }

  /* ---------------- 0. 提示条 ---------------- */
  var toastTimer = null;
  function toast(msg, ms) {
    var el = byId('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, ms || 2200);
  }

  /* ---------------- 1. 台词模型（逐段演出） ---------------- */
  var S = {
    blockId: null,      /* 当前正在演出的 .story-block id */
    convId: null,       /* 当前会话 id（切换会话即从头演出） */
    reviewBlockId: null,/* 回顾模式：正在看的历史条，不参与选项 */
    segs: [],
    cur: 0,
    optionsOpen: true,  /* 本轮是否还有未做出的选择 */
    cgManual: null,     /* 上方箭头手动选中的背景 CG（cgTimeline 下标）；换段/换楼即失效 */
    cgKey: '',          /* 上一次的「楼:段」；一变就把手动选择清掉，回到按文本自动分配 */
    auto: false,
    autoTimer: null
  };
  window.VN = { desktop: { S: S, render: function () { render(); }, sync: function (f) { syncFromDom(!!f); } } };

  function messagesArea() { return byId('messagesArea'); }
  function allBlocks() { var a = messagesArea(); return a ? $$('.story-block', a) : []; }
  function currentBlock() {
    if (S.reviewBlockId) {
      var found = allBlocks().filter(function (b) { return b.dataset.id === S.reviewBlockId; })[0];
      if (found) return found;
      S.reviewBlockId = null;
    }
    var blocks = allBlocks();
    /* 末尾楼层可能是空的（系统提示 / 工具楼层）：往前找最后一个有台词的楼层 */
    for (var i = blocks.length - 1; i >= 0; i--) {
      if (extractSegments(blocks[i]).length) return blocks[i];
    }
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  /** 把一个 .story-block 拆成逐段台词 */
  function extractSegments(block) {
    var out = [];
    if (!block) return out;
    if (block.classList.contains('user')) {
      var ut = $('.user-action-text', block);
      var t = ut ? ut.textContent.trim() : '';
      if (t) out.push({ kind: 'dialog', who: 'me', name: personaName(), text: t });
      return out;
    }
    $$('.narration-text, .dialog-wrapper, .scene-content, .html-message', block).forEach(function (node) {
      if (node.classList.contains('dialog-wrapper')) {
        var nameEl = $('.dialogue-name', node);
        var bodyEl = $('.dialogue-text', node) || $('.speaker-dialogue', node) || $('.dialogue-bubble', node);
        var text = bodyEl ? bodyEl.textContent.trim() : '';
        if (!text) return;
        out.push({
          kind: 'dialog',
          name: (nameEl ? nameEl.textContent : '').replace(/[:：]\s*$/, '').trim(),
          right: node.classList.contains('dialog-wrapper-right'),
          text: text
        });
      } else {
        var t2 = node.textContent.replace(/\s+\n/g, '\n').trim();
        if (t2) out.push({ kind: 'narration', text: t2 });
      }
    });
    return out;
  }

  /** 行动选项：app.js 渲染成 .choice-menu > .choice-list > .choice-option[data-action] */
  function extractChoices(block) {
    if (!block) return [];
    return $$('.choice-menu .choice-option, .choice-menu .action-btn', block).map(function (b) {
      var label = $('.choice-label', b);
      return (b.dataset.action || (label ? label.textContent : b.textContent) || '').trim();
    }).filter(Boolean);
  }

  function blockText(block) {
    if (!block) return '';
    var clone = block.cloneNode(true);
    $$('.msg-actions, .choice-menu, .tts-replay-btn, .cg-refresh-btn, .cg-delete-btn', clone)
      .forEach(function (n) { n.parentNode && n.parentNode.removeChild(n); });
    return clone.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------- 2. 说话人 / 头像 / 好感 ---------------- */
  function personaName() {
    var p = App.userProfile || {};
    return p.persona_name || p.name || '我';
  }
  /** 当前角色卡：?conv= 深链进来时 AppState.currentCharacter 可能还没选上，
      这时按会话的 character_id 到 characters 里取，保证左头像 / 名字有真数据 */
  function convCharacter() {
    var conv = App.currentConversation || {};
    if (App.currentCharacter && (!conv.character_id || App.currentCharacter.id === conv.character_id)) return App.currentCharacter;
    var chars = App.characters || [];
    if (conv.character_id) {
      var c = chars.filter(function (x) { return x.id === conv.character_id; })[0];
      if (c) return c;
    }
    return App.currentCharacter || null;
  }
  function charName() {
    var c = convCharacter();
    return (c && c.name) || '角色';
  }
  function saveId() {
    if (App._currentSaveId) return App._currentSaveId;
    var c = App.currentConversation || {};
    return c.save_id || '';
  }
  function rosterOf(name) {
    var r = App.characterRoster || {};
    if (r[name]) return r[name];
    var key = Object.keys(r).filter(function (k) { return k === name || (k && name && k.indexOf(name) >= 0); })[0];
    return key ? r[key] : null;
  }
  function avatarUrlFor(name) {
    if (!name) return '';
    var ch = convCharacter();
    if (ch && name === ch.name && ch.avatar) return ch.avatar;
    if (name === personaName()) {
      var p = App.userProfile || {};
      if (p.persona_avatar) return p.persona_avatar;
      if (p.avatar) return p.avatar;
    }
    var entry = rosterOf(name);
    if (entry && entry.avatar && entry.avatar !== 'pending') {
      return entry.avatar.charAt(0) === '/' ? entry.avatar : '/api/saves/' + saveId() + '/avatar/' + encodeURIComponent(name);
    }
    return '';
  }

  /** 说话人头像：完全照旧前端 renderDialogueBlock 的取法
      —— 用户侧用 getUserAvatarForName，其余从名册 lookupRosterEntry 找，
      名册头像是相对值就拼 /api/saves/<saveId>/avatar/<名册名>（app.js 的原路径）。 */
  function speakerAvatar(name) {
    if (!name) return '';
    try {
      if (typeof window.isUserSideName === 'function' && window.isUserSideName(name)) {
        return (typeof window.getUserAvatarForName === 'function' && window.getUserAvatarForName(name)) || '';
      }
      var r = typeof window.lookupRosterEntry === 'function' ? window.lookupRosterEntry(name) : null;
      var e = r && r.entry;
      var rn = (r && r.matchName) || name;
      if (e && e.avatar && e.avatar !== 'pending' && e.avatar !== '' && e.avatar !== '已有头像') {
        return e.avatar.charAt(0) === '/' ? e.avatar
          : '/api/saves/' + saveId() + '/avatar/' + encodeURIComponent(rn);
      }
    } catch (err) { }
    return '';
  }

  /* 头像：固定只有左侧一个槽位（右侧槽已去掉），显示「当前说话人」。 */
  function setAvatar(side, name, url, active) {
    var slot = byId('av' + side);
    var img = byId('av' + side + 'Img');
    var nm = byId('av' + side + 'Name');          /* 设计稿已去掉姓名标签，这里兼容旧 DOM */
    if (nm) nm.textContent = name || '';
    if (slot) slot.dataset.initial = (name || '').trim().charAt(0) || '?';
    if (img) {
      if (url) {
        if (img.getAttribute('src') !== url) img.setAttribute('src', url);
        img.style.visibility = '';
        img.dataset.empty = '';
      } else {
        img.removeAttribute('src');
        img.dataset.empty = '1';
        img.style.visibility = 'hidden';
      }
      slot && slot.classList.toggle('no-art', !url);
    }
    if (slot) slot.classList.toggle('on', !!active);
    if (slot && name) slot.title = name + '（点击查看大图）';
  }

  /* 当前说话人（单槽位）。原先是左右两个槽靠 dialog-wrapper-left/right 交替点亮，
     观感是「两张脸来回跳」，现改为固定左侧、只切人。 */
  var cast = { cur: null };
  function resetCast() { cast = { cur: null }; }

  /** 新一轮开头常是旁白（没人说话）——先把上一位说话人放回头像框，别让左下空着。
      单槽位版：从往前数最近的 `dialog-wrapper` 里取第一个说话人即可。 */
  function seedCastFromHistory() {
    var blocks = allBlocks();
    var cur = currentBlock();
    var idx = blocks.indexOf(cur);
    if (idx < 0) return;
    for (var i = idx - 1; i >= 0; i--) {
      var dws = $$('.dialog-wrapper', blocks[i]);
      for (var j = dws.length - 1; j >= 0; j--) {
        var nmEl = $('.dialogue-name', dws[j]);
        var nm = nmEl ? nmEl.textContent.replace(/[:：]\s*$/, '').trim() : '';
        if (!nm) continue;
        cast.cur = { name: nm, url: speakerAvatar(nm) };
        return;
      }
    }
  }

  /**
   * 把当前说话人放到唯一的左侧头像槽。
   * active = 这一段是「有人说话的对白」→ 点亮；旁白（没人说话）→ 半透明。
   */
  function syncCast(activeSeg) {
    var isDialog = !!(activeSeg && activeSeg.kind === 'dialog');
    var name = isDialog ? (activeSeg.name || '') : '';
    if (isDialog && name) cast.cur = { name: name, url: speakerAvatar(name) };
    var c = cast.cur;
    setAvatar('L', c ? c.name : '', c ? c.url : '', isDialog);
    /* 还没人说过话（新存档 / 纯旁白开头）：头像框先不上台，别留一个「?」 */
    app.classList.toggle('no-cast', !c);
    /* 旁白段：头像半透明 */
    app.classList.toggle('narr', !!activeSeg && activeSeg.kind === 'narration');
    syncAffection(name || (c && c.name) || '');
  }

  function syncAffection(speaker) {
    var aff = $('.aff', byId('dialog'));
    if (!aff) return;
    var entry = rosterOf(speaker) || {};
    var key = Object.keys(entry).filter(function (k) { return /好感|affinity|love|亲密/.test(k) && !isNaN(parseFloat(entry[k])); })[0];
    if (!key) { aff.style.display = 'none'; return; }
    var v = Math.max(0, Math.min(100, parseFloat(entry[key])));
    aff.style.display = '';
    var bar = byId('affBar'), num = byId('affNum');
    if (bar) bar.style.width = v + '%';
    txt(num, String(Math.round(v)));
  }

  /* ---------------- 3. 渲染 ---------------- */
  function segsOf(block) { return extractSegments(block); }

  function render() {
    try { renderInner(); } catch (e) {
      (window.__vnErrors = window.__vnErrors || []).push('render: ' + (e && e.message));
      console.warn('[VN] render 失败', e);
    }
  }

  function renderInner() {
    var block = currentBlock();
    /* 换段 / 换楼 → 手动选的背景 CG 失效，回到「按文本智能分配」
       （上方箭头是自由翻看，不与文本对应；一旦推进段落就重新跟随文本） */
    var key = ((block && block.dataset.id) || '') + ':' + S.cur;
    if (key !== S.cgKey) { S.cgKey = key; S.cgManual = null; }
    var dlgText = byId('dlgText');
    var dlgNarr = byId('dlgNarr');
    var narHint = byId('narHint');
    var dialog = byId('dialog');
    var plate = $('.plate', byId('dialog'));

    S.segs = segsOf(block);
    if (!S.segs.length) {
      /* 空态：清掉设计稿的演示文案，别让假台词留在画面上；旁白位留给引导语 */
      if (dlgText) dlgText.textContent = '';
      if (dlgNarr) dlgNarr.textContent = '从左侧展开游戏列表，选一张角色卡开始新的故事。\n（S = 展开列表 · M = 菜单 · D = 数据中心 · L = 回顾）';
      if (dialog) dialog.classList.add('is-narr');
      if (narHint) narHint.classList.remove('on');
      txt(byId('spkName'), '—');
      setRomaji('');
      resetCast();
      setAvatar('L', '', '', false);
      var aff0 = $('.aff', byId('dialog'));
      if (aff0) aff0.style.display = 'none';
      renderChoices([]);
      syncDots();
      syncStage();
      updateChips();
      return;
    }
    if (S.cur < 0) S.cur = 0;
    if (S.cur > S.segs.length - 1) S.cur = S.segs.length - 1;
    var seg = S.segs[S.cur];

    if (seg.kind === 'narration') {
      /* 设计稿的开关是 #dialog 上的 .is-narr（.dialog.is-narr .dlg-narr{display:block}），
         不能用 inline display:'' —— 那会退回样式表里的 display:none，正文就看不见了 */
      if (dialog) dialog.classList.add('is-narr');
      if (dlgNarr) dlgNarr.textContent = seg.text;
      if (plate) plate.style.opacity = '.35';
      txt(byId('spkName'), '旁白');
      setRomaji('');
    } else {
      if (dialog) dialog.classList.remove('is-narr');
      if (dlgText) dlgText.textContent = seg.text;
      if (plate) plate.style.opacity = '';
      var nm = seg.name || (seg.who === 'me' ? personaName() : charName());
      txt(byId('spkName'), nm);
      setRomaji(romajiHint(nm));
    }

    syncCast(seg);
    syncDots();
    syncSegButtons();
    syncStage();          /* 先定背景，再更新画面角标 —— 角标要读的是刚换上的这张 CG */
    updateChips();
    syncCgNav();

    /* 行动选项：读到本轮最后一段才出现；回滚即隐藏（传统 GAL 习惯） */
    var atLast = S.cur === S.segs.length - 1;
    var choices = S.optionsOpen && !S.reviewBlockId && atLast && block && !block.classList.contains('user')
      ? extractChoices(block) : [];
    renderChoices(choices);
    app.classList.toggle('choosing', choices.length > 0);

    /* 旁白/长文本滚动提示 */
    if (narHint) {
      var box = $('.body', byId('dialog'));
      var over = box && box.scrollHeight > box.clientHeight + 4;
      narHint.classList.toggle('on', !!over);
    }
    updateAutoTimer();
    dumpState();
  }

  /* 说话人名牌后面的小字（#spkRomaji）：
     ✗ 以前塞的是 entry['种族性别']（"human_boy" → "HUMAN_BOY"）—— 就是角色名后面那个种族性别 tag；
     ✓ 现在只放「真正的罗马音/英文名」，花名册里没有就整块藏起来（不留空格 / 不留占位）。
     同理也不再写 'NARRATION' / 'NO SAVE' 这类装饰性命名字样。 */
  function romajiHint(name) {
    var entry = rosterOf(name) || {};
    var rom = entry.romaji || entry.Romaji || entry.romaji_name || entry.name_en || entry['英文名'] || '';
    return String(rom).trim().slice(0, 18).toUpperCase();
  }
  function setRomaji(text) {
    var em = byId('spkRomaji');
    if (!em) return;
    var v = String(text == null ? '' : text).trim();
    em.textContent = v;
    em.style.display = v ? '' : 'none';
  }

  function syncDots() {
    var dots = byId('segDots');
    var badge = byId('segBadge');
    if (!dots) return;
    var n = S.segs.length;
    var cap = Math.min(n, 12);
    var from = Math.max(0, S.cur - cap + 1);
    var html = '';
    for (var i = from; i < from + cap && i < n; i++) {
      html += '<span class="dot' + (i === S.cur ? ' on' : '') + '" data-i="' + i + '"></span>';
    }
    if (from > 0) html = '<span class="more">+' + from + '</span>' + html;
    if (from + cap < n) html += '<span class="more">+' + (n - from - cap) + '</span>';
    dots.innerHTML = html;
    $$('.dot', dots).forEach(function (d) {
      d.addEventListener('click', function () { S.cur = Number(d.dataset.i); render(); });
    });
    txt(badge, n ? (S.cur + 1) + ' / ' + n : '0 / 0');
  }

  /** 上一段/下一段按钮的可用态与文案（到头就置灰，别让用户点了没反应还不知道为什么） */
  function syncSegButtons() {
    var n = S.segs.length;
    var atFirst = S.cur <= 0;
    var atLast = S.cur >= n - 1;
    var prev = byId('btnPrev');
    var next = byId('btnNext');
    if (prev) prev.classList.toggle('off', atFirst || !n);
    if (next) {
      /* 最后一段但还有选项没选时，按钮不置灰（点了会提示去选行动） */
      next.classList.toggle('off', (atLast && !(S.optionsOpen && !S.reviewBlockId)) || !n);
      next.title = atLast ? '本轮最后一段（→ / 空格）' : '下一段（→ / 空格）';
    }
  }

  function renderChoices(list) {    var box = byId('choices');
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    list.forEach(function (text, i) {
      var b = document.createElement('button');
      b.className = 'ch';
      b.type = 'button';
      var s = document.createElement('span');
      s.textContent = text;
      var k = document.createElement('kbd');
      k.textContent = String(i + 1);
      b.appendChild(s);
      b.appendChild(k);
      b.addEventListener('click', function () { chooseAction(text); });
      box.appendChild(b);
    });
  }

  function updateChips() {
    /* 右下角 CG 标签（.chip-cg）已去掉：页码在顶部 cgNav，CG 名非必要且会压住画面右下角 */
    var chipLoc = $('.chip-loc', app);
    if (chipLoc) {
      var ws = App.worldState || {};
      var locKey = Object.keys(ws).filter(function (k) { return /地点|位置|场景|location|place/i.test(k); })[0];
      var loc = locKey ? String(ws[locKey]) : '';
      if (loc) { chipLoc.style.display = ''; chipLoc.childNodes[0].nodeValue = loc; } else chipLoc.style.display = 'none';
    }
  }

  /* 舞台画面（按优先级）：
     1) app.js 的脚本背景 —— document.body.style.backgroundImage（/bg 指令 + replayScriptUIState）
        · 明确 "none" = 剧本清掉了背景，就尊重它，不放图
        · 空 = 从没设过，才继续往下找
     2) 当前楼层里嵌的 CG（img.cg-image）
     3) CG 画廊最后一张（app.js 渲染的 .cg-image，不是头像）
     都没有 → 收起 #cgImg，露出设计稿的中性渐变底（绝不放占位照片） */
  /* 背景 = 一个「当前背景」槽位（按用户要求的时间顺序）：
       ① 角色卡卡面（新存档的底） → ② 出现新 CG 就换成那张 CG → ③ 之后每张新 CG 依次替换
     剧本 /bg 命令也是「一次换背景事件」，靠 vn.bgStamp 记住它在第几楼应用的，才能和 CG 比新旧。 */
  function cardFace() {
    var c = convCharacter();
    return (c && c.avatar) || '';
  }
  var bgStamp = null;
  function readBgStamp() {
    if (bgStamp) return bgStamp;
    try { bgStamp = JSON.parse(localStorage.getItem('vn.bgStamp') || 'null'); } catch (e) { bgStamp = null; }
    return bgStamp;
  }
  /** 钩住 app.js 的剧本换背景入口，记录「哪个存档、第几楼之后」应用的 */
  function hookApplyBg() {
    if (window.__vnBgHooked || typeof window.applyChatBackground !== 'function') return;
    var orig = window.applyChatBackground;
    window.applyChatBackground = function (v) {
      try {
        var conv = (App.currentConversation && App.currentConversation.id) || '';
        /* 启动时 app.js 会重放上次的 script:bg，那时还没有当前对话（conv=''）。
           这种重放绝不能写 stamp —— 否则会把「这条背景属于哪个存档」冲成空，
           之后打开该存档就再也认不出它了（背景/隔离判断全靠 stamp.conv）。 */
        if (conv) {
          var st = {
            conv: conv,
            count: $$('#messagesArea .story-block').length,
            value: v || ''
          };
          localStorage.setItem('vn.bgStamp', JSON.stringify(st));
          bgStamp = st;
        }
      } catch (e) { }
      return orig.apply(this, arguments);
    };
    window.__vnBgHooked = true;
  }

  /** 钩住 app.js 的画廊重画入口。
      CG 生成完成后 app.js 的全部动作就是 startGalleryPoll →「AppState.cgGallery = 新列表; renderGallery();」，
      而 renderGallery 只重画画廊那一栏（viewport / 计数 / 翻页钮），从不碰舞台 #cgImg ——
      于是新 CG 要等到下一轮 syncFromDom → render() → syncStage() 才出现，
      表现就是「CG 生成后不加载，进入下一轮才显示上一轮的」。
      这里在画廊重画之后补一次舞台重算：画廊一更新，当前该显示哪张立刻跟着变。
      （boot() 里的启动轮询也会调 syncStage，但它 800ms×40 ≈ 32s 后就停了，撑不住整局游戏。） */
  function hookRenderGallery() {
    if (window.__vnGalleryHooked || typeof window.renderGallery !== 'function') return;
    var orig = window.renderGallery;
    window.renderGallery = function () {
      var r = orig.apply(this, arguments);
      try { syncStage(); } catch (e) { }
      return r;
    };
    window.__vnGalleryHooked = true;
  }
  /** 最新一张 CG：按【时间】取，不是按 DOM 顺序 ——
      历史坑：`App.cgGallery` 是「新的在前」，早先这里对旧画廊里的 <img> 取 .pop()（DOM 最后一张）
      = 拿到【最旧】的一张，于是新生成的 CG 永远换不上背景（舞台一直停在老 CG 上）。 */
  function newestCg() {
    var t = cgTimeline();
    if (t.length) return { url: t[t.length - 1].url, count: t[t.length - 1].blockNo || (1 << 30) };
    var gv = byId('galleryViewport');
    var last = gv ? $$('img.cg-image', gv).filter(function (x) { return x.getAttribute('src'); }).pop() : null;
    return last ? { url: last.getAttribute('src'), count: 1 << 30 } : null;
  }

  /** 旧画廊（#galleryViewport）里的 CG URL 列表 —— App.cgGallery 为空时的兜底：
      旧前端的画廊是「新的在前」，这里只取 URL；时间从文件名的毫秒戳里读。 */
  function legacyCgList() {
    var gv = byId('galleryViewport');
    if (!gv) return [];
    var out = [];
    $$('img.cg-image', gv).forEach(function (el) {
      var s = el.getAttribute('src') || el.dataset.big || '';
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    $$('[data-big]', gv).forEach(function (el) {
      var s = el.dataset.big || '';
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }
  /* ── CG 时间线：把画廊里的 CG 按时间【升序】排好，并归属到「生成时正在演出的那一楼」──
     归属依据 = CG 的 timestamp 落在哪一楼的 created_at 之后（App.messages 里带 created_at）。
     一条剧情里生成了多张 CG 时，就按段号把它们摊到这一楼的各段上（见 cgForSeg）。 */
  var cgTlCache = { sig: '', items: null };
  function cgTimeline() {
    var gal = (App.cgGallery || []);
    var legacy = (!gal.length) ? legacyCgList() : [];      /* 元数据没到/为空时退回旧画廊的 DOM */
    var msgs = (App.messages || []).filter(function (m) { return m && m.id != null; });
    var sig = (gal.length || 'L' + legacy.length) + '|'
      + (gal.length ? gal.map(function (g) { return String(g.timestamp || '') + String(g.file || g.filename || ''); }).join(',') : legacy.join(','))
        .slice(0, 400)
      + '|' + msgs.length + '|' + saveId();
    if (cgTlCache.sig === sig && cgTlCache.items) return cgTlCache.items;

    var items = (gal.length ? gal.map(function (g) {
      var file = String(g.file || g.filename || g.url || g.image || '');
      var ts = Date.parse(g.timestamp || g.created_at || '') || 0;
      return { file: file, url: imgUrlFor(file), ts: ts, cap: String(g.character || g.description || ''), msgId: '', order: -1, blockNo: 0 };
    }) : legacy.map(function (u) {
      /* 旧画廊只有 URL：文件名里的毫秒时间戳（_____1789582234346.jpg）就是生成时间 */
      var file = String(u).split('/').pop();
      var m = /(\d{10,})/.exec(file);
      return { file: file, url: u, ts: m ? Number(m[1]) : 0, cap: '', msgId: '', order: -1, blockNo: 0 };
    })).filter(function (x) { return !!x.url; });
    items.sort(function (a, b) { return (a.ts - b.ts); });

    /* 每张 CG → 生成时正在演出的那一楼（created_at <= ts 的最后一楼；比第一楼还早就归第一楼） */
    if (msgs.length) {
      var times = msgs.map(function (m) { return Date.parse(m.created_at || m.createdAt || '') || 0; });
      var blocks = allBlocks();
      items.forEach(function (x) {
        var k = 0;
        for (var i = 0; i < times.length; i++) if (times[i] && x.ts && times[i] <= x.ts) k = i;
        x.order = k;
        /* id 可能是数字也可能是字符串（messages 来自 API、data-id 来自 DOM）→ 统一成字符串比 */
        x.msgId = msgs[k] && msgs[k].id != null ? String(msgs[k].id) : '';
        /* blockNo = 该楼在页面上的序（1 起），用于和剧本背景的「第几楼」比新旧 */
        var idx = -1;
        for (var j = 0; j < blocks.length; j++) if (String(blocks[j].dataset.id) === x.msgId) { idx = j; break; }
        x.blockNo = idx >= 0 ? idx + 1 : (k + 1);
      });
    }
    cgTlCache = { sig: sig, items: items };
    return items;
  }

  /** 当前楼在当前段该显示哪张 CG：本楼的 CG 按段摊开；本楼没有就用「到本楼为止最后一张」 */
  function cgForSeg(segIndex) {
    var t = cgTimeline();
    if (!t.length) return null;
    var block = currentBlock();
    var id = block && block.dataset.id != null ? String(block.dataset.id) : '';
    var mine = t.filter(function (x) { return x.msgId && x.msgId === id; });
    if (mine.length) {
      var segs = Math.max(1, (S.segs || []).length);
      var k = Math.min(mine.length - 1, Math.floor((segIndex || 0) * mine.length / segs));
      return mine[k];
    }
    var order = blockOrderOf(id);
    var upto = t.filter(function (x) { return x.order >= 0 && x.order <= order; });
    if (upto.length) return upto[upto.length - 1];
    return t[0];
  }
  function blockOrderOf(blockId) {
    var msgs = (App.messages || []);
    var want = String(blockId);
    for (var i = 0; i < msgs.length; i++) if (msgs[i] && String(msgs[i].id) === want) return i;
    return msgs.length ? msgs.length - 1 : 0;
  }

  /** 有没有「正在演的这局」：没有对话 / 没有消息 → 舞台回到初次加载态（卡面或中性底），不放 CG。
      否则上一局留在画廊里的 CG 会被 newestCg() 继续当成背景，要等又生成一张新 CG 才换掉。 */
  function hasActiveStory() {
    if (!(App.currentConversation && App.currentConversation.id)) return false;
    if ((App.messages || []).length) return true;
    return allBlocks().length > 0;
  }

  /** 是否已经"读到最新"：正在看最新那一楼的最后一段。
      后台生图（管家触发 / 登场 CG）往往在这一楼演完之后才落地；此时舞台必须跟着换到新 CG，
      否则会一直停在【同一楼的第一张】（cgForSeg 按段摊分，段没变就永远取第 0 张）
      —— 这正是"后台生成 1~2 张、前端才刷新"的来源。 */
  function atLatestSegment() {
    if (S.reviewBlockId) return false;
    var blocks = allBlocks();
    if (!blocks.length) return false;
    var last = blocks[blocks.length - 1];
    var cur = currentBlock();
    if (!cur) return true;                    /* 外壳尚未定位到某一楼 → 视为"在看最新" */
    if (cur !== last) return false;
    if (!(S.segs || []).length) return true;  /* 段还没算出来 → 同上 */
    return (S.cur || 0) >= S.segs.length - 1;
  }

  /** 舞台最终用哪张：手动切换（上方箭头）优先 → 按文本分配 → 都没有才退回角色卡卡面 */
  function currentCg() {
    if (!hasActiveStory()) return null;   /* 没进游戏 / 已退出游戏 → 不出图 */
    var t = cgTimeline();
    if (S.cgManual != null && t[S.cgManual]) {
      var m = t[S.cgManual];
      return { url: m.url, count: m.blockNo || (1 << 30), manual: true };
    }
    var auto = cgForSeg(S.cur);
    /* 已经读到最新一段时：若最新一张 CG 比"按段分配"的那张更新，就用最新的。
       这样后台新出的 CG 会在几秒内自动上舞台，而不必等下一轮/下一段。 */
    if (atLatestSegment()) {
      var n2 = newestCg();
      if (n2 && (!auto || n2.url !== auto.url)) return n2;
    }
    if (auto) return { url: auto.url, count: auto.blockNo || (1 << 30) };
    var n = newestCg();
    return n;
  }

  /* ── 画面中央上方的 CG 切换器：自由翻看所有背景 CG（不与文本对应） ── */
  function cgIndexOf(url) {
    var t = cgTimeline();
    for (var i = 0; i < t.length; i++) if (t[i].url === url) return i;
    return -1;
  }
  function syncCgNav() {
    var nav = byId('cgNav');
    if (!nav) return;
    var t = cgTimeline();
    var cur = '';
    var img = byId('cgImg');
    if (img && img.getAttribute('src')) cur = img.getAttribute('src');
    var i = cur ? cgIndexOf(cur) : -1;
    if (i < 0 && S.cgManual != null) i = S.cgManual;
    var show = t.length > 1 && !app.classList.contains('ui-gone');
    nav.classList.toggle('on', show);
    txt(byId('cgIdx'), t.length ? ((i < 0 ? 1 : i + 1) + ' / ' + t.length) : '0 / 0');
    var p = byId('cgPrev'), n = byId('cgNext');
    if (p) p.disabled = !t.length;
    if (n) n.disabled = !t.length;
    nav.classList.toggle('manual', S.cgManual != null);
  }
  /** 手动翻一张：dir=+1 下一张 / -1 上一张（到头回绕，方便来回看） */
  function stepCg(dir) {
    var t = cgTimeline();
    if (!t.length) { toast('这个存档还没有 CG'); return; }
    var img = byId('cgImg');
    var cur = img && img.getAttribute('src') || '';
    var i = cgIndexOf(cur);
    if (i < 0) i = S.cgManual != null ? S.cgManual : t.length - 1;
    i = (i + dir + t.length) % t.length;
    S.cgManual = i;
    syncStage();
    toast('背景 CG ' + (i + 1) + ' / ' + t.length + (t[i].cap ? '（' + t[i].cap + '）' : ''));
  }
  function storedBg() {
    try {
      var sb = (localStorage.getItem('script:bg') || '').trim();
      if (!sb || sb === 'none' || sb === 'default') return '';
      return /^(https?:|data:|\/)/i.test(sb) ? sb : '/' + sb.replace(/^\/+/, '');
    } catch (e) { return ''; }
  }

  function syncStage() {
    var img = byId('cgImg');
    if (!img) return;
    var cg = currentCg();
    var bg = storedBg();
    var st = readBgStamp();
    var conv = (App.currentConversation && App.currentConversation.id) || '';
    var url = '';
    if (bg) {
      /* 剧本背景也必须「属于本存档」：换存档 / 没进游戏时，上一局 /bg 设的背景不能再出现
         （bgStamp 记的是「哪个存档、第几楼之后」应用的；缺 stamp 的一律不认）。
         只有属于本存档、且应用得比最新 CG 更晚的剧本背景才压过 CG。 */
      var sameSave = !!(st && st.conv === conv);
      if (!cg) { if (sameSave) url = bg; }
      else if (sameSave && (parseInt(st.count, 10) || 0) >= cg.count) url = bg;
    }
    if (!url) url = cg ? cg.url : cardFace();
    if (url) {
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      img.style.display = '';
      img.dataset.empty = '';
      app.classList.add('has-cg');
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      img.dataset.empty = '1';
      app.classList.remove('has-cg');
    }
    updateChips();   /* ← 画面角标跟着当前背景那张走（手动翻页时也要立刻跟上） */
    syncCgNav();
  }

  /* ---------------- 4. 与消息区的同步 ---------------- */
  function syncFromDom(force) {
    noteConvChange();
    var block = currentBlock();
    if (!block) return;
    var id = block.dataset.id || '';
    var convId = (App.currentConversation && App.currentConversation.id) || '';
    var segs = segsOf(block);
    if (!segs.length) return;

    var fresh = false;
    if (convId && convId !== S.convId) { S.convId = convId; fresh = true; S.reviewBlockId = null; S.cgManual = null; S.cgKey = null; resetCast(); }
    if (S.forceFirst) { fresh = true; S.forceFirst = false; }
    var isNew = id !== S.blockId;
    var lenChanged = segs.length !== S.segs.length;
    if (!force && !isNew && !lenChanged && !fresh) return;

    if (isNew || fresh) {
      S.blockId = id; S.cur = 0; S.optionsOpen = true; seedCastFromHistory();
      if (S.wantSeg != null) {
        S.cur = S.wantSeg === Infinity ? S.segs.length - 1 : Math.max(0, Math.min(S.segs.length - 1, S.wantSeg));
      }
    }
    S.segs = segs;
    if (S.reviewBlockId && S.reviewBlockId !== id) { /* 回顾态：不抢画面 */ }
    render();
    updateHeader();
    dumpState();
  }

  function updateHeader() {
    var sw = byId('saveSwitch');
    if (!sw) return;
    var conv = App.currentConversation || {};
    var name = conv.save_id || conv.title || (App.currentCharacter && App.currentCharacter.name) || '未选择存档';
    var blocks = allBlocks();
    var round = 0;
    blocks.forEach(function (b) { round = Math.max(round, parseInt(b.dataset.round, 10) || 0); });
    sw.innerHTML = '';
    var b1 = document.createElement('b');
    b1.textContent = name;
    var em = document.createElement('em');
    em.textContent = '第 ' + (round || 0) + ' 轮';
    sw.appendChild(b1);
    sw.appendChild(em);
  }

  /** 顶栏 tokens 稳定度：优先 AppState，其次 app.js 写的 #tokenContext / #tokenTotal */
  function num(el) {
    var t = el ? String(el.textContent || '').trim() : '';
    if (!t) return 0;
    var m = t.match(/([\d.]+)\s*([kKmM]?)/);
    if (!m) return 0;
    var v = parseFloat(m[1]) || 0;
    var u = m[2].toLowerCase();
    return Math.round(u === 'k' ? v * 1000 : u === 'm' ? v * 1e6 : v);
  }
  function syncTokens() {
    var box = $('.stability', app);
    if (!box) return;
    var ctx = App.tokenContext || num(byId('tokenContext'));
    var total = App.tokenTotal || num(byId('tokenTotal'));
    var numEl = $('.num', box);
    if (!total) {
      txt(numEl, '—');
      box.dataset.level = 'safe';
      var bar0 = $('i, .fill', box);
      if (bar0) bar0.style.width = '0%';
      return;
    }
    txt(numEl, (ctx / 1000).toFixed(1) + 'k / ' + (total / 1000).toFixed(1) + 'k');
    var pct = Math.min(100, Math.round(ctx / total * 100));
    var bar = $('i, .fill', box);
    if (bar) bar.style.width = pct + '%';
    box.dataset.level = pct > 85 ? 'danger' : pct > 65 ? 'warning' : 'safe';
  }

  /* ---------------- 5. 逐段导航 / 选项 / 输入 ---------------- */
  function go(d) {
    S.wantSeg = null;                              /* 用户一动，就不再受 URL 段位约束 */
    var next = S.cur + d;
    if (next < 0) { toast('已经是第一段'); return; }
    if (next > S.segs.length - 1) {
      if (S.optionsOpen && !S.reviewBlockId) { toast('本轮已读完，请选择行动或输入你的下一句'); return; }
      next = S.segs.length - 1;
    }
    S.cur = next;
    render();
  }

  function chooseAction(text) {
    var input = byId('messageInput');
    var send = byId('btnSend');
    if (!input || !send) { toast('输入区未就绪'); return; }
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
    S.optionsOpen = false;
    renderChoices([]);
    app.classList.remove('choosing');
    toast('已选择：' + text);
  }

  /** 自动播放：按文本长度估算停留时间 */
  function updateAutoTimer() {
    clearTimeout(S.autoTimer);
    if (!S.auto || S.cur >= S.segs.length - 1) return;
    var seg = S.segs[S.cur] || { text: '' };
    var wait = Math.min(9000, 1400 + seg.text.length * 90);
    S.autoTimer = setTimeout(function () { if (S.auto) { go(1); } }, wait);
  }

  function setAuto(on, silent) {
    var was = S.auto;
    S.auto = !!on;
    var b = byId('btnAuto');
    if (b) b.classList.toggle('on', S.auto);
    if (silent) return;                       /* 启动时只对齐视觉，不弹提示、不自动推进 */
    if (S.auto) { toast('自动播放：开'); go(1); } else { clearTimeout(S.autoTimer); toast('自动播放：关'); }
    if (!S.auto && was) render();             /* 关掉时立刻停掉在跑的计时器并重画 */
  }

  /* 普通 Enter 发送（app.js 只绑了 Ctrl/Cmd+Enter） */
  var input = byId('messageInput');
  on(input, 'keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      byId('btnSend') && byId('btnSend').click();
    }
  });
  /* 导入角色卡：由左侧游戏列表底部的 #btnImportCharacter 负责（app.js 自己绑了它 —— 外壳 DOM
     在文档里排在旧界面之前，所以 app.js 取到的就是这颗按钮），这里不再重复绑。 */

  /* ---------------- 6. 主题 / 字号 / 隐藏 UI ---------------- */
  var themeMode = 'dark';
  function setTheme(mode, quiet) {
    themeMode = mode === 'light' ? 'light' : 'dark';
    html.setAttribute('data-theme', themeMode);
    if (body) body.setAttribute('theme-mode', themeMode);
    try { localStorage.setItem('rp-theme-mode', themeMode); } catch (e) { }
    txt($('#btnTheme .ic, #btnTheme i', app) || byId('btnTheme'), themeMode === 'light' ? '☀' : '☾');
    var b = byId('btnTheme');
    if (b) b.textContent = themeMode === 'light' ? '☀' : '☾';
    if (!quiet) toast(themeMode === 'light' ? '浅色主题' : '深色主题');
  }
  /* app.js 的预设主题会写同一个 data-theme 属性，这里守住明/暗两态 */
  new MutationObserver(function () {
    if (html.getAttribute('data-theme') !== themeMode) html.setAttribute('data-theme', themeMode);
  }).observe(html, { attributes: true, attributeFilter: ['data-theme'] });

  /* 字号：不能写在 html 的 style 上（app.js 的 applyThemeVars 会 removeAttribute('style')） */
  var FS_KEY = 'dsh.desktopvn.fs';
  var fsStyle = document.createElement('style');
  fsStyle.id = 'vnFsStyle';
  document.head.appendChild(fsStyle);
  var fs = 1;
  try { var savedFs = parseFloat(localStorage.getItem(FS_KEY)); if (savedFs >= 0.85 && savedFs <= 1.5) fs = savedFs; } catch (e) { }
  function applyFs(quiet) {
    fs = clampFs(fs);
    fsStyle.textContent = '.app{--fs:' + fs + '}';
    txt(byId('fsVal'), Math.round(fs * 100) + '%');
    var r = byId('fsRange');
    if (r) r.value = String(Math.round(fs * 100));
    $$('#fsPresets button').forEach(function (b) { b.classList.toggle('on', Math.abs(Number(b.dataset.fs) - fs) < 0.001); });
    try { localStorage.setItem(FS_KEY, String(fs)); } catch (e) { }
    render();
    if (!quiet) toast('正文字号 ' + Math.round(fs * 100) + '%');
  }
  on(byId('fsMinus'), 'click', function () { fs -= 0.05; applyFs(); });
  on(byId('fsPlus'), 'click', function () { fs += 0.05; applyFs(); });
  on(byId('fsVal'), 'click', function () { fs = 1; applyFs(); });
  on(byId('fsRange'), 'input', function () { fs = Number(this.value) / 100; applyFs(true); });
  $$('#fsPresets button').forEach(function (b) {
    on(b, 'click', function () { fs = Number(b.dataset.fs); applyFs(); });
  });

  function setHideUI(on2) {
    app.classList.toggle('ui-gone', on2);
    var b = byId('btnHideUI');
    if (b) b.textContent = on2 ? '⛶ 显示UI' : '⛶ 隐藏UI';
    toast(on2 ? '已隐藏界面（按 H 恢复）' : '界面已恢复');
  }

  /* ---------------- 7. 悬浮窗 / 面板通用 ---------------- */
  var sheets = ['sheetHist', 'sheetConsole'];
  function openSheet(id) {
    sheets.forEach(function (s) { if (s !== id) byId(s) && byId(s).classList.remove('on'); });
    var el = byId(id);
    if (el) el.classList.add('on');
    var scrim = byId('scrim');
    if (scrim) scrim.classList.add('on');
  }
  function closeSheets() {
    sheets.forEach(function (s) { byId(s) && byId(s).classList.remove('on'); });
    var scrim = byId('scrim');
    if (scrim) scrim.classList.remove('on');
  }
  function sheetOpen() { return sheets.some(function (s) { return byId(s) && byId(s).classList.contains('on'); }); }

  var dock = byId('dock');
  function openDock(pane) {
    if (dock) dock.classList.add('on');
    if (pane) showPane(pane);
    var f = byId('fabData');
    if (f) f.classList.add('on');
  }
  function closeDock() {
    if (dock) dock.classList.remove('on');
    var f = byId('fabData');
    if (f) f.classList.remove('on');
  }
  function toggleDock() { dock && dock.classList.contains('on') ? closeDock() : openDock(); }

  $$('#dockTabs .dtab').forEach(function (t) {
    on(t, 'click', function () {
      $$('#dockTabs .dtab').forEach(function (x) { x.classList.toggle('on', x === t); });
      $$('.dock-body .pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === t.dataset.pane); });
      loadPane(t.dataset.pane);
    });
  });
  on(byId('btnDockClose'), 'click', closeDock);
  on(byId('fabData'), 'click', function (e) { e.stopPropagation(); toggleDock(); });
  on(dock, 'click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function (e) {
    if (!dock || !dock.classList.contains('on')) return;
    if (e.target.closest && e.target.closest('#dock, #fabData, #choices, #messageInput, .tool, #btnSend, #btnNext, #btnPrev, .stage, .menu, .sheet')) return;
    closeDock();
  });

  /* ---------------- 8. 左侧栏：app.js 渲染，外壳接管三件事 ----------------
     (a) 点角色卡 = 只展开这人的存档列表（不自动进入存档）
     (b) 每行存档补一个显式「载入」按钮，点了才进存档
     (c) 点竖条小头像 = 滑出游戏列表面板（而不是 app.js 默认的「选中并收起」）
     三件都必须在捕获阶段先于 app.js 的处理器执行，否则会被它的默认行为抢先。 */
  function setCurrentCharacter(id) {
    if (!id || (App.currentCharacter && App.currentCharacter.id === id)) return Promise.resolve();
    return fetch('/api/characters/' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (ch) {
        if (!ch || !ch.id) return;
        App.currentCharacter = ch;
        try { if (typeof window.initUserStatus === 'function') window.initUserStatus(ch); } catch (e) { }
        try { if (typeof window.renderStatusBar === 'function') window.renderStatusBar(); } catch (e) { }
        try { if (typeof window.renderStripAvatars === 'function') window.renderStripAvatars(); } catch (e) { }
        try { if (typeof window.renderCharacterList === 'function') window.renderCharacterList(); } catch (e) { }
      })
      .catch(function (e) { console.warn('[VN] 载入角色卡失败', e); });
  }

  /** 给每条存档行补「载入」按钮（app.js 的 DOM 里没有，外壳按需注入） */
  function decorateConvRows(scope) {
    $$('.char-conv-item:not(.new-conv)', scope || byId('characterList') || app).forEach(function (row) {
      var label = $('.conv-item-label', row);
      if (!label) return;
      var btn = $('.conv-load', row);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv-load';
        btn.dataset.convId = row.dataset.convId || '';
        btn.dataset.charId = (row.closest('[data-char-convs]') || {}).dataset
          ? row.closest('[data-char-convs]').dataset.charConvs : '';
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var cid = btn.dataset.convId;
          var chid = btn.dataset.charId;
          if (!cid) { toast('这条存档没有标识'); return; }
          toast('载入存档…');
          Promise.resolve(chid ? setCurrentCharacter(chid) : null).then(function () {
            /* setCurrentCharacter 会触发 app.js 重渲染角色列表，原来那个 label 已经被换掉，
               所以必须重新在活 DOM 里找同一条存档行再点；找不到就直接调 loadConversation。 */
            var live = $('#characterList .char-conv-item[data-conv-id="' + cid + '"] .conv-item-label');
            if (live) { live.click(); return; }
            if (typeof window.loadConversation === 'function') {
              Promise.resolve(window.loadConversation(cid)).then(function () {
                var c = byId('btnCollapseSidebar');
                if (c) c.click();
              }, function () { toast('载入失败'); });
            } else toast('载入不可用');
          });
        });
        row.insertBefore(btn, row.querySelector('.conv-item-actions') || null);
      }
      btn.textContent = row.classList.contains('active') ? '当前' : '载入';
      btn.classList.toggle('on', row.classList.contains('active'));
      /* app.js 用彩色 emoji（📥）当导出图标，跟这套单色 UI 不搭：换成单色箭头，语义放 title */
      var exp = $('.conv-export-md', row);
      if (exp && !exp.dataset.vnGlyph) {
        exp.dataset.vnGlyph = '1';
        exp.textContent = '↓';
        if (!exp.title) exp.title = '导出 Markdown';
      }
      /* 存档名就是 save_id（20260917020844375cygp），直接读太累：转成 09-17 02:08，原串留作悬停提示 */
      if (label.dataset.vnPretty) return;
      var raw = (label.textContent || '').trim();
      var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(raw);
      label.dataset.vnPretty = '1';
      label.dataset.raw = raw;
      label.title = raw || '存档';
      if (m) label.textContent = m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    });
  }

  /** 会话列表：app.js 只在 selectCharacter 里填 AppState.conversations，
      外壳不走那条路，就得自己保证它被填上——否则侧栏每张角色卡下都看不到存档行。 */
  var convFetching = null;
  function ensureConversations() {
    if (App.conversations && App.conversations.length) return Promise.resolve(App.conversations);
    if (convFetching) return convFetching;
    convFetching = fetch('/api/conversations')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        convFetching = null;
        if (Array.isArray(list)) {
          App.conversations = list;
          try { if (typeof window.renderCharacterList === 'function') window.renderCharacterList(); } catch (e) { }
        }
        return App.conversations || [];
      })
      .catch(function (e) { convFetching = null; console.warn('[VN] 取会话列表失败', e); return []; });
    return convFetching;
  }

  /** app.js 载入存档后不会重渲染侧栏，导致「当前」标记停留在旧行：外壳补一次刷新 */
  function refreshSidebar() {
    try { if (typeof window.renderCharacterList === 'function') window.renderCharacterList(); } catch (e) { }
    markActiveInSidebar();
    decorateConvRows(byId('characterList'));
  }

  /** 直接把「当前是哪个角色 / 哪条存档」标到侧栏上：
      app.js 只在 selectCharacter 里写 .active，走 ?conv= 直连或点存档行进来时它不会补，
      于是角色卡少了金框高亮、存档行少了青框、「当前」金标也不出现。 */
  function markActiveInSidebar() {
    var list = byId('characterList');
    if (!list) return;
    var convId = (App.currentConversation && App.currentConversation.id) || null;
    var charId = (App.currentCharacter && App.currentCharacter.id) || null;
    $$('.char-conv-item', list).forEach(function (row) {
      row.classList.toggle('active', !!convId && row.dataset.convId === convId);
    });
    $$('.character-item', list).forEach(function (card) {
      var isActive = (!!charId && card.dataset.id === charId) ||
        (!!convId && !!$('.char-conv-item[data-conv-id="' + convId + '"]', list) &&
          card.dataset.id === (($('.char-conv-item[data-conv-id="' + convId + '"]', list)
            .closest('[data-char-convs]') || {}).dataset || {}).charConvs);
      card.classList.toggle('active', isActive);
      if (isActive) {
        var convs = $('#characterList [data-char-convs="' + card.dataset.id + '"]');
        if (convs) convs.classList.add('show');
      }
    });
  }

  var lastSidebarConv = null;
  function noteConvChange() {
    var cc = (App.currentConversation && App.currentConversation.id) || null;
    if (cc === lastSidebarConv) return;
    lastSidebarConv = cc;
    setTimeout(refreshSidebar, 120);
  }

  function toggleCharCard(card, forceOpen) {
    var id = card.dataset.id;
    var open = function () {
      var fresh = $('#characterList .character-item[data-id="' + id + '"]') || card;
      toggleCharCardOpen(fresh, id, forceOpen);
    };
    if (App.conversations && App.conversations.length) { open(); return; }
    ensureConversations().then(function () { setTimeout(open, 30); });
  }

  function toggleCharCardOpen(card, id, forceOpen) {
    var list = $('#characterList [data-char-convs="' + id + '"]');
    var wasOpen = !!(list && list.classList.contains('show'));
    $$('#characterList .char-conv-list').forEach(function (l) { l.classList.remove('show'); });
    $$('#characterList .character-item').forEach(function (el) { el.classList.toggle('sel', el === card); });
    if (list && (forceOpen || !wasOpen)) {
      list.classList.add('show');
      App.expandedCharId = id;
      decorateConvRows(list);
      if (!list.querySelector('.char-conv-item:not(.new-conv)')) toast('这个角色还没有存档，点「＋ 新对话」开始');
    } else {
      App.expandedCharId = null;
    }
  }

  /** 点角色卡（列表里的大卡）：只展开存档列表 */
  onCap(byId('characterList'), 'click', function (e) {
    var card = e.target.closest && e.target.closest('.character-item');
    if (!card) return;                                   /* 存档行 / ＋新对话 / 编辑删除 → 交给 app.js */
    if (e.target.closest('.character-actions')) return;  /* 编辑 / 删除按钮 → 交给 app.js */
    e.stopPropagation();
    e.preventDefault();
    toggleCharCard(card);
  });

  /** 点竖条小头像：滑出面板 + 展开该角色的存档列表（不自动进存档） */
  onCap(byId('stripAvatars'), 'click', function (e) {
    var mini = e.target.closest && e.target.closest('.strip-avatar');
    if (!mini) return;
    e.stopPropagation();
    e.preventDefault();
    var sb = byId('leftSidebar');
    if (sb && !sb.classList.contains('expanded')) {
      var x = byId('btnExpandSidebar');
      if (x) x.click();
      else sb.classList.add('expanded');
    }
    var card = $('#characterList .character-item[data-id="' + mini.dataset.id + '"]');
    if (card) setTimeout(function () { toggleCharCard(card, true); }, 40);
    syncSidebarGlyph();
  });

  /* app.js 每次重渲染角色列表都会把注入的按钮冲掉：渲染后再补一遍 */
  var decoratePending = null;
  new MutationObserver(function () {
    clearTimeout(decoratePending);
    decoratePending = setTimeout(function () { decorateConvRows(byId('characterList')); }, 60);
  }).observe(byId('characterList') || app, { childList: true, subtree: true });

  function syncSidebarGlyph() {
    var sb = byId('leftSidebar');
    var b = byId('btnExpandSidebar');
    /* 顶端图标：折叠态 ▶（点开列表）/ 展开态 ◀（收起）。
       原来是 emoji 文件夹（📂 折叠 / 📁 展开），两个字形状太接近、不易辨认，改成方向明确的箭头。
       注意：这个字符是 JS 维护的（下面那个观察器会在侧栏 class 一变时重设），
       光改 index.html 里的初始文字会被这里覆盖掉。 */
    if (b && sb) b.textContent = sb.classList.contains('expanded') ? '◀' : '▶';
  }
  new MutationObserver(syncSidebarGlyph).observe(byId('leftSidebar') || app, { attributes: true, attributeFilter: ['class'] });

  /* ---------------- 8b. 设置类弹窗：按功能分类的左导航 ----------------
     旧设置弹窗把「主/管家/画家/代理」四个标签页和 供应商/主题/移动端/世界书/记忆表格/图像生成
     全堆成一列，看不出归类；「用户」弹窗同样把身份表单和三段提示词编辑器堆成 1600px 长滚动。
     这里给带 .settings-shell 的弹窗各挂一条类别栏，右侧只显示对应那一组。
     所有表单元素 id 保持不变（app.js 的绑定、switchSettingsTab 都不受影响）。 */
  var navModals = null;   /* [{modal, panes, nav}] */
  function settingsShellModals() {
    if (navModals) return navModals;
    navModals = [];
    Array.prototype.slice.call(document.querySelectorAll('.modal')).forEach(function (m) {
      var shell = m.querySelector('.settings-shell');
      var nav = shell && shell.querySelector('.settings-nav');
      if (!shell || !nav) return;
      navModals.push({
        modal: m,
        nav: nav,
        panes: Array.prototype.slice.call(shell.querySelectorAll('.settings-pane'))
      });
    });
    return navModals;
  }
  function showSettingsPane(name, modalOrId) {
    var list = settingsShellModals();
    var target = null;
    if (modalOrId) {
      var id = typeof modalOrId === 'string' ? modalOrId : (modalOrId.id || '');
      target = list.filter(function (e) { return e.modal.id === id; })[0] || null;
    }
    var entries = target ? [target] : list;
    entries.forEach(function (e) {
      if (!e.panes.length) return;
      var hit = '';
      e.panes.forEach(function (p) { if (name && p.dataset.pane === name) hit = name; });
      if (!hit) hit = e.panes[0].dataset.pane;
      /* 只切 .on：显示/隐藏交给集成层 CSS（html:not(.legacy) .settings-pane:not(.on){display:none}）。
         这样 ?legacy=1（外壳直接 return，本函数不跑）下面板仍然全部可见，不会只剩第一类。 */
      e.panes.forEach(function (p) {
        p.classList.toggle('on', p.dataset.pane === hit);
        p.style.display = '';
      });
      Array.prototype.slice.call(e.nav.querySelectorAll('.settings-nav-btn')).forEach(function (b) {
        b.classList.toggle('on', b.dataset.pane === hit);
      });
    });
  }
  var settingsNavBound = false;
  function initSettingsNav() {
    if (settingsNavBound) return;
    var list = settingsShellModals();
    if (!list.length) return;
    settingsNavBound = true;
    list.forEach(function (e) {
      e.nav.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.settings-nav-btn') : null;
        if (b && b.dataset.pane) showSettingsPane(b.dataset.pane, e.modal);
      });
      var on0 = e.nav.querySelector('.settings-nav-btn.on') || e.nav.querySelector('.settings-nav-btn');
      showSettingsPane(on0 && on0.dataset.pane, e.modal);
    });
  }

  /* ---------------- 9. BGM：按钮 / 音量由 app.js 绑定，这里同步视觉条 ---------------- */
  // 真实播放状态以 app.js 的 BGM_STATE 为准（开关只是它的镜像）：
  // 浏览器拦截自动播放时 BGM_STATE.enabled=false，视觉条与开关就都显示「关」，不再说谎。
  function bgmPlaying() {
    try {
      if (typeof BGM_STATE !== 'undefined' && BGM_STATE) {
        var el = BGM_STATE.audioEl;
        return !!(BGM_STATE.enabled && el && !el.paused && !el.ended);
      }
    } catch (e) { /* app.js 尚未加载 → 退回看图标 */ }
    var icon = byId('audioIcon');
    return !!(icon && icon.textContent.indexOf('🔇') === -1);
  }
  function syncViz() {
    var icon = byId('audioIcon');
    var viz = byId('audioVisualizer');
    if (!viz) return;
    var playing = bgmPlaying();
    var vol = Number((byId('bgmVolume') || {}).value || 30);
    viz.classList.toggle('playing', !!playing && vol > 0);
    viz.classList.toggle('paused', !playing || vol === 0);
    var btn = byId('btnToggleAudio');
    if (btn) btn.classList.toggle('off', !playing);   // 外壳样式：关 = .off
    if (icon) icon.textContent = playing ? '🔊' : '🔇'; // 图标跟着真实状态
  }
  on(byId('bgmVolume'), 'input', syncViz);
  on(byId('btnToggleAudio'), 'click', function () { setTimeout(syncViz, 60); setTimeout(syncViz, 1600); });
  // 启动时同步一次，并在 app.js 尝试自动播放（约 0.5s + 0.9s 后才定论）之后再对齐一次
  syncViz();
  setTimeout(syncViz, 700);
  setTimeout(syncViz, 1900);

  /* ---------------- 10. TTS 开关（对话框右上） ---------------- */
  function ttsEnabled() {
    var cb = byId('ttsMasterEnabled');
    if (cb) return !!cb.checked;
    try { return localStorage.getItem('rp-tts-enabled') === '1'; } catch (e) { return false; }
  }
  function syncTts() {
    var b = byId('btnTtsToggle');
    if (!b) return;
    var enabled = ttsEnabled();
    b.classList.toggle('disabled', !enabled);
    b.innerHTML = (enabled ? '🔊' : '🔇') + ' 语音';
    b.setAttribute('data-tip', enabled
      ? '语音朗读（V）· 点击重播本段'
      : '系统设置中未打开 TTS —— 请在设置中打开 TTS');
  }
  on(byId('btnTtsToggle'), 'click', function () {
    if (!ttsEnabled()) {
      toast('系统设置中未打开 TTS —— 请先在设置里打开');
      var t = byId('btnTTS');
      if (t) t.click();
      return;
    }
    var block = currentBlock();
    var replay = block && $('.tts-replay-btn', block);
    if (replay) { replay.click(); toast('正在朗读本段'); }
    else toast('本条没有可朗读的语音');
  });

  /* ---------------- 11. 数据中心 5 个 pane（读 AppState 真实数据） ---------------- */
  function imgUrlFor(name) {
    if (!name) return '';
    if (/^(https?:|\/)/.test(name)) return name;
    return '/api/saves/' + saveId() + '/images/' + encodeURIComponent(name);
  }
  function emptyPane(msg) { return '<div class="pane-empty">' + msg + '</div>'; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 渲染进设计稿已有的 .card / .kv / .roster / .cg / .mem / .mvu-row 结构里，
     样式全部由设计稿提供，不额外造类名 */
  function typeOf(v) {
    if (Array.isArray(v)) return 'arr';
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    return t === 'object' ? 'obj' : t === 'number' ? 'num' : t === 'boolean' ? 'bool' : 'str';
  }
  function flatRows(obj, prefix, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 3 || obj == null || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var path = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatRows(v, path, out, depth + 1);
      else out.push({ path: path, type: typeOf(v), value: Array.isArray(v) ? v.join(', ') : (v && typeof v === 'object' ? JSON.stringify(v) : String(v == null ? '' : v)) });
    });
    return out;
  }
  function meter(cls, pct) { return '<div class="meter ' + (cls || '') + '"><i style="width:' + pct + '%"></i></div>'; }

  /* 各 pana 对应的 app.js 懒加载函数（数据没到就催一次，别一直显示空） */
  var paneLoaded = {};
  function paneHasData(pane) {
    if (pane === 'memory') {
      var rows = (memCache.rows || []);
      return rows.length > 0 || (Array.isArray(window._memoryEntries) && window._memoryEntries.length > 0);
    }
    return true;   /* 其余面板读的是 app 的响应式状态，不存在「催了但空」的情况 */
  }
  function ensureData(pane) {
    var fn = { roster: 'loadRosterPage', memory: 'loadMemoryPage', status: 'loadStatusPage', gallery: 'loadGalleryPage' }[pane];
    if (!fn || paneLoaded[pane] || typeof window[fn] !== 'function') return;
    paneLoaded[pane] = true;
    try {
      Promise.resolve(window[fn]()).then(function () {
        /* 催了还是空（典型：启动早期 AppState._currentSaveId 还没设，旧函数直接 bail）——
           把标记放掉，等下一次 loadPane 再催，否则这个面板会永远停在「暂无」 */
        if (paneHasData(pane)) setTimeout(function () { loadPane(pane); }, 600);
        else paneLoaded[pane] = false;
      }, function () { paneLoaded[pane] = false; });
    } catch (e) { paneLoaded[pane] = false; }
  }

  function paneStatus() {
    ensureData('status');
    var el = $('.pane[data-pane="status"]');
    if (!el) return;
    var out = [];
    /* 1) 角色数值：只认真数值字段（排除 id 这类标识） */
    var numeric = [];
    var roster = App.characterRoster || {};
    var AFF = /好感|信任|体力|生命|精神|理智|亲密|san|hp|mp|等级|经验|钱|金/i;
    Object.keys(roster).slice(0, 3).forEach(function (name) {
      var r = roster[name] || {};
      Object.keys(r).forEach(function (k) {
        if (k === 'avatar' || k === '_color' || /^id$/i.test(k) || /id$/i.test(k)) return;
        var isNum = typeof r[k] === 'number';
        var num = parseFloat(r[k]);
        if (isNaN(num) || String(r[k]).trim() === '') return;
        if (!isNum && !AFF.test(k)) return;
        if (num < 0 || num > 100 || String(r[k]).length > 8) return;
        numeric.push({ who: name, k: k, v: num });
      });
    });
    if (numeric.length) {
      out.push('<div class="card"><h5>角色数值<span>' + escapeHtml(numeric[0].who) + '</span></h5><div class="kv-grid">' +
        numeric.slice(0, 6).map(function (n) {
          return '<div class="kv"><span class="k">' + escapeHtml(n.k) + '</span><span class="v rose">' + escapeHtml(String(n.v)) + '</span>' + meter('rose', Math.round(n.v)) + '</div>';
        }).join('') + '</div></div>');
    }
    /* 2) 用户状态栏（app.js 的 userStatus） */
    var status = App.userStatus || {};
    if (Object.keys(status).length) {
      out.push('<div class="card"><h5>状态栏<span>用户</span></h5><div class="kv-grid">' +
        Object.keys(status).slice(0, 8).map(function (k) {
          return '<div class="kv"><span class="k">' + escapeHtml(k) + '</span><span class="v gold">' + escapeHtml(String(status[k])) + '</span></div>';
        }).join('') + '</div></div>');
    }
    /* 3) 世界即时快照 + 上下文占用 */
    var ws = App.worldState || {};
    var rows = flatRows(ws, '', [], 0).slice(0, 8);
    if (rows.length) {
      out.push('<div class="card"><h5>世界<span>实时</span></h5><div class="kv-grid">' +
        rows.map(function (r) {
          return '<div class="kv"><span class="k">' + escapeHtml(r.path) + '</span><span class="v" style="font-size:13px">' + escapeHtml(r.value) + '</span></div>';
        }).join('') + '</div></div>');
    }
    var ctx = App.tokenContext || 0, total = App.tokenTotal || 0;
    if (total) {
      var pct = Math.min(100, Math.round(ctx / total * 100));
      out.push('<div class="card"><h5>上下文占用<span>' + (ctx / 1000).toFixed(1) + 'k / ' + (total / 1000).toFixed(1) + 'k</span></h5>' +
        meter(pct > 85 ? 'rose' : '', pct) + '</div>');
    }
    el.innerHTML = out.join('') || '<div class="card"><h5>主要状态<span>暂无</span></h5><div class="empty-state">暂无状态数据（进行对话后出现）</div></div>';
  }

  function paneRoster() {
    ensureData('roster');
    var el = $('.pane[data-pane="roster"]');
    if (!el) return;
    var roster = App.characterRoster || {};
    var names = Object.keys(roster);
    /* 当前角色始终显示（即使名册还没生成） */
    if (!names.length && App.currentCharacter) names = [App.currentCharacter.name];
    if (!names.length) { el.innerHTML = '<div class="card"><h5>角色名册<span>暂无</span></h5><div class="empty-state">还没有角色名册（管家 AI 生成后出现）</div></div>'; return; }
    el.innerHTML = names.map(function (name) {
      var r = roster[name] || {};
      var url = speakerAvatar(name);
      var desc = [r['种族性别'], r['年龄'] ? r['年龄'] + '岁' : '', r['身份'] || r['职业'] || r['简要介绍']]
        .filter(Boolean).join(' · ') || (name === personaName() ? '玩家' : '');
      var affKey = Object.keys(r).filter(function (k) { return /好感|affinity|信任/.test(k) && !isNaN(parseFloat(r[k])); })[0];
      var aff = affKey ? Math.max(0, Math.min(100, parseFloat(r[affKey]))) : null;
      return '<div class="roster" data-name="' + escapeHtml(name) + '"' + (url ? ' data-big="' + escapeHtml(url) + '"' : '') + '>' +
        '<div class="av"' + (url ? ' style="background-image:url(' + escapeHtml(url) + ')"' : '') + '>' + (url ? '' : escapeHtml(firstChar(name))) + '</div>' +
        '<div class="info"><b>' + escapeHtml(name) + '</b><p>' + escapeHtml(desc) + '</p>' + (aff != null ? meter('rose', Math.round(aff)) : '') + '</div>' +
        (aff != null ? '<span class="rel">' + escapeHtml(affKey) + ' ' + Math.round(aff) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  function paneGallery() {
    ensureData('gallery');
    var el = $('.pane[data-pane="gallery"]');
    if (!el) return;
    var gal = App.cgGallery || [];
    /* 画廊只放 CG：头像 / 卡面一个都不进（旧存档的 cg_gallery.json 里可能混过立绘，
       所以除了「不渲染头像卡片」之外，这里再按名册头像文件名过滤一道）。 */
    var avatarFiles = {};
    function markAvatar(u) {
      if (u && typeof u === 'string') avatarFiles[u.split('/').pop().split('?')[0]] = 1;
    }
    var roster = App.characterRoster || {};
    Object.keys(roster).forEach(function (n) { markAvatar(roster[n] && roster[n].avatar); });
    markAvatar(avatarUrlFor(charName()));
    markAvatar(avatarUrlFor(personaName()));
    var onlyCg = gal.filter(function (g) {
      var f = String(g.file || g.filename || g.url || g.image || '').split('/').pop().split('?')[0];
      return !f || !avatarFiles[f];
    });
    var items = onlyCg.map(function (g, i) {
      var file = g.file || g.filename || g.url || g.image || '';
      var url = imgUrlFor(file);
      var cap = g.description || g.name || g.title || g.character || ('CG ' + (i + 1));
      return '<div class="cg" data-big="' + escapeHtml(url) + '" data-name="' + escapeHtml(cap) + '"' +
        (url ? ' style="background-image:url(' + escapeHtml(url) + ')"' : '') + '><span class="cap">' + escapeHtml(cap) + '</span></div>';
    });
    el.innerHTML = items.length
      ? '<div class="card"><h5>CG 画廊<span>' + onlyCg.length + ' 张</span></h5><div class="cg-grid">' + items.join('') + '</div></div>'
      : '<div class="card"><h5>CG 画廊<span>空</span></h5><div class="empty-state">画廊还是空的（生成 CG 后出现）</div></div>';
  }

  /* ── 记忆表格：外壳自己拉 /api/saves/<id>/memory ──
     原先这里只读 window._memoryEntries（旧面板 loadMemoryPage() 的副产物），
     而 loadMemoryPage() 在启动早期就被 ensureData() 催过一次，那时 AppState._currentSaveId
     还是空的 ⇒ 直接 bail 成「未找到当前存档」，且 ensureData 的 paneLoaded 标记让它不再重试
     ⇒ 数据明明有（实测该存档 35 条），面板永远显示「暂无」。现在外壳自己取数并缓存，
     取到后再刷一次面板；旧面板那条路仍保留（记忆条目点击编辑要用它的 openMemoryEdit）。 */
  var memCache = { save: '', rows: null, fetching: false };
  function memoryRows() {
    var sid = saveId();
    if (!sid) return memCache.rows || [];
    if (memCache.save === sid && memCache.rows) return memCache.rows;
    if (memCache.fetching) return memCache.rows || [];
    memCache.fetching = true;
    memCache.save = sid;
    fetch('/api/saves/' + encodeURIComponent(sid) + '/memory')
      .then(function (r) { return r.ok ? r.json() : { memory: [] }; })
      .then(function (j) {
        var mem = (j && j.memory) || [];
        var entries = Array.isArray(mem) ? mem : Object.keys(mem).map(function (k) { return { key: k, value: mem[k] }; });
        memCache.rows = entries.map(function (m) {
          return {
            k: m.key || m.topic || m.name || m.title || '',
            tag: m.round || m.turn || '',
            v: m.value || m.content || m.summary || m.text || ''
          };
        });
        memCache.fetching = false;
        if ($('.pane[data-pane="memory"]')) loadPane('memory');
      })
      .catch(function () { memCache.fetching = false; });
    return memCache.rows || [];
  }

  function paneMemory() {
    ensureData('memory');
    var el = $('.pane[data-pane="memory"]');
    if (!el) return;
    var rows = memoryRows();
    if (!rows.length) {
      var mem = window._memoryEntries;
      if (Array.isArray(mem) && mem.length) {
        rows = mem.map(function (m) {
          return { k: m.key || m.name || m.topic || m.title || '', tag: m.round || m.turn || '', v: m.value || m.content || m.summary || m.text || '' };
        });
      } else {
        var ws = App.worldState || {};
        var memObj = ws['记忆'] || ws['memory'] || ws['记忆表格'];
        if (memObj && typeof memObj === 'object') {
          rows = Object.keys(memObj).map(function (k) { return { k: k, tag: '', v: typeof memObj[k] === 'object' ? JSON.stringify(memObj[k]) : String(memObj[k]) }; });
        }
      }
    }
    if (!rows.length) { el.innerHTML = '<div class="card"><h5>记忆表格<span>暂无</span></h5><div class="empty-state">还没有记忆摘要（管家 AI 生成后出现）</div></div>'; return; }
    el.innerHTML = '<div class="card"><h5>记忆表格<span>共 ' + rows.length + ' 条 · 管家 AI 摘要</span></h5>' + rows.map(function (r) {
      return '<div class="mem"><div class="k">' + escapeHtml(r.k) + (r.tag ? '<em>' + escapeHtml(String(r.tag)) + '</em>' : '') + '</div><p class="v">' + escapeHtml(String(r.v)) + '</p></div>';
    }).join('') + '</div>';
  }

  function paneWorld() {
    var el = $('.pane[data-pane="world"]');
    if (!el) return;
    var rows = flatRows(App.worldState || {}, '', [], 0);
    var acts = '<div class="ws-acts">' +
      '<button class="tool" data-ws="seed">↺ 重读初始值</button>' +
      '<button class="tool" data-ws="reprocess">⟳ 重新处理</button>' +
      '<button class="tool" data-ws="clear">🗑 清除</button>' +
      '<button class="tool" data-ws="add">＋ 新增</button></div>';
    el.innerHTML = '<div class="card"><h5>MVU 世界状态<span>engine 卡</span></h5>' + acts +
      (rows.length
        ? rows.map(function (r) {
          return '<div class="mvu-row"><span class="n">' + escapeHtml(r.path) + '</span><span class="ty">' + r.type + '</span><span class="val">' + escapeHtml(r.value) + '</span></div>';
        }).join('')
        : '<div class="empty-state">世界状态为空（可让 AI 生成或点「重读初始值」播种）</div>') +
      '</div>';
    $$('.ws-acts .tool[data-ws]', el).forEach(function (b) {
      on(b, 'click', function () {
        var act = b.dataset.ws;
        var fns = { seed: 'seedWorldStateFromGreeting', reprocess: 'reprocessWorldState', clear: 'clearWorldState' };
        /* 「新增」要走 prompt，和 app.js 保持一致 */
        if (act === 'add') {
          var path = prompt('变量路径（RFC6902 风格，如 /contact/新角色/affection）：', '/contact/新角色');
          if (!path) return;
          var raw = prompt('值（字符串；数字可直接写）：', '');
          if (raw === null) return;
          if (typeof window.setWorldVarByPath === 'function') {
            try { window.setWorldVarByPath(path, raw); toast('已写入 ' + path); setTimeout(paneWorld, 900); }
            catch (e) { toast('写入失败：' + e.message); }
          } else toast('该操作当前不可用');
          return;
        }
        var fn = fns[act] && window[fns[act]];
        if (typeof fn === 'function') {
          try {
            var r = fn();
            toast('已执行：' + b.textContent.trim());
            if (r && typeof r.then === 'function') r.then(function () { setTimeout(paneWorld, 900); }, function () { setTimeout(paneWorld, 900); });
            else setTimeout(paneWorld, 900);
            return;
          } catch (e) { toast('执行失败：' + e.message); }
        }
        /* 兜底：点旧面板上的同名按钮（老代码走的是抽屉里的静态按钮） */
        var target = document.querySelector('.ws-act[data-ws-action="' + act + '"]');
        if (target) { target.click(); toast('已触发：' + b.textContent.trim()); setTimeout(paneWorld, 900); }
        else toast('该操作当前不可用');
      });
    });
  }
  function showPane(name) {
    $$('#dockTabs .dtab').forEach(function (x) { x.classList.toggle('on', x.dataset.pane === name); });
    $$('.dock-body .pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === name); });
    loadPane(name);
  }
  function loadPane(name) {
    try {
      if (name === 'status') paneStatus();
      else if (name === 'roster') paneRoster();
      else if (name === 'gallery') paneGallery();
      else if (name === 'memory') paneMemory();
      else if (name === 'world') paneWorld();
    } catch (e) { console.warn('[VN] pane', name, e); }
  }

  /* ---------------- 12. 回顾面板：真实会话逐条 + 展开全文 ---------------- */
  var HIST_KEY = 'dsh.desktopvn.histScope';
  function scopeMatches(block, scope) {
    if (scope === 'all') return true;
    if (scope === 'narr') return !block.classList.contains('user') && !$('.dialog-wrapper', block);
    return !block.classList.contains('user') && !!$('.dialog-wrapper', block);
  }
  /* 一行 = 一条完整消息（71 轮也不会炸），展开看全文，并按段落跳转 */
  /* 一行 = 一轮对话（一问一答算一轮）——编号与 /hide N / /unhide N 完全同源：
     app.js 在每条 user 消息上让 AppState.roundCounter +1，assistant 沿用同一个值，
     于是 story-block 的 data-round 就是「轮」，/hide 也是按 user 消息数轮。
     以前这里是一行一条消息（user/assistant 各占一行、还各自编号 #1 #2 …），
     于是「回顾」里的 #6/#7 其实是同一轮，跟 /hide 3 对不上。 */
  function renderHistory() {
    var body2 = byId('histBody');
    if (!body2) return;
    var scope = localStorage.getItem(HIST_KEY) || 'all';
    var blocks = allBlocks();
    if (!blocks.length) { body2.innerHTML = emptyPane('还没有对话内容'); return; }

    var order = [], byRound = {};
    blocks.forEach(function (b) {
      var r = String(b.dataset.round == null || b.dataset.round === '' ? '0' : b.dataset.round);
      if (!byRound[r]) { byRound[r] = []; order.push(r); }
      byRound[r].push(b);
    });

    function segText(block) {
      return segsOf(block).map(function (s) {
        return s.kind === 'narration' ? s.text : (s.name ? s.name + '：' + s.text : s.text);
      }).join(' ');
    }
    function segList(block, tag) {
      var isUser = block.classList.contains('user');
      var who = isUser ? personaName() : charName();
      var segs = segsOf(block);
      if (!segs.length) return '';
      return '<p class="qa">' + tag + '</p>' + segs.map(function (s, si) {
        return '<p class="q"><span class="q-who">' + escapeHtml(s.kind === 'narration' ? '旁白' : (s.name || who)) + '</span>' +
          escapeHtml(s.text) +
          '<button class="jump" data-block="' + escapeHtml(block.dataset.id || '') + '" data-seg="' + si + '">跳到这段 ›</button></p>';
      }).join('');
    }

    var out = [];
    var nShown = 0, maxRound = 0;
    // 「重新生成」只给最后一轮（中间轮次的上下文已被后续楼层改写，重发不会自洽）
    var maxRoundRound = 0;
    blocks.forEach(function (b) {
      var r = Number(b.dataset.round == null || b.dataset.round === '' ? 0 : b.dataset.round) || 0;
      if (r > maxRoundRound) maxRoundRound = r;
    });
    order.forEach(function (r) {
      var group = byRound[r].filter(function (b) { return segsOf(b).length && scopeMatches(b, scope); });
      if (!group.length) return;
      nShown++;
      maxRound = Math.max(maxRound, Number(r) || 0);

      var q = group.filter(function (b) { return b.classList.contains('user'); })[0] || null;
      var a = group.filter(function (b) { return !b.classList.contains('user'); })[0] || null;
      var hidden = group.some(function (b) { return b.classList.contains('is-hidden'); });
      var times = '';
      var timeEl = (q || a) && (q || a).querySelector('.ai-time, .user-action-time');
      if (timeEl) times = timeEl.textContent.trim();

      var preview = [];
      if (q) preview.push('问：' + segText(q));
      if (a) preview.push('答：' + segText(a));
      if (!preview.length) preview.push(segText(group[0]));

      var segCount = group.reduce(function (n, b) { return n + segsOf(b).length; }, 0);
      var who = q ? '你' : charName();
      var isLatestRound = Number(r) === maxRoundRound;
      out.push(
        '<div class="hist' + (q ? ' me' : '') + (hidden ? ' ishidden' : '') + '" data-round="' + escapeHtml(r) + '">' +
        '<span class="who">' + escapeHtml((Number(r) ? '第 ' + r + ' 轮' : '开场')) + '</span>' +
        '<span class="txt">' + escapeHtml(preview.join('　').slice(0, 200)) + '</span>' +
        '<span class="seq">#' + escapeHtml(r) + (hidden ? '<em>已隐藏</em>' : '') + '</span>' +
        '<span class="exp">▾</span>' +
        '<div class="full">' +
        '<p class="meta">' + escapeHtml(who + ' · ' + (Number(r) ? '第 ' + r + ' 轮' : '开场') + ' · ' + group.length + ' 楼 / ' + segCount + ' 段' +
          (hidden ? ' · 已隐藏（AI 不读）' : '') + (times ? ' · ' + times : '')) + '</p>' +
        '<div class="hist-ops">' +
        '<button class="hop danger" data-hist-op="del" data-round="' + escapeHtml(r) + '" title="删除这一轮的 AI 回复（含管家 Agent 处理记录），保留你的发言">🗑 删除这条回复</button>' +
        (isLatestRound ? '<button class="hop" data-hist-op="regen" data-round="' + escapeHtml(r) + '" title="删除这一轮的回复并重新生成">↻ 重新生成</button>' : '') +
        '</div>' +
        (q ? segList(q, '问') : '') +
        (a ? segList(a, '答') : '') +
        '</div></div>'
      );
    });
    body2.innerHTML = out.join('') || emptyPane('该筛选下没有内容');
    /* 副标题给真实轮数（以前是设计稿里的静态「12 轮」） */
    var sub = $('#sheetHist .sub');
    if (sub) sub.textContent = '本存档 · ' + maxRound + ' 轮 / ' + blocks.length + ' 楼';
    $$('.hist', body2).forEach(function (h) {
      on(h, 'click', function (e) {
        if (e.target.closest('.jump')) return;
        h.classList.toggle('open');
      });
    });
    $$('.hist .jump', body2).forEach(function (b) {
      on(b, 'click', function (e) {
        e.stopPropagation();
        S.reviewBlockId = b.dataset.block || null;
        S.cur = Number(b.dataset.seg) || 0;
        closeSheets();
        render();
        toast('已跳到历史段落（再按 → 可继续逐段看）');
      });
    });
    /* 单条回复的删除 / 重新生成 */
    $$('.hist .hop', body2).forEach(function (b) {
      on(b, 'click', function (e) {
        e.stopPropagation();
        var round = b.dataset.round;
        var op = b.dataset.histOp;
        var n = aiBlocksOfRound(round).length;
        if (!n) { toast('这一轮没有可删除的 AI 回复'); return; }
        if (op === 'regen') {
          if (!confirm('删除「第 ' + round + ' 轮」的 AI 回复并重新生成？\n（你的发言会保留，作为重新生成的输入）')) return;
          regenerateRound(round);
          return;
        }
        if (!confirm('删除「第 ' + round + ' 轮」的 AI 回复？\n会一并删除该轮的管家 Agent 处理记录（含思维链 / portrait / CG 判定）。\n你的发言会保留。')) return;
        b.disabled = true;
        deleteRoundReply(round).then(function (dropped) {
          toast('已删除该轮回复' + (dropped ? '，并清掉 ' + dropped + ' 条管家处理记录' : ''));
        }).catch(function (err) {
          toast('删除失败：' + (err && err.message ? err.message : err));
          b.disabled = false;
        });
      });
    });
    var all = byId('histExpandAll');
    if (all) all.textContent = '展开全部';
    syncHistScopeButtons(scope);
  }
  function syncHistScopeButtons(scope) {
    $$('#sheetHist [data-hist-scope]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.histScope === scope);
    });
  }
  $$('#sheetHist [data-hist-scope]').forEach(function (b) {
    on(b, 'click', function () {
      try { localStorage.setItem(HIST_KEY, b.dataset.histScope); } catch (e) { }
      syncHistScopeButtons(b.dataset.histScope);
      renderHistory();
    });
  });
  on(byId('histExpandAll'), 'click', function () {
    var anyClosed = !!$('#histBody .hist:not(.open)');
    $$('#histBody .hist').forEach(function (h) { h.classList.toggle('open', anyClosed); });
    this.textContent = anyClosed ? '收起全部' : '展开全部';
    this.classList.toggle('on', anyClosed);
  });

  /* ---------------- 12.5 「回顾」里删除单条回复 / 重新生成 ----------------
     用途：某一轮 AI 生成效果不佳（格式崩了、内容废了）时，只删掉【这一轮的 AI 回复】
     再重新生成，而不是把整段对话删掉重来。
     · 删除范围：该轮的 AI 楼层（messages 表里那条 assistant）＋ 该轮【管家 Agent 的处理记录】
       （幕后控制台的调试卡片，含思维链 / portrait / CG 判定），以及服务端 event_log 里的对应记忆行
       （DELETE /api/messages/:id 内部会调 cleanupEventLog）。
     · 用户自己的发言保留 —— 那是「重新生成」的输入。
     · 只有【最后一轮】才提供「重新生成」：中间轮次的上下文已经被后续楼层改写，
       直接重发生成的结果不会与后续剧情自洽。 */
  function roundOfHistRow(row) {
    var r = row.getAttribute('data-round');
    return r == null ? '' : String(r);
  }
  /** 该轮里的 AI 楼层（.story-block.assistant） */
  function aiBlocksOfRound(round) {
    return allBlocks().filter(function (b) {
      return !b.classList.contains('user') && String(b.dataset.round == null ? '' : b.dataset.round) === String(round);
    });
  }
  function userBlocksOfRound(round) {
    return allBlocks().filter(function (b) {
      return b.classList.contains('user') && String(b.dataset.round == null ? '' : b.dataset.round) === String(round);
    });
  }
  /** 删掉该轮在「幕后控制台」里的调试卡片（主 Agent + 管家 Agent 成对出现） */
  function dropDebugCardsOfRound(round) {
    var removed = 0;
    ['debugMainAgentContent', 'debugButlerContent'].forEach(function (id) {
      var box = byId(id);
      if (!box) return;
      $$('.debug-card', box).forEach(function (c) {
        var r = c.getAttribute('data-round');
        if (r != null && String(r) === String(round)) { c.remove(); removed++; }
      });
    });
    return removed;
  }
  function deleteRoundReply(round) {
    var ai = aiBlocksOfRound(round);
    if (!ai.length) { toast('这一轮没有可删除的 AI 回复'); return Promise.resolve(0); }
    var ids = ai.map(function (b) { return b.dataset.id; }).filter(function (x) { return x && x.indexOf('stream-') !== 0 && x.indexOf('temp-') !== 0; });
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return fetch('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
          if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
        });
      });
    });
    return chain.then(function () {
      // 前端同步清理：楼层 + AppState + 管家调试记录
      ai.forEach(function (b) {
        if (S.reviewBlockId === b.dataset.id) S.reviewBlockId = null;
        b.remove();
      });
      try {
        App.messages = (App.messages || []).filter(function (m) { return ids.indexOf(m.id) < 0; });
      } catch (e) { }
      var dropped = dropDebugCardsOfRound(round);
      try { renderConsole(); } catch (e) { }
      syncFromDom(true);
      renderHistory();
      return dropped;
    });
  }
  /** 用该轮的用户发言重新生成一条回复（等价于「原地重发」，不会留下重复的用户楼层） */
  function regenerateRound(round) {
    var users = userBlocksOfRound(round);
    var last = users[users.length - 1];
    var content = last ? blockText(last).trim() : '';
    if (!content) { toast('找不到这一轮的用户发言，无法重新生成'); return; }
    var userIds = users.map(function (b) { return b.dataset.id; })
      .filter(function (x) { return x && x.indexOf('stream-') !== 0 && x.indexOf('temp-') !== 0; });
    // 先删旧回复；再把该轮原有的用户发言也删掉（内容已抓在手里），
    // 否则重发会产生第二条一模一样的用户楼层，画面上看着像重复了一遍。
    deleteRoundReply(round).then(function () {
      var chain = Promise.resolve();
      userIds.forEach(function (id) {
        chain = chain.then(function () {
          return fetch('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
            if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
          });
        });
      });
      return chain.then(function () {
        users.forEach(function (b) {
          if (S.reviewBlockId === b.dataset.id) S.reviewBlockId = null;
          b.remove();
        });
        try { App.messages = (App.messages || []).filter(function (m) { return userIds.indexOf(m.id) < 0; }); } catch (e) { }
        syncFromDom(true);
      });
    }).then(function () {
      if (typeof sendMessage !== 'function') { toast('当前环境无法发送，请手动重发'); return; }
      var inp = byId('messageInput');
      if (inp) {
        inp.value = content;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      closeSheets();
      sendMessage();
      toast('已删除旧回复，正在重新生成…');
    }).catch(function (e) {
      toast('重新生成失败：' + (e && e.message ? e.message : e));
    });
  }

  /* ---------------- 13. 控制台：真实调试卡片逐条展开 ---------------- */
  function debugCards(container) {
    if (!container) return [];
    var cards = $$('.debug-card', container);
    if (cards.length) return cards;
    var t = container.textContent.trim();
    return t ? null : [];
  }
  function renderConsole() {
    var tabs = { agent: { src: byId('debugMainAgentContent'), dst: byId('logAgent') }, butler: { src: byId('debugButlerContent'), dst: byId('logButler') } };
    var PLACEHOLDER = /将在此显示|暂无|等待|输出将/;
    Object.keys(tabs).forEach(function (k) {
      var src = tabs[k].src, dst = tabs[k].dst;
      if (!dst) return;
      if (!src) { dst.innerHTML = emptyPane('调试面板不可用'); return; }
      var cards = debugCards(src);
      if (cards && cards.length) {
        dst.innerHTML = cards.map(function (c, i) {
          var head = c.querySelector('.debug-card-header, .debug-card-title, h4, h5, summary');
          var sum = c.querySelector('.debug-card-summary');
          var rnd = c.querySelector('.debug-card-round');
          var title = (sum && sum.textContent.trim())
            ? ((rnd && rnd.textContent.trim()) ? rnd.textContent.trim() + ' · ' : '') + sum.textContent.trim()
            : (head ? head.textContent.replace(/[▶◀▸▾▲▼]/g, ' ').replace(/\s+/g, ' ').trim()
              : (c.textContent.trim().split('\n')[0] || ('条目 ' + (i + 1))));
          var clone = c.cloneNode(true);
          var h2 = clone.querySelector('.debug-card-header, .debug-card-title, h4, h5, summary');
          if (h2) h2.parentNode.removeChild(h2);
          var isErr = /错误|失败|error|failed|429|500/i.test(c.textContent);
          return '<div class="con-item' + (isErr ? ' err' : '') + '" data-kind="' + k + '">' +
            '<div class="con-line"><span class="ts">' + escapeHtml(shortTime(c.textContent)) + '</span>' +
            '<span class="' + (k === 'agent' ? 'k-agent' : 'k-butler') + '">' + (k === 'agent' ? '主Agent' : '管家AI') + '</span>' +
            escapeHtml(title.slice(0, 160)) + '<span class="exp">▾</span></div>' +
            '<div class="con-detail">' + clone.innerHTML + '</div></div>';
        }).join('');
      } else {
        var raw = src.textContent.trim();
        if (!raw || PLACEHOLDER.test(raw)) { dst.innerHTML = emptyPane('暂无调试记录（进行一次对话后出现）'); return; }
        dst.innerHTML = raw.split('\n').filter(function (l) { return l.trim(); }).map(function (l) {
          var isErr = /错误|失败|error|failed/i.test(l);
          return '<div class="con-item' + (isErr ? ' err' : '') + '" data-kind="' + k + '">' +
            '<div class="con-line"><span class="ts">' + escapeHtml(shortTime(l)) + '</span>' +
            '<span class="' + (k === 'agent' ? 'k-agent' : 'k-butler') + '">' + (k === 'agent' ? '主Agent' : '管家AI') + '</span>' +
            escapeHtml(l.trim()) + '<span class="exp">▾</span></div>' +
            '<div class="con-detail"><pre>' + escapeHtml(l.trim()) + '</pre></div></div>';
        }).join('');
      }
    });
    // 点条目 → 弹出详情窗（完整输出 + 思维链）；点右侧 ▾ 才就地展开
    $$('.con-line', app).forEach(function (l) {
      on(l, 'click', function (ev) {
        var item = l.parentNode;
        if (ev && ev.target && ev.target.classList && ev.target.classList.contains('exp')) {
          item.classList.toggle('open');
          return;
        }
        openConDetail(item);
      });
    });
  }

  /* ---------------- 13.5 调试条目详情窗（完整输出 + 思维链） ---------------- */
  function openConDetail(item) {
    var m = byId('conModal');
    if (!m || !item) return;
    var line = $('.con-line', item);
    var kind = (item.getAttribute('data-kind') === 'butler') ? '管家AI' : '主Agent';
    var raw = line ? String(line.textContent || '').replace(/[▾▴]/g, '').replace(/\s+/g, ' ').trim() : '';
    var tm = raw.match(/\d{1,2}:\d{2}(:\d{2})?/);
    txt(byId('conModalKind'), kind);
    txt(byId('conModalTime'), tm ? tm[0] : '');
    var clean = raw.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '').replace(kind, '')
      .replace(/[▶◀▸▾▲▼]/g, ' ').replace(/\s*\d{1,2}:\d{2}(:\d{2})?\s*$/, '')
      .replace(/\s+/g, ' ').trim();
    txt(byId('conModalTitle'), clean.slice(0, 200) || (kind + ' 条目详情'));
    var detail = $('.con-detail', item);
    var body = byId('conModalBody');
    if (body) {
      body.innerHTML = detail ? detail.innerHTML : '';
      // 旧调试卡片的正文默认 display:none（旧前端折叠用）→ 在弹窗里必须展开
      $$('.debug-card-body', body).forEach(function (b) { b.style.display = 'block'; });
      // 清掉旧内联事件（避免在弹窗里点到旧卡片的折叠逻辑）
      $$('[onclick]', body).forEach(function (b) { b.removeAttribute('onclick'); });
      if (!String(body.textContent || '').trim()) body.innerHTML = '<pre>（这条记录没有更多内容）</pre>';
      body.scrollTop = 0;
    }
    m.classList.add('on');
  }
  function closeConDetail() {
    var m = byId('conModal');
    if (m) m.classList.remove('on');
  }
  on(byId('conModalClose'), 'click', closeConDetail);
  on(byId('conModal'), 'click', function (ev) { if (ev && ev.target === this) closeConDetail(); });
  on(byId('conModalCopy'), 'click', function () {
    var body = byId('conModalBody');
    var t = body ? String(body.innerText || body.textContent || '') : '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
      else {
        var ta = document.createElement('textarea');
        ta.value = t; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      toast('已复制条目内容');
    } catch (e) { toast('复制失败，请手动选择'); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var m = byId('conModal');
    if (m && m.classList.contains('on')) { closeConDetail(); ev.stopPropagation(); }
  }, true);
  function shortTime(s) {
    var m = String(s || '').match(/\d{1,2}:\d{2}(:\d{2})?/);
    return m ? m[0] : '';
  }
  $$('[data-con-filter]').forEach(function (b) {
    on(b, 'click', function () {
      $$('[data-con-filter]').forEach(function (x) { x.classList.toggle('on', x === b); });
      var onlyErr = b.dataset.conFilter === 'err';
      $$('.con-item').forEach(function (it) { it.classList.toggle('hide', onlyErr && !it.classList.contains('err')); });
    });
  });
  on(byId('conExpandAll'), 'click', function () {
    var anyClosed = !!$('.con-item:not(.open)');
    $$('.con-item').forEach(function (it) { it.classList.toggle('open', anyClosed); });
    this.textContent = anyClosed ? '收起全部' : '展开全部';
    this.classList.toggle('on', anyClosed);
  });
  $$('.con-tab').forEach(function (t) {
    on(t, 'click', function () {
      $$('.con-tab').forEach(function (x) { x.classList.toggle('on', x === t); });
      if (byId('logAgent')) byId('logAgent').style.display = t.dataset.con === 'agent' ? 'block' : 'none';
      if (byId('logButler')) byId('logButler').style.display = t.dataset.con === 'butler' ? 'block' : 'none';
    });
  });

  /* ---------------- 14b. 隐藏 / 显示记录（等同 /hide /unhide） ----------------
     语义与 /hide 完全一致：一问一答算一轮，N = story-block 的 data-round
     （app.js 在 user 消息上 +1、assistant 沿用），所以这里问的「轮次」就是 /hide N 的 N。 */
  function maxRoundNo() {
    var max = 0;
    allBlocks().forEach(function (b) { max = Math.max(max, Number(b.dataset.round) || 0); });
    return max;
  }
  function hiddenRounds() {
    var set = {};
    allBlocks().forEach(function (b) {
      if (b.classList.contains('is-hidden')) set[Number(b.dataset.round) || 0] = 1;
    });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }
  function hideRecords(hide) {
    var max = maxRoundNo();
    if (!max) { toast('这个存档还没有对话轮次'); return; }
    var hid = hiddenRounds();
    var hint = hide
      ? '要隐藏哪些轮次？（与「回顾」里的 #N 一致；等同 /hide，例：1-10、3,5,7）'
      : '要恢复哪些轮次？（等同 /unhide，例：1-10）';
    var def = hide
      ? '1-' + Math.max(1, max - 1)
      : (hid.length ? (hid.length === 1 ? String(hid[0]) : hid[0] + '-' + hid[hid.length - 1]) : '1-' + max);
    var ans = window.prompt(hint, def);
    if (ans == null) return;
    ans = String(ans).trim();
    if (!ans) return;
    var cmd = (hide ? '/hide ' : '/unhide ') + ans;
    var ok = false;
    try { ok = typeof handleSlashCommand === 'function' && handleSlashCommand(cmd); } catch (e) { toast('执行失败：' + e.message); return; }
    if (!ok) { toast('无法执行 ' + cmd); return; }
    /* handleHideCommand 是 async：等它落库 + 改完 DOM，再刷新外壳（回顾表 / 演出 / 楼层显示） */
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      syncFromDom(true);
      renderHistory();
      render();
      if (tries >= 4) clearInterval(t);
    }, 600);
    toast('已执行 ' + cmd);
  }
  on(byId('btnHideRec'), 'click', function () { hideRecords(true); });
  on(byId('btnShowRec'), 'click', function () { hideRecords(false); });

  /* ---------------- 14. 大图 viewer ---------------- */
  function openViewer(src2, cap) {
    if (!src2) return;
    var v = byId('viewer');
    var img = byId('viewerImg');
    if (img) img.setAttribute('src', src2);
    txt(byId('viewerCap'), cap || '');
    if (v) v.classList.add('on');
  }
  on(byId('viewer'), 'click', function () { byId('viewer').classList.remove('on'); });
  /* 隐藏 UI 时的小 ✕：先在 viewer 里关大图，否则恢复界面（隐藏 UI 的唯一出口） */
  function stageExit() {
    var v = byId('viewer');
    if (v && v.classList.contains('on')) { v.classList.remove('on'); return; }
    if (app.classList.contains('ui-gone')) { setHideUI(false); return; }
  }
  on(byId('stageX'), 'click', function (e) { e.stopPropagation(); stageExit(); });
  on(byId('viewerX'), 'click', function (e) { e.stopPropagation(); stageExit(); });
  /* 画面中央上方的 CG 切换器：自由翻看，不与文本对应（Shift + ←/→ 同效） */
  on(byId('cgPrev'), 'click', function (e) { e.stopPropagation(); stepCg(-1); });
  on(byId('cgNext'), 'click', function (e) { e.stopPropagation(); stepCg(1); });
  /* 数据中心里任何带 data-big 的图（CG / 立绘 / 头像）点开大图 */
  on($('.dock-body'), 'click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-big]') : null;
    if (el && el.dataset.big) openViewer(el.dataset.big, el.dataset.name || '');
  });
  /* 点击左侧大头像看大图（右侧槽已去掉，只剩这一个） */
  on(byId('avL'), 'click', function () {
    var img = byId('avLImg');
    var u = img && img.getAttribute('src');
    if (!u) return;
    openViewer(u, cast.cur ? cast.cur.name : '');
  });

  /* ---------------- 15.1 访问密码（远程访问保护） ----------------
     规则：本机访问免密；非本机访问整个服务都要密码。密码只有一个，默认 12345。
     改密码 / 重置**只能在本机**做（服务端同样会校验来源 IP），所以这里也据此提示。 */
  var pwModal = byId('pwModal');
  var pwState = { isLocal: false, hasPassword: false, usingDefaultPassword: false, loaded: false };

  function pwSetNote() {
    var note = byId('pwNote');
    if (!note) return;
    if (!pwState.isLocal) {
      note.className = 'pw-note warn';
      note.innerHTML = '当前不是本机访问，<b>无法修改或重置密码</b>。<br>请到运行 AI-GAL 的那台电脑上打开本窗口操作。';
      return;
    }
    note.className = 'pw-note';
    if (pwState.usingDefaultPassword) {
      note.innerHTML = '当前仍是<b>默认密码 12345</b>，建议马上改成自己的密码。<br>本机访问免密；局域网 / 外网访问需要这个密码。';
    } else {
      note.innerHTML = '已设置自定义密码。<br>本机访问免密；局域网 / 外网访问需要这个密码。';
    }
  }

  function pwSetStateLabel() {
    var el = byId('menuAccessPwState');
    if (!el) return;
    if (!pwState.loaded) { el.textContent = '本机免密 · 远程需密码'; return; }
    if (!pwState.isLocal) { el.textContent = '远程访问 · 需在主机修改'; return; }
    el.textContent = pwState.usingDefaultPassword ? '⚠ 仍是默认密码 12345' : '已设置自定义密码';
  }

  function loadAuthStatus() {
    return fetch('/api/auth/status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        pwState.isLocal = !!s.isLocal;
        pwState.hasPassword = !!s.hasPassword;
        pwState.usingDefaultPassword = !!s.usingDefaultPassword;
        pwState.loaded = true;
        pwSetStateLabel();
        pwSetNote();
        return s;
      })
      .catch(function () { return null; });
  }

  function openPwModal() {
    if (pwModal) pwModal.classList.add('on');
    var err = byId('pwErr'); if (err) err.textContent = '';
    var a = byId('pwNew'), b = byId('pwNew2');
    if (a) a.value = ''; if (b) b.value = '';
    loadAuthStatus().then(function () {
      /* 非本机不给改：把输入区禁掉，免得白填 */
      var disabled = !pwState.isLocal;
      [byId('pwNew'), byId('pwNew2'), byId('pwSave'), byId('pwResetDefault')].forEach(function (el) {
        if (el) el.disabled = disabled;
      });
    });
  }
  function closePwModal() { if (pwModal) pwModal.classList.remove('on'); }

  on(byId('menuAccessPw'), 'click', function () { closeMenu(); openPwModal(); });
  on(byId('pwModalClose'), 'click', closePwModal);
  on(pwModal, 'click', function (e) { if (e.target === pwModal) closePwModal(); });

  on(byId('pwSave'), 'click', function () {
    var err = byId('pwErr');
    var a = byId('pwNew'), b = byId('pwNew2');
    var v1 = a ? a.value : '', v2 = b ? b.value : '';
    if (err) err.textContent = '';
    if (!v1 || v1.length < 4) { if (err) err.textContent = '密码至少 4 位'; return; }
    if (v1 !== v2) { if (err) err.textContent = '两次输入的密码不一致'; return; }
    var btn = this; btn.disabled = true;
    fetch('/api/auth/password', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: v1 })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { if (err) err.textContent = res.d.error || '保存失败'; return; }
        toast('访问密码已更新');
        if (a) a.value = ''; if (b) b.value = '';
        pwState.usingDefaultPassword = !!res.d.usingDefaultPassword;
        pwSetNote(); pwSetStateLabel();
      })
      .catch(function () { if (err) err.textContent = '无法连接服务器'; })
      .then(function () { btn.disabled = false; });
  });

  on(byId('pwResetDefault'), 'click', function () {
    var err = byId('pwErr');
    if (err) err.textContent = '';
    if (!confirm('重置为默认密码 12345？\n重置后，任何知道这个默认密码的人都能从局域网访问。')) return;
    var btn = this; btn.disabled = true;
    fetch('/api/auth/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { if (err) err.textContent = res.d.error || '重置失败'; return; }
        toast('已重置为默认密码 12345');
        pwState.usingDefaultPassword = true;
        pwSetNote(); pwSetStateLabel();
      })
      .catch(function () { if (err) err.textContent = '无法连接服务器'; })
      .then(function () { btn.disabled = false; });
  });


  /* ---------------- 15. 菜单 / 顶栏按钮 ---------------- */
  var menu = byId('menu');
  function openMenu() { menu && menu.classList.add('on'); }
  function closeMenu() { menu && menu.classList.remove('on'); }
  on(byId('btnMenu'), 'click', function (e) { e.stopPropagation(); openMenu(); });
  on(byId('menuClose'), 'click', closeMenu);
  on(byId('menuResume'), 'click', closeMenu);
  on(menu, 'click', function (e) { if (e.target === menu) closeMenu(); });
  $$('#menu [data-pane]').forEach(function (b) {
    on(b, 'click', function () { closeMenu(); openDock(b.dataset.pane); toast('数据中心 · ' + (b.querySelector('b') ? b.querySelector('b').textContent : '')); });
  });
  $$('#menu [data-sidebar]').forEach(function (b) {
    on(b, 'click', function () { closeMenu(); var x = byId('btnExpandSidebar'); if (x && !(byId('leftSidebar') || {}).classList.contains('expanded')) x.click(); });
  });
  $$('#menu [data-open]').forEach(function (b) {
    on(b, 'click', function () { closeMenu(); openSheet(b.dataset.open); if (b.dataset.open === 'sheetHist') renderHistory(); if (b.dataset.open === 'sheetConsole') renderConsole(); });
  });
  $$('#menu [data-toast]').forEach(function (b) {
    on(b, 'click', function () {
      var label = b.querySelector('b') ? b.querySelector('b').textContent : '';
      /* 能落到真实按钮的就点真实按钮 */
      if (/重启/.test(label)) { closeMenu(); var r = byId('btnRestart'); r ? r.click() : toast('重启不可用'); return; }
      if (/导出对话/.test(label)) { closeMenu(); var e2 = byId('btnExport'); e2 ? e2.click() : toast('导出不可用'); return; }
      if (/供应商/.test(label)) { closeMenu(); var s = byId('btnSettings'); s ? s.click() : toast('设置不可用'); return; }
      if (/用户|人格/.test(label)) { closeMenu(); var g = byId('btnGameSettings'); g ? g.click() : toast('用户设置不可用'); return; }
      toast(b.dataset.toast || label);
    });
  });
  on(byId('menuTtsSys'), 'click', function () { closeMenu(); var t = byId('btnTTS'); t ? t.click() : toast('TTS 设置不可用'); });

  on(byId('btnTheme'), 'click', function () { setTheme(themeMode === 'light' ? 'dark' : 'light'); });
  on(byId('btnHideUI'), 'click', function () { setHideUI(!app.classList.contains('ui-gone')); });
  on(byId('btnAuto'), 'click', function () { setAuto(!S.auto); });
  on(byId('btnSkip'), 'click', function () { S.cur = S.segs.length - 1; render(); toast('已跳到本轮最后一段'); });
  /* 逐段演出：上一段 / 下一段（设计稿里这两个按钮的绑定属于演示脚本，生产必须在外壳里重新绑） */
  on(byId('btnNext'), 'click', function (e) { e.stopPropagation(); go(1); });
  on(byId('btnPrev'), 'click', function (e) { e.stopPropagation(); go(-1); });
  on(byId('btnConsole'), 'click', function () { renderConsole(); openSheet('sheetConsole'); });
  on(byId('btnHist'), 'click', function () { renderHistory(); openSheet('sheetHist'); });
  on(byId('toolHist'), 'click', function () { renderHistory(); openSheet('sheetHist'); });
  on(byId('saveSwitch'), 'click', function (e) {
    e.stopPropagation();
    var x = byId('btnExpandSidebar');
    if (x) x.click();
  });
  $$('[data-close]').forEach(function (b) { on(b, 'click', closeSheets); });
  on(byId('scrim'), 'click', closeSheets);

  /* ---------------- 16. 键盘 ---------------- */
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Escape') {
      if (byId('viewer') && byId('viewer').classList.contains('on')) { byId('viewer').classList.remove('on'); return; }
      if (menu && menu.classList.contains('on')) { closeMenu(); return; }
      if (sheetOpen()) { closeSheets(); return; }
      if (dock && dock.classList.contains('on')) { closeDock(); return; }
      var sb = byId('leftSidebar');
      if (sb && sb.classList.contains('expanded')) { var c = byId('btnCollapseSidebar'); c && c.click(); return; }
      if (app.classList.contains('ui-gone')) setHideUI(false);
      if (typing) t.blur();
      return;
    }
    if (typing) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); fs += 0.05; applyFs(); }
      else if (e.key === '-') { e.preventDefault(); fs -= 0.05; applyFs(); }
      else if (e.key === '0') { e.preventDefault(); fs = 1; applyFs(); }
      return;
    }
    switch (e.key) {
      /* Shift + ←/→ = 手动翻背景 CG（与「上一段 / 下一段」分开，互不抢键） */
      case 'ArrowRight': case ' ': case 'PageDown':
        e.preventDefault();
        if (e.shiftKey) { stepCg(1); break; }
        if (app.classList.contains('ui-gone')) setHideUI(false); go(1); break;
      case 'ArrowLeft': case 'PageUp':
        e.preventDefault();
        if (e.shiftKey) { stepCg(-1); break; }
        go(-1); break;
      case 't': case 'T': setTheme(themeMode === 'light' ? 'dark' : 'light'); break;
      case 'h': case 'H': setHideUI(!app.classList.contains('ui-gone')); break;
      case 'l': case 'L': renderHistory(); openSheet('sheetHist'); break;
      case 'm': case 'M': menu && menu.classList.contains('on') ? closeMenu() : openMenu(); break;
      case 'd': case 'D': toggleDock(); break;
      case 'b': case 'B': { var bg = byId('btnToggleAudio'); if (bg) { bg.click(); setTimeout(syncViz, 60); } break; }
      case 'v': case 'V': { var tv = byId('btnTtsToggle'); if (tv) tv.click(); break; }
      case 's': case 'S': { var ex = byId('btnExpandSidebar'); if (ex) ex.click(); break; }
      case 'i': case 'I': { var mi = byId('messageInput'); if (mi) mi.focus(); break; }
      case '1': case '2': case '3': {
        var idx = Number(e.key) - 1;
        if (!app.classList.contains('choosing')) break;
        var btn = $$('#choices .ch')[idx];
        if (btn) btn.click();
        break;
      }
    }
  });

  /* ---------------- 16.5 自检（?vntest=1）：点得动、点得对 ----------------
     无头环境没法手点，就把关键交互脚本化跑一遍，结果写进 #vnDebug.tests。
     只点本地交互（翻页 / 侧栏 / 载入存档），不会发消息、不调 LLM。 */
  function runSelfTest() {
    var res = [];
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function rec(name, pass, detail) {
      res.push({ name: name, pass: !!pass, detail: detail == null ? '' : String(detail) });
    }
    function convId() { return (window.AppState.currentConversation && window.AppState.currentConversation.id) || null; }
    var chain = Promise.resolve();

    /* T1/T2 上一段 / 下一段 */
    chain = chain.then(function () {
      var n = S.segs.length, c0 = S.cur;
      if (n < 2) { rec('下一段按钮生效', false, '本轮只有 ' + n + ' 段，无法验证'); return wait(30); }
      if (c0 === n - 1) { byId('btnPrev').click(); }
      var a = S.cur;
      byId('btnNext').click();
      rec('下一段按钮生效', S.cur === a + 1, 'cur ' + a + ' → ' + S.cur + '（共 ' + n + ' 段）');
      var b = S.cur;
      byId('btnPrev').click();
      rec('上一段按钮生效', S.cur === b - 1, 'cur ' + b + ' → ' + S.cur);
      return wait(60);
    });

    /* T3 点角色卡：只展开存档列表，不进存档 */
    chain = chain.then(function () {
      var sb = byId('leftSidebar');
      if (sb && !sb.classList.contains('expanded')) byId('btnExpandSidebar').click();
      return wait(200);
    }).then(function () {
      var before = convId();
      var cards = $$('#characterList .character-item');
      if (!cards.length) { rec('点角色卡只展开存档列表', false, '侧栏没有角色卡'); return wait(30); }
      var me = window.AppState.currentCharacter && window.AppState.currentCharacter.id;
      /* 优先挑「有存档行、且不是当前角色」的卡，才能顺带验证载入流程 */
      var withSaves = cards.filter(function (c) {
        return c.dataset.id !== me && !!$('#characterList [data-char-convs="' + c.dataset.id + '"] .char-conv-item:not(.new-conv)');
      });
      var card = withSaves[0] || cards.filter(function (c) { return c.dataset.id !== me; })[0] || cards[0];
      card.click();
      return wait(700).then(function () {
        var list = $('#characterList [data-char-convs="' + card.dataset.id + '"]');
        var shown = !!(list && list.classList.contains('show'));
        rec('点角色卡只展开存档列表（不自动进存档）', shown && convId() === before,
          '展开=' + shown + ' 存档 ' + before + ' → ' + convId());
        var rows = list ? $$('.char-conv-item:not(.new-conv)', list) : [];
        var load = rows.length ? $('.conv-load', rows[0]) : null;
        rec('存档行有显式「载入」按钮', !!load, load ? ('按钮文字=' + load.textContent) : '没有存档行');
        if (!load || !rows.length) return wait(30);
        var want = rows[0].dataset.convId || '';
        if (!want || want === convId()) { rec('点「载入」才进入存档', !!load, '目标就是当前存档，跳过实载'); return wait(30); }
        load.click();
        return wait(2200).then(function () {
          rec('点「载入」才进入存档', convId() === want, want + ' → ' + convId());
          return wait(400).then(function () {
            var row = $('#characterList .char-conv-item[data-conv-id="' + want + '"]');
            var pill = row ? $('.conv-load', row) : null;
            rec('当前存档行标成「当前」', !!(row && row.classList.contains('active') && pill && pill.textContent === '当前'),
              'active=' + !!(row && row.classList.contains('active')) + ' pill=' + (pill ? pill.textContent : '无'));
          });
        });
      });
    });

    /* T4 点竖条小头像：滑出面板（而不是收起），且不自动进存档 */
    chain = chain.then(function () {
      var sb = byId('leftSidebar');
      if (sb && sb.classList.contains('expanded')) byId('btnCollapseSidebar').click();
      return wait(600);
    }).then(function () {
      var mini = $$('#stripAvatars .strip-avatar')[0];
      if (!mini) { rec('点小头像滑出游戏列表', false, '竖条里没有头像'); return wait(30); }
      var before = convId();
      mini.click();
      return wait(1000).then(function () {
        var sb = byId('leftSidebar');
        var open = !!(sb && sb.classList.contains('expanded'));
        var r = byId('sidebarPanel') ? byId('sidebarPanel').getBoundingClientRect() : { x: -999, width: 0 };
        /* 无头 + --virtual-time-budget 会把 CSS 过渡冻在起始帧，所以几何只在关动画时判定 */
        var noAnim = /[?&](geom|noanim)=1/.test(location.search);
        rec('点小头像滑出游戏列表', open && (!noAnim || (r.width > 100 && r.x > -40)),
          'expanded=' + open + ' panel.x=' + Math.round(r.x) + ' w=' + Math.round(r.width) +
          (noAnim ? '' : '（未关动画，几何不作判定；加 ?geom=1 复核）'));
        var card2 = $('#characterList .character-item[data-id="' + mini.dataset.id + '"]');
        var list2 = card2 ? $('#characterList [data-char-convs="' + mini.dataset.id + '"]') : null;
        rec('点小头像展开该角色的存档列表', !!(list2 && list2.classList.contains('show')),
          'show=' + !!(list2 && list2.classList.contains('show')) + ' 存档行=' + (list2 ? $$('.char-conv-item:not(.new-conv)', list2).length : 0));
        rec('点小头像不自动进存档', convId() === before, before + ' → ' + convId());
      });
    });

    return chain.then(function () { window.__vnTests = res; dumpState(); })
      .catch(function (e) {
        res.push({ name: '自检异常', pass: false, detail: (e && e.message) || String(e) });
        window.__vnTests = res; dumpState();
      });
  }

  /* ---------------- 17. 启动 ---------------- */
  function clearDemoData() {
    /* 设计稿的静态演示内容（data-demo）：生产里必须消失，否则会和真数据混在一起。
       CSS 已经 display:none，这里再从 DOM 里摘掉，避免误点。 */
    $$('[data-demo]', app).forEach(function (el) { el.parentNode && el.parentNode.removeChild(el); });
    /* 容器空着就补一次真实渲染（app.js 是异步 init，可能早于外壳启动跑过了） */
    var cl = byId('characterList');
    if (cl && !cl.children.length && typeof window.renderCharacterList === 'function') {
      try { window.renderCharacterList(); } catch (e) { }
    }
    var sa = byId('stripAvatars');
    if (sa && !sa.children.length && typeof window.renderStripAvatars === 'function') {
      try { window.renderStripAvatars(); } catch (e) { }
    }
    ['status', 'roster', 'gallery', 'memory', 'world'].forEach(loadPane);
  }

  /* 隐藏的状态自述（调试用：F12 或 --dump-dom 可读；也是「调试条目」的兜底）
     ?geom=1 时附上关键元素的真实盒子，用于无头环境下的布局回归 */
  function box(sel) {
    var el = typeof sel === 'string' ? $(sel, app) : sel;
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: getComputedStyle(el).visibility, disp: getComputedStyle(el).display };
  }
  function dumpState() {
    var el = byId('vnDebug');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'vnDebug';
      el.hidden = true;
      el.style.display = 'none';
      app.appendChild(el);
    }
    var block = currentBlock();
    var seg = S.segs[S.cur] || null;
    var wantGeom = /geom=1/.test(location.search) || app.dataset.geom === '1';
    var state = {
      conv: (App.currentConversation && App.currentConversation.id) || null,
      save: saveId() || null,
      character: charName(),
      persona: personaName(),
      blockId: block ? (block.dataset.id || '') : null,
      blocks: allBlocks().length,
      blockRole: block ? block.className : null,
      segCount: S.segs.length,
      cur: S.cur,
      seg: seg ? { kind: seg.kind, name: seg.name || '', right: !!seg.right, text: seg.text.slice(0, 120) } : null,
      choices: S.optionsOpen ? extractChoices(block).length : 0,
      stage: (byId('cgImg') || {}).getAttribute ? (byId('cgImg').getAttribute('src') || '') : '',
      /* 背景判定的中间量：方便核对「卡面 / CG / 剧本bg」到底谁赢了 */
      bgInfo: (function () {
        var cg = newestCg(), gv = byId('galleryViewport');
        var g = gv ? $$('img.cg-image', gv).filter(function (x) { return x.getAttribute('src'); }).pop() : null;
        var st = readBgStamp();
        return {
          stored: storedBg() || null,
          stamp: st ? { conv: (st.conv || '').slice(0, 8), count: st.count } : null,
          newestMsgCg: cg ? { url: cg.url.split('/').pop(), count: cg.count } : null,
          galleryCg: g ? g.getAttribute('src').split('/').pop() : null,
          cardFace: cardFace() ? cardFace().split('/').pop() : null
        };
      })(),
      avL: (byId('avLImg') || {}).getAttribute ? (byId('avLImg').getAttribute('src') || '') : '',
      cast: { cur: (cast.cur && cast.cur.name) || null },
      /* 对话框几何：正文字区能放几行（6 行是硬要求，见 README） */
      dialog: (function () {
        try {
          var d = byId('dialog'), b = $('.body', d), t = byId('dlgText'), c = $('.cmd', d ? d.parentNode : app);
          if (!d) return null;
          var lh = t ? parseFloat(getComputedStyle(t).lineHeight) || 0 : 0;
          var bh = b ? b.clientHeight : 0;
          return {
            dialogH: d.clientHeight, bodyH: bh, lineH: Math.round(lh * 10) / 10,
            lines: lh ? Math.round(bh / lh * 10) / 10 : 0,
            cmdH: c ? c.clientHeight : 0,
            gap: c && b ? Math.round(c.getBoundingClientRect().top - d.getBoundingClientRect().bottom) : null,
            actionsTop: (function () {
              var a = $('.dlg-actions', d);
              if (!a) return null;
              var r = a.getBoundingClientRect(), dr = d.getBoundingClientRect();
              var cs = getComputedStyle(a), cb = getComputedStyle(a.querySelector('.tool') || a);
              return {
                top: Math.round(r.top - dr.top),      /* 负数 = 骑在顶边之上 */
                x: Math.round(r.left), y: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height),
                vis: cs.visibility + '/' + cs.display + '/z' + cs.zIndex,
                btnBg: cb.backgroundColor, btnColor: cb.color,
                panelBottom: Math.round(dr.bottom)
              };
            })()
          };
        } catch (e) { return 'err'; }
      })(),
      /* 背景 CG 的时间线诊断（「新 CG 没换上背景」时看这里）：
         App.cgGallery 的顺序 / 楼层里有没有 cg-image / 旧画廊里的顺序 / 当前舞台用的是哪张 */
      cgTimeline: (function () {
        try {
          var gal = (App.cgGallery || []).map(function (g) {
            return String(g.file || g.filename || g.url || g.image || '').split('/').pop() +
              '@' + String(g.timestamp || '').slice(0, 19);
          });
          var blocks = $$('#messagesArea .story-block');
          var inBlocks = [];
          blocks.forEach(function (b, i) {
            $$('img.cg-image, .story-content img', b).forEach(function (im) {
              var s = im.getAttribute('src');
              if (s) inBlocks.push((i + 1) + ':' + s.split('/').pop());
            });
          });
          var gv = byId('galleryViewport');
          var legacy = gv ? $$('img.cg-image', gv).map(function (x) { return String(x.getAttribute('src') || '').split('/').pop(); }) : [];
          var n = newestCg();
          return {
            galleryCount: gal.length,
            galleryFirst: gal[0] || '',
            galleryLast: gal[gal.length - 1] || '',
            legacyCount: legacy.length,
            legacyFirst: legacy[0] || '',
            legacyLast: legacy[legacy.length - 1] || '',
            blocks: blocks.length,
            inBlocks: inBlocks.slice(-6),
            newest: n ? String(n.url).split('/').pop() + ' @block' + n.count : null,
            stage: (byId('cgImg') || {}).getAttribute ? String(byId('cgImg').getAttribute('src') || '').split('/').pop() : '',
            storedBg: storedBg(),
            bgStamp: readBgStamp(),
            cardFace: String(cardFace() || '').split('/').pop()
          };
        } catch (e) { return 'err: ' + e.message; }
      })(),
      /* 背景图取景方式（适应模式验收）：object-fit=contain 时算出实际画面尺寸与四周露出的背景色带宽 */
      cgFit: (function () {
        try {
          var img = $('.art-frame .cg') || $('.stage img') || $('.cg-image');
          if (!img) return null;
          var cs = getComputedStyle(img);
          var r = img.getBoundingClientRect();
          var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
          var painted = null, bars = null, cropPct = null;
          if (nw && nh && r.width && r.height) {
            if (cs.objectFit === 'contain') {
              var s = Math.min(r.width / nw, r.height / nh);
              painted = { w: Math.round(nw * s), h: Math.round(nh * s) };
            } else if (cs.objectFit === 'cover') {
              var s2 = Math.max(r.width / nw, r.height / nh);
              painted = { w: Math.round(nw * s2), h: Math.round(nh * s2) };
              cropPct = Math.round((1 - (r.width * r.height) / (painted.w * painted.h)) * 1000) / 10;
            }
            if (painted) bars = { lr: Math.round(r.width - Math.min(painted.w, r.width)), tb: Math.round(r.height - Math.min(painted.h, r.height)) };
          }
          return {
            fit: cs.objectFit, natural: nw + 'x' + nh,
            frame: { w: Math.round(r.width), h: Math.round(r.height) },
            painted: painted, bars: bars, croppedPct: cropPct,
            frameBg: getComputedStyle(img.parentElement || img).backgroundColor
          };
        } catch (e) { return 'err'; }
      })(),
      /* 系统弹窗重绘验收：把当前打开弹窗里关键元素的计算样式打出来（浅/深主题各看一次） */
      modalProbe: (function () {
        try {
          var m = document.querySelector('.modal:not(.hidden)') || document.querySelector('.slide-panel:not(.hidden)');
          if (!m) return null;
          function cs(el) {
            if (!el) return null;
            var s = getComputedStyle(el);
            var r = el.getBoundingClientRect();
            return {
              bg: s.backgroundColor,
              bgImg: (s.backgroundImage || 'none').slice(0, 54),
              color: s.color,
              radius: s.borderRadius,
              border: s.borderTopColor + ' ' + s.borderTopWidth,
              box: Math.round(r.width) + 'x' + Math.round(r.height),
              font: s.fontFamily.split(',')[0].replace(/"/g, '') + ' ' + s.fontSize
            };
          }
          /* 弹窗里所有输入控件（逐个报半径/底色）——「某个字段还是旧样式」时一眼定位 */
          var fields = [];
          var seen = {};
          Array.prototype.slice.call(m.querySelectorAll('input, select, textarea, .setting-input, .setting-select')).forEach(function (el) {
            if (fields.length >= 14) return;
            var s = getComputedStyle(el);
            if (s.display === 'none' || el.type === 'hidden' || el.type === 'file') return;
            var r = el.getBoundingClientRect();
            if (!r.width && !r.height) return;
            var key = (el.tagName + '/' + (el.type || '') + '/' + s.borderRadius + '/' + s.backgroundColor);
            if (seen[key]) return;
            seen[key] = 1;
            fields.push((el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + (el.id ? '#' + el.id : '')).slice(0, 34) +
              ' r=' + s.borderRadius + ' bg=' + s.backgroundColor + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          });
          return {
            id: m.id || String(m.className),
            fields: fields,
            panel: cs(m.querySelector('.modal-content') || m),
            header: cs(m.querySelector('.modal-header')),
            title: cs(m.querySelector('.modal-header h3, .modal-header h2')),
            tabs: cs(m.querySelector('.settings-tabs')),
            tabOn: cs(m.querySelector('.settings-tab.active, .settings-tab.on')),
            select: cs(m.querySelector('select')),
            input: cs(m.querySelector('input[type="text"], input:not([type])')),
            textarea: cs(m.querySelector('textarea')),
            btn: cs(m.querySelector('.btn')),
            btnPrimary: cs(m.querySelector('.btn-primary')),
            providerItem: cs(m.querySelector('.provider-item'))
          };
        } catch (e) { return 'err'; }
      })(),

      /* 控制台条目详情弹窗（?con=N 或点条目）——验收「完整输出 + 思维链」是否真的弹出 */
      conModal: (function () {
        try {
          var m = byId('conModal');
          var body = byId('conModalBody');
          if (!m) return 'missing';
          var txtBody = body ? String(body.innerText || body.textContent || '') : '';
          var pre = body ? body.querySelectorAll('pre') : [];
          return {
            open: m.classList.contains('on'),
            kind: (byId('conModalKind') || {}).textContent || '',
            title: String(((byId('conModalTitle') || {}).textContent) || '').slice(0, 60),
            time: (byId('conModalTime') || {}).textContent || '',
            bodyChars: txtBody.length,
            pres: pre.length,
            hasCoT: /思维链|Chain-of-Thought/i.test(txtBody),
            sections: body ? body.querySelectorAll('.debug-section-title, .cd-row').length : 0,
            panelBg: m.querySelector('.cm-panel') ? getComputedStyle(m.querySelector('.cm-panel')).backgroundColor : '',
            panelRadius: m.querySelector('.cm-panel') ? getComputedStyle(m.querySelector('.cm-panel')).borderRadius : '',
            preBg: pre.length ? getComputedStyle(pre[0]).backgroundColor : '',
            items: $$('.con-item', app).length
          };
        } catch (e) { return 'err: ' + e.message; }
      })(),
      /* 整屏暗角排查：老样式表把暗角挂在 body::before/::after 上，这里直接把计算结果打出来 */
      vignette: (function () {
        try {
          var a = getComputedStyle(document.body, '::after');
          var b = getComputedStyle(document.body, '::before');
          return { after: a.boxShadow || 'none', beforeBg: (b.backgroundImage || 'none').slice(0, 80), display: a.display };
        } catch (e) { return 'err'; }
      })(),
      tts: ttsEnabled(),
      theme: themeMode,
      fs: fs,
      sidebar: !!(byId('leftSidebar') || {}).classList && byId('leftSidebar').classList.contains('expanded'),
      hist: (byId('histBody') || {}).children ? byId('histBody').children.length : 0,
      conAgent: (byId('logAgent') || {}).children ? byId('logAgent').children.length : 0,
      charItems: $$('#characterList .character-item').length,
      errors: window.__vnErrors || [],
      tests: window.__vnTests || null
    };
    if (wantGeom) {
      state.rects = {
        viewport: { w: innerWidth, h: innerHeight },
        sidebar: box('#leftSidebar'),
        panel: box('#sidebarPanel'),
        charList: box('#characterList'),
        charItem0: box($$('#characterList .character-item')[0]),
        charName0: box($$('#characterList .character-name')[0]),
        strip: box('#stripAvatars'),
        dialog: box('#dialog'),
        dlgText: box('#dlgText'),
        dlgNarr: box('#dlgNarr'),
        choices: box('#choices'),
        choice0: box($$('#choices .ch')[0]),
        avL: box('#avL'),
        hud: box('.hud'),
        dock: box('#dock'),
        sheetHist: box('#sheetHist'),
        cmd: box('.cmd'),
        input: box('#messageInput'),
        stage: box('#cgImg')
      };
    }
    el.textContent = JSON.stringify(state, null, 1);
  }

  function observeMessages() {
    var area = messagesArea();
    if (!area) return;
    var pending = null;
    new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(function () { syncFromDom(false); }, 120);
    }).observe(area, { childList: true, subtree: true, characterData: true });
  }

  /* 开机【不】自动接续存档：新启动服务器 = 「未加载角卡」的默认状态。
     以前这里会自动接续最近一条存档，于是上一局的 CG 会跟着一起回来
     —— 这正是「退出游戏后重开还是上一次那张 CG」的来源。 */
  var autoResumed = false;
  function autoResume() {
    if (autoResumed) return;
    if (location.search.indexOf('conv=') >= 0) { autoResumed = true; return; }   /* app.js 自己会载入 */
    if (document.querySelector('#messagesArea .story-block')) { autoResumed = true; return; }
    autoResumed = true;
    /* 停在「选角色卡开始」的引导态：展开左侧游戏列表，不碰任何存档 */
    var x = byId('btnExpandSidebar');
    var sb = byId('leftSidebar');
    if (x && sb && !sb.classList.contains('expanded')) x.click();
  }

  /** URL 直链状态（调试 / 分享某个画面都靠它）：
   *  ?conv=ID      由 app.js 处理（直接进入某存档）
   *  ?seg=last|N   演出到第 N 段（1 基）或本轮最后一段
   *  ?theme=light  明/暗；?fs=1.15 字号；?ui=hidden 隐藏界面
   *  ?side=1 展开左侧游戏列表；?dock=status|roster|gallery|memory|world 数据中心
   *  ?hist=1 回顾面板；?console=1 控制台面板；?menu=1 菜单；?tts=1 语音开
   */
  function applyUrlState() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (q.get('theme') === 'light' || q.get('theme') === 'dark') setTheme(q.get('theme'), true);
    var f = parseFloat(q.get('fs'));
    if (f >= 0.85 && f <= 1.5) { fs = f; applyFs(true); }
    if (q.get('tts') === '1') { var cb = byId('ttsMasterEnabled'); if (cb) cb.checked = true; syncTts(); }
    if (q.get('seg')) {
      /* 目标段位存成「粘性」标记：app.js 会二次重渲染消息，一次性 set 会被重置回第 0 段 */
      S.wantSeg = q.get('seg') === 'last' ? Infinity : Math.max(0, (parseInt(q.get('seg'), 10) || 1) - 1);
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (!S.segs.length) { if (tries > 40) clearInterval(t); return; }
        clearInterval(t);
        if (S.wantSeg != null) {
          S.cur = S.wantSeg === Infinity ? S.segs.length - 1 : Math.max(0, Math.min(S.segs.length - 1, S.wantSeg));
        }
        S.optionsOpen = true;
        syncFromDom(true);
      }, 250);
    }
    setTimeout(function () {
      if (q.get('side') === '1') { var x = byId('btnExpandSidebar'); x && x.click(); }
      if (q.get('dock')) openDock(q.get('dock'));
      if (q.get('hist') === '1') { renderHistory(); openSheet('sheetHist'); }
      if (q.get('console') === '1') { renderConsole(); openSheet('sheetConsole'); }
      /* ?con=N —— 打开控制台第 N 条（1 起）的详情弹窗：截图/验收「完整输出 + 思维链」用 */
      if (q.get('con')) {
        setTimeout(function () {
          renderConsole();
          openSheet('sheetConsole');
          var n = Math.max(1, parseInt(q.get('con'), 10) || 1);
          var items = $$('.con-item', byId('logAgent') || app).concat($$('.con-item', byId('logButler') || app));
          var it = items[n - 1];
          if (it) openConDetail(it); else toast('控制台没有第 ' + n + ' 条记录');
        }, 1200);
      }
      if (q.get('menu') === '1') openMenu();
      /* ?cg=N —— 把背景切到时间线第 N 张（1 起）：截图/验收「背景 CG 智能分配 + 手动翻页」用 */
      if (q.get('cg')) {
        setTimeout(function () {
          var n = Math.max(1, parseInt(q.get('cg'), 10) || 1);
          var t = cgTimeline();
          if (!t.length) { toast('这个存档还没有 CG'); return; }
          S.cgManual = Math.min(t.length, n) - 1;
          syncStage();
          toast('背景 CG ' + (S.cgManual + 1) + ' / ' + t.length);
        }, 2600);
      }
    /* ?tip=1（或 ?tip=btnMenu）强制显示某条悬停提示：截图验收「浮动框压在主 CG 之上」 */
    if (q.get('tip')) {
      var tipId = q.get('tip') === '1' ? 'btnHist' : q.get('tip');
      setTimeout(function () { var t = byId(tipId); if (t) t.classList.add('force-tip'); }, 800);
    }
    /* ?sys=user|settings|image|theme —— 直接开旧前端的系统弹窗（重绘验收用）
       ?spane=ai|image|lore|look|identity|prompts —— 连带切到某一类（验收分类导航用） */
    if (q.get('sys')) {
      var sysBtn = { user: 'btnGameSettings', settings: 'btnSettings', image: 'btnImageGenSettings', theme: 'btnThemeSettings' }[q.get('sys')];
      if (sysBtn) setTimeout(function () {
        var b = byId(sysBtn);
        b && b.click();
        if (q.get('spane')) setTimeout(function () {
          showSettingsPane(q.get('spane'), q.get('sys') === 'user' ? 'gameSettingsModal' : 'settingsModal');
        }, 260);
      }, 900);
    }
      if (q.get('ui') === 'hidden') setHideUI(true);
      if (q.get('vntest') === '1') setTimeout(runSelfTest, 1500);
      dumpState();
    }, 2200);
  }

  function boot() {
    window.__vnErrors = window.__vnErrors || [];
    /* ?noanim=1（或 geom=1 量尺寸时自动开）：关掉过渡与动画。
       无头截图 + --virtual-time-budget 下 CSS 过渡不会推进，量出来的盒子会停在起始值。 */
    if (/noanim=1|geom=1/.test(location.search)) {
      var s = document.createElement('style');
      s.id = 'vnNoAnim';
      s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.appendChild(s);
    }
    window.addEventListener('error', function (e) { window.__vnErrors.push('error: ' + e.message); });
    window.addEventListener('unhandledrejection', function (e) { window.__vnErrors.push('reject: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
    try { themeMode = (localStorage.getItem('rp-theme-mode') === 'light') ? 'light' : 'dark'; } catch (e) { }
    setTheme(themeMode, true);
    applyFs(true);
    syncSidebarGlyph();
    initSettingsNav();
    setAuto(false, true);   /* AUTO 默认关：对齐按钮视觉，避免出现「看起来是开的但没生效」 */
    syncViz();
    syncTts();
    clearDemoData();
    hookApplyBg();
    hookRenderGallery();
    ensureConversations().then(function () { decorateConvRows(byId('characterList')); });
    /* 读一次访问密码状态：更新系统菜单里的提示；若仍是默认密码，首次进来提醒改掉 */
    loadAuthStatus().then(function (s) {
      if (!s || !s.isLocal || !s.usingDefaultPassword) return;
      var key = 'aigal_pw_prompt_done';
      try { if (localStorage.getItem(key) === '1') return; } catch (e) { }
      setTimeout(function () {
        try { localStorage.setItem(key, '1'); } catch (e) { }
        toast('访问密码仍是默认的 12345 —— 建议在「菜单 → 访问密码」里改掉');
      }, 2500);
    });
    observeMessages();
    render();
    updateHeader();
    syncTokens();
    dumpState();

    /* app.js 是异步 init：轮询到真实数据再刷 */
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      App = window.AppState || App;
      syncFromDom(false);
      updateHeader();
      syncTokens();
      syncTts();
      syncViz();
      if (tries === 3 || tries === 10 || tries === 25) { renderHistory(); renderConsole(); ['status', 'roster', 'gallery', 'memory', 'world'].forEach(loadPane); }
      autoResume();
      syncStage();
      dumpState();
      if (tries > 40) clearInterval(poll);
    }, 800);

    var titleEl = byId('conversationTitle');
    if (titleEl) new MutationObserver(updateHeader).observe(titleEl, { childList: true, characterData: true, subtree: true });

    document.addEventListener('visibilitychange', function () { if (!document.hidden) { syncFromDom(false); syncTokens(); } });
    applyUrlState();
    console.log('[VN] 桌面视觉小说外壳已就绪');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

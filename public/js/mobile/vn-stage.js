/* =============================================================================
   AI-GAL 移动端 · GAL 逐段演出驱动（vn-stage.js）
   -----------------------------------------------------------------------------
   职责：把 app.js 渲染到 #messagesArea 的消息，转换成「一段一段」的 GAL 演出：
     · 旁白段 → 衬线字体、无头像
     · 对白段 → 无衬线字体 + 说话者头像（左右交错）+ 名牌
   两段永不并存；点「推进」或点对话框翻段。
   依赖：app.js（业务逻辑）、vn-shell.js（外壳/页面/主题）
   ============================================================================= */
(function () {
  'use strict';

  var VN = window.VN = window.VN || {};

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------- 演出状态 ---------------- */
  var S = {
    segments: [],   // [{type:'line'|'narr', text, speaker, avatar, side, name}]
    idx: 0,
    lastBlockId: null,
    lastConvId: null,   // 用于识别「切换了存档」→ 从第 1 段重读
    forceFirst: false,  // 下一次同步强制从第 1 段开始
    streaming: false,
    follow: true,   // 是否自动跟随最新消息
    reviewBlockId: null, // 正在回顾的历史消息（非最新一条）
  };
  VN.stage = S;

  var dlgEl, stageEl, avatarL, avatarR, plateRow, spkName, spkRomaji, dlgText, dlgNarr,
    narrHint, segBadge, segDots, choicesEl, locEl, castEl, artImg, bgEl;

  /* ---------------- 工具 ---------------- */
  function textOf(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+\n/g, '\n').trim();
  }

  /** 玩家侧显示名（真实身份或游戏内扮演身份） */
  function playerName() {
    var up = window.AppState && window.AppState.userProfile;
    if (!up) return '我';
    return (up.persona_name || up.name || '我');
  }

  function hashSide(name) {
    // 同一说话者尽量固定在同一侧（同一次抽取内保持一致）
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
    return h % 2 === 0 ? 'left' : 'right';
  }

  /**
   * 决定每段的左右侧别：以「说话者」为单位交替。
   * 设计目标：两人对话时头像自动左右交错（同一人始终同一侧，换人即换边）。
   */
  function assignSides(segs) {
    var map = {};   // speaker -> 'left' | 'right'
    var next = 'left';
    segs.forEach(function (seg) {
      if (seg.type !== 'line') return;
      var key = seg.speaker || '角色';
      if (!map[key]) {
        map[key] = next;
        next = (next === 'left') ? 'right' : 'left';
      }
      seg.side = map[key];
    });
    return segs;
  }

  /**
   * 解析说话者头像地址。
   * app.js 的做法（保持一致）：名册里 avatar 不是完整地址时，
   * 走 `/api/saves/:saveId/avatar/:角色名` —— 后端按**角色名**去找生成的头像文件，
   * 而不是按 avatar 字段里的文件名。之前这里按文件名拼路径，所以读不出头像。
   */
  function resolveAvatar(name, rosterAvatar) {
    if (rosterAvatar && /^(\/|https?:|data:)/.test(rosterAvatar)) return rosterAvatar;
    // 玩家侧：用真实身份 / 扮演身份头像（与 app.js 的 getUserAvatarForName 一致）
    var up = window.AppState && window.AppState.userProfile;
    if (up && name) {
      var pn = up.persona_name || '';
      if (name === (up.name || '我') || name === '你' || (pn && name === pn)) {
        if (pn && name === pn && up.persona_avatar) return up.persona_avatar;
        return up.avatar || '';
      }
    }
    var hit = lookupRoster(name);
    if (!hit) return '';
    var entry = hit.entry || {};
    var av = entry.avatar;
    if (!av || av === 'pending' || av === '已有头像') return '';
    if (/^(\/|https?:|data:)/.test(av)) return av;
    var sid = currentSaveId();
    if (!sid) return '';
    return '/api/saves/' + encodeURIComponent(sid) + '/avatar/' + encodeURIComponent(hit.matchName || name);
  }

  /** 当前存档 id（优先对话的 save_id） */
  function currentSaveId() {
    try {
      var c = window.AppState && window.AppState.currentConversation;
      if (c) return c.save_id || c.id || '';
    } catch (e) { }
    try { return localStorage.getItem('mobile-lastConv') || ''; } catch (e) { }
    return '';
  }

  /** 名册查找：精确 → 互相包含 → 按 · / - 拆词（与 app.js 的 lookupRosterEntry 同策略） */
  function lookupRoster(speakerName) {
    var roster = (VN.pages && VN.pages.roster) || {};
    if (!speakerName || !Object.keys(roster).length) return null;
    if (roster[speakerName]) return { entry: roster[speakerName], matchName: speakerName };
    var keys = Object.keys(roster);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.includes(speakerName) || speakerName.includes(key)) {
        return { entry: roster[key], matchName: key };
      }
    }
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (/[·\-]/.test(k) || /[·\-]/.test(speakerName)) {
        var kp = k.split(/[·\-]/), sp = speakerName.split(/[·\-]/);
        for (var a = 0; a < kp.length; a++) {
          for (var b = 0; b < sp.length; b++) {
            var x = (kp[a] || '').trim(), y = (sp[b] || '').trim();
            if (x && y && (x === y || x.includes(y) || y.includes(x))) {
              return { entry: roster[k], matchName: k };
            }
          }
        }
      }
    }
    return null;
  }

  /* ---------------- 从 app.js 的渲染结果抽取段落 ---------------- */
  /**
   * app.js 把一个 AI 回复渲染成 .story-block，实际结构（已核对）：
   *   旁白： <p class="narration-text">…</p>
   *   对白： <div class="dialog-wrapper dialog-wrapper-left|right">
   *            <div class="dialogue-avatar">绫</div>
   *            <div class="dialogue-bubble">
   *              <div class="dialog-content">
   *                <div class="dialogue-name-row"><span class="dialogue-name">示例角色丙</span></div>
   *                <span class="dialogue-divider"></span>
   *                <p class="dialogue-text">……那封信</p>
   *              </div>
   *            </div>
   *          </div>
   *   选项： <div class="choice-menu">…
   * 这里只按顺序抽取，不重新解析文本，保证与后端/桌面解析一致。
   * 注意：必须按 DOM 顺序遍历，因此先选出所有相关节点再排序（querySelectorAll 已是文档序）。
   */
  function extractSegments(block) {
    var out = [];
    if (!block) return out;
    // 玩家消息：app.js 渲染为 .user-action-text（不是旁白也不是对白）
    if (block.classList && block.classList.contains('user')) {
      var ua = $('.user-action-text', block);
      var ut = textOf(ua) || textOf($('.user-action', block)) || textOf(block);
      // 去掉轮次/时间等噪声，只留正文
      ut = ut.replace(/^#\d+\s*/, '').replace(/▷\s*/, '').replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim();
      if (ut) out.push({ type: 'line', text: ut, speaker: playerName(), side: 'right' });
      return out;
    }
    var nodes = $$('.narration-text, .dialog-wrapper, .scene-content, .html-message', block);
    nodes.forEach(function (el) {
      if (el.classList.contains('narration-text')) {
        var t = textOf(el);
        if (t) out.push({ type: 'narr', text: t });
        return;
      }
      if (el.classList.contains('dialog-wrapper')) {
        var nameEl = $('.dialogue-name', el);
        var bodyEl = $('.dialogue-text', el) || $('.speaker-dialogue', el) || $('.dialogue-bubble', el);
        var name = nameEl ? textOf(nameEl).replace(/[:：]\s*$/, '') : '';
        var txt = textOf(bodyEl);
        if (!txt) return;
        // 侧别：app.js 的 dialog-wrapper-right 优先；否则按说话者名字确定（同一角色固定一侧，
        // 这样两人对话时头像会自动左右交错，与设计稿一致）
        var isRight = el.classList.contains('dialog-wrapper-right');
        var side = el.classList.contains('dialog-wrapper-left') ? 'left'
          : (isRight ? 'right' : hashSide(name || '角色'));
        out.push({
          type: 'line',
          text: txt,
          speaker: name || (($('.dialogue-avatar', el) || {}).textContent || '角色').trim(),
          side: side
        });
        return;
      }
      // 自定义场景 / 嵌入块：整体作为一段旁白，保证不丢内容
      var t2 = textOf(el);
      if (t2) out.push({ type: 'narr', text: t2 });
    });
    return assignSides(out);
  }

  /** 抽取行动选项（app.js 的 .choice-menu）
   *  注意：按钮是 .choice-option，文案在 .choice-label 里；
   *  直接用按钮 textContent 会把序号（1/2/3）一起带上，所以优先取 .choice-label。
   *  开场白里的选项同样走这条路径，因此开场就能读到。 */
  function extractChoices(block) {
    var out = [];
    if (!block) return out;
    $$('.choice-menu .choice-option, .choice-menu .action-btn, .choice-menu button', block).forEach(function (b) {
      var lbl = $('.choice-label', b);
      var t = (lbl ? textOf(lbl) : '') || b.getAttribute('data-action') || textOf(b);
      t = String(t || '').trim();
      if (t) out.push(t);
    });
    return out;
  }

  /* ---------------- 对话标题 / 轮次 ---------------- */
  function roundOf(block) {
    var r = block && block.dataset ? parseInt(block.dataset.round, 10) : 0;
    return isNaN(r) ? 0 : r;
  }

  /* ---------------- 渲染 ---------------- */
  function renderTopInfo(title, round) {
    var t = $('#vnTitle'), r = $('#vnRounds');
    if (t && title) t.textContent = title;
    if (r) r.textContent = round > 0 ? ('第 ' + round + ' 轮') : '准备开始';
  }

  function setBackground(url) {
    if (!bgEl) return;
    if (url) {
      document.documentElement.style.setProperty('--stage-bg-img', 'url("' + url + '")');
      if (artImg) {
        artImg.src = url;
        artImg.style.display = '';
      }
    } else {
      if (artImg) artImg.style.display = 'none';
    }
  }

  function setAvatarUrl(el, url, name) {
    if (!el) return;
    if (url) {
      el.innerHTML = '';
      var img = document.createElement('img');
      img.src = url;
      img.alt = name || '';
      img.onerror = function () {
        el.innerHTML = '';
        el.textContent = (name || '?').charAt(0);
      };
      el.appendChild(img);
      el.dataset.url = url;
    } else {
      el.innerHTML = '';
      el.textContent = (name || '?').charAt(0);
      el.dataset.url = '';
    }
    el.dataset.name = name || '';
  }

  function renderSegDots() {
    if (!segDots) return;
    segDots.innerHTML = '';
    var n = S.segments.length;
    if (n > 12) n = 12; // 过多时只示意
    for (var i = 0; i < n; i++) segDots.appendChild(document.createElement('i'));
  }

  function markSegDots() {
    if (!segDots) return;
    var kids = $$('i', segDots);
    var n = S.segments.length || 1;
    var cur = Math.round(S.idx / Math.max(1, n - 1) * (kids.length - 1));
    kids.forEach(function (d, k) { d.classList.toggle('on', k === cur); });
  }

  function updateNarrHint() {
    if (!dlgNarr || !narrHint) return;
    var more = dlgEl.classList.contains('is-narr') && (dlgNarr.scrollHeight - dlgNarr.clientHeight > 4);
    narrHint.classList.toggle('show', more);
    narrHint.textContent = (dlgNarr.scrollTop + dlgNarr.clientHeight >= dlgNarr.scrollHeight - 6)
      ? '↕ 已到底部' : '↕ 本段较长，可滚动';
  }

  function renderSegment(i, opts) {
    opts = opts || {};
    var seg = S.segments[i];
    if (!seg) return;
    S.idx = i;

    if (segBadge) segBadge.textContent = (i + 1) + ' / ' + S.segments.length;
    markSegDots();

    if (seg.type === 'line') {
      dlgEl.classList.remove('is-narr');
      var side = seg.side === 'right' ? 'right' : 'left';
      dlgEl.classList.toggle('by-left', side === 'left');
      dlgEl.classList.toggle('by-right', side === 'right');
      plateRow.classList.toggle('right', side === 'right');
      avatarL.classList.toggle('on', side === 'left');
      avatarR.classList.toggle('on', side === 'right');

      spkName.textContent = seg.speaker || '角色';
      var romajiEl = $('#vnSpkRomaji');
      if (romajiEl) romajiEl.textContent = /^[A-Za-z0-9 ]+$/.test(seg.speaker || '') ? seg.speaker.toUpperCase() : '';
      dlgText.innerHTML = '';
      dlgText.appendChild(document.createTextNode(seg.text));
      var cur = document.createElement('span');
      cur.className = 'cur';
      dlgText.appendChild(cur);

      var av = resolveAvatar(seg.speaker);
      setAvatarUrl(avatarL, av, seg.speaker);
      setAvatarUrl(avatarR, av, seg.speaker);

      // 名册可能还没加载（对白头像依赖它）：拉取后补一次头像
      if (!av && !lookupRoster(seg.speaker) && VN.pages && VN.pages.fetchRoster) {
        VN.pages.fetchRoster().then(function () {
          if (S.idx !== i) return;                     // 已经翻页就不补了
          var av2 = resolveAvatar(seg.speaker);
          if (!av2) return;
          setAvatarUrl(avatarL, av2, seg.speaker);
          setAvatarUrl(avatarR, av2, seg.speaker);
        });
      }

      // 好感度（若名册里有则显示）
      updateAffinity(seg.speaker);
      dlgNarr.scrollTop = 0;
    } else {
      dlgEl.classList.add('is-narr');
      dlgNarr.textContent = seg.text || '';
      dlgNarr.scrollTop = 0;
      avatarL.classList.remove('on');
      avatarR.classList.remove('on');
    }
    setTimeout(updateNarrHint, 30);
    if (!opts.silent) VN.shell && VN.shell.vibrate && VN.shell.vibrate(6);
  }

  function updateAffinity(name) {
    var roster = (VN.pages && VN.pages.roster) || {};
    var entry = roster[name];
    var box = $('#vnAff');
    if (!box) return;
    if (!entry) { box.style.visibility = 'hidden'; return; }
    var val = parseInt(entry.affinity || entry['好感度'] || entry['好感'] || 0, 10) || 0;
    if (!val) { box.style.visibility = 'hidden'; return; }
    box.style.visibility = '';
    var fill = $('i', box);
    var num = $('b', box);
    if (fill) fill.style.width = Math.max(0, Math.min(100, val)) + '%';
    if (num) num.textContent = String(val);
  }

  function renderChoices(list) {
    if (!choicesEl) return;
    choicesEl.innerHTML = '';
    if (!list || !list.length) return;
    list.forEach(function (text) {
      var b = document.createElement('button');
      b.className = 'vn-ch';
      var span = document.createElement('span');
      span.textContent = text;
      b.appendChild(span);
      b.addEventListener('click', function () {
        chooseAction(text);
      });
      choicesEl.appendChild(b);
    });
  }

  /** 点击行动选项：填入输入框并发送（复用 app.js 的发送逻辑） */
  function chooseAction(text) {
    var input = document.getElementById('messageInput');
    var send = document.getElementById('btnSend');
    if (!input || !send) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
    choicesEl.innerHTML = '';
    VN.shell && VN.shell.toast && VN.shell.toast('已选择：' + text);
  }
  VN.chooseAction = chooseAction;

  /* ---------------- 推进 ---------------- */
  function next() {
    if (!S.segments.length) return;
    // 旁白未读完时先滚动
    if (dlgEl.classList.contains('is-narr') && dlgNarr.scrollHeight - dlgNarr.clientHeight > 4 &&
      dlgNarr.scrollTop + dlgNarr.clientHeight < dlgNarr.scrollHeight - 6) {
      dlgNarr.scrollTop = dlgNarr.scrollTop + Math.max(60, dlgNarr.clientHeight * 0.8);
      updateNarrHint();
      return;
    }
    if (S.idx >= S.segments.length - 1) {
      if (S.streaming) return; // 还在生成，等待
      // 全部读完：提示等待或从头再看
      VN.shell && VN.shell.toast && VN.shell.toast('本回合已读完');
      return;
    }
    renderSegment(S.idx + 1);
  }
  function prev() {
    if (!S.segments.length || S.idx <= 0) return;
    renderSegment(S.idx - 1);
  }
  VN.nextSegment = next;
  VN.prevSegment = prev;

  /* ---------------- 从 #messagesArea 同步 ---------------- */
  function latestBlock() {
    var area = document.getElementById('messagesArea');
    if (!area) return null;
    var blocks = $$('.story-block', area);
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  function syncFromDom(force) {
    var block = latestBlock();
    if (!block) return;
    var id = block.dataset.id || '';
    var segs = extractSegments(block);
    if (!segs.length) return;

    var convId = (window.AppState && window.AppState.currentConversation && window.AppState.currentConversation.id) || '';

    // 正在回顾历史：不要被最新消息的同步顶走
    if (S.reviewBlockId && !force) {
      if (S.reviewBlockId === id) return;              // 还在看同一条历史
      return;                                          // 保持手动选中的那一段
    }

    // 切换存档 / 首次载入 → 视为「开始阅读这一回合」，默认从第 1 段开始
    var fresh = false;
    if (convId !== S.lastConvId) {
      S.lastConvId = convId;
      fresh = true;
      S.forceFirst = true;
    }
    if (S.forceFirst) { fresh = true; S.forceFirst = false; }

    var isNew = id !== S.lastBlockId;
    var lenChanged = segs.length !== S.segments.length;
    if (!isNew && !lenChanged && !fresh) {
      // 内容与长度都没变化：保持当前阅读位置（流式增量由 lenChanged 覆盖）
      return;
    }
    S.lastBlockId = id;
    S.segments = segs;
    renderSegDots();

    // 深链 ?seg=N：优先定位到指定段（只在首个块上生效一次）
    if (typeof S.pendingSeg === 'number' && segs[S.pendingSeg]) {
      renderSegment(S.pendingSeg, { silent: true });
      S.pendingSeg = null;
      setChoicesFromBlock(block);
      updateHeaderFromBlock(block);
      updateBackgroundFromBlock(block);
      return;
    }

    if (fresh) {
      // 刚载入 / 刚切换存档：从第 1 段开始读，不跳到结尾
      renderSegment(0, { silent: true });
    } else if (isNew) {
      // 新回合（AI 新回复 / 用户新消息）：从头开始读这一回合
      renderSegment(0, { silent: true });
    } else if (S.idx >= segs.length) {
      renderSegment(segs.length - 1, { silent: true });
    }

    // 行动选项 + 背景 + 顶栏信息
    setChoicesFromBlock(block);
    updateHeaderFromBlock(block);
    updateBackgroundFromBlock(block);
    S.follow = true;
    S.reviewBlockId = null;   // 有新内容即视为回到最新
    updateBackLatest();
  }

  function updateHeaderFromBlock(block) {
    var title = document.getElementById('conversationTitle');
    var round = roundOf(block);
    renderTopInfo(title ? title.textContent : '', round);
  }

  /** 背景：单张 —— 最新 CG 优先，无 CG 用当前角色卡卡面 */
  function updateBackgroundFromBlock(block) {
    // 1) 该消息内自带的图片（刚生成的 CG）优先
    var img = block ? $('.msg-inline-image, .scene-content img, .gallery-image', block) : null;
    var url = img && (img.getAttribute('src') || img.dataset.src);
    // 2) 本存档最新 CG（预取）
    if (!url) url = VN.pages && VN.pages.latestCG && VN.pages.latestCG();
    // 3) 角色卡卡面
    if (!url) url = VN.pages && VN.pages.cardFace && VN.pages.cardFace();
    if (url) setBackground(url);
  }

  /** 拉一次最新 CG 并刷新舞台背景（对话载入后调用） */
  function refreshBackground() {
    if (!VN.pages || !VN.pages.fetchLatestCG) return;
    VN.pages.fetchLatestCG().then(function (url) {
      if (url) setBackground(url);
    });
  }
  VN.refreshBackground = refreshBackground;

  function setStreaming(on) {
    S.streaming = !!on;
    dlgEl.classList.toggle('is-streaming', !!on);
  }
  VN.setStreaming = setStreaming;

  /* ---------------- 观察 DOM 变化 ---------------- */
  function observe() {
    var area = document.getElementById('messagesArea');
    if (!area) return;
    var mo = new MutationObserver(function (muts) {
      var touched = false;
      muts.forEach(function (m) {
        if (m.target && (m.target.closest && m.target.closest('.story-block'))) touched = true;
        if (m.addedNodes && m.addedNodes.length) {
          Array.prototype.forEach.call(m.addedNodes, function (n) {
            if (n.nodeType === 1 && (n.classList.contains('story-block') || (n.closest && n.closest('.story-block')))) touched = true;
          });
        }
      });
      if (touched) syncFromDom(false);
    });
    mo.observe(area, { childList: true, subtree: true, characterData: true });
  }

  /* ---------------- 输入条 ---------------- */
  function bindInput() {
    var input = document.getElementById('messageInput');
    var send = document.getElementById('btnSend');
    // 输入框自适应高度 + 发送后清空
    if (input) {
      input.addEventListener('input', function () {
        input.style.height = 'auto';
        input.style.height = Math.min(96, Math.max(32, input.scrollHeight)) + 'px';
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (send && !send.disabled) send.click();
        }
      });
    }
    if (send) {
      send.addEventListener('click', function () {
        setStreaming(true);
        // 发送后收起选项
        if (choicesEl) choicesEl.innerHTML = '';
        setTimeout(function () { setStreaming(false); syncFromDom(true); }, 400);
      });
    }
  }

  /* ---------------- 头像大图 / 全屏 CG ---------------- */
  function openViewer(src, name, sub) {
    var v = $('#vnViewer');
    if (!v) return;
    var img = $('#vnViewerImg');
    if (img) img.src = src || '';
    var nm = $('#vnViewerName');
    if (nm) nm.textContent = name || '';
    var s = $('#vnViewerSub');
    if (s) s.textContent = sub || '轻点任意处关闭';
    v.classList.add('show');
  }
  VN.openViewer = openViewer;

  /**
   * 关闭大图浮层，并**同时恢复被隐藏的界面**。
   * 之前这里只移除浮层的 show，没有清掉 #vnRoot 的 ui-hidden，
   * 导致「隐藏 UI」进入全屏后点一下只关掉图片、界面仍然是隐藏的（无法切回）。
   */
  function closeViewer() {
    var v = $('#vnViewer');
    if (v) v.classList.remove('show');
    var root = document.getElementById('vnRoot');
    if (root) root.classList.remove('ui-hidden');
  }
  VN.closeViewer = closeViewer;

  /** 当前可展示的画面：最新 CG → 角色卡卡面 → 内置首页图（保证一定有图可看） */
  function currentFace() {
    var url = (VN.pages && VN.pages.latestCG && VN.pages.latestCG())
      || (VN.pages && VN.pages.cardFace && VN.pages.cardFace());
    return url || '/home.jpeg';
  }

  function bindViewer() {
    var v = $('#vnViewer');
    if (v) v.addEventListener('click', closeViewer);
    var vc = $('#vnViewerClose');
    if (vc) vc.addEventListener('click', function (e) { e.stopPropagation(); closeViewer(); });

    if (avatarL) avatarL.addEventListener('click', function () {
      openViewer(avatarL.dataset.url || currentFace(), avatarL.dataset.name, '轻点任意处关闭');
    });
    if (avatarR) avatarR.addEventListener('click', function () {
      openViewer(avatarR.dataset.url || currentFace(), avatarR.dataset.name, '轻点任意处关闭');
    });

    // 隐藏 UI → 全屏看最新 CG（保持原比例，未铺满处用底色）；点任意处 / Esc 恢复界面
    var btnHide = $('#vnBtnHideUI');
    if (btnHide) btnHide.addEventListener('click', function (e) {
      e.stopPropagation();
      var root = document.getElementById('vnRoot');
      if (root.classList.contains('ui-hidden')) { closeViewer(); return; }  // 再点一次即恢复
      root.classList.add('ui-hidden');
      openViewer(currentFace(), '', '看 CG · 轻点任意处返回');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeViewer();
    });

    // 点对话框空白处推进
    var stage = $('#vnDlgStage');
    if (stage) stage.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      if (e.target === dlgNarr && dlgNarr.scrollHeight - dlgNarr.clientHeight > 4) return;
      next();
    });

    var btnNext = $('#vnBtnNext');
    if (btnNext) btnNext.addEventListener('click', next);
    var btnPrev = $('#vnBtnPrev');
    if (btnPrev) btnPrev.addEventListener('click', prev);

    var hint = narrHint;
    if (dlgNarr) dlgNarr.addEventListener('scroll', updateNarrHint);
  }

  /* ---------------- 历史记录（回顾） ----------------
     移动端不做后台调试：「回顾」打开历史对话浮层，
     点任意一条即可回到那一段记录继续阅读 / 接续推进。
  ------------------------------------------------------------------ */

  /** 取 #messagesArea 里所有消息块（含角色、轮次、摘要） */
  function listBlocks() {
    var area = document.getElementById('messagesArea');
    if (!area) return [];
    return $$('.story-block', area).map(function (bl, i) {
      var isUser = bl.classList.contains('user');
      var segs = extractSegments(bl);
      var summary = segs.map(function (s) {
        return (s.type === 'line' ? '「' + s.text + '」' : s.text);
      }).join(' ').replace(/\s+/g, ' ').trim();
      if (summary.length > 60) summary = summary.slice(0, 60) + '…';
      var name = '';
      if (isUser) {
        name = playerName();
      } else {
        var first = segs.filter(function (s) { return s.type === 'line'; })[0];
        var ch = window.AppState && window.AppState.currentCharacter;
        name = (first && first.speaker) || (ch && ch.name) || '旁白';
      }
      return {
        id: bl.dataset.id || ('idx-' + i),
        index: i,
        round: parseInt(bl.dataset.round, 10) || 0,
        isUser: isUser,
        name: name,
        summary: summary,
        block: bl,
      };
    });
  }

  function updateBackLatest() {
    var btn = $('#vnBackLatest');
    if (!btn) return;
    btn.classList.toggle('hidden', !S.reviewBlockId);
  }

  function showHistory() {
    var sheet = $('#vnHistorySheet'), body = $('#vnHistoryBody'), title = $('#vnHistoryTitle');
    if (!sheet || !body) return;
    var blocks = listBlocks();
    if (title) title.textContent = '历史记录' + (blocks.length ? '（' + blocks.length + ' 条）' : '');
    if (!blocks.length) {
      body.innerHTML = '<div class="vn-empty">还没有历史记录。</div>';
    } else {
      // 最新的排在最上面，方便就近回看
      var html = '';
      blocks.slice().reverse().forEach(function (b) {
        var on = S.reviewBlockId ? (S.reviewBlockId === b.id)
          : (b.id === S.lastBlockId);
        html += '<button class="vn-hist-item' + (b.isUser ? ' me' : '') + (on ? ' on' : '') + '" data-block="' + esc(b.id) + '">' +
          '<span class="who">' + esc(b.name) + '</span>' +
          '<span class="txt">' + (b.isUser ? '' : '<span class="narr">') + esc(b.summary || '（无文本）') + (b.isUser ? '' : '</span>') + '</span>' +
          '<span class="seq">' + (b.round ? ('#' + b.round) : '') + '</span>' +
          '</button>';
      });
      body.innerHTML = html;
      $$('.vn-hist-item', body).forEach(function (el) {
        el.addEventListener('click', function () { jumpToBlock(el.dataset.block); });
      });
    }
    sheet.classList.add('show');
    $('#vnScrim').classList.add('show');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 跳到某条历史消息：该消息的段落重新逐段演出 */
  function jumpToBlock(blockId) {
    if (!blockId) return;
    var blocks = listBlocks();
    var hit = blocks.filter(function (b) { return b.id === blockId; })[0];
    if (!hit) { VN.shell && VN.shell.toast && VN.shell.toast('这条记录已不在当前对话中'); return; }
    var segs = extractSegments(hit.block);
    if (!segs.length) { VN.shell && VN.shell.toast && VN.shell.toast('这条记录没有可显示的内容'); return; }

    S.segments = segs;
    S.lastBlockId = hit.id;
    S.reviewBlockId = hit.id;      // 冻结自动跟随，直到用户回到最新
    S.idx = 0;
    S.follow = false;
    renderSegDots();
    renderSegment(0, { silent: true });
    setChoicesFromBlock(hit.block);
    updateBackLatest();
    closeHistory();
    VN.shell && VN.shell.toast && VN.shell.toast('已回到：' + hit.name + (hit.round ? ' · 第 ' + hit.round + ' 轮' : ''));
  }

  /** 回到最新进度 */
  function backToLatest() {
    var block = latestBlock();
    S.reviewBlockId = null;
    S.follow = true;
    S.forceFirst = false;
    updateBackLatest();
    if (block && !S.streaming) {
      // 最新一条从头开始读
      var segs = extractSegments(block);
      if (segs.length) {
        S.segments = segs;
        S.lastBlockId = block.dataset.id || '';
        S.idx = 0;
        renderSegDots();
        renderSegment(0, { silent: true });
      }
      setChoicesFromBlock(block);
    } else {
      syncFromDom(true);
    }
    VN.shell && VN.shell.toast && VN.shell.toast('已回到最新进度');
  }

  /** 选项只在「最新一条」时可点选（历史消息属于已发生的回合） */
  function setChoicesFromBlock(block) {
    if (S.reviewBlockId) { renderChoices([]); return; }
    renderChoices(extractChoices(block));
  }

  function closeHistory() {
    var sheet = $('#vnHistorySheet');
    if (sheet) sheet.classList.remove('show');
    var scrim = $('#vnScrim');
    if (scrim) scrim.classList.remove('show');
  }

  VN.showHistory = showHistory;
  VN.jumpToBlock = jumpToBlock;
  VN.backToLatest = backToLatest;
  VN.closeHistory = closeHistory;

  /* ---------------- 初始化 ---------------- */
  function init() {
    dlgEl = $('#vnDlg');
    stageEl = $('#vnStage');
    avatarL = $('#vnAvLeft');
    avatarR = $('#vnAvRight');
    plateRow = $('#vnPlateRow');
    spkName = $('#vnSpkName');
    dlgText = $('#vnDlgText');
    dlgNarr = $('#vnDlgNarr');
    narrHint = $('#vnNarrHint');
    segBadge = $('#vnSegBadge');
    segDots = $('#vnSegDots');
    choicesEl = $('#vnChoices');
    locEl = $('#vnLoc');
    castEl = $('#vnCast');
    artImg = $('#vnArtImg');
    bgEl = $('#vnStageBg');

    if (!dlgEl) return;

    renderSegDots();
    bindInput();
    bindViewer();
    observe();
    window.addEventListener('resize', function () { setTimeout(updateNarrHint, 60); });

    // 深链：?seg=N 定位到当前回合的第 N 段（便于验收与分享阅读位置）
    try {
      var segParam = parseInt(new URLSearchParams(location.search).get('seg'), 10);
      if (!isNaN(segParam) && segParam > 0) S.pendingSeg = segParam - 1;
    } catch (e) { }

    // 初次同步（历史消息）；?seg 会在同步成功后自动定位
    setTimeout(function () { syncFromDom(true); }, 700);
    // 定时兜底：防止某些更新绕过 MutationObserver（节流）
    setInterval(function () { syncFromDom(false); }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

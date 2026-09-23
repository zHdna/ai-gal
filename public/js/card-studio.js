/**
 * card-studio.js —— 卡坊（Layer U）
 * S1：免费体检（零 LLM）+ 主 AI 供应商悬浮提示。
 * S4：一键适配 → 真实渲染预览（线上同一个 renderAIBlock，空 formatted 走兜底分支）
 *      → 逐项确认（每条可单独取消）→ 应用（显式动作，可回滚）→ 回读刷新表单与 AppState。
 *
 * 依赖全局（经典脚本，index.html 顺序加载）：AppState / renderAIBlock / showToast（app.js）。
 * apply/rollback 后回填编辑表单：否则用户随后点「保存角色卡」会把**旧字段**写回去（§2.2）。
 */
(function () {
  'use strict';

  const API = '/api/card-studio';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const tip = (msg, kind) => { if (window.showToast) showToast(msg, kind || 'info'); };

  // 当前会话状态（弹窗内）
  let currentHash = '';       // 最近一次 adapt 的 source_hash（apply 的陈旧检测用）
  let adaptData = null;       // 最近一次 adapt 的响应
  let appliedOnce = false;    // apply 成功后切换到结果视图

  // ── 供应商提示（悬浮按钮 title） ────────────────────────────────────────────
  async function refreshProviderTip() {
    const btn = document.getElementById('btnCardStudio');
    if (!btn) return null;
    try {
      const r = await fetch(API + '/provider');
      const data = await r.json();
      if (data && data.provider) {
        btn.title = '一键修卡 —— 用 AI 适配本卡的格式与设定，使之匹配前端渲染\n体检免费；适配消耗主 AI 供应商：' + data.provider.name + ' · ' + (data.provider.model || '未填模型');
      } else {
        btn.title = '体检免费；适配前先在「AI 与供应商」里配置主 AI 供应商（' + ((data && data.message) || '尚未配置') + '）';
      }
      return data;
    } catch (e) {
      btn.title = '体检免费';
      return null;
    }
  }

  // ── 弹窗骨架（自建，不占 index.html 既有元素） ──────────────────────────────
  function ensureModal() {
    let m = document.getElementById('cardStudioModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'cardStudioModal';
    m.className = 'modal hidden';
    m.innerHTML =
      '<div class="modal-overlay" id="cardStudioOverlay"></div>' +
      '<div class="modal-content" style="max-width:940px">' +
      '  <div class="modal-header"><h3 id="cardStudioTitle">卡坊体检</h3>' +
      '    <button class="modal-close" id="cardStudioClose">×</button></div>' +
      '  <div class="modal-body" id="cardStudioBody" style="max-height:64vh;overflow:auto;font-size:13px;line-height:1.6"></div>' +
      '  <div class="modal-footer" id="cardStudioFooter">' +
      '    <button class="btn btn-info" id="cardStudioAdapt">一键适配（消耗主 AI）</button>' +
      '    <button class="btn btn-warning" id="cardStudioRollback" style="display:none">回滚上次应用</button>' +
      '    <button class="btn btn-primary" id="cardStudioOk">关闭</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector('#cardStudioOverlay').addEventListener('click', close);
    m.querySelector('#cardStudioClose').addEventListener('click', close);
    m.querySelector('#cardStudioOk').addEventListener('click', close);
    m.querySelector('#cardStudioAdapt').addEventListener('click', runAdapt);
    m.querySelector('#cardStudioRollback').addEventListener('click', runRollback);
    return m;
  }
  function close() {
    const m = document.getElementById('cardStudioModal');
    if (m) m.classList.add('hidden');
  }
  function open() {
    ensureModal().classList.remove('hidden');
  }

  // ── 报告渲染（S1 体检） ─────────────────────────────────────────────────────
  function issueRow(it) {
    const icon = it.level === 'error' ? '🔴' : '🟡';
    return '<div style="padding:2px 0">' + icon + ' <b>' + esc(it.code) + '</b> ' + esc(it.msg) +
      (it.detail ? '<div style="opacity:.7;padding-left:22px">' + esc(String(it.detail)).slice(0, 160) + '</div>' : '') +
      '</div>';
  }
  function section(title, inner) {
    return '<div style="margin:10px 0 2px;font-weight:600;border-bottom:1px solid rgba(128,128,128,.35)">' + title + '</div>' + inner;
  }

  function renderReport(report, meta) {
    const body = document.getElementById('cardStudioBody');
    const g = report.greeting;
    const sp = report.system_prompt;
    const wb = report.worldbook;
    const pv = report.provider || {};
    const pvLine = pv.provider
      ? '主 AI 供应商：<b>' + esc(pv.provider.name) + ' · ' + esc(pv.provider.model || '未填模型') + '</b>（适配时消耗其 token）'
      : esc(pv.message || '尚未配置主 AI 供应商');
    document.getElementById('cardStudioTitle').textContent = '卡坊体检 · ' + report.name;

    body.innerHTML =
      section('基本信息', '<div>' + (report.engine.is_engine ? '⚙ 引擎卡（变量块按字节保留，适配只重排叙事/对白）' : '📖 常规卡') +
        '<div>' + pvLine + '</div>' +
        '<div style="opacity:.7">体检免费 · ' + meta.duration_ms + ' ms · LLM 调用 ' + meta.llm_calls + ' 次</div></div>') +
      section('开场白（前端兜底渲染链）',
        '<div>分类 ' + esc(g.classify) + ' · 对白 ' + g.dialog_count + ' 句（' + esc(g.dialog_names.join('、') || '无') + '）· 旁白 ' + g.story_count + ' 段</div>' +
        '<div>行动选项 ' + (g.actions.length) + ' 条 · 状态键 ' + (g.status_keys.length) + ' 个 · 独立面板块 ' + g.inline_block_count + ' 个</div>' +
        (g.issues.length ? g.issues.map(issueRow).join('') : '<div style="color:#4caf50">✓ 开场白通过全部回环断言</div>')) +
      section('system_prompt',
        '<div>长度 ' + sp.length + ' 字 · ' + (sp.has_status_contract ? '已含 ### status 状态段' : '缺状态格式段（适配时按状态白名单补契约）') + '</div>' +
        (sp.unsupported_macros.length
          ? '<div>🟡 项目只替换 {{user}}/{{char}}；下面这些宏会原样进提示词：' +
            sp.unsupported_macros.map(m => '{{' + esc(m.macro) + '}}×' + m.count).join('、') + '</div>'
          : '')) +
      section('世界书',
        '<div>' + wb.entry_count + ' 条（常驻 ' + wb.constant_entries + '，激活方式 ' + esc(wb.book_activation) + '）· 逐字节重复 ' + wb.duplicate_groups.length + ' 组</div>' +
        (wb.format_bearers.length
          ? wb.format_bearers.slice(0, 12).map(b =>
            '<div style="padding:2px 0 2px 12px">🟡 条目' + b.index + '（' + esc(b.title || '无标题') + '）：' + esc(b.kinds.join('、')) +
            '<div style="opacity:.6;padding-left:16px">' + esc(b.preview) + '</div></div>').join('')
          : '') +
        (wb.duplicate_groups.length
          ? '<div style="opacity:.8">重复条目编号：' + wb.duplicate_groups.map(d => d.indices.join('/')).join('，') + '（适配时按去重提案处理，逐条确认）</div>'
          : '')) +
      section('下一步', '<div>点「一键适配」生成提案（消耗主 AI token）：开场白重排 + 去重 + 状态契约，逐条确认后才会落库，随时可回滚。</div>');
  }

  async function runInspect() {
    const id = window.AppState && window.AppState.editingCharacterId;
    if (!id) {
      tip('卡坊体检针对已保存的角色卡：先保存，再来体检');
      return;
    }
    await refreshProviderTip();
    ensureModal();
    adaptData = null;
    currentHash = '';
    appliedOnce = false;
    const adaptBtn = document.getElementById('cardStudioAdapt');
    adaptBtn.textContent = '一键适配（消耗主 AI）';
    adaptBtn.classList.remove('btn-success');
    adaptBtn.classList.add('btn-info');
    document.getElementById('cardStudioRollback').style.display = 'none';
    try {
      const r = await fetch(API + '/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: id })
      });
      const data = await r.json();
      if (!r.ok) { tip('体检失败：' + (data.error || r.status), 'error'); return; }
      open();
      renderReport(data.report, data.meta);
      // 已有适配记录 → 露出回滚入口
      try {
        const rep = await fetch(API + '/report/' + encodeURIComponent(id)).then(x => x.json());
        if (rep && rep.card_studio && !rep.card_studio.rolled_back_at) {
          document.getElementById('cardStudioRollback').style.display = '';
        }
      } catch (e) { /* 报告接口失败不阻塞体检 */ }
    } catch (e) {
      tip('体检请求失败：' + e.message, 'error');
    }
  }

  // ── S4：适配提案 → 真实渲染预览 → 逐项确认 ────────────────────────────────
  function previewHtml(text) {
    // §8-2：预览 = 线上同一个 renderAIBlock，空 formatted 走兜底分支（与新建对话完全一致）
    if (typeof renderAIBlock !== 'function') return '<pre style="white-space:pre-wrap">' + esc(text) + '</pre>';
    try {
      return renderAIBlock({}, text, '', false);
    } catch (e) {
      return '<div style="color:#e57373">渲染失败：' + esc(e.message) + '</div>';
    }
  }

  function checkRow(id, label, inner, checked, hint) {
    return '<label style="display:block;margin:6px 0;padding:6px 8px;border:1px solid rgba(128,128,128,.3);border-radius:6px">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '> <b>' + esc(label) + '</b>' +
      (hint ? '<span style="opacity:.65"> · ' + esc(hint) + '</span>' : '') +
      '<div style="margin-top:4px">' + inner + '</div></label>';
  }

  function renderProposals(data) {
    const p = data.proposals || {};
    const gr = p.greeting;
    const dd = p.dedupe || { drop: [], l3: [], rejected: [] };
    const ss = p.status_spec;
    const body = document.getElementById('cardStudioBody');
    const cost = '本次消耗：' + esc(data.provider.name) + ' · ' + esc(data.provider.model || '未填模型') +
      ' · LLM 调用 ' + data.meta.llm_calls + ' 次 · ' + data.meta.duration_ms + ' ms' +
      (data.meta.cached ? '（缓存命中，零消耗）' : '');

    let html = section('消耗与提案', '<div>' + cost + '</div>' +
      '<div style="opacity:.75">逐项确认：取消勾选即不应用该项；落库前可回滚提示保留快照。</div>');

    // 开场白重排：左右对照 = 同一个线上渲染器
    if (gr) {
      html += checkRow('csGreeting', '开场白重排（回环校验通过' + (gr.loopback.warnings && gr.loopback.warnings.length ? '，含 ' + gr.loopback.warnings.length + ' 条提醒' : '') + '）', '',
        true,
        '首行 ### · 对白『』· 选项 --N、 · 状态栏独占一行') +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '  <div style="flex:1;min-width:300px"><div style="font-weight:600;margin-bottom:4px">左：当前（线上兜底渲染）</div><div class="cs-preview" data-side="old">' + previewHtml(data.current_greeting || '') + '</div></div>' +
        '  <div style="flex:1;min-width:300px"><div style="font-weight:600;margin-bottom:4px;color:#4caf50">右：提案（同一渲染器跑）</div><div class="cs-preview" data-side="new">' + previewHtml(gr.proposed) + '</div></div>' +
        '</div>' +
        '<details style="margin-top:6px"><summary>文字对照（原文 / 提案）</summary>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<pre style="flex:1;min-width:280px;white-space:pre-wrap;max-height:240px;overflow:auto;opacity:.8">' + esc(data.current_greeting || '') + '</pre>' +
        '<pre style="flex:1;min-width:280px;white-space:pre-wrap;max-height:240px;overflow:auto">' + esc(gr.proposed) + '</pre>' +
        '</div></details>';
    } else {
      html += section('开场白', '<div style="color:#4caf50">' + esc(p.greeting_note || '开场白未做重排。') + '</div>');
    }

    // 状态契约
    if (ss) {
      const keysLine = ss.keys.map(k => esc(k.key) + '（' + esc(k.label || k.key) + '·' + esc(k.type) + (k.max ? '/' + k.max : '') + '）').join(' · ');
      html += checkRow('csStatus', '状态契约（' + ss.keys.length + ' 键，回环通过）',
        '<div style="opacity:.8">' + keysLine + '</div>' +
        '<details style="margin-top:4px"><summary>契约原文（拼进 system_prompt 末尾）</summary>' +
        '<pre style="white-space:pre-wrap;max-height:200px;overflow:auto">' + esc(ss.contract_text) + '</pre></details>',
        true, '引擎卡跳过（走 MVU 通路）');
    }

    // 去重（L1/L2 代码级，自动）
    if (dd.drop && dd.drop.length) {
      html += section('去重删除（逐字/近似重复，代码级判定）——每条可单独取消',
        dd.drop.map((d, i) =>
          '<label style="display:block;margin:4px 0;padding:4px 8px;border:1px solid rgba(128,128,128,.25);border-radius:6px">' +
          '<input type="checkbox" class="csDrop" data-i="' + i + '" checked> ' +
          '删 <b>' + esc(d.field) + '#' + d.para_index + '</b>（' + esc(d.level) + ' 重复，省 ' + (d.end - d.start) + ' 字）' +
          '<div style="opacity:.7;padding-left:20px">' + esc(String(d.text || '').slice(0, 100)) + '</div></label>').join('')) +
        '<div style="margin:4px 0"><button class="btn" id="csDropAll" style="padding:2px 10px">全部取消去重</button></div>';
    }
    if (dd.l3 && dd.l3.length) {
      html += section('语义重复删除（模型提案，服务端已复跑护栏）——每条可单独取消',
        dd.l3.map((d, i) =>
          '<label style="display:block;margin:4px 0;padding:4px 8px;border:1px solid rgba(128,128,128,.25);border-radius:6px">' +
          '<input type="checkbox" class="csL3" data-i="' + i + '" checked> ' +
          '删 <b>' + esc(d.field) + '#' + d.para_index + '</b> ≈ 保留 ' + esc(d.dup_of.field) + '#' + esc(d.dup_of.para_index) +
          '（' + esc(d.reason || '语义相同') + '）' +
          '<div style="opacity:.7;padding-left:20px">' + esc(String(d.text || '').slice(0, 100)) + '</div></label>').join(''));
    }
    if (dd.rejected && dd.rejected.length) {
      html += section('被护栏拦下的删除（不会应用）',
        dd.rejected.map(r => '<div style="opacity:.6;padding:2px 0">' + esc(r.field + '#' + r.para_index + '：' + r.reason) + '</div>').join(''));
    }
    // 世界书常驻化（S5）：内容零改动，只改 constant 开关
    if (p.worldbook && p.worldbook.toggles && p.worldbook.toggles.length) {
      html += section('世界书格式承载条目常驻化（内容零改动）——每条可单独取消',
        p.worldbook.toggles.map((t, i) =>
          '<label style="display:block;margin:4px 0;padding:4px 8px;border:1px solid rgba(128,128,128,.25);border-radius:6px">' +
          '<input type="checkbox" class="csBook" data-i="' + i + '" checked> ' +
          '常驻化 <b>条目' + t.index + '</b>（' + esc(t.title || '无标题') + '）：' + esc((t.kinds || []).join('、')) +
          '<div style="opacity:.65;padding-left:20px">' + esc(t.reason || '关键词触发不命中就整段失效') + '</div>' +
          '<div style="opacity:.55;padding-left:20px">' + esc(t.preview || '') + '</div></label>').join('')) +
        '<div style="opacity:.6">未勾选的条目零改动；条目内容任何情况下都不改。</div>';
    } else if (p.worldbook) {
      html += section('世界书', '<div style="color:#4caf50">✓ 格式承载条目均已常驻（或本卡无此类条目）</div>');
    }
    if (!(dd.drop && dd.drop.length) && !(dd.l3 && dd.l3.length)) {
      html += section('去重', '<div style="color:#4caf50">✓ 未发现重复段落</div>');
    }

    html += section('确认', '<div id="csApplyErr" style="color:#e57373"></div>');
    body.innerHTML = html;
    const dropAll = document.getElementById('csDropAll');
    if (dropAll) dropAll.addEventListener('click', () => {
      document.querySelectorAll('.csDrop').forEach(c => { c.checked = false; });
    });
    const applyBtn = document.getElementById('cardStudioAdapt');
    applyBtn.textContent = '应用选中项';
    applyBtn.classList.remove('btn-info');
    applyBtn.classList.add('btn-success');
  }

  async function runAdapt() {
    // apply 成功后按钮语义切换为「应用选中项」
    if (adaptData) return runApply();
    const id = window.AppState && window.AppState.editingCharacterId;
    if (!id) { tip('先保存角色卡，再适配'); return; }
    const btn = document.getElementById('cardStudioAdapt');
    btn.disabled = true;
    btn.textContent = '适配中…';
    try {
      const r = await fetch(API + '/adapt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: id })
      });
      const data = await r.json();
      if (!r.ok) {
        tip('适配失败：' + (data.error || r.status), 'error');
        return;
      }
      adaptData = data;
      currentHash = data.meta.source_hash;
      if (data.meta && data.meta.notice) tip(data.meta.notice);
      renderProposals(data);
    } catch (e) {
      tip('适配请求失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = adaptData ? '应用选中项' : '一键适配（消耗主 AI）';
    }
  }

  // ── 应用 / 回滚 / 回读刷新 ────────────────────────────────────────────────
  async function refreshEditingCard() {
    const id = window.AppState && window.AppState.editingCharacterId;
    if (!id) return null;
    try {
      const char = await fetch('/api/characters/' + encodeURIComponent(id)).then(r => r.json());
      // 回填表单：否则用户点「保存角色卡」会把适配前的旧字段写回去（§2.2 覆盖风险）
      const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v || ''; };
      set('charName', char.name);
      set('charDescription', char.description);
      set('charPersonality', char.personality);
      set('charScenario', char.scenario);
      set('charFirstMessage', char.first_message);
      set('charSystemPrompt', char.system_prompt);
      // 回读 metadata（与 app.js openCharacterModal 同一解析口径）
      try {
        window.AppState._cardMetadata = (typeof char.metadata === 'string') ? JSON.parse(char.metadata || '{}') : (char.metadata || null);
      } catch (e) { window.AppState._cardMetadata = null; }
      return char;
    } catch (e) { return null; }
  }

  async function runApply() {
    if (!adaptData) return;
    const id = window.AppState && window.AppState.editingCharacterId;
    const p = adaptData.proposals || {};
    const err = document.getElementById('csApplyErr');
    const sel = {};
    const gk = document.getElementById('csGreeting');
    if (gk && gk.checked && p.greeting) sel.greeting = p.greeting.proposed;
    const sk = document.getElementById('csStatus');
    if (sk && sk.checked && p.status_spec) {
      sel.status_contract = {
        keys: p.status_spec.keys, initial: p.status_spec.initial, contract_text: p.status_spec.contract_text
      };
    }
    const drops = [];
    document.querySelectorAll('.csDrop').forEach(c => {
      if (c.checked) drops.push((p.dedupe.drop || [])[Number(c.dataset.i)]);
    });
    if (drops.length) sel.dedupe = drops.filter(Boolean);
    const l3s = [];
    document.querySelectorAll('.csL3').forEach(c => {
      if (c.checked) l3s.push((p.dedupe.l3 || [])[Number(c.dataset.i)]);
    });
    if (l3s.length) sel.l3 = l3s.filter(Boolean);
    const books = [];
    document.querySelectorAll('.csBook').forEach(c => {
      if (c.checked) books.push(((p.worldbook || {}).toggles || [])[Number(c.dataset.i)]);
    });
    if (books.length) sel.book_toggles = books.filter(Boolean).map(t => ({ index: t.index }));
    sel.cost = { provider: adaptData.provider.name, model: adaptData.provider.model, turn: '一键修卡' };

    const btn = document.getElementById('cardStudioAdapt');
    btn.disabled = true;
    btn.textContent = '应用中…';
    try {
      const r = await fetch(API + '/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: id, expected_hash: currentHash, selections: sel })
      });
      const data = await r.json();
      if (err) err.textContent = '';
      if (r.status === 409) {
        if (err) err.textContent = '卡片在适配之后已有改动（' + esc(data.source_hash || '') + '）：请重新体检与适配。';
        tip('卡片已改动，请重新适配', 'warning');
        adaptData = null; currentHash = '';
        document.getElementById('cardStudioAdapt').textContent = '一键适配（消耗主 AI）';
        return;
      }
      if (!r.ok) {
        if (err) err.textContent = esc(data.error || ('HTTP ' + r.status));
        tip('应用失败，卡片未改动：' + (data.error || r.status), 'error');
        return;
      }
      await refreshEditingCard();  // 表单 + AppState._cardMetadata 回读（§8-8）
      appliedOnce = true;
      document.getElementById('cardStudioRollback').style.display = '';
      const body = document.getElementById('cardStudioBody');
      body.insertAdjacentHTML('afterbegin',
        '<div style="background:rgba(76,175,80,.15);border:1px solid #4caf50;border-radius:6px;padding:8px 12px;margin-bottom:8px">✅ ' +
        esc(data.message || '已应用') + '。编辑表单与卡片数据已同步刷新；「保存角色卡」不会丢适配记录。不满意可回滚。</div>');
      tip('已应用；可随时回滚', 'success');
    } catch (e) {
      if (err) err.textContent = esc(e.message);
      tip('应用请求失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '一键适配（消耗主 AI）';
      adaptData = null;
    }
  }

  async function runRollback() {
    const id = window.AppState && window.AppState.editingCharacterId;
    if (!id) return;
    if (!confirm('回滚到上次「应用」之前的状态？')) return;
    try {
      const r = await fetch(API + '/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: id })
      });
      const data = await r.json();
      if (!r.ok) { tip('回滚失败：' + (data.error || r.status), 'error'); return; }
      await refreshEditingCard();
      document.getElementById('cardStudioRollback').style.display = 'none';
      tip('已回滚到应用前状态', 'success');
      runInspect();  // 回滚后重新体检（旧报告不再可信）
    } catch (e) {
      tip('回滚请求失败：' + e.message, 'error');
    }
  }

  // ── 入口绑定 ──────────────────────────────────────────────────────────────
  function bind() {
    const btn = document.getElementById('btnCardStudio');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', runInspect);
    }
    refreshProviderTip();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 测试与后续阶段用
  window.CardStudio = {
    runInspect, runAdapt, runApply, runRollback, refreshEditingCard, close,
    get state() { return { currentHash, appliedOnce, adaptData }; }
  };
})();
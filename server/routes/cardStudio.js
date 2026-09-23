/**
 * cardStudio —— Card Studio（Layer S）：角色卡的体检 / 适配 / 应用。
 * 全新设计（设计文档 AI-GAL-CARDSTUDIO-DESIGN.md；旧 cardFixer 已于 S6 退役删除）。
 *
 * S1 已实现：GET /provider（修卡将使用的供应商）· POST /inspect（免费体检，零 LLM 调用）。
 * 后续阶段在此文件扩展：POST /adapt（P2 去重 + P3 状态契约 + P4 开场白重排，走主 AI 供应商）、
 * POST /apply / POST /rollback（现有 PUT 落库 + metadata 合并）、GET /report/:id。
 *
 * 设计约束（前提 0/1/4）：
 *   - 逐卡、用户主动；体检免费且零 LLM 请求（card-studio-inspect 有断言）；
 *   - 与运行时真源同语义的解析走 Layer F（server/utils/aigalFormat.js）；
 *   - 主 AI 供应商解析与 chat.js 的 resolveMainProvider 同一 SQL 语义（闭包内取不到，
 *     测试断言两者同解）；
 *   - 本文件注释与产出的文本一律正向表述（negative-phrasing-lint 有断言）。
 */
'use strict';
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const fmt = require('../utils/aigalFormat');
const { APP_KEYS } = require('../constants');
const { decrypt: decryptApiKey } = require('../crypto');

// 引擎卡的世界状态播种标记（conversations.js 建对话时扫描的原始文本标记）。
// 管道符用数组拼接表达，保持源码可读。
const PIPE_STATE_MARK = ['<', '|state', '|>'].join('');
const ENGINE_MARKERS = [
  '<json_patch', '<JSONPatch', '<UpdateVariables', '<UpdateVariable',
  '<variable_update_call_format', '<content>', '<now_plot>', '<pic>',
  PIPE_STATE_MARK
];

// 宏支持名单：运行时只替换这些（chat.js:3178-3183 / app.js:8317-8326），
// 其余 {{personality}} / {{scenario}} 等会原样进提示词 —— 体检时点名提示用户。
const SUPPORTED_MACROS = ['user', 'char', '用户', '角色'];

module.exports = (db) => {
  const router = express.Router();

  /**
   * 主 AI 供应商解析：显式 provider_id > 设置 main_ai_provider_id > 默认供应商。
   * 与 chat.js:3107-3116 resolveMainProvider 同一 SQL 语义（card-studio-inspect 断言同解）。
   */
  function resolveMainProvider(provider_id) {
    let pid = provider_id;
    if (!pid) {
      const ai = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_KEYS.MAIN_AI_PROVIDER_ID);
      if (ai && ai.value) pid = ai.value;
    }
    let provider = pid ? db.prepare('SELECT * FROM api_providers WHERE id = ?').get(pid) : null;
    if (!provider) provider = db.prepare('SELECT * FROM api_providers WHERE is_default = 1 LIMIT 1').get();
    return provider || null;
  }

  function providerSummary(p) {
    if (!p) return { provider: null, message: '尚未配置主 AI 供应商：在「AI 与供应商」里添加一个供应商，再回来体检' };
    return {
      provider: { id: p.id, name: p.name, model: p.model || '', is_default: !!p.is_default },
      message: ''
    };
  }

  router.get('/provider', (req, res) => {
    const p = resolveMainProvider(req.query.provider_id || req.body?.provider_id || null);
    res.json(providerSummary(p));
  });

  // ── 体检辅助 ──────────────────────────────────────────────────────────────

  function parseMetadata(row) {
    try { return row && row.metadata ? JSON.parse(row.metadata) : {}; } catch (e) { return {}; }
  }

  function parseBook(row) {
    try {
      const book = row && row.character_book ? JSON.parse(row.character_book) : null;
      const entries = book && Array.isArray(book.entries) ? book.entries
        : (book && book.entries && typeof book.entries === 'object' ? Object.values(book.entries) : []);
      return { name: (book && book.name) || '', entries };
    } catch (e) {
      return { name: '', entries: [] };
    }
  }

  // 格式承载条目分类（S5）：体检 / 适配提案 / apply 复核共用同一口径，防漂移
  function scanBookBearers(book) {
    const out = [];
    book.entries.forEach((e, i) => {
      const content = String(e.content || '');
      const kinds = [];
      if (fmt.isGameMarkupText(content)) kinds.push('引擎标记');
      const marks = scanEngineMarkers(content);
      if (marks.length) kinds.push('引擎变量规则');
      const tpl = fmt.parseTemplate(content);
      if (tpl.formatted.status && Object.keys(tpl.formatted.status).length) kinds.push('### status 段');
      if (tpl.formatted.actions && tpl.formatted.actions.length) kinds.push('### actions 段');
      if (/===\s*状态栏\s*===/.test(content)) kinds.push('状态栏标记');
      if (kinds.length) {
        out.push({
          index: i,
          title: String(e.comment || (e.keys && e.keys[0]) || ''),
          kinds,
          constant: e.constant === true || e.constant === 'true' || e.constant === 1,
          preview: content.slice(0, 60)
        });
      }
    });
    return out;
  }

  function collectMacros(...texts) {
    const found = new Map();
    const re = /\{\{\s*([\w-]+)\s*\}\}/g;
    for (const text of texts) {
      if (!text) continue;
      let m;
      const r = new RegExp(re.source, 'g');
      while ((m = r.exec(text)) !== null) {
        const key = m[1].toLowerCase();
        if (SUPPORTED_MACROS.includes(key)) continue;
        if (!found.has(key)) found.set(key, 0);
        found.set(key, found.get(key) + 1);
      }
    }
    return [...found.entries()].map(([macro, count]) => ({ macro, count }));
  }

  // 源哈希：卡片内容变更检测（apply 时写进 metadata.card_studio.source_hash；§8-5 幂等键）
  function hashCard(row) {
    // 陈旧检测的口径（§8-7）：覆盖**适配读到的一切输入**——六字段 + 世界书 + 引擎信号。
    // dedupe 提案按段落索引定位，改了 description/personality 也必须判陈旧；
    // metadata 里只取影响提案的引擎信号（hasMVU/mvu_meta），card_studio 自身写入不失效化哈希。
    let hasMVU = false;
    try { hasMVU = !!(parseMetadata(row).ui_hints || {}).hasMVU; } catch (e) { hasMVU = false; }
    return crypto.createHash('sha256').update(JSON.stringify({
      description: row.description || '',
      personality: row.personality || '',
      scenario: row.scenario || '',
      greeting: row.first_message || '',
      systemPrompt: row.system_prompt || '',
      character_book: row.character_book || '',
      book_activation: row.book_activation || '',
      markup_mode: row.markup_mode || '',
      engine: { hasMVU, mvuMeta: row.mvu_meta || '' }
    })).digest('hex');
  }

  // 引擎标记扫描：返回命中的标记与其所在位置
  function scanEngineMarkers(text) {
    const hits = [];
    if (!text) return hits;
    for (const mark of ENGINE_MARKERS) {
      if (text.includes(mark)) hits.push(mark);
    }
    return hits;
  }

  /**
   * POST /inspect —— 免费体检（零 LLM 调用）。
   * 报告结构与人工核对项一一对应（card-studio-inspect.js 断言 5 张真实卡）。
   */
  router.post('/inspect', (req, res) => {
    const t0 = Date.now();
    const { character_id } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!row) return res.status(404).json({ error: 'Character not found' });

    const greeting = row.first_message || '';
    const systemPrompt = row.system_prompt || '';
    const meta = parseMetadata(row);
    const book = parseBook(row);
    const bookContents = book.entries.map(e => String(e.content || ''));

    // 引擎卡识别：导入时 detectCardUI 的结论 + 原始文本标记
    const greetingMarkers = scanEngineMarkers(greeting);
    const promptMarkers = scanEngineMarkers(systemPrompt);
    const bookMarkers = [];
    bookContents.forEach((c, i) => { for (const m of scanEngineMarkers(c)) bookMarkers.push(`条目${i}:${m}`); });
    const isEngine = !!(
      (meta.ui_hints && meta.ui_hints.hasMVU) ||
      (row.mvu_meta && String(row.mvu_meta).trim()) ||
      greetingMarkers.length || promptMarkers.length || bookMarkers.length
    );

    // 开场白：按前端兜底渲染链解析（Layer F 客户端语义族）
    const parsed = fmt.parseGreeting(greeting, { userName: '我', charName: row.name });
    const inspection = fmt.validateGreeting(greeting, { mode: 'inspect', userName: '我', charName: row.name });
    const greetingIssues = [
      ...inspection.errors.map(e => ({ level: 'error', code: e.code, msg: e.msg, detail: e.detail || '' })),
      ...inspection.warnings.map(w => ({ level: 'warning', code: w.code, msg: w.msg, detail: w.detail || '' }))
    ];

    // system_prompt 的状态契约迹象（粗判：已有 ### status 段说明卡片自带格式约定）
    const hasStatusContract = /###\s*status/i.test(systemPrompt);

    // 世界书：条目规模 + 格式承载条目（S5 分类口径：scanBookBearers）+ L1 逐字节重复
    const constantEntries = book.entries.filter(e => e.constant).length;
    const formatBearers = scanBookBearers(book);
    const seenContent = new Map();
    const duplicateGroups = [];
    book.entries.forEach((e, i) => {
      const content = String(e.content || '');
      if (content.trim()) {
        const key = content.trim();
        if (seenContent.has(key)) {
          const g = duplicateGroups.find(g => g.key === key);
          if (g) g.indices.push(i); else duplicateGroups.push({ key, indices: [seenContent.get(key), i] });
        } else {
          seenContent.set(key, i);
        }
      }
    });

    const report = {
      spec_version: 1,
      character_id: row.id,
      name: row.name,
      source_hash: hashCard(row),
      engine: {
        is_engine: isEngine,
        signals: {
          ui_hints_hasMVU: !!(meta.ui_hints && meta.ui_hints.hasMVU),
          mvu_meta: !!(row.mvu_meta && String(row.mvu_meta).trim()),
          greeting_markers: greetingMarkers,
          system_prompt_markers: promptMarkers,
          book_markers: bookMarkers
        }
      },
      greeting: {
        classify: parsed.classify,
        first_line_eaten: parsed.firstLineEaten || '',
        dialog_count: parsed.dialog.length,
        dialog_names: [...new Set(parsed.dialog.map(d => d.name))],
        story_count: parsed.story.length,
        actions: parsed.actions,
        action_lines: parsed.actionLines,
        status_keys: Object.keys(parsed.status),
        inline_block_count: parsed.inlineBlocks.length,
        game_markup: !!parsed.gameMarkup,
        issues: greetingIssues
      },
      system_prompt: {
        length: systemPrompt.length,
        has_status_contract: hasStatusContract,
        unsupported_macros: collectMacros(systemPrompt, greeting, ...bookContents)
      },
      worldbook: {
        name: book.name,
        book_activation: row.book_activation || 'off',
        entry_count: book.entries.length,
        constant_entries: constantEntries,
        format_bearers: formatBearers,
        duplicate_groups: duplicateGroups.map(g => ({ size: g.key.length, count: g.indices.length, indices: g.indices, preview: g.key.slice(0, 60) }))
      },
      provider: providerSummary(resolveMainProvider(null)),
      cost_hint: {
        chars: greeting.length + systemPrompt.length + bookContents.reduce((a, c) => a + c.length, 0),
        note: '适配时按主 AI 供应商计费；体检始终免费'
      }
    };

    res.json({ report, meta: { duration_ms: Date.now() - t0, llm_calls: 0 } });
  });

  // ════ S2：适配（P2 去重 + P3 状态契约）═════════════════════════════════════
  // 设计文档 §3-③/§6/§4.3/§8：只返回提案（写库是 S3 的 apply）；
  // LLM 只做语义步骤（L3 语义重复 + 状态键标签/必需性），去重判定与状态键抽取是代码级。

  // ── 供应商调用基建（与 chat.js 同语义复刻，闭包内 require 不到 → 按行引用） ──
  function getProxySettings() { // 同 chat.js:237-248
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'proxy_config'").get();
      if (row && row.value) {
        const cfg = JSON.parse(row.value);
        if (cfg && cfg.enabled && cfg.host) return { enabled: true, host: cfg.host, port: cfg.port || 9567, auth: cfg.auth || '' };
      }
    } catch (e) { }
    return null;
  }

  function isLocalOpenAICompatible(baseUrl, providerType) { // 同 chat.js:4113-4118
    if (providerType === 'ollama') return true;
    if (!baseUrl) return false;
    return baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')
      || baseUrl.includes('0.0.0.0') || baseUrl.includes('192.168.') || baseUrl.includes('10.');
  }

  function buildProviderUrl(base_url, provider_type) { // 同 chat.js:4738-4776
    let url = String(base_url || '').replace(/\/+$/, '');
    if (provider_type === 'ollama') {
      if (url.includes('/api/chat') || url.includes('/v1/chat')) return url;
      if (url.includes('/v1')) return url + '/chat/completions';
      return url + '/api/chat';
    }
    if (provider_type === 'xai') {
      if (url.includes('/responses')) return url;
      return url + '/responses';
    }
    if (provider_type === 'gemini' || url.includes('generativelanguage.googleapis.com')) {
      if (!url.includes('/v1beta/openai')) url = url + '/v1beta/openai';
      if (url.includes('/chat/completions')) return url;
      return url + '/chat/completions';
    }
    if (url.includes('/chat/completions')) return url;
    return url + '/chat/completions';
  }

  function buildAuthHeaders(provider) { // 同 chat.js:4229-4258
    const headers = { 'Content-Type': 'application/json' };
    if (provider && provider.api_key) {
      const cleanKey = decryptApiKey(provider.api_key).replace(/[^\x00-\xFF]/g, '');
      if (cleanKey) headers['Authorization'] = `Bearer ${cleanKey}`;
    }
    const FORBIDDEN_HEADERS = new Set(['host', 'authorization', 'content-length', 'connection', 'content-type']);
    try {
      const parsedHeaders = JSON.parse((provider && provider.custom_headers) || 'null');
      if (parsedHeaders && typeof parsedHeaders === 'object') {
        for (const key of Object.keys(parsedHeaders)) {
          if (!FORBIDDEN_HEADERS.has(key.toLowerCase())) {
            headers[key] = String(parsedHeaders[key]).replace(/[^\x00-\xFF]/g, '');
          }
        }
      }
    } catch (e) { /* 自定义头留空即可 */ }
    return headers;
  }

  /**
   * 非流式调用（chat.js:4263-4453 的同语义复刻，请求体固定 messages 形态 ——
   * OpenAI 兼容网关为主 AI 常见形态）。与真源的差别只有一处（§8-6 失败可见）：
   * 捕获 finish_reason —— 'length' 即截断，上层据此按失败处理。
   */
  // ── 聊天预设合并（与 chat.js applyPresetToProvider 同语义）────────────────────
  // 2026-09-23 用户实测踩坑：主预设 max_tokens=32768（含 enabled_params）从未到达卡坊——
  // callMainAI 只读供应商行的 max_tokens=4096，思考模型把 4096 烧光 → 空内容+length → 502。
  // chat 主链路（chat.js:1306/1621 → applyPresetToProvider('main_ai_preset_id')）一直有这套合并。
  function coerceStringArrayP(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    const t = value.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch { /* fall through */ }
      return t.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return t.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  function coercePresetDataP(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch { return {}; }
  }
  function applyPresetToProvider(provider, presetSettingKey) {
    try {
      const presetSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(presetSettingKey);
      if (!presetSetting || !presetSetting.value) return provider;
      const preset = db.prepare("SELECT * FROM api_presets WHERE id = ? AND preset_type = 'chat'").get(presetSetting.value);
      if (!preset) return provider;
      const presetData = coercePresetDataP(preset.data);
      const enabledParams = new Set(coerceStringArrayP(preset.enabled_params));
      if (enabledParams.size === 0) return provider;
      const overrides = {};
      for (const key of enabledParams) {
        if (presetData[key] !== undefined) overrides[key] = presetData[key];
      }
      if (Object.keys(overrides).length === 0) return provider;
      console.log('[CardStudio] 应用主预设参数:', Object.keys(overrides).join(', '),
        '| max_tokens:', overrides.max_tokens ?? '(预设未启用该参数)');
      return { ...provider, ...overrides };
    } catch (e) {
      console.warn('[CardStudio] 预设合并失败（沿用供应商原值）:', e.message);
      return provider;
    }
  }

  function callMainAI(provider, messages, opts = {}) {
    return new Promise((resolve, reject) => {
      // 与 chat.js 同一套预算语义：先合并主预设（max_tokens 等可来自预设），再组请求体
      provider = applyPresetToProvider(provider, 'main_ai_preset_id');
      const { base_url, model, temperature, max_tokens, provider_type } = provider;
      const url = buildProviderUrl(base_url, provider_type);
      const headers = buildAuthHeaders(provider);
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const proxy = getProxySettings();
      const body = {
        model,
        messages,
        temperature: opts.temperature != null ? opts.temperature : (temperature || 0.2),
        max_tokens: max_tokens || 65536, // 同 chat.js:4280——思考模型的思维链算在输出预算里，兜底必须给足
        stream: false
      };
      const isLocalLLM = isLocalOpenAICompatible(base_url, provider_type);
      if (isLocalLLM && !max_tokens) delete body.max_tokens; // 同 chat.js:4286-4289（llama.cpp 65536 会过度预分配显存）
      const thinkingOff = (provider.thinking === false || provider.thinking === 0) || opts.forceThinkingOff === true;
      if (thinkingOff && isLocalLLM && provider_type !== 'xai') {
        body.chat_template_kwargs = { enable_thinking: false };
      }
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        protocol: isHttps ? 'https:' : 'http:'
      };
      const payload = JSON.stringify(body);
      let req;

      function handleResponse(res) {
        let data = '';
        const decoder = new StringDecoder('utf8');
        res.on('data', c => { data += decoder.write(c); });
        res.on('end', () => {
          data += decoder.end();
          try {
            const json = JSON.parse(data);
            const choice = json.choices && json.choices[0];
            const text = (choice && choice.message && choice.message.content) || '';
            const finishReason = (choice && choice.finish_reason) || '';
            if (!String(text).trim()) {
              return reject(new Error('供应商返回空内容（finish_reason=' + finishReason + '）'));
            }
            resolve({ text: String(text), finish_reason: finishReason });
          } catch (e) {
            reject(new Error('供应商响应解析失败：' + data.slice(0, 160)));
          }
        });
        res.on('error', reject);
      }

      if (proxy && isHttps) { // CONNECT 隧道，同 chat.js:4331-4356
        const connectOpts = {
          hostname: proxy.host, port: proxy.port, method: 'CONNECT',
          path: `${reqOptions.hostname}:${reqOptions.port}`,
          headers: { 'Host': `${reqOptions.hostname}:${reqOptions.port}` }
        };
        if (proxy.auth) connectOpts.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
        const proxyReq = http.request(connectOpts);
        proxyReq.on('connect', (cres, socket) => {
          if (cres.statusCode !== 200) { reject(new Error(`Proxy CONNECT failed: ${cres.statusCode}`)); return; }
          const hreq = https.request({ ...reqOptions, socket, agent: false }, hres => handleResponse(hres));
          hreq.on('error', reject);
          hreq.setTimeout(120000, () => { hreq.destroy(); reject(new Error('Request timeout')); });
          hreq.write(payload);
          hreq.end();
        });
        proxyReq.on('error', reject);
        proxyReq.setTimeout(15000, () => { proxyReq.destroy(); reject(new Error('Proxy connect timeout')); });
        proxyReq.end();
        return;
      }
      if (proxy) { // 明文 HTTP 走代理，同 chat.js:4357-4368
        req = http.request({
          hostname: proxy.host, port: proxy.port, method: 'POST',
          path: `${reqOptions.protocol}//${reqOptions.hostname}${reqOptions.path}`,
          headers: { ...reqOptions.headers, 'Host': reqOptions.hostname }
        }, res => handleResponse(res));
      } else if (isLocalLLM) { // 本地引擎：短连接，同 chat.js:4369-4380
        req = client.request({
          ...reqOptions, agent: false,
          headers: { ...reqOptions.headers, 'Connection': 'close' }
        }, res => handleResponse(res));
      } else {
        req = client.request(reqOptions, res => handleResponse(res));
      }
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // §7 同款护栏（2026-09-23 用户实测踩坑）：本地引擎开着思考时，思维链可能把整个输出预算
  // 烧光（content 空 + finish_reason=length）—— 卡坊的开场白重排恰恰需要整段长输出。
  // 首发命中该形态 → 自动带 enable_thinking:false 重试一次（llama.cpp/Ollama 认这个开关；
  // 实测本机 Qwen-35B：16 token 探针 thinking 开时空内容+length，关思考后正常出字）。
  // 远程供应商不塞未知参数；供应商本来就关着思考时不重试（同一请求没有意义）。
  async function callMainAIRetry(provider, messages, opts = {}) {
    let resp;
    provider = applyPresetToProvider(provider, 'main_ai_preset_id'); // 报错文案要显示有效预算
    try {
      resp = await callMainAI(provider, messages, opts);
    } catch (err) {
      const msg = String((err && err.message) || err);
      const isLocalLLM = isLocalOpenAICompatible(provider.base_url, provider.provider_type);
      const offBySetting = (provider.thinking === false || provider.thinking === 0);
      const budgetEaten = msg.includes('供应商返回空内容') && msg.includes('finish_reason=length');
      if (!budgetEaten || !isLocalLLM || offBySetting || provider.provider_type === 'xai' || opts.retried) throw err;
      console.warn('[CardStudio] 输出预算被思维链吃光（空内容+length），本地引擎自动关思考重试一次');
      try {
        resp = await callMainAI(provider, messages, { ...opts, forceThinkingOff: true, retried: true });
      } catch (err2) {
        const msg2 = String((err2 && err2.message) || err2);
        throw new Error('本地引擎关思考重试后仍失败（' + msg2 + '）：请调大该供应商的「最大输出长度」（当前 '
          + (provider.max_tokens || '未设置') + '）后再试，或换一个供应商做卡坊适配。');
      }
      resp.notice = '本地引擎的思考把输出预算耗尽，已自动关闭思考模式重试成功。要根除：调大该供应商的「最大输出长度」，或取消勾选其「启用思考模式」。';
    }
    return resp;
  }

  // ── P2 去重（设计 §6：L1/L2 代码级自动，L3 走 LLM 只提案，世界书只报告） ──
  const DEDUPE_FIELDS = ['description', 'personality', 'scenario', 'system_prompt'];

  function normalizeForCompare(text) { // 规范化：全半角统一 + 去空白/标点/符号（§6.1）
    return String(text || '')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');
  }
  function digitMultiset(t) { return (String(t).match(/\d+(?:\.\d+)?/g) || []).slice().sort().join(','); }
  function quotedTokens(t) { return (String(t).match(/[「『《【][^」』》】]{1,20}[」』》】]/g) || []).slice().sort().join('|'); }
  function bigrams(t) {
    const s = normalizeForCompare(t);
    const out = new Set();
    for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
    return out;
  }
  function jaccard(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
  }

  function paraUnits(field, text) { // 空行分段 + 字符偏移（证据指针 §6.2）
    const str = String(text || '');
    const out = [];
    const re = /\n[ \t]*\n+/g;
    let start = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (start < m.index && str.slice(start, m.index).trim()) {
        out.push({ field, start, end: m.index, text: str.slice(start, m.index) });
      }
      start = m.index + m[0].length;
    }
    if (start < str.length && str.slice(start).trim()) {
      out.push({ field, start, end: str.length, text: str.slice(start) });
    }
    const counter = {};
    out.forEach(u => { counter[u.field] = (counter[u.field] || 0) + 1; u.para_index = counter[u.field] - 1; });
    return out;
  }

  function dedupeScan(row) {
    const units = [];
    for (const f of DEDUPE_FIELDS) units.push(...paraUnits(f, row[f]));
    const usable = units.filter(u => normalizeForCompare(u.text).length >= 20);
    const dropped = new Set();
    const drop = [];
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i], b = usable[j];
        if (a.field === b.field && a.para_index === b.para_index) continue;
        if (digitMultiset(a.text) !== digitMultiset(b.text)) continue;   // 数值有差异 → 双方都保留（§6.2）
        if (quotedTokens(a.text) !== quotedTokens(b.text)) continue;     // 专名/引号内容有差异 → 双方都保留
        const na = normalizeForCompare(a.text), nb = normalizeForCompare(b.text);
        let level = null;
        if (na === nb) level = 'L1';
        else if (na.length >= 30 && nb.length >= 30 && jaccard(a.text, b.text) >= 0.85) level = 'L2';
        if (!level) continue;
        const victim = (a.text.trim().length >= b.text.trim().length) ? b : a; // 删短留长（§6.1）
        const keeper = (victim === b) ? a : b;
        if (dropped.has(victim)) continue;
        dropped.add(victim);
        drop.push({
          field: victim.field, para_index: victim.para_index, start: victim.start, end: victim.end,
          level, auto: true,
          dup_of: { field: keeper.field, para_index: keeper.para_index },
          evidence: { drop_preview: victim.text.trim().slice(0, 60), keep_preview: keeper.text.trim().slice(0, 60) }
        });
      }
    }
    // 世界书：只报告（§6.1 作用域：世界书↔设定 只报告）
    const book = parseBook(row);
    const worldbookFindings = [];
    for (let i = 0; i < book.entries.length; i++) {
      for (let j = i + 1; j < book.entries.length; j++) {
        const a = String(book.entries[i].content || ''), b = String(book.entries[j].content || '');
        if (normalizeForCompare(a).length < 20 || normalizeForCompare(b).length < 20) continue;
        if (normalizeForCompare(a) === normalizeForCompare(b)) {
          worldbookFindings.push({ entry_index: i, dup_of_entry: j, level: 'L1', report_only: true, preview: a.trim().slice(0, 60) });
        }
      }
    }
    // 长度哨兵：逐字段 |new| ≥ 0.5×|old|，违反则该字段的全部删除提案整组保留原样（§6.2）
    const lengthSentinel = {};
    for (const f of DEDUPE_FIELDS) {
      const oldLen = String(row[f] || '').length;
      const fieldDrops = drop.filter(d => d.field === f);
      if (!oldLen || !fieldDrops.length) continue;
      const newLen = oldLen - fieldDrops.reduce((s, d) => s + (d.end - d.start), 0);
      const ok = newLen >= 0.5 * oldLen;
      lengthSentinel[f] = { old: oldLen, new: newLen, ok };
      if (!ok) fieldDrops.forEach(d => { d.rejected = '长度哨兵：删除后不足原文一半，疑似丢失内容，本字段保留原样'; });
    }
    const accepted = drop.filter(d => !d.rejected);
    const rejected = drop.filter(d => d.rejected);
    return {
      drop: accepted,
      rejected,
      l3: [], // LLM 步骤填充（只提案、默认未勾选）
      worldbook_findings: worldbookFindings,
      saved_chars: accepted.reduce((s, d) => s + (d.end - d.start), 0),
      length_sentinel: lengthSentinel
    };
  }

  // ── P3 状态键抽取（代码优先，§4.3；LLM 只补 label 与 required） ──
  function statusKeyOk(k) { // §4.1：短中文/字母数字、≤8 字、数字键除外
    return /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]{0,7}$/.test(k) && !/^(姓名|name)$/i.test(k);
  }
  function valueShape(v) { // §4.3-2：x/y→gauge，x%→percent，短词→enum，其余 text
    const s = String(v || '').trim();
    const m = s.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
    if (m) return { type: 'gauge', max: Number(m[2]) || 100 };
    if (/^[\d.]+%$/.test(s)) return { type: 'percent' };
    if (s.length <= 6 && s.length > 0 && !/\d/.test(s)) return { type: 'enum' };
    return { type: 'text' };
  }
  const GLOBAL_STATUS_KEYS = /^(HP|MP|SP|EXP|SAN|体力|生命值|生命|魔力|灵力|气力|金钱|金币|好感度|信任度|心情|情绪|境界|等级|经验)$/i;

  function extractStatusCandidates(row, book) {
    const constantContents = book.entries.filter(e => e.constant).map(e => String(e.content || ''));
    const src = [row.system_prompt || '', row.description || '', row.first_message || '', ...constantContents].join('\n');
    const lines = src.split('\n');
    const found = new Map();
    const eatKV = (k, v) => {
      k = String(k || '').trim(); v = String(v || '').trim();
      if (!statusKeyOk(k) || !v || v.length > 40) return;
      const shape = valueShape(v);
      const prev = found.get(k);
      if (!prev || (shape.type === 'gauge' && prev.type !== 'gauge')) {
        found.set(k, { key: k, initial: v, ...shape });
      }
    };
    // a) <variable_list> 块（MVU 卡变量声明，§4.4：跳过 MVU 本体但采集键名）
    const vlRe = /<variable_list>([\s\S]*?)<\/variable_list>/gi;
    let vm;
    while ((vm = vlRe.exec(src)) !== null) {
      for (const line of vm[1].split('\n')) {
        const m = line.match(/^\s*[-*]?\s*([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff]{0,7})\s*[：:]\s*(\S.{0,39})$/);
        if (m) eatKV(m[1], m[2]);
      }
    }
    // b) 「状态栏/状态」章节内的 键：值 行（§4.3-1：章节定向，控制误采集）。
    //    窗口按**单个来源文本**截断——跨字段的 15 行窗口会把隔壁字段的
    //    `姓名：『对白』` 行当成状态键吃进来（实测：开场白的对白行混进键清单）
    const srcs = [row.system_prompt || '', row.description || '', row.first_message || '', ...constantContents];
    for (const one of srcs) {
      const sl = String(one).split('\n');
      for (let i = 0; i < sl.length; i++) {
        if (!/状态栏|状态输出|初始状态|角色状态|变量列表/i.test(sl[i])) continue;
        for (let j = i + 1; j < Math.min(i + 16, sl.length); j++) {
          const m = sl[j].match(/^\s*[-*]?\s*([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff]{0,7})\s*[：:]\s*(\S.{0,39})$/);
          if (m) eatKV(m[1], m[2]);
        }
      }
    }
    // c) 全局只认常见状态 token（HP/MP/体力…，§4.3-1）
    for (const line of lines) {
      const m = line.match(/^\s*[-*]?\s*([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff]{0,7})\s*[：:]\s*(\S.{0,39})$/);
      if (m && GLOBAL_STATUS_KEYS.test(m[1].trim())) eatKV(m[1], m[2]);
    }
    // d) 两列 Markdown 表格行 | 键 | 值 |
    for (const line of lines) {
      const m = line.match(/^\s*\|\s*([^|]{1,8}?)\s*\|\s*([^|]{1,20}?)\s*\|\s*$/);
      if (m && !/^[-:\s]+$/.test(m[1])) eatKV(m[1], m[2]);
    }
    return [...found.values()];
  }

  // ── LLM 语义步骤（L3 提案 + 状态键 label/required） ──
  function buildAdaptMessages(candidates, units) {
    const keysLine = candidates.map(c => c.key + '：' + c.initial + '（' + c.type + '）').join('；');
    const paras = units.slice(0, 30).map(u => '【' + u.field + '#' + u.para_index + '】' + u.text.trim().slice(0, 120)).join('\n');
    const sys = '你是角色卡的格式助手，负责两件事：'
      + '一、为候选状态键补中文标签（最多 4 个汉字）并判断它是否属于每轮都要跟踪的状态（required 为 true 或 false）；'
      + '二、在设定段落里找出同一设定的重复表述（语义相同、说法不同），给出配对建议。'
      + '只输出一个 JSON 对象，格式：'
      + '{"keys":[{"key":"键","label":"标签","required":true}],"l3_pairs":[{"drop_field":"字段名","drop_para":0,"keep_field":"字段名","keep_para":0,"reason":"一句话理由"}]}。'
      + 'l3_pairs 只列出确实重复的配对，没有重复就给空数组；配对只在不同段落之间成立。';
    const user = '候选状态键：' + (keysLine || '（本卡暂无候选键，keys 给空数组）')
      + '\n\n设定段落：\n' + (paras || '（无）')
      + '\n\n请输出 JSON。';
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  function parseLlmJson(text) { // 平衡括号截取 + 围栏剥离（§8-6：解析失败按失败处理）
    const s = String(text || '').replace(/```(?:json)?/g, '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  // ── 状态契约回环（§8-6：emit → parseTemplate 反解析 → 键/值断言） ──
  function loopbackStatusSpec(keys, initial) {
    const issues = [];
    if (!keys.length) return { ok: true, issues, parsed_status: {} };
    const lines = ['### status'];
    for (const k of keys) {
      lines.push(k.key + '：' + (initial[k.key] || (k.type === 'gauge' ? '80/100' : '当前值')));
    }
    const parsed = fmt.parseTemplate(lines.join('\n')).formatted.status || {};
    for (const k of keys) {
      if (!(k.key in parsed)) issues.push('键「' + k.key + '」经 ### status 反解析后丢失');
      else if (k.type === 'gauge' && !/\//.test(String(parsed[k.key]))) {
        issues.push('键「' + k.key + '」的 gauge 值反解析后失去 x/y 形态');
      }
    }
    return { ok: issues.length === 0, issues, parsed_status: parsed };
  }

  // 幂等缓存（§8-5）：同卡同源哈希同供应商 → 同一份提案（进程内）
  const adaptCache = new Map();

  /**
   * POST /adapt —— LLM 适配，只返回提案（写库在 S3 的 apply）。
   * 失败可见（§8-6）：截断 / 坏 JSON / 回环不过 → 明示原因，无半成品。
   */
  router.post('/adapt', async (req, res) => {
    const t0 = Date.now();
    const { character_id, provider_id } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!row) return res.status(404).json({ error: 'Character not found' });

    const provider = resolveMainProvider(provider_id || null);
    if (!provider) {
      // §10-S2：未配置供应商 → 明确报错且本次不发出任何请求
      return res.status(400).json({
        error: '体检免费；适配需要主 AI 供应商 —— 先到「AI 与供应商」里配置一个供应商，再回来适配。本次没有发出任何请求。'
      });
    }

    const sourceHash = hashCard(row);
    const cacheKey = row.id + '|' + sourceHash + '|' + (provider_id || provider.id);
    const cached = adaptCache.get(cacheKey);
    if (cached) {
      const copy = JSON.parse(JSON.stringify(cached));
      copy.meta.cached = true;
      return res.json(copy);
    }

    const book = parseBook(row);

    // P2：代码级去重扫描（L1/L2 自动提案 + 世界书只报告 + 长度哨兵）
    const dedupe = dedupeScan(row);

    // P3：代码级状态键抽取
    const candidates = extractStatusCandidates(row, book);

    // LLM 步骤：有状态候选或存在可比对段落才调用（成本纪律：无候选 → 零请求）
    const compareUnits = [];
    for (const f of DEDUPE_FIELDS) compareUnits.push(...paraUnits(f, row[f]));
    const usableUnits = compareUnits.filter(u => normalizeForCompare(u.text).length >= 20);
    let llm = { keys: [], l3_pairs: [] };
    let llmCalls = 0;
    let llmNotice = '';
    if (candidates.length > 0 || usableUnits.length >= 2) {
      llmCalls = 1;
      let resp;
      try {
        resp = await callMainAIRetry(provider, buildAdaptMessages(candidates, usableUnits));
      } catch (e) {
        return res.status(502).json({
          error: '适配请求失败：' + e.message + '。本次按失败处理，卡片原样未动。',
          provider: { name: provider.name, model: provider.model }
        });
      }
      if (resp.notice) llmNotice = resp.notice;
      if (resp.finish_reason === 'length') {
        return res.status(502).json({
          error: '模型输出被截断（finish_reason=length）：请调大该供应商的「最大输出长度」或关闭其「思考模式」后重试。本次按失败处理，没有生成半成品。',
          provider: { name: provider.name, model: provider.model }
        });
      }
      const parsed = parseLlmJson(resp.text);
      if (!parsed) {
        return res.status(502).json({
          error: '适配响应解析失败：模型输出的不是合法 JSON。本次按失败处理，没有生成半成品。',
          provider: { name: provider.name, model: provider.model }
        });
      }
      llm = parsed;
    }

    // P3 成品：候选键 × LLM 标签/必需性（LLM 的新键需要先通过候选校验，防止幻觉键）
    const specKeys = candidates.map(c => {
      const m = Array.isArray(llm.keys) ? llm.keys.find(x => x && x.key === c.key) : null;
      const label = (m && typeof m.label === 'string' && m.label.trim())
        ? sanitizeGreetingText(m.label).slice(0, 8) || c.key // 剥 # 标题前缀等（LLM 输出不可信）
        : c.key;
      return { key: c.key, label, type: c.type, max: c.max, required: m ? m.required !== false : true };
    });
    const initial = {};
    candidates.forEach(c => { initial[c.key] = c.initial; });

    // L3：语义重复只提案（§6.1：needsReview、默认未勾选）
    const l3 = (Array.isArray(llm.l3_pairs) ? llm.l3_pairs : [])
      .filter(p => p && DEDUPE_FIELDS.includes(p.drop_field) && DEDUPE_FIELDS.includes(p.keep_field))
      .filter(p => Number.isInteger(Number(p.drop_para)) && Number.isInteger(Number(p.keep_para)))
      .map(p => ({
        field: p.drop_field, para_index: Number(p.drop_para),
        dup_of: { field: p.keep_field, para_index: Number(p.keep_para) },
        level: 'L3', auto: false, needs_review: true,
        reason: String(p.reason || '语义重复，待确认').slice(0, 80)
      }))
      .slice(0, 20);
    dedupe.l3 = l3;

    // 状态契约回环（§8-6）
    let statusSpec = null;
    if (specKeys.length) {
      const loop = loopbackStatusSpec(specKeys, initial);
      if (!loop.ok) {
        return res.status(422).json({
          error: '状态契约回环校验未通过：' + loop.issues.join('；') + '。本次按失败处理，卡片原样未动。',
          loopback: loop,
          provider: { name: provider.name, model: provider.model }
        });
      }
      statusSpec = {
        channel: 'character.system_prompt',
        emit: 'full',
        keys: specKeys,
        initial,
        contract_text: fmt.emitStatusContract({ keys: specKeys }),
        loopback: { ok: true, parsed_status: loop.parsed_status }
      };
    }

    // P4：开场白重排（§5；strict 校验有错或 force_greeting 时才发生 LLM 调用 —— 成本纪律）
    const rawGreeting = row.first_message || '';
    const expectedBlocks = extractVariableBlocks(rawGreeting);
    const preCheck = fmt.validateGreeting(rawGreeting, { mode: 'emit', userName: '我', charName: row.name, variableBlocks: expectedBlocks });
    const wantGreeting = rawGreeting.trim().length > 0
      && ((req.body && req.body.force_greeting) || preCheck.errors.length > 0);
    let greetingProposal = null;
    let greetingNote = wantGreeting ? '' : (rawGreeting.trim().length === 0 ? '开场白为空，跳过重排（本次零消耗）。' : '开场白已通过回环校验，未做重排（本次零消耗）。');
    if (wantGreeting) {
      let issuesText = greetingIssuesText(preCheck.errors);
      let lastLoop = null;
      for (let attempt = 1; attempt <= 2 && !greetingProposal; attempt++) {
        llmCalls++;
        let resp;
        try {
          resp = await callMainAIRetry(provider, buildGreetingMessages(row, rawGreeting, issuesText));
        } catch (e) {
          return res.status(502).json({
            error: '开场白重排请求失败：' + e.message + '。本次按失败处理，卡片原样未动。',
            provider: { name: provider.name, model: provider.model }
          });
        }
        if (resp.notice) llmNotice = resp.notice;
        if (resp.finish_reason === 'length') {
          return res.status(502).json({
            error: '开场白重排的模型输出被截断（finish_reason=length）：请调大「最大输出长度」或关闭「思考模式」后重试。本次按失败处理，没有生成半成品。',
            provider: { name: provider.name, model: provider.model }
          });
        }
        const g = parseLlmJson(resp.text);
        if (!g || !Array.isArray(g.story_lines) || !g.story_lines.length) {
          return res.status(502).json({
            error: '开场白重排响应解析失败：模型输出的不是合法 JSON。本次按失败处理，没有生成半成品。',
            provider: { name: provider.name, model: provider.model }
          });
        }
        // 组装：模板定死结构；状态通道/引擎变量块由代码逐字节直传（V1 的期望就是 expectedBlocks 本身）
        const assembled = assembleGreeting(g, preCheck.parsed.status, expectedBlocks);
        const loop = fmt.validateGreeting(assembled, { mode: 'emit', userName: '我', charName: row.name, variableBlocks: expectedBlocks });
        if (loop.ok) {
          greetingProposal = { proposed: assembled, loopback: { ok: true, warnings: loop.warnings }, llm_attempts: attempt };
        } else {
          lastLoop = loop;
          issuesText = greetingIssuesText(loop.errors); // 带着回环错误重试一次（消耗可见：llm_calls 会 +1）
        }
      }
      if (!greetingProposal) {
        return res.status(422).json({
          error: '开场白回环校验未通过（重试后仍未通过）：' + greetingIssuesText(lastLoop.errors) + '。本次按失败处理，卡片原样未动。',
          loopback: lastLoop,
          provider: { name: provider.name, model: provider.model }
        });
      }
    }

    // P5：世界书格式承载条目的常驻化提案（§7：内容一个字都不改，只翻 constant 开关；零 LLM）
    const bookToggles = scanBookBearers(book)
      .filter(b => !b.constant)
      .map(b => ({
        index: b.index, title: b.title, kinds: b.kinds, preview: b.preview,
        current_constant: false, proposed_constant: true,
        reason: '关键词触发不命中就整段失效；确认后改为常驻（每轮进 system_prompt），内容零改动'
      }));

    const body = {
      proposals: { dedupe, status_spec: statusSpec, greeting: greetingProposal, greeting_note: greetingNote, worldbook: { toggles: bookToggles, note: '只做常驻化开关；未勾选的条目零改动，条目内容任何情况下都不改。' } },
      current_greeting: row.first_message || '',
      provider: { id: provider.id, name: provider.name, model: provider.model },
      meta: { llm_calls: llmCalls, duration_ms: Date.now() - t0, source_hash: sourceHash, cached: false, notice: llmNotice || undefined }
    };
    adaptCache.set(cacheKey, body);
    res.json(body);
  });

  // ════ S3：P4 开场白重排 + apply / rollback / report ════════════════════════

  // ### status 载体段原文提取（V1 期望块的来源；段定位照 stripMetaSections 语义，逐行保留原文）
  function extractVariableBlocks(rawText) {
    const lines = String(rawText || '').split('\n');
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      const t = line.trim();
      if (cur === null && /^###\s*status\s*$/i.test(t)) { cur = []; continue; }
      if (cur !== null && /^###\s+\S/.test(t)) { if (cur.length) blocks.push(cur.join('\n')); cur = null; continue; }
      if (cur !== null) cur.push(line);
    }
    if (cur && cur.length) blocks.push(cur.join('\n'));
    return blocks.map(b => b.trim()).filter(Boolean);
  }

  function buildGreetingMessages(row, rawGreeting, issuesText) {
    const sys = '你是角色卡开场白的排版师，把开场白改写成规范形态，情节与专有名词保持原样。'
      + '只输出一个 JSON 对象：'
      + '{"mood":"氛围词","story_lines":["旁白句或 姓名：『对白』 行"],"roster":["在场角色名"],"actions":["行动选项文字"]}。'
      + '要求：story_lines 按原文顺序展开情节；对白行写作「姓名：『对白』」，语气描写放进旁白句；'
      // 2026-09-23 用户实测两类翻车：①模型把原卡首行的 ### 标题逐字抄进 story_lines
      //（渲染器会把 ### 行当标题删掉 → 正文丢失）；②把闭引号 』 写成开引号 『（『别看，跑。『）。
      // 下面两条硬规则就是为这两个行为立的（正向表述，过 negative-phrasing-lint）。
      + '所有字段的每一行都写成纯正文，每行直接以正文文字开头：'
      + '原文若把某行写成了 `### 标题`，去掉 # 前缀只保留那行文字本身，一个 # 都不留；'
      + '引号必须成对：对白的开引号『与闭引号』配对闭合，闭引号一律写成』，「」同理一律写成配对的「」；'
      + 'roster 是开场白里在场或登场的角色名（没有就给空数组）；'
      + 'actions 给 2-4 个贴合当前情境的行动选项，每条 6 字以上；'
      + 'mood 从 relaxed / tense / romantic / suspense / hopeful 里挑最贴近的一个。';
    const user = '角色名：' + row.name
      + '\n\n当前开场白：\n' + rawGreeting
      + '\n\n当前体检问题：\n' + (issuesText || '（重新排一版）')
      + '\n\n请输出 JSON。';
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // LLM 输出净化（2026-09-23 用户实测两类翻车的代码级兜底——提示词只能劝，这里必须拦）：
  // ① 模型把原卡的 ### 标题行逐字抄进 story_lines → 渲染器把 ### 行当标题删掉 → 正文静默丢失；
  // ② 闭引号写成开引号（『别看，跑。『）→ 行尾的『必是翻错的闭引号，行首的』必是翻错的开引号。
  function sanitizeGreetingText(s) {
    let t = String(s || '').trim();
    if (!t) return '';
    t = t.replace(/^#{1,6}\s*/, ''); // 标题前缀一律剥掉（正文里本来就不允许出现标题行）
    t = t.replace(/『$/, '』');       // 行尾开引号 → 闭引号
    t = t.replace(/^』/, '『');       // 行首闭引号 → 开引号（对称翻转）
    t = t.replace(/「$/, '」');
    t = t.replace(/^」/, '「');
    return t;
  }

  // P4 组装：LLM 只出语义件（氛围/正文行/名册/选项），结构由 emitGreeting 模板定死；
  // 正文内状态通道（=== 状态栏 ===）与引擎变量块（### status 载体）由代码逐字节直传。
  // 状态通道净化：原文标记同行时首键会被啃出 `=` 前缀（G5 的成因）——剥前缀再过键校验。
  function assembleGreeting(llmJson, parsedStatus, variableBlocks) {
    const g = llmJson || {};
    const cleanStatus = {};
    for (const [k, v] of Object.entries(parsedStatus || {})) {
      const kk = String(k).replace(/^[=\s]+/, '').trim();
      if (kk && statusKeyOk(kk)) cleanStatus[kk] = v;
    }
    return fmt.emitGreeting({
      mood: sanitizeGreetingText(typeof g.mood === 'string' && g.mood.trim() ? g.mood : 'relaxed') || 'relaxed',
      story: (Array.isArray(g.story_lines) ? g.story_lines : []).map(s => sanitizeGreetingText(s)).filter(Boolean).join('\n'),
      roster: Array.isArray(g.roster) ? g.roster.map(s => sanitizeGreetingText(s)).filter(Boolean) : [],
      actions: (Array.isArray(g.actions) ? g.actions : []).map(s => sanitizeGreetingText(s)).filter(a => a.length > 5).slice(0, 4),
      status: cleanStatus,
      variableBlocks
    });
  }

  function greetingIssuesText(errors) {
    return errors.map(e => e.code + '：' + e.msg + (e.detail ? '（' + String(e.detail).slice(0, 60) + '）' : '')).join('；');
  }

  // self 调用：落库走**现有** PUT（设计 §7）——监听端口会自动漂移（index.js listenOn +1），
  // 因此 origin 取本次请求的 Host 头（客户端实际连到的端口总是可达）。
  function selfJson(origin, method, p, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload || {});
      const parsed = new URL(origin + p);
      const req = http.request({
        hostname: '127.0.0.1',
        port: parsed.port || 80,
        path: parsed.pathname,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Host': parsed.host }
      }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(buf || '{}'); } catch (e) { body = { raw: buf.slice(0, 200) }; }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('self request timeout')); });
      req.write(data);
      req.end();
    });
  }

  function currentOrigin(req) {
    return 'http://' + (req.headers.host || ('127.0.0.1:' + (process.env.PORT || 3000)));
  }

  // 卡片引擎性判定（apply 写 ui_hints 用；同 inspect 的信号口径）
  function isEngineCard(row, meta) {
    if (meta.ui_hints && meta.ui_hints.hasMVU) return true;
    if (row.mvu_meta && String(row.mvu_meta).trim()) return true;
    if (scanEngineMarkers(row.first_message || '').length) return true;
    if (scanEngineMarkers(row.system_prompt || '').length) return true;
    return parseBook(row).entries.some(e => scanEngineMarkers(String(e.content || '')).length > 0);
  }

  /**
   * POST /apply —— 显式落库（设计 §8-4）：只应用用户勾选的项；
   * 服务端对每一类提案重跑自己的护栏（回环/去重扫描/长度哨兵/引擎块比对），
   * 任何校验不过 → 明示原因，一行都不写。落库走现有 PUT /api/characters/:id。
   */
  router.post('/apply', async (req, res) => {
    const { character_id, selections, expected_hash } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!row) return res.status(404).json({ error: 'Character not found' });

    const preHash = hashCard(row);
    if (expected_hash && expected_hash !== preHash) {
      // §8-7 陈旧检测：卡片在适配后又改过 → 拒绝并建议重来
      return res.status(409).json({
        error: '卡片在适配之后已有改动（源哈希不一致）：建议重新体检与适配。本次未做任何改动。',
        source_hash: preHash
      });
    }
    const sel = selections || {};

    // ① P4 开场白：提案文本由预览带回，服务端全量回环（与当前卡原块逐字节比对）
    let newGreeting;
    if (sel.greeting) {
      if (typeof sel.greeting !== 'string' || !sel.greeting.trim()) {
        return res.status(400).json({ error: '开场白提案为空：先完成适配，或在确认界面取消这一项。' });
      }
      const expectedBlocks = extractVariableBlocks(row.first_message || '');
      const loop = fmt.validateGreeting(sel.greeting, {
        mode: 'emit', userName: '我', charName: row.name, variableBlocks: expectedBlocks
      });
      if (!loop.ok) {
        return res.status(422).json({
          error: '开场白回环校验未通过，本次未做任何改动：' + greetingIssuesText(loop.errors),
          loopback: loop
        });
      }
      newGreeting = sel.greeting;
    }

    // ② 去重：服务端重新扫描（确定性零成本），按 {field, para_index} 对齐用户勾选；
    //    L3 项由预览带回 dup_of，服务端对两个段落重跑数值/专名护栏
    const freshScan = dedupeScan(row);
    const acceptedDrops = [];
    const wantedDrop = new Set((Array.isArray(sel.dedupe) ? sel.dedupe : [])
      .filter(d => d && typeof d.field === 'string' && Number.isInteger(d.para_index))
      .map(d => d.field + '#' + d.para_index));
    for (const d of freshScan.drop) {
      if (wantedDrop.has(d.field + '#' + d.para_index)) acceptedDrops.push(d);
    }
    const acceptedL3 = [];
    const skipped = [];
    for (const l3 of (Array.isArray(sel.l3) ? sel.l3 : [])) {
      if (!l3 || typeof l3.field !== 'string' || !Number.isInteger(l3.para_index)) continue;
      const dup = l3.dup_of && typeof l3.dup_of.field === 'string' ? l3.dup_of : null;
      const victimList = paraUnits(l3.field, row[l3.field]);
      const victim = victimList.find(u => u.para_index === l3.para_index);
      if (!victim) { skipped.push({ kind: 'l3', field: l3.field, para_index: l3.para_index, reason: '段落定位失败（卡片已改动）' }); continue; }
      if (dup) {
        const keeper = paraUnits(dup.field, row[dup.field]).find(u => u.para_index === dup.para_index);
        if (keeper) {
          if (digitMultiset(victim.text) !== digitMultiset(keeper.text)) {
            skipped.push({ kind: 'l3', field: l3.field, para_index: l3.para_index, reason: '数值有差异 → 双方保留' });
            continue;
          }
          if (quotedTokens(victim.text) !== quotedTokens(keeper.text)) {
            skipped.push({ kind: 'l3', field: l3.field, para_index: l3.para_index, reason: '专有名词有差异 → 双方保留' });
            continue;
          }
        }
      }
      acceptedL3.push({ field: l3.field, para_index: l3.para_index, start: victim.start, end: victim.end, level: 'L3' });
    }

    // 长度哨兵（组合去重删除后整字段重查）
    const fieldSpans = {};
    for (const d of [...acceptedDrops, ...acceptedL3]) {
      (fieldSpans[d.field] = fieldSpans[d.field] || []).push(d);
    }
    for (const f of Object.keys(fieldSpans)) {
      const oldLen = String(row[f] || '').length;
      const newLen = oldLen - fieldSpans[f].reduce((s, d) => s + (d.end - d.start), 0);
      if (newLen < 0.5 * oldLen) {
        return res.status(422).json({
          error: '长度哨兵：' + f + ' 删除后不足原文一半，疑似丢失内容。本次未做任何改动，请逐条确认删除清单。',
          field: f, old: oldLen, new: newLen
        });
      }
    }

    // ③ 状态契约：回环重查 + 幂等拼接（已含相同契约则视为已应用）
    let newSystemPrompt;
    let appliedStatusContract = false;
    if (sel.status_contract && typeof sel.status_contract === 'object') {
      const sc = sel.status_contract;
      const keys = Array.isArray(sc.keys) ? sc.keys.filter(k => k && statusKeyOk(k.key)) : [];
      const initial = (sc.initial && typeof sc.initial === 'object') ? sc.initial : {};
      const ct = typeof sc.contract_text === 'string' ? sc.contract_text.trim() : '';
      if (!ct.startsWith('=== 状态输出 ===')) {
        return res.status(400).json({ error: '状态契约文本形态不对（应以「=== 状态输出 ===」开头）：本次未做任何改动。' });
      }
      if (!keys.length) {
        return res.status(400).json({ error: '状态契约缺少可用键：本次未做任何改动。' });
      }
      const loop = loopbackStatusSpec(keys, initial);
      if (!loop.ok) {
        return res.status(422).json({ error: '状态契约回环校验未通过，本次未做任何改动：' + loop.issues.join('；'), loopback: loop });
      }
      if (!(row.system_prompt || '').includes(ct)) {
        newSystemPrompt = ((row.system_prompt || '').trim() ? (row.system_prompt || '').trim() + '\n\n' : '') + ct;
        appliedStatusContract = true;
      } else {
        appliedStatusContract = true; // 幂等：契约已在，视作已应用
      }
    }

    // ③b 世界书常驻化（S5）：服务端逐条复核（仍是格式承载 + 仍非常驻）后只翻 constant 开关；
    //     条目内容零改动；落库走现有 PUT /api/characters/:id/book（§7）
    const bookToggled = [];
    const bookSkipped = [];
    let newBookBody = null;
    if (Array.isArray(sel.book_toggles) && sel.book_toggles.length) {
      const bk = parseBook(row);
      const bearerNow = new Set(scanBookBearers(bk).map(b => b.index));
      const entries = bk.entries.map(e => ({ ...e })); // 浅拷贝：只动 constant 字段
      for (const t of sel.book_toggles) {
        const idx = t && Number(t.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) { bookSkipped.push({ index: idx, reason: '条目定位失败（卡片已改动）' }); continue; }
        if (!bearerNow.has(idx)) { bookSkipped.push({ index: idx, reason: '复核不再认定格式承载' }); continue; }
        const isConst = entries[idx].constant === true || entries[idx].constant === 'true' || entries[idx].constant === 1;
        if (isConst) { bookSkipped.push({ index: idx, reason: '已是常驻' }); continue; }
        entries[idx].constant = true;
        bookToggled.push(idx);
      }
      if (bookToggled.length) newBookBody = { entries, book_activation: row.book_activation || 'off', name: bk.name };
    }

    // ④ 汇总落库载荷（PUT 只带真正变化的字段）
    const putBody = {};
    for (const f of Object.keys(fieldSpans)) {
      const text = String(row[f] || '');
      const sorted = fieldSpans[f].slice().sort((a, b) => b.start - a.start);
      let out = text;
      for (const d of sorted) out = out.slice(0, d.start) + out.slice(d.end);
      putBody[f] = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
    }
    if (newGreeting !== undefined) putBody.first_message = newGreeting;
    if (newSystemPrompt !== undefined) putBody.system_prompt = newSystemPrompt;

    const meta = parseMetadata(row);
    const engine = isEngineCard(row, meta);

    if (!Object.keys(putBody).length && !bookToggled.length) {
      return res.json({ message: '本次没有选中任何应用项，卡片原样未动。', changed: 0, skipped });
    }

    // ⑤ 快照 + card_studio 记录（§2.2 合并语义：其余 metadata 键无损）
    const snapshot = {
      description: row.description, personality: row.personality, scenario: row.scenario,
      system_prompt: row.system_prompt, first_message: row.first_message, metadata: row.metadata,
      character_book: row.character_book, book_activation: row.book_activation
    };
    const newUiHints = { ...(meta.ui_hints || {}), hasMVU: engine };
    if (appliedStatusContract) newUiHints.requiresStatus = !engine;
    const changedFields = Object.keys(putBody);
    const newMeta = {
      ...meta,
      ui_hints: newUiHints,
      card_studio: {
        spec_version: 1,
        source_hash: expected_hash || preHash,
        status_spec: appliedStatusContract ? { keys: sel.status_contract.keys, initial: sel.status_contract.initial, contract_text: sel.status_contract.contract_text } : (meta.card_studio && meta.card_studio.status_spec) || null,
        greeting_parsed: newGreeting !== undefined ? fmt.parseGreeting(newGreeting, { userName: '我', charName: row.name }) : (meta.card_studio && meta.card_studio.greeting_parsed) || null,
        conflicts: [],
        dedupe_report: {
          applied: acceptedDrops.length + acceptedL3.length,
          skipped,
          saved_chars: acceptedDrops.reduce((s, d) => s + (d.end - d.start), 0) + acceptedL3.reduce((s, d) => s + (d.end - d.start), 0)
        },
        worldbook_report: { toggled: bookToggled, skipped: bookSkipped },
        report: typeof sel.report === 'string' ? sel.report.slice(0, 4000) : null,
        snapshot,
        applied_at: new Date().toISOString(),
        rolled_back_at: null,
        cost: sel.cost && typeof sel.cost === 'object' ? sel.cost : null
      }
    };
    putBody.metadata = newMeta;

    // ⑥ 落库：现有 PUT /api/characters/:id（§7）
    const origin = currentOrigin(req);
    let putRes;
    try {
      putRes = await selfJson(origin, 'PUT', '/api/characters/' + encodeURIComponent(character_id), putBody);
    } catch (e) {
      return res.status(502).json({ error: '落库请求失败：' + e.message + '。本次未做任何改动。' });
    }
    if (putRes.status !== 200) {
      return res.status(502).json({ error: '落库失败（HTTP ' + putRes.status + '）：' + JSON.stringify(putRes.body).slice(0, 200) + '。本次未做任何改动。' });
    }
    // ⑥b 世界书常驻化（快照已含改前 character_book，回滚可字节级复原）
    if (newBookBody) {
      let bookRes;
      try {
        bookRes = await selfJson(origin, 'PUT', '/api/characters/' + encodeURIComponent(character_id) + '/book', newBookBody);
      } catch (e) {
        return res.status(502).json({ error: '世界书写入请求失败：' + e.message + '。字段与记录已落库，可用「回滚」整体复原。' });
      }
      if (bookRes.status !== 200) {
        return res.status(502).json({ error: '世界书写入失败（HTTP ' + bookRes.status + '）：' + JSON.stringify(bookRes.body).slice(0, 200) + '。字段与记录已落库，可用「回滚」整体复原。' });
      }
    }
    const fresh = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    res.json({
      message: '已应用 ' + changedFields.length + ' 个字段' + (appliedStatusContract ? '（含状态契约）' : '') + (bookToggled.length ? '（含世界书常驻化 ' + bookToggled.length + ' 条）' : '') + '；回滚可用。',
      changed: changedFields,
      worldbook: { toggled: bookToggled, skipped: bookSkipped },
      skipped,
      character: fresh
    });
  });

  /**
   * POST /rollback —— 回滚到应用前快照（六字段 + metadata；世界书从未被本模块写，无需回滚）。
   * 落库同样走现有 PUT。
   */
  router.post('/rollback', async (req, res) => {
    const { character_id } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    const meta = parseMetadata(row);
    const cs = meta.card_studio;
    if (!cs) {
      return res.status(404).json({ error: '本卡没有可回滚的快照（尚未通过卡坊应用过）。' });
    }
    if (cs.rolled_back_at) {
      // 先判「已回滚」再判「有没有快照」：回滚会把快照消化掉，只留 rolled_back_at 审计戳
      return res.status(409).json({ error: '本卡已回滚过；如需再次应用，请重新体检与适配。' });
    }
    if (!cs.snapshot) {
      return res.status(404).json({ error: '本卡没有可回滚的快照（尚未通过卡坊应用过）。' });
    }
    const snap = cs.snapshot;
    const restoredMeta = (() => {
      try { return snap.metadata ? JSON.parse(snap.metadata) : {}; } catch (e) { return {}; }
    })();
    const stamped = {
      ...restoredMeta,
      card_studio: { ...(restoredMeta.card_studio || {}), rolled_back_at: new Date().toISOString(), last_action: 'rollback' }
    };
    const origin = currentOrigin(req);
    let putRes;
    try {
      putRes = await selfJson(origin, 'PUT', '/api/characters/' + encodeURIComponent(character_id), {
        description: snap.description,
        personality: snap.personality,
        scenario: snap.scenario,
        system_prompt: snap.system_prompt,
        first_message: snap.first_message,
        // 世界书：快照存的是改前的原始字节列（S5 之前的老快照没有这两项 → COALESCE 跳过，行为不变）
        character_book: snap.character_book,
        book_activation: snap.book_activation,
        metadata: stamped
      });
    } catch (e) {
      return res.status(502).json({ error: '回滚请求失败：' + e.message + '。卡片未改动。' });
    }
    if (putRes.status !== 200) {
      return res.status(502).json({ error: '回滚失败（HTTP ' + putRes.status + '）：' + JSON.stringify(putRes.body).slice(0, 200) + '。卡片未改动。' });
    }
    const fresh = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    res.json({ message: '已回滚到应用前状态。', character: fresh });
  });

  // GET /report/:id —— 适配记录（metadata.card_studio）
  router.get('/report/:id', (req, res) => {
    const row = db.prepare('SELECT metadata FROM characters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    const meta = parseMetadata(row);
    res.json({ card_studio: meta.card_studio || null });
  });

  return router;
};
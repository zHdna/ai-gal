/**
 * contextWindow.js — 解析「模型上下文窗口」（tokens），供顶栏「稳定度 = 上下文占用比例」当分母。
 *
 * 背景（2026-09-21 用户报「世界稳定度 UI 没有实际效果，无法体现上下文使用情况」）
 * ------------------------------------------------------------------------------
 * 那个条以前算的是 `当前上下文 tokens ÷ 累计消耗 tokens`：
 *   · 第 1 轮 ≈ 100%（条满、判成 danger）
 *   · 之后每轮分母又涨一截 → 比例单调衰减，最终恒为 ~1%
 * 于是条要么顶满、要么空着，跟"上下文用得怎么样"毫无关系（实测用户库：累计 98 万，
 * 当前上下文才 ~1 万 → 条宽 1%，永远 safe）。
 *
 * 正确的分母是**模型的上下文窗口**。它有三个来源，按可信度排序：
 *   1. 供应商上用户手填的 `api_providers.context_window`（最可信，云端模型只能靠它）
 *   2. 本地服务自动探测（best-effort，只在本地/私网地址上做，1.5s 超时 + 5 分钟缓存）：
 *        · llama.cpp      GET  /props                              → default_generation_settings.n_ctx
 *        · Ollama         GET  /api/ps                             → models[].context_length（已加载模型）
 *                         POST /api/show {"model":…}               → model_info["<arch>.context_length"]
 *        · KoboldCpp      GET  /api/extra/true_max_context_length   → value
 *        · vLLM 等        GET  /v1/models                          → data[].max_model_len
 *   3. 聊天预设里导入 ST 预设时带来的 `max_context`（很多 ST 预设并不带，带了就用）
 *   都拿不到就返回 0 = **未知**。前端据此显示「上限未设置」而不是编一个假的百分比。
 */

'use strict';

const http = require('http');
const https = require('https');

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const _cache = new Map();          // cacheKey -> { tokens, source, at }

/** 本地 / 私网地址才做自动探测（云端网关没有统一的自省接口，猜不如不猜） */
function isLocalish(hostname) {
  return /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(hostname || '');
}

/** 把 …/v1/images/xxx 之类的端点收敛成服务根地址 */
function rootOf(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return s.replace(/\/v1$/i, '').replace(/\/api$/i, '');
}

function httpJson(urlStr, { method = 'GET', body = null, timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch { return resolve(null); }
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 200000) { buf = buf.slice(0, 200000); } });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

function posInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 依次尝试各家本地服务的自省接口；命中即返回 {tokens, source} */
async function probeLocal(baseUrl, model) {
  const root = rootOf(baseUrl);
  if (!root) return null;

  // ⚠️ 并行探测（不是串行）：串行最坏 5×1.5s 会拖慢本次请求。
  // 这些端点互相独立，谁先答谁算；全都不答最多等 PROBE_TIMEOUT_MS。
  const [props, ps, show, kb, models] = await Promise.all([
    httpJson(root + '/props'),
    httpJson(root + '/api/ps'),
    model ? httpJson(root + '/api/show', { method: 'POST', body: { model: String(model).replace(/^ollama[:/]/i, '') } }) : null,
    httpJson(root + '/api/extra/true_max_context_length'),
    httpJson(root + '/v1/models'),
  ]);

  // ① llama.cpp server：/props → default_generation_settings.n_ctx（也兼容顶层 n_ctx）
  if (props) {
    const n = posInt(props.default_generation_settings && props.default_generation_settings.n_ctx) || posInt(props.n_ctx);
    if (n) return { tokens: n, source: 'llama.cpp /props' };
  }

  // ② Ollama：/api/ps（已加载模型自带 context_length，最准，因为反映实际启动参数）
  if (ps && Array.isArray(ps.models) && ps.models.length) {
    const want = String(model || '').replace(/^ollama[:/]/i, '').trim();
    const hit = ps.models.find(m => m && (m.name === want || m.model === want || (want && String(m.name || '').startsWith(want)))) || ps.models[0];
    const n = posInt(hit && hit.context_length);
    if (n) return { tokens: n, source: 'Ollama /api/ps' };
  }

  // ③ Ollama：/api/show → model_info["<arch>.context_length"]
  if (show && show.model_info && typeof show.model_info === 'object') {
    const key = Object.keys(show.model_info).find(k => /\.context_length$/i.test(k));
    const n = posInt(key && show.model_info[key]);
    if (n) return { tokens: n, source: 'Ollama /api/show' };
  }

  // ④ KoboldCpp：/api/extra/true_max_context_length → value
  if (kb) {
    const n = posInt(kb.value);
    if (n) return { tokens: n, source: 'KoboldCpp true_max_context_length' };
  }

  // ⑤ vLLM / 部分 OpenAI 兼容服务：/v1/models → data[].max_model_len
  if (models && Array.isArray(models.data) && models.data.length) {
    const want = String(model || '').trim();
    const hit = models.data.find(m => m && (m.id === want)) || models.data[0];
    const n = posInt(hit && (hit.max_model_len || hit.context_length || hit.max_context_length));
    if (n) return { tokens: n, source: '/v1/models max_model_len' };
  }

  return null;
}

/**
 * 解析该供应商的上下文窗口。
 * @param {object} provider api_providers 行（可为 null）
 * @param {number} [presetMaxContext] 聊天预设里的 max_context（可选兜底）
 * @param {{allowProbe?:boolean}} [opts] allowProbe=false 时只用「设置/缓存/预设」，
 *   不发起探测请求（对话回合里用 —— 避免在生成过程中往供应商打无关请求、也不拖慢响应）。
 * @returns {Promise<{tokens:number, source:string}>} tokens=0 表示未知
 */
async function resolveContextWindow(provider, presetMaxContext, opts = {}) {
  const allowProbe = opts.allowProbe !== false;
  const manual = posInt(provider && provider.context_window);
  if (manual) return { tokens: manual, source: '供应商设置' };

  const baseUrl = String((provider && provider.base_url) || '').trim();
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname; } catch { /* 非法地址跳过探测 */ }
  const probeDisabled = /^(1|true|yes)$/i.test(process.env.AI_GAL_NO_CONTEXT_PROBE || '');
  let cacheKey = '';

  if (hostname && isLocalish(hostname)) {
    cacheKey = baseUrl + '|' + String((provider && provider.model) || '');
    const hit = _cache.get(cacheKey);
    // 命中缓存：正结果（探到窗口）保 5 分钟；负结果（探不到）只保 60 秒 ——
    // 用户随后启动 llama.cpp / Ollama 时能较快自愈，不必重启 AI-GAL。
    if (hit) {
      const ttl = hit.tokens > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
      if ((Date.now() - hit.at) < ttl) return { tokens: hit.tokens, source: hit.source };
    }
    if (allowProbe) {
      try {
        const found = await probeLocal(baseUrl, provider && provider.model);
        if (found) {
          _cache.set(cacheKey, { tokens: found.tokens, source: found.source, at: Date.now() });
          console.log('[ContextWindow] 自动探测到上下文窗口：', found.tokens, 'tokens（' + found.source + '，' + baseUrl + '）');
          return found;
        }
      } catch { /* 探测失败就当未知 */ }
      // 探测不到也缓存一下，避免每轮都打一串请求
      _cache.set(cacheKey, { tokens: 0, source: '', at: Date.now() });
      console.log('[ContextWindow] 本地服务未提供上下文窗口信息（' + baseUrl + '）→ 按未知处理；'
        + '可在「AI 与供应商」里手填该模型的上下文长度。');
    }
    // allowProbe=false（对话回合内）：**不发起任何请求**，只用「供应商设置 / 缓存 / 预设」。
    // 窗口由「打开存档时的 GET /chat/token-stats」负责探测并写进缓存 —— 那里不在生成链路上。
  }

  const preset = posInt(presetMaxContext);
  if (preset) return { tokens: preset, source: '预设 max_context' };

  return { tokens: 0, source: '' };
}

/** 只给测试用：清掉探测缓存 */
function _clearCache() { _cache.clear(); }

module.exports = { resolveContextWindow, probeLocal, isLocalish, rootOf, _clearCache };

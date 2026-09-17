/**
 * API Providers CRUD Routes
 * Supports OpenAI, llama.cpp, Ollama etc.
 * API keys are encrypted at rest using AES-256-GCM.
 */
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt } = require('../crypto');
const { isUrlSafe } = require('../utils/urlGuard');

module.exports = (db) => {
  const router = Router();

  // The exact placeholder the GET endpoints return in place of a stored key.
  const API_KEY_MASK = '••••••••';

  /**
   * Is this value a key MASK / placeholder rather than a real credential?
   *
   * The list/get endpoints deliberately return `••••••••` instead of the real key, and the settings
   * UI binds that straight into its input. If the user then saves the form without retyping the
   * key, the mask itself arrives here — and encrypting it would silently destroy the real
   * credential, leaving every request with NO Authorization header (→ HTTP 401 "Unauthorized").
   *
   * Detected shapes:
   *   - the canonical mask, or any value built only from mask glyphs (•, ●, ○, *, ·, ‣, ▪, ＊)
   *   - a truncated key ending in an ellipsis (`sk-abcd...`, `sk-…`)
   *
   * Deliberately narrow: a real key is high-entropy and mixes case/digits, so this cannot
   * misfire on a genuine credential. `''` is NOT a mask — it is an explicit "clear the key".
   */
  function isMaskedApiKey(value) {
    if (value === undefined || value === null) return false;
    const s = String(value).trim();
    if (!s) return false;                                   // empty = intentional clear
    if (s === API_KEY_MASK) return true;
    const MASK_GLYPHS = /^[\u2022\u25CF\u25CB\u25AA\u25AB\u2023\u2043\u2219\u00B7\u002A\uFF0A\u25E6\u26AB\u25CE]+$/;
    if (MASK_GLYPHS.test(s)) return true;
    // A truncated key with a dot leader (`sk-abcd...`, `sk-…`). Kept short on purpose: a real key is
    // long, so `…` appearing in a short string can only be a display truncation.
    if (/(\.\.\.|\u2026)$/.test(s) && s.length <= 12) return true;
    return false;
  }

  /**
   * Resolve the api_key column value for an update.
   * Returns { value, skipped } — `skipped: true` means "keep whatever is stored".
   */
  function resolveApiKeyUpdate(incoming) {
    if (incoming === undefined || incoming === null) return { value: null, skipped: false };
    if (isMaskedApiKey(incoming)) return { value: null, skipped: true };
    return { value: encrypt(String(incoming)), skipped: false };
  }

  // Helper: mask api_key in provider rows (never return decrypted key)
  function maskProviderRows(rows) {
    const arr = Array.isArray(rows) ? rows : [rows];
    arr.forEach(r => {
      if (r && r.api_key) {
        const decrypted = decrypt(r.api_key);
        // 返回掩码版本，不泄露完整密钥
        r.api_key = decrypted ? API_KEY_MASK : '';
        r.has_api_key = !!decrypted;
      }
    });
    return Array.isArray(rows) ? rows : rows;
  }

  // List all providers
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM api_providers ORDER BY is_default DESC, created_at DESC').all();
    res.json(maskProviderRows(rows));
  });

  // Get single provider
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Provider not found' });
    res.json(maskProviderRows(row));
  });

  // Fetch available models from provider URL
  router.post('/fetch-models', async (req, res) => {
    const { base_url, api_key, provider_type } = req.body;
    if (!base_url) return res.status(400).json({ error: 'base_url required' });

    try {
      const models = await fetchModelsFromProvider(base_url, api_key || '', provider_type || 'openai');
      res.json(models);
    } catch (err) {
      console.error('[Providers] Fetch models error:', err.message);
      res.status(502).json({ error: err.message || 'Failed to fetch models' });
    }
  });

  // Create provider
  router.post('/', (req, res) => {
    const { name, provider_type, base_url, api_key, model, custom_headers, temperature, max_tokens, is_default, thinking } = req.body;

    if (!name || !base_url || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, base_url, model' });
    }

    // If this is set as default, unset others
    if (is_default) {
      db.prepare("UPDATE api_providers SET is_default = 0").run();
    }

    const id = uuidv4();
    const thinkVal = (thinking === false || thinking === 0) ? 0 : 1;
    // Reject a display mask on create too: it would produce a provider that is guaranteed to 401.
    if (isMaskedApiKey(api_key)) {
      return res.status(400).json({
        error: 'API密钥无效：收到的是界面上的掩码占位符（••••••••），不是真实密钥。请粘贴完整密钥。',
      });
    }
    db.prepare(`
      INSERT INTO api_providers (id, name, provider_type, base_url, api_key, model, custom_headers, temperature, max_tokens, is_default, thinking)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, provider_type || 'openai', base_url, encrypt(api_key || ''), model, JSON.stringify(custom_headers || {}), temperature ?? 0.7, max_tokens ?? 4096, is_default ? 1 : 0, thinkVal);

    res.status(201).json({ id, message: 'Provider created' });
  });

  // Update provider
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    const { name, provider_type, base_url, api_key, model, custom_headers, temperature, max_tokens, is_default, thinking } = req.body;

    // Validate: non-null fields must be non-empty
    if (name !== undefined && name !== null && !String(name).trim()) {
      return res.status(400).json({ error: '供应商名称不能为空字符串' });
    }
    if (base_url !== undefined && base_url !== null && !String(base_url).trim()) {
      return res.status(400).json({ error: 'API地址不能为空字符串' });
    }
    if (model !== undefined && model !== null && !String(model).trim()) {
      return res.status(400).json({ error: '模型名不能为空字符串' });
    }
    if (api_key !== undefined && api_key !== null && String(api_key).length > 10000) {
      return res.status(400).json({ error: 'API密钥过长' });
    }
    if (name !== undefined && name !== null && String(name).length > 200) {
      return res.status(400).json({ error: '供应商名称过长' });
    }

    // ⚠️ Never overwrite a stored key with the UI's display mask.
    // The settings form is bound to the masked value returned by GET /api/providers, so saving the
    // form untouched used to persist `••••••••` as the credential → every request went out without
    // an Authorization header and the provider replied 401 "Unauthorized".
    const keyUpdate = resolveApiKeyUpdate(api_key);
    if (keyUpdate.skipped) {
      console.warn('[Providers] Ignored masked api_key on update for', req.params.id,
        '("' + String(api_key).trim().slice(0, 12) + '") — kept the stored key');
    }

    // If setting as default, unset others
    if (is_default && !existing.is_default) {
      db.prepare("UPDATE api_providers SET is_default = 0").run();
    }

    db.prepare(`
      UPDATE api_providers SET
        name = COALESCE(?, name),
        provider_type = COALESCE(?, provider_type),
        base_url = COALESCE(?, base_url),
        api_key = COALESCE(?, api_key),
        model = COALESCE(?, model),
        custom_headers = COALESCE(?, custom_headers),
        temperature = COALESCE(?, temperature),
        max_tokens = COALESCE(?, max_tokens),
        is_default = COALESCE(?, is_default),
        thinking = COALESCE(?, thinking),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name, provider_type, base_url, keyUpdate.value, model,
      custom_headers !== undefined ? JSON.stringify(custom_headers) : null,
      temperature, max_tokens, is_default !== undefined ? (is_default ? 1 : 0) : null,
      thinking !== undefined ? ((thinking === false || thinking === 0) ? 0 : 1) : null,
      req.params.id
    );

    res.json({ message: 'Provider updated' });
  });

  // Delete provider
  router.delete('/:id', (req, res) => {
    const count = db.prepare('DELETE FROM api_providers WHERE id = ?').run(req.params.id);
    if (!count.changes) return res.status(404).json({ error: 'Provider not found' });
    res.json({ message: 'Provider deleted' });
  });

  // Set provider as default
  router.post('/:id/set-default', (req, res) => {
    const existing = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });
    db.prepare('UPDATE api_providers SET is_default = 0').run();
    db.prepare('UPDATE api_providers SET is_default = 1, updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    res.json({ message: 'Default provider set' });
  });

  return router;
};

/**
 * Fetch available models from an OpenAI-compatible endpoint.
 * Supports /v1/models (OpenAI) and /api/tags (Ollama).
 */
async function fetchModelsFromProvider(baseUrl, apiKey, providerType) {
  const headers = { 'Content-Type': 'application/json' };
  // Sanitize apiKey: strip non-ASCII characters (e.g. • from password manager autofill)
  // Node.js fetch (undici) requires header values to be ByteStrings (Latin-1, 0-255)
  if (apiKey) {
    const cleanKey = apiKey.replace(/[^\x00-\xFF]/g, '');
    if (cleanKey) headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  // Build URL: strip trailing slash, avoid duplicating path segments
  let url = baseUrl.replace(/\/+$/, '');

  // Try OpenAI-compatible /v1/models first
  // Special case: Gemini base_url already contains /v1beta/openai, so models endpoint is /v1beta/openai/models
  // Also detect Gemini by URL hostname even if providerType is set to 'openai'
  const isGeminiUrl = url.includes('generativelanguage.googleapis.com');
  let modelsUrl;
  if (providerType === 'gemini' || isGeminiUrl) {
    // Gemini OpenAI-compatible: /v1beta/openai/models
    // Auto-append /v1beta/openai if missing from base_url (e.g. user saved old value)
    if (!url.includes('/v1beta/openai')) {
      url = url + '/v1beta/openai';
    }
    modelsUrl = url.includes('/models') ? url : url + '/models';
  } else {
    modelsUrl = url.endsWith('/v1') ? url + '/models' : url + '/v1/models';
  }
  try {
    console.log('[Providers] Fetching models from:', modelsUrl, 'provider_type:', providerType);
    const urlCheck = isUrlSafe(modelsUrl);
    if (!urlCheck.ok) {
      throw new Error(`URL not allowed: ${urlCheck.reason}`);
    }
    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
    console.log('[Providers] Models response status:', res.status);
    if (res.ok) {
      const data = await res.json();
      console.log('[Providers] Models response keys:', Object.keys(data).join(', '));
      if (data && Array.isArray(data.data)) {
        return data.data.map(m => m.id).filter(Boolean).sort();
      }
      // X.AI may return { models: [...] } or { data: [...] }
      if (data && Array.isArray(data.models)) {
        return data.models.map(m => m.id || m.name || m).filter(Boolean).sort();
      }
      console.log('[Providers] Unexpected models format, data keys:', Object.keys(data));
    } else {
      // Log error body for debugging
      try {
        const errText = await res.text();
        console.error('[Providers] Models fetch failed:', res.status, errText.slice(0, 500));
      } catch {}
    }
  } catch (e) {
    console.error('[Providers] Models fetch error:', e.message, 'cause:', e.cause?.message || 'none', 'code:', e.cause?.code || 'none');
  }

  // If X.AI models endpoint doesn't exist or fails, return known models as fallback
  if (providerType === 'xai') {
    console.log('[Providers] X.AI models endpoint failed, returning known models');
    return ['grok-4.3', 'grok-4.3-mini', 'grok-3', 'grok-3-mini'];
  }

  // Gemini: try /v1beta/openai/models, fallback to known models
  if (providerType === 'gemini' || isGeminiUrl) {
    console.log('[Providers] Gemini models endpoint failed, returning known models (includes Gemini 3.x)');
    return [
      // Gemini 3.x (latest, June 2026)
      'gemini-3.5-flash',              // Stable: flagship Flash for agentic workflows
      'gemini-3-flash-preview',         // Preview: latest Pro-class Flash
      'gemini-3.1-pro-preview',        // Preview: latest Pro with enhanced reasoning
      'gemini-3.1-pro-preview-customtools', // Preview: optimized for agentic workflows with custom tools
      'gemini-3.1-flash-lite',         // Stable: fast & cost-effective
      // Gemini 2.5 (stable, widely used)
      'gemini-2.5-flash',               // Stable: best price/perf, supports reasoning
      'gemini-2.5-pro',                 // Stable: most advanced 2.x, deep reasoning
      'gemini-2.5-flash-lite',          // Stable: fastest 2.5, cost-effective
      // Older fallbacks (still available)
      'gemini-2.0-flash',               // Being shut down, fallback only
      'gemini-1.5-flash',               // Older fallback
      'gemini-1.5-pro',                 // Older fallback
    ];
  }

  // Try Ollama /api/tags
  let ollamaUrl = url + '/api/tags';
  try {
    const ollamaUrlCheck = isUrlSafe(ollamaUrl);
    if (!ollamaUrlCheck.ok) {
      throw new Error(`URL not allowed: ${ollamaUrlCheck.reason}`);
    }
    const res = await fetch(ollamaUrl, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.models)) {
        return data.models.map(m => m.name || m.model).filter(Boolean).sort();
      }
    }
  } catch {}

  throw new Error('Cannot fetch models from ' + baseUrl);
}

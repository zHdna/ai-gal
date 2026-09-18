/**
 * SillyTavern (ST) preset format — export helpers.
 *
 * Produces a *standard* ST **chat completion preset**: a flat JSON object whose
 * keys are exactly the keys SillyTavern itself uses, so the file can be dropped
 * straight into ST via
 *   AI Response Configuration → (preset dropdown) → Import
 * or shared with other ST users unchanged.
 *
 * Field names verified against SillyTavern source (`public/scripts/openai.js`):
 *   - `settingsToUpdate` (103 keys) defines the preset key namespace.
 *   - `chat_completion_sources` defines the `chat_completion_source` values.
 *   - `getChatCompletionPreset()` builds a preset as a flat object of those keys
 *     (no envelope; the preset *name* comes from the filename).
 *
 * DELIBERATE DESIGN CHOICE — this exporter emits only the keys this app actually
 * owns (sampler params it manages, the provider/model, and its system prompts).
 * It does NOT dump ST's defaults for the other ~90 keys, because ST's importer
 * applies only the keys that are present:
 *
 *     if (preset[key] !== undefined) { oai_settings[setting] = preset[key]; }
 *                                              (openai.js, preset apply loop)
 *
 * Emitting e.g. `impersonation_prompt` / `wi_format` / `new_chat_prompt` at ST's
 * defaults would silently overwrite the importing user's own ST configuration.
 * Omitting them is both safer and valid: ST keeps its current values.
 *
 * SECURITY: API keys are never exported. Standard ST presets carry no credential
 * (ST keeps secrets in its own secrets store), and baking a key into a shareable
 * JSON would leak it. The key must be entered once in SillyTavern.
 */

/** AI-GAL preset `data` key → ST preset key. Only 1:1 semantic equivalents. */
const SAMPLER_MAP = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  repetition_penalty: 'repetition_penalty',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  seed: 'seed',
  max_tokens: 'openai_max_tokens',
  max_context: 'openai_max_context',
};

/**
 * AI-GAL sampler keys with no chat-completion equivalent in ST.
 * These belong to ST's *text completion* preset namespace, so they are dropped
 * (reported back to the caller rather than silently discarded).
 */
const UNMAPPABLE = [
  'typical_p', 'tfs', 'epsilon_cutoff', 'eta_cutoff', 'rep_pen_range',
  'encoder_repetition_penalty', 'no_repeat_ngram_size', 'penalize_nl',
  'num_beams', 'do_sample', 'min_length', 'num_return_sequences',
];

/**
 * Known API hosts → ST chat completion source + the ST model field for it.
 * A named source is only used when the base URL points at that host directly;
 * anything else (proxy, self-hosted, unknown vendor) becomes ST's `custom`
 * source with an explicit URL, which is the faithful representation.
 */
const HOST_SOURCES = {
  'api.openai.com': ['openai', 'openai_model'],
  'api.anthropic.com': ['claude', 'claude_model'],
  'api.deepseek.com': ['deepseek', 'deepseek_model'],
  'api.moonshot.cn': ['moonshot', 'moonshot_model'],
  'api.moonshot.ai': ['moonshot', 'moonshot_model'],
  'api.groq.com': ['groq', 'groq_model'],
  'api.x.ai': ['xai', 'xai_model'],
  'api.mistral.ai': ['mistralai', 'mistralai_model'],
  'api.siliconflow.cn': ['siliconflow', 'siliconflow_model'],
  'api.siliconflow.com': ['siliconflow', 'siliconflow_model'],
  'openrouter.ai': ['openrouter', 'openrouter_model'],
  'api.fireworks.ai': ['fireworks', 'fireworks_model'],
  'api.perplexity.ai': ['perplexity', 'perplexity_model'],
  'open.bigmodel.cn': ['zai', 'zai_model'],
  'api.z.ai': ['zai', 'zai_model'],
  'api.cohere.ai': ['cohere', 'cohere_model'],
  'api.ai21.com': ['ai21', 'ai21_model'],
  'generativelanguage.googleapis.com': ['makersuite', 'google_model'],
};

/** Paths that still count as "pointing at the vendor itself". */
const VENDOR_PATHS = ['', '/', '/v1', '/v1/', '/api', '/api/'];

/**
 * Map an AI-GAL API provider row onto ST connection fields.
 * @param {object|null} provider api_providers row
 * @returns {{fields: object, source: string, note: string}}
 */
function providerToST(provider) {
  if (!provider) {
    return { fields: {}, source: '', note: 'no provider selected; only sampler/prompt keys exported' };
  }

  const baseUrl = String(provider.base_url || '').trim();
  const model = String(provider.model || '').trim();
  const fields = {};
  let source = 'custom';
  let note = '';

  let host = '';
  let path = '';
  try {
    const u = new URL(baseUrl);
    host = u.hostname.toLowerCase();
    path = u.pathname;
    // Only an exact vendor host with a bare path is safe to map to a named source,
    // because ST's named sources ignore `custom_url` and use their own endpoint.
    if (VENDOR_PATHS.includes(path)) {
      const hit = HOST_SOURCES[host];
      if (hit) {
        source = hit[0];
        if (model) fields[hit[1]] = model;
        note = `mapped to ST source '${source}' by host`;
      }
    }
    if (source === 'custom') {
      note = host ? `unrecognised host '${host}' → ST custom endpoint` : 'invalid URL → ST custom endpoint';
    }
  } catch {
    note = 'unparseable base_url → ST custom endpoint';
  }

  fields.chat_completion_source = source;

  if (source === 'custom') {
    // ST only reads custom_url/custom_model when chat_completion_source === 'custom'.
    if (baseUrl) fields.custom_url = baseUrl;
    if (model) fields.custom_model = model;
    const headers = safeJsonObject(provider.custom_headers);
    if (headers && Object.keys(headers).length > 0) {
      fields.custom_include_headers = JSON.stringify(headers);
    }
  }

  return { fields, source, note };
}

/**
 * Convert AI-GAL `system_prompts` into ST prompt entries.
 * Only content-bearing prompts are exported; ST marker entries are not synthesised.
 * @param {Array} systemPrompts
 */
function promptsToST(systemPrompts) {
  if (!Array.isArray(systemPrompts)) return [];
  const used = new Set();
  const out = [];

  for (const sp of systemPrompts) {
    const content = String((sp && sp.content) || '').trim();
    if (!content) continue;

    const name = String((sp && sp.name) || '').trim() || '提示词';
    let identifier = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!identifier) identifier = 'prompt';
    // ST expects unique identifiers.
    if (used.has(identifier)) {
      let n = 2;
      while (used.has(`${identifier}_${n}`)) n++;
      identifier = `${identifier}_${n}`;
    }
    used.add(identifier);

    out.push({
      identifier,
      name,
      system_prompt: !!sp.system_prompt,
      role: sp.role || 'system',
      content,
      injection_position: sp.injection_position ?? 0,
      injection_depth: sp.injection_depth ?? 0,
      forbid_overrides: !!sp.forbid_overrides,
      enabled: sp.enabled !== false,
    });
  }
  return out;
}

/**
 * Build a standard ST chat completion preset from an AI-GAL preset + provider.
 * @param {object} preset api_presets row (data/enabled_params already parsed)
 * @param {object|null} provider api_providers row
 * @returns {{preset: object, report: object}} the ST preset body + a mapping report
 */
function buildSTPreset(preset, provider) {
  const data = (preset && preset.data) || {};
  const enabled = new Set((preset && preset.enabled_params) || []);

  const body = {};
  const mapped = [];
  const skipped = [];

  for (const [srcKey, stKey] of Object.entries(SAMPLER_MAP)) {
    const v = data[srcKey];
    if (v === undefined || v === null || v === '') continue;
    // Only export params the preset actually enables, when it declares a list.
    if (enabled.size > 0 && !enabled.has(srcKey)) continue;
    body[stKey] = v;
    mapped.push(`${srcKey} → ${stKey}`);
  }

  for (const k of UNMAPPABLE) {
    if (data[k] !== undefined) skipped.push(k);
  }

  // Provider-level fallbacks for the two context fields ST always expects to be sane.
  const p = provider || {};
  if (body.openai_max_tokens === undefined && Number.isFinite(p.max_tokens) && p.max_tokens > 0) {
    body.openai_max_tokens = p.max_tokens;
    mapped.push('provider.max_tokens → openai_max_tokens');
  }
  if (Number.isFinite(p.temperature) && body.temperature === undefined) {
    body.temperature = p.temperature;
    mapped.push('provider.temperature → temperature');
  }

  const prov = providerToST(provider);
  Object.assign(body, prov.fields);

  const prompts = promptsToST(data.system_prompts);
  if (prompts.length > 0) body.prompts = prompts;

  return {
    preset: body,
    report: {
      source: prov.source,
      providerNote: prov.note,
      promptCount: prompts.length,
      mapped,
      unmappableSkipped: skipped,
      includesApiKey: false,
    },
  };
}

/** Sanitise a preset name into a safe download filename. */
function presetFilename(name) {
  const base = String(name || 'preset')
    .replace(/\.json$/i, '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .trim() || 'preset';
  return `${base}.json`;
}

function safeJsonObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = {
  SAMPLER_MAP,
  UNMAPPABLE,
  HOST_SOURCES,
  buildSTPreset,
  providerToST,
  promptsToST,
  presetFilename,
};

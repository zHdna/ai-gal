/**
 * Shared Constants
 * Single source of truth for magic strings used across routes.
 */

// ── Settings row IDs ──
exports.SETTINGS_ID = 'default';

// ── app_settings keys ──
exports.APP_KEYS = {
  GLOBAL_SYSTEM_PROMPT: 'global_system_prompt',
  CARD_FIXER_PROMPT: 'card_fixer_prompt',
  MEMORY_AGENT_PROMPT: 'memory_agent_prompt',
  BUTLER_PROVIDER_ID: 'butler_provider_id',
  PAINTER_PROVIDER_ID: 'painter_provider_id',
  IMAGE_ENABLED: 'image_enabled',
  MAIN_AI_PROVIDER_ID: 'main_ai_provider_id',
  BUTLER_AI_PRESET_ID: 'butler_ai_preset_id',
};

// ── Image engines ──
// `image_settings.mode` accepts:
//   anima      — anima-turbo-cg, a minimal single-model local service (stable-diffusion.cpp)
//                speaking the OpenAI images API on 127.0.0.1:8100.  DEFAULT.
//   comfyui    — full ComfyUI instance + user-supplied workflow JSON (best quality)
//   openai     — any OpenAI-compatible online/offline images API
//   stability  — Stability AI format
//   novelai    — NovelAI image API (image.novelai.net, own JSON dialect + ZIP response)
//   none       — image generation disabled (profile placeholders only)
exports.IMAGE_MODES = ['anima', 'comfyui', 'openai', 'stability', 'novelai', 'none'];

// Modes served by generateViaOpenAI() (`anima` is an OpenAI-compatible endpoint too).
exports.OPENAI_COMPATIBLE_MODES = ['anima', 'openai'];
// Modes that talk to a third-party endpoint instead of a local ComfyUI graph.
exports.EXTERNAL_IMAGE_MODES = ['anima', 'openai', 'stability', 'novelai'];

// anima-turbo-cg preset — the single source of truth for its endpoint contract.
// The service ignores the API key, but AI-GAL requires a non-empty one.
exports.ANIMA_PRESET = {
  MODE: 'anima',
  API_URL: 'http://127.0.0.1:8100/v1/images/generations',
  API_KEY: 'local',
  API_MODEL: 'sd-cpp-local',
  // Anima-Turbo is a distilled model: 1024² is its native resolution.
  IMAGE_SIZE: '1024x1024',
  // sd.cpp answers synchronously.  A GPU box finishes in ~4 s, but a CPU-only box
  // needs minutes for 1024² (512²/6 steps ≈ 73 s), so the default 120 s cloud
  // timeout would abort perfectly healthy requests.
  TIMEOUT_MS: 600000,
};

// Timeout for third-party image APIs (OpenAI / Stability / NovelAI).
exports.EXTERNAL_API_TIMEOUT_MS = 120000;

// NovelAI image API preset — single source of truth for its endpoint contract.
// The endpoint speaks its own JSON dialect ({input, model, action, parameters}) and
// answers with a binary ZIP archive holding the generated PNG — it is NOT OpenAI-
// compatible (see generateViaNovelAI).  Auth = the account's Persistent API Token
// ("Bearer pst-…", obtained from the NovelAI site: Settings → Account).  Default
// parameters stay inside the Opus free tier (≤28 steps, 1 sample, ≤1024²) so normal
// use never burns Anlas.  Response shape verified against NekoAI-API's official
// payload examples (nai3.json / nai4.5.json) and NekoAI-JS' "force zip" behaviour:
// omitting `stream` makes the V4/V4.5 API answer with a plain ZIP, same as V3.
exports.NOVELAI_PRESET = {
  MODE: 'novelai',
  API_URL: 'https://image.novelai.net/ai/generate-image',
  API_MODEL: 'nai-diffusion-4-5-full',
  IMAGE_SIZE: '1024x1024',
  TIMEOUT_MS: 120000,
  // Fixed model list (the API has no OpenAI-style /models endpoint to enumerate it).
  MODELS: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-3', 'nai-diffusion-furry-3'],
  // Built-in fallback negative: NovelAI's standard heavy preset, minus the `nsfw` tag —
  // this app deliberately tags NSFW scenes POSITIVE, so the rating word must stay out.
  DEFAULT_NEGATIVE: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad fingers, bad hands',
};

// ComfyUI's own default port.  ComfyUI is a separate engine from anima-turbo-cg,
// so it must NOT default to 8100.
exports.DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

// ── File names ──
exports.EVENT_LOG_FILE = 'event_log.md';
exports.ROSTER_FILE = 'character_roster.json';

// ── Memory context keys ──
exports.MEMORY_KEYS = {
  EVENT_LOG: 'event_log',
  LAST_ROUND: 'last_round',
  // Round at which the table was last injected. buildApiMessages() only sends the
  // memory block while the conversation is still on that round — between injections
  // the table is dormant in event_log.md and absent from context.
  INJECTED_AT: 'injected_at_round',
};

// ── Memory table injection defaults ──
exports.DEFAULT_INJECT_INTERVAL = 20;   // N: inject the full table every N rounds
exports.DEFAULT_DROP_THRESHOLD = 60;    // M: at round M offer to drop earlier dialogue


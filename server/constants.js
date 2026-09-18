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
//   none       — image generation disabled (profile placeholders only)
exports.IMAGE_MODES = ['anima', 'comfyui', 'openai', 'stability', 'none'];

// Modes served by generateViaOpenAI() (`anima` is an OpenAI-compatible endpoint too).
exports.OPENAI_COMPATIBLE_MODES = ['anima', 'openai'];
// Modes that talk to a third-party endpoint instead of a local ComfyUI graph.
exports.EXTERNAL_IMAGE_MODES = ['anima', 'openai', 'stability'];

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

// Timeout for third-party image APIs (OpenAI / Stability).
exports.EXTERNAL_API_TIMEOUT_MS = 120000;

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
};


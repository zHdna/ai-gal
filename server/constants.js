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

// ── File names ──
exports.EVENT_LOG_FILE = 'event_log.md';
exports.ROSTER_FILE = 'character_roster.json';

// ── Memory context keys ──
exports.MEMORY_KEYS = {
  EVENT_LOG: 'event_log',
  LAST_ROUND: 'last_round',
};


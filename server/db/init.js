/**
 * SQLite Database Initialization
 * Creates all required tables for the AI Role-Play Tool
 */
const Database = require('better-sqlite3');
const { SETTINGS_ID, APP_KEYS } = require('../constants');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');

function initDatabase() {
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // --- API Providers ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'openai',  -- openai | llamacpp | ollama
      base_url    TEXT NOT NULL,
      api_key     TEXT DEFAULT '',
      model       TEXT NOT NULL,
      custom_headers TEXT DEFAULT '{}',              -- JSON string
      temperature REAL DEFAULT 0.7,
      max_tokens  INTEGER DEFAULT 4096,
      is_default  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrate: add thinking column (controls reasoning/think-mode toggle for local
  // thinking models like Qwen3.x on llama.cpp). Default 1 = thinking enabled.
  try {
    db.exec('ALTER TABLE api_providers ADD COLUMN thinking INTEGER DEFAULT 1');
  } catch (e) { /* column already exists */ }

  // --- Character Cards (SillyTavern compatible) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      title           TEXT DEFAULT '',
      description     TEXT DEFAULT '',
      personality     TEXT DEFAULT '',
      scenario        TEXT DEFAULT '',
      first_message   TEXT DEFAULT '',
      system_prompt   TEXT DEFAULT '',
      post_history_instructions TEXT DEFAULT '',
      character_book  TEXT DEFAULT '',               -- JSON: world book entries
      book_activation TEXT DEFAULT 'off',             -- 'always' | 'off' | 'keyword'
      mes_example     TEXT DEFAULT '',               -- JSON string
      creator_notes   TEXT DEFAULT '',
      tags            TEXT DEFAULT '[]',             -- JSON string
      avatar          TEXT DEFAULT '',               -- base64 or URL
      markup_mode     TEXT DEFAULT '',               -- '' | 'game-xml' : custom game-markup cards (Tavern Helper style)
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrate: add post_history_instructions if missing
  try {
    db.exec('ALTER TABLE characters ADD COLUMN post_history_instructions TEXT DEFAULT \'\'');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migrate: add character_book and book_activation if missing
  try {
    db.exec('ALTER TABLE characters ADD COLUMN character_book TEXT DEFAULT \'\'');
  } catch (e) { /* ignore */ }
  try {
    db.exec('ALTER TABLE characters ADD COLUMN book_activation TEXT DEFAULT \'off\'');
  } catch (e) { /* ignore */ }

  // Migrate: add metadata column (culture, gender etc.)
  try {
    db.exec('ALTER TABLE characters ADD COLUMN metadata TEXT DEFAULT \'{}\'');
  } catch (e) { /* ignore */ }

  // Migrate: add markup_mode for game-markup engine cards (大容量卡 / Tavern Helper 风格)
  try { db.exec("ALTER TABLE characters ADD COLUMN markup_mode TEXT DEFAULT ''"); } catch (e) { /* ignore */ }

  // Migrate: add mvu_meta column (MVU variable schema metadata extracted on import)
  try { db.exec("ALTER TABLE characters ADD COLUMN mvu_meta TEXT DEFAULT ''"); } catch (e) { /* ignore */ }

  // Migrate: add game_dir column (master save folder id, e.g. game0001)
  try { db.exec("ALTER TABLE characters ADD COLUMN game_dir TEXT DEFAULT ''"); } catch (e) { /* ignore */ }

  // Migrate: add excluded_names (per-card avatar exclusion list; the card's own name is
  // excluded from portrait generation by default so the scenario/title never becomes a character).
  try { db.exec("ALTER TABLE characters ADD COLUMN excluded_names TEXT DEFAULT '[]'"); } catch (e) { /* ignore */ }
  // Backfill: every card without an exclusion list gets its own name excluded.
  try { db.exec("UPDATE characters SET excluded_names = json_array(name) WHERE excluded_names IS NULL OR excluded_names = '' OR excluded_names = '[]'"); } catch (e) { /* ignore */ }

  // --- User Profile (multi-user) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '我',
      avatar TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Ensure at least one default user exists
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM user_profile').get();
  if (userCount.cnt === 0) {
    db.prepare('INSERT INTO user_profile (name, avatar, intro, is_active) VALUES (?, ?, ?, 1)').run('我', '', '');
  }

  // Migrate: add persona (in-game role-play identity) columns
  try {
    db.exec('ALTER TABLE user_profile ADD COLUMN persona_name TEXT DEFAULT \'\'');
  } catch (e) { /* ignore */ }
  try {
    db.exec('ALTER TABLE user_profile ADD COLUMN persona_avatar TEXT DEFAULT \'\'');
  } catch (e) { /* ignore */ }

  // Migrate old single-row user_profile
  try {
    const oldUser = db.prepare('SELECT * FROM user_profile WHERE id = 1 AND is_active = 0').get();
    if (oldUser) {
      db.prepare('UPDATE user_profile SET is_active = 1 WHERE id = 1').run();
    }
  } catch (e) { /* ignore */ }

  // --- Saves (game save tracking) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS saves (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      character_id TEXT,
      save_name TEXT DEFAULT '',
      save_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // --- Conversations ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT PRIMARY KEY,
      character_id    TEXT,
      title           TEXT DEFAULT 'New Conversation',
      system_prompt   TEXT DEFAULT '',
      memory_context  TEXT DEFAULT '{}',             -- JSON string: enhanced memory
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (character_id) REFERENCES characters(id)
    )
  `);

  // Schema migration: character roster for butler AI
  try { db.exec(`ALTER TABLE conversations ADD COLUMN character_roster TEXT DEFAULT '[]'`); } catch {}

  // Schema migration: STscript 提示词注入 / 作者备注 (Phase 4)
  try { db.exec(`ALTER TABLE conversations ADD COLUMN script_injects TEXT DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN author_note TEXT DEFAULT '{}'`); } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN script_inject_state TEXT DEFAULT '{}'`); } catch {}
  // Migrate: MVU world-state model (Tier 3 closed loop)
  try { db.exec(`ALTER TABLE conversations ADD COLUMN world_state TEXT DEFAULT '{}'`); } catch {}

  // --- Messages ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,                 -- user | assistant | system
      content         TEXT NOT NULL,                 -- raw AI text (clean context)
      formatted       TEXT DEFAULT '{}',             -- JSON: formatting for game UI
      hidden          INTEGER DEFAULT 0,             -- 1 = excluded from AI context
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  // Migrate: add hidden column if missing (existing DBs)
  try {
    db.exec('ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0');
  } catch (e) {
    // Column already exists, ignore
  }

  // --- Image Generation Settings ---
  // Default engine is anima-turbo-cg (minimal single-model local service on port 8100,
  // OpenAI-compatible).  ComfyUI remains the higher-quality option and is a separate
  // engine on its own port (8188).  See README §五.2.
  const ANIMA = require('../constants').ANIMA_PRESET;
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_settings (
      id                        TEXT PRIMARY KEY DEFAULT 'default',
      mode                      TEXT DEFAULT '${ANIMA.MODE}',  -- anima | comfyui | openai | stability | none
      comfyui_url               TEXT DEFAULT 'http://127.0.0.1:8188',
      api_url                   TEXT DEFAULT '${ANIMA.API_URL}',
      api_key                   TEXT DEFAULT '${ANIMA.API_KEY}',
      model                     TEXT DEFAULT 'flux',
      workflow_id               TEXT DEFAULT '',
      custom_params             TEXT DEFAULT '{}',             -- JSON string
      gen_mode                  TEXT DEFAULT 'tag',            -- tag | natural (生图提示词模式)
      portrait_quality_prefix   TEXT DEFAULT '',               -- 头像自定义质量前缀
      cg_quality_prefix         TEXT DEFAULT '',               -- CG自定义质量前缀
      portrait_positive_node    TEXT DEFAULT '',               -- 头像正向提示词节点ID
      portrait_negative_node    TEXT DEFAULT '',               -- 头像负向提示词节点ID
      cg_positive_node          TEXT DEFAULT '',               -- CG正向提示词节点ID
      cg_negative_node          TEXT DEFAULT '',               -- CG负向提示词节点ID
      portrait_negative_prompt  TEXT DEFAULT '',               -- 头像自定义负向提示词
      cg_negative_prompt        TEXT DEFAULT '',               -- CG自定义负向提示词
      api_model                 TEXT DEFAULT '${ANIMA.API_MODEL}', -- OpenAI兼容/anima 生图模型
      quality_prefix            TEXT DEFAULT '',               -- OpenAI兼容模式提示词质量前缀
      image_size                TEXT DEFAULT '${ANIMA.IMAGE_SIZE}' -- OpenAI兼容/anima 图片尺寸
    )
  `);

  // Insert default image settings if not exists
  db.prepare(`INSERT OR IGNORE INTO image_settings (id) VALUES ('default')`).run();

  // Add new columns if table existed before this migration
  const newImageCols = [
    'gen_mode', 'portrait_quality_prefix', 'cg_quality_prefix',
    'portrait_positive_node', 'portrait_negative_node',
    'cg_positive_node', 'cg_negative_node',
    'portrait_negative_prompt', 'cg_negative_prompt',
    'api_model', 'quality_prefix', 'image_size',
    // Workflow file selection (relative to project root); empty = built-in default
    'cg_workflow', 'portrait_workflow'
  ];
  for (const col of newImageCols) {
    try {
      db.prepare(`ALTER TABLE image_settings ADD COLUMN ${col} TEXT DEFAULT ''`).run();
    } catch (e) { /* Column already exists */ }
  }

  // Migrate pre-anima databases that still hold the untouched legacy default row.
  // The guard is deliberately narrow: `mode='none'` AND no API endpoint AND ComfyUI
  // still on its factory URL — i.e. the user never configured image generation at all.
  // Any deliberate choice (a real ComfyUI/API URL, a saved key) is left alone.
  try {
    db.prepare(`
      UPDATE image_settings
         SET mode = ?, api_url = ?, api_key = ?, api_model = ?, image_size = ?
       WHERE id = 'default'
         AND (mode IS NULL OR mode = 'none')
         AND COALESCE(api_url, '') = ''
         AND COALESCE(api_key, '') = ''
         AND COALESCE(comfyui_url, 'http://127.0.0.1:8188') = 'http://127.0.0.1:8188'
    `).run(ANIMA.MODE, ANIMA.API_URL, ANIMA.API_KEY, ANIMA.API_MODEL, ANIMA.IMAGE_SIZE);
  } catch (e) { /* Nothing to migrate */ }

  // --- App Settings (key-value store) ---
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`);
  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`)
    .run(APP_KEYS.GLOBAL_SYSTEM_PROMPT, getDefaultSystemPrompt());

  // Insert a blank placeholder API provider if none exists.
  // Share build: ships NO working credentials and no author-specific model name —
  // the user fills in base_url / api_key / model from the Settings UI.
  const existingProvider = db.prepare('SELECT COUNT(*) as cnt FROM api_providers WHERE is_default = 1').get();
  if (existingProvider.cnt === 0) {
    const { v4: uuidv4 } = require('uuid');
    const defaultProviderId = uuidv4();
    db.prepare(`
      INSERT INTO api_providers (id, name, provider_type, base_url, api_key, model, temperature, max_tokens, is_default)
      VALUES (?, 'My Provider', 'openai', 'http://127.0.0.1:8080/v1', '', '', 0.8, 4096, 1)
    `).run(defaultProviderId);
  }

  // --- Theme Settings ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS theme_settings (
      id              TEXT PRIMARY KEY DEFAULT 'default',
      theme_name      TEXT DEFAULT 'amber',
      css_variables   TEXT DEFAULT '{}',             -- JSON string: custom CSS vars
      is_custom       INTEGER DEFAULT 0
    )
  `);

  db.prepare(`INSERT OR IGNORE INTO theme_settings (id) VALUES ('default')`).run();

  // --- API Presets (imported from SillyTavern or manually configured) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_presets (
      id              TEXT PRIMARY KEY DEFAULT 'default',
      name            TEXT DEFAULT 'Default Preset',
      preset_type     TEXT DEFAULT 'chat',           -- 'chat' | 'image'
      data            TEXT DEFAULT '{}',             -- JSON: { temperature, top_p, top_k, ... }
      enabled_params  TEXT DEFAULT '[]',             -- JSON array of active parameter names
      is_default      INTEGER DEFAULT 1,
      imported_from   TEXT DEFAULT '',               -- source filename
      created_at      TEXT DEFAULT (datetime('now'))
    )
  `);

  // Insert default presets if none exist
  const existingPreset = db.prepare('SELECT COUNT(*) as cnt FROM api_presets').get();
  if (existingPreset.cnt === 0) {
    db.prepare(`INSERT INTO api_presets (id, name, preset_type, data, enabled_params) VALUES (?, ?, ?, ?, ?)`)
      .run('default', 'Default Chat Preset', 'chat',
        JSON.stringify({ temperature: 0.8, top_p: 0.95, top_k: 40, repetition_penalty: 1.1, frequency_penalty: 0, presence_penalty: 0, max_tokens: 4096 }),
        JSON.stringify(['temperature', 'top_p', 'max_tokens']));
    db.prepare(`INSERT INTO api_presets (id, name, preset_type, data, enabled_params, is_default) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('img-default', 'Default Image Preset', 'image',
        JSON.stringify({ steps: 20, cfg_scale: 7, sampler: 'euler', width: 1024, height: 1024 }),
        JSON.stringify(['steps', 'cfg_scale', 'width', 'height']), 0);
  }

  // --- Memory Agent Settings ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_agent_settings (
      id              TEXT PRIMARY KEY DEFAULT 'default',
      enabled         INTEGER DEFAULT 0,
      provider_id     TEXT DEFAULT '',
      prompt_template TEXT DEFAULT '',
      trigger_interval INTEGER DEFAULT 10,           -- messages between memory updates
      last_updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.prepare(`INSERT OR IGNORE INTO memory_agent_settings (id) VALUES ('default')`).run();

  // --- TTS Providers (independent from LLM api_providers) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tts_providers (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      api_key      TEXT DEFAULT '',
      model        TEXT NOT NULL DEFAULT 'tts-1',
      voice        TEXT NOT NULL DEFAULT 'alloy',
      speed        REAL DEFAULT 1.0,
      instruction  TEXT DEFAULT '',
      is_default   INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrate: add columns to tts_providers
  try { db.exec("ALTER TABLE tts_providers ADD COLUMN instruction TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE tts_providers ADD COLUMN api_format TEXT DEFAULT 'openai'"); } catch {}
  try { db.exec("ALTER TABLE tts_providers ADD COLUMN language TEXT DEFAULT 'zh-CN'"); } catch {}
  try { db.exec("ALTER TABLE tts_providers ADD COLUMN voice_map TEXT DEFAULT '{}'"); } catch {}

  // --- STscript Variables (local = conversation, global = user) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_vars (
      conversation_id TEXT NOT NULL,
      name            TEXT NOT NULL,
      value           TEXT DEFAULT '',
      type            TEXT DEFAULT 'string',   -- string | number | json
      PRIMARY KEY (conversation_id, name)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_global_vars (
      user_id TEXT NOT NULL,
      name    TEXT NOT NULL,
      value   TEXT DEFAULT '',
      type    TEXT DEFAULT 'string',
      PRIMARY KEY (user_id, name)
    )
  `);

  // --- Conversation script injection / author note columns ---
  try { db.exec("ALTER TABLE conversations ADD COLUMN script_injects TEXT DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE conversations ADD COLUMN author_note TEXT DEFAULT '{}'"); } catch {}

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

module.exports = { initDatabase, DB_PATH };

function getDefaultSystemPrompt() {
  return `【输出格式要求】
你必须使用以下模板格式输出，严禁使用 JSON。

=== 模板结构 ===

### mood
battle / blue / ceremony / relaxed / nomal / suspense
（每轮回复的第一行必须输出 ### mood 标签，描述本段剧情的氛围）

- 各标签对应氛围说明：
battle：战斗/暴力/破坏/激烈的性行为
blue：忧郁/忧伤/悲剧/葬礼
ceremony：重大场合/仪式/婚礼
relaxed：轻松/恋爱/热恋
nomal：默认
suspense：诡异/悬疑/危机

### portrait
（角色首次登场时必须输出此字段，已有头像的角色严禁再次输出。不为主角/玩家输出portrait）
name: 角色中文名
id: 角色编号
种族性别: 种族_性别格式，如 human_girl / human_boy / elf_girl / cat_furry_futa（奇幻题材用 elf/dwarf/orc，修仙题材用 cat_furry/dog_furry）
年龄段: youth / teen / adult / mature
发色: black_hair / brown_hair / ...
发长: long_hair / short_hair / ...
发型: ponytail / slicked_back / ...
刘海: blunt_bangs / swept_bangs / ...
瞳色: blue_eyes / brown_eyes / ...
身高: short_stature / medium_stature / tall_stature
身材: slender / muscular / ...
罩杯: small_breasts / medium_breasts / big_breasts / none（男性填none）
上衣: school_uniform / suit / ...
下装: pleated_skirt / pants / ...
性经验: 处 / 非处（中文）
贞操观: 高 / 中 / 低（中文）
社交性: 活泼 / 中等 / 内向（中文）
智商: 聪慧 / 普通 / 愚钝（中文）
道德: 善良 / 中立 / 邪恶（中文）
简要介绍: 一句话中文概括（如"来自北境的剑士，沉稳寡言"）
不要输出prompt字段！头像生图指令由系统自动从种族性别到上衣字段提取tag生成

### story
（剧情正文段落。叙述和对白混排——叙述部分正常写成段落，对白必须有角色名在前且用『』包裹。同一角色一次性说完所有话，不拆行。可多段 ### story。）
示例：夜风吹过荒原，艾琳站在月光下。艾琳：『你终于来了。』她的声音发颤。你：『你一直在等我？』

### cg
（当前剧情有NSFW场景时输出。标签须严格匹配当前场景语境。）
character/camera/pose/clothing/body/action/expression/background/count

### image
文件名.jpg（已生成图片时填写）

### status
（每轮回复末尾输出{{user}}当前状态，属性名: 属性值，每行一个属性）

### actions
- 选项1
- 选项2
（需要用户做选择时，每行一个选项，以 - 开头）

=== 核心规则 ===
0. 正文全部写在 ### story 段落中，叙述和对白混排，对白：角色名：『对白』（必须用中文直角引号『』）
1. 必须输出 ### story 段落作为正文，不可只输出状态和选项
2. 同一角色一次性说完所有话，不拆行
3. 只在新角色首次登场时输出 ### portrait
4. 每轮末尾必须输出 ### status
5. NSFW场景必须输出 ### cg`;
}

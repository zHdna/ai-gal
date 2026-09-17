/**
 * Character Card CRUD Routes
 * Supports SillyTavern character card import
 */
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isPathWithin } = require('../utils/pathGuard');
const savePaths = require('../savePaths');

// Avatar upload storage
const avatarDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'characters');
fs.mkdirSync(avatarDir, { recursive: true });
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: avatarDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: {
    fileSize: 50 * 1024 * 1024,   // 50MB — large PNG character cards
    fieldSize: 20 * 1024 * 1024,  // 20MB — large JSON data in form fields (world books etc.)
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});
/**
 * Normalize a world book entry to ensure all required fields exist
 * Compatible with SillyTavern V2 character_book format
 */
function normalizeEntry(entry) {
  if (!entry) return createDefaultEntry();
  return {
    id: entry.id ?? entry.uid ?? 0,
    keys: Array.isArray(entry.keys || entry.key) ? (entry.keys || entry.key) : [],
    secondary_keys: Array.isArray(entry.secondary_keys || entry.keysecondary)
      ? (entry.secondary_keys || entry.keysecondary) : [],
    comment: entry.comment || entry.name || '',
    content: entry.content || '',
    constant: entry.constant ?? false,
    selective: entry.selective ?? false,
    insertion_order: entry.insertion_order ?? entry.order ?? 100,
    enabled: entry.enabled ?? !entry.disable ?? true,
    position: entry.position ?? 'before_char',
    // Extended fields (SillyTavern extensions)
    extensions: {
      scan_depth: entry.extensions?.scan_depth ?? entry.scanDepth ?? null,
      match_whole_words: entry.extensions?.match_whole_words ?? entry.matchWholeWords ?? null,
      case_sensitive: entry.extensions?.case_sensitive ?? entry.caseSensitive ?? null,
      probability: entry.extensions?.probability ?? entry.probability ?? null,
      useProbability: entry.extensions?.useProbability ?? entry.useProbability ?? false,
      depth: entry.extensions?.depth ?? entry.depth ?? 4,
      role: entry.extensions?.role ?? entry.role ?? 0,
      exclude_recursion: entry.extensions?.exclude_recursion ?? entry.excludeRecursion ?? false,
      prevent_recursion: entry.extensions?.prevent_recursion ?? entry.preventRecursion ?? false,
      delay_until_recursion: entry.extensions?.delay_until_recursion ?? entry.delayUntilRecursion ?? false,
      selective_logic: entry.extensions?.selective_logic ?? entry.selectiveLogic ?? 0,
      group: entry.extensions?.group ?? entry.group ?? '',
      group_weight: entry.extensions?.group_weight ?? entry.groupWeight ?? null,
      use_group_scoring: entry.extensions?.use_group_scoring ?? entry.useGroupScoring ?? false,
      cooldown: entry.extensions?.cooldown ?? entry.cooldown ?? null,
      delay: entry.extensions?.delay ?? entry.delay ?? null,
      sticky: entry.extensions?.sticky ?? entry.sticky ?? null,
      ignore_budget: entry.extensions?.ignore_budget ?? entry.ignoreBudget ?? false,
      display_index: entry.extensions?.display_index ?? entry.displayIndex ?? 0,
      ...entry.extensions,
    },
  };
}

function createDefaultEntry() {
  return {
    id: 0, keys: [], secondary_keys: [], comment: '', content: '',
    constant: false, selective: false, insertion_order: 100, enabled: true,
    position: 'before_char',
    extensions: { depth: 4, role: 0, selective_logic: 0, group: '', display_index: 0 },
  };
}

/**
 * Detect whether a SillyTavern card uses custom "game markup" (Tavern Helper style):
 * custom tags <content>/<now_plot>/<pic>/<update>/<json_patch> + {name}「...」 dialogue,
 * or ships extensions.tavern_helper scripts.
 */
function isEngineCard(card) {
  if (!card || typeof card !== 'object') return false;
  const ext = card.extensions;
  if (ext && ext.tavern_helper) return true;
  const hay = [
    card.system_prompt, card.post_history_instructions, card.first_message, card.first_mes,
    card.description, card.mes_example,
    ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])
  ].filter(Boolean).join('\n');
  return /<content>|<now_plot>|<pic>|<\/?json_patch>|<update>|<UpdateVariables>|\{[^}\n]{1,30}\}「/.test(hay);
}

/**
 * Detect the UI contract a card expects:
 *  - hasMVU: the card uses engine markup / MVU variables (status bar must NOT be forced)
 *  - requiresStatus: the card itself asks for the legacy per-round status bar, so we
 *    keep injecting `### status` into prompts. MVU cards never require it.
 */
function cardMentionsStatus(card) {
  const hay = [
    card.system_prompt, card.post_history_instructions, card.first_message, card.first_mes,
    card.description, card.mes_example,
    ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])
  ].filter(Boolean).join('\n');
  return /状态栏|###\s*status|每轮.{0,10}状态|status\s*bar/i.test(hay);
}

function detectCardUI(card) {
  if (!card || typeof card !== 'object') return { hasMVU: false, requiresStatus: false };
  const hasMVU = isEngineCard(card);
  const requiresStatus = !hasMVU && cardMentionsStatus(card);
  return { hasMVU, requiresStatus };
}

/**
 * Extract MVU variable metadata from a character card.
 * Two sources:
 *  1. extensions.tavern_helper → "MVU脚本" → parse Zod schema (z.object top-level keys)
 *  2. character_book.entries   → "<variable_list>" → parse SAM-style type declarations
 *
 * Returns an object: { fields: { [dotPath]: { type, role, keyField?, hidden?, label? } } }
 *   type: "int" | "string" | "list[dict]" | "dict" | "record" | "bool"
 *   role: "character_list" | "asset_list" | "gauge" | "info" | "progress" | "generic"
 *   keyField: for list[dict], which field uniquely identifies each entry (e.g. "name")
 *   hidden: true if this variable should NOT be shown in the UI (still processed)
 *   label: human-readable display name
 */
function extractMvuMeta(card) {
  if (!card || typeof card !== 'object') return { fields: {} };
  const fields = {};

  // ---- Source 1: Zod Schema from tavern_helper ----
  try {
    const ext = card.extensions;
    if (ext && Array.isArray(ext.tavern_helper) && ext.tavern_helper[0] && ext.tavern_helper[0][1]) {
      const scripts = ext.tavern_helper[0][1];
      const mvuScript = scripts.find(s => s.name === 'MVU脚本' || s.name === 'MVU脚本');
      if (mvuScript && mvuScript.content) {
        parseZodSchemaForMeta(mvuScript.content, fields);
      }
    }
  } catch (e) { /* ignore */ }

  // ---- Source 2: SAM <variable_list> from character_book ----
  try {
    const cb = card.character_book;
    const entries = cb && cb.entries ? cb.entries : [];
    const varListEntry = entries.find(e =>
      e.content && e.content.includes('<variable_list>')
    );
    if (varListEntry) {
      parseSamVariableList(varListEntry.content, fields);
    }
    // Also scan SAM update rules for hidden variables
    const hiddenEntries = entries.filter(e =>
      e.content && (e.content.includes('__SAM_') || (e.comment && e.comment.startsWith('__')))
    );
    for (const he of hiddenEntries) {
      const name = he.comment || he.name || '';
      if (name.startsWith('__') && name.endsWith('__')) {
        const key = name.replace(/^__|__$/g, '');
        if (key && !fields[key]) {
          fields[key] = { type: 'dict', role: 'generic', hidden: true, label: key };
        }
      }
    }
  } catch (e) { /* ignore */ }

  return { fields: Object.keys(fields).length > 0 ? fields : null };
}

/**
 * Parse a Zod Schema script to extract top-level field metadata.
 * Only extracts keys at the FIRST indentation level (direct children of the root z.object).
 * Matches patterns like:
 *   contact: z.record(z.object({ ... }))
 *   chapter_manager: z.object({ ... })
 *   calendar: z.object({ ... }).optional()
 */
function parseZodSchemaForMeta(content, fields) {
  // Find the root Schema definition: "const Schema = z.object({"
  const schemaStart = content.indexOf('const Schema');
  if (schemaStart < 0) return;
  const objStart = content.indexOf('{', schemaStart);
  if (objStart < 0) return;

  // Walk at depth 1: collect the start positions of each top-level key declaration.
  // A top-level key appears at depth 1 as:  keyName: z.something
  let depth = 0;
  const topDecls = []; // { key, startPos }
  for (let i = objStart; i < content.length; i++) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') { depth--; if (depth === 0) break; }
    if (depth === 1) {
      // Look for "keyName: z." pattern at this position
      const rest = content.substring(i);
      const m = rest.match(/^(\w+)\s*:\s*z\./);
      if (m) {
        topDecls.push({ key: m[1], pos: i });
        i += m[0].length - 1; // skip past the match
      }
    }
  }

  for (const decl of topDecls) {
    const key = decl.key;
    // Get a generous snippet for type inspection (500 chars is enough for the z.xxx declaration)
    const rest = content.substring(decl.pos, decl.pos + 500);

    let type = 'dict', role = 'generic', keyField = null;

    // Detect z.record / z.object / z.enum / z.coerce.number / z.number / z.boolean / z.string
    if (/z\.record\s*\(/i.test(rest)) {
      type = 'record';
      if (/end_flag|appearance|relationship|clothing|lust|affection|location_info/i.test(rest)) {
        role = 'character_list'; keyField = '__record_key__';
      } else if (/evidence|inventory/i.test(rest)) {
        role = 'asset_list'; keyField = '__record_key__';
      }
    } else if (/z\.object\s*\(/i.test(rest)) {
      type = 'dict';
      if (/chapter|stage|phase|playthrough/i.test(rest)) { role = 'progress'; }
      else if (/time|location|weather|period|environment/i.test(rest)) { role = 'info'; }
      else if (/evidence|inventory/i.test(rest)) { role = 'asset_list'; }
    } else if (/z\.enum\s*\(/i.test(rest)) {
      type = 'string';
    } else if (/z\.coerce\.number/i.test(rest)) {
      type = 'int'; role = 'gauge';
    } else if (/z\.number/i.test(rest)) {
      type = 'int'; role = 'gauge';
    } else if (/z\.boolean/i.test(rest)) {
      type = 'bool';
    } else if (/z\.string/i.test(rest)) {
      type = 'string';
    }

    const hidden = key.startsWith('_') || key.startsWith('__');
    const label = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

    fields[key] = { type, role, ...(keyField && { keyField }), hidden, label };
  }
}

/**
 * Parse a SAM-style <variable_list> to extract variable metadata.
 * Matches patterns like:
 *   `string time`
 *   `int world.security_level`
 *   `list[dict] mc.stargazers`
 *   `list[string] mc.inventory`
 *
 * Also extracts Chinese descriptions from parentheses and section headers:
 *   **核心系统 (Core System)**   → group label for following variables
 *   `string time` (特殊变量, ISO 8601格式)  → label = "特殊变量, ISO 8601格式"
 */
function parseSamVariableList(content, fields) {
  // Extract content between <variable_list> and </variable_list>
  const listMatch = content.match(/<variable_list>([\s\S]*?)<\/variable_list>/);
  if (!listMatch) return;
  const body = listMatch[1];

  // Track current section header (Chinese group label)
  let currentGroup = '';
  let currentGroupZh = '';

  // Split into lines and process sequentially to capture section headers
  const lines = body.split('\n');
  const lineRe = /^\s*\*\s*`(int|string|bool|float|list\[dict\]|list\[string\]|dict|record)\s+([\w.]+)`(?:\s*[（(]([^)）]*)[)）])?/;
  const headerRe = /^\s*\*\*\s*(.+?)\s*\*\*/;

  for (const line of lines) {
    // Check for section header: **Chinese Name (`path`)**
    const hMatch = line.match(headerRe);
    if (hMatch) {
      const headerText = hMatch[1];
      // Extract Chinese name and path from "Chinese Name (`path`)" or "Chinese Name (English)"
      const parts = headerText.match(/^([^(（]+)[（(](.+?)[)）]/);
      if (parts) {
        currentGroupZh = parts[1].trim();
        currentGroup = parts[2].trim().replace(/[`]/g, '');
      } else {
        currentGroupZh = headerText.trim();
        currentGroup = '';
      }
      continue;
    }

    // Check for variable declaration
    const m = line.match(lineRe);
    if (!m) continue;

    const type = m[1].toLowerCase();
    const path = m[2];
    const parenDesc = m[3] || ''; // Chinese description in parentheses
    let role = 'generic';
    let keyField = null;
    const hidden = path.includes('.__') || path.startsWith('__');

    // Role inference based on path and type
    if (type === 'list[dict]') {
      if (/stargazer|character|contact|crew|member|person/i.test(path)) {
        role = 'character_list'; keyField = 'name';
      } else if (/ship|fleet|vessel|vehicle/i.test(path)) {
        role = 'asset_list'; keyField = /ship|fleet/.test(path) ? 'designation' : 'name';
      } else if (/industry|mission|quest|evidence|inventory/i.test(path)) {
        role = 'asset_list'; keyField = 'name';
      } else {
        role = 'asset_list';
      }
    } else if (type === 'int' || type === 'float') {
      if (/standings|reputation|affection|relationship|faction|ally/i.test(path)) {
        role = 'gauge';
      } else if (/level|security|health|hp|mp|mana|credit/i.test(path)) {
        role = 'gauge';
      } else {
        role = 'gauge';
      }
    } else if (type === 'string') {
      if (/time|location|weather|appearance/i.test(path)) {
        role = 'info';
      }
    }

    // Label priority: 1) Chinese description in parentheses > 2) last segment humanized
    // (section header is used as `group` only, NOT as label — it's a category name, not a field name)
    const segments = path.split('.');
    const lastSegment = segments[segments.length - 1].replace(/_/g, ' ');
    let label;
    if (parenDesc) {
      label = parenDesc.trim();
    } else {
      label = lastSegment;
    }

    fields[path] = {
      type, role, ...(keyField && { keyField }), hidden, label,
      ...(currentGroupZh && { group: currentGroupZh })
    };
  }
}

/**
 * Pick the best greeting for an engine card. If first_message is a bare placeholder
 * (e.g. 【扣扣审判封面】), prefer the richest alternate greeting that contains narrative
 * markup, so the imported greeting actually shows the intended rendered content.
 */
function pickEngineGreeting(card) {
  const fm = card.first_message || card.first_mes || '';
  const isPlaceholder = /^【[^】]{0,40}】\s*$/.test((fm || '').trim());
  if (!isPlaceholder) return fm;
  const ags = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
  const rich = ags.find(g => /<content>|<now_plot>|<pic>/.test(g));
  if (rich) return rich;
  if (ags.length) return ags.reduce((a, b) => (b && b.length > (a ? a.length : 0) ? b : a), '');
  return fm;
}

module.exports = (db) => {
  const router = Router();

  // List all characters
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT id, name, title, description, avatar, tags, created_at FROM characters ORDER BY created_at DESC').all();
    res.json(rows);
  });

  // Get single character (full detail)
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    res.json(row);
  });

  // Partial update: markup_mode / asset_base_path (used by frontend engine-card settings)
  router.patch('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    const fields = {};
    if (req.body.markup_mode !== undefined) fields.markup_mode = String(req.body.markup_mode);
    if (req.body.asset_base_path !== undefined) fields.asset_base_path = String(req.body.asset_base_path);
    if (Object.keys(fields).length === 0) return res.json({ message: 'no changes' });

    const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE characters SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
      .run(...Object.values(fields), req.params.id);

    res.json({ message: 'Character updated', fields });
  });

  // Serve <pic> illustration assets from the character's asset_base_path (Tier 2)
  // URL: /api/characters/:id/asset/<relative path inside asset_base_path>
  // Path-traversal protected; tries common image extensions when none given.
  const ASSET_EXTS = ['', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'];
  router.get('/:id/asset/*', (req, res) => {
    const row = db.prepare('SELECT asset_base_path FROM characters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    const base = (row.asset_base_path || '').trim();
    if (!base) return res.status(404).json({ error: 'asset_base_path not configured' });

    const rel = req.params[0] || '';
    if (!rel) return res.status(400).json({ error: 'missing asset path' });

    // Resolve and enforce it stays within base (block ../ traversal)
    const baseResolved = path.resolve(base);
    const resolved = path.resolve(baseResolved, rel);
    if (!isPathWithin(baseResolved, resolved)) {
      return res.status(400).json({ error: 'invalid asset path' });
    }

    for (const ext of ASSET_EXTS) {
      const candidate = ext ? resolved + ext : resolved;
      // Re-validate candidate (with appended extension) still within base dir
      if (!isPathWithin(baseResolved, candidate)) continue;
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return res.sendFile(candidate);
        }
      } catch (e) { /* ignore and continue */ }
    }
    return res.status(404).json({ error: 'asset not found' });
  });

  // Import SillyTavern character card (V2/V1 compatible)
  router.post('/import', (req, res) => {
    const data = req.body;
    // Unwrap SillyTavern V2 nested card if present ({ data: { ... } })
    if (data && data.data && (data.data.first_mes !== undefined || data.data.first_message !== undefined || data.data.alternate_greetings || data.data.extensions)) {
      Object.assign(data, data.data);
    }

    // SillyTavern character card field mapping
    // Supports both V2 (data.{field}) and V1 (top-level) formats
    const name = data.name || data.Character || 'Unknown';
    const title = data.title || '';
    const description = data.description || '';
    const personality = data.personality || '';
    const scenario = data.scenario || '';
    const first_message = pickEngineGreeting(data) || data.greeting || data.firstmsg || '';
    const system_prompt = data.system_prompt || '';
    const post_history_instructions = data.post_history_instructions || '';
    const character_book = data.character_book ? JSON.stringify(data.character_book) : '';
    const mes_example = data.mes_example ? JSON.stringify(data.mes_example) : '';
    const creator_notes = data.creator_notes || '';
    const tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : (typeof data.tags === 'string' ? data.tags : '[]');
    const avatar = data.avatar || data.char_image || '';
    // Engine card detection → markup_mode; asset_base_path from body override or '' (user sets later)
    const markup_mode = data.markup_mode || (isEngineCard(data) ? 'game-xml' : '');
    const asset_base_path = data.asset_base_path || '';
    // Persist detected UI contract (MVU vs legacy status bar) so prompts can adapt.
    const ui = detectCardUI(data);
    const metadata = JSON.stringify({ ui_hints: ui });
    // Extract MVU variable schema metadata for intelligent rendering
    const mvu_meta = JSON.stringify(extractMvuMeta(data));

    const id = uuidv4();
    db.prepare(`
      INSERT INTO characters (id, name, title, description, personality, scenario, first_message,
        system_prompt, post_history_instructions, character_book, book_activation, mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path, metadata, mvu_meta, excluded_names)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, title, description, personality, scenario, first_message,
      system_prompt, post_history_instructions, character_book, 'on', mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path, metadata, mvu_meta, JSON.stringify([name]));

    // Allocate master save folder for this game
    try { savePaths.ensureMasterDir(db, id); } catch (e) { /* ignore */ }

    res.status(201).json({ id, name, markup_mode, ui_hints: ui, mvu_meta: extractMvuMeta(data), message: 'Character imported' });
  });

  // Import PNG character card with avatar file (FormData)
  router.post('/import/file', (req, res, next) => {
    avatarUpload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'PNG 文件过大，请压缩图片后重试（最大 50MB）' });
        }
        if (err.code === 'LIMIT_FIELD_SIZE') {
          return res.status(413).json({ error: '角色卡数据过大（世界书/对话示例等），请精简后重试（最大 20MB）' });
        }
        return res.status(400).json({ error: `文件上传失败: ${err.message}` });
      }
      if (!req.body.json) return res.status(400).json({ error: 'Missing JSON data' });

      // 读取文件前8字节验证 magic bytes
      if (req.file) {
        try {
          const fd = fs.openSync(req.file.path, 'r');
          const buf = Buffer.alloc(8);
          fs.readSync(fd, buf, 0, 8, 0);
          fs.closeSync(fd);
          const isPNG = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
          const isJPEG = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
          if (!isPNG && !isJPEG) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'File is not a valid image' });
          }
        } catch (e) {
          // magic bytes 校验失败时拒绝该文件
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(400).json({ error: 'File is not a valid image' });
        }
      }

      let data;
      try {
        data = JSON.parse(req.body.json);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      // Unwrap SillyTavern V2 nested card if present ({ data: { ... } })
      if (data && data.data && (data.data.first_mes !== undefined || data.data.first_message !== undefined || data.data.alternate_greetings || data.data.extensions)) {
        Object.assign(data, data.data);
      }

      const name = data.name || data.Character || 'Unknown';
      const title = data.title || '';
      const description = data.description || '';
      const personality = data.personality || '';
      const scenario = data.scenario || '';
      const first_message = pickEngineGreeting(data) || data.greeting || data.firstmsg || '';
      const system_prompt = data.system_prompt || '';
      const post_history_instructions = data.post_history_instructions || '';
      const character_book = data.character_book ? JSON.stringify(data.character_book) : '';
      const mes_example = data.mes_example ? JSON.stringify(data.mes_example) : '';
      const creator_notes = data.creator_notes || '';
      const tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : (typeof data.tags === 'string' ? data.tags : '[]');

      // Avatar: use uploaded file path if present, otherwise fall back to data.avatar/char_image
      let avatar = '';
      if (req.file) {
        avatar = '/uploads/characters/' + req.file.filename;
      } else {
        avatar = data.avatar || data.char_image || '';
      }

      const markup_mode = data.markup_mode || (isEngineCard(data) ? 'game-xml' : '');
      const asset_base_path = data.asset_base_path || '';
      // Persist detected UI contract (MVU vs legacy status bar) so prompts can adapt.
      const ui = detectCardUI(data);
      const metadata = JSON.stringify({ ui_hints: ui });
      // Extract MVU variable schema metadata for intelligent rendering
      const mvu_meta = JSON.stringify(extractMvuMeta(data));

      const id = uuidv4();
      db.prepare(`
        INSERT INTO characters (id, name, title, description, personality, scenario, first_message,
          system_prompt, post_history_instructions, character_book, book_activation, mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path, metadata, mvu_meta, excluded_names)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, title, description, personality, scenario, first_message,
        system_prompt, post_history_instructions, character_book, 'on', mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path, metadata, mvu_meta, JSON.stringify([name]));

      // Allocate master save folder for this game
      try { savePaths.ensureMasterDir(db, id); } catch (e) { /* ignore */ }

      res.status(201).json({ id, name, markup_mode, ui_hints: ui, mvu_meta: extractMvuMeta(data), message: 'Character imported' });
    });
  });

  // Create character (manual)
  router.post('/', (req, res) => {
    const { name, title, description, personality, scenario, first_message, system_prompt, post_history_instructions, character_book, book_activation, mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path } = req.body;

    if (!name) return res.status(400).json({ error: 'Character name is required' });

    const id = uuidv4();
    const metadata = typeof req.body.metadata === 'object' ? JSON.stringify(req.body.metadata) : '{}';
    db.prepare(`
      INSERT INTO characters (id, name, title, description, personality, scenario, first_message,
        system_prompt, post_history_instructions, character_book, book_activation, mes_example, creator_notes, tags, avatar, markup_mode, asset_base_path, metadata, excluded_names)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, title || '', description || '', personality || '', scenario || '', first_message || '',
      system_prompt || '', post_history_instructions || '', character_book || '', book_activation || 'off', mes_example || '', creator_notes || '',
      JSON.stringify(tags || []), avatar || '', markup_mode || '', asset_base_path || '', metadata, JSON.stringify([name]));

    // Allocate master save folder for this game
    try { savePaths.ensureMasterDir(db, id); } catch (e) { /* ignore */ }

    res.status(201).json({ id, name, message: 'Character created' });
  });

  // Update character
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    const { name, title, description, personality, scenario, first_message, system_prompt, post_history_instructions, character_book, book_activation, mes_example, creator_notes, tags, avatar, metadata, markup_mode, asset_base_path } = req.body;
    const metadataStr = (metadata && typeof metadata === 'object') ? JSON.stringify(metadata) : undefined;

    db.prepare(`
      UPDATE characters SET
        name = COALESCE(?, name),
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        personality = COALESCE(?, personality),
        scenario = COALESCE(?, scenario),
        first_message = COALESCE(?, first_message),
        system_prompt = COALESCE(?, system_prompt),
        post_history_instructions = COALESCE(?, post_history_instructions),
        character_book = COALESCE(?, character_book),
        book_activation = COALESCE(?, book_activation),
        mes_example = COALESCE(?, mes_example),
        creator_notes = COALESCE(?, creator_notes),
        tags = COALESCE(?, tags),
        avatar = COALESCE(?, avatar),
        metadata = COALESCE(?, metadata),
        markup_mode = COALESCE(?, markup_mode),
        asset_base_path = COALESCE(?, asset_base_path),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name, title, description, personality, scenario, first_message, system_prompt,
      post_history_instructions, character_book, book_activation, mes_example, creator_notes,
      tags !== undefined ? JSON.stringify(tags) : null,
      avatar, metadataStr,
      markup_mode !== undefined ? markup_mode : null,
      asset_base_path !== undefined ? asset_base_path : null,
      req.params.id
    );

    res.json({ message: 'Character updated' });
  });

  // ─── World Book / Character Book Entry APIs ───

  // Get world book entries for a character
  router.get('/:id/book', (req, res) => {
    const row = db.prepare('SELECT character_book, book_activation FROM characters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    try {
      const book = row.character_book ? JSON.parse(row.character_book) : { entries: [] };
      // Normalize: entries can be array or object (ST uses object with numeric keys)
      let entries = book.entries || [];
      if (!Array.isArray(entries) && typeof entries === 'object') {
        entries = Object.values(entries);
      }
      // Normalize each entry to ensure required fields exist
      entries = entries.map(normalizeEntry);
      res.json({ entries, book_activation: row.book_activation || 'off', name: book.name || '' });
    } catch (e) {
      res.json({ entries: [], book_activation: row.book_activation || 'off', name: '' });
    }
  });

  // Update world book entries (full replacement)
  router.put('/:id/book', (req, res) => {
    const existing = db.prepare('SELECT character_book FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    const { entries, book_activation, name } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array' });

    // Normalize and validate each entry
    const normalizedEntries = entries.map(normalizeEntry);

    // Re-index entries with sequential IDs
    normalizedEntries.forEach((e, i) => { e.id = i; });

    const bookObj = {
      name: name || '',
      entries: normalizedEntries
    };

    db.prepare('UPDATE characters SET character_book = ?, book_activation = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(bookObj), book_activation || 'off', req.params.id);

    res.json({ message: 'World book updated', entry_count: normalizedEntries.length });
  });

  // Update a single entry (by entry id)
  router.put('/:id/book/entry/:entryId', (req, res) => {
    const existing = db.prepare('SELECT character_book FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    try {
      const book = existing.character_book ? JSON.parse(existing.character_book) : { entries: [] };
      let entries = book.entries || [];
      if (!Array.isArray(entries) && typeof entries === 'object') {
        entries = Object.values(entries);
      }

      const entryId = parseInt(req.params.entryId);
      const idx = entries.findIndex(e => (e.id !== undefined ? e.id : e.uid) === entryId);
      if (idx === -1) return res.status(404).json({ error: 'Entry not found' });

      // Merge updates into existing entry
      entries[idx] = { ...normalizeEntry(entries[idx]), ...req.body, id: entryId };

      book.entries = entries;
      db.prepare('UPDATE characters SET character_book = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(book), req.params.id);

      res.json({ message: 'Entry updated', entry: entries[idx] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Add a new entry
  router.post('/:id/book/entry', (req, res) => {
    const existing = db.prepare('SELECT character_book FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    try {
      const book = existing.character_book ? JSON.parse(existing.character_book) : { entries: [] };
      let entries = book.entries || [];
      if (!Array.isArray(entries) && typeof entries === 'object') {
        entries = Object.values(entries);
      }

      const newId = entries.length > 0 ? Math.max(...entries.map(e => e.id !== undefined ? e.id : (e.uid || 0))) + 1 : 0;
      const newEntry = normalizeEntry({ ...req.body, id: newId });

      entries.push(newEntry);
      book.entries = entries;
      db.prepare('UPDATE characters SET character_book = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(book), req.params.id);

      res.status(201).json({ message: 'Entry added', entry: newEntry });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete an entry
  router.delete('/:id/book/entry/:entryId', (req, res) => {
    const existing = db.prepare('SELECT character_book FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    try {
      const book = existing.character_book ? JSON.parse(existing.character_book) : { entries: [] };
      let entries = book.entries || [];
      if (!Array.isArray(entries) && typeof entries === 'object') {
        entries = Object.values(entries);
      }

      const entryId = parseInt(req.params.entryId);
      const beforeLen = entries.length;
      entries = entries.filter(e => (e.id !== undefined ? e.id : (e.uid || -1)) !== entryId);

      if (entries.length === beforeLen) return res.status(404).json({ error: 'Entry not found' });

      book.entries = entries;
      db.prepare('UPDATE characters SET character_book = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(book), req.params.id);

      res.json({ message: 'Entry deleted' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Toggle entry enabled/disabled
  router.patch('/:id/book/entry/:entryId/toggle', (req, res) => {
    const existing = db.prepare('SELECT character_book FROM characters WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Character not found' });

    try {
      const book = existing.character_book ? JSON.parse(existing.character_book) : { entries: [] };
      let entries = book.entries || [];
      if (!Array.isArray(entries) && typeof entries === 'object') {
        entries = Object.values(entries);
      }

      const entryId = parseInt(req.params.entryId);
      const entry = entries.find(e => (e.id !== undefined ? e.id : (e.uid || -1)) === entryId);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });

      entry.enabled = !entry.enabled;

      book.entries = entries;
      db.prepare('UPDATE characters SET character_book = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(book), req.params.id);

      res.json({ message: 'Entry toggled', enabled: entry.enabled });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete character
  router.delete('/:id', (req, res) => {
    // Capture game_dir before deleting the row (so we can remove the master folder)
    let gameDir = '';
    try {
      const cur = db.prepare('SELECT game_dir FROM characters WHERE id = ?').get(req.params.id);
      if (cur) gameDir = cur.game_dir || '';
    } catch (e) { /* ignore */ }

    // Delete child records (FK constraints: conversations → characters, messages → conversations, saves → conversations)
    const convs = db.prepare('SELECT id FROM conversations WHERE character_id = ?').all(req.params.id);
    convs.forEach(c => {
      db.prepare('DELETE FROM saves WHERE conversation_id = ?').run(c.id);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
    });
    db.prepare('DELETE FROM conversations WHERE character_id = ?').run(req.params.id);
    const count = db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
    if (!count.changes) return res.status(404).json({ error: 'Character not found' });

    // Remove the master save folder (boundary-checked) so it isn't orphaned
    if (gameDir && /^\/?game\d+$/.test(gameDir)) {
      try {
        const masterPath = path.join(savePaths.SAVES_DIR, gameDir);
        const resolved = path.resolve(masterPath);
        if (isPathWithin(savePaths.SAVES_DIR, resolved)) {
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      } catch (e) { /* ignore */ }
    }

    res.json({ message: 'Character deleted' });
  });

  return router;
};

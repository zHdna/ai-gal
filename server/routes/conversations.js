/**
 * Conversations CRUD Routes
 */
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const { ROSTER_FILE } = require('../constants');
const { applyWorldStateFromText, seedFromStateBlock } = require('../utils/jsonpatch');
const savePaths = require('../savePaths');

// Saves directory
const SAVES_DIR = path.join(__dirname, '..', '..', 'saves');

/**
 * Extract character names from first_message text.
 * Looks for multiple patterns:
 * 1. 👥 在场：name1、name2 (status header field)
 * 2. name：『dialogue』 where name contains Chinese characters (excludes emoji-only speakers)
 * 3. name：『dialogue』 where name contains · (western names like 汤姆·里德尔)
 */
function extractCharacterNamesFromFirstMessage(text) {
  if (!text) return [];
  const names = new Set();

  // Generic terms that should never be treated as character names (substring match)
  const genericPatterns = /(工作人员|路人|士兵|学生|村民|民众|群众|岛民|居民|警官|警察|护士|医生|老师|店主|商人|侍者|仆人)/;
  // Terms that indicate a place, not a person (suffix match)
  const placePatterns = /(岛|学院|学校|港口|城市|村|镇|山|河|海|塔|城|殿|宫|馆|院|寺|庙|园|园|栈桥|码头)$/;

  // Pattern 1: 👥 在场：field — extract names separated by 、
  const presentMatch = text.match(/👥\s*在场[：:]\s*(.+?)(?:\n|$)/);
  if (presentMatch && presentMatch[1]) {
    const raw = presentMatch[1].trim();
    // Split by 、 or , and filter out generic terms
    const parts = raw.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      // Remove count suffix like ×3 or x3
      const cleaned = part.replace(/[×x]\d+$/i, '').trim();
      // Skip if too short, contains generic words, or looks like a place
      if (cleaned.length >= 2 && !genericPatterns.test(cleaned) && !placePatterns.test(cleaned)) {
        names.add(cleaned);
      }
    }
  }

  // Pattern 2: Chinese-name：『dialogue』 (name must contain at least one CJK character)
  // Excludes emoji-only speakers and common pronouns
  const dialogMatches = text.matchAll(/([\u4e00-\u9fff\u3400-\u4dbf][\w\u4e00-\u9fff\u3400-\u4dbf·\-]{1,15})[：:]\s*『/g);
  const pronouns = new Set(['你', '我', '他', '她', '它', '旁白', '叙事', '系统', '画面']);
  for (const m of dialogMatches) {
    if (m[1] && !pronouns.has(m[1]) && !genericPatterns.test(m[1])) {
      names.add(m[1].trim());
    }
  }

  // Pattern 3: 「name」 mentioned as character introduction
  const bracketMatches = text.matchAll(/「([\u4e00-\u9fff\u3400-\u4dbf][\w\u4e00-\u9fff\u3400-\u4dbf·\-]{1,15})」/g);
  for (const m of bracketMatches) {
    if (m[1] && !pronouns.has(m[1]) && !genericPatterns.test(m[1]) && !placePatterns.test(m[1])) {
      names.add(m[1].trim());
    }
  }

  return [...names];
}

module.exports = (db) => {
  const router = Router();

  // List all conversations
  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT c.*, ch.name as character_name, ch.avatar as character_avatar,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
        (SELECT s.id FROM saves s WHERE s.conversation_id = c.id ORDER BY s.created_at DESC LIMIT 1) as save_id
      FROM conversations c
      LEFT JOIN characters ch ON c.character_id = ch.id
      ORDER BY c.updated_at DESC
    `).all();
    res.json(rows);
  });

  // Get single conversation
  router.get('/:id', (req, res) => {
    const row = db.prepare(`
      SELECT c.*, ch.name as character_name, ch.avatar as character_avatar,
        (SELECT s.id FROM saves s WHERE s.conversation_id = c.id ORDER BY s.created_at DESC LIMIT 1) as save_id
      FROM conversations c
      LEFT JOIN characters ch ON c.character_id = ch.id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Conversation not found' });
    res.json(row);
  });

  // Get DETAILED character roster (with 种族性别 / 年龄) for this conversation.
  // conversations.character_roster only stores name arrays (no detail); the full
  // detail lives in saves/{saveId}/character_roster.json. We match each recorded
  // name across ALL save folders (exact + fuzzy) so the front-end TTS voice mapping
  // always gets gender/age even if the "current" save lacks the entry.
  router.get('/:id/roster', (req, res) => {
    try {
      const conv = db.prepare('SELECT character_roster, character_id FROM conversations WHERE id = ?').get(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      let names = [];
      try { names = JSON.parse(conv.character_roster || '[]'); } catch { names = []; }
      const detail = {};

      // Scan this character's game folder (all sub-saves) for roster detail first,
      // then fall back to a global recursive scan for legacy/edge cases.
      const scanRoots = [];
      if (conv.character_id) {
        const gameDir = savePaths.getGameDir(db, conv.character_id);
        if (gameDir) {
          const gd = path.join(savePaths.SAVES_DIR, gameDir);
          if (fs.existsSync(gd)) scanRoots.push(gd);
        }
      }
      scanRoots.push(savePaths.SAVES_DIR); // global fallback

      const merged = {};
      for (const root of scanRoots) {
        for (const r of savePaths.collectRostersRecursive(root)) {
          Object.assign(merged, r);
        }
      }

      for (const n of names) {
        if (detail[n] || !n) continue;
        if (merged[n]) { detail[n] = merged[n]; continue; }
        for (const k of Object.keys(merged)) {
          if (k.includes(n) || n.includes(k)) { detail[n] = merged[k]; break; }
        }
      }
      res.json({ roster: detail });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create conversation
  router.post('/', (req, res) => {
    const { character_id, title, system_prompt } = req.body;

    const id = uuidv4();

    // Auto-create save folder (used as conversation title)
    const now = new Date();
    const saveId = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
      String(now.getMilliseconds()).padStart(3, '0'),
      Math.random().toString(36).slice(2, 6)
    ].join('');
    const savePath = character_id
      ? savePaths.getSubSaveDir(db, character_id, saveId)
      : path.join(SAVES_DIR, saveId);
    fs.mkdirSync(savePath, { recursive: true });

    // Use save_id as title if no title provided
    const convTitle = title || saveId;

    db.prepare(`
      INSERT INTO conversations (id, character_id, title, system_prompt)
      VALUES (?, ?, ?, ?)
    `).run(id, character_id || null, convTitle, system_prompt || '');

    // If character has a first message, auto-insert it
    if (character_id) {
      const char = db.prepare('SELECT first_message, name, markup_mode FROM characters WHERE id = ?').get(character_id);
      if (char && char.first_message) {
        const msgId = uuidv4();
        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, formatted)
          VALUES (?, ?, 'assistant', ?, '{}')
        `).run(msgId, id, char.first_message);

        // Seed MVU world_state from engine-card greeting — supports:
        //   <json_patch> / <JSONPatch>           (RFC 6902, standard MVU)
        //   <UpdateVariables>                     (Tavern Helper SQL dialect)
        //   <variable_update_call_format>         (SAM-style)
        //   <|state|>...</|state|>               (card initial-state JSON block)
        const greetingHasVars = /<json_patch>|<JSONPatch>|<UpdateVariables>|<UpdateVariable>|<variable_update_call_format>|<\|state\|>/.test(char.first_message || '');
        if (char.markup_mode === 'game-xml' || greetingHasVars) {
          try {
            // First try <|state|> block seeding (card style — flattens static.* prefix)
            let seeded = seedFromStateBlock(char.first_message || '');
            // Then apply any <json_patch>/<UpdateVariables>/<variable_update_call_format> blocks
            seeded = applyWorldStateFromText(seeded || {}, char.first_message || '');
            const seededStr = JSON.stringify(seeded);
            if (seededStr && seededStr !== '{}') {
              db.prepare('UPDATE conversations SET world_state = ? WHERE id = ?').run(seededStr, id);
              console.log('[Conversation] Seeded world_state from greeting (json_patch + UpdateVariables + state block)');
            }
          } catch (e) {
            console.error('[Conversation] world_state seed error:', e.message);
          }
        }

        // Pre-populate roster from first_message — extract speaking characters
        // so butler AI can see them as "无头像" on the first user turn
        try {
          const charNames = extractCharacterNamesFromFirstMessage(char.first_message);
          // Filter out the character card name itself (card has its own avatar)
          const filtered = charNames.filter(n => n !== char.name);
          if (filtered.length > 0) {
            const rosterPath = path.join(savePath, ROSTER_FILE);
            const roster = {};
            for (const name of filtered) {
              roster[name] = {
                name,
                avatar: '',  // empty = no avatar (needs generation)
              };
            }
            fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf-8');
            console.log('[Conversation] Pre-populated roster from first_message:', filtered.join(', '));

            // Also set DB roster so butler sees it immediately
            db.prepare('UPDATE conversations SET character_roster = ? WHERE id = ?')
              .run(JSON.stringify(filtered), id);
          }
        } catch (e) {
          console.error('[Conversation] Roster pre-population error:', e.message);
        }
      }
    }

    // Auto-create save record (folder already created above)
    db.prepare('INSERT INTO saves (id, conversation_id, character_id, save_path) VALUES (?, ?, ?, ?)')
      .run(saveId, id, character_id || null, savePath);

    res.status(201).json({ id, message: 'Conversation created', save_id: saveId });
  });

  // Update conversation (e.g., update title, system_prompt, memory_context)
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const { title, system_prompt, memory_context } = req.body;

    // Validate: non-null strings must be non-empty and within length limits
    if (title !== undefined && title !== null && !String(title).trim()) {
      return res.status(400).json({ error: '标题不能为空字符串' });
    }
    if (title !== undefined && title !== null && String(title).length > 200) {
      return res.status(400).json({ error: '标题过长（最大200字符）' });
    }
    if (system_prompt !== undefined && system_prompt !== null && String(system_prompt).length > 50000) {
      return res.status(400).json({ error: '系统提示词过长（最大50000字符）' });
    }

    db.prepare(`
      UPDATE conversations SET
        title = COALESCE(?, title),
        system_prompt = COALESCE(?, system_prompt),
        memory_context = COALESCE(?, memory_context),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      title, system_prompt,
      memory_context !== undefined ? JSON.stringify(memory_context) : null,
      req.params.id
    );

    res.json({ message: 'Conversation updated' });
  });

  // Delete conversation (cascades to messages)
  router.delete('/:id', (req, res) => {
    // Delete child records first (FK constraints)
    db.prepare('DELETE FROM saves WHERE conversation_id = ?').run(req.params.id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id);
    const count = db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
    if (!count.changes) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ message: 'Conversation deleted' });
  });

  // Clear all messages in a conversation (keep the conversation itself)
  // Query: ?reopen=true to re-insert the character's first_message after clearing
  router.delete('/:id/messages', (req, res) => {
    const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id);

    // Re-insert character's first_message if requested
    if (req.query.reopen === 'true' && existing.character_id) {
      const char = db.prepare('SELECT first_message, name FROM characters WHERE id = ?').get(existing.character_id);
      if (char && char.first_message) {
        const msgId = require('uuid').v4();
        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, formatted, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', datetime('now'))
        `).run(msgId, req.params.id, char.first_message);

        // Re-populate roster from first_message
        try {
          const charNames = extractCharacterNamesFromFirstMessage(char.first_message);
          const filtered = charNames.filter(n => n !== char.name);
          if (filtered.length > 0) {
            const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
            if (save) {
              const rosterPath = path.join(save.save_path, ROSTER_FILE);
              const roster = {};
              for (const name of filtered) {
                roster[name] = { name, avatar: '' };
              }
              fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf-8');
              console.log('[Conversation] Re-populated roster from first_message:', filtered.join(', '));
            }
            db.prepare('UPDATE conversations SET character_roster = ? WHERE id = ?')
              .run(JSON.stringify(filtered), req.params.id);
          } else {
            // No characters found — clear roster
            db.prepare('UPDATE conversations SET character_roster = ? WHERE id = ?')
              .run('[]', req.params.id);
          }
        } catch (e) {
          console.error('[Conversation] Roster re-population error:', e.message);
        }
      }
    }

    res.json({ message: 'Messages cleared' });
  });

  // Export conversation: ?mode=summary (main window only) | full (complete output)
  router.get('/:id/export', (req, res) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(req.params.id);

    const mode = req.query.mode || 'summary';
    const charName = conv.character_id
      ? (db.prepare('SELECT name FROM characters WHERE id = ?').get(conv.character_id)?.name || 'AI')
      : 'AI';

    if (mode === 'full') {
      // Full export: all fields including formatted, hidden status
      const exportData = {
        title: conv.title,
        character_name: charName,
        exported_at: new Date().toISOString(),
        mode: 'full',
        messages: messages.map(msg => {
          let formatted = {};
          try { formatted = JSON.parse(msg.formatted || '{}'); } catch { /* ignore */ }
          return {
            id: msg.id,
            role: msg.role,
            content: msg.content,
            formatted,
            hidden: !!msg.hidden,
            created_at: msg.created_at,
          };
        }),
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="conversation-${conv.id}-full.json"`);
      res.json(exportData);
    } else {
      // Summary export: main window content only (narrative + dialogue)
      const lines = [];
      for (const msg of messages) {
        if (msg.hidden) continue; // Skip hidden messages in summary

        let formatted = {};
        try { formatted = JSON.parse(msg.formatted || '{}'); } catch { /* ignore */ }

        const time = msg.created_at || '';
        const prefix = msg.role === 'user' ? '【你】' : `【${charName}】`;

        if (msg.role === 'user') {
          lines.push(`${prefix}${msg.content}`);
        } else {
          // Extract text, action, emotion, internal for summary
          const parts = [];
          if (formatted.emotion) parts.push(`[${formatted.emotion}]`);
          if (formatted.text) parts.push(formatted.text);
          if (formatted.action) parts.push(`*${formatted.action}*`);
          if (formatted.internal) parts.push(`(内心：${formatted.internal})`);
          if (parts.length > 0) {
            lines.push(`${prefix}${parts.join(' ')}`);
          } else {
            lines.push(`${prefix}${msg.content}`);
          }
        }
      }

      const text = lines.join('\n\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="conversation-${conv.id}-summary.txt"`);
      res.send(text);
    }
  });

  // ===================== STscript 提示词注入 / 作者备注 (Phase 4) =====================
  // GET  /:id/script-injects  -> { injects, authorNote, state }
  // POST /:id/script-injects  -> op: add | flush | setNote | setState
  function parseJsonField(row, field, fallback) {
    if (!row || row[field] == null) return fallback;
    try { const v = JSON.parse(row[field]); return v == null ? fallback : v; } catch { return fallback; }
  }
  function getScriptInjectData(convId) {
    const row = db.prepare('SELECT script_injects, author_note, script_inject_state FROM conversations WHERE id = ?').get(convId);
    if (!row) return null;
    return {
      injects: parseJsonField(row, 'script_injects', []),
      authorNote: parseJsonField(row, 'author_note', {}),
      state: parseJsonField(row, 'script_inject_state', {}),
    };
  }

  router.get('/:id/script-injects', (req, res) => {
    const data = getScriptInjectData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Conversation not found' });
    res.json(data);
  });

  router.post('/:id/script-injects', (req, res) => {
    const convId = req.params.id;
    const row = db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId);
    if (!row) return res.status(404).json({ error: 'Conversation not found' });

    const body = req.body || {};
    const { op } = body;
    const data = getScriptInjectData(convId);

    if (op === 'add') {
      const content = (body.content || '').toString();
      if (!content.trim()) return res.status(400).json({ error: 'content required' });
      const inj = {
        id: 'inj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        role: body.role === 'system' ? 'system' : 'user',
        position: body.position === 'sys' ? 'sys' : 'chat',
        depth: typeof body.depth === 'number' ? body.depth : (parseInt(body.depth, 10) || 0),
        content,
      };
      data.injects.push(inj);
      db.prepare("UPDATE conversations SET script_injects = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(data.injects), convId);
      return res.json({ inject: inj, injects: data.injects });
    }

    if (op === 'flush') {
      db.prepare("UPDATE conversations SET script_injects = ?, updated_at = datetime('now') WHERE id = ?")
        .run('[]', convId);
      return res.json({ injects: [] });
    }

    if (op === 'setNote') {
      const note = {
        content: (body.content || '').toString(),
        position: body.position === 'sys' ? 'sys' : 'chat',
        depth: typeof body.depth === 'number' ? body.depth : (parseInt(body.depth, 10) || 1),
      };
      db.prepare("UPDATE conversations SET author_note = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(note), convId);
      return res.json({ authorNote: note });
    }

    if (op === 'setState') {
      const state = {
        role: body.role === 'system' ? 'system' : 'user',
        position: body.position === 'sys' ? 'sys' : 'chat',
        depth: typeof body.depth === 'number' ? body.depth : (parseInt(body.depth, 10) || 0),
      };
      db.prepare("UPDATE conversations SET script_inject_state = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(state), convId);
      return res.json({ state });
    }

    return res.status(400).json({ error: 'unknown op: ' + op });
  });

  // ===================== MVU 世界状态 (Tier 3 闭环) =====================
  // GET  /:id/world-state -> { world_state: {...} }
  // PUT  /:id/world-state -> { world_state: {...} }  (persist model)
  router.get('/:id/world-state', (req, res) => {
    const row = db.prepare('SELECT world_state FROM conversations WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Conversation not found' });
    let worldState = {};
    try { worldState = row.world_state ? JSON.parse(row.world_state) : {}; } catch { worldState = {}; }
    res.json({ world_state: worldState });
  });

  router.put('/:id/world-state', (req, res) => {
    const row = db.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Conversation not found' });
    let ws = req.body && req.body.world_state;
    if (ws === undefined || ws === null) return res.status(400).json({ error: 'world_state required' });
    if (typeof ws !== 'object' || Array.isArray(ws)) return res.status(400).json({ error: 'world_state must be an object' });
    // Clamp size to avoid DB abuse
    const str = JSON.stringify(ws);
    if (str.length > 200000) return res.status(400).json({ error: 'world_state too large' });
    db.prepare("UPDATE conversations SET world_state = ?, updated_at = datetime('now') WHERE id = ?")
      .run(str, req.params.id);
    res.json({ world_state: ws });
  });

  return router;
};

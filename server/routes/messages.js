/**
 * Messages CRUD Routes
 * Distinguishes between content (clean context) and formatted (render data)
 */
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
// 轮次清理（event_log 记忆行）与 chat.js 的「重新生成」共用同一套语义，
// 避免两边各写一份导致「删第 1 轮却清了第 2 轮记忆」那类漂移。
const { getAffectedRounds, cleanupEventLog } = require('../utils/turnCleanup');

function safeLimit(limit) {
  const n = parseInt(limit);
  // ★ 默认 5000：前端 MessageAPI.list 不传 limit 时也必须加载完整长对话，
  //   否则超过 100 条后最新消息永远取不到（数据在库但显示缺最新几条）
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return 5000;
  return n;
}

module.exports = (db) => {
  const router = Router();

  // List messages for a conversation
  // 分页模式（长聊天折叠，节约资源）：
  //   ?latest=1&limit=100            → 最新 100 条（按时间倒序取再反转，返回 ASC 序）
  //   ?before_id=<msgId>&limit=100   → 比指定消息更早的 100 条（游标向前翻页）
  //   ?limit=100&offset=0            → 从最早开始正序分页（旧行为，兼容）
  // 响应：始终为消息数组（兼容旧消费方）；总数经 X-Total-Count 响应头返回
  router.get('/conversation/:conversationId', (req, res) => {
    const limit = safeLimit(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const latest = req.query.latest === '1' || req.query.latest === 'true';
    const beforeId = String(req.query.before_id || '');

    // 总数（前端据此判断是否还有更早消息）
    const total = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(req.params.conversationId).n;
    res.set('X-Total-Count', String(total));

    let rows;
    if (latest) {
      // 最新 N 条：DESC 取前 N，反转回 ASC（与前端渲染顺序一致）
      rows = db.prepare(`
        SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(req.params.conversationId, limit).reverse();
    } else if (beforeId) {
      // 游标向前翻页：created_at 更早；同时间戳按 id 字典序更小（复合游标，避免同刻消息歧义）
      const anchor = db.prepare('SELECT created_at, id FROM messages WHERE id = ?').get(beforeId);
      if (!anchor) {
        rows = [];
      } else {
        rows = db.prepare(`
          SELECT * FROM messages WHERE conversation_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(req.params.conversationId, anchor.created_at, anchor.created_at, anchor.id, limit).reverse();
      }
    } else {
      rows = db.prepare(`
        SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?
      `).all(req.params.conversationId, limit, offset);
    }

    // Parse formatted JSON strings to objects for frontend
    for (const row of rows) {
      if (row.formatted && typeof row.formatted === 'string') {
        try { row.formatted = JSON.parse(row.formatted); } catch { }
      }
    }

    res.json(rows);
  });

  // Batch update hidden status: { message_ids: ["id1","id2",...], hidden: true/false }
  router.patch('/batch-hide', (req, res) => {
    const { message_ids, hidden } = req.body;
    if (!Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json({ error: 'message_ids must be a non-empty array' });
    }
    if (message_ids.length > 500) {
      return res.status(400).json({ error: 'Too many message_ids (max 500)' });
    }
    if (typeof hidden !== 'boolean' && typeof hidden !== 'number') {
      return res.status(400).json({ error: 'hidden must be boolean' });
    }

    const hideValue = hidden ? 1 : 0;
    const placeholders = message_ids.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE messages SET hidden = ? WHERE id IN (${placeholders})
    `).run(hideValue, ...message_ids);

    res.json({ updated: result.changes, message: `${result.changes} messages ${hideValue ? 'hidden' : 'unhidden'}` });
  });

  // Batch delete messages by IDs
  router.post('/batch-delete', (req, res) => {
    const { message_ids } = req.body;
    if (!Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json({ error: 'message_ids must be a non-empty array' });
    }
    if (message_ids.length > 500) {
      return res.status(400).json({ error: 'Too many message_ids (max 500)' });
    }

    // Calculate affected rounds BEFORE deleting
    const affectedRounds = getAffectedRounds(db, message_ids);

    // Get conversation_id BEFORE deleting (cleanupEventLog needs it)
    const placeholders = message_ids.map(() => '?').join(',');
    const msgRow = db.prepare(`SELECT conversation_id FROM messages WHERE id IN (${placeholders}) LIMIT 1`).get(...message_ids);

    const result = db.prepare(`
      DELETE FROM messages WHERE id IN (${placeholders})
    `).run(...message_ids);

    // Clean up event log for affected rounds
    if (msgRow) {
      try { cleanupEventLog(db, msgRow.conversation_id, affectedRounds); } catch (e) { console.warn('[Messages] Event log cleanup failed:', e.message); }
    }

    res.json({ deleted: result.changes, message: `${result.changes} messages deleted` });
  });

  // Get single message
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Message not found' });
    res.json(row);
  });

  // Create message
  router.post('/', (req, res) => {
    const { conversation_id, role, content, formatted } = req.body;

    if (!conversation_id || !role || !content) {
      return res.status(400).json({ error: 'Missing required fields: conversation_id, role, content' });
    }

    const validRoles = ['user', 'assistant', 'system'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Role must be one of: user, assistant, system' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, formatted)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, conversation_id, role, content, JSON.stringify(formatted || {}));

    // Update conversation timestamp
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);

    res.status(201).json({ id, message: 'Message created' });
  });

  // Delete message
  router.delete('/:id', (req, res) => {
    const affectedRounds = getAffectedRounds(db, [req.params.id]);
    // Get conversation_id BEFORE deleting (cleanupEventLog needs it)
    const msgRow = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(req.params.id);
    const count = db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
    if (!count.changes) return res.status(404).json({ error: 'Message not found' });
    if (msgRow) {
      try { cleanupEventLog(db, msgRow.conversation_id, affectedRounds); } catch (e) { console.warn('[Messages] Event log cleanup failed:', e.message); }
    }
    res.json({ message: 'Message deleted' });
  });

  // Update message content
  router.put('/:id', (req, res) => {
    const { content, formatted } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    db.prepare('UPDATE messages SET content = ?, formatted = COALESCE(?, formatted) WHERE id = ?')
      .run(content, formatted ? JSON.stringify(formatted) : null, req.params.id);
    res.json({ message: 'Message updated' });
  });

  return router;
};

/**
 * Inline re-parser for fixing broken formatted data.
 * Handles: ### mood (with story fallback), ### story, ### dialog (legacy), ### status, ### actions
 */
function parseTemplateInline(text) {
  const segments = [];
  const result = { segments, portrait: null, cg: null, image: null, status: {}, mood: '' };
  const sections = text.split(/\n###\s+/);
  let fullText = '';

  for (const section of sections) {
    const body = section.slice(section.indexOf('\n') + 1).trim();
    const firstLine = section.split('\n')[0]?.trim() || '';
    const header = firstLine.replace(/^###\s*/, '').toLowerCase();

    if (header.startsWith('mood')) {
      const lines = body.split('\n');
      result.mood = (lines[0] || '').trim().toLowerCase();
      const afterMood = lines.slice(1).join('\n').trim();
      if (afterMood) parseStoryDialogInline(afterMood, segments);
    } else if (header.startsWith('story')) {
      parseStoryDialogInline(body, segments);
    } else if (header.startsWith('dialog')) {
      // Legacy pipe-table format
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('|')) continue;
        const cells = t.split('|').map(c => c.trim()).filter(c => c);
        if (cells.length < 2) continue;
        segments.push({ type: 'dialog', position: cells[0] || 'left', name: cells[1] || '', mood: cells[2] || '', text: cells[cells.length - 1] || '' });
      }
    } else if (header.startsWith('actions')) {
      result.actions = body.split('\n').map(l => l.trim().replace(/^-\s*/, '')).filter(l => l);
    } else if (header.startsWith('status')) {
      const kv = {};
      for (const line of body.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      result.status = kv;
    } else {
      parseStoryDialogInline(section.trim(), segments);
    }
  }
  return result;
}

function parseStoryDialogInline(text, segments) {
  const dlgRe = /([\u4e00-\u9fff·a-zA-Z0-9\s\-]{1,20})[：:]\s*[『\u2018']([^』\u2019']*)[』\u2019']/g;
  let lastIdx = 0; let posToggle = false; let match;
  while ((match = dlgRe.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index).trim();
    if (before) segments.push({ type: 'story', text: before });
    segments.push({ type: 'dialog', position: posToggle ? 'right' : 'left', name: match[1].trim(), mood: '', text: match[2].trim() });
    posToggle = !posToggle;
    lastIdx = dlgRe.lastIndex;
  }
  const after = text.slice(lastIdx).trim();
  if (after) segments.push({ type: 'story', text: after });
  if (segments.length === 0) segments.push({ type: 'story', text });
}

/**
 * Memory Agent Settings Routes
 * Sub-AI for enhanced memory and state variable management
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { SETTINGS_ID, EVENT_LOG_FILE, MEMORY_KEYS } = require('../constants');

module.exports = (db) => {
  const router = Router();

  // Get memory agent settings
  router.get('/', (req, res) => {
    const row = db.prepare('SELECT * FROM memory_agent_settings WHERE id = ?').get(SETTINGS_ID);
    if (!row) return res.status(404).json({ error: 'Settings not found' });

    // Resolve provider name
    let provider_name = '';
    if (row.provider_id) {
      const provider = db.prepare('SELECT name FROM api_providers WHERE id = ?').get(row.provider_id);
      provider_name = provider ? provider.name : '';
    }

    res.json({ ...row, provider_name });
  });

  // Update memory agent settings
  router.put('/', (req, res) => {
    const { enabled, provider_id, prompt_template, trigger_interval } = req.body;

    db.prepare(`
      UPDATE memory_agent_settings SET
        enabled = COALESCE(?, enabled),
        provider_id = COALESCE(?, provider_id),
        prompt_template = COALESCE(?, prompt_template),
        trigger_interval = COALESCE(?, trigger_interval)
      WHERE id = ?
    `).run(enabled, provider_id, prompt_template, trigger_interval, SETTINGS_ID);

    res.json({ message: 'Memory agent settings updated' });
  });

  // Get event log + countdown info
  router.get('/event-log', (req, res) => {
    const { conversation_id } = req.query;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(conversation_id);
    if (!save) return res.json({ log: '', countdown: 0, total: 0 });

    const eventLogPath = path.join(save.save_path, EVENT_LOG_FILE);
    let log = '';
    try { log = fs.readFileSync(eventLogPath, 'utf-8'); } catch { }

    const totalMessages = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversation_id);
    const currentRound = Math.ceil(totalMessages.cnt / 2);
    const countdown = 20 - (currentRound % 20);

    res.json({ log, countdown: countdown === 20 ? 0 : countdown, round: currentRound, total: totalMessages.cnt });
  });

  // Save event log back
  router.put('/event-log', (req, res) => {
    const { conversation_id, log } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    if (typeof log !== 'string') {
      return res.status(400).json({ error: 'log must be a string' });
    }
    if (log.length > 1024 * 1024) { // 1MB limit
      return res.status(400).json({ error: 'log too large (max 1MB)' });
    }

    const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(conversation_id);
    if (!save) return res.status(404).json({ error: 'Save not found' });

    const eventLogPath = path.join(save.save_path, EVENT_LOG_FILE);
    fs.writeFileSync(eventLogPath, log, 'utf-8');

    // Also update memory_context (merge with existing keys to avoid data loss)
    const totalMessages = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversation_id);
    const currentRound = Math.ceil(totalMessages.cnt / 2);
    if (currentRound % 20 === 0 && log.trim()) {
      const wrapped = `<p class="nowork">\n${log}\n</p>`;
      // Read existing memory_context and merge, instead of overwriting
      const conv = db.prepare('SELECT memory_context FROM conversations WHERE id = ?').get(conversation_id);
      let existing = {};
      try { existing = JSON.parse(conv?.memory_context || '{}'); } catch { }
      existing[MEMORY_KEYS.EVENT_LOG] = wrapped;
      db.prepare("UPDATE conversations SET memory_context = ? WHERE id = ?")
        .run(JSON.stringify(existing), conversation_id);
    }

    res.json({ message: 'Event log saved' });
  });

  // Trigger memory update manually
  router.post('/trigger', (req, res) => {
    const { conversation_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id is required' });
    }

    // Get settings
    const settings = db.prepare('SELECT * FROM memory_agent_settings WHERE id = ?').get('default');
    if (!settings || !settings.enabled) {
      return res.status(400).json({ error: 'Memory agent is not enabled' });
    }

    // Get recent messages for context
    const messages = db.prepare(`
      SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(conversation_id, settings.trigger_interval * 2);

    // Get current memory context
    const conv = db.prepare('SELECT memory_context FROM conversations WHERE id = ?').get(conversation_id);
    const memoryContext = conv && conv.memory_context ? JSON.parse(conv.memory_context) : {};

    res.json({
      status: 'processing',
      message_count: messages.length,
      current_memory: memoryContext,
      message: 'Memory update initiated (Phase 5: full AI processing pending)'
    });
  });

  return router;
};

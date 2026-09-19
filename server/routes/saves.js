/**
 * Game Save Routes
 * Each save = a timestamp folder under saves/
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');

const { isPathWithin } = require('../utils/pathGuard');
const savePaths = require('../savePaths');

const SAVES_DIR = require('../paths').SAVES_DIR;
const GENERATED_IMAGES_DIR = require('../paths').GENERATED_IMAGES_DIR;
const PROFILE_DIR = require('../paths').PROFILE_DIR;

module.exports = (db) => {
  const router = Router();

  // Ensure saves directory exists
  fs.mkdirSync(SAVES_DIR, { recursive: true });

  // List all saves
  router.get('/', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM saves ORDER BY created_at DESC').all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get save by ID
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Save not found' });
    res.json(row);
  });

  // Create save at conversation start
  router.post('/', (req, res) => {
    const { conversation_id, character_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const now = new Date();
    const saveId = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0')
    ].join('');

    const savePath = character_id
      ? savePaths.getSubSaveDir(db, character_id, saveId)
      : path.join(SAVES_DIR, saveId);
    fs.mkdirSync(savePath, { recursive: true });

    // Save character card
    if (character_id) {
      try {
        const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
        if (char) {
          fs.writeFileSync(path.join(savePath, 'character.json'), JSON.stringify(char, null, 2), 'utf-8');
        }
      } catch (e) { /* ignore */ }
    }

    db.prepare('INSERT INTO saves (id, conversation_id, character_id, save_path) VALUES (?, ?, ?, ?)')
      .run(saveId, conversation_id, character_id || null, savePath);

    res.status(201).json({ id: saveId, message: 'Save created' });
  });

  // Delete save (DB records + disk folder)
  router.delete('/:id', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });

    try {
      // 1. Delete disk folder (images, roster, memory, etc.) — with boundary check
      const resolvedSavePath = path.resolve(save.save_path);
      if (isPathWithin(SAVES_DIR, resolvedSavePath)) {
        try { fs.rmSync(resolvedSavePath, { recursive: true, force: true }); } catch { }
      } else {
        console.error('[Saves] Refused to delete path outside SAVES_DIR:', resolvedSavePath);
      }
      // 2. Delete DB records
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(save.conversation_id);
      db.prepare('DELETE FROM saves WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(save.conversation_id);
      res.json({ message: 'Save deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export conversation as Markdown file
  router.get('/:id/export-md', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });

    try {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(save.conversation_id);
      const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(save.conversation_id);

      const charName = conv?.title || '对话';
      let md = `# ${charName}\n\n`;
      md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
      md += `> 存档ID: ${save.id}\n\n---\n\n`;

      for (const msg of messages) {
        const role = msg.role === 'user' ? '**玩家**' : '**AI**';
        let content = msg.content || '';
        // Strip ### headers and format for readability
        content = content.replace(/^###\s+\w+\s*$/gm, '');
        // Format dialog lines
        content = content.replace(/([^：:]+)[：:](『[^』]*』)/g, '\n**$1**： $2');
        md += `### ${role}\n\n${content.trim()}\n\n---\n\n`;
      }

      const filename = encodeURIComponent(charName + '.md');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
      res.send(md);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export full save
  router.get('/:id/export', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });

    try {
      // Export conversation messages
      const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(save.conversation_id);
      fs.writeFileSync(path.join(save.save_path, 'messages.json'), JSON.stringify(messages, null, 2), 'utf-8');

      // Export conversation state
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(save.conversation_id);
      if (conv) {
        fs.writeFileSync(path.join(save.save_path, 'conversation.json'), JSON.stringify(conv, null, 2), 'utf-8');
      }

      // Copy generated images
      const imgDir = GENERATED_IMAGES_DIR;
      const destImgDir = path.join(save.save_path, 'images');
      if (fs.existsSync(imgDir)) {
        fs.mkdirSync(destImgDir, { recursive: true });
        const files = fs.readdirSync(imgDir);
        files.forEach(f => {
          fs.copyFileSync(path.join(imgDir, f), path.join(destImgDir, f));
        });
      }

      res.json({ message: 'Save exported' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Character roster
  router.get('/:id/roster', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    try {
      const roster = JSON.parse(fs.readFileSync(path.join(save.save_path, 'character_roster.json'), 'utf-8'));
      res.json({ roster });
    } catch {
      res.json({ roster: {} });
    }
  });

  // Serve avatar image from save folder
  router.get('/:id/avatar/:name', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).send('Not found');
    try {
      const roster = JSON.parse(fs.readFileSync(path.join(save.save_path, 'character_roster.json'), 'utf-8'));
      const char = roster[decodeURIComponent(req.params.name)];
      // Placeholder NPC sentinels → serve the default profile image (no real avatar yet).
      // The butler's next round discovers these and replaces them with a generated portrait.
      if (char && (char.avatar === 'NPCF' || char.avatar === 'NPCM')) {
        const holder = path.join(PROFILE_DIR, char.avatar + '.jpg');
        if (fs.existsSync(holder)) return res.sendFile(holder);
      }
      // Filter out 'pending' and empty — only serve actual avatar files
      if (char && char.avatar && char.avatar !== 'pending' && char.avatar !== '' && char.avatar !== '已有头像') {
        const imgDir = path.resolve(save.save_path, 'images');
        const avatarPath = path.resolve(imgDir, char.avatar);
        // Prevent path traversal: resolved path must stay within imgDir
        if (!avatarPath.startsWith(imgDir + path.sep)) {
          return res.status(403).send('Forbidden');
        }
        if (fs.existsSync(avatarPath)) return res.sendFile(avatarPath);
      }
    } catch { }
    res.status(404).send('Not found');
  });

  // Serve images from save folder
  router.get('/:id/images/:filename', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).send('Not found');
    const imgDir = path.join(save.save_path, 'images');
    const imgPath = path.resolve(imgDir, req.params.filename);
    // Prevent path traversal: resolved path must stay within imgDir
    if (!imgPath.startsWith(imgDir + path.sep)) {
      return res.status(403).send('Forbidden');
    }
    if (fs.existsSync(imgPath)) return res.sendFile(imgPath);
    res.status(404).send('Not found');
  });

  // === Status JSON (per-save, stored as status.json in save folder) ===
  router.get('/:id/status', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    try {
      const status = JSON.parse(fs.readFileSync(path.join(save.save_path, 'status.json'), 'utf-8'));
      res.json(status);
    } catch {
      res.json({});
    }
  });

  router.put('/:id/status', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    fs.mkdirSync(save.save_path, { recursive: true });
    fs.writeFileSync(path.join(save.save_path, 'status.json'), JSON.stringify(req.body || {}, null, 2), 'utf-8');
    res.json({ message: 'Status saved' });
  });

  // === Character Roster (per-save, stored as character_roster.json) ===
  router.put('/:id/roster', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    fs.mkdirSync(save.save_path, { recursive: true });
    fs.writeFileSync(path.join(save.save_path, 'character_roster.json'), JSON.stringify(req.body || {}, null, 2), 'utf-8');
    res.json({ message: 'Roster saved' });
  });

  // Update single character entry in roster
  router.put('/:id/roster/:name', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    const name = decodeURIComponent(req.params.name);
    try {
      const rp = path.join(save.save_path, 'character_roster.json');
      let roster = {};
      try { roster = JSON.parse(fs.readFileSync(rp, 'utf-8')); } catch { }
      roster[name] = { ...roster[name], ...req.body };
      fs.writeFileSync(rp, JSON.stringify(roster, null, 2), 'utf-8');
      res.json({ message: 'Character updated', roster });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete character entry from roster
  router.delete('/:id/roster/:name', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    const name = decodeURIComponent(req.params.name);
    try {
      const rp = path.join(save.save_path, 'character_roster.json');
      let roster = {};
      try { roster = JSON.parse(fs.readFileSync(rp, 'utf-8')); } catch { }
      delete roster[name];
      fs.writeFileSync(rp, JSON.stringify(roster, null, 2), 'utf-8');
      res.json({ message: 'Character removed', roster });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // === Memory Table (reads from conversations.memory_context + messages.formatted memory blocks) ===
  router.get('/:id/memory', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });

    // Try reading from save folder: memory.json first, then event_log.md
    try {
      const mem = JSON.parse(fs.readFileSync(path.join(save.save_path, 'memory.json'), 'utf-8'));
      return res.json({ memory: mem });
    } catch { }
    try {
      const eventLog = fs.readFileSync(path.join(save.save_path, 'event_log.md'), 'utf-8');
      const entries = [];
      const lines = eventLog.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Pipe format: 第N轮 | date | location | characters | summary
        const pipeParts = trimmed.split('|');
        if (pipeParts.length >= 2 && pipeParts[0].trim().startsWith('第')) {
          const key = pipeParts[0].trim();
          const value = pipeParts.slice(1).map(s => s.trim()).join(' | ');
          entries.push({ key, value: value.substring(0, 250) });
        } else {
          // Plain text line
          entries.push({ key: '', value: trimmed.substring(0, 250) });
        }
      }
      return res.json({ memory: entries.length > 0 ? entries : [{ key: 'event_log', value: eventLog.substring(0, 500) }] });
    } catch { }

    // Fallback: extract from conversation memory_context
    try {
      const conv = db.prepare('SELECT memory_context FROM conversations WHERE id = ?').get(save.conversation_id);
      if (conv && conv.memory_context) {
        const ctx = JSON.parse(conv.memory_context);
        // Already array or has entries/memory key
        if (Array.isArray(ctx)) return res.json({ memory: ctx });
        if (ctx.entries) return res.json({ memory: ctx.entries });
        if (ctx.memory) return res.json({ memory: ctx.memory });
        // Extract from event_log HTML table (format: <p class="nowork">\n<table>...\n</p>)
        if (ctx.event_log) {
          const log = ctx.event_log;
          const rows = [];
          const rowMatches = log.matchAll(/<tr[^>]*>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g);
          for (const m of rowMatches) {
            const key = m[1].replace(/<[^>]*>/g, '').trim();
            const val = m[2].replace(/<[^>]*>/g, '').trim();
            if (key && val) rows.push({ key, value: val });
          }
          if (rows.length > 0) return res.json({ memory: rows });
        }
      }
    } catch { }

    res.json({ memory: [] });
  });

  router.put('/:id/memory', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    fs.mkdirSync(save.save_path, { recursive: true });
    fs.writeFileSync(path.join(save.save_path, 'memory.json'), JSON.stringify(req.body || {}, null, 2), 'utf-8');

    // Also update conversation memory_context
    try {
      db.prepare('UPDATE conversations SET memory_context = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(req.body), save.conversation_id);
    } catch { }

    res.json({ message: 'Memory saved' });
  });

  // Edit single memory entry (updates event_log.md)
  router.put('/:id/memory/edit', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    const { key, value, index } = req.body;
    try {
      const logPath = path.join(save.save_path, 'event_log.md');
      if (fs.existsSync(logPath)) {
        let lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        if (index !== undefined && index >= 0 && index < lines.length) {
          // Replace the specific line
          const line = lines[index];
          const pipeParts = line.split('|');
          if (pipeParts.length >= 2) {
            pipeParts[pipeParts.length - 1] = ' ' + value;
            lines[index] = pipeParts.join('|');
          } else {
            lines[index] = (key ? key + ' | ' : '') + value;
          }
          fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
        }
      }
      // Also update memory.json if it exists
      const memPath = path.join(save.save_path, 'memory.json');
      if (fs.existsSync(memPath)) {
        let mem = JSON.parse(fs.readFileSync(memPath, 'utf-8'));
        if (Array.isArray(mem) && index >= 0 && index < mem.length) {
          mem[index].value = value;
          fs.writeFileSync(memPath, JSON.stringify(mem, null, 2), 'utf-8');
        }
      }
      res.json({ message: 'Entry updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CG gallery
  router.get('/:id/cg-gallery', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    try {
      const gallery = JSON.parse(fs.readFileSync(path.join(save.save_path, 'cg_gallery.json'), 'utf-8'));
      res.json({ gallery });
    } catch {
      res.json({ gallery: [] });
    }
  });

  // Clear the whole CG gallery of a save — used when a game is restarted, so the
  // stage returns to its initial state instead of the previous run's last CG.
  // Only the gallery index is reset; the generated image files are kept on disk.
  router.delete('/:id/cg-gallery', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    const gp = path.join(save.save_path, 'cg_gallery.json');
    let removed = 0;
    try {
      const gallery = JSON.parse(fs.readFileSync(gp, 'utf-8'));
      removed = Array.isArray(gallery) ? gallery.length : 0;
    } catch { /* no gallery file yet — nothing to clear */ }
    try {
      fs.writeFileSync(gp, '[]', 'utf-8');
      res.json({ message: 'CG gallery cleared', removed, filesKept: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to clear gallery' });
    }
  });

  // Delete CG from gallery
  router.delete('/:id/cg-gallery/:index', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).json({ error: 'Save not found' });
    const gp = path.join(save.save_path, 'cg_gallery.json');
    try {
      const gallery = JSON.parse(fs.readFileSync(gp, 'utf-8'));
      const idx = parseInt(req.params.index);
      if (idx >= 0 && idx < gallery.length) {
        // Delete image file (with path traversal guard)
        const imgDir = path.resolve(save.save_path, 'images');
        const imgPath = path.resolve(imgDir, gallery[idx].filename);
        if (!imgPath.startsWith(imgDir + path.sep)) {
          return res.status(403).json({ error: 'Invalid file path' });
        }
        try { fs.unlinkSync(imgPath); } catch { }
        gallery.splice(idx, 1);
        fs.writeFileSync(gp, JSON.stringify(gallery, null, 2), 'utf-8');
        res.json({ message: 'CG deleted' });
      } else {
        res.status(404).json({ error: 'Index out of range' });
      }
    } catch {
      res.status(500).json({ error: 'Failed to delete' });
    }
  });

  return router;
};

/**
 * API Presets Routes
 * Import/edit SillyTavern-compatible presets for chat & image generation
 */
const { Router } = require('express');

module.exports = (db) => {
  const router = Router();

  // List all presets
  router.get('/', (req, res) => {
    const { type } = req.query;
    let rows;
    if (type) {
      rows = db.prepare('SELECT * FROM api_presets WHERE preset_type = ? ORDER BY is_default DESC').all(type);
    } else {
      rows = db.prepare('SELECT * FROM api_presets ORDER BY preset_type, is_default DESC').all();
    }
    res.json(rows.map(r => ({
      ...r,
      data: JSON.parse(r.data || '{}'),
      enabled_params: JSON.parse(r.enabled_params || '[]')
    })));
  });

  // Get single preset
  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM api_presets WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Preset not found' });
    res.json({
      ...row,
      data: JSON.parse(row.data || '{}'),
      enabled_params: JSON.parse(row.enabled_params || '[]')
    });
  });

  // Create/update preset
  router.put('/:id', (req, res) => {
    const { name, preset_type, data, enabled_params, is_default, imported_from } = req.body;
    const existing = db.prepare('SELECT * FROM api_presets WHERE id = ?').get(req.params.id);

    if (existing) {
      db.prepare(`
        UPDATE api_presets SET
          name = COALESCE(?, name),
          preset_type = COALESCE(?, preset_type),
          data = COALESCE(?, data),
          enabled_params = COALESCE(?, enabled_params),
          is_default = COALESCE(?, is_default),
          imported_from = COALESCE(?, imported_from)
        WHERE id = ?
      `).run(
        name, preset_type,
        data ? JSON.stringify(data) : null,
        enabled_params ? JSON.stringify(enabled_params) : null,
        is_default !== undefined ? is_default : null,
        imported_from, req.params.id
      );
    } else {
      db.prepare(`
        INSERT INTO api_presets (id, name, preset_type, data, enabled_params, is_default, imported_from)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id, name || 'New Preset', preset_type || 'chat',
        JSON.stringify(data || {}), JSON.stringify(enabled_params || []),
        is_default ? 1 : 0, imported_from || ''
      );
    }

    res.json({ message: 'Preset saved' });
  });

  // Delete preset
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM api_presets WHERE id = ?').run(req.params.id);
    res.json({ message: 'Preset deleted' });
  });

  // Set as default (unset others of same type first)
  router.post('/:id/set-default', (req, res) => {
    const preset = db.prepare('SELECT * FROM api_presets WHERE id = ?').get(req.params.id);
    if (!preset) return res.status(404).json({ error: 'Preset not found' });

    db.prepare('UPDATE api_presets SET is_default = 0 WHERE preset_type = ?').run(preset.preset_type);
    db.prepare('UPDATE api_presets SET is_default = 1 WHERE id = ?').run(req.params.id);

    res.json({ message: 'Set as default' });
  });

  return router;
};

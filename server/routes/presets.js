/**
 * API Presets Routes
 * Import/edit SillyTavern-compatible presets for chat & image generation
 */
const { Router } = require('express');
const { APP_KEYS } = require('../constants');
const { buildSTPreset, presetFilename } = require('../st-preset');

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw || '');
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Resolve which provider to embed in an exported preset.
 * Mirrors the chat pipeline: app_settings.main_ai_provider_id, then is_default.
 * @param {object} db
 * @param {string|undefined} requestedId explicit ?provider= override
 */
function resolveExportProvider(db, requestedId) {
  if (requestedId) {
    const byId = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(requestedId);
    if (byId) return byId;
  }
  const main = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_KEYS.MAIN_AI_PROVIDER_ID);
  if (main && main.value) {
    const bySetting = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(main.value);
    if (bySetting) return bySetting;
  }
  return db.prepare('SELECT * FROM api_providers WHERE is_default = 1 LIMIT 1').get() || null;
}

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

  // Export a preset as a standard SillyTavern chat completion preset.
  //   GET /presets/:id/export            → downloadable .json (ST-importable)
  //   GET /presets/:id/export?meta=1     → { preset, report } for previews/debug
  //   GET /presets/:id/export?inline=1   → raw preset body, no attachment header
  //   GET /presets/:id/export?provider=X → embed provider X instead of the active one
  router.get('/:id/export', (req, res) => {
    const row = db.prepare('SELECT * FROM api_presets WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Preset not found' });

    // Only chat presets map onto ST's chat completion preset format, which is the
    // one that carries API provider (source / URL / model) information.
    if (row.preset_type && row.preset_type !== 'chat') {
      return res.status(400).json({
        error: 'Only chat presets have a standard SillyTavern format',
        preset_type: row.preset_type,
      });
    }

    const preset = {
      ...row,
      data: safeParse(row.data, {}),
      enabled_params: safeParse(row.enabled_params, []),
    };
    const provider = resolveExportProvider(db, req.query.provider);
    const { preset: body, report } = buildSTPreset(preset, provider);

    if (req.query.meta === '1') {
      return res.json({ preset: body, report });
    }
    if (req.query.inline === '1') {
      return res.json(body);
    }

    const filename = presetFilename(row.name);
    // ASCII fallback for old clients + RFC 5987 form so Chinese names survive.
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(JSON.stringify(body, null, 2));
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

/**
 * Theme Settings Routes
 * Supports Amber (default) and custom CSS variable themes
 */
const { Router } = require('express');
const { SETTINGS_ID, APP_KEYS } = require('../constants');

// Default Blue Deep Theme — matches CSS :root variables in style.css
const DEFAULT_DARK_THEME = {
  '--bg-primary': '#080E1A',
  '--bg-secondary': '#0C1423',
  '--bg-tertiary': '#101A2C',
  '--bg-card': '#11192D',
  '--bg-card-hover': '#162037',
  '--bg-input': '#0A101E',
  '--text-primary': '#D8E2F0',
  '--text-secondary': '#9CB4D4',
  '--text-muted': '#6B89AA',
  '--text-accent': '#60A5FA',
  '--border-color': '#2D4164',
  '--border-accent': '#3B82F6',
  '--accent': '#3B82F6',
  '--accent-hover': '#60A5FA',
  '--font-family': '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  '--theme-dialog-bg': 'rgba(12, 18, 32, 0.82)',
  '--theme-dialog-text': '#FFFFFF',
  '--theme-dialog-name': '#60A5FA',
  '--theme-input-bg': 'rgba(10, 16, 30, 0.82)',
};

const DEFAULT_LIGHT_THEME = {
  '--bg-primary': '#F3FAFF',
  '--bg-secondary': '#F5FAFF',
  '--bg-tertiary': '#F0F8FF',
  '--bg-card': '#F8FCFF',
  '--bg-card-hover': '#EBF5FF',
  '--bg-input': '#F8FCFF',
  '--text-primary': '#1A2538',
  '--text-secondary': '#375173',
  '--text-muted': '#5E7DA0',
  '--text-accent': '#2563EB',
  '--border-color': '#B0C8E0',
  '--border-accent': '#2563EB',
  '--accent': '#2563EB',
  '--accent-hover': '#1D4ED8',
  '--font-family': '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  '--theme-dialog-bg': 'rgba(248, 252, 255, 0.88)',
  '--theme-dialog-text': '#1A2538',
  '--theme-dialog-name': '#1D4ED8',
  '--theme-input-bg': 'rgba(248, 252, 255, 0.90)',
};

const DEFAULT_BLUE_THEME = { dark: DEFAULT_DARK_THEME, light: DEFAULT_LIGHT_THEME };

/**
 * Detect if stored css_variables is flat (old) or per-mode (new).
 * Migrate flat -> per-mode (treat flat values as dark mode overrides).
 */
function normalizeToPerMode(storedVars) {
  if (!storedVars || Object.keys(storedVars).length === 0) return { dark: {}, light: {} };
  // New format: has 'dark' key and the value is an object (not a CSS variable string)
  if (storedVars.dark !== undefined && typeof storedVars.dark === 'object') {
    return { dark: storedVars.dark || {}, light: storedVars.light || {} };
  }
  if (storedVars.light !== undefined && typeof storedVars.light === 'object') {
    return { dark: storedVars.dark || {}, light: storedVars.light || {} };
  }
  // Old flat format: treat all keys as dark mode overrides
  return { dark: storedVars, light: {} };
}

module.exports = (db) => {
  const router = Router();

  // Get current theme (returns per-mode)
  router.get('/', (req, res) => {
    const row = db.prepare('SELECT * FROM theme_settings WHERE id = ?').get(SETTINGS_ID);
    if (!row) return res.status(404).json({ error: 'Settings not found' });

    const storedVars = row.css_variables ? JSON.parse(row.css_variables) : {};
    const perMode = normalizeToPerMode(storedVars);

    res.json({
      theme_name: row.theme_name,
      is_custom: row.is_custom,
      css_variables: perMode,
      dark: { ...DEFAULT_DARK_THEME, ...perMode.dark },
      light: { ...DEFAULT_LIGHT_THEME, ...perMode.light }
    });
  });

  // Update theme (per-mode)
  router.put('/', (req, res) => {
    const { theme_name, css_variables, is_custom, mode } = req.body;

    // Fetch existing stored vars
    const row = db.prepare('SELECT css_variables FROM theme_settings WHERE id = ?').get(SETTINGS_ID);
    const existingVars = row && row.css_variables ? JSON.parse(row.css_variables) : {};
    const existing = normalizeToPerMode(existingVars);

    // Merge new overrides
    if (css_variables && mode) {
      existing[mode] = { ...existing[mode], ...css_variables };
    } else if (css_variables) {
      // Legacy: flat update → treat as dark
      existing.dark = { ...existing.dark, ...css_variables };
    }

    db.prepare(`
      UPDATE theme_settings SET
        theme_name = COALESCE(?, theme_name),
        css_variables = ?,
        is_custom = COALESCE(?, is_custom)
      WHERE id = '${SETTINGS_ID}'
    `).run(
      theme_name,
      JSON.stringify(existing),
      is_custom ? 1 : 0
    );

    res.json({
      message: 'Theme updated',
      css_variables: existing,
      dark: { ...DEFAULT_DARK_THEME, ...existing.dark },
      light: { ...DEFAULT_LIGHT_THEME, ...existing.light }
    });
  });

  // Reset to default
  router.post('/reset', (req, res) => {
    db.prepare(`
      UPDATE theme_settings SET
        theme_name = 'amber',
        css_variables = ?,
        is_custom = 0
      WHERE id = '${SETTINGS_ID}'
    `).run(JSON.stringify({ dark: {}, light: {} }));

    res.json({
      message: 'Theme reset',
      css_variables: { dark: {}, light: {} },
      dark: DEFAULT_DARK_THEME,
      light: DEFAULT_LIGHT_THEME
    });
  });

  // Settings store (system prompts etc.)
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`);
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.GLOBAL_SYSTEM_PROMPT, '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.CARD_FIXER_PROMPT, '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.MEMORY_AGENT_PROMPT, '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.BUTLER_PROVIDER_ID, '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.MAIN_AI_PROVIDER_ID, '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(APP_KEYS.BUTLER_AI_PRESET_ID, '');

  router.get('/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM app_settings').all();
    const result = {};
    rows.forEach(r => result[r.key] = r.value);
    res.json(result);
  });

  router.put('/settings', (req, res) => {
    // Generic: save any key from request body (not hardcoded to specific keys)
    for (const [key, value] of Object.entries(req.body)) {
      if (key && key !== 'id') {
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
      }
    }
    res.json({ message: 'Saved' });
  });

  // Proxy settings
  router.get('/settings/proxy', (req, res) => {
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'proxy_config'").get();
      if (row && row.value) return res.json(JSON.parse(row.value));
    } catch {}
    res.json({ enabled: false, host: '127.0.0.1', port: 9567, auth: '' });
  });

  router.put('/settings/proxy', (req, res) => {
    const { enabled, host, port, auth } = req.body;
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('proxy_config', JSON.stringify({
      enabled: !!enabled, host: host || '127.0.0.1', port: parseInt(port) || 9567, auth: auth || ''
    }));
    res.json({ success: true });
  });

  return router;
};

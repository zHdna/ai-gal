/**
 * STscript Variable Persistence Routes
 *
 * Scope mapping:
 *   - local  variables  -> script_vars        (keyed by conversation_id)
 *   - global variables  -> script_global_vars  (keyed by user_id, multi-user isolated)
 *
 * Endpoints:
 *   GET    /api/script-vars?scope=local&conversation_id=X   -> list all local vars
 *   GET    /api/script-vars?scope=global&user_id=Y          -> list all global vars
 *   POST   /api/script-vars  { scope, conversation_id?, user_id?, name, value, type }  -> upsert
 *   DELETE /api/script-vars?scope=local&conversation_id=X[&name=foo]  -> delete one or flush all
 */
const { Router } = require('express');

module.exports = (db) => {
  const router = Router();

  // Helper: resolve owner column + value for a scope
  function resolveScope(scope, query, body) {
    if (scope === 'global') {
      const userId = (query && query.user_id) || (body && body.user_id);
      if (!userId) return { error: 'global scope requires user_id' };
      return { ownerCol: 'user_id', ownerVal: String(userId), table: 'script_global_vars' };
    }
    if (scope === 'local') {
      const convId = (query && query.conversation_id) || (body && body.conversation_id);
      if (!convId) return { error: 'local scope requires conversation_id' };
      return { ownerCol: 'conversation_id', ownerVal: String(convId), table: 'script_vars' };
    }
    return { error: "scope must be 'local' or 'global'" };
  }

  // ---- List ----
  router.get('/', (req, res) => {
    const scope = req.query.scope || 'local';
    const resolved = resolveScope(scope, req.query, null);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const rows = db.prepare(`
      SELECT name, value, type FROM ${resolved.table} WHERE ${resolved.ownerCol} = ?
    `).all(resolved.ownerVal);

    res.json({ scope, vars: rows });
  });

  // ---- Upsert one variable ----
  router.post('/', (req, res) => {
    const { scope, name, value, type } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const resolved = resolveScope(scope, null, req.body);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const val = value === undefined || value === null ? '' : String(value);
    const varType = ['string', 'number', 'json'].includes(type) ? type : 'string';

    db.prepare(`
      INSERT INTO ${resolved.table} (${resolved.ownerCol}, name, value, type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(${resolved.ownerCol}, name) DO UPDATE SET value = excluded.value, type = excluded.type
    `).run(resolved.ownerVal, name, val, varType);

    res.json({ ok: true, scope, name, value: val, type: varType });
  });

  // ---- Delete one (with name) or flush all (no name) ----
  router.delete('/', (req, res) => {
    const scope = req.query.scope || 'local';
    const resolved = resolveScope(scope, req.query, null);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const { name } = req.query;
    if (name) {
      db.prepare(`DELETE FROM ${resolved.table} WHERE ${resolved.ownerCol} = ? AND name = ?`)
        .run(resolved.ownerVal, name);
      return res.json({ ok: true, scope, deleted: name });
    }

    // No name -> flush entire scope for this owner
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'Pass confirm=true to clear all vars' });
    }
    db.prepare(`DELETE FROM ${resolved.table} WHERE ${resolved.ownerCol} = ?`).run(resolved.ownerVal);
    res.json({ ok: true, scope, flushed: true });
  });

  return router;
};

/**
 * Minimal RFC 6902 JSON Patch engine (backend side).
 * Used to apply engine-card <json_patch> world-state updates to a model object.
 * Path traversal into prototype / constructor is rejected for safety.
 */

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_DEPTH = 50;
const MAX_CLONE_BYTES = 10 * 1024 * 1024; // 10MB

/* ══════════════════════════════════════════════════════════════════════════
 * 数值变更的**边界**与**审计**（2026-09-21 新增）
 *
 * 背景：`delta` / `inc` 原本是"给什么写什么" —— 全文件只有原型污染 / 深度 / 体积三道防护。
 * 于是模型写 `{"op":"delta","path":"/好感度","value":9999}` 会**原样落库**，
 * 而下一轮它还会被当成权威值注入回上下文 → 数值崩坏且不可追溯。
 *
 * 取舍：
 *   · **只夹逼增量**（delta / inc），不夹逼绝对值（replace/add）：没有字段范围声明时，
 *     把绝对值夹到 ±100 会毁掉"金币 5000"这类正常数据。
 *   · 上限默认 100，可用环境变量 MVU_DELTA_ABS_MAX 覆盖（0 或负数 = 关闭夹逼）。
 *   · 夹逼**不静默**：console.warn + 追加一行到 data/mvu-audit.log（写失败只打日志）。
 *   · 另外把最近若干条操作留在内存里（`getMvuAuditLog()`），便于单测与排查。
 * ══════════════════════════════════════════════════════════════════════════ */
const MVU_DELTA_ABS_MAX = (() => {
  const raw = process.env.MVU_DELTA_ABS_MAX;
  if (raw === undefined || raw === '') return 100;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 100;
})();
const MVU_AUDIT_MAX = 200;
const mvuAuditLog = [];

function recordMvuOp(entry) {
  try {
    mvuAuditLog.push(entry);
    while (mvuAuditLog.length > MVU_AUDIT_MAX) mvuAuditLog.shift();
    if (!entry.clamped) return;
    console.warn('[MVU] ⚠️ 数值增量被夹逼：', entry.path,
      '申请', entry.requested, '→ 实际', entry.applied, '（上限 ±' + MVU_DELTA_ABS_MAX + '）');
    try {
      const fsMod = require('fs');
      const pathMod = require('path');
      const dir = require('../paths').DATA_DIR;
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.appendFileSync(pathMod.join(dir, 'mvu-audit.log'),
        JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
    } catch { /* 审计写失败绝不影响状态应用 */ }
  } catch { /* 审计本身不能抛 */ }
}

/** 夹逼一个增量；MVU_DELTA_ABS_MAX <= 0 表示关闭 */
function clampDelta(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || MVU_DELTA_ABS_MAX <= 0) return { applied: v, clamped: false };
  const lim = MVU_DELTA_ABS_MAX;
  const c = Math.max(-lim, Math.min(lim, v));
  return { applied: c, clamped: c !== v };
}

function splitPath(path) {
  // RFC 6902: leading '/' then tokens separated by '/'; '~1' -> '/', '~0' -> '~'
  if (!path || path[0] !== '/') throw new Error('Invalid JSON Patch path: ' + path);
  const tokens = path.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.some(t => FORBIDDEN.has(t))) throw new Error('Forbidden path segment in: ' + path);
  return tokens;
}

function getParentAndKey(tokens) {
  const parentTokens = tokens.slice(0, -1);
  const key = tokens[tokens.length - 1];
  if (FORBIDDEN.has(key)) throw new Error('Forbidden path segment: ' + key);
  return { parentTokens, key };
}

function resolve(obj, tokens) {
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

function ensureParent(obj, parentTokens) {
  if (parentTokens.length > MAX_DEPTH) {
    throw new Error('JSON Patch path too deep (max ' + MAX_DEPTH + ' levels)');
  }
  let cur = obj;
  for (const t of parentTokens) {
    if (cur[t] === undefined || cur[t] === null || typeof cur[t] !== 'object') {
      // If next token is numeric-ish and we are creating an array, allow array; else object
      cur[t] = /^\d+$/.test(t) ? [] : {};
    }
    cur = cur[t];
  }
  return cur;
}

function applySingle(model, op) {
  // Ops that address the whole model (no path) — handle before splitPath.
  if (op && op.op === 'time') {
    const v = op.value;
    if (model.time === undefined || model.time === null) model.time = v;
    else if (typeof model.time === 'object') model.time.current = v;
    else model.time = v;
    return undefined;
  }
  if (op && op.op === 'func') {
    // SAM "func" op evaluates arbitrary code — intentionally NOT executed
    // (security). Treated as a no-op so it never breaks world-state apply.
    return undefined;
  }

  const tokens = splitPath(op.path);
  const { parentTokens, key } = getParentAndKey(tokens);

  switch (op.op) {
    case 'add': {
      const parent = ensureParent(model, parentTokens);
      if (Array.isArray(parent)) {
        const idx = key === '-' ? parent.length : parseInt(key, 10);
        if (key !== '-' && (isNaN(idx) || idx < 0 || idx > parent.length)) throw new Error('Array index out of range: ' + op.path);
        parent.splice(idx, 0, clone(op.value));
      } else {
        parent[key] = clone(op.value);
      }
      break;
    }
    case 'replace': {
      const parent = ensureParent(model, parentTokens);
      if (Array.isArray(parent)) {
        const idx = parseInt(key, 10);
        if (isNaN(idx) || idx < 0 || idx >= parent.length) throw new Error('Array index out of range: ' + op.path);
        parent[idx] = clone(op.value);
      } else {
        parent[key] = clone(op.value);
      }
      break;
    }
    case 'remove': {
      const parent = resolve(model, parentTokens);
      if (parent == null) throw new Error('Path not found for remove: ' + op.path);
      if (Array.isArray(parent)) {
        const idx = parseInt(key, 10);
        if (isNaN(idx) || idx < 0 || idx >= parent.length) throw new Error('Array index out of range: ' + op.path);
        parent.splice(idx, 1);
      } else {
        delete parent[key];
      }
      break;
    }
    case 'move': {
      if (!op.from) throw new Error('move requires from');
      const val = applySingle(model, { op: 'get', path: op.from });
      applySingle(model, { op: 'remove', path: op.from });
      applySingle(model, { op: 'add', path: op.path, value: val });
      break;
    }
    case 'copy': {
      if (!op.from) throw new Error('copy requires from');
      const val = applySingle(model, { op: 'get', path: op.from });
      applySingle(model, { op: 'add', path: op.path, value: val });
      break;
    }
    case 'test': {
      const cur = resolve(model, tokens);
      if (JSON.stringify(cur) !== JSON.stringify(op.value)) throw new Error('Test failed at ' + op.path);
      break;
    }
    case 'delta': {
      // MVU custom op: increment/decrement the current value by op.value.
      // Supports tuple fields [value, label] — only index [0] is updated.
      const cur = resolve(model, tokens);
      const deltaVal0 = Number(op.value);
      if (isNaN(deltaVal0)) break;
      const { applied: deltaVal, clamped } = clampDelta(deltaVal0);
      const before0 = Array.isArray(cur) && typeof cur[0] === 'number' ? cur[0]
        : (typeof cur === 'number' ? cur : null);
      if (Array.isArray(cur) && cur.length > 0 && typeof cur[0] === 'number') {
        cur[0] = cur[0] + deltaVal;
      } else if (typeof cur === 'number') {
        const parent = ensureParent(model, parentTokens);
        if (Array.isArray(parent)) parent[parseInt(key, 10)] = cur + deltaVal;
        else parent[key] = cur + deltaVal;
      } else {
        // cur is undefined/null/non-number — initialize to deltaVal
        const parent = ensureParent(model, parentTokens);
        if (Array.isArray(parent)) parent[parseInt(key, 10) || 0] = deltaVal;
        else parent[key] = deltaVal;
      }
      recordMvuOp({
        op: 'delta', path: op.path, requested: deltaVal0, applied: deltaVal, clamped,
        before: before0, after: (before0 == null ? deltaVal : before0 + deltaVal),
      });
      break;
    }
    case 'get': {
      return clone(resolve(model, tokens));
    }
    /* ────────────────────────────────────────────────────────────────────────
     * SAM v6 extended op vocabulary
     *
     * (Note: the path-less ops 'time' and 'func' are handled at the top of
     * applySingle before splitPath.) All ops below address a path and reuse the
     * splitPath / resolve / ensureParent + FORBIDDEN safety model, so prototype
     * pollution is still impossible.
     * ──────────────────────────────────────────────────────────────────────── */
    case 'inc': {
      // Increment a numeric value by op.value; init to value if missing/non-number.
      const v0 = Number(op.value);
      if (isNaN(v0)) break;
      const { applied: v, clamped } = clampDelta(v0);
      const parent = ensureParent(model, parentTokens);
      let before1 = null;
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        before1 = typeof parent[idx] === 'number' ? parent[idx] : null;
        parent[idx] = (typeof parent[idx] === 'number' ? parent[idx] : 0) + v;
      } else {
        const cur = resolve(model, tokens);
        before1 = typeof cur === 'number' ? cur : null;
        parent[key] = (typeof cur === 'number' ? cur : 0) + v;
      }
      recordMvuOp({
        op: 'inc', path: op.path, requested: v0, applied: v, clamped,
        before: before1, after: (before1 == null ? v : before1 + v),
      });
      break;
    }
    case 'mul': {
      // Multiply a numeric value by op.value; init to 0*value if missing/non-number.
      const v = Number(op.value);
      if (isNaN(v)) break;
      const parent = ensureParent(model, parentTokens);
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        parent[idx] = (typeof parent[idx] === 'number' ? parent[idx] : 0) * v;
      } else {
        const cur = resolve(model, tokens);
        parent[key] = (typeof cur === 'number' ? cur : 0) * v;
      }
      break;
    }
    case 'min': {
      // Set the value to the smaller of current and op.value.
      const v = Number(op.value);
      if (isNaN(v)) break;
      const parent = ensureParent(model, parentTokens);
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        const base = typeof parent[idx] === 'number' ? parent[idx] : Infinity;
        parent[idx] = Math.min(base, v);
      } else {
        const cur = resolve(model, tokens);
        parent[key] = typeof cur === 'number' ? Math.min(cur, v) : v;
      }
      break;
    }
    case 'max': {
      // Set the value to the larger of current and op.value.
      const v = Number(op.value);
      if (isNaN(v)) break;
      const parent = ensureParent(model, parentTokens);
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        const base = typeof parent[idx] === 'number' ? parent[idx] : -Infinity;
        parent[idx] = Math.max(base, v);
      } else {
        const cur = resolve(model, tokens);
        parent[key] = typeof cur === 'number' ? Math.max(cur, v) : v;
      }
      break;
    }
    case 'push': {
      // Append op.value to the array at path (create the array if missing).
      const parent = ensureParent(model, parentTokens);
      let arr;
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        arr = parent[idx];
        if (!Array.isArray(arr)) { parent[idx] = []; arr = parent[idx]; }
      } else {
        arr = parent[key];
        if (!Array.isArray(arr)) { parent[key] = []; arr = parent[key]; }
      }
      arr.push(clone(op.value));
      break;
    }
    case 'pop': {
      // Remove the last element of the array at path.
      const parent = ensureParent(model, parentTokens);
      let arr;
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) arr = parent[parseInt(key, 10)];
      else arr = parent[key];
      if (Array.isArray(arr) && arr.length) arr.pop();
      break;
    }
    case 'pull': {
      // Remove all elements deeply equal to op.value from the array at path.
      const parent = ensureParent(model, parentTokens);
      let arr;
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) arr = parent[parseInt(key, 10)];
      else arr = parent[key];
      if (Array.isArray(arr)) {
        const need = JSON.stringify(clone(op.value));
        for (let i = arr.length - 1; i >= 0; i--) {
          if (JSON.stringify(arr[i]) === need) arr.splice(i, 1);
        }
      }
      break;
    }
    case 'addToSet': {
      // Append op.value only if not already present (deep-equality dedup).
      const parent = ensureParent(model, parentTokens);
      let arr;
      if (Array.isArray(parent) && !isNaN(parseInt(key, 10))) {
        const idx = parseInt(key, 10);
        arr = parent[idx];
        if (!Array.isArray(arr)) { parent[idx] = []; arr = parent[idx]; }
      } else {
        arr = parent[key];
        if (!Array.isArray(arr)) { parent[key] = []; arr = parent[key]; }
      }
      const need = JSON.stringify(clone(op.value));
      if (!arr.some(x => JSON.stringify(x) === need)) arr.push(clone(op.value));
      break;
    }
    case 'insert': {
      // Insert op.value into the array at index = path's last segment.
      const arr = resolve(model, parentTokens);
      if (!Array.isArray(arr)) break;
      const idx = parseInt(key, 10);
      if (isNaN(idx) || idx < 0 || idx > arr.length) break;
      arr.splice(idx, 0, clone(op.value));
      break;
    }
    default:
      throw new Error('Unsupported JSON Patch op: ' + op.op);
  }
  return undefined;
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  const serialized = JSON.stringify(v);
  if (serialized.length > MAX_CLONE_BYTES) {
    throw new Error('Object too large to clone');
  }
  return JSON.parse(serialized);
}

/**
 * Apply an array of RFC 6902 patch operations to a (cloned) model.
 * Returns a new model; throws on invalid op / path.
 */
function applyJsonPatch(model, patches) {
  const next = clone(model || {});
  if (!Array.isArray(patches)) return next;
  let last;
  for (const p of patches) {
    last = applySingle(next, p);
  }
  return next;
}

/**
 * Extract <json_patch>/<JSONPatch> blocks from text and parse each as an
 * RFC 6902 patch array. Matches both lowercase <json_patch> (Tavern Helper
 * style) and capitalized <JSONPatch> (standard MVU Game Maker style).
 * Blocks that fail to parse are skipped (runtime detection).
 * Returns an array of patch-arrays (one per block).
 */
function extractJsonPatches(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  // Case-insensitive: matches <json_patch>, <JSONPatch>, <Json_Patch> etc.
  const re = /<(json_patch|JSONPatch)>([\s\S]*?)<\/(?:json_patch|JSONPatch)>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[2].trim();
    if (!raw) continue;
    // Robust extraction: AI may prefix with comments/markdown (e.g. "- All the
    // JSONPatch write here"). Find the first '[' to the last ']' and parse that.
    const s = raw.indexOf('[');
    const e = raw.lastIndexOf(']');
    if (s < 0 || e < 0 || e < s) continue;
    try {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(parsed) && parsed.every(p => p && typeof p === 'object' && typeof p.op === 'string' && typeof p.path === 'string')) {
        out.push(parsed);
      }
    } catch (err) {
      // Not valid RFC 6902 — skip (falls back to raw display in UI)
    }
  }
  return out;
}

/**
 * Apply all <json_patch> blocks found in text to the model.
 */
function applyJsonPatchesFromText(model, text) {
  const blocks = extractJsonPatches(text);
  let next = clone(model || {});
  for (const block of blocks) {
    try {
      next = applyJsonPatch(next, block);
    } catch (err) {
      // One malformed patch block must not abort the whole world-state apply.
      console.warn('[jsonpatch] skip bad JSONPatch block:', err.message);
    }
  }
  return next;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tavern Helper <UpdateVariables> support
 *
 * Many complex cards (e.g. Tavern Helper / MVU scripts) emit variable updates using a
 * SQL-flavoured dialect rather than RFC 6902 patches:
 *
 *   <UpdateVariables>
 *   @.SELECT_ADD("mc.stargazers", "name", "AA-013", "affection", 100);
 *   @.SELECT_SET("mc.stargazers", "name", "AA-013", "lust", 500);
 *   @.SELECT_SET("mc.stargazers", "name", "AA-013", "optional.命定之人", "示例用户");
 *   @.SELECT_SET("mc.ships", "designation", "“黑鸦”号", "assigned_stargazer", "AA-013");
 *   </UpdateVariables>
 *
 * - arrPath is a dot-path to an ARRAY inside worldState (e.g. "mc.stargazers")
 * - keyField/keyVal locate the record within that array
 * - field is the property to set on the record (supports dot-nested keys like
 *   "optional.命定之人" → record.optional["命定之人"])
 * - value may be a number, string, bool or null
 * - SELECT_ADD creates the record if missing; SELECT_SET requires it exist
 * - SELECT_GET is read-only and ignored on apply
 * A 3-arg shorthand (path, field, value) sets a value directly on a nested object.
 * ────────────────────────────────────────────────────────────────────────── */

// Tokenise top-level comma-separated args, respecting nested quotes / parens.
function parseSqlArgs(s) {
  const args = [];
  let inStr = false, depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inStr = !inStr; cur += c; }
    else if (c === '(' && !inStr) { depth++; cur += c; }
    else if (c === ')' && !inStr) { depth--; cur += c; }
    else if (c === ',' && !inStr && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

// Coerce a single raw argument token into { kind, value }.
function coerceArg(raw) {
  const t = (raw || '').trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return { kind: 'str', value: t.slice(1, -1) };
  }
  if (t === 'true') return { kind: 'bool', value: true };
  if (t === 'false') return { kind: 'bool', value: false };
  if (t === 'null') return { kind: 'null', value: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: 'num', value: Number(t) };
  return { kind: 'raw', value: t };
}

// Coerce the final value argument (string literal / number / bool / null / bare token).
function coerceValue(raw) {
  return coerceArg(raw).value;
}

// Set a (possibly dot-nested) field on an object: "optional.命定之人" → obj.optional["命定之人"].
function setNested(obj, field, value) {
  const parts = String(field).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (FORBIDDEN.has(p)) return;
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!FORBIDDEN.has(last)) cur[last] = value;
}

// Resolve a dot-path, creating plain objects along the way. Returns the container.
function resolveDotPathCreateObj(model, dotPath) {
  const parts = String(dotPath).split('.');
  let cur = model;
  for (const p of parts) {
    if (FORBIDDEN.has(p)) return undefined;
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  return cur;
}

// Resolve a dot-path whose final segment is expected to be an ARRAY (created if absent).
function resolveDotPathArray(model, dotPath) {
  const parts = String(dotPath).split('.');
  let cur = model;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (FORBIDDEN.has(p)) return undefined;
    if (i === parts.length - 1) {
      if (cur[p] === undefined || cur[p] === null) cur[p] = [];
      return cur[p];
    }
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  return cur;
}

function applyOneUpdate(model, op) {
  if (!op || typeof op !== 'object') return;
  const type = String(op.type || '').toUpperCase();
  if (type === 'GET' || type === 'SELECT_GET') return; // read-only, nothing to apply
  const args = Array.isArray(op.args) ? op.args : [];

  // SELECT_DEL: 3-arg — remove record from array by keyField/keyVal match
  // SELECT_DEL("arrPath", "keyField", "keyVal")
  if (type === 'SELECT_DEL' && args.length >= 3) {
    const arrPath = coerceArg(args[0]).value;
    const keyField = coerceArg(args[1]).value;
    const keyVal = coerceArg(args[2]).value;
    const arr = resolveDotPathArray(model, String(arrPath));
    if (Array.isArray(arr)) {
      const idx = arr.findIndex(r => r && r[keyField] === keyVal);
      if (idx >= 0) arr.splice(idx, 1);
    }
    return;
  }

  // DEL: 2-arg — remove item from list by index, or delete key from object
  // DEL("path.to.list", index)
  if (type === 'DEL' && args.length >= 2) {
    const dotPath = String(coerceArg(args[0]).value);
    const idxVal = coerceValue(args[1]);
    const parts = dotPath.split('.');
    let cur = model;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (FORBIDDEN.has(p)) return;
      if (cur[p] == null || typeof cur[p] !== 'object') return;
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (FORBIDDEN.has(last)) return;
    const target = cur[last];
    if (Array.isArray(target)) {
      const i = Number(idxVal);
      if (!isNaN(i) && i >= 0 && i < target.length) target.splice(i, 1);
    } else if (target && typeof target === 'object') {
      delete target[String(idxVal)];
    }
    return;
  }

  // ADD: 2-arg — append to list, or increment number, or set initial value
  // ADD("path.to.var", value)
  if (type === 'ADD' && args.length >= 2) {
    const dotPath = String(coerceArg(args[0]).value);
    const val = coerceValue(args[1]);
    const parts = dotPath.split('.');
    let cur = model;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (FORBIDDEN.has(p)) return;
      if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (FORBIDDEN.has(last)) return;
    if (Array.isArray(cur[last])) {
      cur[last].push(val);
    } else if (typeof cur[last] === 'number' && typeof val === 'number') {
      cur[last] = cur[last] + val;
    } else {
      cur[last] = val;
    }
    return;
  }

  // SET: 2-arg — direct set value at dot-path
  // SET("path.to.var", value)
  if (type === 'SET' && args.length === 2) {
    const dotPath = String(coerceArg(args[0]).value);
    const val = coerceValue(args[1]);
    const parts = dotPath.split('.');
    let cur = model;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (FORBIDDEN.has(p)) return;
      if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (!FORBIDDEN.has(last)) cur[last] = val;
    return;
  }

  // TIME: 1-arg — set the time field
  // TIME("2898-07-16T15:30:00.000Z")
  if (type === 'TIME' && args.length >= 1) {
    const val = coerceValue(args[0]);
    if (model.time === undefined || model.time === null) {
      model.time = val;
    } else if (typeof model.time === 'object') {
      model.time.current = val;
    } else {
      model.time = val;
    }
    return;
  }

  // 3-arg direct form: SET("dotted.path", "field", value)
  if (args.length === 3) {
    const p1 = coerceArg(args[0]).value;
    const p2 = coerceArg(args[1]).value;
    const val = coerceValue(args[2]);
    if (p1 === undefined || p1 === null || p2 === undefined) return;
    const container = resolveDotPathCreateObj(model, String(p1));
    if (container === undefined) return;
    setNested(container, String(p2), val);
    return;
  }

  // 5-arg array-record form: SET("arrPath", "keyField", "keyVal", "field", value)
  if (args.length >= 5) {
    const arrPath = coerceArg(args[0]).value;
    const keyField = coerceArg(args[1]).value;
    const keyVal = coerceArg(args[2]).value;
    const field = coerceArg(args[3]).value;
    const value = coerceValue(args[4]);
    if (arrPath === undefined || arrPath === null || keyField === undefined || field === undefined) return;
    const arr = resolveDotPathArray(model, String(arrPath));
    if (Array.isArray(arr)) {
      let rec = arr.find(r => r && r[keyField] === keyVal);
      if (!rec) {
        // SELECT_ADD/SET both upsert: create the record if it doesn't exist yet,
        // so a card can emit a bare SELECT_SET to register a new entity (e.g. a ship).
        rec = {};
        rec[keyField] = keyVal;
        arr.push(rec);
      }
      setNested(rec, String(field), value);
    } else if (arr && typeof arr === 'object') {
      // arrPath resolved to an existing object (not a record array, e.g. mc.player) —
      // set the field directly on it (ignores keyField/keyVal lookup).
      setNested(arr, String(field), value);
    }
  }
}

/**
 * Parse <UpdateVariables> and <variable_update_call_format> blocks into an
 * array of operations: { type: 'ADD'|'SET'|'DEL'|'SELECT_ADD'|'SELECT_SET'|
 * 'SELECT_DEL'|'TIME'|..., args: [rawArg, ...] }
 *
 * Two wrapper tags are recognised (same SQL-dialect content inside):
 *   <UpdateVariables>               — Tavern Helper style (plural)
 *   <variable_update_call_format>   — SAM-style custom wrapper
 *
 * Supported verbs (case-insensitive, @. prefix optional):
 *   SELECT_ADD / SELECT_SET  — 5-arg upsert record field (existing)
 *   SELECT_DEL               — 3-arg remove record from array by key match
 *   SET                      — 2-arg direct set; 3-arg container+field+value
 *   ADD                      — 2-arg append to list / increment number
 *   DEL                      — 2-arg remove from list by index
 *   TIME                     — 1-arg set time field
 *   GET / SELECT_GET         — read-only, ignored on apply
 */
function parseUpdateVariables(text) {
  const ops = [];
  if (!text || typeof text !== 'string') return ops;
  const re = /<(UpdateVariables|variable_update_call_format)>([\s\S]*?)<\/(?:UpdateVariables|variable_update_call_format)>/gi;
  let block;
  while ((block = re.exec(text)) !== null) {
    const stmts = block[2].split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      // SELECT_* verbs must be matched before bare SET/ADD/DEL to avoid partial matches
      const m = stmt.match(/^(?:@\.|var_update\.)?(SELECT_ADD|SELECT_SET|SELECT_DEL|SELECT_GET|SET|ADD|DEL|TIME|GET)\s*\(([\s\S]*)\)$/i);
      if (!m) continue;
      const args = parseSqlArgs(m[2]);
      if (!args.length) continue;
      ops.push({ type: m[1].toUpperCase(), args });
    }
  }
  return ops;
}

/**
 * Apply a list of parsed <UpdateVariables> operations to a (cloned) model.
 */
function applyUpdateVariables(model, ops) {
  const m = (model && typeof model === 'object') ? model : {};
  if (!Array.isArray(ops)) return m;
  for (const op of ops) applyOneUpdate(m, op);
  return m;
}

/**
 * Extract a <|state|> initial-state block from text (typically inside an HTML
 * comment: <!--<|state|>{...}</|state|>-->). Flattens the "static" wrapper so
 * that update commands like @.SET("mc.credits", 500) align with the seeded model.
 *
 * Returns a merged object or null if no block was found.
 */
function seedFromStateBlock(text) {
  if (!text || typeof text !== 'string') return null;
  // Match <|state|>...</|state|> (the opening may be preceded by <!-- and the
  // closing followed by -->).  We only need the JSON payload between the tags.
  const re = /<\|state\|>([\s\S]*?)<\/\|state\|>/i;
  const m = text.match(re);
  if (!m) return null;
  let raw = m[1].trim();
  // Find the JSON object (first '{' to last '}')
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0 || e < s) return null;
  let obj;
  try {
    obj = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  // Flatten: merge static.* up to top level so update dot-paths align
  const result = {};
  if (obj.static && typeof obj.static === 'object') {
    for (const [k, v] of Object.entries(obj.static)) {
      if (!FORBIDDEN.has(k)) result[k] = v;
    }
  }
  // Copy non-static keys (time, volatile, responseSummary, func, etc.)
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'static' && !FORBIDDEN.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Apply BOTH <json_patch>/<JSONPatch> (RFC 6902) and <UpdateVariables>/
 * <variable_update_call_format> (Tavern Helper / SAM SQL dialect) updates
 * found in text to the model — the merged world-state applier used everywhere.
 */
function applyWorldStateFromText(model, text) {
  let m = applyJsonPatchesFromText(model, text);
  return applyUpdateVariables(m, parseUpdateVariables(text));
}

/**
 * Extract a <SAMCheckpoint> block from text and parse it as a full world-state
 * JSON object (SAM v6 snapshot of the entire state at that moment).
 *
 * The checkpoint is authoritative — when present, the caller should use it as
 * the base model (replacing the DB-stored state) and then apply any
 * <JSONPatch>/<UpdateVariables> deltas found in the same text on top of it.
 *
 * Returns the parsed object, or null when no checkpoint block is present.
 */
function extractCheckpoint(text) {
  if (!text || typeof text !== 'string') return null;
  const re = /<SAMCheckpoint>([\s\S]*?)<\/SAMCheckpoint>/i;
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  // Find the JSON object (first '{' to last '}')
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0 || e < s) return null;
  try {
    const obj = JSON.parse(raw.slice(s, e + 1));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  applyJsonPatch,
  extractJsonPatches,
  applyJsonPatchesFromText,
  splitPath,
  parseUpdateVariables,
  applyUpdateVariables,
  applyOneUpdate,
  applyWorldStateFromText,
  seedFromStateBlock,
  extractCheckpoint,
  // 数值边界与审计（2026-09-21 新增）
  getMvuAuditLog: () => mvuAuditLog.slice(),
  MVU_DELTA_ABS_MAX,
};

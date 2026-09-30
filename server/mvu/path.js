/**
 * MVU path utilities — a faithful port of the reference implementation.
 *
 * Reference: MagVarUpdate/src/function/update_variables.ts
 *   · pathFix()                      (lines 673-749)
 *   · pathSegmentsToLodashPath()    (lines 350-354)
 *   · jsonPatchPathToCommandPath()  (lines 356-363)
 *
 * Why this matters: MVU cards use Chinese keys, keys with spaces, and keys that
 * contain dots. Without this normalisation every such path silently fails.
 */
'use strict';

const _ = require('lodash');

/**
 * Normalise an MVU command path (lodash-ish) into lodash's own path syntax.
 *
 * Rules (mirrors the reference exactly):
 *   a[0]        -> a[0]            (bare digits = array index)
 *   a["0"]      -> a["0"]          (quoted digits = string key)
 *   a[武器栏]    -> a[武器栏]        (non-numeric, no whitespace)
 *   a[喵 呜]     -> a["喵 呜"]      (whitespace -> quoted key)
 *   a."武器栏"   -> a.武器栏        (simple quoted field -> plain)
 *   a."背 包"    -> a["背 包"]      (complex quoted field -> bracket)
 */
function pathFix(path) {
  if (!path) return path;

  // 1) bracket segments
  const fixedBrackets = String(path).replace(/\[([^\]]*)\]/g, (match, rawInner) => {
    let inner = String(rawInner).trim();
    if (!inner) return '[]';

    let wasQuoted = false;
    const first = inner[0];
    const last = inner[inner.length - 1];
    if (inner.length >= 2 && (first === '"' || first === "'") && first === last) {
      wasQuoted = true;
      inner = inner.slice(1, -1);
    }

    const isPureDigits = /^\d+$/.test(inner);
    const hasWhitespace = /\s/.test(inner);

    if (isPureDigits) {
      if (!wasQuoted) return `[${inner}]`;          // bare digits -> array index
      return `["${inner.replace(/"/g, '\\"')}"]`;  // quoted digits -> string key
    }
    if (hasWhitespace) {
      return `["${inner.replace(/"/g, '\\"')}"]`;
    }
    return `[${inner}]`;
  });

  // 2) dotted segments that are wholly quoted
  const fixedDots = fixedBrackets.replace(
    /(^|\.)(["\'])([^"\']*)\2(?=\.|\[|$)/g,
    (match, prefix, quote, name) => {
      const hasWhitespace = /\s/.test(name);
      const hasSpecial = /[.[\]]/.test(name);
      if (!hasWhitespace && !hasSpecial) return prefix + name;   // foo."武器栏" -> foo.武器栏
      const escaped = name.replace(/"/g, '\\"');
      if (prefix === '.') return `["${escaped}"]`;              // foo."a b" -> foo["a b"]
      return `${prefix}["${escaped}"]`;                         // "a b".c   -> ["a b"].c
    }
  );

  return fixedDots;
}

/** Build a lodash path from pre-split segments, quoting every segment. */
function pathSegmentsToLodashPath(pathSegments) {
  return (pathSegments || [])
    .map(seg => `["${String(seg).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
    .join('');
}

/** Convert an RFC 6902 JSON-Pointer path into an MVU command path. */
function jsonPatchPathToCommandPath(path) {
  if (!path) return '';
  const withoutRoot = path.startsWith('/') ? path.slice(1) : path;
  const segments = withoutRoot.split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  return pathSegmentsToLodashPath(segments);
}

/** lodash toPath, kept as one place so behaviour can be swapped in tests. */
function toPath(path) {
  return _.toPath(path);
}

module.exports = { pathFix, pathSegmentsToLodashPath, jsonPatchPathToCommandPath, toPath };

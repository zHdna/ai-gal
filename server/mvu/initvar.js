/**
 * MVU variable initialisation ([InitVar] worldbook entries + the opening-message <initvar> block).
 *
 * Ported from MagVarUpdate/src/function/initvar/variable_init.ts:
 *   · loadInitVarData (250)  · the opening-message override (155-186)  · createEmptyGameData (332)
 *
 * Semantics that must be preserved:
 *   · Entries are found by comment containing '[initvar]' (lower-cased compare) and are
 *     used EVEN IF the entry is disabled.
 *   · Entry content may be wrapped in <initvar>...</initvar> or a fenced code block; both
 *     wrappers are stripped before parsing.
 *   · Parsing is YAML-first (YAML is a JSON superset).
 *   · Multiple entries are deep-merged in order (later wins).
 *   · Merge direction is { ...initvar, ...existingStatData } — EXISTING DATA WINS, so a
 *     repeated initialisation can never wipe the player@sQ@s progress.
 *   · 'initialized_lorebooks' records which worldbooks were initialised, so it happens once.
 */
'use strict';

const _ = require('lodash');
const YAML = require('yaml');
const { cleanUpMetadata } = require('./schema');

/** Empty MvuData skeleton (mirrors createEmptyGameData). */
function createEmptyGameData() {
  return {
    display_data: {},
    initialized_lorebooks: {},
    stat_data: {},
    delta_data: {},
    schema: { type: 'object', properties: {} },
  };
}

/** Parse one InitVar blob: strip wrappers, then YAML/JSON parse. Returns null on failure. */
function parseInitVarContent(rawContent) {
  let content = String(rawContent === undefined || rawContent === null ? '' : rawContent).trim();
  if (!content) return null;

  const xmlMatch = content.match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m);
  if (xmlMatch) content = xmlMatch[1];

  const codeMatch = content.trim().match(/```.*\n([\s\S]*)\n```/m);
  if (codeMatch) content = codeMatch[1];

  try {
    const parsed = YAML.parse(content);
    return parsed === undefined ? null : parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Deep-merge `source` into `target` (arrays and objects merged, source wins).
 * Mirrors the reference's correctlyMerge() usage for InitVar entries.
 */
function correctlyMerge(target, source) {
  if (!_.isObject(target) || !_.isObject(source)) return target;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(tv) && Array.isArray(sv)) {
      target[key] = tv.map((item, i) => (i < sv.length ? correctlyMergeDeep(item, sv[i]) : item));
      for (let i = tv.length; i < sv.length; i++) target[key].push(sv[i]);
    } else if (_.isPlainObject(tv) && _.isPlainObject(sv)) {
      correctlyMerge(tv, sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

function correctlyMergeDeep(a, b) {
  if (_.isPlainObject(a) && _.isPlainObject(b)) return correctlyMerge(_.cloneDeep(a), b);
  return b;
}

/**
 * Load every [InitVar] entry of the given worldbooks into mvuData.stat_data.
 * @param {object} mvuData                      MvuData (mutated)
 * @param {Array<{name:string, entries:Array}>} worldbooks  enabled worldbooks with their entries
 * @param {(s:string)=>string} [substitute]      optional macro substitution
 * @returns {boolean} whether anything was applied
 */
function loadInitVarData(mvuData, worldbooks, substitute) {
  if (!_.isObject(mvuData.initialized_lorebooks) || Array.isArray(mvuData.initialized_lorebooks)) {
    mvuData.initialized_lorebooks = {};
  }
  let isUpdated = false;

  for (const book of worldbooks || []) {
    const bookName = book && book.name;
    if (!bookName) continue;
    if (_.has(mvuData.initialized_lorebooks, bookName)) continue;
    mvuData.initialized_lorebooks[bookName] = [];

    const mergedData = {};
    for (const entry of (book.entries || [])) {
      const comment = String((entry && entry.comment) || '');
      if (!comment.toLowerCase().includes('[initvar]')) continue;
      let content = String((entry && entry.content) || '');
      if (typeof substitute === 'function') {
        try { content = substitute(content); } catch (e) { /* keep raw */ }
      }
      const parsed = parseInitVarContent(content);
      if (parsed && _.isObject(parsed)) correctlyMerge(mergedData, parsed);
    }

    // Existing data wins — re-initialisation must never roll back progress.
    mvuData.stat_data = Object.assign({}, mergedData, mvuData.stat_data);
    isUpdated = true;
  }

  return isUpdated;
}

/**
 * Apply an opening-message <initvar> block: it REPLACES stat_data and resets the lorebook
 * bookkeeping so the other worldbooks initialise again on top of it.
 * Returns the parsed override, or null when the message has no such block.
 */
function applyOpeningInitVarOverride(mvuData, openingMessageContent, characterBookName) {
  const content = String(openingMessageContent || '');
  const m = content.match(/<initvar>([\s\S]*?)<\/initvar>/i);
  if (!m) return null;

  const parsed = parseInitVarContent(m[1]);
  if (!parsed || !_.isObject(parsed)) return null;

  mvuData.stat_data = parsed;
  mvuData.initialized_lorebooks = {};
  if (characterBookName) mvuData.initialized_lorebooks[characterBookName] = [];
  cleanUpMetadata(mvuData.stat_data);
  return parsed;
}

module.exports = {
  createEmptyGameData,
  parseInitVarContent,
  correctlyMerge,
  loadInitVarData,
  applyOpeningInitVarOverride,
};

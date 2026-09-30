/**
 * MVU command extraction: the state-machine parser.
 *
 * Ported from MagVarUpdate/src/function/update_variables.ts:
 *   · extractJsonPatch (365) · extractCommands (437) · findMatchingCloseParen (570)
 *   · parseParameters (610)
 *
 * Three behaviours must be preserved exactly, because naive regexes break on real cards:
 *
 *   1. A command ends at the matching close paren, NOT at the first `);`. Argument text may
 *      contain nested () [] {} and quoted strings with brackets inside.
 *   2. A command is only valid when followed by `;`. A `//` comment right after the `;`
 *      becomes the command's reason.
 *   3. `<json_patch>` blocks and inline `_.xxx()` calls may be mixed in one reply. Both are
 *      collected and re-sorted by position, so operations apply in the order the model wrote
 *      them.
 */
'use strict';

const _ = require('lodash');
const { jsonPatchPathToCommandPath, pathSegmentsToLodashPath } = require('./path');

/** Command names accepted from the model (aliases are normalised later). */
const COMMAND_NAMES = 'set|insert|assign|remove|unset|delete|add';

/** Find the matching close paren, ignoring parens inside quotes. */
function findMatchingCloseParen(str, startPos) {
  let parenCount = 1;
  let inQuote = false;
  let quoteChar = '';

  for (let i = startPos; i < str.length; i++) {
    const char = str[i];
    const prevChar = i > 0 ? str[i - 1] : '';

    if ((char === '"' || char === '\'' || char === '`') && prevChar !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
    }

    if (!inQuote) {
      if (char === '(') parenCount++;
      else if (char === ')') {
        parenCount--;
        if (parenCount === 0) return i;
      }
    }
  }
  return -1;
}

/** Split a command's argument string on top-level commas (quote/bracket aware). */
function parseParameters(paramsString) {
  const params = [];
  let currentParam = '';
  let inQuote = false;
  let quoteChar = '';
  let bracketCount = 0;
  let braceCount = 0;
  let parenCount = 0;

  for (let i = 0; i < paramsString.length; i++) {
    const char = paramsString[i];

    if ((char === '"' || char === '\'' || char === '`') && (i === 0 || paramsString[i - 1] !== '\\')) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
      currentParam += char;
      continue;
    }

    if (inQuote) {
      currentParam += char;
      continue;
    }

    if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
    else if (char === '{') braceCount++;
    else if (char === '}') braceCount--;
    else if (char === '(') parenCount++;
    else if (char === ')') parenCount--;

    if (char === ',' && bracketCount === 0 && braceCount === 0 && parenCount === 0) {
      params.push(currentParam.trim());
      currentParam = '';
      continue;
    }
    currentParam += char;
  }
  if (currentParam.trim() || params.length > 0) params.push(currentParam.trim());
  return params;
}

/** Translate one RFC 6902 operation into MVU command form. */
function extractJsonPatch(patch) {
  const translated = [];
  if (!Array.isArray(patch)) return translated;

  for (const op of patch) {
    const path = jsonPatchPathToCommandPath(op.path !== undefined ? op.path : op.to);
    switch (op.op) {
      case 'replace':
        translated.push({ type: 'set', full_match: JSON.stringify(op), args: [path, JSON.stringify(op.value)], reason: 'json_patch' });
        break;
      case 'delta':
        translated.push({ type: 'add', full_match: JSON.stringify(op), args: [path, JSON.stringify(op.value)], reason: 'json_patch' });
        break;
      case 'insert':
      case 'add': {
        const pathParts = _.toPath(path);
        const lastPart = pathParts[pathParts.length - 1];
        const containerPath = pathSegmentsToLodashPath(pathParts.slice(0, -1));
        const keyOrIndexArg = /^\d+$/.test(lastPart) ? lastPart : JSON.stringify(lastPart);
        translated.push({ type: 'insert', full_match: JSON.stringify(op), args: [containerPath, keyOrIndexArg, JSON.stringify(op.value)], reason: 'json_patch' });
        break;
      }
      case 'remove':
        translated.push({ type: 'delete', full_match: JSON.stringify(op), args: [path], reason: 'json_patch' });
        break;
      case 'move':
        translated.push({ type: 'move', full_match: JSON.stringify(op), args: [jsonPatchPathToCommandPath(op.from), path], reason: 'json_patch' });
        break;
      default:
        break;
    }
  }
  return translated;
}

/**
 * Extract every command from a message, in the order the model wrote them.
 * @param {string} inputText
 * @returns {Array<{type:string, full_match:string, args:string[], reason:string}>}
 */
function extractCommands(inputText) {
  const text = String(inputText || '');
  const results = [];

  // (a) <json_patch> / <JSONPatch> blocks -> commands
  const patchRe = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim;
  let pm;
  while ((pm = patchRe.exec(text)) !== null) {
    const body = String(pm[2] || '').trim();
    const start = pm.index;
    const s = body.indexOf('[');
    const e = body.lastIndexOf(']');
    if (s < 0 || e < 0 || e < s) continue;
    try {
      const parsed = JSON.parse(body.slice(s, e + 1));
      if (Array.isArray(parsed)) {
        for (const cmd of extractJsonPatch(parsed)) results.push(Object.assign({ $index: start }, cmd));
      }
    } catch (err) { /* invalid patch block -> ignore */ }
  }

  // (b) inline _.set / _.add / _.assign / _.remove / ... calls
  let i = 0;
  const cmdRe = new RegExp('_\\.(' + COMMAND_NAMES + ')\\(');
  while (i < text.length) {
    const setMatch = text.substring(i).match(cmdRe);
    if (!setMatch || setMatch.index === undefined) break;

    const commandType = setMatch[1];
    const setStart = i + setMatch.index;
    const openParen = setStart + setMatch[0].length;
    const closeParen = findMatchingCloseParen(text, openParen);
    if (closeParen === -1) { i = openParen; continue; }

    let endPos = closeParen + 1;
    if (endPos >= text.length || text[endPos] !== ';') { i = closeParen + 1; continue; }
    endPos++;

    let comment = '';
    const potentialComment = text.substring(endPos).match(/^\s*\/\/(.*)/);
    if (potentialComment) {
      comment = potentialComment[1].trim();
      endPos += potentialComment[0].length;
    }

    const fullMatch = text.substring(setStart, endPos);
    const paramsString = text.substring(openParen, closeParen);
    const params = parseParameters(paramsString);

    let isValid = false;
    if (commandType === 'set' && params.length >= 2) isValid = true;
    else if (commandType === 'assign' && params.length >= 2) isValid = true;
    else if (commandType === 'insert' && params.length >= 2) isValid = true;
    else if (commandType === 'remove' && params.length >= 1) isValid = true;
    else if (commandType === 'unset' && params.length >= 1) isValid = true;
    else if (commandType === 'delete' && params.length >= 1) isValid = true;
    else if (commandType === 'add' && params.length === 2) isValid = true;

    if (isValid) {
      results.push({ $index: setStart, type: commandType, full_match: fullMatch, args: params, reason: comment });
    }
    i = endPos;
  }

  return _(results).sortBy('$index').map(c => _.omit(c, '$index')).value();
}

/** Normalise aliases exactly like the reference (assign->insert, remove/unset->delete). */
function normalizeAliases(commands) {
  for (const cmd of commands) {
    if (cmd.type === 'remove') cmd.type = 'delete';
    else if (cmd.type === 'assign') cmd.type = 'insert';
    else if (cmd.type === 'unset') cmd.type = 'delete';
  }
  return commands;
}

module.exports = { extractCommands, extractJsonPatch, findMatchingCloseParen, parseParameters, normalizeAliases, COMMAND_NAMES };

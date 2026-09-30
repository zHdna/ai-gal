/**
 * MVU value semantics: VWD detection, command-value parsing, template application.
 *
 * Ported from MagVarUpdate:
 *   · variable_def.ts        isValueWithDescription / ValueWithDescription
 *   · update_variables.ts    trimQuotesAndBackslashes (156), applyTemplate (170),
 *                            parseCommandValue (221)
 *
 * parseCommandValue is deliberately a FOUR-LAYER chain; the order must not change:
 *   JSON  ->  JSON5 (objects/arrays only)  ->  YAML (single-quoted strings)  ->  math  ->  raw string
 */
'use strict';

const JSON5 = require('json5');
const YAML = require('yaml');
const _ = require('lodash');
const { evaluateExpression } = require('./math');

/** A ValueWithDescription pair: [value, description]. */
function isVWD(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

/** Strip surrounding backslashes / quotes / backticks / spaces. */
function trimQuotesAndBackslashes(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/^[\\"\'` ]*(.*?)[\\"\'` ]*$/, '$1');
}

/**
 * Merge a template into a value (value wins). Mirrors the reference behaviour table:
 *   object+object   -> _.merge({}, template, value)
 *   array+array     -> concat (default) or _.merge
 *   literal+array   -> [literal] then concat/merge  (unless strict_array_cast)
 *   type mismatch   -> template skipped
 */
function applyTemplate(value, template, strictArrayCast = false, arrayMergeConcat = true) {
  if (!template) return value;

  const valueIsObject = _.isObject(value) && !Array.isArray(value) && !_.isDate(value);
  const valueIsArray = Array.isArray(value);
  const templateIsArray = Array.isArray(template);

  if (valueIsObject && !templateIsArray) {
    return _.merge({}, template, value);
  } else if (valueIsArray && templateIsArray) {
    if (arrayMergeConcat) return _.concat(value, template);
    return _.merge([], template, value);
  } else if (
    ((valueIsObject || valueIsArray) && templateIsArray !== valueIsArray) ||
    (!valueIsObject && !valueIsArray && _.isObject(template) && !Array.isArray(template))
  ) {
    return value;
  } else if (!valueIsObject && !valueIsArray && templateIsArray) {
    if (strictArrayCast) return value;
    if (arrayMergeConcat) return _.concat([value], template);
    return _.merge([], template, [value]);
  }
  return value;
}

/** Parse one raw command argument the way MVU does (see file header for the order). */
function parseCommandValue(valStr) {
  if (typeof valStr !== 'string') return valStr;
  const trimmed = valStr.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;

  // Layer 1: strict JSON.
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Layer 2: relaxed data literals, but only for objects/arrays.
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const result = JSON5.parse(trimmed);
        if (_.isObject(result) || Array.isArray(result)) return result;
      } catch (err) { /* fall through to math / string */ }
    }
  }

  // Layer 3: single-quoted text goes through YAML (keeps backslashes and '' escaping).
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    try {
      return YAML.parse(trimmed);
    } catch (e) { /* maybe a math expression with quoted operands */ }
  }

  // Layer 4: math expression (never runs for quoted values handled above).
  const mathResult = evaluateExpression(trimmed);
  if (mathResult.ok) return mathResult.value;

  // Layer 5: plain unquoted string.
  return trimQuotesAndBackslashes(valStr);
}

/** Deep clone that also handles plain JSON structures (structuredClone is native in Node 22). */
function clone(value) {
  try {
    return structuredClone(value);
  } catch (e) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }
}

module.exports = { isVWD, trimQuotesAndBackslashes, applyTemplate, parseCommandValue, clone };

/**
 * MVU state lifecycle: the MvuData object, per-layer snapshots, and the update entry point.
 *
 * Ported from MagVarUpdate:
 *   · util.ts getLastValidVariable (20) — search backwards for the last message carrying
 *     stat_data + schema (per swipe).
 *   · update_variables.ts updateVariables (823) / handleVariablesInMessage (1647).
 *
 * Storage policy (decision D1): full MvuData per layer, kept in the SAVE FOLDER
 * (saves/<save>/mvu/), not in the database — so export / delete / copy stay in sync.
 */
'use strict';

const _ = require('lodash');
const { extractCommands, normalizeAliases } = require('./extract');
const { executeCommands } = require('./execute');
const { reconcileAndApplySchema, buildInitialSchema } = require('./schema');
const { createEmptyGameData } = require('./initvar');
const { clone } = require('./value');

/** True when a value looks like an MvuData snapshot (stat_data + schema present). */
function isMvuData(variables) {
  return _.isObject(variables) && _.get(variables, 'stat_data') !== undefined && _.get(variables, 'schema') !== undefined;
}

/**
 * Pick the newest snapshot at or before `endMessageId`.
 * @param {Array<{messageId:number, swipeId?:number, variables:object}>} snapshots  any order
 */
function getLastValidSnapshot(snapshots, endMessageId) {
  const list = (snapshots || [])
    .filter(s => s && s.variables && isMvuData(s.variables))
    .filter(s => (endMessageId === undefined || endMessageId === null ? true : s.messageId < endMessageId))
    .sort((a, b) => a.messageId - b.messageId);
  return list.length ? list[list.length - 1] : null;
}

/**
 * Apply one assistant message's text to a snapshot, returning a NEW snapshot.
 * This is the single entry point used by the chat pipeline.
 *
 * @param {object} baseVariables   MvuData from the previous layer (or a fresh one)
 * @param {string} messageContent  the assistant message text
 * @param {object} [opts]          { substituteMacros?: (s)=>string }
 * @returns {{variables:object, isUpdated:boolean, errors:Array, applied:Array, commands:Array}}
 */
function updateVariablesFromMessage(baseVariables, messageContent, opts = {}) {
  const variables = clone(baseVariables || createEmptyGameData());
  const before = clone(variables.stat_data || {});

  let text = String(messageContent || '');
  if (typeof opts.substituteMacros === 'function') {
    try { text = opts.substituteMacros(text); } catch (e) { /* keep raw */ }
  }

  const commands = normalizeAliases(extractCommands(text));
  const { errors, applied } = executeCommands(variables, commands);

  const isModified = !_.isEqual(variables.stat_data, before);
  if (isModified) reconcileAndApplySchema(variables);

  return { variables, isUpdated: isModified, errors, applied, commands };
}

/** Build the first MvuData for a new game (InitVar entries already merged by caller). */
function makeInitialState(statData) {
  const variables = createEmptyGameData();
  variables.stat_data = statData || {};
  variables.schema = buildInitialSchema(variables.stat_data);
  return variables;
}

module.exports = { isMvuData, getLastValidSnapshot, updateVariablesFromMessage, makeInitialState };

/**
 * MVU command execution: set / insert / delete / add / move.
 *
 * Ported from MagVarUpdate/src/function/update_variables.ts (updateVariables body,
 * cases at lines 906/997/1265/1470, plus the alias normalisation at 864-873).
 *
 * Contract that must hold:
 *   · Every command is validated against the schema BEFORE it mutates anything.
 *   · Illegal commands are REJECTED with a readable error (never applied silently).
 *   · VWD ([value, description]) keeps its description: only element 0 changes.
 *   · display_data records `old->new (reason)` for each applied change.
 */
'use strict';

const _ = require('lodash');
const { pathFix, pathSegmentsToLodashPath } = require('./path');
const { isVWD, parseCommandValue, applyTemplate, trimQuotesAndBackslashes, clone } = require('./value');
const { generateSchema, getSchemaForPath, cleanUpMetadata, isObjectSchema, isArraySchema } = require('./schema');

function outOfRange(key, obj) {
  if (Array.isArray(obj) && /^\d+$/.test(key)) return Number(key) >= obj.length;
  return false;
}

/**
 * Execute one batch of commands against `variables` (an MvuData object).
 * Mutates variables.stat_data / display_data / delta_data; returns the change log.
 */
function executeCommands(variables, commands, options = {}) {
  const strictSet = (variables.schema && variables.schema.strictSet) || false;
  const strictTemplate = (variables.schema && variables.schema.strictTemplate) || false;
  const concatTemplateArray =
    variables.schema && variables.schema.concatTemplateArray !== undefined
      ? variables.schema.concatTemplateArray
      : true;

  const schema = variables.schema;
  const statData = variables.stat_data;
  const displayData = (variables.display_data = variables.display_data || {});
  const deltaData = (variables.delta_data = variables.delta_data || {});
  const errors = [];
  const applied = [];

  for (const command of commands) {
    const rawPath = command.args && command.args[0];
    const path = pathFix(trimQuotesAndBackslashes(String(rawPath === undefined ? '' : rawPath)));
    const reasonStr = command.reason ? `(${command.reason})` : '';
    let displayStr = '';

    const fail = (message) => {
      errors.push({ command: command.full_match, message });
    };

    try {
      switch (command.type) {
        // ── set ──────────────────────────────────────────────────────────────
        case 'set': {
          if (path !== '' && !_.has(statData, path)) {
            fail(`set target path does not exist: ${path} ${reasonStr}`);
            break;
          }
          let oldValue = path === '' ? clone(statData) : _.get(statData, path);
          let newValue = parseCommandValue(command.args[command.args.length - 1]);
          if (newValue instanceof Date) newValue = newValue.toISOString();

          let isPathVWD = false;
          if (!strictSet && Array.isArray(oldValue) && oldValue.length === 2 && typeof oldValue[1] === 'string' && !Array.isArray(oldValue[0])) {
            const oldInner = clone(oldValue[0]);
            oldValue[0] = typeof oldValue[0] === 'number' && newValue !== null ? Number(newValue) : newValue;
            oldValue = oldInner;
            isPathVWD = true;
          } else if (typeof oldValue === 'number' && newValue !== null && typeof newValue === 'string') {
            _.set(statData, path, Number(newValue));
          } else if (path) {
            _.set(statData, path, newValue);
          } else {
            variables.stat_data = newValue;
          }

          let finalNewValue = path === '' ? variables.stat_data : _.get(variables.stat_data, path);
          const oldForDisplay = isVWD(oldValue) ? oldValue[0] : oldValue;
          const displayNew = isPathVWD && Array.isArray(finalNewValue) ? finalNewValue[0] : finalNewValue;
          displayStr = `${JSON.stringify(oldForDisplay)}->${JSON.stringify(displayNew)} ${reasonStr}`;
          applied.push({ path, op: 'set', oldValue: oldForDisplay, newValue: displayNew, reason: command.reason || '' });
          break;
        }

        // ── insert (_.assign / _.insert / JSONPatch add) ──────────────────────
        case 'insert': {
          const targetPath = path;
          const existingValue = targetPath === '' ? statData : _.get(statData, targetPath);
          const targetSchema = getSchemaForPath(schema, targetPath);

          if (existingValue !== null && !Array.isArray(existingValue) && !_.isObject(existingValue)) {
            fail(`cannot insert into a primitive at ${targetPath} ${reasonStr}`);
            break;
          }
          if (targetSchema && targetSchema.extensible !== true) {
            fail(`target is not extensible: ${targetPath} ${reasonStr}`);
            break;
          }

          const isArrayTarget = Array.isArray(existingValue);
          const isObjectTarget = _.isObject(existingValue) && !isArrayTarget;

          let keyOrIndex;
          let valueArg;
          if (command.args.length >= 3) {
            keyOrIndex = parseCommandValue(command.args[1]);
            if (typeof keyOrIndex === 'string') keyOrIndex = trimQuotesAndBackslashes(keyOrIndex);
            valueArg = parseCommandValue(command.args[2]);
          } else {
            valueArg = parseCommandValue(command.args[1]);
          }

          const templateValue = applyTemplate(valueArg, targetSchema && targetSchema.template, strictTemplate, concatTemplateArray);

          if (isArrayTarget) {
            if (keyOrIndex === undefined || keyOrIndex === '-') {
              existingValue.push(templateValue);
            } else {
              const idx = Number(keyOrIndex);
              if (!Number.isFinite(idx)) { fail(`invalid array index for ${targetPath}: ${keyOrIndex}`); break; }
              if (idx < 0 || idx > existingValue.length) { fail(`array index out of range for ${targetPath}: ${idx}`); break; }
              existingValue.splice(idx, 0, templateValue);
            }
            displayStr = `INSERTED into ${targetPath} ${reasonStr}`;
          } else if (isObjectTarget) {
            if (keyOrIndex === undefined || keyOrIndex === '') {
              const parsedObj = parseCommandValue(command.args[1]);
              if (_.isObject(parsedObj) && !Array.isArray(parsedObj)) {
                Object.assign(existingValue, parsedObj);
                displayStr = `MERGED into ${targetPath} ${reasonStr}`;
              } else {
                fail(`_.assign on an object needs a key: ${targetPath} ${reasonStr}`);
                break;
              }
            } else {
              existingValue[String(keyOrIndex)] = templateValue;
              displayStr = `INSERTED ${keyOrIndex} into ${targetPath} ${reasonStr}`;
            }
          } else {
            // null / undefined target: create per root-level meta
            if (targetPath === '') {
              variables.stat_data = valueArg;
              displayStr = `ASSIGNED root ${reasonStr}`;
            } else {
              _.set(statData, targetPath, valueArg);
              displayStr = `CREATED ${targetPath} ${reasonStr}`;
            }
          }

          // keep the schema in sync when the inserted structure introduced new members
          if (targetSchema && _.isObject(valueArg) && !Array.isArray(valueArg)) {
            try {
              const cloneForSchema = clone(valueArg);
              const newSchema = generateSchema(cloneForSchema, targetSchema);
              _.merge(targetSchema, newSchema);
              cleanUpMetadata(valueArg);
            } catch (e) {
              fail(`template/schema resolution failed for ${targetPath}: ${e && e.message}`);
            }
          }
          applied.push({ path: targetPath, op: 'insert', newValue: valueArg, reason: command.reason || '' });
          break;
        }

        // ── delete (_.remove / _.unset / _.delete / JSONPatch remove) ─────────
        case 'delete': {
          const pathParts = _.toPath(path);
          const lastPart = pathParts[pathParts.length - 1];
          const isArrayElementPath = /^\d+$/.test(lastPart);

          if (command.args.length === 1 && isArrayElementPath) {
            const containerPath = pathSegmentsToLodashPath(pathParts.slice(0, -1));
            const container = _.get(statData, containerPath);
            const indexToRemove = parseInt(lastPart, 10);
            if (Array.isArray(container) && indexToRemove < container.length) {
              const containerSchema0 = getSchemaForPath(schema, containerPath);
              if (containerSchema0 && containerSchema0.type === 'array' && containerSchema0.extensible !== true) {
                fail(`array is not extensible: ${containerPath} ${reasonStr}`);
                break;
              }
              container.splice(indexToRemove, 1);
              displayStr = `REMOVED item from ${containerPath} at index ${indexToRemove} ${reasonStr}`;
              applied.push({ path: containerPath, op: 'delete', index: indexToRemove, reason: command.reason || '' });
              break;
            }
          }

          if (!_.has(statData, path)) {
            fail(`remove target path does not exist: ${path} ${reasonStr}`);
            break;
          }

          let containerPath = path;
          let keyOrIndexToRemove;
          if (command.args.length > 1) {
            keyOrIndexToRemove = parseCommandValue(command.args[1]);
            if (typeof keyOrIndexToRemove === 'string') keyOrIndexToRemove = trimQuotesAndBackslashes(keyOrIndexToRemove);
          } else {
            const pp = _.toPath(path);
            const last = pp.pop();
            if (last) {
              keyOrIndexToRemove = /^\d+$/.test(last) ? Number(last) : last;
              containerPath = pathSegmentsToLodashPath(pp);
            }
          }
          if (keyOrIndexToRemove === undefined) {
            fail(`unable to determine delete target: ${path} ${reasonStr}`);
            break;
          }
          if (containerPath !== '' && !_.has(statData, containerPath)) {
            fail(`container path missing: ${containerPath} ${reasonStr}`);
            break;
          }

          const containerSchema = getSchemaForPath(schema, containerPath);
          if (containerSchema) {
            if (containerSchema.type === 'array') {
              if (containerSchema.extensible !== true) { fail(`array is not extensible: ${containerPath} ${reasonStr}`); break; }
            } else if (containerSchema.type === 'object') {
              const keyString = String(keyOrIndexToRemove);
              if (_.has(containerSchema.properties, keyString) && containerSchema.properties[keyString].required === true) {
                fail(`key is required and cannot be removed: ${keyString} @ ${containerPath} ${reasonStr}`);
                break;
              }
            }
          }

          const targetToRemove = command.args.length > 1 ? parseCommandValue(command.args[1]) : undefined;
          if (targetToRemove === undefined) {
            const oldValue = _.get(statData, path);
            _.unset(statData, path);
            displayStr = `REMOVED path ${path} ${reasonStr}`;
            applied.push({ path, op: 'delete', oldValue, reason: command.reason || '' });
          } else {
            const collection = _.get(statData, path);
            if (Array.isArray(collection)) {
              const idx = collection.indexOf(targetToRemove);
              const numeric = typeof targetToRemove === 'number' && targetToRemove < collection.length;
              if (idx >= 0) collection.splice(idx, 1);
              else if (numeric) collection.splice(targetToRemove, 1);
              else { fail(`value not found in array ${path}: ${JSON.stringify(targetToRemove)}`); break; }
              displayStr = `REMOVED ${JSON.stringify(targetToRemove)} from ${path} ${reasonStr}`;
            } else if (_.isObject(collection)) {
              if (!_.has(collection, String(targetToRemove))) { fail(`key not found in ${path}: ${targetToRemove}`); break; }
              _.unset(collection, String(targetToRemove));
              displayStr = `REMOVED key ${targetToRemove} from ${path} ${reasonStr}`;
            } else {
              fail(`remove target is not a collection: ${path} ${reasonStr}`);
              break;
            }
            applied.push({ path, op: 'delete', removed: targetToRemove, reason: command.reason || '' });
          }
          break;
        }

        // ── add (numeric delta) ──────────────────────────────────────────────
        case 'add': {
          if (!_.has(statData, path)) { fail(`add target path does not exist: ${path} ${reasonStr}`); break; }
          const currentRaw = _.get(statData, path);
          const isPathVWD = !strictSet && isVWD(currentRaw) && !Array.isArray(currentRaw[0]);
          const currentValue = isPathVWD ? currentRaw[0] : currentRaw;
          const delta = parseCommandValue(command.args[1]);

          let nextValue = null;
          if (typeof delta === 'number' && !Number.isNaN(delta)) {
            if (typeof currentValue === 'number') nextValue = currentValue + delta;
          } else if (delta instanceof Date && currentValue instanceof Date) {
            nextValue = new Date(currentValue.getTime() + delta.getTime());
          }

          if (nextValue === null) { fail(`_.add needs a number delta and a numeric target: ${path} ${reasonStr}`); break; }

          if (isPathVWD) currentRaw[0] = nextValue;
          else _.set(statData, path, nextValue);

          const before = currentValue instanceof Date ? currentValue.toISOString() : currentValue;
          const after = nextValue instanceof Date ? nextValue.toISOString() : nextValue;
          displayStr = `${JSON.stringify(before)}->${JSON.stringify(after)} ${reasonStr}`;
          applied.push({ path, op: 'add', delta, oldValue: before, newValue: after, reason: command.reason || '' });
          break;
        }

        // ── move (JSON Patch) ───────────────────────────────────────────────
        case 'move': {
          const fromPath = pathFix(trimQuotesAndBackslashes(String(command.args[0] || '')));
          const toPath = path;
          if (!_.has(statData, fromPath)) { fail(`move source does not exist: ${fromPath}`); break; }
          const moving = clone(_.get(statData, fromPath));
          _.unset(statData, fromPath);
          if (toPath === '') { fail(`move needs a destination path`); break; }
          _.set(statData, toPath, moving);
          displayStr = `MOVED ${fromPath} -> ${toPath} ${reasonStr}`;
          applied.push({ path: toPath, op: 'move', from: fromPath, reason: command.reason || '' });
          break;
        }

        default:
          fail(`unknown command type: ${command.type}`);
          break;
      }
    } catch (err) {
      fail(`execution error: ${err && err.message}`);
    }

    if (displayStr) {
      _.set(displayData, path, displayStr);
      _.set(deltaData, path, displayStr);
    }
  }

  return { errors, applied };
}

module.exports = { executeCommands };

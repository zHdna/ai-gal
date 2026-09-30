/**
 * MVU compatibility core (see docs/AI-GAL-MVU-COMPAT-PLAN.md).
 *
 * Pure functions only — no file system, no database, no network. That keeps the whole
 * semantic layer unit-testable, and lets the storage layer (saves/<save>/mvu/) sit on top.
 */
'use strict';

const path = require('./path');
const value = require('./value');
const mathMod = require('./math');
const schema = require('./schema');
const extract = require('./extract');
const execute = require('./execute');
const initvar = require('./initvar');
const state = require('./state');

module.exports = Object.assign({}, path, value, mathMod, schema, extract, execute, initvar, state);

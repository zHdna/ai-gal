/**
 * MVU engine facade — the ONLY entry point the chat pipeline should use.
 *
 * Gating contract (explicit user requirement):
 *   When the active card is NOT an MVU card, the backend must not load the MVU module
 *   at all. That is why this file is lazily required through `getEngine(character)`,
 *   which returns null for non-MVU cards WITHOUT ever requiring ./index.js, ./store.js
 *   or touching the save folder.
 *
 *   The cheap detector lives in server/mvu.js (dependency-free) so the gate itself
 *   costs nothing.
 *
 * Responsibilities:
 *   · seed a new MvuData from the card@s [InitVar] entries + opening message
 *   · load the latest snapshot for a save (save folder first, then DB mirror)
 *   · apply one assistant message and persist the result
 *   · keep conversations.world_state in sync (front-end compatibility)
 */
'use strict';

const { detectMvuCard, detectMvuFaction, FACTION } = require('../mvu');

let engineCache = null;

/**
 * Is this conversation MVU-enabled?
 *
 * Decided by the CARD, not by whatever text happens to be in a message: a narrative line
 * mentioning <json_patch> must not switch the module on. We ask what dialect the card
 * itself speaks (markup_mode / mvu_meta / its own prompt and worldbook), plus one
 * data-driven exception (a conversation that already holds variable state).
 *
 * Cost: one dependency-free JSON + regex scan. No filesystem, no engine load.
 *
 * @param {object|null} character   character row
 * @param {object} [conv]           conversation row (world_state is a strong hint)
 * @returns {boolean}
 */
function isMvuConversation(character, conv) {
  if (character) {
    if (character.markup_mode === 'game-xml') return true;
    try {
      const meta = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta || '{}') : character.mvu_meta;
      if (meta && ((meta.fields && Object.keys(meta.fields).length) || (meta.initvar && Object.keys(meta.initvar).length))) return true;
    } catch (e) { /* ignore */ }
    if (detectMvuFaction(character) !== FACTION.NONE) return true;
  }
  if (conv && conv.world_state) {
    try {
      const ws = typeof conv.world_state === 'string' ? JSON.parse(conv.world_state) : conv.world_state;
      if (ws && typeof ws === 'object' && Object.keys(ws).length) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/**
 * Lazily load (and memoise) the engine. Returns NULL for non-MVU cards —
 * in which case no MVU module, storage or save-folder access ever happens.
 */
function getEngine(character, conv) {
  if (!isMvuConversation(character, conv)) return null;
  if (!engineCache) {
    engineCache = {
      core: require('./index'),
      store: require('./store'),
    };
  }
  return engineCache;
}

/** Extract [InitVar] worldbook entries from a character row (card import already stored them). */
function getInitVarBooks(character) {
  const books = [];
  if (!character) return books;
  try {
    const meta = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta || '{}') : character.mvu_meta;
    if (meta && Array.isArray(meta.initvar_books)) books.push(...meta.initvar_books);
    if (meta && meta.initvar && Object.keys(meta.initvar).length) {
      books.push({ name: '@card-initvar@', entries: [{ comment: '[InitVar] card', content: JSON.stringify(meta.initvar) }] });
    }
  } catch (e) { /* ignore */ }
  try {
    const cb = typeof character.character_book === 'string' ? JSON.parse(character.character_book) : character.character_book;
    if (cb && Array.isArray(cb.entries)) {
      const name = (cb.name || character.name || 'card-book') + '';
      books.push({ name, entries: cb.entries });
    }
  } catch (e) { /* ignore */ }
  return books;
}

/**
 * Build the FIRST MvuData for a card: [InitVar] worldbooks -> schema -> metadata stripped.
 *
 * Mirrors the reference initCheck(): worldbook entries are merged (existing data wins),
 * then an opening-message <initvar> block OVERRIDES everything and resets the book
 * bookkeeping so the remaining worldbooks initialise again on top of it.
 *
 * @param {object} engine          result of getEngine()
 * @param {object} character       character row
 * @param {string} [openingText]   the card@s first_message / selected greeting
 * @param {object} [seedStatData]  pre-existing stat_data (e.g. mirrored world_state)
 * @returns {object} MvuData
 */
function createInitialStateForCard(engine, character, openingText, seedStatData) {
  const { core } = engine;
  const variables = core.createEmptyGameData();
  variables.stat_data = seedStatData && typeof seedStatData === 'object' ? seedStatData : {};

  const charBookName = (character && (character.name || character.id)) || 'card';
  const books = getInitVarBooks(character);

  // 1) worldbook [InitVar] (existing data wins inside loadInitVarData)
  try {
    core.loadInitVarData(variables, books);
  } catch (e) {
    console.warn('[MVU] InitVar load failed:', e && e.message);
  }

  // 2) opening-message <initvar> overrides everything and resets bookkeeping
  if (openingText) {
    try {
      core.applyOpeningInitVarOverride(variables, openingText, charBookName);
    } catch (e) {
      console.warn('[MVU] opening <initvar> failed:', e && e.message);
    }
  }

  // 3) schema (+ strips $meta / markers from the live stat_data)
  variables.schema = core.buildInitialSchema(variables.stat_data);
  return variables;
}

module.exports = { isMvuConversation, getEngine, getInitVarBooks, createInitialStateForCard };

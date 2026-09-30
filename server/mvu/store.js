/**
 * MVU snapshot storage (decision D1: full MvuData per layer, inside the game SAVE FOLDER).
 *
 * Layout (sits next to event_log.md, inside the existing per-playthrough sub-save folder):
 *
 *   saves/gameNNNN/<saveId>/
 *     mvu/
 *       state.json        <- latest MvuData (used for prompt injection / front-end panel)
 *       rounds/
 *         0001.json       <- per-layer snapshot, keyed by messageId + swipeId
 *         0002.json
 *
 * Why the save folder and not the database: saves are copied / exported / deleted as a unit,
 * so the variable state travels with the story automatically. The DB keeps a mirror of
 * stat_data in conversations.world_state so the existing front-end panel keeps working.
 *
 * IMPORTANT: this module is only ever loaded for MVU cards. Non-MVU cards must not touch
 * any of it (see server/routes/chat.js isMvuConversation gate).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MVU_DIR = 'mvu';
const ROUNDS_DIR = 'rounds';
const STATE_FILE = 'state.json';
const MAX_ROUND_FILES = 5000;

/** Absolute path of the mvu/ folder for a save path (does not create it). */
function mvuDir(savePath) {
  return path.join(String(savePath || ''), MVU_DIR);
}

function roundsDir(savePath) {
  return path.join(mvuDir(savePath), ROUNDS_DIR);
}

/** Create mvu/ and rounds/. Returns the mvu dir, or null when savePath is unusable. */
function ensureDirs(savePath) {
  if (!savePath) return null;
  try {
    const dir = mvuDir(savePath);
    fs.mkdirSync(path.join(dir, ROUNDS_DIR), { recursive: true });
    return dir;
  } catch (e) {
    console.warn('[MVU] cannot create mvu dir:', e && e.message);
    return null;
  }
}

/** Zero-padded round file name. */
function roundFileName(messageId) {
  const n = Number(messageId);
  return String(Number.isFinite(n) && n >= 0 ? n : 0).padStart(4, '0') + '.json';
}

/** Write one layer snapshot (atomic-ish: write temp then rename). */
function writeRound(savePath, messageId, swipeId, variables) {
  if (!ensureDirs(savePath)) return false;
  const target = path.join(roundsDir(savePath), roundFileName(messageId));
  const payload = { messageId: Number(messageId) || 0, swipeId: Number(swipeId) || 0, variables };
  try {
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    console.warn('[MVU] writeRound failed:', e && e.message);
    return false;
  }
}

/** Read one layer snapshot, or null. */
function readRound(savePath, messageId) {
  try {
    const raw = fs.readFileSync(path.join(roundsDir(savePath), roundFileName(messageId)), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.variables ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** List all layer snapshots, oldest first. */
function listRounds(savePath) {
  const out = [];
  try {
    const dir = roundsDir(savePath);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (parsed && parsed.variables) out.push(parsed);
      } catch (e) { /* skip corrupt file */ }
      if (out.length >= MAX_ROUND_FILES) break;
    }
  } catch (e) { /* no rounds yet */ }
  return out.sort((a, b) => a.messageId - b.messageId);
}

/** Write the latest-state mirror (used for injection and the front-end panel). */
function writeState(savePath, variables) {
  if (!ensureDirs(savePath)) return false;
  try {
    const target = path.join(mvuDir(savePath), STATE_FILE);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(variables), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    console.warn('[MVU] writeState failed:', e && e.message);
    return false;
  }
}

/** Read the latest-state mirror, or null. */
function readState(savePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(mvuDir(savePath), STATE_FILE), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Does this save already carry MVU data? (used to seed from world_state on first run) */
function hasState(savePath) {
  try {
    return fs.existsSync(path.join(mvuDir(savePath), STATE_FILE));
  } catch (e) {
    return false;
  }
}

module.exports = {
  mvuDir,
  roundsDir,
  ensureDirs,
  roundFileName,
  writeRound,
  readRound,
  listRounds,
  writeState,
  readState,
  hasState,
};

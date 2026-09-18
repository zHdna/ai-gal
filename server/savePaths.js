/**
 * savePaths.js — Master/Sub save-folder architecture for AI-GAL
 *
 * Layout:
 *   saves/
 *     gameNNNN/                 <- MASTER folder (one per character card)
 *       character_roster.json   <- master roster (canonical first-version of each character)
 *       images/                 <- master avatar cache (shared across sub-saves)
 *       {timestamp}/            <- SUB folder (one per progress / conversation start)
 *         character_roster.json <- sub roster (live, per-playthrough; info changes only here)
 *         images/               <- sub avatar copies
 *         cg_gallery.json       <- CG (sub-only, never shared)
 *         ...
 *
 * Rules:
 *  - Avatar/roster generation is master-first: when a sub needs a portrait, check the
 *    master cache first; if present, copy into the sub and skip generation. Otherwise
 *    generate, write to the sub, then cache into the master to avoid duplicate generation
 *    for future sub-saves of the same game.
 *  - During play, when a character's info changes (e.g. 性经验), only the SUB roster is
 *    updated — the MASTER remains the frozen canonical first version.
 *  - The front-end floating window always reads the SUB roster.
 */

const fs = require('fs');
const path = require('path');
const { ROSTER_FILE } = require('./constants');
const { namesEquivalent, isActionLikeText } = require('./nameMatch');

const SAVES_DIR = path.join(__dirname, '..', 'saves');
const GAME_DIR_RE = /^game(\d+)$/;
// Must match chat.js NPC_PLACEHOLDER_AVATAR sentinel (avatar filename stays in master, not copied).
const NPC_PLACEHOLDER = 'NPCF';

fs.mkdirSync(SAVES_DIR, { recursive: true });

// ── Allocation ────────────────────────────────────────────────
// Returns the persistent gameNNNN dir for a character, allocating + persisting it on first use.
function getGameDir(db, characterId) {
  if (!characterId) return '';
  try {
    const row = db.prepare('SELECT game_dir FROM characters WHERE id = ?').get(characterId);
    if (row && row.game_dir) return row.game_dir;
  } catch (e) { /* column may not exist on very old DBs; fall through to allocate */ }

  // Scan existing game_dir values to compute the next index.
  let max = 0;
  try {
    const existing = db.prepare("SELECT game_dir FROM characters WHERE game_dir IS NOT NULL AND game_dir != ''").all();
    for (const r of existing) {
      const m = GAME_DIR_RE.exec(r.game_dir || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (e) { /* ignore */ }

  const next = 'game' + String(max + 1).padStart(4, '0');
  try {
    db.prepare('UPDATE characters SET game_dir = ? WHERE id = ?').run(next, characterId);
  } catch (e) { /* ignore if column missing */ }
  return next;
}

function getMasterDir(db, characterId) {
  return path.join(SAVES_DIR, getGameDir(db, characterId));
}

// Ensure the master folder exists; returns its path.
function ensureMasterDir(db, characterId) {
  const dir = getMasterDir(db, characterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  return dir;
}

// Sub-save path: master/gameNNNN/{saveId}
function getSubSaveDir(db, characterId, saveId) {
  const master = ensureMasterDir(db, characterId);
  const sub = path.join(master, saveId);
  fs.mkdirSync(sub, { recursive: true });
  return sub;
}

// ── Roster helpers ────────────────────────────────────────────
function readRoster(savePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(savePath, ROSTER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeRoster(savePath, roster) {
  fs.mkdirSync(savePath, { recursive: true });
  fs.writeFileSync(path.join(savePath, ROSTER_FILE), JSON.stringify(roster, null, 2), 'utf8');
}

function readRosterEntry(savePath, name) {
  const r = readRoster(savePath);
  return r ? r[name] || null : null;
}

function hasRealAvatar(av) {
  return !!av && av !== '' && av !== 'pending' && av !== 'failed' && av !== NPC_PLACEHOLDER;
}

// ── Card-name guard ───────────────────────────────────────────
// The CHARACTER CARD (left sidebar) is NOT a dialogue character and must never appear
// in a roster/avatar. It already has its own cover. Returns true if `name` is a variant
// of the card title. Centralized here so BOTH the sub sink (images.js updateRoster) and
// the master sink (this module) apply the identical protection — a regression in the
// master-sub change let the card name leak into the MASTER roster, which is then scanned
// by collectRostersRecursive and reused by ensureAvatarFromMaster (persistent, shared leak).
function isCardName(db, characterId, name) {
  if (!characterId || !name) return false;
  try {
    const card = db.prepare('SELECT name, excluded_names FROM characters WHERE id = ?').get(characterId);
    if (!card) return false;
    // Build the exclusion list: explicit characters.excluded_names if present,
    // otherwise fall back to just the card's own name.
    let list = [];
    if (card.excluded_names) {
      try { list = JSON.parse(card.excluded_names); } catch {}
    }
    if (!Array.isArray(list) || list.length === 0) list = [card.name];
    for (const ex of list) {
      if (ex && namesEquivalent(name, ex)) return true;
    }
  } catch (e) { /* ignore lookup errors */ }
  return false;
}

// ── Master caching (write) ────────────────────────────────────

/**
 * Seed a character entry into the MASTER roster when the butler first discovers
 * a new character (before any avatar is generated). This satisfies the user's
 * requirement: "首次生成名册和头像时，名册与头像放在总文件夹下，然后复制到存档文件夹".
 *
 * - GUARD: never seeds the character CARD title (see isCardName). The card is not a
 *   dialogue character and must not pollute the (shared, persistent) master roster.
 * - If the master roster doesn't have this character yet → write the full entry.
 * - If the master already has this character with a real avatar → don't overwrite
 *   (master is the canonical first version; sub changes don't propagate up).
 * - If the master has this character but no real avatar → update with the new entry
 *   (the butler may have richer data on a subsequent round).
 *
 * @param {object} db         - database handle
 * @param {string} characterId - character card id (for resolving game_dir + card-name guard)
 * @param {string} name        - character name
 * @param {object} entry       - full roster entry object (from buildRosterEntry)
 */
function seedMasterRoster(db, characterId, name, entry) {
  if (!characterId || !name || !entry) return;
  if (isCardName(db, characterId, name)) {
    console.log('[savePaths] Skipped master seed for character CARD (not a dialogue character):', name);
    return;
  }
  const masterDir = ensureMasterDir(db, characterId);
  let mr = readRoster(masterDir) || {};
  if (mr[name] && hasRealAvatar(mr[name].avatar)) {
    // Master already has a cached avatar for this character — don't overwrite.
    return;
  }
  // GUARD (B-class): never seed action options / sentence fragments (the butler
  // can emit a dialogue ACTION as a `### portrait` speaker). The master roster is
  // a shared, persistent cache, so a contaminated entry leaks into every sub-save.
  if (isActionLikeText(name)) {
    console.log('[savePaths] Skipped master seed for action-like / sentence-fragment name:', name);
    return;
  }
  mr[name] = entry;
  writeRoster(masterDir, mr);
  console.log('[savePaths] Seeded master roster for:', name);
}

// Called after a portrait image is actually saved into a sub-save. Copies the real
// avatar file + the full roster entry into the master cache so future sub-saves of
// the same game can reuse it (skip generation).
function cachePortraitInMaster(db, conversation_id, character_name, subSavePath) {
  if (!conversation_id || !character_name) return;
  let characterId = null;
  try {
    const conv = db.prepare('SELECT character_id FROM conversations WHERE id = ?').get(conversation_id);
    if (conv && conv.character_id) characterId = conv.character_id;
  } catch (e) { return; }
  if (!characterId) return;
  // GUARD: never cache the character CARD title into the (shared, persistent) master roster.
  if (isCardName(db, characterId, character_name)) {
    console.log('[savePaths] Skipped master cache for character CARD (not a dialogue character):', character_name);
    return;
  }
  // GUARD (B-class): never cache action options / sentence fragments into the master roster.
  if (isActionLikeText(character_name)) {
    console.log('[savePaths] Skipped master cache for action-like / sentence-fragment name:', character_name);
    return;
  }

  const subEntry = readRosterEntry(subSavePath, character_name);
  if (!subEntry) return;
  if (!hasRealAvatar(subEntry.avatar)) return; // only cache real avatars

  const masterDir = ensureMasterDir(db, characterId);
  const srcFile = path.join(subSavePath, 'images', subEntry.avatar);
  if (fs.existsSync(srcFile)) {
    try { fs.copyFileSync(srcFile, path.join(masterDir, 'images', subEntry.avatar)); } catch (e) { /* ignore */ }
  }

  const masterRosterPath = path.join(masterDir, ROSTER_FILE);
  let mr = readRoster(masterDir) || {};
  // Master = canonical first version; only set if not already present with a real avatar.
  if (!mr[character_name] || !hasRealAvatar(mr[character_name].avatar)) {
    mr[character_name] = subEntry;
    writeRoster(masterDir, mr);
  }
}

// ── Master reuse (read) ───────────────────────────────────────
// Called from butler before triggering generation. If the master cache has a real avatar
// for this character, copy it into the sub-save (file + full roster entry) and return true
// so generation is skipped.
function ensureAvatarFromMaster(db, characterId, name, subSavePath) {
  if (!characterId || !name) return false;
  // GUARD: never serve the character CARD title from master (defense in depth; master
  // should never contain it, but skip safely if it ever does).
  if (isCardName(db, characterId, name)) return false;
  // GUARD (B-class): never serve an action option / sentence fragment from master.
  if (isActionLikeText(name)) return false;
  const masterDir = ensureMasterDir(db, characterId);
  const masterRosterPath = path.join(masterDir, ROSTER_FILE);
  if (!fs.existsSync(masterRosterPath)) return false;

  const mr = readRoster(masterDir);
  if (!mr) return false;
  const entry = mr[name];
  if (!entry || !hasRealAvatar(entry.avatar)) return false;

  const masterFile = path.join(masterDir, 'images', entry.avatar);
  if (!fs.existsSync(masterFile)) return false;

  // Copy avatar file into sub images/
  const subImages = path.join(subSavePath, 'images');
  fs.mkdirSync(subImages, { recursive: true });
  try { fs.copyFileSync(masterFile, path.join(subImages, entry.avatar)); } catch (e) { return false; }

  // Merge master entry into sub roster (master provides the canonical base; existing
  // sub fields — if any — take precedence so per-playthrough info is preserved).
  const sr = readRoster(subSavePath) || {};
  sr[name] = { ...entry, ...(sr[name] || {}) };
  sr[name].avatar = entry.avatar; // ensure the reused avatar filename wins
  writeRoster(subSavePath, sr);
  return true;
}

// ── Master reuse (peek, read-only) ────────────────────────────
// Read-only twin of ensureAvatarFromMaster: does the MASTER cache already hold a real avatar
// for this character? Used by the DEBUT-CG rule in chat.js — when a sub-save has no avatar but
// the master does, the character is appearing in THIS playthrough for the first time, and a
// debut CG must be generated alongside the reused portrait.
// Never copies/writes anything (unlike ensureAvatarFromMaster) so it is safe to call eagerly.
function hasMasterAvatar(db, characterId, name) {
  if (!characterId || !name) return false;
  if (isCardName(db, characterId, name)) return false;
  if (isActionLikeText(name)) return false;
  const masterDir = ensureMasterDir(db, characterId);
  const masterRosterPath = path.join(masterDir, ROSTER_FILE);
  if (!fs.existsSync(masterRosterPath)) return false;
  const mr = readRoster(masterDir);
  if (!mr) return false;
  const entry = mr[name];
  if (!entry || !hasRealAvatar(entry.avatar)) return false;
  return fs.existsSync(path.join(masterDir, 'images', entry.avatar));
}

// ── Recursive roster collection (for conversations.js /:id/roster) ──
// Walks a root directory tree and returns every character_roster.json object found.
function collectRostersRecursive(root) {
  const base = root || SAVES_DIR;
  const results = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === ROSTER_FILE) {
        try { results.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* ignore */ }
      }
    }
  }
  walk(base);
  return results;
}

module.exports = {
  SAVES_DIR,
  GAME_DIR_RE,
  NPC_PLACEHOLDER,
  isCardName,
  getGameDir,
  getMasterDir,
  ensureMasterDir,
  getSubSaveDir,
  readRoster,
  writeRoster,
  readRosterEntry,
  hasRealAvatar,
  seedMasterRoster,
  cachePortraitInMaster,
  ensureAvatarFromMaster,
  hasMasterAvatar,
  collectRostersRecursive,
};

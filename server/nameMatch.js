/**
 * nameMatch.js — Canonical card-name / character-name equivalence for AI-GAL.
 *
 * SINGLE SOURCE OF TRUTH for `namesEquivalent`, `normCard`, `levenshtein`.
 * Previously duplicated in chat.js and images.js, which invites silent drift.
 * Centralized so every roster/avatar write path (sub AND master) can apply the
 * same protection against treating the CHARACTER CARD TITLE as a dialogue character.
 *
 * Why this matters:
 *   The character card (left sidebar) already has its own cover avatar and is NOT a
 *   dialogue character. A buggy model can emit the card title (or a variant) as a
 *   portrait entry. `namesEquivalent` identifies the FULL card title so it is blocked
 *   from portrait generation / roster writes — while a legitimate SHORT display-name
 *   NPC that shares the card's prefix (e.g. "示例NPC" inside card "示例卡 - 副标题")
 *   is deliberately ALLOWED to keep its portrait.
 */

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Normalize a name for CARD-TITLE comparison: strip whitespace, unify dash-like
 * chars (full-width － / en – / em — / tilde ~) to a plain hyphen, drop trailing
 * punctuation. This lets "示例卡 - 副标题" and "示例卡－副标题"
 * compare as equal.
 */
function normCard(s) {
  return (s || '')
    .replace(/[　\s]+/g, '')
    .replace(/[－–—~]/g, '-')
    .replace(/[。、，！？；：·.…・]+$/g, '')
    .trim();
}

/**
 * Returns true ONLY when `a` refers to the full CHARACTER CARD TITLE — never a bare
 * display-name token of it. Used to block the card itself from portrait generation.
 *
 * Design intent (why token matching was wrong):
 *   - "示例卡 - 副标题"  -> blocked (exact title / dash-normalized variant)
 *   - 10-char variant of a 9-char title -> blocked (contains the full title)
 *   - "示例NPC" (the ACTUAL NPC who speaks in this card) -> ALLOWED
 *     (only ~18% of the 11-char title, so the containment ratio rejects it)
 *
 * The card title and a legitimate short NPC that shares its prefix must NOT be
 * collapsed — otherwise the speaking NPC silently loses its portrait.
 */
function namesEquivalent(a, b) {
  if (!a || !b) return false;
  const na = normCard(a), nb = normCard(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  // Whole-string containment with a substantial-length floor (>=60% of the longer
  // name). Catches full-title variants WITHOUT matching a short display name.
  if (shorter.length >= 4 && longer.includes(shorter) && shorter.length >= longer.length * 0.6) {
    return true;
  }
  // Single-character typo variant of the full title (handles off-by-one model output)
  if (Math.abs(na.length - nb.length) <= 2 && levenshtein(na, nb) <= 1) return true;
  return false;
}

/**
 * Returns true when `name` looks like an ACTION OPTION or a SENTENCE FRAGMENT rather
 * than a character name. These were leaking into rosters/avatars as fake "characters"
 * (e.g. "将白紫嫣拉进房间并关门，用低沉的声音问她", "2、继续在门内逗她，问她").
 *
 * This is the B-class fix (the A-class is the card-title guard above). The butler AI
 * occasionally emits a dialogue ACTION as a `### portrait` speaker; the name then reads
 * like a full sentence. We detect that textually and drop it before ANY roster write
 * or portrait generation.
 *
 * Heuristics (high-precision — a real display name like "示例NPC" / "NPC-742" never hits):
 *   - contains a full-width comma "，" or enumeration comma "、"  -> sentence / option list
 *   - starts with a digit followed by "、" / "." / ")" / "）"     -> numbered option ("1、", "(1)")
 *   - length > 20 (CJK chars)                                     -> long-sentence fallback
 */
function isActionLikeText(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length === 0) return true;
  if (n.includes('，') || n.includes('、')) return true;
  if (/^[\d]+[、．.）)]/.test(n)) return true;
  if (n.length > 20) return true;
  return false;
}

module.exports = { levenshtein, normCard, namesEquivalent, isActionLikeText };

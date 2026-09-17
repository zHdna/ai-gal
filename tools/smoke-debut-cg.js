/**
 * 登场 CG 端到端冒烟（dry_run，不产生任何生成/落盘）：
 *   真实的 buildDebutCgPrompt → POST /api/images/generate (type:cg, debut_cg:true, dry_run:true)
 * 目的：验证「CG 公用流 + 不强插 nsfw + half_body/场景仍在」这条链在真实服务上成立。
 *   对照组：同一条提示词带 debut_cg:false（普通 CG），应当被强行补 nsfw。
 */
const fs = require('fs');
const path = require('path');
const { loadFunctions } = require('../cg_test/_extract_fn');

const CHAT = path.join(__dirname, '..', 'server', 'routes', 'chat.js');
const src = fs.readFileSync(CHAT, 'utf-8');
function extractConst(name, open, close) {
  const re = new RegExp(`const ${name}\\s*=\\s*${open}[\\s\\S]*?${close};`);
  const m = src.match(re);
  if (!m) throw new Error('const not found: ' + name);
  return new Function(`return ${m[0].replace(/^const [^=]+=\s*/, '').replace(/;\s*$/, '')};`)();
}
const GENDER_TAG_MAP = extractConst('GENDER_TAG_MAP', '\\{', '\\}');
const RACE_TAG_MAP = extractConst('RACE_TAG_MAP', '\\{', '\\}');
const RACE_NL_MAP = extractConst('RACE_NL_MAP', '\\{', '\\}');
const CUP_NL_MAP = extractConst('CUP_NL_MAP', '\\{', '\\}');
const CG_EXCLUDED_TAGS = extractConst('CG_EXCLUDED_TAGS', 'new Set\\(\\[', '\\]\\)');
const DEBUT_CG_FRAMING_CONFLICTS = extractConst('DEBUT_CG_FRAMING_CONFLICTS', 'new Set\\(\\[', '\\]\\)');
const GENDER_WORDS = extractConst('GENDER_WORDS', '\\[', '\\]');
const PORTRAIT_TAG_FIELDS = extractConst('PORTRAIT_TAG_FIELDS', '\\[', '\\]');
const SAFETY_RATING_TAGS = extractConst('SAFETY_RATING_TAGS', '\\[', '\\]');
const PORTRAIT_QUALITY_PREFIX = extractConst('PORTRAIT_QUALITY_PREFIX', "'", "'");
const DEBUT_CG_FRAMING_TAG = extractConst('DEBUT_CG_FRAMING_TAG', "'", "'");

const { hasAnimaHybridLayers, composeAnimaHybrid, dedupeHardTagLine } =
  loadFunctions(src, ['hasAnimaHybridLayers', 'splitAnimaHybrid', 'composeAnimaHybrid', 'dedupeHardTagLine']);
const { buildPortraitPromptNatural, isCleanAsciiName, splitRaceGender, buildPortraitPrompt } =
  loadFunctions(src, ['isCleanAsciiName', 'buildPortraitPromptNatural', 'splitRaceGender', 'buildPortraitPrompt'],
    { GENDER_WORDS, GENDER_TAG_MAP, RACE_TAG_MAP, RACE_NL_MAP, CUP_NL_MAP, PORTRAIT_TAG_FIELDS, PORTRAIT_QUALITY_PREFIX });
const { extractCGCharacterTags } = loadFunctions(src, ['extractCGCharacterTags'],
  { buildPortraitPrompt, CG_EXCLUDED_TAGS, PORTRAIT_QUALITY_PREFIX });
const { buildDebutCgPrompt } = loadFunctions(src, ['normalizeTagKey', 'ensureHalfBody', 'ensureSafetyRating',
  'prepareDebutCgPrompt', 'buildDebutCgPrompt'],
  { hasAnimaHybridLayers, composeAnimaHybrid, dedupeHardTagLine, splitRaceGender, isCleanAsciiName,
    extractCGCharacterTags, buildPortraitPromptNatural, DEBUT_CG_FRAMING_TAG, DEBUT_CG_FRAMING_CONFLICTS, SAFETY_RATING_TAGS });

// Sample roster entry (stand-in: the real one lives in your own save folder).
// Override with SMOKE_ROSTER=<path to character_roster.json> and SMOKE_CHAR=<name>.
const rosterPath = process.env.SMOKE_ROSTER ||
  path.join(__dirname, '..', 'saves', 'game0001', 'character_roster.json');
const charName = process.env.SMOKE_CHAR || 'ExampleChar';
let roster;
try {
  roster = JSON.parse(fs.readFileSync(rosterPath, 'utf-8'));
} catch {
  throw new Error(`roster not found at ${rosterPath} — set SMOKE_ROSTER to your character_roster.json`);
}
const entry = roster[charName] || Object.values(roster)[0];
if (!entry) throw new Error(`no roster entry found (looked for "${charName}")`);

const built = buildDebutCgPrompt(entry, entry.english_name, {
  scene: 'She stands in the classroom after class, late afternoon light across the desks, empty chairs around her.',
  safety: 'safe',
});
console.log('=== 代码构造的登场 CG 提示词 ===');
console.log(built.prompt);
console.log('');

const URL = (process.env.SMOKE_BASE || 'http://127.0.0.1:3215') + '/api/images/generate';
async function post(body) {
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
(async () => {
  const base = { type: 'cg', prompt: built.prompt, character_name: charName, dry_run: true };
  const a = await post({ ...base, debut_cg: true });
  const b = await post({ ...base, debut_cg: false });

  console.log('=== A. 登场 CG（debut_cg:true, dry_run）===');
  console.log('HTTP', a.status);
  const pa = a.json && (a.json.finalPrompt || a.json.prompt);
  console.log(pa || JSON.stringify(a.json).slice(0, 400));
  console.log('');
  console.log('=== B. 对照：同一提示词按普通 CG 走（debut_cg:false）===');
  console.log('HTTP', b.status);
  const pb = b.json && (b.json.finalPrompt || b.json.prompt);
  console.log(pb || JSON.stringify(b.json).slice(0, 400));

  const A = String(pa || ''), B = String(pb || '');
  const hardA = A.split(/\n\n/)[0].split(',').map(s => s.trim().toLowerCase());
  const hardB = B.split(/\n\n/)[0].split(',').map(s => s.trim().toLowerCase());
  console.log('');
  console.log('--- 断言 ---');
  const checks = [
    ['A 含 half_body', hardA.includes('half_body')],
    ['A 未被强插 nsfw', !hardA.includes('nsfw')],
    ['A 保留安全分级 safe', hardA.includes('safe')],
    ['A 保留自然语言层（当前场景）', A.includes('late afternoon light across the desks')],
    ['A 无 close-up / portrait / full_body', !hardA.some(t => ['close-up', 'portrait', 'full_body'].includes(t))],
    ['B（普通 CG）仍被强插 nsfw（原有行为不变）', hardB.includes('nsfw')],
  ];
  let bad = 0;
  for (const [label, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + label); if (!ok) bad++; }
  process.exit(bad ? 1 : 0);
})();

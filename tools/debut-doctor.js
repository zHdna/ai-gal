/**
 * tools/debut-doctor.js — 登场 CG 诊断器（只读，不改任何文件）
 *
 * 用途：用户报「角色首次登场生成半身 CG 没有生效」时，直接对着真实的存档/名册/对话，
 * 把 chat.js 里那条判定逻辑重放一遍，逐角色打印：
 *     子存档头像状态 / 总存档头像状态 / 本轮是否登场 / 最终判定（会不会出登场 CG，以及走哪条路）
 *
 * 用法：
 *   node tools/debut-doctor.js                 # 最近一次存档
 *   node tools/debut-doctor.js --all           # 所有存档
 *   node tools/debut-doctor.js <saveId>        # 指定存档（saves.id 或 saves.save_path 目录名）
 *   node tools/debut-doctor.js --conv=<id>     # 指定对话，取它最新的存档
 *
 * 判定规则（与 chat.js「首次登场判定」一致）：
 *   首次登场 = 子存档名册里该角色【没有真实头像】( '' / 'pending' / 'failed' / NPC 占位 / '已有头像' 都不算 )
 *              且该角色【本轮剧情里出现】（本轮正文提到它的名字，或管家/画家给了它的 portrait）
 *   → 总存档有真实头像 → 复制头像 + 出一张登场 CG（判定①）
 *   → 总存档也没有     → 走头像生成，生成成功后同样出一张登场 CG（判定②）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const savePaths = require('../server/savePaths');
const { ROSTER_FILE } = require('../server/constants');
const { namesEquivalent, isActionLikeText } = require('../server/nameMatch');

const DB = path.join(__dirname, '..', 'server', 'db', 'data.db');
const db = new Database(DB, { readonly: true });

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const convArg = (args.find(a => a.startsWith('--conv=')) || '').slice(7);
const saveArg = args.find(a => !a.startsWith('--'));

function pickSaves() {
  if (convArg) return db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC').all(convArg);
  if (saveArg) {
    const rows = db.prepare('SELECT * FROM saves WHERE id = ? OR save_path LIKE ? ORDER BY created_at DESC').all(saveArg, '%' + saveArg + '%');
    return rows;
  }
  const rows = db.prepare('SELECT * FROM saves ORDER BY created_at DESC LIMIT ?').all(wantAll ? 999 : 1);
  return rows;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function lastTurnText(conversationId) {
  try {
    const rows = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").all(conversationId);
    return rows.length ? String(rows[0].content || '') : '';
  } catch { return ''; }
}

function userName() {
  try {
    const r = db.prepare('SELECT name FROM user_profile WHERE is_active = 1 LIMIT 1').get();
    return (r && r.name) || '';
  } catch { return ''; }
}

function cardNameFor(characterId) {
  try {
    const r = db.prepare('SELECT name FROM characters WHERE id = ?').get(characterId);
    return (r && r.name) || '';
  } catch { return ''; }
}

const U = userName();
let grand = { checked: 0, trigger: 0, reuse: 0, gen: 0 };

for (const save of pickSaves()) {
  const subRosterPath = path.join(save.save_path, ROSTER_FILE);
  const masterDir = path.join(path.dirname(save.save_path));
  const masterRosterPath = path.join(masterDir, ROSTER_FILE);
  const turn = lastTurnText(save.conversation_id);
  const subRoster = readJson(subRosterPath) || {};
  const masterRoster = readJson(masterRosterPath) || {};
  const conv = db.prepare('SELECT character_id FROM conversations WHERE id = ?').get(save.conversation_id) || {};
  const cardName = cardNameFor(conv.character_id);

  console.log('='.repeat(96));
  console.log('存档:', save.id, '| 对话:', save.conversation_id);
  console.log('  子存档:', save.save_path);
  console.log('  总存档:', masterDir);
  console.log('  名册文件:', fs.existsSync(subRosterPath) ? '有' : '缺失',
    '| 总存档名册:', fs.existsSync(masterRosterPath) ? '有' : '缺失',
    '| 本轮正文:', turn.length, '字');
  console.log('  主角:', U || '(未设置)', '| 角色卡:', cardName || '(未知)');
  console.log('-'.repeat(96));

  const names = Object.keys(subRoster);
  if (!names.length) console.log('  （子存档名册为空）');

  for (const nm of names) {
    const entry = subRoster[nm] || {};
    const av = String(entry.avatar || '');
    const realSub = savePaths.hasRealAvatar(av);
    const masterAv = String((masterRoster[nm] || {}).avatar || '');
    const realMaster = savePaths.hasRealAvatar(masterAv);
    // 总存档头像文件是否真的在（hasMasterAvatar 会校验文件存在）
    let masterFileOk = false;
    try { masterFileOk = savePaths.hasMasterAvatar(db, conv.character_id, nm); } catch { masterFileOk = false; }

    const mentioned = !!nm && turn.includes(nm);
    const isProtagonist = !!(U && namesEquivalent(nm, U));
    const isCard = !!(cardName && namesEquivalent(nm, cardName));
    const actionLike = isActionLikeText(nm);

    let verdict;
    if (realSub) verdict = '— 已有真实头像（跳过）';
    else if (entry.debut_cg) verdict = '— 本存档已出过登场 CG（跳过）';
    else if (isProtagonist) verdict = '— 主角（不出画像）';
    else if (isCard) verdict = '— 角色卡（不是对话角色）';
    else if (actionLike) verdict = '— 动作/句子碎片（剔除）';
    else if (!mentioned) verdict = '· 本轮未在正文出现（等它登场）';
    else if (masterFileOk) { verdict = '★ 判定①：复制总存档头像 + 出登场 CG'; grand.trigger++; grand.reuse++; }
    else if (realMaster) { verdict = '★ 判定①(风险)：总存档名册有头像但文件找不到 → 实际会走生成'; grand.trigger++; grand.gen++; }
    else { verdict = '★ 判定②：本轮生成头像 + 出登场 CG（需管家给出该角色 portrait）'; grand.trigger++; grand.gen++; }

    grand.checked++;
    console.log('  ' + (nm + ' '.repeat(Math.max(0, 10 - nm.length * 2))).padEnd(14) +
      '子=' + (av || '(空)').padEnd(22) +
      '总=' + (masterAv || '(空)').padEnd(22) +
      '文件=' + (masterFileOk ? '在' : '无').padEnd(4) +
      '登场=' + (mentioned ? '是' : '否').padEnd(4) +
      verdict);
  }
}

console.log('='.repeat(96));
console.log('汇总：检查角色', grand.checked, '| 会被判定为首次登场', grand.trigger,
  '（其中复制总存档头像', grand.reuse, '、需本轮生成', grand.gen, '）');
console.log('提示：判定②需要管家AI 在本轮为该角色输出 portrait —— 若管家按规则对已登场过的角色不再输出 portrait，');
console.log('      请确认总存档里已有该角色的头像（那样走判定①，与管家无关）。本工具只读，不改任何文件。');

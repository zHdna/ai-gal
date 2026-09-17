#!/usr/bin/env node
/**
 * tools/fix-roster-english.js —— 按「热门二次元角色译名查询表」清洗名册的 english_name
 *
 * 口径（用户 2026-09 定稿）：
 *   · english_name 只为**二次元同人卡**服务（让生图模型认出 Rem / 亚丝娜 / 初音未来…）；
 *   · 查表命中 → 写官方英文名/生图标签；
 *   · 查不到（原创角色）→ **删掉该字段**；不写拼音、不写中文、不留旧垃圾值。
 *
 * 用法：
 *   node tools/fix-roster-english.js --dry     # 只看会改什么
 *   node tools/fix-roster-english.js           # 真改（自动备份到 .probe-tmp/en-fix-backup/）
 */
const fs = require('fs');
const path = require('path');
const { lookupAnimeEnglishName } = require('../server/utils/anime-names.js');

const ROOT = path.join(__dirname, '..');
const SAVES = path.join(ROOT, 'saves');
const BACKUP = path.join(ROOT, '.probe-tmp', 'en-fix-backup');
const DRY = process.argv.includes('--dry');

const stats = { files: 0, touched: 0, set: 0, removed: 0, kept: 0, absent: 0 };
const log = [];

function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'character_roster.json') fixFile(p);
  }
}

function fixFile(file) {
  stats.files++;
  let roster;
  try { roster = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return; }
  let changed = false;
  for (const [name, entry] of Object.entries(roster)) {
    if (!entry || typeof entry !== 'object') continue;
    const want = lookupAnimeEnglishName(entry.name || name || '');
    const has = 'english_name' in entry;
    const cur = has ? (entry.english_name || '').toString().trim() : '';
    if (want) {
      if (cur === want) { stats.kept++; continue; }
      entry.english_name = want;
      stats.set++;
      log.push(`  设  ${path.relative(ROOT, file)}  ${name}: ${cur ? `"${cur}" → ` : ''}"${want}"`);
      changed = true;
    } else if (has) {
      delete entry.english_name;
      stats.removed++;
      log.push(`  删  ${path.relative(ROOT, file)}  ${name}: 删掉 english_name（原值 "${cur}"；表格中无此角色=原创角色）`);
      changed = true;
    } else {
      stats.absent++;
    }
  }
  if (!changed) return;
  stats.touched++;
  if (DRY) { log.push(`  [dry] 会写入 ${path.relative(ROOT, file)}`); return; }
  const bk = path.join(BACKUP, path.relative(SAVES, file));
  fs.mkdirSync(path.dirname(bk), { recursive: true });
  if (!fs.existsSync(bk)) fs.copyFileSync(file, bk);
  fs.writeFileSync(file, JSON.stringify(roster, null, 2) + '\n', 'utf-8');
}

walk(SAVES);
console.log((DRY ? '== 试运行（未写入）==' : '== 已执行 =='));
console.log(log.join('\n') || '  （没有需要改的条目）');
console.log(`\n名册文件 ${stats.files} 个｜改动 ${stats.touched} 个｜查表写入 ${stats.set} 条｜删除(原创角色) ${stats.removed} 条｜已是正确值 ${stats.kept} 条｜本来没有该字段 ${stats.absent} 条`);
if (!DRY && stats.touched) console.log(`备份目录：${path.relative(ROOT, BACKUP)}`);

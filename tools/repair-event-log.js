/**
 * 记忆表格（event_log.md）历史脏数据修复
 * ---------------------------------------------------------------------------
 * 为什么要 DB-aware：event_log.md 是**一行一次生成**。当「停止」失效导致同一轮
 * 并发跑了两次生成时，会多写一行；而 `cleanupEventLog` 老实现又会把剩下的行按 1..M 重排
 * （见 server/utils/turnCleanup.js 的注释），于是**从那之后每一行的轮号都偏了一位**。
 * 实测 ai-rp-tool：38 条 assistant / 36 轮，event_log 37 行，
 * 第 33 行写的是第 32 轮的剧情、末尾两行都是 `第36轮`。
 * 单纯"去掉重复轮号"救不了这种错位 —— 必须按 DB 里真实的生成顺序重新对齐轮号。
 *
 * 做法（每个 save 独立处理）：
 *   1) 从 DB 按 rowid 顺序取该对话的消息，算出**每次生成时的真实轮号**
 *      （轮号 = 该生成之前已插入的非隐藏 user 消息条数；开场问候不算生成，跳过）。
 *   2) 若 event_log 的有效行数 == 生成次数，则一一对上：
 *        · 同一轮出现第二次的那些行 = 重复生成写出来的 → 丢弃
 *        · 其余行按真实轮号重标
 *      行数与生成次数不符 → 该文件**不猜**，只报告、不修改。
 *   3) 最后再清一遍：没有 `第N轮 |` 前缀的无归属行、以及超长"摘要"
 *      （管家把思维链写进 summarize 的那种，实测一整段 290 字英文）。
 *
 * 不重新编号成 1..M：轮号必须等于真实轮次，缺口保持缺口（那一轮确实没有可用记忆）。
 *
 * 用法：
 *   node repair-event-log.js                       # 干跑（默认，只报告）
 *   node repair-event-log.js --apply               # 写入（每个文件先备份 .bak-<时间戳>）
 *   node repair-event-log.js --simple              # 不做 DB 对齐，只去重/清垃圾
 *   --db <path>  --root <saves 目录>  --max-chars <n>
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const valOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

// 默认路径取应用自己的解析结果（server/paths.js 是 DATA_ROOT 的唯一真相来源）：
// 桌面版解析到 %APPDATA%\AI-GAL，绿色版解析到程序目录 —— 与界面里看到的是同一份存档。
let defaultSaves = 'D:/DSH/ai-rp-tool/saves';
let defaultDb = 'D:/DSH/ai-rp-tool/server/db/data.db';
try {
  const p = require('../server/paths');
  if (p.SAVES_DIR) defaultSaves = p.SAVES_DIR;
  if (p.DB_PATH) defaultDb = p.DB_PATH;
} catch (e) { /* 独立运行时用上面的兜底路径 */ }

const APPLY = has('--apply');
const SIMPLE = has('--simple');
const MAX_CHARS = Number(valOf('--max-chars', '160'));
const ROOT = valOf('--root', defaultSaves);
const DB_PATH = valOf('--db', defaultDb);

let db = null;
if (!SIMPLE) {
  try {
    const Database = require(process.env.BETTER_SQLITE3 || require.resolve('better-sqlite3'));
    db = new Database(DB_PATH, { readonly: true });
  } catch (e) {
    console.log('⚠️ 打不开 DB（' + e.message + '）→ 自动退化为 --simple 模式（只去重/清垃圾，不做轮号对齐）');
  }
}

const rowRe = /^第(\d+)轮\s*\|/;

function collect(root) {
  const out = [];
  (function walk(dir) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'event_log.md') out.push(p);
    }
  })(root);
  return out;
}

/** 每次生成时的真实轮号（按插入顺序；开场问候不算生成） */
function expectedRoundsFor(conversationId) {
  const msgs = db.prepare('SELECT role, hidden FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);
  const rounds = [];
  let u = 0, firstAssistantSeen = false;
  for (const m of msgs) {
    if (m.role === 'user') { if (!m.hidden) u++; continue; }
    if (m.role !== 'assistant') continue;
    if (u === 0 && !firstAssistantSeen) { firstAssistantSeen = true; continue; }   // 开场问候
    rounds.push(u);
  }
  return rounds;
}

function repairFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const all = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = all.filter(l => rowRe.test(l));
  const dropped = { orphan: [], overlong: [], dupGen: [], unaligned: false };
  all.filter(l => !rowRe.test(l)).forEach(l => dropped.orphan.push(l));

  let out = rows.map(l => ({ line: l }));

  // ---- 1) DB 对齐：按真实生成轮号重标 + 丢掉重复生成的行 ----
  if (db) {
    const save = db.prepare('SELECT conversation_id FROM saves WHERE save_path = ? OR save_path = ?').get(path.dirname(file), path.dirname(file).replace(/\//g, '\\'));
    const convId = save && save.conversation_id;
    if (!convId) { dropped.unaligned = true; }
    else {
      const expected = expectedRoundsFor(convId);
      const distinctRounds = new Set(expected).size;
      const labels = rows.map(l => Number(l.match(rowRe)[1]));
      const labelDup = labels.length !== new Set(labels).size;          // 有重复轮号
      const inRange = labels.every(n => n >= 1 && n <= distinctRounds); // 轮号没超出实际轮数

      if (expected.length === out.length) {
        // 行数 == 生成次数：可以逐一对上 → 重标 + 丢重复生成的行
        const seen = new Set();
        const aligned = [];
        for (let i = 0; i < out.length; i++) {
          const round = expected[i];
          if (round <= 0) { dropped.dupGen.push(out[i].line); continue; }
          if (seen.has(round)) { dropped.dupGen.push(out[i].line); continue; }   // 同一轮的第二次生成
          seen.add(round);
          const body = out[i].line.replace(/^第\d+轮\s*\|\s*/, '');
          aligned.push({ line: `第${round}轮 | ${body}` });
        }
        out = aligned;
      } else if (!labelDup && inRange) {
        // 行数少于生成次数、轮号又连续无重复且在范围内 → 只是有些轮没摘要（合法），不动
        dropped.alreadyOk = true;
      } else {
        dropped.unaligned = true;       // 对不上又说不清 → 不猜，只报告
      }
    }
  }

  // ---- 2) 超长"摘要"（管家把思维链写进 summarize）----
  const before = out.length;
  out = out.filter(r => {
    const summary = r.line.replace(/^第\d+轮\s*\|\s*/, '');
    if (summary.length > MAX_CHARS) { dropped.overlong.push(r.line); return false; }
    return true;
  });

  const changed = !dropped.alreadyOk && (
    out.length !== rows.length
    || dropped.orphan.length > 0
    || out.some((r, i) => rows[i] && r.line !== rows[i])
    || out.length !== before
  );

  return { file, rows: rows.length, after: out.length, out, dropped, changed };
}

const files = collect(ROOT);
if (!files.length) { console.log('没找到 event_log.md（root=' + ROOT + '）'); process.exit(0); }

console.log('模式: ' + (APPLY ? '★ 实际写入（先备份）' : '干跑（只报告）')
  + (db ? ' | DB 对齐: 开（' + DB_PATH + '）' : ' | DB 对齐: 关')
  + ' | 摘要上限: ' + MAX_CHARS + ' 字');
console.log('扫描: ' + files.length + ' 个 event_log.md\n');

let dirty = 0, unaligned = 0;
for (const f of files) {
  const r = repairFile(f);
  if (!r.changed && !r.dropped.unaligned) continue;
  dirty++;
  const rel = f.replace(/\\/g, '/').split('/saves/').pop();
  if (r.dropped.unaligned) {
    unaligned++;
    console.log('── ' + rel + '   ⚠️ 行数与生成次数对不上 → 本次不修改（只报告，请人工核对）');
    continue;
  }
  console.log('── ' + rel);
  console.log('   记忆行 ' + r.rows + ' → ' + r.after
    + '  | 重复生成行 ' + r.dropped.dupGen.length
    + ' | 无归属行 ' + r.dropped.orphan.length
    + ' | 超长垃圾 ' + r.dropped.overlong.length);
  const show = (arr, tag) => arr.slice(0, 4).forEach(l => console.log('     [' + tag + '] ' + l.replace(/\s+/g, ' ').slice(0, 108) + (l.length > 108 ? '…' : '')));
  show(r.dropped.dupGen, '重复生成');
  show(r.dropped.orphan, '无归属');
  show(r.dropped.overlong, '超长');
  if (r.rows !== r.after && r.dropped.dupGen.length) {
    console.log('     重标后首末：' + r.out[0].line.slice(0, 40) + '  …  ' + r.out[r.out.length - 1].line.slice(0, 40));
  }

  if (APPLY) {
    const bak = f + '.bak-' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    fs.copyFileSync(f, bak);
    fs.writeFileSync(f, r.out.map(x => x.line).join('\n') + '\n', 'utf-8');
    console.log('     ✔ 已写入（备份 ' + path.basename(bak) + '）');
  }
}

console.log('\n=== 汇总：' + dirty + ' 个文件有问题（其中 ' + unaligned + ' 个行数不符、未修改）===');
if (!APPLY && dirty) console.log('（干跑模式，未写盘；确认无误后加 --apply）');

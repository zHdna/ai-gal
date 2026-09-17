#!/usr/bin/env node
/**
 * 字体统一缩小 + 阅读区字号可缩放（一次性迁移工具，保留备查）
 *
 *   node tools/rescale-fonts.js <file.html> [--dry]
 *
 * 规则（按用户要求「主要字体改小 2px」）：
 *   n >= 14        → n - 2
 *   12 <= n < 14   → n - 1.5
 *   11 <= n < 12   → n - 1
 *   n < 11         → 不变（已是很小的元信息字号，再缩会读不清）
 *
 * 阅读区（对白 / 旁白 / 行动选项 / 回顾正文 / 控制台正文）额外包一层
 * calc(px * var(--fs))，使「字号」设置能整体放大缩小正文。
 */
const fs = require('fs');

const READING = [
  '.dlg-text', '.dlg-narr', '.ch',
  '.hist .txt', '.hist .full', '.con-line', '.con-detail',
];

const file = process.argv[2];
const dry = process.argv.includes('--dry');
if (!file) { console.error('usage: node tools/rescale-fonts.js <file.html> [--dry]'); process.exit(2); }

let src = fs.readFileSync(file, 'utf8');
const report = [];

function reduce(n) {
  if (n >= 14) return n - 2;
  if (n >= 12) return n - 1.5;
  if (n >= 11) return n - 1;
  return n;
}

const round = (n) => (Math.round(n * 100) / 100);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* 选择器是否命中阅读区（词边界匹配：'.ch' 不应命中 '.chip'） */
const READING_RE = READING.map((r) => new RegExp(`(^|[\\s,>+~])${esc(r)}(?![\\w-])`));
const isReading = (sel) => READING_RE.some((re) => re.test(sel));

/* 找出每条 font-size 声明所属的选择器（用花括号深度扫描，兼容 @media 嵌套） */
const lines = src.split('\n');
let selectorStack = [];
let inStyle = false;
let changed = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // 进入 / 离开 <style>
  if (/<style[\s>]/i.test(line)) { inStyle = true; continue; }
  if (/<\/style>/i.test(line)) { inStyle = false; selectorStack = []; continue; }
  if (!inStyle) continue;

  const m = line.match(/^(\s*)font-size:\s*(calc\()?([\d.]+)px(\s*\*\s*var\(--fs\))?\)?;/);
  if (m && selectorStack.length) {
    const indent = m[1];
    const n = parseFloat(m[3]);
    const isCalc = !!m[2];
    const nn = round(reduce(n));
    const sel = selectorStack[selectorStack.length - 1];
    const reading = isReading(sel) || isCalc;
    let out;
    if (reading) out = `${indent}font-size: calc(${nn}px * var(--fs));`;
    else out = `${indent}font-size: ${nn}px;`;
    if (out !== line) {
      report.push(`  ${String(i + 1).padStart(5)}  ${sel.slice(0, 42).padEnd(42)}  ${line.trim()}  →  ${out.trim()}`);
      lines[i] = out;
      changed++;
    } else {
      report.push(`  ${String(i + 1).padStart(5)}  ${sel.slice(0, 42).padEnd(42)}  ${line.trim()}  (不变)`);
    }
    continue;
  }

  // 选择器栈维护：逐字符扫花括号
  let buf = '';
  for (const ch of line) {
    if (ch === '{') {
      const sel = buf.trim();
      selectorStack.push(sel || selectorStack[selectorStack.length - 1] || '');
      buf = '';
    } else if (ch === '}') {
      selectorStack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
}

console.log(report.join('\n'));
console.log(`\n共修改 ${changed} 条 font-size; 文件 ${dry ? '(dry-run，未写入)' : ''}`);
if (!dry) fs.writeFileSync(file, lines.join('\n'), 'utf8');

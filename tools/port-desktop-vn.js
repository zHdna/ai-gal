#!/usr/bin/env node
/**
 * 一次性迁移：把 public/index.html 改成「桌面 VN 外壳 + 隐藏旧 DOM」结构
 *
 *   node tools/port-desktop-vn.js [--check]
 *
 * 做五件事（幂等，重复执行不会重复插入）：
 *   1. head 末尾引入 css/desktop/vn.css
 *   2. 把旧桌面布局（nav.top-bar / .system-menu-bar / .main-layout）包进 #vnLegacyDom
 *      —— app.js 的 DOM 契约仍然满足，只是不渲染
 *   3. 把 #editModal（旧 DOM 里唯一被包住的功能性弹窗）搬到 wrapper 之外，
 *      避免消息编辑功能失效（app.js 的 showEditModal）
 *   4. 在 wrapper **之前**留下 <!-- VN-SHELL:BEGIN/END --> 标记
 *      —— 文档序至关重要：app.js 用 document.getElementById 取「第一个」同名元素，
 *         外壳在前，可见的 #messageInput / #btnSend 才会被 app.js 绑定（P1）
 *   5. body 末尾引入 js/desktop/vn-shell.js
 * 改动前备份 index.html → index.html.bak-vn
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'public/index.html');
const check = process.argv.includes('--check');

let lines = fs.readFileSync(FILE, 'utf8').split('\n');
const src = lines.join('\n');

const report = [];
const findLine = (needle, from = 0) => {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i;
  return -1;
};

/* ---------- 2. 定位旧布局起止 ---------- */
let wrapOpen = findLine('<nav class="top-bar"');
if (wrapOpen === -1) wrapOpen = findLine('class="top-bar"');
const layoutOpen = findLine('<div class="main-layout"');
if (wrapOpen === -1 || layoutOpen === -1) throw new Error('找不到旧布局起点');

/* 从 .main-layout 起点按 div 配平找到闭合行 */
const countDivs = (s) => (s.match(/<div\b/g) || []).length - (s.match(/<\/div>/g) || []).length;
let depth = 0, layoutClose = -1;
for (let i = layoutOpen; i < lines.length; i++) {
  depth += countDivs(lines[i]);
  if (depth === 0) { layoutClose = i; break; }
}
if (layoutClose === -1) throw new Error('.main-layout 未闭合');

const already = src.includes('id="vnLegacyDom"');
report.push(`旧布局范围: 行 ${wrapOpen + 1} … ${layoutClose + 1}（${already ? '已包过，跳过' : '将包裹'}）`);

/* ---------- 3. #editModal 搬到 wrapper 之外 ---------- */
const editOpen = findLine('id="editModal"');
let editClose = -1;
if (editOpen !== -1 && editOpen > wrapOpen && editOpen < layoutClose) {
  let d = 0;
  for (let i = editOpen; i < lines.length; i++) {
    d += countDivs(lines[i]);
    if (d === 0) { editClose = i; break; }
  }
}
report.push(`#editModal: 行 ${editOpen + 1}${editClose > 0 ? '…' + (editClose + 1) + '（将搬出 wrapper）' : '（不在 wrapper 内，跳过）'}`);

/* ---------- 1. CSS / 4. 标记 / 5. 脚本 ---------- */
const headClose = findLine('</head>');
const bodyClose = lines.map((l, i) => (l.trim() === '</body>' ? i : -1)).filter((i) => i !== -1).pop();

if (check) {
  report.push(`head 结束行: ${headClose + 1}，body 结束行: ${bodyClose + 1}`);
  report.push(`已引入 vn.css: ${src.includes('css/desktop/vn.css')}`);
  report.push(`已有 VN 标记: ${src.includes('VN-SHELL:BEGIN')}`);
  report.push(`已引入 vn-shell.js: ${src.includes('js/desktop/vn-shell.js')}`);
  console.log(report.join('\n'));
  process.exit(0);
}

if (!already) fs.copyFileSync(FILE, FILE + '.bak-vn');

/* 5. 脚本（先取行号，插到 body 末尾） */
const SCRIPT = '  <script src="js/desktop/vn-shell.js?v=20260916a"></script>';
const MARK_B = '  <!-- VN-SHELL:BEGIN（由 tools/build-desktop-vn.js 从设计稿生成） -->';
const MARK_E = '  <!-- VN-SHELL:END -->';

/* 从后往前插，避免行号漂移 */
const inserts = [];
if (bodyClose !== -1 && !src.includes('js/desktop/vn-shell.js')) {
  inserts.push({ at: bodyClose, text: SCRIPT });
}
if (!already) {
  /* 同一位置插入时「后 push 的在前」：先 push wrapper，再 push 标记，
     结果才是 [标记 → 外壳 DOM] … [wrapper 开 → 旧布局 → wrapper 闭] */
  inserts.push({ at: wrapOpen, text: '<div id="vnLegacyDom" hidden aria-hidden="true">' });
  inserts.push({ at: wrapOpen, text: MARK_B + '\n' + MARK_E });
  inserts.push({ at: layoutClose + 1, text: '</div>' });
}
if (headClose !== -1 && !src.includes('css/desktop/vn.css')) {
  inserts.push({ at: headClose, text: '  <link rel="stylesheet" href="css/desktop/vn.css?v=20260916a">' });
}

inserts.sort((a, b) => b.at - a.at).forEach(({ at, text }) => lines.splice(at, 0, text));

/* 3. 搬运 #editModal（在所有插入之后做，重新定位一次） */
if (editClose > 0) {
  const block = lines.slice(editOpen, editClose + 1);
  lines.splice(editOpen, block.length);
  const newLayoutClose = lines.map((l, i) => (l.includes('id="vnLegacyDom"') ? i : -1)).filter((i) => i !== -1)[0];
  let d2 = 0, closeAt = -1;
  for (let i = newLayoutClose; i < lines.length; i++) {
    d2 += countDivs(lines[i]);
    if (d2 === 0) { closeAt = i; break; }
  }
  if (closeAt > 0) {
    lines.splice(closeAt + 1, 0, '', '  <!-- 消息编辑弹窗：搬出隐藏区，保持可用 -->', ...block, '');
    report.push(`#editModal 已搬到 wrapper 之后（行 ${closeAt + 2}）`);
  }
}

fs.writeFileSync(FILE, lines.join('\n'), 'utf8');
console.log(report.join('\n'));
console.log('已写入 public/index.html（备份 index.html.bak-vn）');

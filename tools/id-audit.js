#!/usr/bin/env node
/**
 * 外壳 id / 结构审计
 *
 *   node tools/id-audit.js
 *
 * 1) 结构检查：外壳是否在 #vnLegacyDom 之前（P1：document.getElementById 取第一个）、
 *    #messageInput / #btnSend 是否由外壳胜出、#editModal 是否在隐藏区之外、
 *    vn.css / vn-shell.js 是否已引入
 * 2) id 分类：app.js 会接管哪些外壳 id（有意为之）、哪些重名、哪些外壳独占
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'design/mockups/desktop-vn.html'), 'utf8');

const B = '<!-- VN-SHELL:BEGIN';
const E = '<!-- VN-SHELL:END -->';
const bAt = index.indexOf(B);
const eAt = index.indexOf(E);
const shell = bAt !== -1 && eAt !== -1 ? index.slice(bAt, eAt) : '';
const legacy = index.replace(/<!-- VN-SHELL:BEGIN[\s\S]*?<!-- VN-SHELL:END -->/, '');

const grab = (src) => [...new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
const ids = grab(shell);
const legacyIds = new Set(grab(legacy));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const appRefs = (id) => (app.match(new RegExp("(['\"`]" + esc(id) + "['\"`])|(#[\\w-]*" + esc(id) + "\\b)", 'g')) || []).length;

console.log('== 结构检查 ==');
const checks = [
  ['外壳片段存在', shell.length > 0],
  ['外壳在 #vnLegacyDom 之前（P1）', bAt !== -1 && bAt < index.indexOf('id="vnLegacyDom"')],
  ['外壳内 #messageInput 存在', /id="messageInput"/.test(shell)],
  ['外壳内 #btnSend 存在', /id="btnSend"/.test(shell)],
  ['#messageInput 第一个在 外壳内', index.indexOf('id="messageInput"') > bAt && index.indexOf('id="messageInput"') < eAt],
  ['#btnSend 第一个在 外壳内', index.indexOf('id="btnSend"') > bAt && index.indexOf('id="btnSend"') < eAt],
  ['#editModal 在隐藏区之外', index.indexOf('id="editModal"') > eAt],
  ['已引入 css/desktop/vn.css', index.includes('css/desktop/vn.css')],
  ['已引入 js/desktop/vn-shell.js', index.includes('js/desktop/vn-shell.js')],
];
checks.forEach(([name, ok]) => console.log((ok ? '  OK   ' : '  FAIL ') + name));

const taken = [], dup = [], own = [];
for (const id of ids) {
  const n = appRefs(id);
  if (n > 0) taken.push(`${id}${legacyIds.has(id) ? '（与旧 DOM 重名）' : ''}`);
  else if (legacyIds.has(id)) dup.push(id);
  else own.push(id);
}

console.log(`\n== 外壳 id ${ids.length} 个 ==`);
console.log(`A. app.js 会接管（外壳在前 + 被引用）${taken.length} 个：`);
console.log('   ' + taken.join('  '));
console.log(`B. 与旧 DOM 重名、app.js 不引用 ${dup.length} 个：\n   ` + (dup.join('  ') || '（无）'));
console.log(`C. 外壳独占 ${own.length} 个：\n   ` + own.join('  '));
console.log('\n== 设计稿定义但未被外壳片段包含的 id ==');
console.log('   ' + (grab(html).filter((i) => !ids.includes(i)).join('  ') || '（无）'));

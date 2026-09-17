#!/usr/bin/env node
/**
 * 从最近一次 --dump-dom 的结果里抠出左侧边栏的角色卡 HTML（看 app.js 生成的 class/结构）。
 *   node tools/dump-sidebar-html.js [id]
 */
const fs = require('fs');
const path = require('path');

const id = process.argv[2] || 'characterList';
const file = path.resolve(__dirname, '..', '.probe-tmp', 'real-dom.html');
if (!fs.existsSync(file)) { console.error('没有 real-dom.html，先跑 probe-real.js'); process.exit(1); }
const dom = fs.readFileSync(file, 'utf8');

const at = dom.indexOf('id="' + id + '"');
if (at < 0) { console.error('没找到 #' + id); process.exit(1); }
const start = dom.lastIndexOf('<', at);
const open = dom.slice(start, dom.indexOf('>', at) + 1);
const tag = (open.match(/^<([a-z0-9-]+)/i) || [, 'div'])[1];

/* 标签配对找闭合 */
let depth = 0, i = start;
const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '>', 'gi');
re.lastIndex = start;
let m, end = dom.length;
while ((m = re.exec(dom))) {
  if (m[0].slice(0, 2) === '</') { depth--; if (depth === 0) { end = m.index + m[0].length; break; } }
  else depth++;
}
let html = dom.slice(start, end);
/* 每个标签单独一行，方便看结构 */
html = html.replace(/></g, '>\n<');
console.log(html.length > 60000 ? html.slice(0, 60000) + '\n…（截断）' : html);

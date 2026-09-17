/**
 * 从 --dump-dom 的输出里取 #vnDebug 的 JSON（外壳自述状态）。
 *   node tools/read-vndebug.js [dumpPath]
 */
const fs = require('fs');
const d = fs.readFileSync(process.argv[2] || '.probe-tmp/real-dom.html', 'utf8');
const key = 'id="vnDebug"';
const at = d.indexOf(key);
if (at < 0) { console.error('#vnDebug 不存在（外壳没跑到 dumpState？）'); process.exit(1); }
const gt = d.indexOf('>', at);
const end = d.indexOf('</pre>', gt);
const raw = d.slice(gt + 1, end)
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
let obj;
try { obj = JSON.parse(raw); } catch (e) { console.error('JSON 解析失败：\n' + raw.slice(0, 1500)); process.exit(1); }
console.log(JSON.stringify(obj, null, 2));

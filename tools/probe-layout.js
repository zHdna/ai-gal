/* 用无头 Chrome 打开 mockup-probe.html，取回结构化布局测量结果（v2 桌面稿）
 * 用法: node tools/probe-layout.js 1920x1080,1366x768[,2560x1440]
 *       node tools/probe-layout.js 1920x1080 --seg=3        # 指定段落状态
 *       node tools/probe-layout.js 1920x1080 --theme=light
 * 注意：直接把 chrome 的 stdout 重定向到「文件」而不是管道（沙箱下管道会 EPERM）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

if (!CHROME) { console.error('no chrome/edge found'); process.exit(1); }

const argv = process.argv.slice(2);
const extra = argv.filter(a => a.startsWith('--')).map(a => '&' + a.slice(2)).join('');
const sizes = (argv.find(a => !a.startsWith('--')) || '1920x1080').split(',').map(s => s.trim());
const base = `http://127.0.0.1:3211/tools/mockup-probe.html`;
const work = path.resolve(__dirname, '..', '.probe-tmp');
fs.mkdirSync(work, { recursive: true });
const profile = path.join(work, 'chrome-profile');

let failed = 0;
for (const size of sizes) {
  const [w, h] = size.split('x');
  const url = `${base}?w=${w}&h=${h}${extra}`;
  const dumpFile = path.join(work, `dom-${size}.html`);
  const errFile = path.join(work, `err-${size}.log`);
  const fd = fs.openSync(dumpFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`,
      '--virtual-time-budget=6000',
      '--dump-dom',
      url,
    ], { stdio: ['ignore', fd, fdErr] });
  } catch (e) {
    console.error(`[${size}] chrome failed:`, e.message);
    console.error('  stderr:', fs.readFileSync(errFile, 'utf8').slice(0, 600).replace(/\s+/g, ' '));
    fs.closeSync(fd);
    fs.closeSync(fdErr);
    failed++;
    continue;
  }
  fs.closeSync(fd);
  fs.closeSync(fdErr);

  const out = fs.readFileSync(dumpFile, 'utf8');
  const m = out.match(/@@PROBE@@([\s\S]*?)@@END@@/);
  if (!m) {
    console.error(`[${size}] no probe payload; html head:`, out.slice(0, 300).replace(/\s+/g, ' '));
    failed++;
    continue;
  }
  const d = JSON.parse(decodeURIComponent(m[1]));
  console.log('\n================ ' + size + '  seg=' + d.seg + '  theme=' + d.theme + ' ================');
  console.log('artFrame  :', JSON.stringify(d.artFrame));
  console.log('dialog    :', JSON.stringify(d.dialog));
  console.log('avatars   :', JSON.stringify(d.avatars));
  console.log('text      :', JSON.stringify(d.text));
  console.log('choices   :', JSON.stringify(d.choices));
  console.log('controls  :', JSON.stringify(d.controls));
  console.log('sidebar   :', JSON.stringify(d.sidebar));
  console.log('dockOpen  :', JSON.stringify(d.dockOpen));
  console.log('tabs      :', JSON.stringify(d.tabs));
  console.log('dockClosed:', JSON.stringify(d.dockClosed), '| dockOpen:', JSON.stringify(d.dockOpen));
  console.log('menu      :', JSON.stringify(d.menu), '| sheetHist:', JSON.stringify(d.sheetHist));
  console.log('themeSwitch:', JSON.stringify(d.themeSwitch));
  console.log('hideUI    :', JSON.stringify(d.hideUI));
  console.log('boxes     :', JSON.stringify(d.boxes));
  console.log('notes     :', d.notes.length ? '\n - ' + d.notes.join('\n - ') : 'none');
  console.log('FAIL      :', d.fail.length ? '\n X ' + d.fail.join('\n X ') : 'none');
  if (d.fail.length) failed++;
}
console.log('\n==== ' + (failed ? failed + ' 个尺寸存在问题' : '全部尺寸 PASS') + ' ====');


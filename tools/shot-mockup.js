/* 用无头 Chrome 给设计稿拍多状态截图（供人眼/视觉模型核对）
 * 用法: node tools/shot-mockup.js            # 拍全部预设状态
 *       node tools/shot-mockup.js 1920x1080  # 只拍某个尺寸
 * 产物: .probe-tmp/shots/*.png
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
if (!CHROME) { console.error('no chrome/edge'); process.exit(1); }

const work = path.resolve(__dirname, '..', '.probe-tmp');
const out = path.join(work, 'shots');
fs.mkdirSync(out, { recursive: true });
const profile = path.join(work, 'chrome-profile');

const BASE = 'http://127.0.0.1:3211/design/mockups/desktop-vn.html';
const only = process.argv[2];

const shots = [
  { name: 'a-dark-dialog-1920', size: '1920x1080', q: 'theme=dark&seg=0' },
  { name: 'k-dark-sidebar-1920', size: '1920x1080', q: 'theme=dark&seg=0&side=1' },
  { name: 'h-dark-choices-1920', size: '1920x1080', q: 'theme=dark&seg=5' },
  { name: 'n-dark-tooltip-1920', size: '1920x1080', q: 'theme=dark&seg=0&tts=0&tip=1' },
  { name: 'i-light-choices-1920', size: '1920x1080', q: 'theme=light&seg=5' },
  { name: 'g-dark-longdialog-1920', size: '1920x1080', q: 'theme=dark&seg=3' },
  { name: 'b-dark-narration-1920', size: '1920x1080', q: 'theme=dark&seg=4' },
  { name: 'c-light-dialog-1920', size: '1920x1080', q: 'theme=light&seg=0' },
  { name: 'd-dark-dialog-1366', size: '1366x768', q: 'theme=dark&seg=0' },
  { name: 'j-dark-choices-1366', size: '1366x768', q: 'theme=dark&seg=5' },
  { name: 'e-dark-panel-1920', size: '1920x1080', q: 'theme=dark&seg=0&panel=status' },
  { name: 'o-dark-history-1920', size: '1920x1080', q: 'theme=dark&seg=0&hist=1' },
  { name: 'p-dark-console-1920', size: '1920x1080', q: 'theme=dark&seg=0&console=1' },
  { name: 'q-dark-font-150-1920', size: '1920x1080', q: 'theme=dark&seg=0&fs=1.5' },
  { name: 'r-dark-font-85-1920', size: '1920x1080', q: 'theme=dark&seg=0&fs=0.85' },
  { name: 'f-dark-menu-1920', size: '1920x1080', q: 'theme=dark&seg=0&menu=1' },
];

for (const s of shots) {
  if (only && s.size !== only) continue;
  const [w, h] = s.size.split('x');
  const png = path.join(out, s.name + '.png');
  const url = `${BASE}?${s.q}&noanim=1`;
  const log = fs.openSync(path.join(work, `shot-${s.name}.log`), 'w');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`,
      '--virtual-time-budget=4000',
      `--screenshot=${png}`,
      url,
    ], { stdio: ['ignore', log, log] });
  } catch (e) {
    console.error(`[${s.name}] FAILED: ${e.message}`);
    console.error('  ' + fs.readFileSync(path.join(work, `shot-${s.name}.log`), 'utf8').split('\n').slice(-4).join(' | '));
    fs.closeSync(log);
    continue;
  }
  fs.closeSync(log);
  const kb = (fs.statSync(png).size / 1024).toFixed(0);
  console.log(`${s.name.padEnd(26)} ${s.size.padEnd(10)} ${kb} KB  ${url}`);
}
console.log('shots dir:', out);

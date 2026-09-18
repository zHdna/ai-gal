#!/usr/bin/env node
/**
 * 任意 URL 截图（headless Chrome）
 *
 *   node tools/shot-url.js <url> <out.png> [WxH] [budgetMs]
 *
 * 与 tools/probe-real.js 同一套 Chrome 参数；stdio 落盘（管道会 EPERM）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requireBrowser } = require('./browser');

const url = process.argv[2];
const out = process.argv[3];
const size = (process.argv[4] || '1920x1080').split('x');
const budget = process.argv[5] || '6000';
if (!url || !out) { console.error('usage: node tools/shot-url.js <url> <out.png> [WxH] [budgetMs]'); process.exit(2); }

const CHROME = requireBrowser();

fs.mkdirSync(path.dirname(out), { recursive: true });
const work = path.join(__dirname, '..', '.probe-tmp');
fs.mkdirSync(work, { recursive: true });
const log = path.join(work, 'shot-url.log');
const fd = fs.openSync(log, 'w');

const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--user-data-dir=' + path.join(work, 'chrome-profile'),
  '--window-size=' + size[0] + ',' + size[1],
  '--virtual-time-budget=' + budget,
  '--screenshot=' + path.resolve(out),
  url,
];
const r = spawnSync(CHROME, args, { stdio: ['ignore', fd, fd], timeout: 90000 });
fs.closeSync(fd);
const ok = fs.existsSync(out);
console.log((ok ? 'OK  ' : 'FAIL') + ' ' + out + '  ' + (ok ? Math.round(fs.statSync(out).size / 1024) + ' KB' : 'see ' + log) + '  exit=' + r.status);
process.exit(ok ? 0 : 1);

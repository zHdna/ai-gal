#!/usr/bin/env node
/**
 * 真实前端 DOM 探针：headless Chrome --dump-dom 抓取运行后的页面，
 * 再把 VN 外壳关心的事实打出来（不依赖肉眼截图）。
 *
 *   node tools/probe-real.js <url> [WxH] [budgetMs]
 *
 * Chrome 的 stdout 必须重定向到「文件」（管道在沙箱下 EPERM）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2];
if (!url) { console.error('usage: node tools/probe-real.js <url> [WxH] [budgetMs]'); process.exit(2); }
const size = (process.argv[3] || '1920x1080').split('x');
const budget = process.argv[4] || '14000';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(3); }

const work = path.resolve(__dirname, '..', '.probe-tmp');
fs.mkdirSync(work, { recursive: true });
const domFile = path.join(work, 'real-dom.html');
const logFile = path.join(work, 'real-dom.log');
fs.writeFileSync(domFile, '');
fs.writeFileSync(logFile, '');

const domFd = fs.openSync(domFile, 'w');
const logFd = fs.openSync(logFile, 'w');
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--user-data-dir=' + path.join(work, 'chrome-profile-real'),
  '--window-size=' + size[0] + ',' + size[1],
  '--virtual-time-budget=' + budget,
  '--dump-dom', url,
];
spawnSync(CHROME, args, { stdio: ['ignore', domFd, logFd], timeout: 120000 });
fs.closeSync(domFd); fs.closeSync(logFd);

const dom = fs.readFileSync(domFile, 'utf8');
if (!dom || dom.length < 500) {
  console.error('DOM 抓取失败（' + dom.length + ' bytes），日志: ' + logFile);
  console.error(fs.readFileSync(logFile, 'utf8').slice(-800));
  process.exit(1);
}

/* ---------- 极简 HTML 解析：只取 id 元素与 class 计数 ---------- */
function attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : '';
}
function innerOf(id) {
  const at = dom.indexOf('id="' + id + '"');
  if (at < 0) return { found: false };
  const start = dom.lastIndexOf('<', at);
  const open = dom.slice(start, dom.indexOf('>', at) + 1);
  const tag = (open.match(/^<([a-z0-9-]+)/i) || [, 'div'])[1];
  /* 用标签配对找闭合（假设无同名嵌套，VN 外壳满足） */
  let depth = 0, i = start;
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '>', 'gi');
  re.lastIndex = start;
  let m;
  while ((m = re.exec(dom))) {
    if (m[0].slice(0, 2) === '</') { depth--; if (depth === 0) return { found: true, tag, open, inner: dom.slice(re.lastIndex, m.index), outer: dom.slice(start, m.index + m[0].length) }; }
    else depth++;
  }
  return { found: true, tag, open, inner: dom.slice(start, start + 3000), outer: '' };
}
function text(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function countClass(cls) {
  const re = new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"', 'g');
  return (dom.match(re) || []).length;
}

const out = {};
['app', 'messagesArea', 'vnLegacyDom', 'dlgText', 'dlgNarr', 'spkName', 'avLImg', 'avRImg',
  'characterList', 'stripAvatars', 'saveSwitch', 'segBadge', 'choices', 'cgImg', 'histBody',
  'logAgent', 'logButler', 'messageInput', 'btnSend', 'conversationTitle', 'tokenContext',
  'leftSidebar', 'btnTheme'].forEach((id) => {
    const r = innerOf(id);
    if (!r.found) { out[id] = null; return; }
    out[id] = { tag: r.tag, attrs: r.open.replace(/\s+/g, ' ').slice(0, 220), text: text(r.inner).slice(0, 300), len: r.inner.length };
  });

out._counts = {
  storyBlock: countClass('story-block'),
  userBlock: (dom.match(/class="story-block user"/g) || []).length,
  dialogWrapper: countClass('dialog-wrapper'),
  narration: countClass('narration-text'),
  choiceMenu: countClass('choice-menu'),
  charItem: countClass('character-item'),
  stripAvatar: countClass('strip-avatar'),
  conItem: countClass('con-item'),
  debugCard: countClass('debug-card'),
  hist: countClass('hist'),
  roster: countClass('roster'),
  cg: countClass('\\bcg\\b'),
};
out._theme = attr(dom.slice(dom.indexOf('<html')), 'data-theme');
out._bodyThemeMode = attr(dom.slice(dom.indexOf('<body')), 'theme-mode');
out._appClass = (attr(dom.slice(dom.indexOf('id="app"') - 200, dom.indexOf('id="app"') + 40), 'class'));

console.log(JSON.stringify(out, null, 2));

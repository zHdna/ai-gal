#!/usr/bin/env node
/**
 * 设计稿 → 生产文件 同步工具
 *
 *   node tools/build-desktop-vn.js [--check]
 *
 * 把 design/mockups/desktop-vn.html（唯一设计源）里的
 *   1. <style> 块    → public/css/desktop/vn.css  （作用域化：规则收进 .app，避免污染 app.js 的模态框）
 *   2. <div class="app"> DOM → 注入 public/index.html 的 <!-- VN-SHELL:BEGIN/END --> 之间
 * 产物头部写「由设计稿生成，勿手改」。
 *
 * 作用域化：
 *   :root                     → .app
 *   html[data-theme="light"]  → html[data-theme="light"] .app
 *   html.noanim               → html.noanim .app
 *   html / body               → .app
 *   .app…                     → 原样
 *   其它                      → .app <选择器>
 *   @media 内同样处理；@keyframes 内不动
 *
 * id 改写：设计稿的 id → app.js 真正绑定的 id（外壳在文档序最前，等于交出控制权）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOCK = path.join(ROOT, 'design/mockups/desktop-vn.html');
const OUT_CSS = path.join(ROOT, 'public/css/desktop/vn.css');
const OUT_HTML = path.join(ROOT, 'public/index.html');
const INTEGRATION = path.join(ROOT, 'design/mockups/desktop-vn.integration.css');
const BANNER = '/* 本文件由 design/mockups/desktop-vn.html 生成（node tools/build-desktop-vn.js）；要改样式请改设计稿 */\n';

/* 设计稿 id → 生产 id（app.js 的 DOM 契约） */
const ID_MAP = {
  cmdInput: 'messageInput',   // 发送缓冲 + 选项派发缓冲（app.js:4590 / app.js:694）
};

const check = process.argv.includes('--check');
const mock = fs.readFileSync(MOCK, 'utf8');

const rewrite = (s) => Object.keys(ID_MAP).reduce(
  (acc, k) => acc
    .replace(new RegExp('(id=")' + k + '(")', 'g'), '$1' + ID_MAP[k] + '$2')
    .replace(new RegExp('#' + k + '\\b', 'g'), '#' + ID_MAP[k]),
  s,
);

/* 设计稿里的占位素材（../assets/*）只存在于设计稿目录，生产里必须剥掉：
   真实背景 / 立绘由 vn-shell.js 从 AppState 与 CG 画廊写入，缺图时走中性格渐变，
   绝不能把 mockup 的示例照片、更不能用 404 的坏图。 */
const stripAssets = (s) => s
  .replace(/\s+src="\.\.\/assets\/[^"]*"/g, ' data-empty="1"')
  .replace(/(data-big|data-(?:src|cap))="\.\.\/assets\/[^"]*"/g, '$1=""')
  .replace(/url\((['"]?)\.\.\/assets\/[^'")]*\1\)/g, 'none');

/* ---------- 1. 取 <style> ---------- */
const styleMatch = mock.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error('设计稿里找不到 <style>');
let css = styleMatch[1];

/* ---------- 2. 作用域化 ---------- */
function splitSelectors(sel) {
  const out = [];
  let depth = 0, buf = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
  }
  out.push(buf);
  return out;
}

function scopeOne(s) {
  const t = s.trim();
  if (!t) return t;
  if (/^@/.test(t)) return t;
  if (/^html\[data-theme=/.test(t)) return t.replace(/^(html\[data-theme="(?:light|dark)"\])\s*/, '$1 .app ');
  if (/^html\.noanim/.test(t)) return t.replace(/^html\.noanim\s*/, 'html.noanim .app ');
  if (/^:root\b/.test(t)) return '.app';
  if (/^(html|body)\b/.test(t)) return '.app';
  if (/^\.app\b/.test(t)) return t;
  return '.app ' + t;
}

const scopeSelectorList = (list) => {
  const seen = [];
  for (const s of splitSelectors(list).map(scopeOne)) {
    const t = s.replace(/[ \t]+/g, ' ').trim();
    if (t && seen.indexOf(t) === -1) seen.push(t);
  }
  return seen.join(', ');
};

/* 递归解析成树，再递归作用域化 */
function parse(text) {
  const nodes = [];
  let i = 0;
  while (i < text.length) {
    const ws = text.slice(i).match(/^\s+/);            // 先吃掉空白，保证 i 正好落在注释或选择器上
    if (ws) { nodes.push({ t: 'raw', text: ws[0] }); i += ws[0].length; continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      nodes.push({ t: 'raw', text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (text[i] === '}') { i++; continue; }
    const brace = text.indexOf('{', i);
    if (brace === -1) { nodes.push({ t: 'raw', text: text.slice(i) }); break; }
    const head = text.slice(i, brace);
    if (head.trim().startsWith('@')) {
      let depth = 1, j = brace + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      nodes.push({ t: 'at', head: head.trim(), children: parse(text.slice(brace + 1, j - 1)) });
      i = j;
      continue;
    }
    const close = text.indexOf('}', brace);
    const stop = close === -1 ? text.length : close + 1;
    nodes.push({ t: 'rule', head, body: text.slice(brace, stop) });
    i = stop;
  }
  return nodes;
}

function render(nodes, inKeyframes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'raw') { out += n.text; continue; }
    if (n.t === 'at') {
      out += n.head + '{' + render(n.children, inKeyframes || /^@keyframes/.test(n.head)) + '}';
      continue;
    }
    if (inKeyframes) { out += n.head + n.body; continue; }
    const lead = (n.head.match(/^(\s*)/) || ['', ''])[1];
    const rest = n.head.slice(lead.length);
    const trail = (rest.match(/\s*$/) || [''])[0];
    out += lead + scopeSelectorList(rest.trim()) + trail + n.body;
  }
  return out;
}

css = render(parse(css), false);

/* ---------- 3. 集成规则（手写，不参与生成） ---------- */
const integration = fs.existsSync(INTEGRATION)
  ? '\n\n/* ===================== 集成层（手写：design/mockups/desktop-vn.integration.css） ===================== */\n' +
  fs.readFileSync(INTEGRATION, 'utf8').trimEnd() + '\n'
  : '';

const cssOut = stripAssets(rewrite(BANNER + css.trimEnd() + '\n' + integration));

/* ---------- 4. 取 VN DOM 片段 ---------- */
const appStart = mock.indexOf('<div class="app" id="app">');
if (appStart === -1) throw new Error('设计稿里找不到 <div class="app" id="app">');
let depth = 0, end = -1;
const tagRe = /<(\/?)div\b[^>]*>/g;
tagRe.lastIndex = appStart;
let m;
while ((m = tagRe.exec(mock))) {
  if (m[1] === '/') { depth--; if (depth === 0) { end = m.index + m[0].length; break; } }
  else depth++;
}
if (end === -1) throw new Error('设计稿 .app 块不闭合');
const fragment = stripAssets(rewrite(mock.slice(appStart, end)));

const html = fs.readFileSync(OUT_HTML, 'utf8');
const B = '<!-- VN-SHELL:BEGIN（由 tools/build-desktop-vn.js 从设计稿生成） -->';
const E = '<!-- VN-SHELL:END -->';
const hasMarkers = html.includes(B) && html.includes(E);

if (check) {
  console.log('生成 CSS:', cssOut.length, 'bytes（含 id 改写）');
  console.log('VN DOM 片段:', fragment.length, 'bytes');
  console.log('片段里 id="messageInput":', (fragment.match(/id="messageInput"/g) || []).length);
  console.log('index.html 已插入标记:', hasMarkers);
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT_CSS), { recursive: true });
fs.writeFileSync(OUT_CSS, cssOut, 'utf8');
console.log('写出 public/css/desktop/vn.css  ' + cssOut.length + ' bytes');

if (hasMarkers) {
  const re = new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + E);
  fs.writeFileSync(OUT_HTML, html.replace(re, B + '\n' + fragment + '\n' + E), 'utf8');
  console.log('已更新 index.html 的 VN 外壳片段  ' + fragment.length + ' bytes');
} else {
  fs.mkdirSync(path.join(ROOT, '.probe-tmp'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.probe-tmp/vn-fragment.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(ROOT, '.probe-tmp/vn-css-preview.css'), cssOut, 'utf8');
  console.log('index.html 还没有 VN-SHELL 标记，片段与 CSS 预览先写到 .probe-tmp/');
}

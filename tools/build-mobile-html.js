#!/usr/bin/env node
/**
 * 组装 public/mobile.html
 * ---------------------------------------------------------------------------
 * 背景：public/index.html 是桌面版入口。移动端要「复用 app.js 的业务逻辑」，
 * 就必须提供 app.js 期望的 DOM 契约（各类 id / 容器）。因此本脚本：
 *   1) 取 index.html 的 <head>（保留桌面样式表 —— app.js 生成的弹窗依赖它们）
 *   2) 取 index.html 的顶栏 / 系统菜单 / main-layout（放进隐藏容器 #vnLegacyDom）
 *   3) 取 index.html 的全部弹窗（移动端用 vn.css 改造成全屏 Sheet）
 *   4) 插入移动端（GAL）外壳 + 三个移动端脚本
 * 用 Node 实现以保证 UTF-8 不被 Windows PowerShell 的 ANSI 读取破坏。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'index.html');
const SHELL = path.join(ROOT, 'tools', 'mobile-shell.html');
const OUT = path.join(ROOT, 'public', 'mobile.html');

const html = fs.readFileSync(INDEX, 'utf8');
const shell = fs.readFileSync(SHELL, 'utf8');

function slice(from, to, label) {
  const a = html.indexOf(from);
  const b = html.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error('切片失败: ' + label + ' (' + a + ',' + b + ')');
  return html.slice(a, b);
}

// 1) head
let head = html.slice(0, html.indexOf('</head>'));
head = head.replace(/<title>[^<]*<\/title>/, '<title>AI-GAL</title>');
// 去掉桌面版的移动端跳转注释块（移动端页面不需要自我跳转）
head = head.replace(/<!--\s*\[移动端前端临时屏蔽[\s\S]*?-->\s*<script>[\s\S]*?<\/script>/, '');
head += `
  <!-- ===== 移动端（GAL）样式：置于桌面样式之后以覆盖 ===== -->
  <link rel="stylesheet" href="css/mobile/vn.css?v=20260913b">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#060B18">
  <script>
    /* 首屏前确定主题与字号，避免闪烁。
       注意：app.js 的 applyThemeVars() 会 removeAttribute('style') 清掉 html 行内样式，
       所以字号用「注入 <style>」承载（写在行内 --fs 会被抹掉）。 */
    (function () {
      try {
        document.documentElement.setAttribute('data-theme', localStorage.getItem('mobile-theme') || 'dark');
        var fs = parseFloat(localStorage.getItem('mobile-font-scale')) || 1;
        var q = new URLSearchParams(location.search).get('fs');
        if (q) fs = parseFloat(q) || 1;
        fs = Math.min(1.6, Math.max(0.85, fs));
        window.__vnFs = fs;
        document.documentElement.setAttribute('data-fs', fs >= 1.3 ? 'xl' : (fs >= 1.15 ? 'lg' : 'md'));
        var st = document.createElement('style');
        st.id = 'vnFsStyle';
        st.textContent = ':root{--fs:' + fs + '}';
        (document.head || document.documentElement).appendChild(st);
      } catch (e) { }
    })();
  </script>
</head>`;

// 2) DOM 契约：顶栏 / 系统菜单 / main-layout
const topBar = slice('<nav class="top-bar"', '<!-- Unified System Menu Bar -->', 'top-bar');
const menuBar = slice('<div class="system-menu-bar"', '<!-- Main Layout -->', 'system-menu-bar');
const mainLayout = slice('<div class="main-layout"', '<!-- Modal: Game Settings -->', 'main-layout');

// 3) 弹窗
const modals = slice('<!-- Modal: Game Settings -->', '<input type="file" id="characterFileInput"', 'modals');

// 4) 组装
const legacy = `
  <!-- ===== app.js 所需的隐藏 DOM 契约（桌面结构，移动端由 vn.css 隐藏） ===== -->
  <div id="vnLegacyDom" style="display:none" aria-hidden="true">
${topBar}
${menuBar}
${mainLayout}
    <div id="statusContent"></div>
    <div id="debugTabContent"></div>
    <div id="tokenCounter" hidden></div>
  </div>
`;

const tail = `
  <input type="file" id="characterFileInput" accept=".json,.png" style="display:none">

  <script src="js/api.js?v=20260709a"></script>
  <script src="js/stscript.js?v=20260709a"></script>
  <script src="js/app.js?v=20260905a"></script>
  <script src="js/mobile/vn-shell.js?v=20260913b"></script>
  <script src="js/mobile/vn-pages.js?v=20260913b"></script>
  <script src="js/mobile/vn-stage.js?v=20260913b"></script>
</body>

</html>
`;

const out = head + '\n' + shell.trimEnd() + '\n' + legacy + '\n' + modals + '\n' + tail;
fs.writeFileSync(OUT, out, 'utf8');
console.log('[build-mobile] 已生成 ' + OUT + '  (' + out.length + ' chars)');

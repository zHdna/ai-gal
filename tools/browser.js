#!/usr/bin/env node
/**
 * browser.js — 定位本机 Chromium 系浏览器（headless 调试工具共用）
 *
 * 解析顺序（全部在运行时计算，源码内不含任何本机绝对路径或用户名）：
 *   1) 环境变量 BROWSER_PATH / CHROME_PATH —— 显式指定，优先级最高
 *   2) PATH 中的 chrome / msedge / chromium 可执行文件
 *   3) 各平台标准安装目录（由 ProgramFiles / LOCALAPPDATA / HOME 等环境变量拼接）
 *   4) Windows 注册表 App Paths（chrome.exe / msedge.exe）
 *
 * 用法：
 *   const { requireBrowser } = require('./browser');
 *   const CHROME = requireBrowser();          // 找不到时打印提示并退出(3)
 *   const maybe  = findBrowser();             // 找不到时返回 ''
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = process.platform === 'win32'
  ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

// 由环境变量拼出的候选安装位置（不含任何字面量绝对路径）
function fromEnvRoots() {
  const out = [];
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.HOME,
    os.homedir(),
  ].filter(Boolean);

  const rels = process.platform === 'win32'
    ? [
        'Google/Chrome/Application/chrome.exe',
        'Microsoft/Edge/Application/msedge.exe',
        'Chromium/Application/chrome.exe',
      ]
    : process.platform === 'darwin'
      ? [
          'Google Chrome.app/Contents/MacOS/Google Chrome',
          'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['google-chrome/google-chrome', 'chromium/chromium'];

  for (const root of roots) for (const rel of rels) out.push(path.join(root, rel));
  return out;
}

function fromExplicitEnv() {
  return ['BROWSER_PATH', 'CHROME_PATH']
    .map((k) => process.env[k])
    .filter(Boolean);
}

function fromPath() {
  const out = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const exe of EXE) out.push(path.join(dir, exe));
  }
  return out;
}

function fromRegistry() {
  if (process.platform !== 'win32') return [];
  const out = [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of keys) {
    try {
      const raw = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = raw.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && m[1]) out.push(m[1].trim());
    } catch { /* 该注册表项不存在 */ }
  }
  return out;
}

function findBrowser() {
  const candidates = [...fromExplicitEnv(), ...fromPath(), ...fromEnvRoots(), ...fromRegistry()];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return '';
}

function requireBrowser() {
  const found = findBrowser();
  if (found) return found;
  console.error('找不到 Chrome / Edge。请用环境变量指定浏览器可执行文件：');
  console.error('  set BROWSER_PATH=<浏览器可执行文件路径>        (Windows CMD)');
  console.error('  $env:BROWSER_PATH="<浏览器可执行文件路径>"     (PowerShell)');
  process.exit(3);
}

module.exports = { findBrowser, requireBrowser };

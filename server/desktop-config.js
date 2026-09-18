/**
 * desktop-config.js — 桌面版可配置项（当前只有端口）
 *
 * 端口之所以要可配置：3210 容易撞上别的程序，用户需要一个自救手段，
 * 而不是「双击没反应」。文件放在 DATA_ROOT 下（不是程序目录），
 * 因此装到 Program Files 也能写入。
 *
 * 解析优先级：
 *   1. 环境变量 PORT          —— 命令行 / Electron 外壳显式指定，最高优先级
 *   2. <DATA_ROOT>/desktop-config.json 的 port
 *   3. 默认 3210
 *
 * 端口被占用时由 index.js 自动向上寻找空闲端口，并把结果**回写本文件**，
 * 所以用户下次启动仍落在那个端口上，不会每次都漂移。
 */

'use strict';

const fs = require('fs');
const paths = require('./paths');

const DEFAULT_PORT = 3210;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function isValidPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

function readConfig() {
  try {
    let raw = fs.readFileSync(paths.DESKTOP_CONFIG_PATH, 'utf8');
    // 记事本 / PowerShell 5.1 写 UTF-8 时会带 BOM，而 JSON.parse 遇到 BOM 直接抛错。
    // 不处理的话用户手改配置会「改了没反应」，所以先剥掉。
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(paths.DATA_ROOT, { recursive: true });
    fs.writeFileSync(paths.DESKTOP_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[desktop-config] 写入失败 ${paths.DESKTOP_CONFIG_PATH}: ${e.message}`);
  }
  return next;
}

/** 取「期望端口」：env PORT > 配置文件 > 默认 3210 */
function resolveDesiredPort() {
  const fromEnv = process.env.PORT;
  if (fromEnv && isValidPort(fromEnv)) return Number(fromEnv);
  const cfg = readConfig();
  if (isValidPort(cfg.port)) return Number(cfg.port);
  return DEFAULT_PORT;
}

/**
 * 取「期望监听地址」：env HOST > 配置 allowLan > 127.0.0.1（仅本机）。
 *
 * allowLan 为 true 时绑定 0.0.0.0，局域网内其它设备（手机、平板）也能打开。
 * 绿色版仍可用 Start-LAN.bat 的 HOST=0.0.0.0 覆盖，行为不变。
 */
function resolveDesiredHost() {
  const fromEnv = process.env.HOST;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const cfg = readConfig();
  return cfg.allowLan === true ? '0.0.0.0' : '127.0.0.1';
}

/** 当前是否允许局域网访问 */
function resolveAllowLan() {
  return resolveDesiredHost() === '0.0.0.0';
}

/**
 * 仅读配置文件、**不看环境变量**的端口 / 地址 —— 桌面版外壳专用。
 *
 * 为什么要这一对：桌面程序是用户从快捷方式启动的，会继承一份环境变量。
 * 如果父进程（开发工具、其它服务）恰好设了 PORT/HOST，用户就会看到
 * 「我在界面里设了 5000，它却跑在别的端口上」。所以外壳以配置文件为准，
 * 环境变量只用于绿色版 / 命令行（server/index.js 仍走 resolveDesired*）。
 */
function resolveConfiguredPort() {
  const cfg = readConfig();
  return isValidPort(cfg.port) ? Number(cfg.port) : DEFAULT_PORT;
}

function resolveConfiguredHost() {
  return readConfig().allowLan === true ? '0.0.0.0' : '127.0.0.1';
}

module.exports = {
  DEFAULT_PORT,
  MIN_PORT,
  MAX_PORT,
  isValidPort,
  readConfig,
  writeConfig,
  resolveDesiredPort,
  resolveDesiredHost,
  resolveAllowLan,
  resolveConfiguredPort,
  resolveConfiguredHost,
  CONFIG_PATH: paths.DESKTOP_CONFIG_PATH,
};

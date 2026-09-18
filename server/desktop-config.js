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
    const raw = fs.readFileSync(paths.DESKTOP_CONFIG_PATH, 'utf8');
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

module.exports = {
  DEFAULT_PORT,
  MIN_PORT,
  MAX_PORT,
  isValidPort,
  readConfig,
  writeConfig,
  resolveDesiredPort,
  CONFIG_PATH: paths.DESKTOP_CONFIG_PATH,
};

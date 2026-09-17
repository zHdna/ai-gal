/**
 * 路径安全校验工具
 * 统一处理路径遍历防护，避免各路由重复实现
 */
const path = require('path');

/**
 * 校验 resolvedPath 是否位于 baseDir 之内
 * @param {string} baseDir - 允许的根目录（绝对路径）
 * @param {string} resolvedPath - 待校验的绝对路径
 * @returns {boolean} - 是否安全
 */
function isPathWithin(baseDir, resolvedPath) {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(resolvedPath);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + path.sep);
}

/**
 * 安全拼接并校验路径，防止路径遍历
 * @param {string} baseDir - 允许的根目录
 * @param {...string} segments - 路径片段
 * @returns {{ ok: boolean, path: string|null }} - 校验结果
 */
function safeJoin(baseDir, ...segments) {
  const resolved = path.resolve(baseDir, ...segments);
  if (isPathWithin(baseDir, resolved)) {
    return { ok: true, path: resolved };
  }
  return { ok: false, path: null };
}

module.exports = { isPathWithin, safeJoin };

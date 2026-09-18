#!/usr/bin/env node
/**
 * clean-runtime.js — 清除全部运行时产物（开发专用目录策略）
 *
 * AI-GAL 目录为开发专用：不保留任何存档、缓存与运行 / 设置记录。
 * 每次修改代码后运行本脚本，使工作区回到「干净、可直接发布」的状态。
 *
 * 用法：
 *   runtime\node.exe tools\clean-runtime.js     （本机自带运行时，推荐）
 *   node tools\clean-runtime.js                 （系统 Node 22+）
 *
 * 被删除的目录会在应用下次启动 / 使用时自动重建，无需手动创建。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 运行时产物：数据库与密钥、存档、生成图、TTS 缓存与队列、上传、立绘占位
const TARGETS = [
  'server/db/data.db',
  'server/db/data.db-wal',
  'server/db/data.db-shm',
  'server/db/.crypto_secret',
  'saves',
  'data/tts-queue.json',
  'data/generated_images',
  'data/tts-cache',
  'data/tts-cache-bak',
  'server/generated_images',
  'public/uploads',
  'profile',
  '.probe-tmp',
];

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(path.join(p, e.name));
    }
    return total;
  } catch { return 0; }
}

let removed = 0;
let freed = 0;

for (const rel of TARGETS) {
  const target = path.join(ROOT, rel);
  if (!fs.existsSync(target)) continue;
  const bytes = sizeOf(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
    freed += bytes;
    console.log(`  ✔ ${rel}${bytes ? `  (${(bytes / 1024).toFixed(1)} KB)` : ''}`);
  } catch (e) {
    console.error(`  ✘ ${rel} — ${e.message}`);
    process.exitCode = 1;
  }
}

// 日志 / 临时输出
for (const name of fs.readdirSync(ROOT)) {
  if (!/\.(log|out|err)$/i.test(name)) continue;
  try {
    freed += sizeOf(path.join(ROOT, name));
    fs.rmSync(path.join(ROOT, name), { force: true });
    removed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n[clean-runtime] 清理完成：${removed} 项，释放 ${(freed / 1024).toFixed(1)} KB`);
console.log('[clean-runtime] 本目录为开发专用，不保留存档 / 缓存 / 运行与设置记录。');

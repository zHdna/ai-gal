/**
 * paths.js — 只读资源目录（APP_ROOT）与可写数据目录（DATA_ROOT）的唯一真相来源。
 *
 * 背景
 * ----
 * 本应用需要写数据库、加密密钥、存档、生成图片、TTS 缓存、上传头像等。安装到
 * `C:\Program Files\` 后程序目录对普通用户**不可写**，那些写入会失败（或被 UAC
 * 虚拟化到 VirtualStore，用户再也找不到自己的存档）。因此所有可写路径统一由本
 * 模块解析，使程序装到任何位置都能正常工作。
 *
 * DATA_ROOT 解析顺序
 * ------------------
 *   1. 环境变量 `AI_GAL_DATA_DIR`   —— 桌面版由 Electron 外壳注入（%APPDATA%\AI-GAL）
 *   2. 程序目录存在 `.portable` 标记 —— 便携模式，数据留在程序目录（U 盘 / 免安装场景）
 *   3. 程序目录可写                 —— 仓库运行 / 解压运行，沿用程序目录
 *   4. 否则 `%APPDATA%\AI-GAL`（Windows）/ `~/.ai-gal`（其他平台）
 *
 * 关键设计
 * --------
 * DATA_ROOT 下的相对布局与 APP_ROOT **完全一致**（server/db、saves、
 * data/generated_images、data/tts-cache、public/uploads、profile）。因此：
 *   · 旧用户（DATA_ROOT === APP_ROOT）路径零变化，**不需要任何数据迁移**；
 *   · 静态资源 URL 不变 —— `/uploads/...` 与 `/profile/...` 仍由同名目录提供。
 *
 * 只读资源（public/ 静态页、BGM/、server/data/anime-character-names.json、
 * GALCG.json、nsfw_tags.txt 等）始终从 APP_ROOT 读取，不参与外置。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 程序目录（只读资源所在）：<root>/server/paths.js → <root> */
const APP_ROOT = path.join(__dirname, '..');

/** 探测目录是否真的可写（能建目录 + 能建删文件），而非只看存在性 */
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataRoot() {
  const fromEnv = process.env.AI_GAL_DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) {
    return { root: path.resolve(String(fromEnv).trim()), source: 'env(AI_GAL_DATA_DIR)' };
  }
  if (fs.existsSync(path.join(APP_ROOT, '.portable'))) {
    return { root: APP_ROOT, source: 'portable-marker' };
  }
  if (probeWritable(APP_ROOT)) {
    return { root: APP_ROOT, source: 'app-root(writable)' };
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return { root: path.join(process.env.APPDATA, 'AI-GAL'), source: 'appdata(fallback)' };
  }
  return { root: path.join(os.homedir(), '.ai-gal'), source: 'home(fallback)' };
}

const { root: DATA_ROOT, source: DATA_ROOT_SOURCE } = resolveDataRoot();

// ── 可写路径（全部位于 DATA_ROOT 下，相对布局与 APP_ROOT 一致）────────────
const DB_DIR = path.join(DATA_ROOT, 'server', 'db');
const DB_PATH = path.join(DB_DIR, 'data.db');
const CRYPTO_SECRET_PATH = path.join(DB_DIR, '.crypto_secret');
const SAVES_DIR = path.join(DATA_ROOT, 'saves');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const GENERATED_IMAGES_DIR = path.join(DATA_DIR, 'generated_images');
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const TTS_QUEUE_FILE = path.join(DATA_DIR, 'tts-queue.json');
/** 缩略图缓存（按「源图路径+尺寸」的 sha1 命名，见 server/utils/thumbnails.js） */
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const UPLOADS_DIR = path.join(DATA_ROOT, 'public', 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const CHARACTER_AVATARS_DIR = path.join(UPLOADS_DIR, 'characters');
const PROFILE_DIR = path.join(DATA_ROOT, 'profile');
/** 桌面版配置（端口等），详见 desktop-config.js */
const DESKTOP_CONFIG_PATH = path.join(DATA_ROOT, 'desktop-config.json');

// ── 只读资源（始终位于程序目录）────────────────────────────────────────────
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const BGM_DIR = path.join(APP_ROOT, 'BGM');
const SERVER_DATA_DIR = path.join(APP_ROOT, 'server', 'data');

const WRITABLE_DIRS = [
  DB_DIR, SAVES_DIR, DATA_DIR, GENERATED_IMAGES_DIR, TTS_CACHE_DIR, THUMBS_DIR,
  UPLOADS_DIR, AVATARS_DIR, CHARACTER_AVATARS_DIR, PROFILE_DIR,
];

/** 幂等创建全部可写目录；单个失败不阻断启动（权限问题会由后续写入报错暴露） */
function ensureWritableDirs() {
  for (const d of WRITABLE_DIRS) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      console.error(`[paths] 无法创建目录 ${d}: ${e.message}`);
    }
  }
}
ensureWritableDirs();

/** 一行诊断信息，方便排查「存档去哪了」这类问题 */
function describe() {
  return `APP_ROOT=${APP_ROOT} | DATA_ROOT=${DATA_ROOT} (source: ${DATA_ROOT_SOURCE})`;
}

module.exports = {
  APP_ROOT,
  DATA_ROOT,
  DATA_ROOT_SOURCE,
  probeWritable,
  ensureWritableDirs,
  describe,

  // 可写
  DB_DIR,
  DB_PATH,
  CRYPTO_SECRET_PATH,
  SAVES_DIR,
  DATA_DIR,
  GENERATED_IMAGES_DIR,
  TTS_CACHE_DIR,
  TTS_QUEUE_FILE,
  THUMBS_DIR,
  UPLOADS_DIR,
  AVATARS_DIR,
  CHARACTER_AVATARS_DIR,
  PROFILE_DIR,
  DESKTOP_CONFIG_PATH,

  // 只读
  PUBLIC_DIR,
  BGM_DIR,
  SERVER_DATA_DIR,
};

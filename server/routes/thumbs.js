/**
 * thumbs.js — 缩略图服务
 *
 * URL 形状刻意与**原图**一一对应，前端只加一个前缀即可切换：
 *   /uploads/characters/<file>            → /api/thumbs/characters/<file>
 *   /uploads/avatars/<file>               → /api/thumbs/avatars/<file>
 *   /api/saves/<id>/avatar/<name>         → /api/thumbs/saves/<id>/avatar/<name>
 *   /api/saves/<id>/images/<file>         → /api/thumbs/saves/<id>/images/<file>
 *
 * 为什么不用一个 ?src=<路径> 的通吃接口：那等于把任意文件读开给 HTTP，必须自己
 * 再造一套白名单；而按上面四条分路，路径全部由已知目录 + basename 拼出，
 * 天然没有穿越空间。
 *
 * 生成时机：**首次请求时生成**（约 50~100ms，之后永久命中缓存）。没有挂到生图
 * 落盘的每一处，是因为 images.js / chat.js 里写文件的地方有十几处，逐个去挂既
 * 容易漏、又把无关模块都改了；改成「请求即生成 + 启动后台预热」等价，且对**已经
 * 存在的老图**一样有效（那些图早就落盘了，挂落盘点反而覆盖不到）。
 *
 * 不支持缩略的图（JPEG 等）：本路由**直接回原图**，前端无需关心失败分支。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const thumbnails = require('../utils/thumbnails');
const paths = require('../paths');

const DEFAULT_SIZE = 256;
const MIN_SIZE = 32;
const MAX_SIZE = 1024;

function parseSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}

/** 统一出口：能出缩略图就出缩略图，不能就回原图（绝不 404 掉一张本来能看的图） */
function sendThumbOrOriginal(req, res, srcPath) {
  let stat;
  try { stat = fs.statSync(srcPath); } catch { return res.status(404).send('Not found'); }
  if (!stat.isFile()) return res.status(404).send('Not found');

  const size = parseSize(req.query.size);
  const thumb = thumbnails.ensureThumbnail(srcPath, size);

  if (!thumb) {
    // 不支持缩略（JPEG/损坏/隔行 PNG）→ 回原图，浏览器该怎么显示还怎么显示
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(srcPath);
  }
  res.setHeader('Content-Type', 'image/png');
  // 缓存键里带了源图 mtime 的语义（ensureThumbnail 会按 mtime 重做），
  // 所以这里可以放心让浏览器缓存；换头像时前端本来就会带 ?t= 破缓存。
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(thumb.file);
}

/** 只取 basename，杜绝 ../ 穿越 */
function safeName(name) {
  const base = path.basename(String(name || ''));
  return base && base !== '.' && base !== '..' ? base : '';
}

module.exports = function thumbsRoutes(db) {
  const router = express.Router();

  // 角色卡上传的头像（public/uploads/characters）
  router.get('/characters/:filename', (req, res) => {
    const name = safeName(req.params.filename);
    if (!name) return res.status(400).send('Bad name');
    sendThumbOrOriginal(req, res, path.join(paths.CHARACTER_AVATARS_DIR, name));
  });

  // 用户 / 扮演身份头像（public/uploads/avatars）
  router.get('/avatars/:filename', (req, res) => {
    const name = safeName(req.params.filename);
    if (!name) return res.status(400).send('Bad name');
    sendThumbOrOriginal(req, res, path.join(paths.AVATARS_DIR, name));
  });

  // 存档内名册头像：解析逻辑与 /api/saves/:id/avatar/:name 完全一致，
  // 否则同一个角色会出现「原图 404 但缩略图有」这类对不上的现象。
  router.get('/saves/:id/avatar/:name', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).send('Not found');
    try {
      const rosterPath = path.join(save.save_path, 'character_roster.json');
      const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf-8'));
      const char = roster[decodeURIComponent(req.params.name)];

      // 占位 NPC：复用默认立绘（PROFILE_DIR 下）
      if (char && (char.avatar === 'NPCF' || char.avatar === 'NPCM')) {
        const holder = path.join(paths.PROFILE_DIR, char.avatar + '.jpg');
        if (fs.existsSync(holder)) return sendThumbOrOriginal(req, res, holder);
      }
      if (char && char.avatar && char.avatar !== 'pending' && char.avatar !== '' && char.avatar !== '已有头像') {
        const imgDir = path.resolve(save.save_path, 'images');
        const avatarPath = path.resolve(imgDir, char.avatar);
        if (!avatarPath.startsWith(imgDir + path.sep)) return res.status(403).send('Forbidden');
        if (fs.existsSync(avatarPath)) return sendThumbOrOriginal(req, res, avatarPath);
      }
    } catch { /* 名册缺失/损坏 → 落到 404 */ }
    res.status(404).send('Not found');
  });

  // 存档内的图（CG / 立绘），画廊格子用这个
  router.get('/saves/:id/images/:filename', (req, res) => {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) return res.status(404).send('Not found');
    const name = safeName(req.params.filename);
    if (!name) return res.status(400).send('Bad name');
    const imgDir = path.resolve(save.save_path, 'images');
    const imgPath = path.resolve(imgDir, name);
    if (!imgPath.startsWith(imgDir + path.sep)) return res.status(403).send('Forbidden');
    sendThumbOrOriginal(req, res, imgPath);
  });

  return router;
};

module.exports.DEFAULT_SIZE = DEFAULT_SIZE;

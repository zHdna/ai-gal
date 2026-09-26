/**
 * thumbnails.js — 零依赖 PNG 缩略图生成器（node:zlib）
 *
 * 为什么要自己写
 * --------------
 * AI-GAL 的运行依赖只有 express / better-sqlite3 / multer / uuid / archiver，
 * 刻意不引 sharp / canvas 这类**含原生二进制**的包：桌面版是整目录拷贝分发，
 * 多一个原生模块就多一份"换机器/node 版本对不上就启动失败"的风险，而且
 * sharp 的预编译包会让安装体积翻好几倍。
 *
 * 而本项目的图几乎全是 PNG（实测 saves 下 54 张：52 PNG / 2 JPEG），
 * 所以只用 node 自带的 zlib 就能覆盖：PNG 解码 = inflate + 逐行反滤波，
 * 编码 = 逐行滤波 + deflate，两边都不需要第三方代码。
 *
 * 干什么
 * ------
 *   头像：1536x2720 / 6MB 的原图 → 256px 缩略图（几十 KB）
 *   画廊：1024x1024 / 1MB 的 CG    → 384px 缩略图
 * 前端先用缩略图铺满界面，只有用户点开放大或切到某张图时才读原图。
 *
 * 缓存
 * ----
 * 缩略图落在 DATA_ROOT/data/thumbs/ 下（可写目录，随数据外置），文件名是
 * 「源文件绝对路径 + 尺寸」的 sha1 —— 源目录保持干净，不往用户图库里塞东西。
 * 用 mtime+size 判新鲜度，源图被重新生成/覆盖会自动重做。
 *
 * 不支持的情况一律**返回 null**（调用方回落到原图），绝不抛错打断请求：
 *   · Adam7 隔行扫描 PNG
 *   · 非 PNG（JPEG/WEBP/BMP/GIF）—— 需要完整的 JPEG 解码器，不在本模块范围内
 *   · 结构损坏 / CRC 不符
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const paths = require('../paths');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 缩略图缓存目录（惰性创建，避免只读环境下 paths 初始化就失败） */
function thumbsDir() {
  const dir = paths.THUMBS_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只读环境：后面写会失败，由调用方回落 */ }
  return dir;
}

/* ---------------- CRC32（PNG 每个 chunk 都要） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- PNG 解码 ---------------- */

/** 每种颜色类型的通道数：0=灰 2=RGB 3=调色板 4=灰+Alpha 6=RGBA */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 PNG → { width, height, rgba }（RGBA8，直通内存，不依赖任何库）。
 * 不支持时返回 null（不抛错）。
 */
function decodePNG(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;          // 截断
    const data = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (len < 13) return null;
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }

  if (!ihdr || !idat.length) return null;
  if (ihdr.interlace !== 0) return null;                          // Adam7 不支持
  if (ihdr.compression !== 0 || ihdr.filter !== 0) return null;   // 规范里只有 0
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) return null;
  if (ihdr.colorType === 3 && !palette) return null;
  const { width, height, bitDepth, colorType } = ihdr;
  if (!width || !height) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  // 滤波的"每像素字节数"：位深 <8 时按 1 算（PNG 规范 9.2）
  const bpp = bitDepth < 8 ? 1 : Math.max(1, (bitsPerPixel / 8) | 0);
  if (raw.length < (rowBytes + 1) * height) return null;

  // 逐行反滤波 → 拼成连续像素缓冲
  const img = Buffer.alloc(rowBytes * height);
  let prev = Buffer.alloc(rowBytes);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + rowBytes);
    p += rowBytes;
    const cur = img.subarray(y * rowBytes, (y + 1) * rowBytes);
    line.copy(cur);
    switch (ft) {
      case 0: break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? cur[i - bpp] : 0;
          cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          // Paeth 预测器
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[i] = (cur[i] + pred) & 0xff;
        }
        break;
      default:
        return null;                                   // 非法滤波类型
    }
    prev = cur;
  }

  // 统一转 RGBA8
  const rgba = Buffer.alloc(width * height * 4);
  if (bitDepth === 8) {
    for (let i = 0, n = width * height; i < n; i++) {
      const s = i * channels;
      const d = i * 4;
      if (colorType === 0) { const g = img[s]; rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255; }
      else if (colorType === 2) { rgba[d] = img[s]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s + 2]; rgba[d + 3] = 255; }
      else if (colorType === 4) { const g = img[s]; rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = img[s + 1]; }
      else if (colorType === 6) { rgba[d] = img[s]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s + 2]; rgba[d + 3] = img[s + 3]; }
      else {                                            // 调色板
        const pi = img[s] * 3;
        rgba[d] = palette[pi]; rgba[d + 1] = palette[pi + 1]; rgba[d + 2] = palette[pi + 2];
        rgba[d + 3] = trns && img[s] < trns.length ? trns[img[s]] : 255;
      }
    }
  } else if (bitDepth === 16) {
    for (let i = 0, n = width * height; i < n; i++) {
      const s = i * channels * 2;
      const d = i * 4;
      const hi = (k) => img[s + k * 2];                 // 取高字节即可（8 位精度足够）
      if (colorType === 0) { const g = hi(0); rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255; }
      else if (colorType === 2) { rgba[d] = hi(0); rgba[d + 1] = hi(1); rgba[d + 2] = hi(2); rgba[d + 3] = 255; }
      else if (colorType === 4) { const g = hi(0); rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = hi(1); }
      else if (colorType === 6) { rgba[d] = hi(0); rgba[d + 1] = hi(1); rgba[d + 2] = hi(2); rgba[d + 3] = hi(3); }
      else return null;                                 // 调色板不允许 16 位
    }
  } else {
    // 位深 1/2/4：只有灰度(0)与调色板(3)
    if (colorType !== 0 && colorType !== 3) return null;
    const perByte = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = img[y * rowBytes + ((x / perByte) | 0)];
        const shift = 8 - bitDepth * ((x % perByte) + 1);
        const v = (byte >> shift) & mask;
        const d = (y * width + x) * 4;
        if (colorType === 0) {
          const g = Math.round((v * 255) / mask);
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255;
        } else {
          const pi = v * 3;
          rgba[d] = palette[pi]; rgba[d + 1] = palette[pi + 1]; rgba[d + 2] = palette[pi + 2];
          rgba[d + 3] = trns && v < trns.length ? trns[v] : 255;
        }
      }
    }
  }
  return { width, height, rgba };
}

/* ---------------- 缩放 ---------------- */

/**
 * 面积平均（box filter）缩放。比最近邻慢一点，但没有锯齿 —— 头像是要长期盯着看的，
 * 最近邻在 1536→256 这种 6:1 的倍率下会出现明显的块状噪点。
 */
function boxDownscale(rgba, sw, sh, tw, th) {
  if (sw === tw && sh === th) return rgba;
  const out = Buffer.alloc(tw * th * 4);
  const xRatio = sw / tw;
  const yRatio = sh / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((ty + 1) * yRatio)));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((tx + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let src = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++, src += 4) {
          // 按 alpha 加权，避免透明区域把颜色拉黑
          const av = rgba[src + 3];
          r += rgba[src] * av; g += rgba[src + 1] * av; b += rgba[src + 2] * av; a += av; n++;
        }
      }
      const d = (ty * tw + tx) * 4;
      if (a > 0) {
        out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a);
      }
      out[d + 3] = n ? Math.round(a / n) : 0;
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA8 → PNG（有全不透明像素时自动降为 RGB，体积小 1/4）。全部行用 Paeth 滤波。 */
function encodePNG(rgba, w, h) {
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] !== 255) { hasAlpha = true; break; } }
  const channels = hasAlpha ? 4 : 3;
  const rowBytes = w * channels;
  const raw = Buffer.alloc((rowBytes + 1) * h);

  // ⚠️ 滤波必须拿【未滤波的上一行】做预测（PNG 规范 9.2），而不是 raw 里的上一行 ——
  //    raw 里的上一行已经被减过预测值，拿它当 prev 会让解码端解出彩色噪点。
  //    曾经就踩过这个坑：自己 decode 自己的输出"看起来对"（对称的错），但浏览器一渲染全是雪花。
  const bpp = channels;
  let prevOrig = Buffer.alloc(rowBytes);                // 上一行的【原始】像素
  let orig = Buffer.alloc(rowBytes);
  for (let y = 0; y < h; y++) {
    const out = y * (rowBytes + 1);
    raw[out] = 4;                                       // Paeth
    const line = raw.subarray(out + 1, out + 1 + rowBytes);
    const s = y * w * 4;
    for (let x = 0, d = 0; x < w; x++) {
      orig[d++] = rgba[s + x * 4];
      orig[d++] = rgba[s + x * 4 + 1];
      orig[d++] = rgba[s + x * 4 + 2];
      if (hasAlpha) orig[d++] = rgba[s + x * 4 + 3];
    }
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? orig[i - bpp] : 0;
      const b = prevOrig[i];
      const c = i >= bpp ? prevOrig[i - bpp] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (orig[i] - pred) & 0xff;
    }
    const swap = prevOrig; prevOrig = orig; orig = swap;   // 复用缓冲，行数多时省分配
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                          // 位深
  ihdr[9] = hasAlpha ? 6 : 2;                           // 颜色类型
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 对外：生成缩略图 ---------------- */

/** 按最长边算目标尺寸（只缩不放），返回 null 表示不需要缩 */
function fitSize(w, h, maxSize) {
  const max = Math.max(w, h);
  if (max <= maxSize) return null;
  const scale = maxSize / max;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * 源图 Buffer → 缩略图 PNG Buffer。
 * @returns {Buffer|null} null = 不支持/不需要（调用方回落原图）
 */
function makeThumbnail(srcBuf, maxSize) {
  const max = Math.max(16, Math.min(2048, Number(maxSize) || 256));
  const img = decodePNG(srcBuf);
  if (!img) return null;
  const fit = fitSize(img.width, img.height, max);
  if (!fit) return null;                                // 原图本来就小
  const small = boxDownscale(img.rgba, img.width, img.height, fit.w, fit.h);
  return encodePNG(small, fit.w, fit.h);
}

/* 缓存格式版本：改了编码/缩放算法就 +1 —— 否则老的（可能算错的）缩略图因为
   mtime 比源图新，会被一直当成"命中"用下去，永远不重做。 */
const THUMB_VERSION = 2;

/** 缓存文件名：源路径 + 尺寸的 sha1（源目录保持干净） */
function cacheNameFor(srcPath, maxSize) {
  const h = crypto.createHash('sha1')
    .update(path.resolve(srcPath) + '|' + maxSize + '|v' + THUMB_VERSION)
    .digest('hex').slice(0, 20);
  return h + '-' + maxSize + '-v' + THUMB_VERSION + '.png';
}

/**
 * 取（必要时生成）某个图片文件的缩略图。
 * @param {string} srcPath 源图绝对路径
 * @param {number} maxSize 最长边像素
 * @returns {{file:string, size:number, cached:boolean}|null} null = 不支持，回落原图
 */
function ensureThumbnail(srcPath, maxSize) {
  const max = Math.max(16, Math.min(2048, Number(maxSize) || 256));
  let st;
  try { st = fs.statSync(srcPath); } catch { return null; }
  if (!st.isFile()) return null;

  const outPath = path.join(thumbsDir(), cacheNameFor(srcPath, max));
  // 命中且比源图新 → 直接用
  try {
    const ts = fs.statSync(outPath);
    if (ts.mtimeMs >= st.mtimeMs && ts.size > 0) return { file: outPath, size: ts.size, cached: true };
  } catch { /* 没缓存 */ }

  let src;
  try { src = fs.readFileSync(srcPath); } catch { return null; }
  const png = makeThumbnail(src, max);
  if (!png) return null;
  try {
    const tmp = outPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, png);                         // 先写临时文件再 rename：并发请求不会读到半个文件
    fs.renameSync(tmp, outPath);
  } catch { return null; }
  return { file: outPath, size: png.length, cached: false };
}

/* ---------------- 后台预热 ---------------- */

const WARM_SIZES = [256, 384];
const WARM_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

function listImages(dir, out, depth) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const q = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) listImages(q, out, depth - 1);
    } else if (WARM_EXT.test(e.name)) {
      out.push(q);
    }
  }
  return out;
}

/**
 * 后台预热缩略图缓存：把「已经存在但还没缩略图」的图补上，
 * 这样用户第一次打开界面不会为每张头像各等一次生成。
 *
 * 关键约束：**不能挡住服务器启动，也不能长时间占住事件循环**。
 * 所以是 setImmediate 逐个做（每张之间让出一次事件循环），并且在生成前
 * 先 stat 一下缓存是否已命中 —— 命中就直接跳过，不读源图、不解码。
 *
 * @param {string[]} dirs 要扫描的目录（存档的 images、uploads 等）
 * @param {(done:number,total:number,skipped:number)=>void} [onDone]
 */
function warmCache(dirs, onDone) {
  const files = [];
  for (const d of dirs || []) listImages(d, files, 2);
  // 先过滤掉缓存已命中的，减少无谓的 readFileSync
  const todo = [];
  for (const f of files) {
    let hit = false;
    for (const size of WARM_SIZES) {
      try {
        const outPath = path.join(thumbsDir(), cacheNameFor(f, size));
        const ts = fs.statSync(outPath);
        const ss = fs.statSync(f);
        if (ts.mtimeMs >= ss.mtimeMs && ts.size > 0) { hit = true; break; }
      } catch { /* 未命中 */ }
    }
    if (!hit) todo.push(f);
  }

  let i = 0, done = 0, failed = 0;
  const total = todo.length;
  if (!total) { if (onDone) onDone(0, 0, files.length); return { total: 0, cancel: () => {} }; }

  let cancelled = false;
  function step() {
    if (cancelled) return;
    const f = todo[i++];
    if (!f) { if (onDone) onDone(done, total, files.length); return; }
    for (const size of WARM_SIZES) {
      try { if (!ensureThumbnail(f, size)) failed++; } catch { failed++; }
    }
    done++;
    // 单张生成是 CPU 密集的（大图约 100ms），中间留一点空档，
    // 让并发的页面请求能插进来 —— 预热再久也不该让界面变卡。
    setTimeout(step, 12);
  }
  setTimeout(step, 12);
  return { total, cancel: () => { cancelled = true; } };
}

module.exports = {
  decodePNG,
  encodePNG,
  boxDownscale,
  makeThumbnail,
  ensureThumbnail,
  fitSize,
  cacheNameFor,
  thumbsDir,
  warmCache,
  WARM_SIZES,
};

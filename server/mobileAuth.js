/**
 * 访问密码（远程访问保护）
 *
 * 需求（用户明确）：
 *   · 只设【一个】密码，不分用户名；
 *   · **本机（127.0.0.1 / ::1）访问不需要密码**；
 *   · 非本机 IP 访问【整个服务】都必须先过密码；
 *   · 默认密码 12345；首次使用时前端应提示用户去系统菜单改掉；
 *   · 密码在系统菜单里修改；忘记密码时在本机登录后重置。
 *
 * 实现要点：
 *   · 密码不落明文：scrypt 加盐哈希后存 app_settings.auth_password_hash；
 *   · 会话用 HMAC 签名的 cookie（值里带签发时间，可设有效期），
 *     签名密钥来自 server/crypto.js 同一份 per-install 密钥材料，
 *     重启后仍然有效、且不随数据库泄露；
 *   · 校验/设置/重置都做常量时间比较，避免时序侧信道；
 *   · 只放行必要的登录接口与登录页静态资源，其余一律 401。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTING_KEY = 'auth_password_hash';
const COOKIE_NAME = 'aigal_auth';
const DEFAULT_PASSWORD = '12345';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 天
const LOGIN_FAIL_WINDOW_MS = 1000 * 60 * 10;       // 10 分钟内
const LOGIN_FAIL_MAX = 20;                         // 最多 20 次失败

/* ---------------- 工具 ---------------- */

function isLoopback(req) {
  let ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
  // Express 在某些部署下会给 ::ffff:127.0.0.1 形式
  ip = String(ip).replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

function scryptHash(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

/** timingSafeEqual 要求等长；不等长时用固定长度比较避免抛异常 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // 仍做一次比较以消耗相近时间，然后返回 false
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------- 密码存储 ---------------- */

function readHash(db) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY);
    return row && row.value ? String(row.value) : '';
  } catch {
    return '';
  }
}

function writeHash(db, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(SETTING_KEY, value);
}

/** 是否已经改过默认密码（用于前端提示"建议设置密码"） */
function isDefaultPassword(db) {
  const stored = readHash(db);
  if (!stored) return true;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  return safeEqual(scryptHash(DEFAULT_PASSWORD, parts[0]), parts[1]);
}

function hasPassword(db) {
  return !!readHash(db);
}

/** 设置密码：只存哈希（salt:hash） */
function setPassword(db, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  writeHash(db, salt + ':' + scryptHash(password, salt));
}

function verifyPassword(db, password) {
  const stored = readHash(db);
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  return safeEqual(scryptHash(password, parts[0]), parts[1]);
}

/** 确保存在一个密码（首次启动写入默认密码 12345） */
function ensureDefaultPassword(db) {
  if (hasPassword(db)) return false;
  setPassword(db, DEFAULT_PASSWORD);
  console.log('[Auth] 已写入默认访问密码（请提醒用户尽快在系统菜单里修改）');
  return true;
}

/* ---------------- 会话（HMAC 签名 cookie） ---------------- */

let SIGN_KEY = null;
function signKey() {
  if (SIGN_KEY) return SIGN_KEY;
  // 与加密模块同源：优先环境变量，否则用同一份 per-install 密钥文件
  const material = (process.env.CRYPTO_PASSWORD && process.env.CRYPTO_SALT)
    ? process.env.CRYPTO_PASSWORD + '|' + process.env.CRYPTO_SALT
    : (() => {
        try { return fs.readFileSync(require('./paths').CRYPTO_SECRET_PATH, 'utf8').trim(); }
        catch { return 'ai-gal-auth-fallback'; }
      })();
  SIGN_KEY = crypto.scryptSync('auth-session|' + material, 'ai-gal-auth-v1', 32);
  return SIGN_KEY;
}

function sign(payload) {
  return crypto.createHmac('sha256', signKey()).update(payload).digest('hex');
}

function makeToken() {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ts + '.' + nonce;
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  if (!safeEqual(parts[2], sign(payload))) return false;
  const ts = parseInt(parts[0], 36);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) < SESSION_TTL_MS;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthed(req) {
  if (isLoopback(req)) return true;                       // 本机免密
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

function setAuthCookie(res) {
  const token = makeToken();
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/* ---------------- 登录失败限速 ---------------- */

const failures = new Map();   // ip -> { count, first }

function tooManyFailures(ip) {
  const rec = failures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_FAIL_WINDOW_MS) { failures.delete(ip); return false; }
  return rec.count >= LOGIN_FAIL_MAX;
}

function noteFailure(ip) {
  const rec = failures.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

function clearFailures(ip) { failures.delete(ip); }

/* ---------------- 放行清单 ---------------- */

// 未登录也必须能拿到的东西：登录页本体、登录接口、以及登录页用到的静态资源。
function isPublicPath(p) {
  const s = String(p || '');
  if (s === '/login' || s === '/login.html') return true;
  if (s.startsWith('/api/auth/')) return true;            // login / status
  if (s === '/favicon.ico') return true;
  // 登录页需要的最少静态资源（样式/字体/图标）；不做通配以免把业务接口漏出去
  if (/^\/css\/[A-Za-z0-9._-]+\.css$/.test(s)) return true;
  if (/^\/js\/(login|api)\.js$/.test(s)) return true;
  return false;
}

/* ---------------- 路由 ---------------- */

function registerRoutes(app, db) {
  app.get('/api/auth/status', (req, res) => {
    res.json({
      isLocal: isLoopback(req),
      authed: isAuthed(req),
      hasPassword: hasPassword(db),
      usingDefaultPassword: isDefaultPassword(db),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = String((req.socket && req.socket.remoteAddress) || req.ip || '');
    if (tooManyFailures(ip)) {
      return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
    }
    if (isLoopback(req)) { setAuthCookie(res); return res.json({ ok: true, isLocal: true }); }
    if (!hasPassword(db)) { setAuthCookie(res); return res.json({ ok: true, noPassword: true }); }
    const password = req.body && req.body.password;
    if (!password || !verifyPassword(db, password)) {
      noteFailure(ip);
      return res.status(401).json({ error: '密码不正确' });
    }
    clearFailures(ip);
    setAuthCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  // 改密码 / 重置：**仅本机**可调用（忘记密码的人在本机登录后重置）
  app.post('/api/auth/password', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: '只能在本机修改访问密码' });
    const next = req.body && req.body.password;
    if (!next || String(next).length < 4) return res.status(400).json({ error: '密码至少 4 位' });
    if (String(next).length > 200) return res.status(400).json({ error: '密码过长' });
    setPassword(db, String(next));
    setAuthCookie(res);          // 本机本来就免密，这里顺手刷新会话
    res.json({ ok: true, usingDefaultPassword: isDefaultPassword(db) });
  });

  // 重置为默认密码 12345（同样仅本机）
  app.post('/api/auth/reset', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: '只能在本机重置访问密码' });
    setPassword(db, DEFAULT_PASSWORD);
    res.json({ ok: true, password: DEFAULT_PASSWORD });
  });
}

/* ---------------- 中间件 ---------------- */

/**
 * 全站门禁：非本机且未通过密码 → 拦下。
 * 页面请求 302 到 /login；接口请求返回 401 JSON（前端据此跳登录页）。
 */
function gate(db) {
  return function (req, res, next) {
    if (isLoopback(req)) return next();
    if (isAuthed(req)) return next();
    if (isPublicPath(req.path)) return next();

    const wantsJson = req.path.startsWith('/api/')
      || (req.headers.accept || '').includes('application/json')
      || req.xhr;
    if (wantsJson) return res.status(401).json({ error: '需要登录', needLogin: true });
    return res.redirect(302, '/login');
  };
}

module.exports = {
  DEFAULT_PASSWORD,
  COOKIE_NAME,
  isLoopback,
  isAuthed,
  hasPassword,
  isDefaultPassword,
  setPassword,
  verifyPassword,
  ensureDefaultPassword,
  registerRoutes,
  gate,
  parseCookies,
  verifyToken,
};

const express = require('express');
const path = require('path');
const { initDatabase } = require('./db/init');
const { APP_KEYS } = require('./constants');

// 防御：单条坏请求(如未捕获的 Promise rejection)不应拖垮整个进程。
// 此前一条带中文缓存参数的 TTS 请求抛 ERR_INVALID_CHAR，直接导致 3210 退出。
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  // 进程状态可能已不一致，安全退出
  process.exit(1);
});

// 桌面版 sidecar 模式：外壳（Electron）退出后本进程必须跟着退出，否则会留下
// 孤儿 node 占着端口，用户下次启动就会莫名换端口。IPC 通道断开是父进程已死的
// 可靠信号 —— 比「写 stdout 时撞上 EPIPE」这种偶然事件确定得多。
if (typeof process.send === 'function') {
  process.on('disconnect', () => {
    console.log('[Server] 外壳已退出，sidecar 随之关闭');
    process.exit(0);
  });
}

const app = express();
const appPaths = require('./paths');
const desktopConfig = require('./desktop-config');
const PORT = desktopConfig.resolveDesiredPort();
// 默认仅本机可访问；Start-LAN.bat 的 HOST=0.0.0.0、
// 或桌面版的「允许局域网访问」开关（desktop-config.json 的 allowLan）都会改为全网卡监听。
const LISTEN_HOST = desktopConfig.resolveDesiredHost();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// ===== 移动端前端路由 (2026-09-13 启用) =====
// 规则：
//   · 手机/平板访问，或桌面浏览器窗口很窄 → 自动进入移动端 public/mobile.html
//   · 显式 ?desktop=1（含 Cookie 记忆）→ 停留在桌面版；移动端可随时切回
//   · 需要完全停用移动端跳转时，启动带环境变量 DISABLE_MOBILE_FRONTEND=1（旧开关仍兼容）
const DISABLE_MOBILE_FRONTEND = process.env.DISABLE_MOBILE_FRONTEND === '1';
const PUBLIC_DIR = appPaths.PUBLIC_DIR;
const DESKTOP_INDEX = path.join(PUBLIC_DIR, 'index.html');
const MOBILE_INDEX = path.join(PUBLIC_DIR, 'mobile.html');

function isMobileRequest(req) {
  if (req.query && req.query.desktop === '1') return false;
  if (/forceDesktop=1/.test(req.headers.cookie || '')) return false;
  if (req.query && req.query.mobile === '1') return true;
  if (req.headers['sec-ch-ua-mobile'] === '?1') return true;
  const ua = String(req.headers['user-agent'] || '');
  if (/Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  if (/Mobile|Tablet/i.test(ua) && !/Windows NT|Macintosh/i.test(ua)) return true;
  return false;
}

if (!DISABLE_MOBILE_FRONTEND) {
  // 根路径：手机/平板 → mobile.html；桌面 → index.html
  app.get('/', (req, res) => {
    if (isMobileRequest(req)) return res.sendFile(MOBILE_INDEX);
    return res.sendFile(DESKTOP_INDEX);
  });
  // 旧地址 /m.html、/old/mobile.html 统一跳到新的移动端页面（/mobile.html 本身除外）
  app.use((req, res, next) => {
    var p = req.path.toLowerCase();
    if (p === '/mobile.html') return next();
    if (/^\/(?:old\/)?(?:mobile|m)\.html$/.test(p)) {
      return res.redirect(302, '/mobile.html');
    }
    next();
  });
  // 切回桌面的记忆写在这里，省去移动端额外一次请求
  app.get('/switch-desktop', (req, res) => {
    res.setHeader('Set-Cookie', 'forceDesktop=1; Path=/; Max-Age=31536000; SameSite=Lax');
    res.redirect(302, '/?desktop=1');
  });
  // 恢复移动端（清除记忆）
  app.get('/switch-mobile', (req, res) => {
    res.setHeader('Set-Cookie', 'forceDesktop=; Path=/; Max-Age=0; SameSite=Lax');
    res.redirect(302, '/mobile.html');
  });
}

// Serve static files with no-cache for development
app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));
// profile/ 与 public/uploads/ 是**可写**数据（随 DATA_ROOT 外置，见 server/paths.js），
// 单独挂载到与原先相同的 URL 上，前端不必改任何路径。
app.use('/profile', express.static(require('./paths').PROFILE_DIR));
app.use('/uploads', express.static(require('./paths').UPLOADS_DIR));

// Initialize DB
const db = initDatabase();

// --- Routes ---
app.use('/api/providers', require('./routes/providers')(db));
app.use('/api/characters', require('./routes/characters')(db));
app.use('/api/conversations', require('./routes/conversations')(db));
app.use('/api/messages', require('./routes/messages')(db));
app.use('/api/images', require('./routes/images')(db));
app.use('/api/themes', require('./routes/themes')(db));
app.use('/api/memory-agent', require('./routes/memoryAgent')(db));
app.use('/api/chat', require('./routes/chat')(db));
app.use('/api/card-fixer', require('./routes/cardFixer')(db));
app.use('/api/user', require('./routes/user')(db));
app.use('/api/saves', require('./routes/saves')(db));
app.use('/api/presets', require('./routes/presets')(db));
app.use('/api/script-vars', require('./routes/script-vars')(db));
app.use('/api/script', require('./routes/script-commands')(db));

// TTS Module (cloud API — no local dependencies)
app.use('/api/tts', require('./routes/tts')(db));

// Settings (global_system_prompt read/write)
app.get('/api/settings/system-prompt', (req, res) => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_KEYS.GLOBAL_SYSTEM_PROMPT);
  res.json({ prompt: row ? row.value : '' });
});
app.put('/api/settings/system-prompt', (req, res) => {
  const { prompt } = req.body;
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run(APP_KEYS.GLOBAL_SYSTEM_PROMPT, prompt || '');
  res.json({ message: 'Saved' });
});

// BGM files
app.use('/bgm', require('./routes/bgm')(db));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

// 404 handler (for unmatched API routes)
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '请求体过大，请使用文件上传接口' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: '上传文件数量过多' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── 启动监听：端口被占用时自动向上寻找空闲端口 ─────────────────────────────
// 3210 撞上别的程序时，用户不该看到「双击没反应」。找到可用端口后回写
// desktop-config.json，让下次启动稳定落在同一端口，而不是每次漂移。
const MAX_PORT_TRIES = 20;

function listenOn(port, attempt) {
  attempt = attempt || 0;
  const server = app.listen(port, LISTEN_HOST);

  server.on('listening', () => {
    if (port !== PORT) {
      console.warn(`[Server] 端口 ${PORT} 已被占用，自动改用 ${port}（已记入 desktop-config.json）`);
      desktopConfig.writeConfig({ port });
    }
    const mode = LISTEN_HOST === '0.0.0.0' ? 'LAN accessible' : 'local only';
    console.log(`[Server] AI-GAL running at http://${LISTEN_HOST}:${port} (${mode})`);
    // 固定格式，供 Electron 外壳 / 启动器解析实际端口
    console.log(`[Server] PORT=${port}`);
    console.log(`[paths] ${appPaths.describe()}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES && port < desktopConfig.MAX_PORT) {
      return listenOn(port + 1, attempt + 1);
    }
    console.error(`[Server] 监听失败 ${LISTEN_HOST}:${port} -> ${err.code || err.message}`);
    process.exit(1);
  });
}

listenOn(PORT);

/**
 * AI-GAL 桌面版 — Electron 外壳
 *
 * 设计要点
 * --------
 * 1. **服务端仍是原来的 Express 应用**，由随包的便携版 Node 22（runtime\node.exe）
 *    作为 sidecar 子进程运行。这样 better-sqlite3 的原生 ABI 与打包时完全一致，
 *    既不需要 electron-rebuild，也不必把业务代码改成 Electron 模块 —— 改动面最小。
 * 2. Electron 只负责「窗口 + 托盘 + 生命周期」，通过 http://127.0.0.1:<port> 加载界面。
 *    界面代码一行都不用改（前端本来就用同源相对路径）。
 * 3. 可写数据放在 %APPDATA%\AI-GAL（经 AI_GAL_DATA_DIR 注入），所以程序可以装在
 *    Program Files 或用户自选的任意目录，都不影响数据库 / 存档 / 上传写入。
 * 4. 端口：读 desktop-config.json → 若被占用则自动另选并回写；实际端口以子进程
 *    打印的 `[Server] PORT=n` 为准（避免「先探测后被抢」的竞态）。
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// ── 单实例：第二个实例只把已有窗口唤到前台，避免两个服务抢同一个 SQLite ──────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

function main() {
  // ── 路径 ────────────────────────────────────────────────────────────────
  const IS_PACKAGED = app.isPackaged;
  /** 随包的业务负载目录：开发时是仓库根，打包后是 resources/app-payload */
  const PAYLOAD_ROOT = IS_PACKAGED
    ? path.join(process.resourcesPath, 'app-payload')
    : path.join(__dirname, '..');

  // 数据目录必须在 require paths.js 之前注入环境变量
  const DATA_ROOT = path.join(app.getPath('appData'), 'AI-GAL');
  process.env.AI_GAL_DATA_DIR = DATA_ROOT;

  // Electron 自身的缓存（Cookies / Local Storage / GPUCache）单独放子目录，
  // 免得和用户的存档、数据库、配置混在同一个文件夹里。
  try { app.setPath('userData', path.join(DATA_ROOT, 'runtime')); } catch { /* 忽略 */ }

  const desktopConfig = require(path.join(PAYLOAD_ROOT, 'server', 'desktop-config.js'));
  const appPaths = require(path.join(PAYLOAD_ROOT, 'server', 'paths.js'));

  const NODE_EXE = path.join(PAYLOAD_ROOT, 'runtime', 'node.exe');
  const SERVER_ENTRY = path.join(PAYLOAD_ROOT, 'server', 'index.js');
  const LOG_DIR = path.join(DATA_ROOT, 'logs');
  const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
  const ICON_PNG = path.join(PAYLOAD_ROOT, 'public', 'logo.png');

  const APP_NAME = 'AI-GAL';
  const WINDOW_TITLE = `${APP_NAME} — AI 视觉小说引擎`;

  let win = null;
  let settingsWin = null;
  let tray = null;
  let child = null;
  let actualPort = null;
  let quitting = false;

  // ── 日志（便于售后排查「打不开 / 存档在哪」）──────────────────────────────
  function writeLog(text) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      try {
        if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0); // 超过 2MB 清空
      } catch { /* 文件不存在 */ }
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}`);
    } catch { /* 日志失败不影响运行 */ }
  }

  // ── 端口 ────────────────────────────────────────────────────────────────
  function isPortFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
  }

  async function pickFreePort(desired) {
    for (let p = desired; p < desired + 20 && p <= desktopConfig.MAX_PORT; p++) {
      if (await isPortFree(p)) return p;
    }
    return desired; // 全部占用时交给服务端自行兜底（它会再找）
  }

  // ── sidecar 子进程 ──────────────────────────────────────────────────────
  function spawnServer(port) {
    if (!fs.existsSync(NODE_EXE)) {
      fatal('内置 Node 运行时缺失', `找不到：${NODE_EXE}\n安装包可能不完整，请重新安装。`);
      return;
    }
    if (!fs.existsSync(SERVER_ENTRY)) {
      fatal('程序文件缺失', `找不到：${SERVER_ENTRY}\n安装包可能不完整，请重新安装。`);
      return;
    }

    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AI_GAL_DATA_DIR: DATA_ROOT };
    delete env.ELECTRON_RUN_AS_NODE; // 不要污染子进程

    child = spawn(NODE_EXE, [SERVER_ENTRY], {
      cwd: PAYLOAD_ROOT,
      env,
      windowsHide: true,
      // 第 4 个 'ipc' 通道：外壳被杀时子进程会收到 disconnect，从而自我了断，
      // 不会留下孤儿 node 占住端口（见 server/index.js 的 disconnect 处理）
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout.on('data', (b) => {
      const s = b.toString();
      writeLog(s);
      process.stdout.write(s);
      const m = /\[Server\] PORT=(\d+)/.exec(s);
      if (m && !actualPort) {
        actualPort = Number(m[1]);
        if (actualPort !== port) desktopConfig.writeConfig({ port: actualPort });
      }
    });

    child.stderr.on('data', (b) => {
      const s = b.toString();
      writeLog(s);
      process.stderr.write(s);
    });

    child.on('exit', (code, signal) => {
      child = null;
      if (quitting) return;
      writeLog(`[desktop] server exited code=${code} signal=${signal}\n`);
      if (code !== 0) {
        dialog.showErrorBox('AI-GAL 服务已退出',
          `后台服务异常退出（code=${code}）。\n\n日志：${LOG_FILE}\n数据目录：${DATA_ROOT}`);
      }
    });
  }

  function killServer() {
    return new Promise((resolve) => {
      if (!child || !child.pid) return resolve();
      const pid = child.pid;
      try {
        // /T 连带子进程，避免留下孤儿 node
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
          .on('exit', () => resolve())
          .on('error', () => { try { child.kill('SIGKILL'); } catch {} resolve(); });
      } catch {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }
    });
  }

  function waitForHealth(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          retry();
        });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
      };
      const retry = () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  // ── 窗口 ────────────────────────────────────────────────────────────────
  function createWindow(port) {
    const icon = fs.existsSync(ICON_PNG) ? nativeImage.createFromPath(ICON_PNG) : undefined;
    win = new BrowserWindow({
      width: 1280,
      height: 832,
      minWidth: 1024,
      minHeight: 680,
      title: WINDOW_TITLE,
      backgroundColor: '#111318',
      icon,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });

    win.once('ready-to-show', () => win.show());
    win.loadURL(`http://127.0.0.1:${port}/`);

    // 站内链接留在窗口内；外部链接交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('http://127.0.0.1')) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(`http://127.0.0.1:${port}`)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });

    // 无菜单栏，但保留排查用的快捷键
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      if (ctrl && input.key.toLowerCase() === 'r') { e.preventDefault(); win.webContents.reload(); }
      if (ctrl && input.shift && input.key.toLowerCase() === 'i') { e.preventDefault(); win.webContents.toggleDevTools(); }
      if (input.key === 'F12') { e.preventDefault(); win.webContents.toggleDevTools(); }
    });

    win.on('closed', () => { win = null; });
  }

  // ── 端口设置窗口 ────────────────────────────────────────────────────────
  function openSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
    settingsWin = new BrowserWindow({
      width: 460,
      height: 340,
      resizable: false,
      title: '端口设置',
      parent: win || undefined,
      modal: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload-settings.js'),
      },
    });
    settingsWin.setMenuBarVisibility(false);
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  ipcMain.handle('settings:get', () => ({
    port: actualPort || desktopConfig.resolveDesiredPort(),
    dataRoot: DATA_ROOT,
    configPath: desktopConfig.CONFIG_PATH,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save-port', async (_e, rawPort) => {
    const port = Number(rawPort);
    if (!desktopConfig.isValidPort(port)) {
      return { ok: false, message: `端口需为 ${desktopConfig.MIN_PORT}~${desktopConfig.MAX_PORT} 之间的整数` };
    }
    desktopConfig.writeConfig({ port });
    await restartServer();
    return { ok: true, port: actualPort, message: `已切换到端口 ${actualPort}` };
  });

  ipcMain.handle('settings:open-data-folder', () => { shell.openPath(DATA_ROOT); return true; });

  // ── 托盘 ────────────────────────────────────────────────────────────────
  function createTray() {
    if (!fs.existsSync(ICON_PNG)) return;
    try {
      tray = new Tray(nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 }));
    } catch { return; }
    tray.setToolTip(WINDOW_TITLE);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: '端口设置…', click: openSettingsWindow },
      { label: '打开数据文件夹（存档 / 配置）', click: () => shell.openPath(DATA_ROOT) },
      { label: '打开程序文件夹', click: () => shell.openPath(PAYLOAD_ROOT) },
      { type: 'separator' },
      { label: `版本 ${app.getVersion()}`, enabled: false },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  }

  // ── 启动编排 ────────────────────────────────────────────────────────────
  async function startServer() {
    const desired = desktopConfig.resolveDesiredPort();
    const port = await pickFreePort(desired);
    if (port !== desired) {
      writeLog(`[desktop] port ${desired} busy, using ${port}\n`);
      desktopConfig.writeConfig({ port });
    }
    actualPort = null;
    spawnServer(port);
    // 以子进程自报的端口为准，等它出现；同时用健康检查兜底
    const ready = await waitForHealth(port, 40000);
    if (!ready) {
      fatal('服务启动超时',
        `等待 http://127.0.0.1:${port} 就绪超过 40 秒。\n\n日志：${LOG_FILE}`);
      return port;
    }
    return actualPort || port;
  }

  async function restartServer() {
    quitting = false;
    await killServer();
    await new Promise((r) => setTimeout(r, 600));
    const port = await startServer();
    if (win && !win.isDestroyed()) win.loadURL(`http://127.0.0.1:${port}/`);
    return port;
  }

  function fatal(title, detail) {
    writeLog(`[desktop] FATAL ${title}: ${detail}\n`);
    dialog.showErrorBox(title, detail);
    quitting = true;
    app.quit();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.on('window-all-closed', () => { quitting = true; app.quit(); });

  app.on('before-quit', async (e) => {
    quitting = true;
    if (child) {
      e.preventDefault();
      await killServer();
      app.quit();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    writeLog(`[desktop] start v${app.getVersion()} packaged=${IS_PACKAGED}\n[desktop] ${appPaths.describe()}\n`);
    const port = await startServer();
    createWindow(port);
    createTray();
  });
}

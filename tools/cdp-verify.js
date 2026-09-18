/**
 * .probe-tmp/cdp-verify.js — 用 headless Chrome + CDP（Node 内置 WebSocket）做交互验收
 *   1) 打开真实外壳页面
 *   2) 注入两条旧前端调试卡片（含思维链 + 完整输出）
 *   3) 点「幕后控制台」→ 点第 1 条 → 断言详情弹窗可见、含思维链、正文完整
 *   4) 顺带读 BGM 开关的真实初始状态
 *   5) 截图 + 打印 JSON 证据
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requireBrowser } = require('./browser');

const CHROME = requireBrowser();

const URL_APP = process.argv[2] || 'http://127.0.0.1:3215/?theme=dark&fs=1';
const OUT = process.argv[3] || path.join(__dirname, '..', '.probe-tmp', 'cdp-conmodal.png');
const PORT = 9333;

const profile = path.join(__dirname, 'cdp-profile');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1600,1000',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { return await httpJson(`http://127.0.0.1:${PORT}/json/version`); } catch (e) { await sleep(250); }
  }
  throw new Error('Chrome 调试端口没起来');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 20000);
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

(async () => {
  const evidence = {};
  try {
    await waitChrome();
    const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    // 先写 localStorage：模拟「上次开着 BGM」的用户（旧代码就是在这条路径上把开关点亮成开启的）
    await cdp.send('Page.navigate', { url: URL_APP.replace(/\/\?.*$/, '/') });
    await sleep(700);
    await cdp.eval("try{localStorage.setItem('rp-bgm-enabled','1');localStorage.setItem('rp-bgm-mood','nomal');}catch(e){} true");
    await cdp.send('Page.navigate', { url: URL_APP });

    // 等外壳就绪（控制台按钮出现且外壳已接管）
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const ok = await cdp.eval("!!document.getElementById('btnConsole') && !!document.querySelector('.app.narr, .app')").catch(() => false);
      if (ok) break;
    }
    await sleep(2600); // 外壳 boot 的 2.2s 定时器 + 余量

    evidence.shell = await cdp.eval(`(function(){
      var app = document.querySelector('.app');
      return { shell: !!app, cls: app ? app.className : '', legacy: document.documentElement.className,
               conItems: document.querySelectorAll('.con-item').length,
               hasConModal: !!document.getElementById('conModal'),
               bgmIcon: (document.getElementById('audioIcon')||{}).textContent,
               bgmBtn: (document.getElementById('btnToggleAudio')||{}).className,
               bgmState: (typeof BGM_STATE !== 'undefined' && BGM_STATE) ? { en: BGM_STATE.enabled, playing: BGM_STATE.isPlaying, el: !!BGM_STATE.audioEl } : 'n/a',
               viz: (document.getElementById('audioVisualizer')||{}).className };
    })()`);

    // 注入两条假调试卡片（结构与 app.js 的 renderDebugCard 一致）
    await cdp.eval(`(function(){
      document.getElementById('debugMainAgentContent').innerHTML = '<div class="debug-card" id="dbg-1">' +
        '<div class="debug-card-header" onclick="toggleDebugCard(\\'dbg-1\\')"><span class="debug-card-arrow">&#9654;</span>' +
        '<span class="debug-card-round">第3轮</span><span class="debug-card-summary">主Agent 输出（验收假数据）</span>' +
        '<span class="debug-card-time">12:34:56</span></div>' +
        '<div class="debug-card-body" style="display:none">' +
        '<div class="debug-section-title" style="color:#f0a040">思维链 (Chain-of-Thought)</div>' +
        '<pre class="debug-pre">1. 先确认场景在观星台，风停、无云。\\n2. 让示例角色丙克制地开口，不要一次把心事说完。\\n3. 把「星图」作为伏笔埋进对白，等下一轮再点破。</pre>' +
        '<div class="debug-section-title">完整输出</div>' +
        '<pre>### mood=quiet\\n### story\\n风停了。雪线以上没有云。\\n### dialog\\n示例角色丙：「……你把我叫到这种地方。」</pre>' +
        '</div></div>';
      document.getElementById('debugButlerContent').innerHTML = '<div class="debug-card" id="dbg-2">' +
        '<div class="debug-card-header" onclick="toggleDebugCard(\\'dbg-2\\')"><span class="debug-card-arrow">&#9654;</span>' +
        '<span class="debug-card-round">第3轮</span><span class="debug-card-summary">管家AI 处理记录（验收假数据）</span>' +
        '<span class="debug-card-time">12:34:57</span></div>' +
        '<div class="debug-card-body" style="display:none">' +
        '<div class="debug-section-title" style="color:#a0f040">管家AI 思维链</div>' +
        '<pre class="debug-pre">判定：示例角色丙在本存档首次登场（子存档无头像 / 总存档有头像）→ 复制头像 + 出半身登场 CG。</pre>' +
        '</div></div>';
      return true;
    })()`);

    // 点「幕后控制台」（点 console 图标按钮）
    const opened = await cdp.eval(`(function(){
      var b = document.getElementById('btnConsole'); if (!b) return 'no-btn';
      b.click(); return 'clicked';
    })()`);
    await sleep(900);
    evidence.afterConsole = await cdp.eval(`(function(){
      return { items: document.querySelectorAll('.con-item').length,
               agentItems: document.querySelectorAll('#logAgent .con-item').length,
               sheet: (function(){ var s=document.getElementById('sheetConsole'); return s? s.className : null; })(),
               firstLine: (function(){ var l=document.querySelector('#logAgent .con-item .con-line'); return l? l.textContent.replace(/\\s+/g,' ').trim().slice(0,90) : null; })() };
    })()`);

    // 点第一条 → 应弹窗
    await cdp.eval(`(function(){
      var l = document.querySelector('#logAgent .con-item .con-line'); if (!l) return 'no-line';
      l.click(); return 'clicked';
    })()`);
    await sleep(500);

    evidence.conModal = await cdp.eval(`(function(){
      var m = document.getElementById('conModal'); if (!m) return 'missing';
      var body = document.getElementById('conModalBody');
      var pres = m.querySelectorAll('pre');
      var panel = m.querySelector('.cm-panel');
      var pcs = panel ? getComputedStyle(panel) : null;
      var bodyTxt = body ? String(body.innerText||'') : '';
      var mcs = getComputedStyle(m);
      return {
        open: m.classList.contains('on'),
        display: mcs.display,
        zIndex: mcs.zIndex,
        kind: (document.getElementById('conModalKind')||{}).textContent,
        title: (document.getElementById('conModalTitle')||{}).textContent,
        time: (document.getElementById('conModalTime')||{}).textContent,
        bodyChars: bodyTxt.length,
        preCount: pres.length,
        hasCoT: /思维链|Chain-of-Thought/.test(bodyTxt),
        hasFullOutput: /完整输出/.test(bodyTxt) || bodyTxt.indexOf('### dialog') >= 0,
        preVisible: pres.length ? getComputedStyle(pres[0]).display !== 'none' : false,
        panelRadius: pcs ? pcs.borderRadius : '',
        panelBg: pcs ? pcs.backgroundColor : '',
        preBg: pres.length ? getComputedStyle(pres[0]).backgroundColor : '',
        scrollable: body ? body.scrollHeight > body.clientHeight : false
      };
    })()`);

    // Esc 关闭再验一次
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    evidence.afterEsc = await cdp.eval("document.getElementById('conModal').classList.contains('on')");

    // 再打开一次用于截图
    await cdp.eval("document.querySelector('#logAgent .con-item .con-line').click(); true");
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    evidence.screenshot = OUT;

    console.log(JSON.stringify(evidence, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message), evidence }, null, 2));
    process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch (e) { /* noop */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }
})();

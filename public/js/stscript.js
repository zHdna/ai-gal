/*
 * STScript — SillyTavern 脚本语言兼容引擎 (Phase 0 + Phase 1)
 * --------------------------------------------------------------------------
 * 解析与执行全在浏览器端，贴近 UI 与既有发送流。
 * 变量持久化走 ScriptVarsAPI（后端 script-vars 路由）：
 *   local  -> conversation 级（随对话存档）
 *   global -> user 级（多用户隔离）
 *   scoped -> 闭包运行时栈（不持久化）
 * Phase 2 (LLM 命令 /gen /trigger /regenerate /continue /swipe /ask) 与 Phase 3 (消息命令
 * /send /sendas /sys /comment /hide /unhide /cut /del /messages) 通过 global.AppScript 桥接
 * 复用既有 ChatAPI.stream / MessageAPI，不重造管线。
 * Phase 4 (提示词注入 / 作者备注 /inject /listinjects /flushinjects /note /interval /depth
 * /position /parser-flag) 通过 global.AppScript.inject 等桥接落库 conversations 表
 * (script_injects / author_note / script_inject_state)，并由 chat.js 的 buildSystemPrompt /
 * buildApiMessages 消费。
 * Phase 5 (世界书命令 /getchatbook /findentry /getentryfield /setentryfield /createentry)
 * 通过 global.AppScript.getChatBook 等桥接操作 characters.character_book，复用既有 world book
 * 关键词注入链路（并修复"仅扫描 AI 输出导致用户关键词不触发"的链路断裂）。
 * Phase 6 角色/UI/扩展命令完整实现：
 *   角色：/roll /char-get /char-update /imagine /go /random /char-delete
 *   UI  ：/bubble /flat /single /bg /panels /lockbg /unlockbg
 *   扩展：/websearch /help
 * 通过 global.AppScript 桥接角色 CRUD、生图触发、UI 态切换、免 key 联网搜索；
 * 骰子为纯前端解析，/websearch 走后端 /api/script/websearch（DuckDuckGo 免 key 抓取）。
 * 本期实现：变量 / 宏 / 数学 / 流程控制 / I/O / 闭包 / LLM 命令 / 消息读写命令 / 提示词注入 / 世界书 / 角色·UI·扩展。
 *
 * 暴露全局对象：window.STScript
 *   STScript.run(scriptText, { conversationId, userId }) -> Promise<{ ok, unknown, message }>
 *   STScript.expandMacros(text, ctx?) -> string   （供脚本上下文展开变量宏）
 */
(function (global) {
  'use strict';

  // ===================== 工具 =====================

  function isNumeric(s) {
    if (s === null || s === undefined || s === '') return false;
    if (typeof s === 'number') return !isNaN(s);
    return /^-?\d+(\.\d+)?$/.test(String(s).trim());
  }

  function toNum(s) {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function isTruthy(s) {
    if (s === null || s === undefined) return false;
    if (typeof s === 'boolean') return s;
    const t = String(s).trim().toLowerCase();
    return !(t === '' || t === 'false' || t === '0' || t === 'null' || t === 'undefined');
  }

  // 解析变量命令参数：支持 `name=value` 与 `name value` 两种形式
  function parseKV(args) {
    const raw = args[0] || '';
    if (raw.includes('=')) {
      const idx = raw.indexOf('=');
      const name = raw.slice(0, idx);
      const restAfter = raw.slice(idx + 1);
      const tail = args.slice(1).join(' ');
      return { name, value: tail ? restAfter + ' ' + tail : restAfter };
    }
    return { name: raw, value: args.slice(1).join(' ') };
  }

  function showToastSafe(text, severity) {    if (typeof global.showToast === 'function') {
      global.showToast(text, severity || 'info');
    } else {
      console.log('[STScript:' + (severity || 'info') + '] ' + text);
    }
  }

  // MVU 世界状态路径工具（setvar/getvar 用，自包含，不依赖 app.js）
  function wsSplitPathLocal(path) {
    if (!path || path[0] !== '/') throw new Error('路径需以 / 开头');
    return path.slice(1).split('/').map(t => decodeURIComponent(t.replace(/~1/g, '/').replace(/~0/g, '~')));
  }
  function applyPatchToModel(model, patch) {
    const next = (model && typeof model === 'object') ? JSON.parse(JSON.stringify(model)) : {};
    const p = wsSplitPathLocal(patch.path);
    const parent = p.slice(0, -1);
    const key = p[p.length - 1];
    let cur = next;
    for (const t of parent) { if (cur[t] == null || typeof cur[t] !== 'object') cur[t] = /^\d+$/.test(t) ? [] : {}; cur = cur[t]; }
    if (Array.isArray(cur)) { const i = key === '-' ? cur.length : parseInt(key, 10); cur.splice(i, 0, patch.value); }
    else cur[key] = patch.value;
    return next;
  }
  function readPathFromModel(model, path) {
    const tokens = wsSplitPathLocal(path);
    let cur = model;
    for (const t of tokens) { if (cur == null) return undefined; cur = cur[t]; }
    return cur;
  }

  // STscript 命令帮助注册表（供 /help 输出；保持与实际实现同步）
  const COMMAND_HELP = {
    'roll': '/roll [骰子表达式] — 掷骰子（如 /roll 2d6+3）',
    'char-get': '/char-get <字段> — 读取当前角色字段',
    'char-update': '/char-update <字段> <值> — 更新当前角色字段',
    'char-delete': '/char-delete <名称> — 删除角色（精确→前缀→子串模糊匹配）',
    'imagine': '/imagine <提示词> — 触发 AI 生图',
    'go': '/go <角色名> — 切换到指定角色（模糊匹配）',
    'random': '/random — 随机切换到一个角色聊天',
    'bubble': '/bubble — 聊天样式：气泡 + 侧边立绘（默认）',
    'flat': '/flat — 聊天样式：去气泡边框的纯文本段落',
    'single': '/single — 聊天样式：单栏模式（隐藏立绘）',
    'bg': '/bg <url|none|default> — 设置聊天背景',
    'panels': '/panels [on|off] — 切换顶栏/侧栏/调试抽屉显隐',
    'lockbg': '/lockbg — 锁定当前背景（禁止 /bg 修改）',
    'unlockbg': '/unlockbg — 解锁背景',
    'websearch': '/websearch <查询> — 联网搜索（免 key，返回结果文本）',
    'setvar': '/setvar <path> <value> — 设置 MVU 世界状态变量（path 如 /contact/艾玛/relationship/affection）',
    'getvar': '/getvar <path> — 读取 MVU 世界状态变量（返回当前值）',
    'help': '/help [命令] — 显示帮助',
  };

  // ===================== 词法：脚本切分为命令段 =====================
  // 处理：| 管道 / || 断管 / 注释(// /# /* */) / 引号 / 转义
  // 返回: [{ text, pipe: 'none'|'pipe'|'breakpipe' }]

  function tokenizeScript(src) {
    const segments = [];
    let cur = '';
    let i = 0;
    let inComment = false;
    let inStr = false;
    let strQ = '';
    let blockDepth = 0; // {: :} 嵌套深度：块内不按换行/管道切分

    const flush = (pipe) => {
      if (cur.trim() !== '') segments.push({ text: cur, pipe: pipe || 'none' });
      cur = '';
    };

    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];

      if (inComment) {
        if (c === '\n') {
          inComment = false;
          if (blockDepth === 0) flush('none');
          else cur += '\n';
        }
        i++; continue;
      }

      if (inStr) {
        cur += c;
        if (c === '\\' && n !== undefined) { cur += n; i += 2; continue; }
        if (c === strQ) inStr = false;
        i++; continue;
      }

      // 引号
      if (c === '"') { inStr = true; strQ = '"'; cur += c; i++; continue; }

      // 转义（必须在管道/注释判定之前）
      if (c === '\\' && n !== undefined) {
        switch (n) {
          case ' ': cur += ' '; break;
          case '|': cur += '|'; break;
          case '"': cur += '"'; break;
          case '{': cur += '{'; break;
          case ':': cur += ':'; break;
          case '\\': cur += '\\'; break;
          default: cur += n;
        }
        i += 2; continue;
      }

      // 行注释 // 或 /#（仅在段首或空白后出现，避免误伤 http://）
      if (c === '/' && (n === '/' || n === '#')) {
        const before = cur.replace(/\s+$/, '');
        if (before === '' || /\s$/.test(cur)) {
          if (blockDepth === 0) flush('none');
          inComment = true;
          i += 2; continue;
        }
        cur += c; i++; continue;
      }

      // 块注释 /* */
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }

      // 闭包开 {:
      if (src.startsWith('{: ', i) || src.startsWith('{:', i)) {
        blockDepth++;
        cur += '{:';
        i += 2; continue;
      }
      // 闭包闭 :}
      if (src.startsWith(':}', i)) {
        if (blockDepth > 0) blockDepth--;
        cur += ':}';
        i += 2; continue;
      }

      // 管道（块内保留为文本）
      if (c === '|') {
        if (blockDepth > 0) { cur += c; i++; continue; }
        if (n === '|') { flush('breakpipe'); i += 2; continue; }
        flush('pipe'); i++; continue;
      }

      // 换行（块内保留为 \n，块外为命令分隔）
      if (c === '\n') {
        if (blockDepth === 0) flush('none');
        else cur += '\n';
        i++; continue;
      }

      cur += c; i++; continue;
    }
    if (cur.trim() !== '') segments.push({ text: cur, pipe: 'none' });
    return segments;
  }

  // ===================== 语法：段 -> 命令树 =====================

  // 在字符串中查找未转义/未加引号的子串 needle（从 from 开始）
  function findUnescaped(src, needle, from) {
    let inStr = false, q = '';
    let i = from;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (inStr) {
        if (c === '\\' && n !== undefined) { i += 2; continue; }
        if (c === q) inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; q = '"'; i++; continue; }
      if (c === '\\') { i += 2; continue; }
      if (src.startsWith(needle, i)) return i;
      i++;
    }
    return -1;
  }

  // 将参数串拆为数组（支持引号与转义）
  function splitArgs(str) {
    const args = [];
    let cur = '';
    let inStr = false, q = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i], n = str[i + 1];
      if (inStr) {
        if (c === '\\' && n !== undefined) { cur += n; i++; continue; }
        if (c === q) { inStr = false; continue; }
        cur += c; continue;
      }
      if (c === '"') { inStr = true; q = '"'; continue; }
      if (c === '\\' && n !== undefined) {
        switch (n) {
          case ' ': cur += ' '; break;
          case '|': cur += '|'; break;
          case '"': cur += '"'; break;
          case '{': cur += '{'; break;
          case ':': cur += ':'; break;
          case '\\': cur += '\\'; break;
          default: cur += n;
        }
        i += 2; continue;
      }
      if (c === ' ' || c === '\t') {
        if (cur !== '') { args.push(cur); cur = ''; }
        continue;
      }
      cur += c;
    }
    if (cur !== '') args.push(cur);
    return args;
  }

  // 解析命令头（名称 + 可选 (params) + 参数）
  function parseHead(head) {
    head = head.trim();
    if (head === '') return { name: '', args: [], params: null };
    const sp = findUnescaped(head, ' ', 0);
    let namePart, rest;
    if (sp === -1) { namePart = head; rest = ''; }
    else { namePart = head.slice(0, sp); rest = head.slice(sp); }

    let name = namePart;
    let params = null;
    const pm = namePart.match(/^([\w\u4e00-\u9fa5]+)\((.*)\)$/);
    if (pm) {
      name = pm[1];
      const inner = pm[2].trim();
      params = inner === '' ? [] : splitArgs(inner);
    }
    const args = splitArgs(rest);
    return { name, args, params };
  }

  // 解析单个段为命令节点（含 {: :} 块与 else / IIFE）
  function parseSegment(text, pipe) {
    const openIdx = findUnescaped(text, '{:', 0);
    if (openIdx === -1) {
      const { name, args, params } = parseHead(text);
      return { name, args, params, closure: null, elseClosure: null, isClosureDef: false, isIIFE: false, pipe: pipe || 'none' };
    }

    const head = text.slice(0, openIdx);
    const afterOpen = openIdx + 2;
    // 找到匹配的 :}（平衡）
    let depth = 1, j = afterOpen, closeIdx = -1;
    while (j < text.length) {
      const c = text[j], n = text[j + 1];
      if (c === '"') {
        // 跳过字符串
        const endQ = text.indexOf('"', j + 1);
        j = endQ === -1 ? text.length : endQ + 1; continue;
      }
      if (c === '\\') { j += 2; continue; }
      if (text.startsWith('{: ', j) || text.startsWith('{:', j)) { depth++; j += 2; continue; }
      if (text.startsWith(':}', j)) { depth--; if (depth === 0) { closeIdx = j; break; } j += 2; continue; }
      j++;
    }
    if (closeIdx === -1) closeIdx = text.length;
    const inner = text.slice(afterOpen, closeIdx);
    const after = text.slice(closeIdx + 2);

    const { name, args, params } = parseHead(head);
    const blockCmds = parseCommands(inner);

    const node = {
      name, args, params,
      closure: blockCmds,
      elseClosure: null,
      isClosureDef: !name.startsWith('/') && name !== '',
      isIIFE: false,
      pipe: pipe || 'none',
    };

    // IIFE: 头为 `()`（匿名闭包）且后面紧跟 `()` 调用
    const afterTrim = after.trim();
    if (node.isClosureDef && name === '' && afterTrim.startsWith('()')) {
      node.isIIFE = true;
    } else if (node.isClosureDef && afterTrim.startsWith('()')) {
      // name {: :}() -> 定义后立即调用
      node.isIIFE = true;
    }

    // else 块
    if (afterTrim.startsWith('else')) {
      let rest = afterTrim.slice(4).trim();
      if (rest.startsWith('{:')) {
        const eInner = rest.slice(2);
        const eClose = findUnescaped(eInner, ':}', 0);
        const eBody = eClose === -1 ? eInner : eInner.slice(0, eClose);
        node.elseClosure = parseCommands(eBody);
      } else if (rest !== '') {
        node.elseClosure = [parseSegment(rest, 'none')];
      }
    }

    return node;
  }

  // 解析整段脚本为命令列表
  function parseCommands(src) {
    const segments = tokenizeScript(src);
    const cmds = [];
    for (const seg of segments) {
      const node = parseSegment(seg.text, seg.pipe);
      // 跳过纯标签 :label
      if (node.name.startsWith(':')) continue;
      cmds.push(node);
    }
    return cmds;
  }

  // ===================== 变量 / 宏 =====================

  function makeVar(value, type) {
    let t = type;
    if (!t) t = isNumeric(value) ? 'number' : 'string';
    return { value: value === undefined || value === null ? '' : String(value), type: t };
  }

  function getLocal(ctx, name) {
    const v = ctx.local.get(name);
    return v ? v.value : '';
  }
  function getGlobal(ctx, name) {
    const v = ctx.global.get(name);
    return v ? v.value : '';
  }
  function getScoped(ctx, name) {
    for (let k = ctx.scopedStack.length - 1; k >= 0; k--) {
      if (ctx.scopedStack[k].has(name)) return ctx.scopedStack[k].get(name).value;
    }
    return undefined;
  }

  async function setLocal(ctx, name, value, type) {
    ctx.local.set(name, makeVar(value, type));
    await persistVar('local', ctx, name, String(value), type || (isNumeric(value) ? 'number' : 'string'));
  }
  async function setGlobal(ctx, name, value, type) {
    ctx.global.set(name, makeVar(value, type));
    await persistVar('global', ctx, name, String(value), type || (isNumeric(value) ? 'number' : 'string'));
  }
  async function setScoped(ctx, name, value, type) {
    const top = ctx.scopedStack[ctx.scopedStack.length - 1];
    top.set(name, makeVar(value, type));
  }

  async function persistVar(scope, ctx, name, value, type) {
    if (typeof global.ScriptVarsAPI === 'undefined') return;
    try {
      const owner = scope === 'global' ? ctx.userId : ctx.conversationId;
      if (!owner) return;
      await global.ScriptVarsAPI.set(scope, owner, name, value, type);
    } catch (e) {
      console.warn('[STScript] persist failed:', e && e.message);
    }
  }

  // 宏展开：数字 -> local -> global -> 字面字符串
  function expandMacros(text, ctx) {
    if (!text || typeof text !== 'string') return text;

    const RESERVED = new Set(['user', 'char', '用户', '角色', 'pipe', 'getvar', 'getglobalvar', 'setvar', 'addvar', 'incvar', 'decvar', 'var']);

    const resolve = (fullMatch, macroName, inner) => {
      const lc = macroName.toLowerCase();
      const name = (inner || '').trim();
      switch (lc) {
        case 'pipe':
          return ctx ? (ctx.pipe || '') : '';
        case 'getvar': {
          if (isNumeric(name)) return name;
          if (ctx && ctx.local.has(name)) return ctx.local.get(name).value;
          if (ctx && ctx.global.has(name)) return ctx.global.get(name).value;
          return name; // 字面字符串
        }
        case 'var': {
          if (isNumeric(name)) return name;
          if (ctx) {
            const sc = getScoped(ctx, name);
            if (sc !== undefined) return sc;
            if (ctx.local.has(name)) return ctx.local.get(name).value;
            if (ctx.global.has(name)) return ctx.global.get(name).value;
          }
          return name;
        }
        case 'getglobalvar': {
          if (isNumeric(name)) return name;
          if (ctx && ctx.global.has(name)) return ctx.global.get(name).value;
          if (ctx && ctx.local.has(name)) return ctx.local.get(name).value;
          return name;
        }
        case 'setvar': {
          const parts = name.split('::');
          const v = parts.slice(1).join('::');
          if (ctx) ctx.local.set(parts[0], makeVar(v));
          return v;
        }
        case 'addvar': {
          const parts = name.split('::');
          const cur = ctx && ctx.local.has(parts[0]) ? ctx.local.get(parts[0]).value : '';
          const v = cur + parts.slice(1).join('::');
          if (ctx) ctx.local.set(parts[0], makeVar(v));
          return v;
        }
        case 'incvar': {
          const cur = ctx && ctx.local.has(name) ? toNum(ctx.local.get(name).value) : 0;
          const v = String(cur + 1);
          if (ctx) ctx.local.set(name, makeVar(v, 'number'));
          return v;
        }
        case 'decvar': {
          const cur = ctx && ctx.local.has(name) ? toNum(ctx.local.get(name).value) : 0;
          const v = String(cur - 1);
          if (ctx) ctx.local.set(name, makeVar(v, 'number'));
          return v;
        }
        default: {
          // 裸 {{name}} 变量查找（scoped -> local -> global -> 字面）
          if (RESERVED.has(lc)) return fullMatch; // 保留宏（user/char 等）原样保留，交 replaceMacros
          if (ctx) {
            const sc = getScoped(ctx, macroName);
            if (sc !== undefined) return sc;
            if (ctx.local.has(macroName)) return ctx.local.get(macroName).value;
            if (ctx.global.has(macroName)) return ctx.global.get(macroName).value;
          }
          return fullMatch; // 字面字符串
        }
      }
    };

    // {{ name::rest }} 与 {{ pipe }}
    return text.replace(/\{\{\s*([a-zA-Z]+)\s*(?:::\s*([\s\S]*?))?\s*\}\}/g, (m, macro, inner) => {
      return resolve(m, macro, inner || '');
    });
  }

  // ===================== 流程控制 / 数学 =====================

  const MATH_OPS = {
    add: (a, b) => toNum(a) + toNum(b),
    sub: (a, b) => toNum(a) - toNum(b),
    mul: (a, b) => toNum(a) * toNum(b),
    div: (a, b) => { const d = toNum(b); return d === 0 ? 0 : toNum(a) / d; },
    mod: (a, b) => { const d = toNum(b); return d === 0 ? 0 : toNum(a) % d; },
    pow: (a, b) => Math.pow(toNum(a), toNum(b)),
    sin: (a) => Math.sin(toNum(a)),
    cos: (a) => Math.cos(toNum(a)),
    log: (a) => Math.log(toNum(a)),
    abs: (a) => Math.abs(toNum(a)),
    sqrt: (a) => Math.sqrt(toNum(a)),
    round: (a) => Math.round(toNum(a)),
    rand: (a, b) => {
      const lo = toNum(a), hi = toNum(b);
      if (hi < lo) return Math.random() * (lo - hi) + hi;
      return Math.random() * (hi - lo) + lo;
    },
    max: (a, b) => Math.max(toNum(a), toNum(b)),
    min: (a, b) => Math.min(toNum(a), toNum(b)),
  };

  function fmtNum(n) {
    if (!isFinite(n)) return '0';
    // 去掉浮点噪声
    const r = Math.round(n * 1e10) / 1e10;
    return String(r);
  }

  // 比较规则: a op b
  function evalRule(rule, ctx) {
    rule = expandMacros(rule, ctx); // 每次求值都重新展开宏（while/if 条件随时间变化）
    const parts = splitArgs(rule);
    if (parts.length === 0) return false;
    if (parts[0].toLowerCase() === 'not') {
      const rest = parts.slice(1).join(' ');
      return rest === '' ? false : !isTruthy(rest);
    }
    if (parts.length < 3) {
      // 单值：判断真值
      return isTruthy(parts.join(' '));
    }
    const a = parts[0], op = parts[1].toLowerCase(), b = parts.slice(2).join(' ');
    if (isNumeric(a) && isNumeric(b)) {
      const na = toNum(a), nb = toNum(b);
      switch (op) {
        case 'eq': return na === nb;
        case 'neq': return na !== nb;
        case 'lt': return na < nb;
        case 'gt': return na > nb;
        case 'lte': return na <= nb;
        case 'gte': return na >= nb;
        default: break;
      }
    }
    const sa = a, sb = b;
    switch (op) {
      case 'eq': return sa === sb;
      case 'neq': return sa !== sb;
      case 'lt': return sa < sb;
      case 'gt': return sa > sb;
      case 'lte': return sa <= sb;
      case 'gte': return sa >= sb;
      case 'in': return sb.includes(sa);
      case 'nin': return !sb.includes(sa);
      default: return false;
    }
  }

  // ===================== 执行器 =====================

  async function executeList(commands, ctx) {
    let prevPipeType = 'none';
    for (let idx = 0; idx < commands.length; idx++) {
      if (ctx.abortFlag) return;
      const cmd = commands[idx];

      // 管道值作为下一命令首参（仅普通 pipe）
      let args = cmd.args.slice();
      if (prevPipeType === 'pipe' && ctx.pipe !== null && ctx.pipe !== undefined) {
        args = [ctx.pipe, ...args];
      }
      // 宏展开
      args = args.map(a => expandMacros(a, ctx));

      const output = await execCommand(cmd, args, ctx);

      // 设置 pipe 输出
      if (cmd.pipe === 'pipe') {
        ctx.pipe = output == null ? '' : String(output);
      } else if (cmd.pipe === 'breakpipe') {
        ctx.pipe = null;
      } else {
        ctx.pipe = output == null ? '' : String(output);
      }
      prevPipeType = cmd.pipe;

      if (ctx.abortFlag) return;
    }
  }

  async function execCommand(cmd, args, ctx) {
    const rawName = cmd.name;

    // 闭包定义（非 / 开头，且带 {: :} 块）
    if (cmd.isClosureDef && cmd.closure) {
      ctx.closures.set(rawName, { params: cmd.params || [], body: cmd.closure });
      if (cmd.isIIFE) {
        return await invokeClosure(rawName, cmd.params || [], ctx);
      }
      return '';
    }

    // 非斜杠命令：闭包调用 / 标签 / 未知
    if (!rawName.startsWith('/')) {
      if (rawName.startsWith(':')) return ''; // 标签
      if (ctx.closures.has(rawName)) {
        const actual = cmd.params || args;
        return await invokeClosure(rawName, actual, ctx);
      }
      ctx.unknown = true;
      ctx.unknownMsg = '未支持指令: ' + (rawName || '(空)');
      showToastSafe('未支持指令: ' + (rawName || '(空)'), 'warning');
      return '';
    }

    const name = rawName.slice(1).toLowerCase();
    ctx.lastOutput = '';

    switch (name) {
      // ---------- 变量 ----------
      case 'setvar': {
        const { name, value } = parseKV(args);
        await setLocal(ctx, name, value);
        return value;
      }
      case 'getvar': {
        const v = getLocal(ctx, args[0]);
        showToastSafe(args[0] + ' = ' + v, 'info');
        return v;
      }
      case 'addvar': {
        const { name, value } = parseKV(args);
        const cur = getLocal(ctx, name);
        const nv = isNumeric(cur) && isNumeric(value) ? String(toNum(cur) + toNum(value)) : (cur + value);
        await setLocal(ctx, name, nv, isNumeric(nv) ? 'number' : 'string');
        return nv;
      }
      case 'incvar': {
        const cur = toNum(getLocal(ctx, args[0]));
        const nv = String(cur + 1);
        await setLocal(ctx, args[0], nv, 'number');
        return nv;
      }
      case 'decvar': {
        const cur = toNum(getLocal(ctx, args[0]));
        const nv = String(cur - 1);
        await setLocal(ctx, args[0], nv, 'number');
        return nv;
      }
      case 'flushvar': {
        ctx.local.clear();
        if (typeof global.ScriptVarsAPI !== 'undefined' && ctx.conversationId) {
          try { await global.ScriptVarsAPI.remove('local', ctx.conversationId); } catch {}
        }
        showToastSafe('已清空本地变量', 'info');
        return '';
      }
      // global 变体
      case 'setglobalvar': {
        const { name, value } = parseKV(args);
        await setGlobal(ctx, name, value);
        return value;
      }
      case 'getglobalvar': {
        const v = getGlobal(ctx, args[0]);
        showToastSafe('[global] ' + args[0] + ' = ' + v, 'info');
        return v;
      }
      case 'addglobalvar': {
        const { name, value } = parseKV(args);
        const cur = getGlobal(ctx, name);
        const nv = isNumeric(cur) && isNumeric(value) ? String(toNum(cur) + toNum(value)) : (cur + value);
        await setGlobal(ctx, name, nv, isNumeric(nv) ? 'number' : 'string');
        return nv;
      }
      case 'incglobalvar': {
        const cur = toNum(getGlobal(ctx, args[0]));
        const nv = String(cur + 1);
        await setGlobal(ctx, args[0], nv, 'number');
        return nv;
      }
      case 'decglobalvar': {
        const cur = toNum(getGlobal(ctx, args[0]));
        const nv = String(cur - 1);
        await setGlobal(ctx, args[0], nv, 'number');
        return nv;
      }
      case 'flushglobalvar': {
        ctx.global.clear();
        if (typeof global.ScriptVarsAPI !== 'undefined' && ctx.userId) {
          try { await global.ScriptVarsAPI.remove('global', ctx.userId); } catch {}
        }
        showToastSafe('已清空全局变量', 'info');
        return '';
      }
      // scoped
      case 'let':
      case 'var': {
        const { name, value } = parseKV(args);
        await setScoped(ctx, name, value);
        return value;
      }

      // ---------- 数学 ----------
      case 'add': case 'sub': case 'mul': case 'div':
      case 'mod': case 'pow': case 'max': case 'min': {
        const r = MATH_OPS[name](args[0], args[1]);
        return fmtNum(r);
      }
      case 'sin': case 'cos': case 'log': case 'abs': case 'sqrt': case 'round': {
        const r = MATH_OPS[name](args[0]);
        return fmtNum(r);
      }
      case 'rand': {
        const r = MATH_OPS.rand(args[0], args[1]);
        return fmtNum(r);
      }

      // ---------- 流程控制 ----------
      case 'if': {
        const rule = cmd.args.join(' ');
        const cond = evalRule(rule, ctx);
        if (cond) {
          if (cmd.closure) await executeList(cmd.closure, ctx);
        } else if (cmd.elseClosure) {
          await executeList(cmd.elseClosure, ctx);
        }
        return '';
      }
      case 'while': {
        let guard = 0;
        while (guard < 100) {
          const rule = cmd.args.join(' ');
          if (!evalRule(rule, ctx)) break;
          guard++;
          ctx.breakFlag = false;
          if (cmd.closure) await executeList(cmd.closure, ctx);
          if (ctx.breakFlag) break;
          if (ctx.returnFlag) break;
          if (ctx.abortFlag) return '';
        }
        return '';
      }
      case 'times': {
        let n = parseInt(expandMacros(cmd.args[0] || '0', ctx), 10) || 0;
        n = Math.min(Math.max(n, 0), 100);
        let guard = 0;
        while (guard < n && guard < 100) {
          guard++;
          ctx.breakFlag = false;
          if (cmd.closure) await executeList(cmd.closure, ctx);
          if (ctx.breakFlag) break;
          if (ctx.returnFlag) break;
          if (ctx.abortFlag) return '';
        }
        return '';
      }
      case 'break':
        ctx.breakFlag = true;
        return '';
      case 'abort':
        ctx.abortFlag = true;
        return '';
      case 'return':
        ctx.returnFlag = true;
        return '';

      // ---------- I/O ----------
      case 'echo': {
        let severity = 'info';
        let text = args.join(' ');
        const m = text.match(/\sseverity=(\w+)\s*$/i);
        if (m) { severity = m[1].toLowerCase(); text = text.slice(0, m.index).trim(); }
        const map = { info: 'info', warn: 'warning', warning: 'warning', error: 'error', success: 'success' };
        showToastSafe(text, map[severity] || 'info');
        return text;
      }
      case 'pass':
        return args.join(' ');
      case 'input': {
        const varName = args[0];
        const promptText = args.slice(1).join(' ') || '输入变量 ' + varName;
        let val = '';
        if (typeof global.prompt === 'function') val = global.prompt(promptText, '');
        if (val === null) val = '';
        await setLocal(ctx, varName, val);
        return val;
      }
      case 'popup':
        if (typeof global.alert === 'function') global.alert(args.join(' '));
        return args.join(' ');
      case 'setinput': {
        const inp = global.document && global.document.getElementById('messageInput');
        if (inp) inp.value = args.join(' ');
        return args.join(' ');
      }
      case 'beep': {
        try {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (AC) {
            const ac = new AC();
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            osc.connect(gain); gain.connect(ac.destination);
            osc.frequency.value = 660;
            gain.gain.value = 0.1;
            osc.start();
            setTimeout(() => { osc.stop(); ac.close(); }, 150);
          }
        } catch (e) {}
        return '';
      }
      case 'speak': {
        try {
          if (global.speechSynthesis) {
            const u = new global.SpeechSynthesisUtterance(args.join(' '));
            global.speechSynthesis.speak(u);
          }
        } catch (e) {}
        return args.join(' ');
      }
      case 'buttons': {
        // 简化版：解析 buttonN=标签 与 cmdN=脚本，弹出选择
        const labels = [], cmds = [];
        for (let k = 1; k <= 9; k++) {
          const li = args.findIndex(a => a.startsWith('button' + k + '='));
          const ci = args.findIndex(a => a.startsWith('cmd' + k + '='));
          if (li >= 0) labels.push(args[li].slice(('button' + k + '=').length));
          if (ci >= 0) cmds.push(args[ci].slice(('cmd' + k + '=').length));
        }
        if (typeof global.prompt === 'function' && labels.length) {
          const choice = global.prompt('选择：\n' + labels.map((l, i) => (i + 1) + '. ' + l).join('\n'), '1');
          const idx = parseInt(choice, 10) - 1;
          if (cmds[idx]) await STScript.run(cmds[idx], { conversationId: ctx.conversationId, userId: ctx.userId });
        }
        return '';
      }

      // ---------- LLM 命令 (Phase 2) ----------
      case 'gen':
      case 'genraw':
      case 'trigger':
      case 'regenerate':
      case 'swipe':
      case 'continue':
      case 'ask': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.gen !== 'function') {
          showToastSafe('当前环境不支持 LLM 命令（需在聊天界面运行）', 'warning');
          return '';
        }
        // 解析参数（provider=/as=/name=/instruct=/lock=/stop 等），剩余部分作为内容
        const PARAM_KEYS = ['provider', 'as', 'name', 'instruct', 'lock', 'stop', 'depth', 'position'];
        const params = {};
        const contentArgs = [];
        for (const a of args) {
          const eq = a.indexOf('=');
          const key = eq >= 0 ? a.slice(0, eq) : a;
          if (PARAM_KEYS.includes(key.toLowerCase()) && eq >= 0) params[key.toLowerCase()] = a.slice(eq + 1);
          else contentArgs.push(a);
        }
        let content = contentArgs.join(' ').trim();
        // trigger/regenerate/swipe/continue 复用最近一条用户消息重新生成
        if (name === 'trigger' || name === 'regenerate' || name === 'swipe' || name === 'continue') {
          content = (typeof bridge.getLastUserContent === 'function') ? bridge.getLastUserContent() : '';
        }
        try {
          const result = await bridge.gen(content, { providerId: params.provider || null });
          return result && result.content ? result.content : '';
        } catch (e) {
          showToastSafe('生成失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }

      // ---------- 消息读写命令 (Phase 3) ----------
      case 'send':
      case 'sendas': {
        const bridge = global.AppScript;
        if (!bridge) { showToastSafe('当前环境不支持消息命令', 'warning'); return ''; }
        let content = args.join(' ').trim();
        let role = 'user';
        if (name === 'sendas' && args.length >= 2) {
          // /sendas <角色名> <内容> —— 应用无独立 sendas 角色模型，以 "角色名：内容" 写入用户消息
          const who = args[0];
          content = who + '：' + args.slice(1).join(' ').trim();
        }
        try {
          const r = await bridge.addMessage({ role, content, hidden: 0 });
          showToastSafe('已发送消息', 'info');
          return r && r.id ? r.id : '';
        } catch (e) {
          showToastSafe('发送失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'sys':
      case 'comment': {
        const bridge = global.AppScript;
        if (!bridge) { showToastSafe('当前环境不支持消息命令', 'warning'); return ''; }
        const content = args.join(' ').trim();
        const role = 'user';
        const hidden = (name === 'comment') ? 1 : 0;
        try {
          const r = await bridge.addMessage({ role, content, hidden });
          showToastSafe(name === 'comment' ? '已添加注释（隐藏，不进上下文）' : '已添加系统消息', 'info');
          return r && r.id ? r.id : '';
        } catch (e) {
          showToastSafe('操作失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'hide':
      case 'unhide': {
        const bridge = global.AppScript;
        if (!bridge) { showToastSafe('当前环境不支持消息命令', 'warning'); return ''; }
        const target = args[0] || 'last';
        const doHide = (name === 'hide');
        try {
          const r = await bridge.hideMessage(target, doHide);
          return r && r.id ? r.id : '';
        } catch (e) {
          showToastSafe('操作失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'del': {
        const bridge = global.AppScript;
        if (!bridge) { showToastSafe('当前环境不支持消息命令', 'warning'); return ''; }
        const target = args[0] || 'last';
        try {
          const r = await bridge.deleteMessage(target);
          return r && r.id ? r.id : '';
        } catch (e) {
          showToastSafe('删除失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'cut': {
        const bridge = global.AppScript;
        if (!bridge) { showToastSafe('当前环境不支持消息命令', 'warning'); return ''; }
        const idx = args[0] ? parseInt(args[0], 10) : 0; // 0 = 清空全部
        try {
          const r = await bridge.cutFrom(idx);
          return String(r && r.deleted ? r.deleted : 0);
        } catch (e) {
          showToastSafe('裁剪失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'messages': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.listMessages !== 'function') return '';
        const list = bridge.listMessages();
        const info = list.map(m => `#${m.index} [${m.role}${m.hidden ? ',hidden' : ''}] ${m.content}`).join('\n');
        showToastSafe('消息数: ' + list.length, 'info');
        if (typeof console !== 'undefined') console.log('[STScript /messages]\n' + info);
        return String(list.length);
      }

      // ---------- 提示词注入 / 作者备注命令 (Phase 4) ----------
      case 'inject': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.inject !== 'function') {
          showToastSafe('当前环境不支持注入命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const raw = (args && args.length) ? args.join(' ').trim() : '';
        if (!raw) { showToastSafe('/inject 缺少注入文本', 'error'); return ''; }
        const p = parseInjectParams(raw);
        const state = (bridge.getInjectState && typeof bridge.getInjectState === 'function') ? (await bridge.getInjectState()) : {};
        const role = p.role || state.role || 'user';
        const position = p.position || state.position || 'chat';
        const depth = p.depth !== undefined ? p.depth : (state.depth || 0);
        try {
          const inj = await bridge.inject({ content: p.text, role, position, depth });
          showToastSafe('已注入 (' + role + '/' + position + ')', 'success');
          if (typeof console !== 'undefined') console.log('[STScript /inject]', inj.id, '-', p.text.slice(0, 80));
          return inj.id || '';
        } catch (e) {
          showToastSafe('注入失败: ' + (e && e.message ? e.message : e), 'error');
          return '';
        }
      }
      case 'listinjects': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.listInjects !== 'function') {
          showToastSafe('当前环境不支持注入命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const list = await bridge.listInjects();
        const info = list.map((m, i) => `#${i + 1} [${m.role}/${m.position} d${m.depth}] ${String(m.content).slice(0, 60)}`).join('\n');
        showToastSafe('注入数: ' + list.length, 'info');
        if (typeof console !== 'undefined') console.log('[STScript /listinjects]\n' + info);
        return String(list.length);
      }
      case 'flushinjects': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.flushInjects !== 'function') {
          showToastSafe('当前环境不支持注入命令（需在聊天界面运行）', 'warning');
          return '';
        }
        try { await bridge.flushInjects(); showToastSafe('已清空注入', 'success'); return 'ok'; }
        catch (e) { showToastSafe('清空失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'note': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.setAuthorNote !== 'function') {
          showToastSafe('当前环境不支持作者备注命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const raw = (args && args.length) ? args.join(' ').trim() : '';
        if (!raw) { showToastSafe('/note 缺少内容', 'error'); return ''; }
        const p = parseInjectParams(raw);
        const state = (bridge.getInjectState && typeof bridge.getInjectState === 'function') ? (await bridge.getInjectState()) : {};
        const position = p.position || state.position || 'chat';
        const depth = p.depth !== undefined ? p.depth : (state.depth || 1);
        try {
          await bridge.setAuthorNote({ content: p.text, position, depth });
          showToastSafe('作者备注已设置', 'success');
          return 'ok';
        } catch (e) { showToastSafe('设置失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'interval': {
        const bridge = global.AppScript;
        const n = (args && args[0]) ? parseInt(args[0], 10) : 0;
        const v = isNaN(n) ? 0 : n;
        if (bridge && typeof bridge.setInjectState === 'function') {
          try { await bridge.setInjectState({ depth: v }); showToastSafe('深度已设为 ' + v, 'success'); }
          catch (e) { showToastSafe('设置失败', 'error'); }
        }
        return String(v);
      }
      case 'depth': {
        const bridge = global.AppScript;
        const n = (args && args[0]) ? parseInt(args[0], 10) : 0;
        const v = isNaN(n) ? 0 : n;
        if (bridge && typeof bridge.setInjectState === 'function') {
          try { await bridge.setInjectState({ depth: v }); showToastSafe('默认深度 ' + v, 'success'); }
          catch (e) { showToastSafe('设置失败', 'error'); }
        }
        return String(v);
      }
      case 'position': {
        const bridge = global.AppScript;
        const p = (args && args[0]) || 'chat';
        const position = (p === 'sys' || p === 'system') ? 'sys' : 'chat';
        if (bridge && typeof bridge.setInjectState === 'function') {
          try { await bridge.setInjectState({ position }); showToastSafe('默认位置 ' + position, 'success'); }
          catch (e) { showToastSafe('设置失败', 'error'); }
        }
        return position;
      }
      case 'parser-flag': {
        const name = args && args[0];
        const val = (args && args[1]) ? args[1] : 'on';
        if (!name) { showToastSafe('/parser-flag 缺少名称', 'error'); return ''; }
        try {
          const sv = global.ScriptVarsAPI;
          if (sv && typeof sv.get === 'function' && typeof sv.set === 'function') {
            const all = (sv.get('__parser_flags__') || {});
            all[name] = val;
            sv.set('__parser_flags__', all);
          }
          showToastSafe('解析器标记 ' + name + ' = ' + val, 'success');
          return val;
        } catch (e) { showToastSafe('设置失败', 'error'); return ''; }
      }

      // ---------- 世界书命令 (Phase 5, ST 原生语法适配) ----------
      // ST 原生语法 (file= 本工具忽略, 始终操作当前角色书):
      //   /getchatbook
      //   /findentry [file=] [field=key] [text]
      //   /getentryfield [file=] [field=content] [UID]
      //   /setentryfield [file=] [uid=] [field=content] [text]
      //   /createentry [file=] [key=] [content text]
      case 'getchatbook': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.getChatBook !== 'function') {
          showToastSafe('当前环境不支持世界书命令（需在聊天界面运行）', 'warning');
          return '';
        }
        try {
          const book = await bridge.getChatBook();
          const entries = (book.entries || []);
          const name = book.name || ('character_' + (bridge.getCharacterId ? bridge.getCharacterId() : ''));
          showToastSafe('世界书: ' + name + ' (' + entries.length + ' 条)', 'info');
          if (typeof console !== 'undefined') console.log('[STScript /getchatbook]', name, 'entries=', entries.length);
          return name; // ST: 返回绑定世界书文件名, 供管道使用
        } catch (e) { showToastSafe('读取世界书失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'findentry': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.findEntry !== 'function') {
          showToastSafe('当前环境不支持世界书命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const { params, positional } = parseKv(args);
        const search = positional.join(' ').trim();
        const field = params.field || 'key';
        if (!search) { showToastSafe('/findentry 缺少搜索文本', 'error'); return ''; }
        try {
          const hits = await bridge.findEntry(search, field);
          if (!hits.length) { showToastSafe('未找到匹配条目', 'warning'); return ''; }
          showToastSafe('匹配 ' + hits.length + ' 条, 取 #' + hits[0].id, 'info');
          if (typeof console !== 'undefined') console.log('[STScript /findentry]', field, search, '=>', JSON.stringify(hits));
          return String(hits[0].id); // ST: 返回首个匹配 UID 并管道
        } catch (e) { showToastSafe('查找失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'getentryfield': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.getEntryField !== 'function') {
          showToastSafe('当前环境不支持世界书命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const { params, positional } = parseKv(args);
        const entryId = positional[0] || (ctx && ctx.pipe !== undefined ? ctx.pipe : '');
        const field = params.field || 'content';
        if (!entryId) { showToastSafe('/getentryfield 需要 <条目UID> [field=content]', 'error'); return ''; }
        try {
          const val = await bridge.getEntryField(entryId, field);
          showToastSafe('#' + entryId + '.' + field + ' = ' + val, 'info');
          if (typeof console !== 'undefined') console.log('[STScript /getentryfield]', entryId, field, '=>', val);
          return String(val);
        } catch (e) { showToastSafe('读取失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'setentryfield': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.setEntryField !== 'function') {
          showToastSafe('当前环境不支持世界书命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const { params, positional } = parseKv(args);
        const uidFromParam = params.uid;
        const entryId = uidFromParam || positional[0] || (ctx && ctx.pipe !== undefined ? ctx.pipe : '');
        const field = params.field || 'content';
        if (!entryId || !field) { showToastSafe('/setentryfield 需要 uid=<UID> field=<字段> <值>', 'error'); return ''; }
        const valueTokens = uidFromParam ? positional : positional.slice(1);
        const rawVal = valueTokens.join(' ');
        if (rawVal === '') { showToastSafe('/setentryfield 缺少值', 'error'); return ''; }
        const value = coerceEntryField(field, rawVal);
        try {
          const entry = await bridge.setEntryField(entryId, field, value);
          showToastSafe('已更新 #' + entryId + '.' + field, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /setentryfield]', entryId, field, '=>', value);
          return typeof value === 'string' ? value : JSON.stringify(value);
        } catch (e) { showToastSafe('更新失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'createentry': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.createEntry !== 'function') {
          showToastSafe('当前环境不支持世界书命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const { params, positional } = parseKv(args);
        const keys = params.key ? String(params.key).split(',').map(s => s.trim()).filter(Boolean) : [];
        const content = positional.join(' ');
        const comment = keys.length ? keys.join(', ') : (content ? content.slice(0, 24) : 'New Entry');
        if (!keys.length && !content.trim()) { showToastSafe('/createentry 至少需 key= 或内容', 'error'); return ''; }
        try {
          const entry = await bridge.createEntry({ comment, keys, content });
          showToastSafe('已创建条目 #' + entry.id, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /createentry]', entry.id, '-', comment);
          return String(entry.id);
        } catch (e) { showToastSafe('创建失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // 解析 key=value 参数 (file=/field=/uid=/key= 等), 值可带引号已由 splitArgs 剥离
      function parseKv(args) {
        const params = {};
        const positional = [];
        for (const a of (args || [])) {
          const eq = a.indexOf('=');
          if (eq > 0 && /^[a-zA-Z_]\w*$/.test(a.slice(0, eq))) {
            params[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1);
          } else {
            positional.push(a);
          }
        }
        return { params, positional };
      }

      // 解析 key=value 参数（role=/position:/depth=），剩余部分作为注入文本
      function parseInjectParams(text) {
        const re = /(role|position|depth)\s*[=:]\s*(\S+)/gi;
        const params = { text, role: undefined, position: undefined, depth: undefined };
        let m;
        while ((m = re.exec(text)) !== null) {
          const key = m[1].toLowerCase();
          if (key === 'depth') params.depth = parseInt(m[2], 10) || 0;
          else params[key] = m[2];
        }
        params.text = text.replace(/(role|position|depth)\s*[=:]\s*\S+/gi, '').replace(/\s+/g, ' ').trim();
        return params;
      }

      // 世界书字段类型转换（keys/secondary_keys→数组，布尔字段→bool）
      function coerceEntryField(field, value) {
        const f = String(field).toLowerCase();
        if (f === 'key' || f === 'keys' || f === 'secondary_keys' || f === 'keysecondary') {
          return String(value).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (f === 'constant' || f === 'selective' || f === 'enabled' || f === 'disable') {
          return /^(on|true|1|yes)$/i.test(String(value).trim());
        }
        return value;
      }

      // 骰子表达式解析 (纯前端, 无需后端): 支持 2d6+1d4+3 / d20 / 3d8-2 等
      function rollDice(expr) {
        expr = String(expr || '').trim().toLowerCase();
        if (!expr) expr = '1d20';
        let total = 0;
        const rolls = [];
        const re = /([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/g;
        let m, matched = false;
        while ((m = re.exec(expr)) !== null) {
          matched = true;
          if (m[3] !== undefined) {
            const sign = m[1] === '-' ? -1 : 1;
            const count = m[2] === '' ? 1 : parseInt(m[2], 10);
            const sides = parseInt(m[3], 10);
            if (count < 1 || count > 100 || sides < 2 || sides > 1000) throw new Error('骰子参数非法');
            let sum = 0;
            for (let i = 0; i < count; i++) {
              const v = Math.floor(Math.random() * sides) + 1;
              rolls.push(v);
              sum += v;
            }
            total += sign * sum;
          } else {
            const sign = m[4] === '-' ? -1 : 1;
            total += sign * parseInt(m[5], 10);
          }
        }
        if (!matched) throw new Error('无效的骰子表达式: ' + expr);
        return { total, rolls };
      }

      // ---------- 角色/UI/扩展命令 (Phase 6) ----------
      case 'roll': {
        try {
          const expr = (args && args.join(' ')).trim() || '1d20';
          const res = rollDice(expr);
          showToastSafe('🎲 ' + expr + ' = ' + res.total, 'info');
          if (typeof console !== 'undefined') console.log('[STScript /roll]', expr, '=>', res.total, res.rolls);
          return String(res.total);
        } catch (e) { showToastSafe('骰子错误: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'char-get': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.getCharacter !== 'function') {
          showToastSafe('当前环境不支持角色命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const field = (args && args[0]) || '';
        if (!field) { showToastSafe('/char-get 需要 <字段>', 'error'); return ''; }
        try {
          const val = await bridge.getCharacter(field);
          showToastSafe('角色.' + field + ' = ' + val, 'info');
          if (typeof console !== 'undefined') console.log('[STScript /char-get]', field, '=>', val);
          return String(val);
        } catch (e) { showToastSafe('读取失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'char-update': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.updateCharacter !== 'function') {
          showToastSafe('当前环境不支持角色命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const field = args && args[0];
        const value = args.slice(1).join(' ');
        if (!field || value === '') { showToastSafe('/char-update 需要 <字段> <值>', 'error'); return ''; }
        try {
          const v = await bridge.updateCharacter(field, value);
          showToastSafe('已更新角色.' + field, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /char-update]', field, '=>', v);
          return String(v);
        } catch (e) { showToastSafe('更新失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'imagine': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.triggerImage !== 'function') {
          showToastSafe('当前环境不支持生图命令（需在聊天界面运行）', 'warning');
          return '';
        }
        const prompt = (args && args.join(' ')).trim();
        if (!prompt) { showToastSafe('/imagine 需要 <提示词>', 'error'); return ''; }
        try {
          await bridge.triggerImage(prompt);
          showToastSafe('已触发生图: ' + prompt.slice(0, 20), 'success');
          if (typeof console !== 'undefined') console.log('[STScript /imagine]', prompt);
          return prompt;
        } catch (e) { showToastSafe('生图失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // ---------- 角色导航命令 (Phase 6 剩余) ----------
      case 'go': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.listCharacters !== 'function' || typeof bridge.switchToCharacter !== 'function') {
          showToastSafe('当前环境不支持角色导航（需在聊天界面运行）', 'warning');
          return '';
        }
        const name = (args && args.join(' ')).trim();
        if (!name) { showToastSafe('/go 需要 <角色名>', 'error'); return ''; }
        try {
          const chars = await bridge.listCharacters();
          const q = name.toLowerCase();
          let target = chars.find(c => (c.name || '').toLowerCase() === q)
            || chars.find(c => (c.name || '').toLowerCase().startsWith(q))
            || chars.find(c => (c.name || '').toLowerCase().includes(q));
          if (!target) { showToastSafe('未找到角色: ' + name, 'error'); return ''; }
          await bridge.switchToCharacter(target.id, { collapseAfter: true });
          showToastSafe('已切换到: ' + target.name, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /go]', name, '=>', target.name);
          return target.name;
        } catch (e) { showToastSafe('切换失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'random': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.goRandomCharacter !== 'function') {
          showToastSafe('当前环境不支持角色导航', 'warning');
          return '';
        }
        try {
          const name = await bridge.goRandomCharacter();
          showToastSafe('随机进入: ' + name, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /random] =>', name);
          return name;
        } catch (e) { showToastSafe('随机切换失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'char-delete': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.deleteCharacterByName !== 'function') {
          showToastSafe('当前环境不支持角色命令', 'warning');
          return '';
        }
        const name = (args && args.join(' ')).trim();
        if (!name) { showToastSafe('/char-delete 需要 <名称>', 'error'); return ''; }
        try {
          const deleted = await bridge.deleteCharacterByName(name);
          showToastSafe('已删除角色: ' + deleted, 'success');
          if (typeof console !== 'undefined') console.log('[STScript /char-delete]', name, '=>', deleted);
          return deleted;
        } catch (e) { showToastSafe('删除失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // ---------- UI 样式 / 面板命令 (Phase 6 剩余) ----------
      case 'bubble':
      case 'flat':
      case 'single': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.setChatStyle !== 'function') {
          showToastSafe('当前环境不支持 UI 命令', 'warning');
          return '';
        }
        try {
          const s = await bridge.setChatStyle(name);
          showToastSafe('聊天样式: ' + s, 'info');
          return s;
        } catch (e) { showToastSafe('样式切换失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'bg': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.setBackground !== 'function') {
          showToastSafe('当前环境不支持 UI 命令', 'warning');
          return '';
        }
        const v = (args && args.join(' ')).trim() || 'none';
        try {
          const r = await bridge.setBackground(v);
          showToastSafe('背景: ' + r, 'info');
          if (typeof console !== 'undefined') console.log('[STScript /bg]', v);
          return r;
        } catch (e) { showToastSafe('背景设置失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'panels': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.togglePanels !== 'function') {
          showToastSafe('当前环境不支持 UI 命令', 'warning');
          return '';
        }
        const mode = (args && args[0]) || '';
        try {
          const r = await bridge.togglePanels(mode);
          showToastSafe('面板: ' + r, 'info');
          return r;
        } catch (e) { showToastSafe('面板切换失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'lockbg': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.lockBackground !== 'function') {
          showToastSafe('当前环境不支持 UI 命令', 'warning');
          return '';
        }
        try { const r = bridge.lockBackground(); showToastSafe('背景已锁定', 'info'); return r; }
        catch (e) { showToastSafe('失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'unlockbg': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.unlockBackground !== 'function') {
          showToastSafe('当前环境不支持 UI 命令', 'warning');
          return '';
        }
        try { const r = bridge.unlockBackground(); showToastSafe('背景已解锁', 'info'); return r; }
        catch (e) { showToastSafe('失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // ---------- 扩展命令 (Phase 6 剩余) ----------
      case 'websearch': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.webSearch !== 'function') {
          showToastSafe('当前环境不支持联网搜索（需在聊天界面运行）', 'warning');
          return '';
        }
        const q = (args && args.join(' ')).trim();
        if (!q) { showToastSafe('/websearch 需要 <查询>', 'error'); return ''; }
        try {
          const data = await bridge.webSearch(q);
          const results = (data.results || []);
          if (!results.length) {
            showToastSafe('未找到结果' + (data.degraded ? '（搜索服务不可用）' : ''), 'warning');
            return '';
          }
          const text = results.map((r, i) => '[' + (i + 1) + '] ' + r.title + '\n' + (r.snippet || '') + '\n' + r.url).join('\n\n');
          showToastSafe('搜索到 ' + results.length + ' 条结果', 'success');
          if (typeof console !== 'undefined') console.log('[STScript /websearch]', q, '=>', results.length, 'results');
          return text;
        } catch (e) { showToastSafe('搜索失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // ---------- MVU 世界状态变量 (Tier 3 闭环) ----------
      case 'setvar': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.saveWorldState !== 'function' || typeof bridge.getWorldState !== 'function') {
          showToastSafe('当前环境不支持世界状态（需在聊天界面运行）', 'warning');
          return '';
        }
        // 参数：<path> <value...>
        if (!args || args.length < 2) { showToastSafe('/setvar 需要 <path> <value>', 'error'); return ''; }
        const path = args[0].trim();
        if (!path.startsWith('/')) { showToastSafe('/setvar 路径需以 / 开头', 'error'); return ''; }
        const rawVal = args.slice(1).join(' ').trim();
        // 尝试智能类型：数字 / true / false / null
        let value = rawVal;
        if (/^-?\d+(\.\d+)?$/.test(rawVal)) value = Number(rawVal);
        else if (rawVal === 'true') value = true;
        else if (rawVal === 'false') value = false;
        else if (rawVal === 'null') value = null;
        try {
          const ws = await bridge.getWorldState();
          const next = applyPatchToModel(ws, [{ op: 'add', path, value }]);
          await bridge.saveWorldState(next);
          if (typeof global.renderWorldStatePanel === 'function') global.renderWorldStatePanel();
          showToastSafe('已设置 ' + path, 'success');
          return value;
        } catch (e) { showToastSafe('设置失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }
      case 'getvar': {
        const bridge = global.AppScript;
        if (!bridge || typeof bridge.getWorldState !== 'function') {
          showToastSafe('当前环境不支持世界状态（需在聊天界面运行）', 'warning');
          return '';
        }
        const path = ((args && args[0]) || '').trim();
        if (!path.startsWith('/')) { showToastSafe('/getvar 需要 <path>', 'error'); return ''; }
        try {
          const ws = await bridge.getWorldState();
          const val = readPathFromModel(ws, path);
          if (val === undefined) { showToastSafe('变量不存在: ' + path, 'warning'); return ''; }
          const text = (typeof val === 'object') ? JSON.stringify(val) : String(val);
          showToastSafe(path + ' = ' + text, 'info');
          return text;
        } catch (e) { showToastSafe('读取失败: ' + (e && e.message ? e.message : e), 'error'); return ''; }
      }

      // ---------- 帮助命令 ----------
      case 'help': {
        const sub = ((args && args[0]) || '').replace(/^\//, '').toLowerCase();
        if (sub && COMMAND_HELP[sub]) {
          showToastSafe(COMMAND_HELP[sub], 'info');
          return COMMAND_HELP[sub];
        }
        const lines = Object.keys(COMMAND_HELP).map(k => COMMAND_HELP[k]);
        const text = 'STscript 支持的命令：\n' + lines.join('\n');
        showToastSafe('已列出 ' + lines.length + ' 条命令', 'info');
        if (typeof console !== 'undefined') console.log('[STScript /help]\n' + text);
        return text;
      }

      // ---------- 未支持命令 ----------
      default:
        ctx.unknown = true;
        ctx.unknownMsg = '未支持指令: /' + name;
        showToastSafe('未支持指令: /' + name, 'warning');
        return '';
    }
  }

  async function invokeClosure(name, actualArgs, ctx) {
    const def = ctx.closures.get(name);
    if (!def) return '';
    ctx.scopedStack.push(new Map());
    const top = ctx.scopedStack[ctx.scopedStack.length - 1];
    (def.params || []).forEach((p, i) => top.set(p, makeVar(actualArgs[i] !== undefined ? actualArgs[i] : '')));
    ctx.returnFlag = false;
    await executeList(def.body, ctx);
    ctx.scopedStack.pop();
    return ctx.lastOutput || '';
  }

  // ===================== 会话与入口 =====================

  const STScript = {
    version: '0.1.0',
    _session: null,

    async initSession(conversationId, userId) {
      const local = new Map();
      const globalMap = new Map();
      if (typeof global.ScriptVarsAPI !== 'undefined') {
        if (conversationId) {
          try {
            const r = await global.ScriptVarsAPI.list('local', conversationId);
            (r.vars || []).forEach(v => local.set(v.name, { value: v.value, type: v.type }));
          } catch (e) { console.warn('[STScript] load local failed', e && e.message); }
        }
        if (userId) {
          try {
            const r = await global.ScriptVarsAPI.list('global', userId);
            (r.vars || []).forEach(v => globalMap.set(v.name, { value: v.value, type: v.type }));
          } catch (e) { console.warn('[STScript] load global failed', e && e.message); }
        }
      }
      this._session = {
        conversationId, userId,
        local, global: globalMap,
        closures: new Map(),
        scopedStack: [new Map()],
      };
      return this._session;
    },

    async run(scriptText, opts) {
      opts = opts || {};
      const conversationId = opts.conversationId || null;
      const userId = opts.userId != null ? opts.userId : null;

      // 确保会话已加载
      if (!this._session ||
          this._session.conversationId !== conversationId ||
          this._session.userId !== userId) {
        await this.initSession(conversationId, userId);
      }
      const ctx = this._session;
      ctx.pipe = '';
      ctx.breakFlag = false;
      ctx.returnFlag = false;
      ctx.abortFlag = false;
      ctx.unknown = false;
      ctx.unknownMsg = '';

      let commands;
      try {
        commands = parseCommands(scriptText);
      } catch (e) {
        return { ok: false, unknown: false, message: '解析错误: ' + (e && e.message) };
      }

      if (!commands.length) {
        return { ok: true, unknown: false, message: '' };
      }

      try {
        await executeList(commands, ctx);
      } catch (e) {
        return { ok: false, unknown: false, message: '执行错误: ' + (e && e.message) };
      }

      return {
        ok: !ctx.unknown,
        unknown: ctx.unknown,
        message: ctx.unknownMsg || '',
      };
    },

    expandMacros,
    // 暴露内部供测试/调试
    _parse: parseCommands,
    _tokenize: tokenizeScript,
  };

  global.STScript = STScript;
})(typeof window !== 'undefined' ? window : globalThis);

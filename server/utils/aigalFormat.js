'use strict';
/**
 * aigalFormat —— AI-GAL 渲染契约的单一实现（Card Studio 的 Layer F）
 *
 * 定位：把「文本 → 前端可渲染 DOM」的判定语义集中到一个可 require 的纯函数模块，
 * 供 Card Studio 的体检 / 适配 / 回环校验使用。
 *
 * 与运行时的关系（设计文档 §2.1，前提 0）：
 *   - 运行时真源（chat.js / app.js）保持原样，本模块按其语义独立实现；
 *   - 用 new Function 抠出真函数做 golden 对拍（_tmp/aigal-format-golden.js），
 *     真源语义一旦变化，对拍报警，两边同步维护；
 *   - 按「客户端语义（开场白路径）」与「服务端语义（每轮路径）」两族组织，
 *     每个函数注释都标注真源行号。
 *
 * 表述风格（设计文档前提 4）：本文件的注释与产出的文本一律正向表述。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 客户端语义族（开场白路径：formatted='{}' 时的兜底渲染链，真源 = app.js）
// 链条：replaceMacros(2448) → classifyAIOutput(2452) → stripThink(2557) →
//       stripMetaSections(2560) → splitInlineBlocks(2563) → renderPlainFallback(2352)
// ─────────────────────────────────────────────────────────────────────────────

// 宏替换（照 app.js:8317-8326 replaceMacros；运行时读 AppState，这里以参数传入）
function replaceMacrosClient(text, userName, charName) {
  if (!text || typeof text !== 'string') return text;
  const u = userName || '我';
  const c = charName || '';
  return text
    .replace(/\{\{\s*user\s*\}\}/gi, u)
    .replace(/\{\{\s*char\s*\}\}/gi, c)
    .replace(/\{\{\s*用户\s*\}\}/g, u)
    .replace(/\{\{\s*角色\s*\}\}/g, c);
}

// 思维链剥离（照 app.js:2493-2502 stripThink；think 开标记在真源中为转义书写，此处保持一致）
function stripThink(text) {
  if (!text) return text;
  return text
    .replace(/<customize_cot>[\s\S]*?<\/customize_cot>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();
}

// 段级裁剪（照 app.js:1933-1978 stripMetaSections）：
// mood/status/summarize/actions 四段整段丢弃；story/dialog 保留正文；
// portrait/cg/image 只保留非「键:值」的残余正文；未知标题与首个 ### 之前的正文原样保留。
function stripMetaSections(text) {
  if (!text) return text;
  const sections = text.split(/\n###\s+/);
  const storyParts = [];
  for (const section of sections) {
    const firstLine = section.split('\n')[0]?.trim() || '';
    const header = firstLine.replace(/^###\s*/, '').toLowerCase();
    if (header.startsWith('mood') || header.startsWith('status') || header.startsWith('summarize')) {
      // 纯元数据段：整段跳过
    } else if (header.startsWith('portrait') || header.startsWith('cg') || header.startsWith('image')) {
      const body = section.slice(section.indexOf('\n') + 1).trim();
      const remainderLines = [];
      let inRemainder = false;
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (inRemainder) { remainderLines.push(line); continue; }
        const ci = t.indexOf('：');
        const ei = t.indexOf(':');
        const idx = ci >= 0 ? ci : ei >= 0 ? ei : -1;
        if (idx > 0 && idx < t.length - 1) {
          // 「键:值」行：跳过
        } else {
          inRemainder = true;
          remainderLines.push(line);
        }
      }
      if (remainderLines.join('\n').trim()) {
        storyParts.push(remainderLines.join('\n').trim());
      }
    } else if (header.startsWith('actions')) {
      // 行动选项段：由 formatted.actions 单独通道承载，正文里跳过
    } else if (header.startsWith('story') || header.startsWith('dialog')) {
      const body = section.slice(section.indexOf('\n') + 1).trim();
      if (body) storyParts.push(body);
    } else {
      // 未知标题（首行丢弃、正文保留）或无标题首段（原样保留）
      const content = header ? section.slice(section.indexOf('\n') + 1).trim() : section.trim();
      if (content) storyParts.push(content);
    }
  }
  return storyParts.join('\n\n').trim();
}

// 对白切分·客户端版（照 app.js:2691-2712 splitStoryDialog）：
// `姓名：『对白』`，名字排除句读（。！？）与冒号，1-30 字，冒号后紧跟『』。
function splitStoryDialogClient(text) {
  const parts = [];
  const dialogRegex = /(?:^|\n|。|！|？)([^\n。！？:：]{1,30}?)[：:]\s*『([^』]+)』/g;
  let lastIndex = 0;
  let match;
  while ((match = dialogRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index + (match.index !== lastIndex ? 1 : 0)).trim();
    if (before) parts.push({ type: 'story', text: before });
    parts.push({ type: 'dialog', name: match[1].trim(), text: match[2].trim() });
    lastIndex = dialogRegex.lastIndex;
  }
  const after = text.slice(lastIndex).trim();
  if (after) parts.push({ type: 'story', text: after });
  if (parts.length === 0 && text.trim()) parts.push({ type: 'story', text: text.trim() });
  return parts;
}

// 引擎标记探测（照 app.js:3208-3211 isGameMarkupText）：
// 命中其一即可见正文整段改走 renderGameMarkup（对白气泡全丢）。
const GAME_MARKUP_RE = /<content>|<now_plot>|<pic>|<\/?json_patch>|<update>|<UpdateVariables>|\{[^}\n]{1,30}\}「/;
function isGameMarkupText(text) {
  if (!text) return false;
  return GAME_MARKUP_RE.test(text);
}

// 叙事根标签集合（照 app.js:2122-2126 NARRATIVE_ROOT_TAGS）
const NARRATIVE_ROOT_TAGS = new Set([
  'battlescene', 'scene', 'narrative', 'narration', 'desc', 'description',
  'location', 'status', 'ooc', 'setting', 'atmosphere', 'action', 'innerthought',
  'thought', 'dialogue', 'monologue', 'flashback', 'interlude', 'aside'
]);

// 输出分类（照 app.js:2128-2158 classifyAIOutput）
function classifyOutput(text) {
  if (!text || typeof text !== 'string') return { type: 'plain' };
  const stripped = text
    .replace(/^```(?:html|xml)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  if (!stripped.startsWith('<')) return { type: 'plain' };
  if (isGameMarkupText(stripped)) return { type: 'plain' };
  if (/\n###\s+/m.test(stripped) || /^<(customize_cot|think|reasoning|thought|thinking)\b/i.test(stripped)) {
    return { type: 'plain' };
  }
  if (/^<!DOCTYPE\s+html/i.test(stripped) || /^<html[\s>]/i.test(stripped)) {
    return { type: 'html', body: stripped };
  }
  const rootMatch = stripped.match(/^<([a-zA-Z][\w:-]*)\b[^>]*>/);
  if (rootMatch) {
    const root = rootMatch[1];
    const hasClose = new RegExp('</' + root + '\\s*>', 'i').test(stripped);
    const tagCount = (stripped.match(/<[a-zA-Z][\w:-]*\b/g) || []).length;
    if (hasClose || tagCount >= 2) {
      if (NARRATIVE_ROOT_TAGS.has(root.toLowerCase())) {
        return { type: 'narrative-custom', body: stripped, root };
      }
      return { type: 'xml', body: stripped };
    }
  }
  return { type: 'plain' };
}

// 内联 HTML 白名单与引擎/变量块集合（照 app.js:2236-2246）
const INLINE_HTML_TAGS = new Set([
  'b','i','u','em','strong','small','span','br','p','a','sub','sup','code','pre',
  'li','ul','ol','h1','h2','h3','h4','h5','h6','table','tr','td','th','thead','tbody',
  'div','section','article','blockquote','hr','img','font','center','ruby','rt','rp',
  'details','summary','figure','figcaption','nav','header','footer','main','aside','mark','time'
]);
const CORE_SKIP_BLOCKS = new Set([
  'jsonpatch','updatevariables','updatevariable','variable_update_call_format',
  'samcheckpoint','content','now_plot','pic','update','json_patch','status','ooc'
]);

// 独立自定义块定位（照 app.js:2264-2316 splitInlineBlocks）：
// 仅当开标签起于行首、闭标签收于行尾时才算独立块（渲染为玻璃面板）。
function splitInlineBlocks(text) {
  if (!text) return [{ kind: 'prose', text: text || '' }];
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*>/g;
  const stack = [];
  const tops = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const name = m[2];
    if (isClose) {
      const top = stack.pop();
      if (top && top.name.toLowerCase() === name.toLowerCase() && stack.length === 0) {
        tops.push({ name: top.name, start: top.start, end: re.lastIndex });
      } else if (top) {
        stack.push(top);
      }
    } else {
      stack.push({ name, start: m.index });
    }
  }
  const blocks = [];
  for (const t of tops) {
    const body = text.slice(t.start, t.end);
    const lower = t.name.toLowerCase();
    if (INLINE_HTML_TAGS.has(lower)) continue;
    if (CORE_SKIP_BLOCKS.has(lower)) continue;
    if (isGameMarkupText(body)) continue;
    const before = t.start === 0 ? '' : text.slice(0, t.start);
    if (before && !/\n\s*$/.test(before)) continue;
    const after = text.slice(t.end);
    if (after && !/^\s*\n/.test(after) && after.trim() !== '') continue;
    blocks.push({ name: t.name, start: t.start, end: t.end });
  }
  if (blocks.length === 0) return [{ kind: 'prose', text }];
  blocks.sort((a, b) => a.start - b.start);
  const segs = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.start > cursor) {
      const prose = text.slice(cursor, b.start);
      if (prose.trim()) segs.push({ kind: 'prose', text: prose });
    }
    segs.push({ kind: 'block', body: text.slice(b.start, b.end) });
    cursor = b.end;
  }
  if (cursor < text.length) {
    const prose = text.slice(cursor);
    if (prose.trim()) segs.push({ kind: 'prose', text: prose });
  }
  return segs.length ? segs : [{ kind: 'prose', text }];
}

// 状态行解析·正文内通道版（照 app.js:7342-7365 parseStatusSection；
// 运行时把结果合并进 AppState.userStatus 并刷新状态栏，这里返回新对象）
function parseStatusSectionClient(text) {
  if (!text) return {};
  const statusObj = {};
  const lines = text.includes('；') ? text.split(/[；;]/) : text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('：') >= 0 ? trimmed.indexOf('：') : trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    val = val.replace(/\[.*\]$/, '').trim();
    if (key && val) statusObj[key] = val;
  }
  return statusObj;
}

// 末尾行动选项扫描（照 app.js:2364-2377；同款扫描亦在段落路径 2523-2541）
const ACTION_LINE_RE = /^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*.+/;
const ACTION_CLEAN_RE = /^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?(.+?)(?:\s*-{1,2}\*?\*?)?$/;
const ACTION_PREFIX_RE = /^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?/;
function extractTailActions(displayText) {
  const result = { actions: [], actionStart: -1, cleanText: displayText };
  if (!displayText) return result;
  const lines = displayText.split('\n');
  let actionStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (ACTION_LINE_RE.test(t) && t.length > 5) {
      actionStart = i;
    } else break;
  }
  let actionLines = [];
  if (actionStart < lines.length) {
    actionLines = lines.slice(actionStart).map(l => {
      const am = l.trim().match(ACTION_CLEAN_RE);
      return am ? am[1].trim() : l.trim().replace(ACTION_PREFIX_RE, '').trim();
    });
    lines.splice(actionStart);
  }
  result.actions = actionLines;
  result.actionStart = actionStart;
  result.cleanText = lines.join('\n').trim();
  return result;
}

const STATUS_MARKER = '=== 状态栏 ===';

/**
 * 开场白解析：完整走一遍前端的兜底渲染链（解析侧，产出结构而非 HTML）。
 * 镜像 renderAIBlock(2444-2588) 无 segments 分支 + renderPlainFallback(2352-2397)。
 * 返回字段：
 *   classify       'plain' | 'html' | 'xml' | 'narrative-custom'
 *   visibleText    stripMetaSections 之后的保留文本
 *   inlineBlocks   独立自定义块原文（渲染为玻璃面板的部分）
 *   status         状态栏键值（正文内通道）
 *   statusRaw      状态标记之后截取的原文（slice(idx+10) 语义）
 *   actions        末尾行动选项（已剥序号）
 *   actionLines    命中的原始选项行
 *   gameMarkup     命中引擎标记的可见正文（整段改道 renderGameMarkup）
 *   dialog / story 客户端对白切分结果（gameMarkup 命中时为空）
 *   firstLineEaten 兜底渲染会吃掉的首行（首行缺 ### 标题时）
 */
function parseGreeting(rawText, opts) {
  const o = opts || {};
  const text0 = replaceMacrosClient(rawText, o.userName, o.charName);
  const cls = classifyOutput(text0);
  const out = {
    classify: cls.type, visibleText: '', inlineBlocks: [], status: {}, statusRaw: '',
    actions: [], actionLines: [], gameMarkup: '', dialog: [], story: [], firstLineEaten: ''
  };
  if (cls.type !== 'plain') return out;

  const rawText2 = stripThink(text0);
  // 兜底路径首行语义：首行缺 ### 标题时被当作标题丢弃（app.js:1971-1974 的无标题首段分支）
  const firstLine = (rawText2.split('\n')[0] || '').trim();
  if (firstLine && !/^###\s*\S/.test(firstLine)) out.firstLineEaten = firstLine;

  const kept = stripMetaSections(rawText2);
  out.visibleText = kept;
  if (!kept) return out;

  const segs = splitInlineBlocks(kept);
  for (const s of segs) {
    if (s.kind === 'block') { out.inlineBlocks.push(s.body); continue; }
    // —— 以下逐行镜像 renderPlainFallback(2352-2397) 的解析侧 ——
    let displayText = s.text;
    if (!displayText) continue;
    const statusIdx = displayText.indexOf(STATUS_MARKER);
    if (statusIdx >= 0) {
      const statusSection = displayText.slice(statusIdx + 10);
      displayText = displayText.slice(0, statusIdx).trim();
      if (!out.statusRaw) out.statusRaw = statusSection;
      Object.assign(out.status, parseStatusSectionClient(statusSection));
    }
    if (displayText) {
      const tail = extractTailActions(displayText);
      if (tail.actions.length > 0) {
        out.actions.push(...tail.actions);
        const rawTail = displayText.split('\n').slice(tail.actionStart).map(l => l.trim());
        out.actionLines.push(...rawTail);
      }
      const cleanText = tail.cleanText;
      if (cleanText) {
        if (isGameMarkupText(cleanText)) {
          out.gameMarkup += (out.gameMarkup ? '\n' : '') + cleanText;
        } else {
          const mixed = splitStoryDialogClient(cleanText);
          for (const part of mixed) {
            if (part.type === 'dialog') out.dialog.push(part);
            else if (part.text && part.text.trim()) out.story.push(part);
          }
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 服务端语义族（每轮路径，真源 = chat.js 路由闭包内的解析器）
// ─────────────────────────────────────────────────────────────────────────────

// 标题规范化（照 chat.js:6368-6391 normalizeHeaders）
function normalizeHeaders(text) {
  if (!text) return text;
  text = text.replace(/###(\S)/g, '### $1');
  text = text.replace(/(###\s+mood)\s+(\S+)/g, '$1\n$2');
  text = text.replace(/(###\s+image)\s+(\S+)/g, '$1\n$2');
  text = text.replace(/([^\n])###\s/g, '$1\n### ');
  text = text.replace(/(\n)(###\s)/g, '\n\n$2');
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

// 键值解析（照 chat.js:6619-6664 parseKeyValue；含 emoji 键前缀清理与一行多对容错）
function parseKeyValue(text) {
  function cleanKey(k) {
    return k.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE00}-\u{FE0F}\u{200D}\s]+/u, '').trim() || k;
  }
  const obj = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fullWidthCount = (trimmed.match(/：/g) || []).length;
    if (fullWidthCount > 1) {
      const subItems = trimmed.split(/\s{2,}/);
      for (const item of subItems) {
        const si = item.indexOf('：');
        if (si > 0) {
          obj[cleanKey(item.slice(0, si).trim())] = item.slice(si + 1).trim();
        } else {
          const si2 = item.indexOf(':');
          if (si2 > 0 && !/^\d+$/.test(item.slice(0, si2).trim())) {
            obj[cleanKey(item.slice(0, si2).trim())] = item.slice(si2 + 1).trim();
          }
        }
      }
    } else {
      let idx = trimmed.indexOf('：');
      if (idx > 0) {
        obj[cleanKey(trimmed.slice(0, idx).trim())] = trimmed.slice(idx + 1).trim();
      } else {
        idx = trimmed.indexOf(':');
        if (idx > 0 && !/^\d+$/.test(trimmed.slice(0, idx).trim())) {
          obj[cleanKey(trimmed.slice(0, idx).trim())] = trimmed.slice(idx + 1).trim();
        }
      }
    }
  }
  return obj;
}

// 键值解析 + 残余正文（照 chat.js:6585-6616 parseKeyValueWithRemainder）
function parseKeyValueWithRemainder(text) {
  const obj = {};
  const remainderLines = [];
  let inRemainder = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { if (inRemainder) remainderLines.push(''); continue; }
    if (inRemainder) { remainderLines.push(line); continue; }
    const ci = trimmed.indexOf('：');
    const ei = trimmed.indexOf(':');
    const idx = ci >= 0 ? ci : ei >= 0 ? ei : -1;
    if (idx > 0 && idx < trimmed.length - 1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      obj[key] = val;
    } else if (idx > 0 && idx === trimmed.length - 1) {
      const key = trimmed.slice(0, idx).trim();
      obj[key] = '';
    } else {
      inRemainder = true;
      remainderLines.push(line);
    }
  }
  return { kv: obj, remaining: remainderLines.join('\n').trim() };
}

// 旧式管道表（照 chat.js:6666-6680 parseDialogTable）
function parseDialogTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map(c => c.trim());
    const usable = cells[0] === '' ? cells.slice(1) : cells;
    if (usable.length > 0 && usable[usable.length - 1] === '') usable.pop();
    if (usable.length < 2) continue;
    if (usable[0] === '位置' || usable[0] === 'position') continue;
    rows.push({ position: usable[0] || 'left', name: usable[1] || '', mood: usable[2] || '', text: usable[3] || '' });
  }
  return rows;
}

// 对白切分·服务端版（照 chat.js:6687-6722 parseStoryDialog；接受（情绪）标签，带左右交替）
function parseStoryDialogServer(text) {
  const result = [];
  const dlgRe = /([\u4e00-\u9fff·a-zA-Z0-9\s\-]{1,20})[：:]\s*(?:[（(]([^）)]*)[）)]\s*)?[『\u2018']([^』\u2019']*)[』\u2019']/g;
  let lastIdx = 0;
  let match;
  let posToggle = false;
  while ((match = dlgRe.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index).trim();
    if (before) result.push({ type: 'story', text: before });
    result.push({
      type: 'dialog',
      position: posToggle ? 'right' : 'left',
      name: match[1].trim(),
      mood: (match[2] || '').trim(),
      text: match[3].trim(),
    });
    posToggle = !posToggle;
    lastIdx = dlgRe.lastIndex;
  }
  const after = text.slice(lastIdx).trim();
  if (after) result.push({ type: 'story', text: after });
  if (result.length === 0) result.push({ type: 'story', text });
  return result;
}

// 行动选项规范化（照 chat.js:5240-5266 normalizeActions）
function normalizeActions(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const markerRe = /-{1,2}\s*\d+[、．.]\s*/g;
  const out = [];
  for (const raw of arr) {
    if (raw == null) continue;
    const byNewline = String(raw).split(/\r?\n/);
    for (const piece0 of byNewline) {
      const piece = piece0.trim();
      if (!piece) continue;
      const matches = [...piece.matchAll(markerRe)];
      if (matches.length > 1) {
        for (let i = 0; i < matches.length; i++) {
          const start = matches[i].index + matches[i][0].length;
          const end = (i + 1 < matches.length) ? matches[i + 1].index : piece.length;
          const opt = piece.slice(start, end).trim().replace(/^-{1,2}\s*/, '').trim();
          if (opt) out.push(opt);
        }
      } else {
        const cleaned = piece.replace(markerRe, '').trim();
        if (cleaned) out.push(cleaned);
      }
    }
  }
  return out;
}

// 模板解析（照 chat.js:6398-6515 parseTemplate；真源的 console.log 副作用省略，解析产物逐字段一致）
function parseTemplate(text) {
  text = normalizeHeaders(text);
  text = text.replace(/\[\s*\{[\s\S]*?"name"\s*:\s*"[^"]*"[\s\S]*?\}\s*(?:,\s*\{[\s\S]*?\}\s*)*\]/g, '');
  text = text.replace(/\{\s*"name"\s*:\s*"[^"]*"[\s\S]*?(?:"种族性别"|"发色"|"罩杯"|"上衣"|"简要介绍")[\s\S]*?\}/g, '');
  text = text.replace(/<!--\s*\[[\s\S]*?"name"\s*:\s*"[^"]*"[\s\S]*?\]\s*-->/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  const segments = [];
  const result = { segments, portrait: null, portraits: [], cg: null, image: null, status: {}, mood: '' };
  const sections = text.split(/\n###\s+/);
  let fullText = '';

  for (const section of sections) {
    const body = section.slice(section.indexOf('\n') + 1).trim();
    const firstLine = section.split('\n')[0]?.trim() || '';
    const header = firstLine.replace(/^###\s*/, '').toLowerCase();

    if (header.startsWith('mood')) {
      const lines = body.split('\n');
      result.mood = (lines[0] || '').trim().toLowerCase();
      const afterMood = lines.slice(1).join('\n').trim();
      if (afterMood) {
        const mixed = parseStoryDialogServer(afterMood);
        mixed.forEach(item => {
          segments.push(item);
          fullText += (item.type === 'dialog' ? item.name + '：' + item.text : item.text) + '\n';
        });
      }
    } else if (header.startsWith('portrait')) {
      let processedBody = body;
      if (body.trim().startsWith('{') && body.trim().endsWith('}')) {
        try {
          const jsonObj = JSON.parse(body.trim());
          processedBody = Object.entries(jsonObj)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
        } catch (e) {
          // JSON 解析失败时按普通文本处理（与真源同分支）
        }
      }
      const { kv, remaining } = parseKeyValueWithRemainder(processedBody);
      result.portrait = kv;
      result.portraits.push(kv);
      if (remaining.trim()) {
        const mixed = parseStoryDialogServer(remaining.trim());
        mixed.forEach(item => {
          segments.push(item);
          fullText += (item.type === 'dialog' ? item.name + '：' + item.text : item.text) + '\n';
        });
      }
    } else if (header.startsWith('story')) {
      const mixed = parseStoryDialogServer(body);
      mixed.forEach(item => {
        segments.push(item);
        if (item.type === 'dialog') {
          fullText += item.name + '：' + item.text + '\n';
        } else {
          fullText += item.text + '\n';
        }
      });
    } else if (header.startsWith('dialog')) {
      const rows = parseDialogTable(body);
      rows.forEach(r => {
        segments.push({ type: 'dialog', position: r.position, name: r.name, mood: r.mood, text: r.text });
        fullText += r.name + '：' + r.text + '\n';
      });
    } else if (header.startsWith('cg')) {
      result.cg = parseKeyValue(body);
    } else if (header.startsWith('image')) {
      result.image = body.split('\n')[0].trim();
    } else if (header.startsWith('actions')) {
      if (!result.actions || result.actions.length === 0) {
        result.actions = normalizeActions(body);
      }
    } else if (header.startsWith('summarize')) {
      if (!result.summarize) {
        result.summarize = body.trim();
      }
    } else if (header.startsWith('status')) {
      if (Object.keys(result.status).length === 0) {
        result.status = parseKeyValue(body);
      }
    } else {
      const mixed = parseStoryDialogServer(section.trim());
      mixed.forEach(item => {
        segments.push(item);
        fullText += (item.type === 'dialog' ? item.name + '：' + item.text : item.text) + '\n';
      });
    }
  }

  result.fullText = fullText.trim();
  const cleanText = fullText.trim() || text.replace(/###\s*\w+[\s\S]*/g, '').trim() || text;
  delete result.fullText;
  return { cleanText, formatted: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 回环校验（设计文档 §5.1 四条硬规矩的可执行形态）与 emit 模板（正向表述）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验开场白。
 * mode='emit'   对适配产物要求全绿（问题记入 errors）；
 * mode='inspect' 对旧卡原文做体检（硬性问题仍为 errors，建议项为 warnings）。
 * opts.variableBlocks 期望逐字节保留的引擎卡变量块数组（V1 断言用，见设计文档 §5.2）。
 */
function validateGreeting(rawText, opts) {
  const o = opts || {};
  const mode = o.mode || 'emit';
  const raw = String(rawText || '');
  const parsed = parseGreeting(raw, o);
  const errors = [];
  const warnings = [];

  // 规矩 1：首行是 ### 标题（首行缺标题时会被兜底渲染当作标题删掉）
  const firstLine = (raw.split('\n')[0] || '').trim();
  if (firstLine && !/^###\s*\S/.test(firstLine)) {
    errors.push({ code: 'G1', field: 'firstLine', msg: '开场白首行写作 `###` 标题', detail: firstLine });
  }
  if (parsed.firstLineEaten) {
    errors.push({ code: 'G1b', field: 'firstLine', msg: '首行写作 `###` 标题（当前首行会被兜底渲染当作标题删除）', detail: parsed.firstLineEaten });
  }

  // 规矩 2：状态标记独占一行（截断取 slice(idx+10)，与状态同行会啃掉首键）
  const markerIdx = raw.indexOf(STATUS_MARKER);
  if (markerIdx >= 0) {
    const markerLine = raw.slice(markerIdx).split('\n')[0].trim();
    if (markerLine !== STATUS_MARKER) {
      errors.push({ code: 'G2', field: 'statusMarker', msg: '状态标记 `=== 状态栏 ===` 独占一行', detail: markerLine });
    }
    const statusRaw = raw.slice(markerIdx + STATUS_MARKER.length).replace(/^\s*\n/, '');
    if (!statusRaw.trim()) {
      warnings.push({ code: 'G2w', field: 'status', msg: '状态标记之后至少一行 `键：值`' });
    }
    // 状态键卫生：键首保持干净（与标记同行时会出现 = 前缀）；键数按 VN 面板能力提示
    for (const key of Object.keys(parsed.status)) {
      if (key.startsWith('=')) {
        errors.push({ code: 'G5', field: 'statusKey', msg: '状态键写作 `键：值`（当前键带上了标记残片）', detail: key });
      }
    }
    const keys = Object.keys(parsed.status);
    if (keys.length > 8) {
      warnings.push({ code: 'G5w', field: 'status', msg: '桌面 VN 状态面板展示前 8 个键', detail: keys.length + ' 个键' });
    }
    // 规矩 2 派生：行动选项写在状态标记之前（标记之后的选项行会随截断整体变成状态文本）
    const tailText = raw.slice(markerIdx + STATUS_MARKER.length);
    const tailActionLine = tailText.split('\n').map(l => l.trim()).find(l => ACTION_LINE_RE.test(l) && l.length > 5);
    if (tailActionLine) {
      errors.push({ code: 'G6', field: 'actions', msg: '行动选项写作 `--N、` 行并放在状态标记之前', detail: tailActionLine });
    }
  }

  // 规矩 4：可见正文保持纯净（引擎标记会让整段改道 renderGameMarkup，对白气泡全丢）
  if (parsed.gameMarkup) {
    const hits = [];
    const probes = [
      ['<content>', /<content>/], ['<now_plot>', /<now_plot>/], ['<pic>', /<pic>/],
      ['<json_patch>', /<\/?json_patch>/], ['<update>', /<update>/],
      ['<UpdateVariables>', /<UpdateVariables>/], ['{名}「', /\{[^}\n]{1,30}\}「/]
    ];
    for (const [label, re] of probes) if (re.test(parsed.gameMarkup)) hits.push(label);
    errors.push({ code: 'G4', field: 'visibleText', msg: '可见正文保持纯净：引擎标记放入被丢弃的段', detail: hits.join('、') });
  }

  // 规矩 3：行动选项（数量 / 长度）
  if (parsed.actions.length === 0) {
    const item = { code: 'G3', field: 'actions', msg: '开场白末尾提供 2-4 个 `--N、` 行动选项' };
    if (mode === 'emit') errors.push(item); else warnings.push(item);
  } else {
    if (parsed.actions.length < 2 || parsed.actions.length > 4) {
      const item = { code: 'G3c', field: 'actions', msg: '行动选项取 2-4 个', detail: parsed.actions.length + ' 个' };
      (mode === 'emit' ? errors : warnings).push(item);
    }
    // 选项行整体 trim 后需大于 5 字符（恰好 5 字符的行会被当成旁白，app.js:2367）；
    // 扫描只认末尾连续块，长度不足或位置居中的 `--N、` 行会漏进正文 —— 逐一指出
    const visibleOptionLines = parsed.visibleText.split('\n').map(l => l.trim()).filter(l => ACTION_LINE_RE.test(l));
    const missed = visibleOptionLines.filter(l => !parsed.actionLines.includes(l));
    if (missed.length) {
      warnings.push({ code: 'G3l', field: 'actions', msg: '行动选项写作 `--N、` 连续块并收在末尾（每行 6 字符以上）', detail: missed.join(' / ') });
    }
  }

  // 开场白对白卫生：冒号后紧跟『（（情绪）标签会让该句退化为旁白，客户端切分认不到）
  const moodRe = /[^\n。！？:：]{1,30}[：:]\s*[（(][^）)]*[）)]\s*『/;
  if (moodRe.test(parsed.visibleText)) {
    const hit = (parsed.visibleText.match(moodRe) || [])[0];
    const item = { code: 'G7', field: 'dialog', msg: '开场白对白写作 `姓名：『对白』`（语气描写放旁白句）', detail: hit };
    if (mode === 'emit') errors.push(item); else warnings.push(item);
  }

  // 分类：开场白以标记语言开头会整块内嵌渲染（对白全丢）
  if (parsed.classify !== 'plain') {
    errors.push({ code: 'G8', field: 'classify', msg: '开场白以纯文本叙述开头（当前会被判定为 ' + parsed.classify + ' 内嵌渲染）' });
  }

  // 引擎卡变量块：逐字节相同地留在被丢弃的 ### status 段（设计文档 §5.2 双断言之一）
  if (Array.isArray(o.variableBlocks) && o.variableBlocks.length > 0) {
    if (!/\n###\s+status[\s\S]*$/.test(raw)) {
      errors.push({ code: 'V1', field: 'variableBlocks', msg: '变量块放入开场白的 `### status` 段' });
    }
    for (const block of o.variableBlocks) {
      if (!raw.includes(block)) {
        errors.push({ code: 'V1', field: 'variableBlocks', msg: '变量块逐字节保留（当前有丢失或改动）', detail: String(block).slice(0, 40) });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, parsed };
}

/**
 * 组装规范开场白（正文内通道，设计文档 §5.1）。
 * parts:
 *   mood           氛围标签（缺省 relaxed）
 *   story          叙事/对白正文（对白行写作 `姓名：『对白』`）
 *   roster         在场角色名数组 → `👥 在场：A、B、C`
 *   actions        行动选项文案数组 → `--1、` `--2、` …（2-4 条，每条 6-30 字）
 *   status         状态键值对象 → `=== 状态栏 ===` 每行 `键：值`
 *   variableBlocks 引擎卡变量块原文数组 → 逐字放入被丢弃的 `### status` 段
 */
function emitGreeting(parts) {
  const p = parts || {};
  const lines = [];
  lines.push('### mood');
  lines.push(String(p.mood || 'relaxed').trim());
  lines.push('');
  lines.push('### story');
  const story = String(p.story || '').trim();
  if (story) lines.push(story);
  if (Array.isArray(p.roster) && p.roster.length > 0) {
    lines.push('');
    lines.push('👥 在场：' + p.roster.map(s => String(s).trim()).filter(Boolean).join('、'));
  }
  if (Array.isArray(p.actions) && p.actions.length > 0) {
    lines.push('');
    p.actions.forEach((a, i) => lines.push('--' + (i + 1) + '、' + String(a).trim()));
  }
  if (p.status && Object.keys(p.status).length > 0) {
    lines.push('');
    lines.push(STATUS_MARKER);
    for (const [k, v] of Object.entries(p.status)) lines.push(String(k).trim() + '：' + String(v).trim());
  }
  if (Array.isArray(p.variableBlocks) && p.variableBlocks.length > 0) {
    lines.push('');
    lines.push('### status');
    p.variableBlocks.forEach(b => lines.push(String(b)));
  }
  return lines.join('\n');
}

/**
 * 生成写入卡片 system_prompt 的状态格式契约（正向表述，设计文档 §4.3）。
 * spec = { keys: [ { key, label?, type: gauge|percent|enum|text, example?, required? } ] }
 */
function emitStatusContract(spec) {
  const keys = (spec && Array.isArray(spec.keys)) ? spec.keys : [];
  const lines = [];
  lines.push('=== 状态输出 ===');
  lines.push('每轮结尾输出「### status」段，列出以下状态，每行写作「键：值」：');
  for (const k of keys) {
    const name = k.label || k.key;
    const ex = k.example || '';
    const opt = (k.required === false) ? '（有变化时列出）' : '';
    if (k.type === 'gauge') {
      lines.push(name + '（写作 当前/上限，如 ' + (ex || '80/100') + '）' + opt);
    } else if (k.type === 'percent') {
      lines.push(name + '（如 ' + (ex || '50%') + '）' + opt);
    } else if (k.type === 'enum') {
      lines.push(name + '（如 ' + (ex || (Array.isArray(k.values) && k.values[0]) || '当前阶段') + '）' + opt);
    } else {
      lines.push(name + '（如 ' + (ex || '当前情况') + '）' + opt);
    }
  }
  lines.push('本轮列出完整状态集，数值照实记录。');
  return lines.join('\n');
}

module.exports = {
  // 客户端语义族
  replaceMacrosClient,
  stripThink,
  stripMetaSections,
  splitStoryDialogClient,
  isGameMarkupText,
  classifyOutput,
  splitInlineBlocks,
  parseStatusSectionClient,
  extractTailActions,
  parseGreeting,
  // 服务端语义族
  normalizeHeaders,
  parseKeyValue,
  parseKeyValueWithRemainder,
  parseDialogTable,
  parseStoryDialogServer,
  normalizeActions,
  parseTemplate,
  // 回环校验与 emit
  validateGreeting,
  emitGreeting,
  emitStatusContract,
  // 集合常量
  NARRATIVE_ROOT_TAGS,
  INLINE_HTML_TAGS,
  CORE_SKIP_BLOCKS,
  STATUS_MARKER,
};
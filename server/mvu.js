/**
 * MVU (engine-card variable system) shared helpers.
 *
 * Used by:
 *   - chat.js   -> buildMvuPromptModule(): inject the main-AI variable-sync module,
 *                  chosen to MATCH the faction the card itself already speaks.
 *   - detectMvuCard() / detectMvuFaction(): card-format helpers (also used by tests).
 *
 * Why factions matter (see docs/AI-GAL-MVU-COMPAT-PLAN.md, gap G10):
 *   A native MVU card already ships its own prompt telling the model to emit
 *   <UpdateVariable> + _.set(...). If we ALSO demand <json_patch>, the model either
 *   emits both or neither, and updates get lost. So the injected module must never
 *   contradict the card: it either stays silent about the format, or mirrors it.
 *
 * Kept dependency-free so it can be unit-tested in isolation.
 */
'use strict';

/** Format families a card can speak. */
const FACTION = {
  NATIVE: 'mvu-native',   // <UpdateVariable> + _.set / _.add / _.assign / _.remove
  PATCH: 'json-patch',    // <json_patch> / <JSONPatch> (RFC 6902)
  SAM: 'sam-sql',         // <UpdateVariables> + @.SELECT_SET(...)
  NONE: 'none',
};

/**
 * Detect whether a card uses the MVU / engine variable system.
 * @param {object|null} character  Full character row (may have markup_mode / mvu_meta).
 * @param {...string} texts        Free-text fragments (system_prompt, descriptions, ...).
 * @returns {boolean}
 */
function detectMvuCard(character, ...texts) {
  if (character) {
    if (character.markup_mode === 'game-xml') return true;
    if (character.mvu_meta) {
      try {
        const m = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta) : character.mvu_meta;
        if (m && m.fields && Object.keys(m.fields).length) return true;
        if (m && m.initvar && Object.keys(m.initvar).length) return true;
      } catch (e) { /* ignore */ }
    }
  }
  const hay = texts.filter(Boolean).join(String.fromCharCode(10));
  return /<content>|<now_plot>|<pic>|<\/?json_patch>|<UpdateVariables?>|<variable_update_call_format>|_\.(set|add|assign|remove)\(|\{[^}\n]{1,30}\}「/.test(hay);
}

/**
 * Which update dialect does this card itself use?
 * Scans the card content so we never contradict it.
 * @returns {string} one of FACTION.*
 */
function detectMvuFaction(character, ...texts) {
  const parts = [];
  if (character) {
    for (const k of ['system_prompt', 'personality', 'description', 'scenario', 'mes_example', 'post_history_instructions', 'creator_notes']) {
      if (character[k]) parts.push(String(character[k]));
    }
    if (character.character_book) {
      try {
        const cb = typeof character.character_book === 'string' ? JSON.parse(character.character_book) : character.character_book;
        for (const e of ((cb && cb.entries) || [])) {
          if (e && e.content) parts.push(String(e.content));
          if (e && e.comment) parts.push(String(e.comment));
        }
      } catch (e) { /* ignore */ }
    }
  }
  for (const t of texts) if (t) parts.push(String(t));
  const hay = parts.join(String.fromCharCode(10));
  if (!hay) return FACTION.NONE;

  // Native MVU commands are the strongest signal (but <UpdateVariables> is SAM).
  if (/<UpdateVariable[^s]/.test(hay) || /_\.(set|add|assign|remove|insert|unset|delete)\s*\(/.test(hay)) return FACTION.NATIVE;
  if (/<json_?patch>/i.test(hay) || /"op"\s*:\s*"(replace|delta|remove)"/.test(hay)) return FACTION.PATCH;
  if (/<UpdateVariables>/.test(hay) || /@\.(SELECT_SET|SELECT_ADD|SET|ADD)\s*\(/.test(hay)) return FACTION.SAM;
  return FACTION.NONE;
}

/** Does the card text already carry an explicit variable output-format spec? */
function hasOwnFormatSpec(character, ...texts) {
  const faction = detectMvuFaction(character, ...texts);
  return faction === FACTION.NATIVE || faction === FACTION.PATCH || faction === FACTION.SAM;
}

/**
 * Build the OPTIONAL MVU variable-sync module for the main AI system prompt.
 *
 * Behaviour by faction:
 *   NATIVE -> a SHORT supplement only. We must NOT ask it to switch to <json_patch>,
 *             because the card@s own prompt already defines the contract. We only state
 *             that the commands are really executed, plus the rules cards forget most:
 *             the [0] rule for composite values, and no invented keys.
 *   PATCH  -> the hard rule: changes MUST be a <json_patch> block.
 *   SAM    -> null (the SAM SQL dialect is applied by the applier; no need to nag).
 *   NONE   -> null unless the card carries a schema (then treat like PATCH).
 *
 * @param {object|null} character
 * @param {object} [opts]  { texts?: string[] } extra text fragments for faction detection
 * @returns {string|null}
 */
function buildMvuPromptModule(character, opts) {
  const extra = (opts && Array.isArray(opts.texts)) ? opts.texts : [];
  const faction = detectMvuFaction(character, ...extra);

  // Variable list (english key -> label), when the card was imported with a schema.
  let meta = null;
  try {
    const raw = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta) : (character && character.mvu_meta);
    if (raw && raw.fields && Object.keys(raw.fields).length) meta = raw;
  } catch (e) { /* ignore */ }
  const entries = meta ? Object.entries(meta.fields).filter(([, f]) => !f.hidden) : [];
  const lines = entries.map(([key, f]) => '- ' + key + '（' + (f.label || key) + '）');
  const firstKey = entries.length ? entries[0][0] : 'key';

  if (faction === FACTION.NATIVE) {
    if (!entries.length && !hasOwnFormatSpec(character, ...extra)) return null;
    const body = [
      '',
      '【MVU 变量命令 - 会被真实执行】',
      '本卡使用 MVU 变量系统。你在 <UpdateVariable> 中写出的命令会被脚本逐条真实执行，',
      '并把结果作为下一轮的权威状态回传给你 —— 所以不要凭记忆编造数值，也不要重复输出整份状态。',
    ];
    if (entries.length) {
      body.push('变量清单（英文 key → 中文含义）：');
      body.push(lines.join(String.fromCharCode(10)));
    } else {
      body.push('请严格按照卡内定义的变量清单与格式操作。');
    }
    body.push('');
    body.push('补充两条最容易出错的规则：');
    body.push('- 值本身是对象或数组时，必须用 [0] 定位：路径写成 福建.舰载机[0].补给中.J-35 这样；');
    body.push('  （对 [值, 描述] 这种二元组直接赋值只会改到值，描述会自动保留。）');
    body.push('- 不要新增或删除卡内未定义的键：结构受约束，越权的新增/删除会被拒绝且不生效。');
    body.push('- 本轮没有变量变化时，不要输出 <UpdateVariable> 块。');
    return body.join(String.fromCharCode(10));
  }

  if (faction === FACTION.SAM) return null;
  if (!entries.length) return null;

  const patchBody = [
    '',
    '【MVU 变量状态同步 - 强制模块】',
    '本卡使用 MVU 变量系统。变量清单（英文 key → 中文含义）：',
    lines.join(String.fromCharCode(10)),
    '',
    '规则：',
    '- 当上述任一变量在本轮发生变化时，必须在该轮回复的【最末尾】输出一个 <json_patch> 块（RFC 6902 JSON 数组）。',
    '- path 必须使用上面的【英文 key】，以 JSON 指针风格写出（/ 分隔，例如 /mc/energy）；绝对禁止用中文键，绝对禁止用散文描述变化。',
    '- 支持的操作：replace（设为值）、add（追加或数字自增）、delta（对当前数值增减，例如好感度 +5 用 {"op":"delta","path":"/contact/haogan","value":5}）、remove。',
    '- 本轮若无任何变量变化，则【不输出】<json_patch> 块。',
    '- 严禁在 ### story / ### portrait 等叙事段落中输出 JSON 或变量数据。',
    '',
    '合法范例（变量变化时的输出，置于回复末尾）：',
    '<json_patch>',
    '[',
    '  {"op":"replace","path":"/' + firstKey + '","value":80},',
    '  {"op":"delta","path":"/' + firstKey + '","value":5}',
    ']',
    '</json_patch>',
  ];
  return patchBody.join(String.fromCharCode(10));
}

module.exports = { detectMvuCard, detectMvuFaction, buildMvuPromptModule, FACTION };

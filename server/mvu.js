/**
 * MVU (engine-card variable system) shared helpers.
 *
 * Used by:
 *   - chat.js   → buildMvuPromptModule(): conditionally inject the main-AI
 *                 variable-sync module (only when the active card is an MVU card).
 *   - detectMvuCard(): card-format helper (kept exported for tooling/tests;
 *                 the legacy cardFixer route was retired — cardStudio.js has
 *                 its own engine detection).
 *
 * Kept dependency-free so it can be unit-tested in isolation.
 */

/**
 * Detect whether a card uses the MVU / engine variable system.
 * @param {object|null} character  Full character row (may have markup_mode / mvu_meta).
 * @param {...string} texts        Free-text fragments (system_prompt, descriptions, …).
 * @returns {boolean}
 */
function detectMvuCard(character, ...texts) {
  if (character) {
    if (character.markup_mode === 'game-xml') return true;
    if (character.mvu_meta) {
      try {
        const m = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta) : character.mvu_meta;
        if (m && m.fields && Object.keys(m.fields).length) return true;
      } catch { /* ignore */ }
    }
  }
  const hay = texts.filter(Boolean).join('\n');
  return /<content>|<now_plot>|<pic>|<\/?json_patch>|<UpdateVariables>|<variable_update_call_format>|\{[^}\n]{1,30}\}「/.test(hay);
}

/**
 * Build the OPTIONAL MVU variable-sync module for the main AI system prompt.
 * Returns null unless the card is an MVU card with a non-empty variable schema,
 * so callers can treat a null return as "module inactive".
 *
 * When present, the module:
 *   - lists each variable as `english.key（中文含义）` (so the AI understands semantics),
 *   - hard-rules that any variable change MUST be emitted as a <json_patch> block
 *     (RFC 6902) using the English key as a JSON-pointer path,
 *   - gives a valid few-shot example matching what server/utils/jsonpatch.js accepts.
 *
 * @param {object|null} character
 * @returns {string|null}
 */
function buildMvuPromptModule(character) {
  if (!character) return null;
  let meta = null;
  try {
    const raw = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta) : character.mvu_meta;
    if (raw && raw.fields && Object.keys(raw.fields).length) meta = raw;
  } catch { /* ignore */ }
  if (!meta) return null;

  const entries = Object.entries(meta.fields).filter(([, f]) => !f.hidden);
  if (!entries.length) return null;

  const lines = entries.map(([key, f]) => `- ${key}（${f.label || key}）`);
  const firstKey = entries[0][0];

  return `
【MVU 变量状态同步 - 强制模块】
本卡使用 MVU 变量系统。变量清单（英文 key → 中文含义）：
${lines.join('\n')}

规则：
- 当上述任一变量在本轮发生变化时，必须在该轮回复的【最末尾】输出一个 <json_patch> 块（RFC 6902 JSON 数组）。
- path 必须使用上面的【英文 key】，以 JSON 指针风格写出（'/' 分隔，例如 /mc/energy）；绝对禁止用中文键，绝对禁止用散文描述变化。
- 支持的操作：replace（设为值）、add（追加或数字自增）、delta（对当前数值增减，例如好感度 +5 用 {"op":"delta","path":"/contact/haogan","value":5}）、remove。
- 本轮若无任何变量变化，则【不输出】<json_patch> 块。
- 严禁在 ### story / ### portrait 等叙事段落中输出 JSON 或变量数据。

合法范例（变量变化时的输出，置于回复末尾）：
<json_patch>
[
  {"op":"replace","path":"/${firstKey}","value":80},
  {"op":"delta","path":"/${firstKey}","value":5}
]
</json_patch>`;
}

module.exports = { detectMvuCard, buildMvuPromptModule };

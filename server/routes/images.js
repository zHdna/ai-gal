/**
 * Image Generation Routes - ComfyUI workflow mode + profile fallback
 */
const { Router } = require('express');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const { SETTINGS_ID, ANIMA_PRESET, NOVELAI_PRESET, OPENAI_COMPATIBLE_MODES, EXTERNAL_IMAGE_MODES, EXTERNAL_API_TIMEOUT_MS, DEFAULT_COMFYUI_URL } = require('../constants');
const { isPathWithin } = require('../utils/pathGuard');
const savePaths = require('../savePaths');
const { isUrlSafe } = require('../utils/urlGuard');
const { normalizeImageSize, sizeForEngine } = require('../utils/imageSize');

// Maximum allowed size for base64 data URLs (5 MB)
const MAX_DATA_URL_BYTES = 5 * 1024 * 1024;
// Maximum number of HTTP redirect hops when downloading external images
const MAX_REDIRECTS = 5;

const IMAGES_DIR = require('../paths').GENERATED_IMAGES_DIR;
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const PROJECT_ROOT = path.join(__dirname, '..', '..');
// profile/ 是可写数据（NPC 占位头像等），随 DATA_ROOT 外置
const PROFILE_DIR = require('../paths').PROFILE_DIR;
const DEFAULT_WORKFLOW_CG = 'GALCG.json';
const DEFAULT_WORKFLOW_PORTRAIT = 'portrait_x.json';
// NSFW 流程结束图（纯场景空镜）在 CG 画廊里的中文说明，前端直接显示在缩略图下方
const SCENE_END_LABEL = '场景 · NSFW 流程结束';
// ComfyUI is a distinct engine from anima-turbo-cg (which owns 8100), so it keeps 8188.
// DEFAULT_COMFYUI_URL is imported from ../constants (single source of truth).

/**
 * Resolve the effective endpoint for an external image engine.
 *
 * anima-turbo-cg is the built-in default engine, so its endpoint/model must survive a
 * blank settings row (fresh install, cleared field, or an API-Key field a browser
 * refused to prefill).  novelai's endpoint/model have fixed official defaults for the
 * same reason — but its API key (the account's Persistent API Token) can NEVER be
 * defaulted and stays blank until the user fills it in.  `openai` / `stability` keep
 * their "user must configure it" behaviour and are returned blank when unset.
 */
function resolveExternalEndpoint(genMode, settings) {
  const isAnima = genMode === ANIMA_PRESET.MODE;
  const isNovelai = genMode === NOVELAI_PRESET.MODE;
  const preset = isNovelai ? NOVELAI_PRESET : ANIMA_PRESET;
  const pick = (value, fallback) => {
    const v = typeof value === 'string' ? value.trim() : '';
    return v || ((isAnima || isNovelai) ? fallback : '');
  };
  return {
    apiUrl: pick(settings && settings.api_url, preset.API_URL),
    apiKey: pick(settings && settings.api_key, isNovelai ? '' : ANIMA_PRESET.API_KEY),
    apiModel: pick(settings && settings.api_model, preset.API_MODEL),
    timeoutMs: isAnima ? ANIMA_PRESET.TIMEOUT_MS
      : (isNovelai ? NOVELAI_PRESET.TIMEOUT_MS : EXTERNAL_API_TIMEOUT_MS),
  };
}

/**
 * Resolve the workflow file used for a generation type.
 * A workflow chosen in settings wins; otherwise the built-in default is used.
 * The value is always interpreted as a bare filename inside the project root —
 * path separators are rejected, so a crafted value cannot escape the directory.
 */
function getWorkflowFile(type, settings) {
  const configured = String((type === 'cg' ? settings?.cg_workflow : settings?.portrait_workflow) || '').trim();
  const usable = configured && !/[/\\]/.test(configured) && configured !== '.' && configured !== '..';
  return path.join(PROJECT_ROOT, usable ? configured : (type === 'cg' ? DEFAULT_WORKFLOW_CG : DEFAULT_WORKFLOW_PORTRAIT));
}

// ---- Character-card name matching (shared single source of truth) ----
const { namesEquivalent, normCard, levenshtein, isActionLikeText } = require('../nameMatch');

// ---- ComfyUI model name normalization ----
// ComfyUI validates model names case-sensitively against its filesystem index.
// On Windows the filesystem is case-insensitive, but the index can differ from
// what we have in the workflow JSON.  Query ComfyUI and fix mismatches.
let _modelNormalizerCache = null;
let _modelNormalizerCacheTime = 0;

async function normalizeWorkflowModels(workflow, comfyuiUrl) {
  if (!workflow || !comfyuiUrl) return;
  const now = Date.now();
  if (!_modelNormalizerCache || (now - _modelNormalizerCacheTime) > 300000) {
    try {
      const resp = await httpGet(new URL('/object_info', comfyuiUrl.replace(/\/$/, '')));
      const allModels = new Map();
      if (resp) {
        for (const [, info] of Object.entries(resp)) {
          const inputs = info?.input?.required;
          if (!inputs) continue;
          for (const [, paramInfo] of Object.entries(inputs)) {
            if (!Array.isArray(paramInfo) || !paramInfo[0] || !Array.isArray(paramInfo[0])) continue;
            for (const val of paramInfo[0]) {
              if (typeof val === 'string' && val.includes('.')) {
                allModels.set(val.toLowerCase(), val);
              }
            }
          }
        }
      }
      _modelNormalizerCache = allModels;
      _modelNormalizerCacheTime = now;
    } catch { return; }
  }
  const MODEL_KEYS = new Set(['unet_name', 'clip_name', 'vae_name', 'lora_name', 'ckpt_name']);
  for (const [nid, node] of Object.entries(workflow)) {
    if (!node.inputs) continue;
    for (const key of MODEL_KEYS) {
      const val = node.inputs[key];
      if (typeof val !== 'string') continue;
      const canonical = _modelNormalizerCache.get(val.toLowerCase());
      if (canonical && canonical !== val) {
        console.log(`[ImageGen] Normalized ${key}: "${val}" → "${canonical}" (node ${nid})`);
        node.inputs[key] = canonical;
      }
    }
  }
}

const PORT = process.env.PORT || 3210;
// Self-fetch URL: always use loopback (server calling itself), NOT affected by LISTEN_HOST
const HOST = process.env.SELF_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

// Age → tag mapping; xianzi overrides all if wuxia/xianxia context
const AGE_TAGS = { teen: 'teen', adult: 'milf', mature: 'milf', loli: 'loli' };

// Lower-body words stripped from portrait prompts (ensure headshot)
const BODY_FILTER = [
  'skirt', 'pants', 'jeans', 'shorts', 'trousers', 'stockings', 'socks', 'thighhighs',
  'legs', 'feet', 'shoes', 'boots', 'heels', 'barefoot', 'toes', 'ankle',
  'calf', 'thigh', 'knee', 'hip', 'waist', 'belt', 'pantyhose', 'leggings',
  'miniskirt', 'hotpants', 'underwear', 'panties', 'lingerie', 'footwear',
  'sandals', 'sneakers', 'loafers', 'stiletto', 'wedges', 'platform_shoes',
  'knee_boots', 'thigh_boots', 'ankle_boots', 'calf_boots',
  'standing', 'full_body', 'sitting_on_floor', 'sitting_on_chair',
  '短裙', '裤', '袜', '腿', '脚', '鞋', '裙', '内裤', '丝袜', '长筒袜',
  '短裤', '热裤', '凉鞋', '高跟鞋', '靴子', '站姿', '坐姿', '全身',
];

// Clothing tags that get replaced with hanfu in wuxia contexts
const CLOTHING_TAGS = [
  'dress', 'skirt', 'uniform', 'suit', 'shirt', 'blouse', 'jacket',
  'coat', 'sweater', 'hoodie', 't-shirt', 'tank top', 'crop top',
  'armor', 'robe', 'gown', 'kimono', 'yukata', 'cheongsam', 'qipao',
  'jeans', 'pants', 'shorts', 'leggings', 'school uniform',
  'maid', 'bikini', 'swimsuit', 'lingerie', 'casual', 'western',
  'modern', 'streetwear', 'business', 'formal',
  '裙', '衣', '服', '装', '甲', '袍', '衫', '旗袍', '和服',
];

/**
 * True when `prompt` carries the Anima two-layer shape:
 *   line 1 = comma-separated Hard Tags, blank line, then a natural-language caption.
 * Anima/Cosmos-style models (and their Qwen text encoder) read this as two distinct layers, so
 * any prompt rewriting below MUST keep the blank-line boundary instead of flattening it.
 */
function isAnimaHybridPrompt(prompt) {
  return /\r?\n[ \t]*\r?\n/.test(String(prompt || ''));
}

/**
 * Clean a single Hard-Tags line: drop `artist:`/`year 2024`-style directives, ensure the `nsfw`
 * rating is present, and de-duplicate (case / spacing / `+` insensitive) while preserving order.
 */
function cleanHardTagLine(line, opts) {
  // forceNsfw defaults to true (every NSFW-scene CG must carry the rating); the DEBUT CG path
  // passes { forceNsfw: false } so a safe character-introduction shot is not mislabelled.
  const forceNsfw = !opts || opts.forceNsfw !== false;
  const tags = String(line || '').split(',').map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const deduped = [];
  // Only strip bare artist:name / style directives from AI output.
  // Do NOT strip NovelAI attention syntax ({...} / [...]) or system quality prefix tags.
  const artistReject = /^(artist\s*:?|by\s+|year\s*\d{4}|\d{4}\s*style|style\s+of|ask|novelai)/i;
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase().replace(/\+/g, ' ').trim();
    // Protect: NovelAI attention brackets or system quality prefix tags
    const isNAI = /^\{[^}]+\}$/.test(trimmed) || /^\[[^\]]+\]$/.test(trimmed);
    if (!isNAI && artistReject.test(key)) continue;
    if (!seen.has(key)) {
      deduped.push(trimmed);
      seen.add(key);
    }
  }
  // Ensure nsfw tag is present (unless the caller opted out — see forceNsfw above)
  if (forceNsfw && !deduped.some(t => t.toLowerCase() === 'nsfw')) {
    deduped.splice(1, 0, 'nsfw');
  }
  return deduped.join(', ');
}

/**
 * Clean CG prompt: deduplicate quality tags, ensure nsfw tag is present, normalize spacing.
 * CG prompts have quality prefix pre-applied by chat.js code.
 *
 * Anima hybrid prompts are handled specially: the Hard-Tags line is cleaned but the
 * natural-language caption is passed through VERBATIM and the blank line between the two
 * layers is preserved. Flattening them into one comma-separated line (the legacy behaviour)
 * destroys both the tag/identity constraints and the Natural-Language structure.
 */
function cleanCGPrompt(prompt, opts) {
  // --- Anima hybrid: clean the Hard-Tags layer only, keep the caption intact ---
  if (isAnimaHybridPrompt(prompt)) {
    const lines = String(prompt).replace(/\r\n/g, '\n').split('\n');
    const hardLine = lines.shift();
    const caption = lines.join('\n').replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
    const cleanedTags = cleanHardTagLine(hardLine, opts);
    if (!caption) return cleanedTags;
    return cleanedTags ? `${cleanedTags}\n\n${caption}` : caption;
  }

  // --- Legacy single-layer prompt ---
  return cleanHardTagLine(prompt, opts);
}

/**
 * True when the prompt declares the subject count / gender as a TAG.
 * Covers the canonical Danbooru forms (`1girl`, `1boy`, `1futa`, `2girls`, `6+girls`) and the
 * malformed `1_girl` / `1 girl` variants models occasionally emit.
 */
function hasSubjectTag(prompt) {
  return /\b\d+\+?\s*[ -_]?(girl|girls|boy|boys|futa|other)s?\b/i.test(String(prompt || ''));
}

/**
 * Last-resort guard: make sure a subject/gender TAG exists before the prompt is sent out.
 *
 * Every Danbooru-tag-driven model keys identity off this tag; without it the subject count is
 * unconstrained (a multi-character base model can split the canvas, or drop the character).
 * The prompt builders are supposed to supply it — this only fires when they did not, and it
 * never touches a prompt that already declares a count (`2girls`, `1girl, 1boy`, …).
 *
 * Returns { prompt, injected } so the caller can log/assert.
 */
function ensureSubjectTag(prompt, type, portrait) {
  if (hasSubjectTag(prompt)) return { prompt, injected: null };
  // Prefer the roster gender when we have it, so a male character is not forced to `1girl`.
  let tag = '1girl';
  if (portrait && typeof portrait === 'object') {
    const rg = String(portrait['种族性别'] || portrait.gender || '').toLowerCase();
    if (/(^|_)boy$/.test(rg)) tag = '1boy';
    else if (/(^|_)futa$/.test(rg)) tag = '1futa';
  } else if (isAnimaHybridPrompt(prompt)) {
    // Hybrid prompt with no subject tag: insert at the head of the Hard-Tags line so the tag
    // stays in the tags layer instead of leaking into the caption.
    const nl = String(prompt).indexOf('\n');
    const head = nl < 0 ? String(prompt) : String(prompt).slice(0, nl);
    const tail = nl < 0 ? '' : String(prompt).slice(nl);
    return { prompt: `${head.replace(/,\s*$/, '')}, ${tag}${tail}`, injected: tag };
  }
  return { prompt: `${tag}, ${prompt}`, injected: tag };
}

/**
 * 纯场景图（NSFW 流程结束图）提示词规范化。
 *
 * 这类图**画面里不能有任何人**：它是 NSFW 剧情收尾时的一张空镜，靠"没有人物"本身
 * 表示流程结束。所以必须做到三件事，缺一件就会被下游模型画出人来：
 *   1) 清掉一切人物/人数标签（1girl / 1boy / 2girls / solo / male …）与
 *      `character:` / `participant:` 之类的人物字段；
 *   2) 清掉 nsfw / explicit / sensitive 分级，强制成 `safe`（SFW）；
 *   3) 强制补 `no_humans`（Danbooru 系模型唯一可靠的"无人物"约束）。
 *
 * 兼容 Anima 两层结构：只清洗 Hard-Tags 行，自然语言层原样保留。
 */
function enforceSceneOnlyPrompt(prompt) {
  const personTagRe = /\b\d+\+?\s*[ -_]?(girl|girls|boy|boys|futa|other)s?\b/i;
  const personWordRe = /^(solo|male|female|man|woman|boy|girl|1other|multiple_others)$/i;
  // 标签里"夹着"人物词的（girl_on_top / two_people / male_focus …）也要清：
  // 只按"人数标签"（1girl 这种）清是不够的，模型经常漏写数字。
  const personInlineRe = /(^|[_ -])(girl|girls|boy|boys|futa|person|people|human|woman|man|male|female|loli|shota)($|[_ -])/i;
  const ratingRe = /^(safe|sensitive|nsfw|explicit|questionable)$/i;
  const fieldRe = /^[\w\u4e00-\u9fff]+\s*[:：]\s*/;
  // 人物 / 身体 / 性行为相关标签：**画面里其实还有个人**的强暗示。
  // 实测见过管家把上一张 NSFW CG 的 `completely_nude` 一起带进空镜 —— 这类标签
  // 不剔掉，空镜里就会站个人，"没有人"这个语义就废了（该图靠"无人物"表示流程结束）。
  const bodyTagRe = new RegExp('^(?:' + [
    'completely_nude', 'nude', 'naked', 'topless', 'bottomless', 'undressed', 'clothed', 'partially_clothed', 'exposed',
    'nipples?', 'areolae?', 'breasts?', 'cleavage', 'pussy', 'penis', 'anus', 'anal', 'ass', 'buttocks',
    'thighs?', 'legs?', 'feet', 'hands?', 'fingers?', 'arms?', 'shoulders?', 'collarbone',
    'mouth', 'tongue', 'teeth', 'lips', 'face', 'faces', 'eyes?', 'eyelashes', 'hair', 'skin', 'body', 'torso', 'pov',
    'blush', 'flushed_face', 'sweat', 'saliva', 'ahegao', 'orgasm', 'climax', 'cum', 'semen',
    'sex', 'vaginal', 'fellatio', 'cunnilingus', 'masturbation', 'penetration', 'spread_legs', 'presenting',
    'lingerie', 'underwear', 'panties', 'bra', 'bikini', 'swimsuit', 'dress', 'skirt', 'shirt', 'uniform',
    'bondage', 'bdsm', 'restrained', 'leash', 'collared',
  ].join('|') + ')$', 'i');
  // 去掉权重装饰（{{tag}} / (tag:1.2)）后再判定
  const bareTag = (t) => String(t).trim()
    .replace(/^[({[]+/, '').replace(/[)}\]]+$/, '')
    .replace(/:\s*[\d.]+$/, '').trim();
  const isPersonish = (t) => {
    const b = bareTag(t);
    return personTagRe.test(b) || personWordRe.test(b) || personInlineRe.test(b) || bodyTagRe.test(b.replace(/[ -]/g, '_'));
  };
  const cleanSceneLine = (line) => {
    const tags = String(line || '')
      .split(',')
      .map(t => t.trim().replace(fieldRe, '').trim())
      .filter(Boolean)
      .filter(t => !isPersonish(t) && !ratingRe.test(bareTag(t)))
      .filter(t => !/^(no_humans|scenery|background)$/i.test(bareTag(t))); // 由系统统一补，避免重复
    const out = ['safe', 'no_humans'];
    for (const t of tags) {
      if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out.join(', ');
  };
  if (isAnimaHybridPrompt(prompt)) {
    const lines = String(prompt).replace(/\r\n/g, '\n').split('\n');
    const hardLine = lines.shift();
    const caption = lines.join('\n').replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
    return caption ? `${cleanSceneLine(hardLine)}\n\n${caption}` : cleanSceneLine(hardLine);
  }
  return cleanSceneLine(prompt);
}

function cleanPortraitPrompt(prompt, culture) {
  // Anima two-layer portrait: clean the Hard-Tags line only and keep the caption verbatim,
  // exactly like cleanCGPrompt — flattening would turn the caption into comma-separated
  // fragments and destroy the tag/caption boundary the model reads.
  let hardLine = prompt;
  let caption = '';
  if (isAnimaHybridPrompt(prompt)) {
    const lines = String(prompt).replace(/\r\n/g, '\n').split('\n');
    hardLine = lines.shift();
    caption = lines.join('\n').replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }

  let tags = String(hardLine).split(',').map(t => t.trim()).filter(Boolean);

  // 1. Filter out lower-body / full-body keywords
  tags = tags.filter(tag => {
    const lower = tag.toLowerCase().replace(/\+/g, ' ');
    return !BODY_FILTER.some(word => lower.includes(word));
  });

  // 2. Ensure portrait tag (headshot indicator)
  if (!tags.some(t => t.toLowerCase() === 'portrait')) {
    const idx = tags.findIndex(t => t.includes('1girl') || t.includes('1boy') || t.includes('1futa') || t.includes('solo'));
    if (idx >= 0) tags.splice(idx + 1, 0, 'portrait');
    else tags.splice(2, 0, 'portrait');
  }

  // 3. Ensure close-up tag for headshot
  if (!tags.some(t => t.toLowerCase() === 'close-up' || t.toLowerCase() === 'closeup')) {
    const idx = tags.findIndex(t => t === 'portrait');
    if (idx >= 0) tags.splice(idx + 1, 0, 'close-up');
    else tags.push('close-up');
  }

  // 4. Remove conflicting full-body / cowboy-shot tags
  tags = tags.filter(t => !/^(full_body|cowboy_shot|full-body|cowboy-shot)$/i.test(t.trim()));

  // 5. Wuxia clothing restriction: replace non-compatible clothing with hanfu
  if (culture === 'wuxia') {
    injectHanfuClothing(tags);
  }

  const cleanedTags = tags.join(', ');
  if (!caption) return cleanedTags;
  return cleanedTags ? `${cleanedTags}\n\n${caption}` : caption;
}

/**
 * Replace/reduce clothing tags to hanfu or hanfu+dress for wuxia contexts.
 * If no clothing tag found, insert hanfu after appearance-related tags.
 */
function injectHanfuClothing(tags) {
  let hasClothing = false;
  for (let i = 0; i < tags.length; i++) {
    const lower = tags[i].toLowerCase().replace(/\+/g, ' ').trim();
    if (CLOTHING_TAGS.some(ct => lower === ct || lower.includes(ct))) {
      tags[i] = 'hanfu';
      hasClothing = true;
    }
  }
  if (!hasClothing) {
    // Insert hanfu after '1girl'/'1boy'/'1futa' or 'solo' tag
    const idx = tags.findIndex(t => t.includes('1girl') || t.includes('1boy') || t.includes('1futa') || t.includes('solo'));
    if (idx >= 0) tags.splice(idx + 1, 0, 'hanfu');
    else tags.splice(2, 0, 'hanfu');
  }
}
const WUXIA_KEYWORDS = ['武侠', '修仙', '仙侠', '修真', '江湖', '宗门', '道长', '剑仙', '修为', '功法', '炼丹'];

function detectWuxia(portrait, conversation_id) {
  // Check portrait fields (support both old and new format fields)
  const fields = [
    portrait.temperament, portrait.clothing, portrait.relationship, portrait.appearance,
    portrait['上衣'], portrait['下装'], portrait['简要介绍'], portrait['道德']
  ].filter(Boolean).join(' ');
  if (WUXIA_KEYWORDS.some(k => fields.includes(k))) return true;
  return false;
}

function injectAgeTag(prompt, portrait, conversation_id, db) {
  let tag = null;
  const age = (portrait.age || portrait['年龄段'] || portrait['年龄'] || '').toLowerCase();

  // Check wuxia context: portrait fields + character data
  const isWuxia = detectWuxia(portrait, conversation_id);
  if (isWuxia) {
    tag = 'xianzi';
  } else if (AGE_TAGS[age]) {
    tag = AGE_TAGS[age];
  }

  if (!tag) return prompt;

  // Inject tag after the first gender/solo tag (works regardless of quality prefix)
  const genderIdx = prompt.search(/\b1(girl|boy|futa)|solo\b/);
  if (genderIdx >= 0) {
    // Find comma after the gender/solo tag
    const afterTag = prompt.indexOf(',', genderIdx);
    const insertPos = afterTag >= 0 ? afterTag + 1 : prompt.length;
    const injected = prompt.slice(0, insertPos) + tag + ',' + prompt.slice(insertPos);
    console.log('[ImageGen] Age tag injected:', tag, 'for age:', age);
    return injected;
  }
  // Fallback: prepend
  console.log('[ImageGen] Age tag prepended:', tag);
  return tag + ',' + prompt;
}

function pickRandomProfile(tag) {
  const folder = path.join(PROFILE_DIR, tag);
  if (!fs.existsSync(folder)) return null;
  const files = fs.readdirSync(folder).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  if (files.length === 0) return null;
  const picked = files[Math.floor(Math.random() * files.length)];
  return { path: path.join(folder, picked), name: picked };
}

/**
 * Apply prompt to a workflow's positive prompt node (auto-detected).
 * Configured node IDs act only as manual overrides; empty = auto-detect
 * from the graph structure, so any workflow/model works without edits.
 * @param {object} workflow - Parsed ComfyUI workflow JSON
 * @param {string} prompt - The cleaned prompt text to inject
 * @param {object} settings - image_settings row from DB
 * @param {string} type - 'portrait' or 'cg'
 */
/* ============================================================================
 * Workflow-agnostic prompt node resolution
 * ----------------------------------------------------------------------------
 * Every ComfyUI workflow exposes the prompt differently, so NO node id may be
 * hard-coded. Observed layouts in the wild:
 *   - classic : KSampler.positive -> CLIPTextEncode.text (plain string)
 *   - krea/LLM: KSampler.positive -> CLIPTextEncode.text ->[link]-> Switch
 *               -> ... -> PrimitiveStringMultiline.value ("User Prompt")
 *   - legacy  : placeholder string inside CLIPTextEncode
 * Instead of guessing ids, we walk the graph backwards from the sampler and
 * score the textual sinks we reach.
 * ========================================================================== */

// Node classes holding a plain, user-editable string (ComfyUI primitive widgets)
const STRING_NODE_RE = /^(PrimitiveString|StringLiteral|StringConstant|StringFunction|MultilineString|TextMultiline|ShowText|SimpleString|Text|String)$/i;
// Node classes that encode text into conditioning
const ENCODE_NODE_RE = /(CLIPTextEncode|TextEncode|WildcardEncode|PromptStyler|PromptEncode)/i;
// Boolean/int/float primitives also carry `value`, but are NOT prompt sinks
const NON_TEXT_PRIMITIVE_RE = /^Primitive(Boolean|Int|Float|Number)/i;

/** True when an input value is a graph link `[nodeId, outputIndex]` rather than a literal. */
function isLink(v) {
  return Array.isArray(v) && v.length >= 2 &&
    (typeof v[0] === 'string' || typeof v[0] === 'number');
}

/**
 * Field holding the text of a text-ish node, or null when the class is not textual.
 * - Primitive string widgets use `value`
 * - Text encoders use `text`
 * - Unknown classes qualify only if they already hold a string in one of those
 */
function getPromptInputKey(node) {
  if (!node || !node.inputs) return null;
  const ct = node.class_type || '';
  if (NON_TEXT_PRIMITIVE_RE.test(ct)) return null;
  if (STRING_NODE_RE.test(ct)) {
    if (node.inputs.value !== undefined) return 'value';
    if (node.inputs.text !== undefined) return 'text';
    return 'value';
  }
  if (ENCODE_NODE_RE.test(ct)) return 'text';
  if (typeof node.inputs.text === 'string') return 'text';
  if (typeof node.inputs.value === 'string') return 'value';
  return null;
}

/**
 * Collect every node id reachable by following links from `startLinks`,
 * crossing pass-through nodes (switches, routers, concatenators, previews...).
 */
function collectReachable(workflow, startLinks) {
  const seen = new Set();
  const queue = [...startLinks];
  while (queue.length) {
    const link = queue.shift();
    if (!isLink(link)) continue;
    const nid = String(link[0]);
    if (seen.has(nid)) continue;
    const node = workflow[nid];
    if (!node) continue;
    seen.add(nid);
    for (const v of Object.values(node.inputs || {})) {
      if (isLink(v)) queue.push(v);
    }
  }
  return seen;
}

/** Semantic score for a candidate prompt sink. Higher = more likely the user prompt. */
function scorePromptNode(workflow, nid, negOnly) {
  const node = workflow[nid];
  const ct = node.class_type || '';
  const title = node._meta?.title || '';
  let score = 0;
  if (/(positive|user|用户输入|正向)[\s_\-\(]*prompt|用户输入|用户提示|正向提示/i.test(title)) score += 120;
  else if (/prompt|提示词/i.test(title)) score += 20;
  if (/system[\s_\-\(]*prompt|系统提示/i.test(title)) score -= 90;
  if (/negative|负面|负向|反向|bad[\s_\-]*prompt|unwanted/i.test(title)) score -= 200;
  if (STRING_NODE_RE.test(ct)) score += 40;
  if (ENCODE_NODE_RE.test(ct)) score += 15;
  if (negOnly) score -= 150;
  const key = getPromptInputKey(node);
  const val = key ? node.inputs[key] : '';
  if (typeof val === 'string' && val.trim().length > 0) score += 5;
  if (/placeholder|PROMPT_HERE/i.test(String(val))) score += 30; // explicit placeholder slot
  return score;
}

/**
 * Resolve the node that should receive a prompt, for any workflow layout.
 * @param {object} workflow - parsed workflow
 * @param {'positive'|'negative'} branch - which sampler input to trace back from
 * @param {string} preferredId - explicit node id from settings (empty = auto)
 * @returns {{id:string,node:object,key:string,source:string}|null}
 */
function resolvePromptNode(workflow, branch, preferredId) {
  // 1) Explicit configuration wins, as long as the node exists and is textual.
  if (preferredId && workflow[preferredId]) {
    const key = getPromptInputKey(workflow[preferredId]);
    if (key) return { id: preferredId, node: workflow[preferredId], key, source: 'configured' };
    console.warn(`[ImageGen] Configured ${branch} node ${preferredId} (${workflow[preferredId].class_type}) is not textual; auto-detecting.`);
  }

  // Structural sampler detection: any node exposing BOTH `positive` and
  // `negative` conditioning inputs is a sampler, regardless of class name.
  // This covers KSampler, SamplerCustom, ClownsharKSampler, and any future /
  // custom sampler without maintaining a class whitelist.
  const samplers = Object.values(workflow).filter((n) =>
    n && n.inputs && isLink(n.inputs.positive) && isLink(n.inputs.negative));
  const posLinks = [], negLinks = [];
  for (const n of samplers) {
    posLinks.push(n.inputs.positive);
    negLinks.push(n.inputs.negative);
  }
  const ownLinks = branch === 'negative' ? negLinks : posLinks;
  const otherLinks = branch === 'negative' ? posLinks : negLinks;
  const ownReach = collectReachable(workflow, ownLinks);
  const otherReach = collectReachable(workflow, otherLinks);

  const seenCand = new Set();
  const candidates = [];
  const consider = (nid) => {
    if (seenCand.has(nid)) return;
    const node = workflow[nid];
    if (!node) return;
    const key = getPromptInputKey(node);
    if (!key) return;
    const val = node.inputs ? node.inputs[key] : undefined;
    // Never write into a field that is wired to another node — that would sever
    // the graph. Only plain strings (or empty slots) are valid sinks.
    if (isLink(val)) return;
    if (val !== undefined && typeof val !== 'string') return;
    seenCand.add(nid);
    candidates.push({
      id: nid, node, key,
      score: scorePromptNode(workflow, nid, otherReach.has(nid) && !ownReach.has(nid)),
      onBranch: ownReach.has(nid),
    });
  };

  const pools = [];
  for (const nid of ownReach) consider(nid);
  pools.push({ pool: candidates.filter(c => c.onBranch), source: 'sampler-trace' });
  pools.push({ pool: candidates.filter(c => !c.onBranch), source: 'graph-scan' });

  let chosen = null;
  for (const { pool, source } of pools) {
    if (!pool.length) continue;
    pool.sort((a, b) => b.score - a.score);
    chosen = { id: pool[0].id, node: pool[0].node, key: pool[0].key, source };
    if (pool.length > 1) {
      console.log(`[ImageGen] ${branch} node candidates (${source}): ` +
        pool.map(c => `${c.id}(${c.node.class_type}|${c.key})=${c.score}`).join(', '));
    }
    break;
  }
  return chosen;
}

function applyNodeSettings(workflow, prompt, settings, type) {
  // Node ids are resolved from the graph, never hard-coded: the configured id is
  // only a manual override (leave it empty for auto-detection).
  const configuredPosId = type === 'portrait'
    ? (settings?.portrait_positive_node || '')
    : (settings?.cg_positive_node || '');
  const configuredNegId = type === 'portrait'
    ? (settings?.portrait_negative_node || '')
    : (settings?.cg_negative_node || '');
  const customNegPrompt = type === 'portrait'
    ? (settings?.portrait_negative_prompt || '')
    : (settings?.cg_negative_prompt || '');

  // --- Positive prompt node ---
  const pos = resolvePromptNode(workflow, 'positive', configuredPosId);
  if (!pos) {
    console.warn(`[ImageGen] No prompt node found in workflow (type=${type}); prompt NOT injected.`);
    console.warn(`[ImageGen] Workflow node types:`, Object.entries(workflow).map(([n, v]) => `${n}=${v.class_type}`).join(', '));
  } else {
    pos.node.inputs[pos.key] = prompt;
    const nodeText = pos.node.inputs[pos.key];
    const genderInNode = nodeText.match(/1(girl|boy|futa)/g);
    console.log(`[ImageGen] Positive node=${pos.id} (class=${pos.node.class_type}, field=${pos.key}, via=${pos.source}, type=${type}) gender:`, genderInNode || 'NONE',
      'prompt HEAD:', nodeText.substring(0, 80), 'TAIL:', nodeText.slice(-80));
    if (nodeText !== prompt) {
      console.error(`[ImageGen] CRITICAL: workflow node ${pos.id} override failed!`);
    }
    // Defensive single-injection guard: ensure the prompt lives in exactly ONE node.
    // If the workflow graph ever routes it into multiple text encoders, the model would
    // treat it as two segments and draw two subjects ("left-right merged" artifacts).
    let promptNodes = 0;
    for (const [nid, node] of Object.entries(workflow)) {
      for (const f of ['text', 'value']) {
        if (typeof node.inputs?.[f] === 'string' && node.inputs[f] === prompt) promptNodes++;
      }
    }
    if (promptNodes !== 1) {
      console.error(`[ImageGen] SINGLE-INJECTION GUARD: prompt found in ${promptNodes} nodes (expected 1)! type=${type} posId=${pos.id}`);
    }
  }

  // --- Custom negative prompt (optional; many workflows zero out the negative) ---
  if (customNegPrompt && customNegPrompt.trim()) {
    const neg = resolvePromptNode(workflow, 'negative', configuredNegId);
    if (neg) {
      neg.node.inputs[neg.key] = customNegPrompt.trim();
      console.log(`[ImageGen] Applied custom negative prompt to node ${neg.id} (class=${neg.node.class_type}, field=${neg.key}, via=${neg.source}, type=${type})`);
    } else {
      console.warn(`[ImageGen] No negative node found in workflow (type=${type}), custom negative prompt ignored`);
    }
  } else {
    console.log(`[ImageGen] Using workflow default negative prompt (type=${type})`);
  }
}

/**
 * Parse generation params stored in image_settings.custom_params (JSON string).
 * Supported: width, height, steps, cfg, sampler, scheduler, seed.
 * Empty/0 numeric values and empty strings = keep workflow defaults;
 * seed '' / null / -1 = randomize each run.
 */
function getGenerationParams(settings) {
  try {
    const p = JSON.parse(settings?.custom_params || '{}') || {};
    let seed = p.seed;
    seed = (seed === '' || seed === null || seed === undefined) ? -1 : parseFloat(seed);
    if (!isFinite(seed)) seed = -1;
    return {
      width: parseInt(p.width, 10) || 0,
      height: parseInt(p.height, 10) || 0,
      steps: parseInt(p.steps, 10) || 0,
      cfg: parseFloat(p.cfg) || 0,
      sampler: (p.sampler || '').trim(),
      scheduler: (p.scheduler || '').trim(),
      seed: (seed >= 0) ? Math.floor(seed) : -1,
    };
  } catch { return {}; }
}

/**
 * Apply generation params onto a parsed ComfyUI workflow.
 * Called AFTER seed randomization so an explicit seed param wins.
 * Workflow-agnostic: params land on nodes that structurally expose the
 * matching input fields (any sampler class, not just KSampler).
 */
function applyGenerationParams(workflow, params) {
  if (!params) return;
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    // Latent source: any node producing width/height (EmptyLatentImage and
    // custom variants alike).
    if (typeof node.inputs.width === 'number' && typeof node.inputs.height === 'number') {
      if (params.width > 0) node.inputs.width = params.width;
      if (params.height > 0) node.inputs.height = params.height;
    }
    // Sampler: any node exposing the sampler tuning inputs.
    if ('seed' in node.inputs && 'steps' in node.inputs) {
      if (params.steps > 0) node.inputs.steps = params.steps;
      if (params.cfg > 0 && 'cfg' in node.inputs) node.inputs.cfg = params.cfg;
      if (params.sampler && 'sampler_name' in node.inputs) node.inputs.sampler_name = params.sampler;
      if (params.scheduler && 'scheduler' in node.inputs) node.inputs.scheduler = params.scheduler;
      if (params.seed >= 0) node.inputs.seed = params.seed;
    }
  }
}

module.exports = (db) => {
  const router = Router();

  // 把「读代理配置」的能力交给顶层生成辅助函数（它们在本闭包之外，见 resolveImageProxy）
  setAppProxyProvider(() => {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'proxy_config'").get();
    return row && row.value ? JSON.parse(row.value) : null;
  });

  router.use('/files', (req, res) => {
    const requestedPath = req.path.replace(/^\/+/, '');
    const filePath = path.resolve(IMAGES_DIR, requestedPath);
    // Prevent path traversal: resolved path must stay within IMAGES_DIR
    if (!filePath.startsWith(IMAGES_DIR + path.sep)) {
      return res.status(403).send('Forbidden');
    }
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send('Not found');
    }
  });

  router.get('/', (req, res) => {
    const row = db.prepare('SELECT * FROM image_settings WHERE id = ?').get(SETTINGS_ID);
    if (!row) return res.json(row);
    // Surface anima-turbo-cg's preset so the Settings UI renders a working endpoint even
    // when the row is bare (older DB, or a cleared field).  Only the anima engine does
    // this — `openai` / `stability` must stay blank until the user fills them in.
    if (row.mode === ANIMA_PRESET.MODE) {
      const ep = resolveExternalEndpoint(ANIMA_PRESET.MODE, row);
      row.api_url = ep.apiUrl;
      row.api_key = ep.apiKey;
      row.api_model = ep.apiModel;
      if (!row.image_size) row.image_size = ANIMA_PRESET.IMAGE_SIZE;
      if (!row.comfyui_url) row.comfyui_url = DEFAULT_COMFYUI_URL;
    } else if (row.mode === NOVELAI_PRESET.MODE) {
      // Surface NovelAI's fixed endpoint/model so the Settings UI renders a working
      // config even on a bare row.  api_key is deliberately NOT defaulted — it is the
      // user's Persistent API Token.
      const ep = resolveExternalEndpoint(NOVELAI_PRESET.MODE, row);
      row.api_url = ep.apiUrl;
      row.api_model = ep.apiModel;
      if (!row.image_size) row.image_size = NOVELAI_PRESET.IMAGE_SIZE;
    }
    // 历史坏值（如 `1536X1024`）在返回给界面时就规范化：用户一打开设置页看到的就是
    // 正确写法，保存一次即可把库里的坏值覆盖掉（本地引擎只认小写 x，见 utils/imageSize.js）。
    if (row.image_size) row.image_size = normalizeImageSize(row.image_size) || row.image_size;
    res.json(row);
  });

  // 代理拉取服务端模型列表（避免浏览器 CORS，密钥不暴露到前端）
  router.post('/models', async (req, res) => {
    let { api_url, api_key } = req.body || {};
    if (typeof api_url === 'string') api_url = api_url.trim();
    if (typeof api_key === 'string') api_key = api_key.trim();
    // NovelAI 没有 OpenAI 风格的 /models 端点，其模型清单是固定的，直接返回
    if (api_url && /novelai\.net/i.test(api_url)) {
      return res.json({ models: NOVELAI_PRESET.MODELS.slice() });
    }
    // 未传则用已保存的设置
    if (!api_url) {
      const row = db.prepare('SELECT * FROM image_settings WHERE id = ?').get(SETTINGS_ID);
      // anima 引擎的端点有内置默认值，字段留空时也能拉模型列表
      api_url = resolveExternalEndpoint(row && row.mode, row).apiUrl;
      if (!api_key) api_key = (row && row.api_key) || '';
    }
    if (!api_url) return res.status(400).json({ error: '未配置 API 地址' });
    // 由生图端点推导 /models 基址：去掉末尾 /images/generations 等后缀
    const base = api_url.replace(/\/images\/generations\/?$/i, '').replace(/\/+$/, '');
    const modelsUrl = base + '/models';
    try {
      const headers = { 'Authorization': 'Bearer ' + (api_key || '') };
      const r = await fetch(modelsUrl, { headers });
      if (!r.ok) {
        let detail = '';
        try { const e = await r.json(); detail = e.error || e.message || ''; } catch (_) {}
        return res.status(r.status).json({ error: '拉取模型失败 (HTTP ' + r.status + ')' + (detail ? ': ' + detail : '') });
      }
      const j = await r.json();
      const models = Array.isArray(j.data)
        ? j.data.map(m => String(m.id != null ? m.id : m.name || '').trim()).filter(Boolean)
        : [];
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: '拉取模型失败: ' + e.message });
    }
  });

  router.put('/', (req, res) => {
    let { mode, comfyui_url, api_url, api_key, model,
      gen_mode, portrait_quality_prefix, cg_quality_prefix,
      portrait_positive_node, portrait_negative_node,
      cg_positive_node, cg_negative_node,
      portrait_negative_prompt, cg_negative_prompt,
      cg_workflow, portrait_workflow,
      api_model, quality_prefix, image_size, custom_params } = req.body;
    // custom_params: JSON string of generation params (width/height/steps/cfg/sampler/scheduler/seed)
    if (custom_params !== undefined && custom_params !== null && typeof custom_params !== 'string') {
      custom_params = JSON.stringify(custom_params);
    }
    // 去除 API 地址/密钥首尾空白，避免用户复制粘贴时带入空格导致请求发到错误地址
    if (typeof api_url === 'string') api_url = api_url.trim();
    if (typeof api_key === 'string') api_key = api_key.trim();
    if (typeof comfyui_url === 'string') comfyui_url = comfyui_url.trim();
    // 工作流文件名：仅接受项目根目录下的裸文件名（后端 getWorkflowFile 会再校验）
    if (typeof cg_workflow === 'string') cg_workflow = cg_workflow.trim();
    if (typeof portrait_workflow === 'string') portrait_workflow = portrait_workflow.trim();
    // 尺寸落库前规范化（前端已经是「宽/高两个格子」，这里是给 API 调用方与历史值兜底）：
    // `1536X1024` → `1536x1024`。anima/sd.cpp 只认小写 x，别的写法会被静默忽略。
    if (image_size !== undefined && image_size !== null) {
      const before = String(image_size).trim();
      image_size = normalizeImageSize(before);
      if (before && !image_size) {
        console.warn('[ImageGen] 尺寸 "%s" 无法解析为「宽x高」，已按"不指定尺寸"保存（引擎将用自身默认值）', before);
      } else if (image_size && image_size !== before) {
        console.log('[ImageGen] 尺寸已规范化：%s → %s', before, image_size);
      }
    }
    db.prepare(`UPDATE image_settings SET
      mode=COALESCE(?,mode), comfyui_url=COALESCE(?,comfyui_url),
      api_url=COALESCE(?,api_url), api_key=COALESCE(?,api_key), model=COALESCE(?,model),
      gen_mode=COALESCE(?,gen_mode),
      portrait_quality_prefix=COALESCE(?,portrait_quality_prefix),
      cg_quality_prefix=COALESCE(?,cg_quality_prefix),
      portrait_positive_node=COALESCE(?,portrait_positive_node),
      portrait_negative_node=COALESCE(?,portrait_negative_node),
      cg_positive_node=COALESCE(?,cg_positive_node),
      cg_negative_node=COALESCE(?,cg_negative_node),
      portrait_negative_prompt=COALESCE(?,portrait_negative_prompt),
      cg_negative_prompt=COALESCE(?,cg_negative_prompt),
      cg_workflow=COALESCE(?,cg_workflow),
      portrait_workflow=COALESCE(?,portrait_workflow),
      api_model=COALESCE(?,api_model),
      quality_prefix=COALESCE(?,quality_prefix),
      image_size=COALESCE(?,image_size),
      custom_params=COALESCE(?,custom_params)
      WHERE id = ?`)
      .run(mode, comfyui_url, api_url, api_key, model,
        gen_mode, portrait_quality_prefix, cg_quality_prefix,
        portrait_positive_node, portrait_negative_node,
        cg_positive_node, cg_negative_node,
        portrait_negative_prompt, cg_negative_prompt,
        cg_workflow, portrait_workflow,
        api_model, quality_prefix, image_size, custom_params, SETTINGS_ID);
    res.json({ message: 'Saved' });
  });

  // Regenerate with same prompt (no AI involved)
  router.post('/regenerate', async (req, res) => {
    const { prompt, type, character_name, conversation_id, culture, old_filename } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const settings = db.prepare('SELECT * FROM image_settings WHERE id = ?').get(SETTINGS_ID);
    const genMode = (settings && settings.mode) || 'anima';
    res.json({ message: 'Regeneration queued', status: 'pending' });

    // --- ComfyUI URL (external instance) ---
    let comfyUrl = (settings?.comfyui_url || DEFAULT_COMFYUI_URL);
    let comfyWaitSec = 60;

    // Find save and old gallery entry
    // `old_filename` (optional) lets the caller say exactly which CG to replace.
    // Without it we fall back to gallery[0] — which is only correct when the user is
    // regenerating the newest CG (the common case: just-generated image, unhappy with it).
    let oldFilename = null;
    let replaceIndex = 0;
    if (conversation_id) {
      try {
        const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
        if (save) {
          const gp = path.join(save.save_path, 'cg_gallery.json');
          try {
            const gallery = JSON.parse(fs.readFileSync(gp, 'utf-8'));
            if (Array.isArray(gallery) && gallery.length > 0) {
              let idx = 0;
              if (old_filename) {
                const want = String(old_filename);
                const found = gallery.findIndex(g => g && String(g.filename || g.file || '') === want);
                if (found >= 0) idx = found;
                else console.warn('[ImageGen-Regen] old_filename not found in gallery, falling back to newest:', want);
              }
              replaceIndex = idx;
              oldFilename = gallery[idx].filename;
              console.log('[ImageGen-Regen] replacing gallery entry #' + idx + ':', oldFilename);
            }
          } catch { }
        }
      } catch { }
    }

    if (genMode === 'none') {
      const result = fallbackFromProfileWithDB(db, conversation_id, character_name, 'teen');
      if (result) console.log('[ImageGen] Regenerated (fallback):', result.filename);
      return;
    }

    // Boost 1boy weight for male characters
    let boostedPrompt = prompt;
    if (prompt.includes('1boy') && !prompt.includes('(1boy:')) {
      boostedPrompt = prompt.replace(/\b1boy\b/, '(1boy:1.3)');
      console.log('[ImageGen-Regen] Boosted 1boy weight to (1boy:1.3)');
    }

    // --- External API regeneration (anima-turbo-cg / OpenAI-compatible / Stability) ---
    // Without this branch the CG「重新生成」button always fell through to the ComfyUI path,
    // which is meaningless when the user's engine is anima-turbo-cg (no workflow, no ComfyUI).
    if (EXTERNAL_IMAGE_MODES.includes(genMode)) {
      const { apiUrl, apiKey } = resolveExternalEndpoint(genMode, settings);
      if (!apiUrl) {
        console.error('[ImageGen-Regen] External API URL not configured (mode=' + genMode + ')');
        return;
      }
      try {
        const result = await generateViaExternalAPI(boostedPrompt, genMode, apiUrl, apiKey, settings, type);
        if (!result || (!result.url && !result.b64)) return;
        const charName = (character_name || 'character').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        // 扩展名按内容判定（见 sniffImageExt）
        const buf = result.b64 ? Buffer.from(result.b64, 'base64') : null;
        const ext = buf ? sniffImageExt(buf) : 'jpg';
        const filename = `${charName}_${Date.now()}.${ext}`;
        const savePath = path.join(IMAGES_DIR, filename);
        if (result.url) await downloadExternalImage(result.url, savePath);
        else fs.writeFileSync(savePath, buf);
        const replaced = replaceGalleryEntry(db, conversation_id, oldFilename, filename, savePath, prompt, character_name);
        console.log('[ImageGen] Regenerated via ' + genMode + ':', filename, replaced ? '' : '（⚠ 画廊条目未替换，详见错误日志）');
      } catch (err) {
        console.error('[ImageGen-Regen] External API failed (mode=' + genMode + '):', {
          message: err.message, genMode, type, character_name, conversation_id,
          promptHead: (prompt || '').substring(0, 150),
        });
      }
      return;
    }

    try {
      const workflowFile = getWorkflowFile(type, settings);
      if (!fs.existsSync(workflowFile)) return;
      let workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf-8'));

      // Apply node settings (positive/negative node IDs, custom negative prompt)
      applyNodeSettings(workflow, boostedPrompt, settings, type);

      // Normalize model names to match ComfyUI's filesystem index (case-insensitive on Windows)
      await normalizeWorkflowModels(workflow, comfyUrl);

        // Randomize seed on all sampler nodes (structural: has seed+steps), then apply explicit user params (seed param wins)
        for (const [nid, node] of Object.entries(workflow)) {
          if (node.inputs && 'seed' in node.inputs && 'steps' in node.inputs) {
            node.inputs.seed = Math.floor(Math.random() * 9999999999999);
          }
        }
        applyGenerationParams(workflow, getGenerationParams(settings));

        const submitUrl = new URL('/prompt', comfyUrl.replace(/\/$/, ''));
      const promptId = await httpPost(submitUrl, { prompt: workflow });
      if (!promptId) return;
      const outputImage = await waitForComfyUI(comfyUrl, promptId, comfyWaitSec);
      if (!outputImage) return;

      // Use new filename (cache-bust) and replace gallery entry
      const charName = (character_name || 'character').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const filename = `${charName}_${Date.now()}.jpg`;
      const savePath = path.join(IMAGES_DIR, filename);
      await downloadImage(comfyUrl, outputImage, savePath);

      // Copy to save folder and update gallery
      if (conversation_id) {
        try {
          const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
          if (save) {
            const destDir = path.join(save.save_path, 'images');
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(savePath, path.join(destDir, filename));
            // Delete old image
            if (oldFilename && oldFilename !== filename) {
              const oldPath = path.resolve(destDir, oldFilename);
              if (isPathWithin(destDir, oldPath)) {
                try { fs.unlinkSync(oldPath); } catch { }
              }
            }
            // Replace gallery entry（用 replaceIndex，而不是写死 gallery[0]：
            // 用户可能正在重画一张较旧的 CG）
            const gp = path.join(save.save_path, 'cg_gallery.json');
            try {
              const gallery = JSON.parse(fs.readFileSync(gp, 'utf-8'));
              const k = (typeof replaceIndex === 'number' && replaceIndex >= 0 && replaceIndex < gallery.length) ? replaceIndex : 0;
              if (gallery.length > 0) {
                gallery[k].filename = filename;
                gallery[k].timestamp = new Date().toISOString();
                fs.writeFileSync(gp, JSON.stringify(gallery, null, 2), 'utf-8');
              }
            } catch { }
          }
        } catch { }
      }
      console.log('[ImageGen] Regenerated:', filename);
    } catch (err) {
      console.error('[ImageGen] Regenerate failed:', {
        message: err.message,
        stack: err.stack,
        type, character_name, conversation_id,
        promptHead: (prompt || '').substring(0, 150),
        genMode,
      });
    }
  });

  router.post('/generate', async (req, res) => {
    let { type, prompt, conversation_id, character_name, portrait, dry_run } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    // dry_run: return the exact prompt that WOULD be sent to the image model (after all cleaning
    // and tag injection) without queueing a generation. Used to verify prompt formatting.
    const dryRun = dry_run === true || dry_run === 'true';

    // === Final safety check: block portrait generation for protagonist/character card ===
    if (type === 'portrait' && character_name) {
      try {
        // Check if character_name matches the active user (protagonist)
        const userProfile = db.prepare('SELECT * FROM user_profile WHERE is_active = 1 LIMIT 1').get();
        if (userProfile && userProfile.name === character_name) {
          console.log('[ImageGen] BLOCKED: portrait generation for protagonist:', character_name);
          return res.json({ message: 'Skipped protagonist portrait', status: 'skipped' });
        }
        // Check if character_name matches the character card (not a dialogue character)
        if (conversation_id) {
          const conv = db.prepare('SELECT character_id FROM conversations WHERE id = ?').get(conversation_id);
          if (conv && conv.character_id) {
            const card = db.prepare('SELECT name FROM characters WHERE id = ?').get(conv.character_id);
            if (card && card.name === character_name) {
              console.log('[ImageGen] BLOCKED: portrait generation for character card:', character_name);
              return res.json({ message: 'Skipped character card portrait', status: 'skipped' });
            }
          }
        }
      } catch (e) { console.warn('[ImageGen] Safety check error:', e.message); }
    }

    const settings = db.prepare('SELECT * FROM image_settings WHERE id = ?').get(SETTINGS_ID);
    let comfyuiUrl = (settings && settings.comfyui_url) || DEFAULT_COMFYUI_URL;
    const genMode = (settings && settings.mode) || 'anima';

    // Extract culture from portrait metadata
    const culture = (portrait && typeof portrait === 'object') ? (portrait.culture || '') : '';

    // Clean prompt & inject age tag
    // 登场 CG（debut_cg）走同一套 CG 清洗，唯一区别：它是「角色登场」画面而不是 NSFW 场景图，
    // 因此【不强行插 nsfw】——安全分级由 chat.js 按当前场景给出（safe / nsfw）。
    const isDebutCg = type === 'cg' && req.body && req.body.debut_cg === true;
    // 纯场景图（NSFW 流程结束图）：type 仍是 cg（照常进 CG 画廊），但它【不含人物】。
    // 与登场 CG 一样关闭 nsfw 自动注入，并额外：强制 SFW 分级 + no_humans、不补人物/性别标签、
    // 不套用人物兜底图（见下方 fallbackTag 与 ensureSubjectTag 的分支）。
    const isSceneOnly = type === 'cg' && req.body && req.body.scene_only === true;
    if (type === 'portrait') {
      prompt = cleanPortraitPrompt(prompt, culture);
    } else if (type === 'cg') {
      prompt = cleanCGPrompt(prompt, { forceNsfw: !isDebutCg && !isSceneOnly });
      if (isDebutCg) console.log('[ImageGen] Debut CG — nsfw auto-injection disabled (safety rating comes from the scene)');
      if (isSceneOnly) {
        prompt = enforceSceneOnlyPrompt(prompt);
        console.log('[ImageGen] Scene-only CG (NSFW 流程结束图) — 强制 safe + no_humans 后的提示词:', prompt.slice(0, 140));
      }
    }
    if (portrait && typeof portrait === 'object') {
      prompt = injectAgeTag(prompt, portrait, conversation_id, db);
    }

    // Subject/gender tag guard: every downstream model keys identity off `1girl`/`1boy`/`1futa`.
    // This is a safety net for prompts built outside the normal pipeline (or by a weak model);
    // in the normal flow the tag is already present, so nothing is injected.
    {
      const guard = isSceneOnly ? { prompt, injected: null } : ensureSubjectTag(prompt, type, portrait);
      if (guard.injected) {
        console.warn(`[ImageGen] GUARD: prompt had no subject tag — injected "${guard.injected}" (type=${type})`);
      }
      prompt = guard.prompt;
    }
    if (isSceneOnly) {
      console.log('[ImageGen] Scene-only CG — subject-tag guard skipped (no humans in frame)');
    }

    console.log('[ImageGen] Final prompt HEAD (first 150):', prompt.substring(0, 150));
    console.log('[ImageGen] Final prompt TAIL (last 100):', prompt.slice(-100));
    console.log('[ImageGen] Final prompt total length:', prompt.length, 'chars');
    // Gender diagnostic. A Danbooru tag (`1girl` / `1boy` / `1futa`) is what tag-driven models
    // actually act on, so that is the thing worth flagging. The optional `[ -_]?` also catches the
    // malformed `1_girl` / `1 girl` variants that models occasionally emit, while prose carries
    // gender words — report those separately instead of pretending gender is missing.
    const genderTag = prompt.match(/1[ -_]?(girl|boy|futa)/g);
    const genderWords = prompt.match(/\b(man|woman|male|female|lady|gentleman)\b/gi);
    console.log('[ImageGen] Gender tags in final prompt:', genderTag || 'NONE',
      genderTag ? '' : '| prose gender words: ' + (genderWords ? [...new Set(genderWords.map(w => w.toLowerCase()))].join('/') : 'NONE'));
    if (!genderTag) {
      if (genderWords) {
        console.warn('[ImageGen] WARNING: no 1girl/1boy/1futa TAG (prose gender present — weaker identity control)');
      } else if (isSceneOnly) {
        console.log('[ImageGen] Scene-only CG — no gender signal by design (pure scenery, no humans)');
      } else {
        console.error('[ImageGen] ERROR: no gender signal at all (neither a tag nor a gender word) — prompt:', prompt.slice(0, 160));
      }
    }

    // Boost 1boy weight for models that are weak at male generation (Illustrious/Pony etc.)
    // Standard SD weighting: (tag:1.3) increases emphasis by 30%
    // NEVER do this for an Anima hybrid prompt: `(1boy:1.3)` is not a valid Danbooru tag and would
    // corrupt the Hard-Tags layer of a model that reads tags verbatim.
    if (prompt.includes('1boy') && !prompt.includes('(1boy:') && !isAnimaHybridPrompt(prompt)) {
      prompt = prompt.replace(/\b1boy\b/, '(1boy:1.3)');
      console.log('[ImageGen] Boosted 1boy weight to (1boy:1.3) for male character');
    } else if (prompt.includes('1boy') && isAnimaHybridPrompt(prompt)) {
      console.log('[ImageGen] Skipped (1boy:1.3) boost — Anima hybrid prompt (tags must stay verbatim)');
    }

    // dry_run: report the fully-processed prompt and stop before queueing any generation.
    if (dryRun) {
      return res.json({
        status: 'dry_run',
        type: type || null,
        promptLength: prompt.length,
        prompt,
        isAnimaHybrid: isAnimaHybridPrompt(prompt),
        hasChinese: /[\u4e00-\u9fff]/.test(prompt),
      });
    }

    res.json({ message: 'Generation queued', status: 'pending' });

    let comfyWaitSec = 60;
    const useComfy = (genMode === 'comfyui');

    // Determine fallback tag
    let fallbackTag = null;
    if (portrait && typeof portrait === 'object') {
      const age = (portrait.age || portrait['年龄段'] || portrait['年龄'] || '').toLowerCase();
      const isWuxia = detectWuxia(portrait, conversation_id);
      fallbackTag = isWuxia ? 'xianzi' : (AGE_TAGS[age] || 'teen');
    }
    // For CG without portrait info, default fallback tag（纯场景图没有人物，绝不能套人物兜底图）
    if (!fallbackTag && type === 'cg' && !isSceneOnly) {
      fallbackTag = 'teen'; // Default fallback for CG scenes
    }

    // If mode is 'none', skip generation, go straight to fallback
    if (genMode === 'none') {
      if (isSceneOnly) {
        console.log('[ImageGen] Scene-only CG skipped — image mode is off (无兜底图：纯场景不套用人物画像)');
        return;
      }
      console.log('[ImageGen] Mode=off, using profile fallback for tag:', fallbackTag);
      const result = fallbackFromProfileWithDB(db, conversation_id, character_name, fallbackTag || 'teen');
      if (result) console.log('[ImageGen] Fallback saved:', result.filename);
      return;
    }

    // --- External API generation (anima-turbo-cg / OpenAI-compatible / Stability) ---
    if (EXTERNAL_IMAGE_MODES.includes(genMode)) {
      const { apiUrl, apiKey } = resolveExternalEndpoint(genMode, settings);
      if (!apiUrl) {
        console.error('[ImageGen] External API URL not configured (mode=' + genMode + ')');
        return;
      }
      try {
        const result = await generateViaExternalAPI(prompt, genMode, apiUrl, apiKey, settings, type);
        if (result && (result.url || result.b64)) {
          const charName = (character_name || 'character').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
          // 扩展名按**文件内容**（magic bytes）判定，而不是按"传输方式"猜：
          // 以前 `b64 ? png : jpg` 会把 base64 返回的 JPEG 写成 .jpg/.png 不符的名字，
          // 于是 Content-Type、下载名、缩略图三处全错。
          const buf = result.b64 ? Buffer.from(result.b64, 'base64') : null;
          const ext = buf ? sniffImageExt(buf) : 'jpg';
          const filename = `${charName}_${Date.now()}.${ext}`;
          const savePath = path.join(IMAGES_DIR, filename);
          if (result.url) {
            await downloadExternalImage(result.url, savePath);
          } else {
            fs.writeFileSync(savePath, buf);
          }
          const stored = saveToConversation(db, conversation_id, character_name, filename, savePath, type === 'cg', prompt, isSceneOnly ? { sceneEnd: true } : null);
          console.log('[ImageGen] External API saved:', filename, stored ? '' : '（⚠ 未进入存档画廊，详见上方错误日志）');
          return;
        }
      } catch (err) {
        console.error('[ImageGen] External API failed (mode=' + genMode + ', NOT falling back to ComfyUI):', {
          message: err.message,
          stack: err.stack,
          genMode, type, character_name, conversation_id,
          apiUrl, promptHead: (prompt || '').substring(0, 150),
        });
      }
    }

    // --- ComfyUI generation (mode 'comfyui' = external instance) ---
    // 关键修复：openai/stability 模式下外部调用若失败，绝不能静默回退到 ComfyUI，
    // 否则用户明明选了 OpenAI 兼容接口却仍在调用本地 ComfyUI。
    let success = false;
    if (useComfy) {
    try {
      const workflowFile = getWorkflowFile(type, settings);
      if (!fs.existsSync(workflowFile)) {
        console.error('[ImageGen] Workflow not found:', workflowFile);
      } else {
        let workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf-8'));

        // Apply node settings (positive/negative node IDs, custom negative prompt)
        applyNodeSettings(workflow, prompt, settings, type);

        // Normalize model names to match ComfyUI's filesystem index (case-insensitive on Windows)
        await normalizeWorkflowModels(workflow, comfyuiUrl);

        // Randomize seed on all sampler nodes (structural: has seed+steps), then apply explicit user params (seed param wins)
        for (const [nid, node] of Object.entries(workflow)) {
          if (node.inputs && 'seed' in node.inputs && 'steps' in node.inputs) {
            node.inputs.seed = Math.floor(Math.random() * 9999999999999);
          }
        }
        applyGenerationParams(workflow, getGenerationParams(settings));

        const submitUrl = new URL('/prompt', comfyuiUrl.replace(/\/$/, ''));
        const promptId = await httpPost(submitUrl, { prompt: workflow });

        if (promptId) {
          console.log('[ImageGen] Submitted, prompt_id:', promptId);
          const outputImage = await waitForComfyUI(comfyuiUrl, promptId, comfyWaitSec);
          if (outputImage) {
            const charName = (character_name || 'character').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const filename = `${charName}_${Date.now()}.jpg`;
            const savePath = path.join(IMAGES_DIR, filename);
            await downloadImage(comfyuiUrl, outputImage, savePath);
            const stored = saveToConversation(db, conversation_id, character_name, filename, savePath, type === 'cg', prompt, isSceneOnly ? { sceneEnd: true } : null);
            console.log('[ImageGen] Saved:', filename, stored ? '' : '（⚠ 未进入存档画廊，详见上方错误日志）');
            success = true;
          }
        }
      }
    } catch (err) {
      console.error('[ImageGen] ComfyUI failed:', {
        message: err.message,
        stack: err.stack,
        type, character_name, conversation_id,
        comfyuiUrl, promptHead: (prompt || '').substring(0, 150),
      });
      // If portrait generation failed, reset 'pending' to '' so it can be retried next turn
      if (type === 'portrait' && character_name && conversation_id) {
        try {
          const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
          if (save) {
            const rp = path.join(save.save_path, 'character_roster.json');
            if (fs.existsSync(rp)) {
              const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
              if (r[character_name] && r[character_name].avatar === 'pending') {
                r[character_name].avatar = '';
                fs.writeFileSync(rp, JSON.stringify(r, null, 2), 'utf-8');
                console.log('[ImageGen] Reset roster pending for:', character_name);
              }
            }
          }
        } catch (e) { console.error('[ImageGen] Reset pending failed:', e.message); }
      }
    }
    } // end if (useComfy)

    // --- Fallback: use profile image (only meaningful in ComfyUI mode) ---
    if (genMode === 'comfyui' && !success && fallbackTag) {
      console.log('[ImageGen] Trying fallback from profile/', fallbackTag);
      const result = fallbackFromProfileWithDB(db, conversation_id, character_name, fallbackTag);
      if (result) {
        console.log('[ImageGen] Fallback saved:', result.filename);
      }
    }
  });

  return router;
};

// --- Save helpers ---

function saveToConversation(db, conversation_id, character_name, filename, savePath, isCG, cgPrompt, extra) {
  if (!conversation_id) return false;
  try {
    // 目标存档：同秒创建的两条 saves 记录会让 `created_at DESC` 的排序不确定
    // （实测：图片/画廊写进 A 条，界面读 B 条 → "图没进画廊"），所以再加 rowid 兜底。
    const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
    if (!save) {
      console.error('[ImageGen] 图片已生成但【没有存档记录】可写入（conversation_id=%s）—— 图片只留在 generated_images：%s',
        conversation_id, filename);
      return false;
    }
    const destDir = path.join(save.save_path, 'images');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(savePath, path.join(destDir, filename));

    if (isCG) {
      // Add to CG gallery
      const added = addToCGGallery(save.save_path, filename, character_name, cgPrompt, extra);
      if (!added) {
        console.error('[ImageGen] 图片已复制进存档但【未能写进 cg_gallery.json】（save=%s, file=%s）—— 画廊里不会出现这张图',
          save.id, filename);
        return false;
      }
    } else {
      updateRoster(save.save_path, character_name, filename);
      // Cache the generated avatar into the master folder so future sub-saves reuse it.
      savePaths.cachePortraitInMaster(db, conversation_id, character_name, save.save_path);
    }
    return true;
  } catch (e) {
    // 以前这里是 `catch (e) { /* ignore */ }`：图片生成成功、画廊没更新，日志里却一个字都没有。
    // 这正是"能在存档文件夹看到图、游戏里却看不到/画廊没有"无法诊断的原因。
    console.error('[ImageGen] 保存到存档失败（图片已生成，未进画廊）:', e.message,
      { conversation_id, character_name, filename, savePath, isCG });
    return false;
  }
}

/**
 * Swap a regenerated CG into the newest save of a conversation: copy the fresh file in,
 * delete the superseded one, and repoint its gallery entry (matched by the old filename,
 * falling back to the top entry so a missing name never loses the refresh).
 */
function replaceGalleryEntry(db, conversation_id, oldFilename, filename, savePath, prompt, character_name) {
  if (!conversation_id) return false;
  try {
    const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
    if (!save) {
      console.error('[ImageGen] 重新生成的图片没有存档记录可写入（conversation_id=%s）', conversation_id);
      return false;
    }
    const destDir = path.join(save.save_path, 'images');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(savePath, path.join(destDir, filename));
    if (oldFilename && oldFilename !== filename) {
      const oldPath = path.resolve(destDir, oldFilename);
      if (isPathWithin(destDir, oldPath)) { try { fs.unlinkSync(oldPath); } catch { } }
    }
    const gp = path.join(save.save_path, 'cg_gallery.json');
    let gallery = null;
    try { gallery = JSON.parse(fs.readFileSync(gp, 'utf-8')); } catch (e) {
      console.error('[ImageGen] 重新生成时读 cg_gallery.json 失败（不覆盖原文件）:', e.message, { saveId: save.id });
      return false;
    }
    if (Array.isArray(gallery)) {
      const entry = gallery.find(g => g && g.filename === oldFilename) || gallery[0];
      if (entry) {
        entry.filename = filename;
        entry.timestamp = new Date().toISOString();
        if (prompt) entry.prompt = prompt;
        if (character_name) entry.character = character_name;
        const tmp = gp + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(gallery, null, 2), 'utf-8');
        fs.renameSync(tmp, gp);
      }
    }
    return true;
  } catch (e) { console.error('[ImageGen] Gallery replace failed:', e.message); return false; }
}

function addToCGGallery(savePath, filename, character_name, prompt, extra) {
  const galleryPath = path.join(savePath, 'cg_gallery.json');
  let gallery = [];
  try {
    gallery = JSON.parse(fs.readFileSync(galleryPath, 'utf-8'));
    if (!Array.isArray(gallery)) throw new Error('not an array');
  } catch (e) {
    // 读失败**不能**当成空数组：那会把整张画廊表覆盖掉（老条目全丢，文件还在磁盘上，
    // 表现就是"画廊突然空了"）。先备份坏文件，再以空表重建。
    if (fs.existsSync(galleryPath)) {
      const bad = galleryPath + '.bad-' + new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.copyFileSync(galleryPath, bad); } catch { /* 备份失败也要继续，别把出图卡死 */ }
      console.error('[ImageGen] cg_gallery.json 读取失败（已备份为 %s）:%s —— 将以空画廊重建',
        path.basename(bad), e.message);
    }
    gallery = [];
  }
  // New CG at top
  const entry = {
    filename,
    character: character_name || 'unknown',
    prompt: prompt || '',  // Store full prompt for regeneration
    timestamp: new Date().toISOString(),
  };
  // NSFW 流程结束的空镜：打 sceneEnd 标记 + 中文说明，前端据此把它标成「收尾场景图」
  // （而不是当成一张普通 NSFW CG —— 它画面里没有人物）。
  if (extra && extra.sceneEnd) {
    entry.sceneEnd = true;
    entry.description = SCENE_END_LABEL;
  }
  gallery.unshift(entry);
  // Keep max 20（只裁剪索引，图片文件保留在存档 images/ 与 generated_images/ 里）
  if (gallery.length > 20) gallery = gallery.slice(0, 20);
  try {
    // 原子替换：先写临时文件再 rename，避免写到一半被读到半截 JSON
    const tmp = galleryPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(gallery, null, 2), 'utf-8');
    fs.renameSync(tmp, galleryPath);
  } catch (e) {
    console.error('[ImageGen] 写 cg_gallery.json 失败:', e.message, { savePath, filename });
    return false;
  }
  console.log('[ImageGen] CG gallery updated:', filename);
  return true;
}

function fallbackFromProfileWithDB(db, conversation_id, character_name, tag) {
  const picked = pickRandomProfile(tag);
  if (!picked) return null;

  const charName = (character_name || 'character').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const filename = `${charName}_${Date.now()}.jpg`;
  const savePath = path.join(IMAGES_DIR, filename);

  try {
    fs.copyFileSync(picked.path, savePath);

    if (conversation_id) {
      const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversation_id);
      if (save) {
        const destDir = path.join(save.save_path, 'images');
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(savePath, path.join(destDir, filename));
        updateRoster(save.save_path, character_name, filename);
        // Cache the generated avatar into the master folder so future sub-saves reuse it.
        savePaths.cachePortraitInMaster(db, conversation_id, character_name, save.save_path);
      }
    }
    return { filename, savePath };
  } catch (e) {
    console.error('[ImageGen] Fallback error:', e.message);
    return null;
  }
}

function updateRoster(savePath, character_name, filename) {
  if (!character_name) return;
  // Backstop: never write a roster entry for the conversation's CHARACTER CARD itself.
  // The card (left sidebar, scenario/title) already has its own cover avatar and is NOT a
  // dialogue character. A portrait can still be generated for it by a buggy model output whose
  // name is a variant of the card name — block it here so it never pollutes the roster.
  try {
    // Resolve the save's conversation_id. Prefer an exact save_path match, but also
    // fall back to the directory basename (which equals the save id) — this avoids
    // path-normalization mismatches that would otherwise make the lookup miss and let
    // the card-name entry slip through.
    let conversation_id = null;
    const byPath = db.prepare('SELECT conversation_id FROM saves WHERE save_path = ?').get(savePath);
    if (byPath) conversation_id = byPath.conversation_id;
    if (!conversation_id) {
      const base = path.basename(savePath).replace(/[\\/]$/, '');
      const byId = db.prepare('SELECT conversation_id FROM saves WHERE id = ?').get(base);
      if (byId) conversation_id = byId.conversation_id;
    }
    if (conversation_id) {
      const conv = db.prepare('SELECT character_id FROM conversations WHERE id = ?').get(conversation_id);
      if (conv && conv.character_id) {
        const card = db.prepare('SELECT name FROM characters WHERE id = ?').get(conv.character_id);
        if (card && card.name && namesEquivalent(character_name, card.name)) {
          console.log('[ImageGen] Skipped roster write for character card (not a dialogue character):', character_name);
          return;
        }
      }
    }
  } catch { /* ignore lookup errors */ }
  const rosterPath = path.join(savePath, 'character_roster.json');
  try {
    let roster = {};
    try { roster = JSON.parse(fs.readFileSync(rosterPath, 'utf-8')); } catch { /* new roster */ }
    if (roster[character_name]) {
      roster[character_name].avatar = filename;
    } else {
      // Entry doesn't exist yet — create minimal entry (shouldn't normally happen since butler pre-creates entries)
      roster[character_name] = { name: character_name, avatar: filename, generated_at: new Date().toISOString() };
    }
    fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf-8');
    console.log('[ImageGen] Updated roster for:', character_name, 'avatar:', filename);
  } catch (e) { console.error('[ImageGen] updateRoster error:', e.message); }
}

// --- ComfyUI helpers ---

async function httpPost(urlObj, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          // Detect ComfyUI validation errors
          if (json.error && !json.prompt_id) {
            const errInfo = [];
            if (json.node_errors) {
              for (const [nid, ne] of Object.entries(json.node_errors)) {
                if (ne.errors && ne.errors.length > 0) {
                  errInfo.push(`node ${nid}(${ne.class_type}): ${ne.errors.map(e => e.message || JSON.stringify(e)).join('; ')}`);
                }
              }
            }
            const msg = `ComfyUI rejected: ${json.error.type} - ${errInfo.join(' | ') || json.error.message}`;
            reject(new Error(msg));
          } else {
            resolve(json.prompt_id || (json.result || json));
          }
        } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

async function waitForComfyUI(baseUrl, promptId, maxWait = 60) {
  const historyUrl = new URL('/history/' + promptId, baseUrl.replace(/\/$/, ''));
  for (let i = 0; i < maxWait; i++) {
    await sleep(2000);
    try {
      const result = await httpGet(historyUrl);
      if (result && result[promptId] && result[promptId].outputs) {
        const outputs = result[promptId].outputs;
        for (const nodeId of Object.keys(outputs)) {
          const imgs = outputs[nodeId].images;
          if (imgs && imgs.length > 0) {
            return { filename: imgs[0].filename, subfolder: imgs[0].subfolder || '', type: imgs[0].type || 'output' };
          }
        }
      }
    } catch (e) { /* retry */ }
  }
  return null;
}

async function httpGet(urlObj) {
  return new Promise((resolve, reject) => {
    http.get(urlObj, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

async function downloadImage(baseUrl, outputImage, savePath) {
  const { filename, subfolder, type } = outputImage;
  const viewUrl = new URL(`/view?filename=${encodeURIComponent(filename)}&subfolder=${subfolder}&type=${type}`, baseUrl.replace(/\/$/, ''));
  // SSRF guard: validate the ComfyUI view URL before fetching
  const urlCheck = isUrlSafe(viewUrl.toString());
  if (!urlCheck.ok) {
    throw new Error(`URL not allowed: ${urlCheck.reason}`);
  }
  return new Promise((resolve, reject) => {
    http.get(viewUrl, (res) => {
      const file = fs.createWriteStream(savePath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 按文件内容判定图片扩展名（PNG / JPEG / WebP / GIF / BMP / AVIF），判定不出回退 png。
 * 为什么不能靠"传输方式"猜：b64 通路以前一律写 `.png`、url 通路一律写 `.jpg`，
 * 服务商实际返回什么格式完全不管 —— 名字与内容不符会让 Content-Type、下载文件名、
 * 缩略图生成全错（浏览器虽然多数能靠嗅探渲染，但排查时极容易误判成"格式不被支持"）。
 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return 'png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'avif';
  return 'png';
}

// --- External Image API ---

// 各引擎的中文名（报错信息里用，让"引擎与地址不匹配"一眼看懂）
const IMAGE_MODE_LABELS = {
  anima: 'anima-turbo-cg', comfyui: 'ComfyUI', openai: 'OpenAI 兼容',
  stability: 'Stability AI', novelai: 'NovelAI', none: '关闭生图',
};

/**
 * 判定一个 API 地址属于哪个引擎（'' = 判定不出的自填地址）。
 * 只认各家的**官方端点特征**，避免把用户的第三方中转误判成某一家。
 */
function imageUrlOwnerEngine(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/novelai\.net|\/ai\/generate-image/i.test(s)) return 'novelai';
  if (/:8100\b/.test(s)) return 'anima';
  if (/api\.stability\.ai/i.test(s)) return 'stability';
  if (/api\.openai\.com/i.test(s)) return 'openai';
  return '';
}

/**
 * 把用户填的地址规范成 OpenAI 图像接口的**完整端点**。
 * 各家文档给的地址形态不一：`https://api.siliconflow.cn/v1`（基址）、
 * `https://api.openai.com`（裸域）、以及完整的 `.../v1/images/generations`。
 * 只补标准后缀，**自定义路径一律不动**（自建网关可能是 /sd/txt2img 之类）。
 */
function normalizeOpenAIEndpoint(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return s;
  let u;
  try { u = new URL(s); } catch { return s; } // 非法地址原样返回，交给调用方报错
  const p = u.pathname.replace(/\/+$/, '');
  if (/\/images\/generations$/i.test(p)) return s;                 // 已是完整端点
  if (p === '') u.pathname = '/v1/images/generations';             // 裸域
  else if (/\/v\d+$/i.test(p)) u.pathname = p + '/images/generations'; // 基址 .../v1
  else return s;                                                   // 自定义路径：不动
  return u.toString();
}

async function generateViaExternalAPI(prompt, mode, apiUrl, apiKey, settings, type) {
  let url = apiUrl.replace(/\/$/, '');
  // 引擎与地址必须配套：把 OpenAI 格式的请求体发给 NovelAI 端点（或反之）只会得到
  // 一个看不懂的报错。这里提前拦下并说清"当前引擎 / 地址属于谁 / 该改成什么"。
  const owner = imageUrlOwnerEngine(url);
  if (owner && owner !== mode) {
    // 固定端点引擎（anima / novelai）自带官方默认端点：直接回落到自己的端点，
    // 不要让用户因为一个历史坏地址就完全不能出图。
    const fixed = (mode === ANIMA_PRESET.MODE) ? ANIMA_PRESET.API_URL
      : (mode === NOVELAI_PRESET.MODE ? NOVELAI_PRESET.API_URL : '');
    if (fixed) {
      console.warn('[ImageGen] 生图地址与当前引擎不匹配（引擎「' + (IMAGE_MODE_LABELS[mode] || mode) +
        '」的地址却是「' + (IMAGE_MODE_LABELS[owner] || owner) + '」的端点：' + url +
        '），已回落到本引擎默认端点：' + fixed);
      url = fixed;
    } else {
      throw new Error('生图地址与当前引擎不匹配：引擎「' + (IMAGE_MODE_LABELS[mode] || mode) +
        '」不能用「' + (IMAGE_MODE_LABELS[owner] || owner) + '」的端点（' + url +
        '）。请到「图像设置 → 生成引擎」里把 API 地址改成当前引擎自己的地址。');
    }
  }
  // anima-turbo-cg speaks the OpenAI images API, so it shares this branch; the mode is
  // still passed through so the model/size/timeout defaults resolve correctly.
  if (OPENAI_COMPATIBLE_MODES.includes(mode)) {
    return generateViaOpenAI(prompt, url, apiKey, settings, mode);
  } else if (mode === 'stability') {
    return generateViaStability(prompt, url, apiKey, settings);
  } else if (mode === NOVELAI_PRESET.MODE) {
    return generateViaNovelAI(prompt, url, apiKey, settings, type);
  }
  throw new Error('Unknown external API mode: ' + mode);
}

/**
 * Pick the transport by the URL's own protocol.
 *
 * anima-turbo-cg serves plain HTTP on 127.0.0.1:8100.  Hardcoding `https` made every
 * such request die with EPROTO (a TLS handshake against a plaintext server), which is
 * why the default engine could never actually be reached.
 *
 * ---- 代理（2026-09-20）----
 * 外网生图（NovelAI / OpenAI / Stability）在受限网络里直连会被墙：报错长这样
 *   AggregateError [ETIMEDOUT]  at internalConnectMultiple  /  ECONNRESET
 * 而浏览器和 chat.js 的请求都走了代理 —— 只有生图这条路径**完全没看代理配置**，
 * 于是出现"聊天能用、生图超时"。这里让生图复用同一个 app_settings.proxy_config，
 * 并在应用内未启用代理时自动采用 **Windows 系统代理**（就是浏览器在用的那个）。
 *
 * 优先级：HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量 > 应用内 proxy_config(enabled)
 *        > Windows 注册表系统代理 > 直连。
 * 一律直连的情况：本机/私网地址（anima 127.0.0.1:8100、ComfyUI、局域网）、
 *        NO_PROXY 命中、或 AI_GAL_DISABLE_PROXY=1 / AI_GAL_NO_PROXY=1。
 */
const netMod = require('net');
const tlsMod = require('tls');
const httpsMod = require('https');
const httpMod = http; // 顶部已 require('http')

let _osProxyResolved = false;
let _osProxyFound = null;

function isLocalOrPrivateHost(hostname) {
  return /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(hostname || '');
}

/** 注册表里的写法很杂：`host:port`、`http://host:port`、`http=host:port;https=host:port`。 */
function parseProxyServerValue(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // "http=host:port;https=host:port" 形式（注意与带 scheme 的完整 URL 区分：后者含 "://"）
  if (s.indexOf('=') !== -1 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const parts = {};
    for (const seg of s.split(';')) {
      const i = seg.indexOf('=');
      if (i > 0) parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
    }
    s = parts.https || parts.http || parts.socks || '';
  }
  // 去掉 scheme 与尾部斜杠：注册表实测会写 "http://127.0.0.1:9567"
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '').trim();
  return s || null;
}

function detectWindowsSystemProxy() {
  if (_osProxyResolved) return _osProxyFound;
  _osProxyResolved = true;
  if (process.platform !== 'win32') return null;
  let tmp = '';
  try {
    const cp = require('child_process');
    const os = require('os');
    tmp = path.join(os.tmpdir(), 'ai-gal-proxy-probe-' + process.pid + '-' + Date.now() + '.txt');
    // 注意：stdout 必须落**文件**、不能用管道 —— 受限环境里管道的 stdio 会被 EPERM 拒绝
    // （本项目既有经验：spawn/exec 的默认 pipe 在受限沙箱不可用）。
    const fd = fs.openSync(tmp, 'w');
    try {
      cp.execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ], { stdio: ['ignore', fd, 'ignore'], timeout: 3000, windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
    const out = fs.readFileSync(tmp, 'utf8');
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return null;
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    const hp = m ? parseProxyServerValue(m[1]) : null;
    if (!hp) return null;
    const idx = hp.lastIndexOf(':');
    const host = idx > 0 ? hp.slice(0, idx) : hp;
    const port = idx > 0 ? parseInt(hp.slice(idx + 1), 10) : 8080;
    if (host && port) _osProxyFound = { host, port, auth: '', source: '系统代理' };
  } catch { /* 读不到注册表（或 reg 不可用）就直连 */ }
  finally { if (tmp) { try { fs.unlinkSync(tmp); } catch { } } }
  return _osProxyFound;
}

const _proxyLogged = new Set();
/**
 * 应用内代理配置的读取钩子：本文件顶层的生成辅助函数（transportFor / novelAIPost …）在
 * 路由工厂**闭包之外**，拿不到工厂参数 `db`，所以由工厂在创建时把读取函数注入进来。
 */
let _appProxyProvider = null;
function setAppProxyProvider(fn) { _appProxyProvider = typeof fn === 'function' ? fn : null; }

function resolveImageProxy(hostname) {
  if (isLocalOrPrivateHost(hostname)) return null;
  if (/^(1|true|yes)$/i.test(process.env.AI_GAL_DISABLE_PROXY || '') || /^(1|true|yes)$/i.test(process.env.AI_GAL_NO_PROXY || '')) return null;
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  if (noProxy && noProxy.split(',').some(h => h.trim() && hostname.endsWith(h.trim().replace(/^\./, '')))) return null;

  let proxy = null;
  const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      if (u.hostname) proxy = { host: u.hostname, port: Number(u.port) || 8080, auth: u.username ? (decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')) : '', source: '环境变量' };
    } catch { /* 环境变量写法不对则忽略 */ }
  }
  if (!proxy && _appProxyProvider) {
    try {
      const cfg = _appProxyProvider();
      if (cfg && cfg.enabled && cfg.host) proxy = { host: cfg.host, port: Number(cfg.port) || 9567, auth: cfg.auth || '', source: '应用设置' };
    } catch { /* 设置表尚未就绪 */ }
  }
  if (!proxy) proxy = detectWindowsSystemProxy();
  const logKey = proxy ? (proxy.source + '|' + proxy.host + ':' + proxy.port) : '';
  if (proxy && !_proxyLogged.has(logKey)) {
    _proxyLogged.add(logKey);
    console.log('[ImageGen] 外网生图经代理 ' + proxy.host + ':' + proxy.port + '（来源：' + proxy.source + '）');
  }
  return proxy;
}

/** HTTPS 目标经 HTTP 代理的 CONNECT 隧道 Agent（零依赖，纯 node:net + node:tls）。 */
function makeTunnelAgent(proxy) {
  const agent = new httpsMod.Agent({ keepAlive: false });
  agent.createConnection = (options, cb) => {
    const sock = netMod.connect(proxy.port, proxy.host);
    sock.setTimeout(20000, () => sock.destroy(new Error('代理连接超时（' + proxy.host + ':' + proxy.port + '）')));
    sock.once('connect', () => {
      let head = 'CONNECT ' + options.host + ':' + options.port + ' HTTP/1.1\r\nHost: ' + options.host + ':' + options.port + '\r\n';
      if (proxy.auth) head += 'Proxy-Authorization: Basic ' + Buffer.from(proxy.auth).toString('base64') + '\r\n';
      sock.write(head + '\r\n');
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      const head = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      const status = parseInt(head.slice(9, 12), 10);
      if (status !== 200) {
        sock.destroy();
        cb(new Error('代理拒绝 CONNECT（' + proxy.host + ':' + proxy.port + '）：' + head.split('\r\n')[0]));
        return;
      }
      if (rest.length) sock.unshift(rest);
      const t = tlsMod.connect({ socket: sock, servername: options.host });
      t.once('secureConnect', () => cb(null, t));
      t.once('error', (e) => cb(e));
    };
    sock.on('data', onData);
    sock.once('error', (e) => cb(e));
  };
  return agent;
}

/** 经代理失败时把代理信息带进错误文本，避免又出现"看不出是网络还是令牌"的报错。 */
function tagProxyError(req, proxy) {
  req.on('error', (e) => {
    if (e && !e._proxyTagged) {
      e._proxyTagged = true;
      e.message = (e.message || e.code || 'error') + '（经' + proxy.source + ' ' + proxy.host + ':' + proxy.port + '）';
    }
  });
  return req;
}

function transportFor(urlString) {
  const isHttps = /^https:/i.test(urlString);
  const mod = isHttps ? httpsMod : httpMod;
  let hostname = '';
  try { hostname = new URL(urlString).hostname; } catch { return mod; }
  const proxy = resolveImageProxy(hostname);
  if (!proxy) return mod;
  if (isHttps) {
    const agent = makeTunnelAgent(proxy);
    return { request: (opts, cb) => tagProxyError(mod.request(Object.assign({}, opts, { agent }), cb), proxy) };
  }
  // 明文 HTTP 目标：请求发给代理，path 用绝对 URL（与 chat.js 的做法一致）
  return {
    request: (opts, cb) => {
      const headers = Object.assign({}, opts.headers);
      if (proxy.auth) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
      const absUrl = 'http://' + opts.hostname + ':' + (opts.port || 80) + (opts.path || '/');
      return tagProxyError(httpMod.request(Object.assign({}, opts, { hostname: proxy.host, port: proxy.port, path: absUrl, headers }), cb), proxy);
    },
  };
}

async function generateViaOpenAI(prompt, apiUrl, apiKey, settings, mode) {
  // OpenAI 图像接口格式（DALL·E 3 / GPT-Image-1 / 任意 OpenAI 兼容服务；anima-turbo-cg 也走这条）
  const ep = resolveExternalEndpoint(mode, settings);
  const model = ep.apiModel || 'dall-e-3';
  // 地址规范化：用户常填基址（https://api.siliconflow.cn/v1）或裸域，补齐 /images/generations
  const endpoint = normalizeOpenAIEndpoint(apiUrl);
  // 尺寸：一律先规范化再发。
  // ⚠️ anima-turbo-cg（sd.cpp）的 OpenAI 路由只认小写 `x`：`1536X1024` / `1536×1024` / `1536*1024`
  // 会被**静默忽略**、回落到服务启动参数里的默认尺寸（实测 1536X1024 → 出图 1024x1024）。
  // 历史库里就有这种值，所以这里必须兜住，而不能只靠前端。
  const sized = sizeForEngine(mode, settings && settings.image_size);
  const size = sized.size;
  if (sized.notes.length) console.warn('[ImageGen-OpenAI] 尺寸修正：' + sized.notes.join('；'));
  // 提示词质量前缀（OpenAI兼容模式）：拼接到提示词最前面增强画质
  const qp = (settings && settings.quality_prefix) ? settings.quality_prefix.trim() : '';
  let fullPrompt = qp ? (qp + ', ' + prompt) : prompt;
  fullPrompt = fullPrompt.substring(0, 4000);  // DALL-E 提示词长度上限
  // 请求体严格按 OpenAI images API：model / prompt / n / size。
  // response_format 只有 DALL·E 家族认（gpt-image-1 会因未知参数直接 400 拒绝），
  // 其余兼容服务商默认就返回 url —— 少发一个参数，兼容性最好。
  const bodyObj = { model, prompt: fullPrompt, n: 1 };
  if (size) bodyObj.size = size;
  if (/^dall-e/i.test(model)) bodyObj.response_format = 'url';
  const body = JSON.stringify(bodyObj);
  console.log('[ImageGen-OpenAI] POST', endpoint, '| model:', model, '| size:', size || '(服务商默认)');

  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(endpoint); } catch (e) { return reject(new Error('API 地址不是合法 URL：' + endpoint)); }
    const isHttps = urlObj.protocol === 'https:';
    const opts = {
      hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: ep.timeoutMs
    };
    const req = transportFor(endpoint).request(opts, (res) => {
      let buf = ''; res.on('data', d => buf += d);
      res.on('end', () => {
        const status = res.statusCode || 0;
        try {
          const json = JSON.parse(buf);
          // 各家返回字段不一：OpenAI = data[0].url|b64_json；SiliconFlow = images[0].url；
          // 自建网关常见 output.url / artifacts[0].base64 —— 一并认下，避免"有图却解析不出来"
          const firstOf = (v) => Array.isArray(v) ? (v[0] || null) : ((v && typeof v === 'object') ? v : null);
          const cands = [firstOf(json.data), firstOf(json.images), firstOf(json.artifacts), firstOf(json.output)]
            .filter(Boolean);
          let imageUrl = '';
          let b64 = '';
          for (const c of cands) {
            if (!imageUrl && typeof c.url === 'string' && c.url) imageUrl = c.url;
            if (!b64 && typeof c.b64_json === 'string' && c.b64_json) b64 = c.b64_json;
            if (!b64 && typeof c.base64 === 'string' && c.base64) b64 = c.base64;
          }
          if (!imageUrl && typeof json.url === 'string') imageUrl = json.url;
          if (!b64 && typeof json.b64_json === 'string') b64 = json.b64_json;
          b64 = b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');  // 去掉 data URI 前缀
          if (imageUrl) return resolve({ url: imageUrl });
          if (b64) return resolve({ b64 });
          // 服务端返回的是错误体（如 {"error":{"message":"model is not found"}}），直接透传，便于定位
          let detail = '';
          if (json && json.error) {
            detail = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
          }
          reject(new Error(detail ? ('服务端返回错误（HTTP ' + status + '）：' + detail)
            : ('HTTP ' + status + ' 响应中无图片数据：' + buf.substring(0, 200))));
        } catch (e) {
          reject(new Error('HTTP ' + status + ' 响应不是合法 JSON：' + buf.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    // 本地单模型服务（anima-turbo-cg）同步出图，纯 CPU 上 1024² 可能耗时数分钟：
    // 超时后必须显式销毁，否则请求会一直吊着而不是报错。
    req.on('timeout', () => {
      req.destroy(new Error(`生图请求超时（${Math.round(ep.timeoutMs / 1000)}s）。若使用 anima-turbo-cg 且为纯 CPU，请把图片尺寸降到 512x512 或 768x768。`));
    });
    req.write(body); req.end();
  });
}

async function generateViaStability(prompt, apiUrl, apiKey, settings) {
  // Stability AI API format
  const qp = (settings && settings.quality_prefix) ? settings.quality_prefix.trim() : '';
  const fullPrompt = qp ? (qp + ', ' + prompt) : prompt;
  const formData = new URLSearchParams();
  formData.append('prompt', fullPrompt.substring(0, 2000));
  formData.append('output_format', 'jpeg');

  return new Promise((resolve, reject) => {
    const urlObj = new URL(apiUrl);
    const isHttps = urlObj.protocol === 'https:';
    const body = formData.toString();
    const opts = {
      hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body), 'Accept': 'image/*' },
      timeout: EXTERNAL_API_TIMEOUT_MS
    };
    const req = transportFor(apiUrl).request(opts, (res) => {
      if (res.headers['content-type']?.includes('image')) {
        // Direct image response → save to temp file, return URL path
        const savePath = path.join(IMAGES_DIR, `stability_${Date.now()}.jpg`);
        const file = fs.createWriteStream(savePath);
        res.pipe(file);
        file.on('finish', () => resolve({ url: `${BASE_URL}/api/images/files/` + path.basename(savePath) }));
      } else {
        let buf = ''; res.on('data', d => buf += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(buf);
            const imageUrl = json.artifacts?.[0]?.base64 ?
              `data:image/png;base64,${json.artifacts[0].base64}` : (json.image || json.url);
            if (imageUrl) resolve({ url: imageUrl });
            else reject(new Error('No image in response'));
          } catch { reject(new Error('Parse error: ' + buf.substring(0, 200))); }
        });
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('生图请求超时')); });
    req.write(body); req.end();
  });
}

// ---------------------------------------------------------------------------
// NovelAI (image.novelai.net) — NOT OpenAI-compatible:
//   POST { input, model, action, parameters }  →  binary ZIP archive holding PNG(s)
// (V4 answers with msgpack event stream ONLY when `stream:"msgpack"` is requested;
// omitting `stream` yields a plain ZIP for V3 and V4 alike — NekoAI-JS "force zip".)
// Auth: `Authorization: Bearer <persistent api token>` ("pst-…", from the NovelAI
// site → Settings → Account).  Official payload shapes mirrored from NekoAI-API's
// examples/nai3.json & nai4.5.json.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

/** Snap a dimension to a multiple of 64 (NovelAI requirement), clamped to 64..3072. */
function snap64(v) {
  let n = Math.round((parseInt(v, 10) || 0) / 64) * 64;
  if (n < 64) n = 64;
  if (n > 3072) n = 3072;
  return n;
}

/** Parse "WxH" (settings.image_size) into {width, height}; defaults to 1024x1024. */
function parseNovelAISize(size) {
  const m = String(size || '').match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (!m) return { width: 1024, height: 1024 };
  return { width: snap64(m[1]), height: snap64(m[2]) };
}

/**
 * SD numeric weighting `(1boy:1.3)` is NOT valid NovelAI syntax (NovelAI uses {} / []
 * attention layers).  Convert the single boost this codebase emits into NovelAI
 * weighting: ×1.3 ≈ {{1boy}} (two layers, ×1.1025) — a sane approximation, and the
 * tag itself stays readable either way.
 */
function toNovelAIWeighting(prompt) {
  return String(prompt || '').replace(
    /\((1\s*(?:girl|boy|futa)\s*:\s*1\.3)\)/gi,
    (m, inner) => `{{${inner.split(':')[0].replace(/\s+/g, '')}}}`
  );
}

/**
 * Build the /ai/generate-image request payload.  Mirrors the official example
 * payloads field-for-field (V3: nai3.json, V4.5: nai4.5.json) so every parameter
 * the server expects is present.  `stream` is deliberately omitted → ZIP response
 * for both V3 and V4 models, keeping ONE response-parsing path.
 */
function buildNovelAIPayload(model, prompt, negative, dims, { steps, scale, sampler, seed }) {
  const isV4 = /nai-diffusion-4/.test(model || '');
  const parameters = isV4 ? {
    params_version: 3,
    width: dims.width, height: dims.height,
    scale, sampler, steps,
    n_samples: 1,
    ucPreset: 3,
    qualityToggle: false,
    negative_prompt: negative,
    // V4 models require the structured caption objects (multi-character capable);
    // single-character generation puts everything into base_caption.
    v4_prompt: {
      caption: { base_caption: prompt, char_captions: [] },
      use_coords: false,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: negative, char_captions: [] },
      legacy_uc: false,
    },
    characterPrompts: [],
    use_coords: false,
    legacy_uc: false,
    legacy: false,
    legacy_v3_extend: false,
    add_original_image: true,
    autoSmea: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    cfg_rescale: 0,
    noise_schedule: 'karras',
    skip_cfg_above_sigma: null,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    normalize_reference_strength_multiple: true,
    inpaintImg2ImgStrength: 1,
    seed,
  } : {
    params_version: 3,
    width: dims.width, height: dims.height,
    scale, sampler, steps,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: false,
    sm: false, sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: 0,
    noise_schedule: 'karras',
    legacy_v3_extend: false,
    skip_cfg_above_sigma: null,
    seed,
    characterPrompts: [],
    negative_prompt: negative,
  };
  return { input: prompt, model, action: 'generate', parameters };
}

/** POST the payload and return the raw binary body (never JSON). */
function novelAIPost(url, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const opts = {
      hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/x-zip-compressed, application/zip, binary/octet-stream, application/msgpack, */*',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs || EXTERNAL_API_TIMEOUT_MS,
    };
    const req = transportFor(url).request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // NovelAI errors are JSON bodies ({statusCode, message}) — surface them verbatim
          // so "401 bad token" / "402 out of Anlas" are immediately diagnosable.
          let detail = buf.toString('utf8').substring(0, 200);
          try {
            const j = JSON.parse(buf.toString('utf8'));
            detail = (j && (j.message || j.detail)) || JSON.stringify(j);
          } catch { /* plain text error body */ }
          const hint = res.statusCode === 401 ? '（Token 无效或过期，请重新到官网 Account 页生成 Persistent API Token）'
            : (res.statusCode === 402 ? '（Anlas 不足，或订阅不包含该模型/尺寸/步数）' : '');
          reject(new Error(`NovelAI HTTP ${res.statusCode}${hint}: ${detail}`));
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`NovelAI 请求超时（${Math.round((timeoutMs || EXTERNAL_API_TIMEOUT_MS) / 1000)}s）`)); });
    req.write(body); req.end();
  });
}

/**
 * Pull the first PNG out of a ZIP buffer by walking the central directory (sizes are
 * always present there, unlike stream-written local headers).  Handles stored (0) and
 * deflate (8) entries; NovelAI's archive contains exactly the generated .png file(s).
 */
function extractFirstPngFromZip(buf) {
  // Locate the End Of Central Directory record ("PK\x05\x06") scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null; // "PK\x01\x02"
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const cmLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString('utf8');
    if (/\.png$/i.test(name) && usize > 0) {
      const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.slice(dataStart, dataStart + csize);
      return (method === 0) ? raw : zlib.inflateRawSync(raw);
    }
    off += 46 + fnLen + exLen + cmLen;
  }
  return null;
}

/**
 * Fallback: scan a binary blob (msgpack event stream, if the server ever switches to
 * it) for the LAST complete PNG frame (signature … IEND).  Intermediate msgpack
 * frames are JPEG and thus skipped.
 */
function extractLastCompletePng(buf) {
  let best = null;
  let pos = 0;
  while (true) {
    const i = buf.indexOf(PNG_SIGNATURE, pos);
    if (i < 0) break;
    const end = buf.indexOf(PNG_IEND, i + PNG_SIGNATURE.length);
    if (end >= 0 && end + PNG_IEND.length <= buf.length) {
      best = buf.slice(i, end + PNG_IEND.length);
      pos = end + PNG_IEND.length;
    } else {
      pos = i + 1;
    }
  }
  return best;
}

function extractNovelAIImage(buf) {
  if (!buf || buf.length < 8) throw new Error('NovelAI 返回了空响应');
  if (buf[0] === 0x50 && buf[1] === 0x4B) { // "PK" → ZIP archive
    const png = extractFirstPngFromZip(buf);
    if (png && png.length > 8) return png;
  }
  const png = extractLastCompletePng(buf);
  if (png) return png;
  throw new Error('无法从 NovelAI 响应中提取 PNG（既不是 ZIP 也没有 PNG 帧），响应头部: ' + buf.slice(0, 32).toString('hex'));
}

/**
 * Generate via the NovelAI image API.  Returns { b64 } (base64 PNG) which the shared
 * external-API persistence path already understands — it writes the file with a .png
 * extension and updates the gallery/roster exactly like the other engines.
 */
async function generateViaNovelAI(prompt, apiUrl, apiKey, settings, type) {
  if (!apiKey) {
    throw new Error('未配置 NovelAI API Token：请到 NovelAI 官网 → 设置齿轮 → Account → Get Persistent API Token，把 pst- 开头的令牌填进设置的 API Key');
  }
  const ep = resolveExternalEndpoint(NOVELAI_PRESET.MODE, settings);
  const model = ep.apiModel || NOVELAI_PRESET.API_MODEL;

  // Prompt: convert the SD-style (1boy:1.3) boost into NovelAI weighting, then apply the
  // optional quality prefix (same setting field the OpenAI-compatible path uses).
  let naiPrompt = toNovelAIWeighting(prompt);
  const qp = (settings && settings.quality_prefix) ? settings.quality_prefix.trim() : '';
  if (qp) naiPrompt = qp + ', ' + naiPrompt;

  // Negative prompt: the per-type custom field wins; otherwise NovelAI's built-in
  // heavy preset (rating-safe: no `nsfw` word — see NOVELAI_PRESET.DEFAULT_NEGATIVE).
  const customNeg = String((type === 'portrait'
    ? (settings && settings.portrait_negative_prompt)
    : (settings && settings.cg_negative_prompt)) || '').trim();
  const negative = customNeg || NOVELAI_PRESET.DEFAULT_NEGATIVE;

  // Dimensions: custom_params width/height win; otherwise parse settings.image_size.
  const params = getGenerationParams(settings);
  const dims = (params.width > 0 && params.height > 0)
    ? { width: snap64(params.width), height: snap64(params.height) }
    : parseNovelAISize(settings && settings.image_size);

  // Defaults stay inside the Opus free tier: 28 steps, 1 sample, ≤1024² pixels.
  const isV4 = /nai-diffusion-4/.test(model);
  const steps = params.steps > 0 ? params.steps : 28;
  const scale = params.cfg > 0 ? params.cfg : (isV4 ? 5 : 6);
  const sampler = params.sampler || 'k_euler_ancestral';
  const seed = params.seed >= 0 ? params.seed : Math.floor(Math.random() * 4294967296);
  if (dims.width * dims.height > 1024 * 1024 || steps > 28) {
    console.log(`[ImageGen-NovelAI] NOTE: ${dims.width}x${dims.height} @ ${steps} steps exceeds the Opus free tier — this generation will consume Anlas`);
  }

  const payload = buildNovelAIPayload(model, naiPrompt, negative, dims, { steps, scale, sampler, seed });
  console.log(`[ImageGen-NovelAI] model=${model} ${dims.width}x${dims.height} steps=${steps} scale=${scale} sampler=${sampler} seed=${seed} neg=${negative.length} chars`);
  const buf = await novelAIPost(apiUrl || NOVELAI_PRESET.API_URL, apiKey, JSON.stringify(payload), ep.timeoutMs);
  const png = extractNovelAIImage(buf);
  console.log(`[ImageGen-NovelAI] got PNG ${png.length} bytes (input ${buf.length} bytes)`);
  return { b64: png.toString('base64') };
}

async function downloadExternalImage(imageUrl, savePath, _redirectCount = 0) {
  if (imageUrl.startsWith('data:')) {
    // Base64 data URL — enforce size limit to avoid DoS via huge payloads
    const b64 = imageUrl.split(',')[1] || '';
    const decoded = Buffer.from(b64, 'base64');
    if (decoded.length > MAX_DATA_URL_BYTES) {
      throw new Error(`Data URL exceeds size limit: ${decoded.length} > ${MAX_DATA_URL_BYTES} bytes`);
    }
    fs.writeFileSync(savePath, decoded);
    return;
  }
  if (imageUrl.startsWith(BASE_URL)) {
    // Local file already saved
    return;
  }
  // SSRF guard: validate URL before issuing the request
  const urlCheck = isUrlSafe(imageUrl);
  if (!urlCheck.ok) {
    throw new Error(`URL not allowed: ${urlCheck.reason}`);
  }
  // Remote URL download
  return new Promise((resolve, reject) => {
    const protocol = imageUrl.startsWith('https') ? require('https') : require('http');
    protocol.get(imageUrl, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Cap redirect chain to avoid loops / excessive hops
        if (_redirectCount + 1 >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
          res.destroy();
          return;
        }
        downloadExternalImage(res.headers.location, savePath, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      const file = fs.createWriteStream(savePath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}


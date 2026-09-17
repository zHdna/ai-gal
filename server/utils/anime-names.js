/**
 * server/utils/anime-names.js —— 热门二次元角色「中文译名 → 官方英文名/生图标签」查询
 *
 * 用途：给名册的 english_name 用。**只服务热门二次元角色**——同人卡里的角色（Rem / 亚丝娜 /
 * 初音未来…）需要一个 ASCII 锚点，让生图模型认得出来；**原创角色不需要**这个功能，
 * 查不到就老老实实没有 english_name（不再用拼音硬凑，见 ENGLISH_NAME_CN_ROOT_CAUSE.md）。
 *
 * 数据：server/data/anime-character-names.json（由 tools/build-anime-name-table.js 生成；
 *      数据源是 GitHub 上 WAI Illustrious 角色选择器的中文名↔英文标签表，MIT 许可）。
 *
 * 本模块**纯离线**：只读本地表，不发网络请求，不引入任何依赖。
 */
'use strict';

const path = require('path');

const TABLE_PATH = path.join(__dirname, '..', 'data', 'anime-character-names.json');

let _table = null;
function table() {
  if (_table) return _table;
  try { _table = require(TABLE_PATH); } catch { _table = { names: {}, full: {} }; }
  return _table;
}

/**
 * 归一化查表键：小写、全角括号→半角、去掉空白与日文中点。
 * 例：' 亚丝娜（刀剑神域） ' → '亚丝娜(刀剑神域)'
 *     '初音ミク' / '初音 未来' → '初音ミク' / '初音未来'
 */
function normalizeKey(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[·・\u00b7]/g, '')
    .replace(/\s+/g, '');
}

/** 从「名字（限定）」里取出裸名 */
function bareOf(key) {
  return key.replace(/\(.*$/, '').trim();
}

/**
 * 查询官方英文名。
 *   1) 整串精确命中（名册里写了「亚丝娜（校服）（碧蓝档案）」这种带限定的名字时最准）
 *   2) 裸名命中（'亚丝娜（刀剑神域）' / '亚丝娜' → 'asuna (sao)'）
 *   3) 英文名反向命中（卡里直接写 'Rem' / 'hatsune miku' → 'rem (re zero)' / 'hatsune miku'）
 * 命中不了返回 ''（= 没有 english_name，调用方应**省略**该字段）。
 */
function lookupAnimeEnglishName(name) {
  const key = normalizeKey(name);
  if (!key) return '';
  const t = table();
  if (t.full && t.full[key]) return t.full[key];
  const bare = bareOf(key);
  if (bare.length >= 2 && t.names && t.names[bare]) return t.names[bare];
  if (t.en && t.en[key]) return t.en[key];
  if (bare.length >= 3 && t.en && t.en[bare]) return t.en[bare];
  return '';
}

/** 仅供调试/自检：表里有多少条 */
function tableStats() {
  const t = table();
  return {
    built_at: t.built_at || '',
    source: t.source || '',
    bare: Object.keys(t.names || {}).length,
    full: Object.keys(t.full || {}).length,
    en: Object.keys(t.en || {}).length,
    loaded: _table !== null,
  };
}

module.exports = { lookupAnimeEnglishName, normalizeKey, bareOf, tableStats, TABLE_PATH };

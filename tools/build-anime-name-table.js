#!/usr/bin/env node
/**
 * tools/build-anime-name-table.js —— 生成「热门二次元角色 中文译名 → 官方英文名」查询表
 *
 * 数据源（在线）：GitHub R0smontis/comfyui_anime_character_selector 的 data/wai_characters.csv
 *   —— WAI Illustrious 角色选择器用的中文角色名 ↔ 英文生图标签对照表（MIT 许可，5200+ 条）。
 *   GitHub 直连在本机不通，所以走 jsDelivr CDN 镜像；也可以用 --csv 指定本地文件离线重建。
 *
 * 产出：server/data/anime-character-names.json
 *   names[b]    裸名 → 英文名（同名多候选时按下面的规则挑一个）
 *   full[k]     带限定的整名 → 英文名（仅在同名有歧义时保留，用于精确消歧）
 *
 * 挑候选的规则（确定性，可复现）：
 *   ① 中文名括号更少（更接近标准名，如「初音未来（Vocaloid）」优于「初音未来（迷你版）（Vocaloid）」）
 *   ② 英文名括号更少（基础形态优于派生形态）
 *   ③ 英文名更短
 *   ④ 文件里出现更早（稳定兜底）
 *   裸名长度 < 2 的整条丢弃（单字名歧义太大，宁可不给锚点）
 *
 * 用法：
 *   node tools/build-anime-name-table.js                # 从 jsDelivr 拉取后重建
 *   node tools/build-anime-name-table.js --csv a.csv    # 用本地 CSV 重建
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeKey, bareOf, TABLE_PATH } = require('../server/utils/anime-names.js');

const CDN = 'https://cdn.jsdelivr.net/gh/R0smontis/comfyui_anime_character_selector@1.0.0/data/wai_characters.csv';
const SOURCE = 'https://github.com/R0smontis/comfyui_anime_character_selector (MIT) · data/wai_characters.csv';

const csvArg = (() => { const i = process.argv.indexOf('--csv'); return i >= 0 ? process.argv[i + 1] : ''; })();

async function loadCsv() {
  if (csvArg) return fs.readFileSync(csvArg, 'utf-8');
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(CDN, { signal: c.signal, headers: { 'User-Agent': 'ai-gal/build-anime-name-table' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(id); }
}

/** 打分：越小越好 */
function better(a, b) {
  for (const [x, y] of [[a.parens, b.parens], [a.enParens, b.enParens], [a.en.length, b.en.length], [a.idx, b.idx]]) {
    if (x !== y) return x < y;
  }
  return false;
}

(async () => {
  const csv = await loadCsv();
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const byBare = new Map();
  const allFull = new Map();
  let parsed = 0, skippedShort = 0;

  lines.forEach((line, idx) => {
    const cut = line.lastIndexOf(',');
    if (cut < 0) return;
    const zhRaw = line.slice(0, cut).trim();
    const enRaw = line.slice(cut + 1).trim();
    if (!zhRaw || !enRaw) return;
    parsed++;

    const key = normalizeKey(zhRaw);
    const bare = bareOf(key);
    if (!bare) return;
    const cand = {
      zh: zhRaw, en: enRaw, bare, key, idx,
      parens: (zhRaw.match(/[（(]/g) || []).length,
      enParens: (enRaw.match(/\(/g) || []).length,
    };
    if (!allFull.has(key)) allFull.set(key, cand);
    if (bare.length < 2) { skippedShort++; return; }   // 单字名歧义太大 → 只做整名精确匹配
    if (!byBare.has(bare)) byBare.set(bare, []);
    byBare.get(bare).push(cand);
  });

  const names = {};
  const full = {};
  const en = {};          // 反向：英文名/生图标签 → 带作品的规范标签（卡里直接写 Rem / Miku 时也能命中）
  const ambiguous = [];
  for (const [bare, cands] of byBare) {
    let best = cands[0];
    for (const c of cands.slice(1)) if (better(c, best)) best = c;
    names[bare] = best.en;
    // 只有「裸名有歧义」的才需要整名精确匹配来消歧（控制体积：全量存会让表大一倍）
    if (cands.length > 1) {
      ambiguous.push(bare);
      for (const c of cands) if (!full[c.key]) full[c.key] = c.en;
    }
    // 英文索引：英文裸名 → 它自己的规范标签（'rem' → 'rem (re zero)'）。
    // 每个候选都索引（英文标签本身是唯一确定的，不存在歧义），查询侧会先剥掉括号再查。
    const enBare = bareOf(normalizeKey(best.en));
    if (enBare && enBare.length >= 3 && !en[enBare]) en[enBare] = best.en;
    for (const c of cands) {
      const b = bareOf(normalizeKey(c.en));
      if (b && b.length >= 3 && !en[b]) en[b] = c.en;
    }
  }
  // 裸名被丢弃的（单字名）也只保留整名精确匹配
  for (const [k, c] of allFull) {
    if (!full[k] && !names[c.bare]) full[k] = c.en;
  }

  const out = {
    _comment: '热门二次元角色「中文译名 → 官方英文名/生图标签」查询表；由 tools/build-anime-name-table.js 生成，请勿手改。',
    source: SOURCE,
    built_at: new Date().toISOString(),
    stats: { csv_lines: lines.length, parsed, bare: Object.keys(names).length, full: Object.keys(full).length, en: Object.keys(en).length, skipped_single_char: skippedShort, ambiguous: ambiguous.length },
    names,
    full,
    en,
  };
  fs.mkdirSync(path.dirname(TABLE_PATH), { recursive: true });
  fs.writeFileSync(TABLE_PATH, JSON.stringify(out, null, 1) + '\n', 'utf-8');
  console.log('写出', path.relative(path.join(__dirname, '..'), TABLE_PATH));
  console.log(JSON.stringify(out.stats));
  console.log('抽样：雷姆 →', names['雷姆'], '｜亚丝娜 →', names['亚丝娜'], '｜初音未来 →', names['初音未来'], '｜御坂美琴 →', names['御坂美琴']);
})();

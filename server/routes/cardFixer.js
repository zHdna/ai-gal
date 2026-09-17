/**
 * Card Fixer - AI-powered character card optimization
 * Uses the default LLM provider with a dedicated system prompt
 * to deduplicate, restructure, and standardize character prompts.
 */
const { Router } = require('express');
const http = require('http');
const https = require('https');
const { decrypt: decryptApiKey } = require('../crypto');
const { APP_KEYS } = require('../constants');
const { detectMvuCard } = require('../mvu');

// Dedicated agent prompt — separate from game AI
const CARD_FIXER_PROMPT = `你是一个角色卡分析助手。你的任务是分析角色设定，提取以下元信息（仅输出JSON，不要任何其他文字）：

{"culture":"<wuxia|modern|fantasy|scifi|historical|other>","gender":"<female|male|npc>","wuxia":<true|false>}

- culture: 世界观类型（wuxia=武侠/修仙/仙侠/修真/江湖/宗门）
- gender: 主角色性别
- wuxia: 是否为修仙/武侠类（true=角色卡含修炼体系、功法、境界等）`;

const CARD_FIXER_PROMPT_LEGACY = `你是一个角色卡分析优化助手。你的核心任务是：

【首要任务：状态变量识别与格式化】
从角色卡中识别所有需要追踪的动态状态和属性变量（如生命值、魔力值、金钱、经验、物品、好感度、修为阶段、晋升进度、技能等级、门派贡献等），在优化后的系统提示词末尾追加状态变量白名单：

<p class="nowork">
<!-- STATUS_VARS -->
{
  "可追踪状态": [
    {"变量名": "HP", "中文名": "生命值", "初始值": "100/100", "描述": "角色的生命值"},
    {"变量名": "MP", "中文名": "魔力值", "初始值": "50/50", "描述": "角色的魔力值"}
  ]
}
<!-- /STATUS_VARS -->
</p>

变量名用英文标识符（代码key），中文名用于前端显示。初始值根据角色卡设定填写，如未设定填"未设定"。描述用简短中文。

【次要任务：去重合并】
把重复、含义相近的段落合并为一段简洁描述。保留所有关键信息，去除冗余表述。

【禁止项】
- 不要修改角色性格、说话风格、世界观设定
- 不要添加任何输出格式指令（如 ### story、### portrait 等——这些由系统统一管理）
- 不要添加服饰限定（如hanfu等——由系统根据wuxia属性自动处理）

【输出格式】
直接输出优化后的完整系统提示词文本（含STATUS_VARS块），不要加任何解释、前言或后缀。`;

// ── MVU fixer: normalize variables to stable English keys + Chinese labels,
//    emit a compatible <json_patch> emission appendix. Preserves engine blocks
//    (no destructive rewrite of the card's system prompt). ──
const CARD_FIXER_PROMPT_MVU = `你是一个 MVU 变量卡适配专家。给定一张使用引擎标记（<json_patch> / <UpdateVariables> / Tavern Helper MVU 脚本 / <variable_list>）的角色卡，请完成两件事：

1) 识别卡中所有状态变量，为每个变量确定：
   - key：稳定的【英文 dot-path】（如 "mc.energy"、"contact.haogan"、"Mainchar.XingYu"），必须与卡内引擎脚本/变量声明实际使用的键保持一致；绝对禁止用中文作键。
   - label：该变量的【中文显示名】，从卡内中文注释 / 中文变量名 / section 标题 / 括号描述中提取；若无可音译或意译。
   - type：int | string | bool | dict | record | list[dict] 之一
   - role：character_list | asset_list | gauge | info | progress | generic 之一
   - 若该变量是 list[dict]（角色/资产列表），额外给出 keyField（唯一标识字段名，通常为 "name"）

2) 生成一段"变量发射附录"文本（appendix）：用中文明确指示——"当上述任一变量发生变化时，每轮回复的最末尾必须输出一个 <json_patch> 块（RFC 6902 JSON 数组），path 用上面的英文 key 以 JSON 指针风格写出（'/' 分隔，如 /mc/energy），禁止用中文键、禁止用散文、禁止输出其他变量系统不支持的格式"。并给出 1 个 few-shot 范例（使用上面真实的 key，演示 replace / add / delta 操作）。

只输出一个 JSON 对象（不要任何其他文字、不要 markdown 代码块、不要解释）：
{"mvu_meta":{"fields":{"<key>":{"type":"<type>","role":"<role>","label":"<中文名>"[,"keyField":"<字段>"]}}},"appendix":"<发射附录文本>"}`;

async function runMvuFix({ apiUrl, apiKey, model, character, combinedPrompt, system_prompt }) {
  // Gather full context available from the stored character (no extensions column, but
  // character_book <variable_list>, first_message and stored mvu_meta are persisted).
  const ctxParts = [];
  if (character) {
    if (character.first_message) ctxParts.push('【开场白 first_message】\n' + character.first_message);
    if (character.character_book) {
      try {
        const book = JSON.parse(character.character_book);
        const entries = book.entries || [];
        const vl = entries.find(e => e.content && e.content.includes('<variable_list>'));
        if (vl) ctxParts.push('【变量声明 <variable_list>】\n' + vl.content);
      } catch { /* ignore */ }
    }
    if (character.mvu_meta) {
      try {
        const m = typeof character.mvu_meta === 'string' ? JSON.parse(character.mvu_meta) : character.mvu_meta;
        if (m && m.fields) ctxParts.push('【系统已识别的变量 (mvu_meta)】\n' + JSON.stringify(m.fields, null, 2));
      } catch { /* ignore */ }
    }
  }
  ctxParts.push('【系统提示词 system_prompt】\n' + combinedPrompt);
  const ctx = ctxParts.join('\n\n');

  const fixMsg = [
    { role: 'system', content: CARD_FIXER_PROMPT_MVU },
    { role: 'user', content: ctx.substring(0, 7000) }
  ];
  const fixBody = JSON.stringify({ model, messages: fixMsg, temperature: 0.2, max_tokens: 2048, stream: false });
  const raw = await callLLM(apiUrl, fixBody, apiKey);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('MVU fixer: LLM returned no JSON');
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { throw new Error('MVU fixer: invalid JSON from LLM'); }
  const fields = (parsed.mvu_meta && parsed.mvu_meta.fields) || parsed.fields || {};
  const mvu_meta = { fields };
  const appendix = (parsed.appendix || '').trim();
  const fixed_prompt = (system_prompt || '') + (appendix ? '\n\n' + appendix : '');
  return { fixed_prompt, mvu_meta };
}

module.exports = (db) => {
  const router = Router();

  router.post('/fix', async (req, res) => {
    const { system_prompt, personality, description, post_history_instructions, character_id } = req.body;

    // Load full character if id provided (MVU normalization needs character_book
    // <variable_list>, first_message and stored mvu_meta context).
    let character = null;
    if (character_id) {
      try { character = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id); } catch (e) { /* ignore */ }
    }

    const combinedPrompt = [system_prompt, personality, description, post_history_instructions]
      .filter(Boolean)
      .join('\n\n');

    const isMVU0 = detectMvuCard(character, combinedPrompt, system_prompt, post_history_instructions, description);
    let isMVU = isMVU0;

    if (!combinedPrompt.trim() && !character) {
      return res.status(400).json({ error: 'No prompt content to fix' });
    }

    try {
      // Resolve the provider the SAME way as the game's MAIN AI (主AI):
      //   app_settings.main_ai_provider_id  >  is_default provider
      // This prevents the card fixer from being pinned to the local default model
      // (llama.cpp) when the user has configured a dedicated 主AI.
      let providerId = null;
      const mainAiSetting = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APP_KEYS.MAIN_AI_PROVIDER_ID);
      if (mainAiSetting && mainAiSetting.value) providerId = mainAiSetting.value;
      let provider = providerId
        ? db.prepare('SELECT * FROM api_providers WHERE id = ?').get(providerId)
        : null;
      if (!provider) {
        provider = db.prepare('SELECT * FROM api_providers WHERE is_default = 1 LIMIT 1').get();
      }
      if (!provider) {
        return res.status(500).json({ error: 'No API provider configured' });
      }

      const baseUrl = provider.base_url || 'http://127.0.0.1:8080';
      const model = provider.model || '';
      const apiUrl = buildProviderUrl(baseUrl);
      const apiKey = decryptApiKey(provider.api_key);

      // --- Step 1: Analyze culture, gender & wuxia ---
      const analysisMsg = [
        { role: 'system', content: `分析以下角色卡，只输出一个JSON对象，不要任何其他文字：{"culture":"<wuxia|modern|fantasy|scifi|historical|other>","gender":"<female|male|npc>","wuxia":<true|false>}

culture判定关键词：
- 含"修仙|仙侠|修真|剑仙|道长|炼丹|功法|御剑|真气|内力|灵气|渡劫|飞升|江湖|武林|侠客|门派|宗门|掌法|剑法|轻功|暗器|点穴|内力|真气|修为|境界|灵根|筑基|金丹|元婴" → wuxia
- 含"魔法|龙|精灵|骑士|巫师|魔导师|圣骑士" → fantasy
- 含"太空|飞船|AI|机器人|赛博|机甲|星际" → scifi
- 含"皇宫|朝堂|古代|征战|将军|帝王|朝代"但无上述武侠修仙词 → historical
- 含"学校|都市|公司|手机|网络|咖啡厅|现代" → modern
- 以上均不匹配 → other

wuxia判定：culture为"wuxia"时wuxia填true，否则填false

gender判定关键词：
- 含"性别：男|性别:男|男性|少年|他是|他是|he/him|小伙子|男子" → male
- 含"性别：女|性别:女|女性|少女|她是|她是|she/her|姑娘|女孩" → female
- 配角/路人/非重要角色/非人类 → npc
- 默认 → 检查角色卡文本中是否有明确男性标识，如无则 female` },
        { role: 'user', content: combinedPrompt.substring(0, 2500) }
      ];

      const analysisBody = JSON.stringify({ model, messages: analysisMsg, temperature: 0.1, max_tokens: 128, stream: false });
      let metadata = { culture: 'other', gender: 'female', wuxia: false };

      // Code-based pre-detection before AI call (improves accuracy for obvious cases)
      const lowerPrompt = combinedPrompt.toLowerCase();
      if (/性别[：:]\s*男|男性角色|男性|少年(?!女)|he\/him|小伙子|男子/.test(combinedPrompt)) {
        metadata.gender = 'male';
        console.log('[CardFixer] Code pre-detect: male');
      }

      try {
        const analysisRaw = await callLLM(apiUrl, analysisBody, apiKey);
        const jsonMatch = analysisRaw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          metadata.culture = parsed.culture || 'other';
          metadata.gender = parsed.gender || 'female';
          metadata.wuxia = parsed.wuxia || (parsed.culture === 'wuxia');
        }
        console.log('[CardFixer] AI analysis:', metadata);
      } catch (err) {
        console.warn('[CardFixer] AI analysis failed, using code-based detection:', err.message);
      }

      // Code-level fallback: if AI returned "other", double-check with keywords
      if (metadata.culture === 'other') {
        const lower = combinedPrompt.toLowerCase();
        if (/修仙|仙侠|修真|剑仙|道长|炼丹|功法|御剑|真气|内力|灵气|渡劫|飞升|江湖|武林|侠客|门派|宗门|掌法|剑法|轻功/.test(lower)) {
          metadata.culture = 'wuxia';
          console.log('[CardFixer] Code correction: other → wuxia');
        } else if (/魔法|龙|精灵|骑士|巫师|魔导师/.test(lower)) {
          metadata.culture = 'fantasy';
        } else if (/太空|飞船|ai|机器人|赛博|机甲|星际/.test(lower)) {
          metadata.culture = 'scifi';
        } else if (/皇宫|朝堂|古代|征战|将军|帝王|朝代/.test(lower)) {
          metadata.culture = 'historical';
        }
      }
      // Set wuxia flag from culture
      metadata.wuxia = metadata.culture === 'wuxia';
      // Code-level gender correction: override AI's "female" if strong male signals exist
      if (metadata.gender === 'female' && /性别[：:]\s*男|男性|少年(?!女)|he\/him|小伙子|男子|他是(?!她)/.test(combinedPrompt)) {
        metadata.gender = 'male';
        console.log('[CardFixer] Code correction: female → male');
      }
      // Code-level gender correction: override AI's "male" if strong female signals exist
      if (metadata.gender === 'male' && /性别[：:]\s*女|女性|少女|she\/her|姑娘|女孩|她是(?!他)/.test(combinedPrompt)) {
        metadata.gender = 'female';
        console.log('[CardFixer] Code correction: male → female');
      }
      console.log('[CardFixer] Final analysis:', metadata);

      // --- Step 2: Optimize prompt (MVU branch vs LEGACY branch) ---
      let fixed = '';
      let mvuMeta = null;
      if (isMVU) {
        // MVU branch: normalize variables to English keys + Chinese labels, emit a
        // compatible <json_patch> emission appendix. Preserves engine blocks.
        try {
          const r = await runMvuFix({
            apiUrl, apiKey, model, character,
            combinedPrompt,
            system_prompt: system_prompt || (character && character.system_prompt) || ''
          });
          fixed = r.fixed_prompt;
          mvuMeta = r.mvu_meta;
          // Persist directly so the one-click fix takes effect on the stored card.
          if (character && character.id) {
            try {
              db.prepare(`UPDATE characters SET system_prompt = ?, mvu_meta = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(fixed, JSON.stringify(mvuMeta), JSON.stringify({ ui_hints: { hasMVU: true, requiresStatus: false } }), character.id);
              console.log('[CardFixer] MVU card normalized & persisted:', character.id);
            } catch (pe) { console.error('[CardFixer] MVU persist error:', pe.message); }
          }
        } catch (mvuErr) {
          console.error('[CardFixer] MVU fix failed, falling back to legacy:', mvuErr.message);
          isMVU = false; // fall through to LEGACY
        }
      }
      if (!isMVU) {
        try {
          // Check for custom card fixer prompt
          const customPromptRow = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APP_KEYS.CARD_FIXER_PROMPT);
          const fixerPrompt = (customPromptRow && customPromptRow.value && customPromptRow.value.trim())
            ? customPromptRow.value.trim()
            : CARD_FIXER_PROMPT_LEGACY;

          const fixMsg = [
            { role: 'system', content: fixerPrompt },
            { role: 'user', content: `请优化以下角色卡系统提示词：\n\n${combinedPrompt}` }
          ];
          const fixBody = JSON.stringify({ model, messages: fixMsg, temperature: 0.3, max_tokens: 4096, stream: false });
          fixed = await callLLM(apiUrl, fixBody, apiKey);
        } catch (fixErr) {
          console.error('[CardFixer] LLM fix failed, using code-based:', fixErr.message);
          fixed = combinedPrompt;
        }
      }

      // --- Step 3: Code-level post-processing (LEGACY only; MVU appendix stays verbatim) ---
      if (!isMVU) {
        // HTML comment transformation: <!-- ... --> → <p class="nowork"><!-- ... --></p>
        fixed = fixed.replace(/<p\s+class="nowork">\s*(<!--[\s\S]*?-->)\s*<\/p>/g, '$1');
        fixed = fixed.replace(/<!--[\s\S]*?-->/g, '<p class="nowork">$&</p>');
      }

      const resp = { fixed_prompt: fixed, metadata };
      if (mvuMeta) {
        resp.mvu_meta = mvuMeta;
        resp.mvu = true;
        // make sure response metadata carries the MVU UI hint so frontend save preserves it
        if (metadata && typeof metadata === 'object') metadata.ui_hints = { hasMVU: true, requiresStatus: false };
      }
      res.json(resp);
    } catch (err) {
      console.error('[CardFixer] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

function buildProviderUrl(baseUrl) {
  let url = baseUrl.replace(/\/$/, '');
  if (url.includes('/chat/completions')) return url;
  if (url.includes('/v1')) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}

function callLLM(apiUrl, body, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(apiUrl);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Local LLM (llama.cpp etc.): disable keep-alive so a finished request releases
    // the slot immediately — otherwise the connection pool can starve other modules
    // (same rule as chat.js / reader.js / AI-GAL cardFixer).
    const isLocalLLM = urlObj.hostname === '127.0.0.1' || urlObj.hostname === 'localhost' || urlObj.hostname.startsWith('192.168.');

    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
      agent: isLocalLLM ? false : undefined,
    };

    if (isLocalLLM) opts.headers['Connection'] = 'close';
    if (apiKey) {
      opts.headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const req = transport.request(opts, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content.trim());
        } catch (e) {
          reject(new Error('Failed to parse LLM response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

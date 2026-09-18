/**
 * TTS Routes — Cloud API Provider (OpenAI-compatible /v1/audio/speech)
 * Independent tts_providers table, separate from LLM api_providers.
 */
const { Router } = require('express');
const { encrypt, decrypt } = require('../crypto');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isPathWithin } = require('../utils/pathGuard');

const TTS_CACHE_DIR = require('../paths').TTS_CACHE_DIR;
const TTS_QUEUE_FILE = require('../paths').TTS_QUEUE_FILE;

const TTS_SETTINGS_KEY = 'tts_api_settings';

// Module-level guard so the cloud keep-alive heartbeat timer is never started twice
// (e.g. on route hot-reload which re-invokes buildTTSRouter).
let _ttsHeartbeatTimer = null;

// Sanitize a cache-file name component to ASCII only. HTTP header values must be
// Latin-1/ASCII; Chinese/non-ASCII chars in the filename would throw ERR_INVALID_CHAR
// on res.set('X-TTS-Cache-File', ...). Keep an ASCII prefix and append a short hash of
// the original for uniqueness when non-ASCII chars were stripped.
function asciiSafeName(str, maxLen) {
  const cleaned = String(str == null ? '' : str).replace(/[\\/:*?"<>|]/g, '_');
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '');
  if (ascii.length > 0 && ascii === cleaned) {
    return ascii.substring(0, maxLen || 30);
  }
  const hash = crypto.createHash('md5').update(cleaned, 'utf8').digest('hex').substring(0, 16);
  const prefix = ascii.replace(/\s+/g, '_').substring(0, Math.max(0, (maxLen || 30) - 17));
  return (prefix + (prefix ? '_' : '') + hash).substring(0, maxLen || 30);
}

// ============ ComfyUI Qwen3-TTS VoiceDesign workflow ============
// 本机 ComfyUI 工作流 TTS：不使用固定声线，而是用「类型(用户在角色音声映射中
// 选择的标签) + 情绪(AI 根据剧情当场给出)」组合成自然语言 voice_description。
const COMFY_TTS_WORKFLOW_PATH = path.join(__dirname, '..', '..', 'qwen3-tts-01.json');
const COMFY_OUTPUT_NODE = '3'; // SaveAudioMP3 节点 id（输出 mp3）

// 12 种声音类型标签（用户在角色音声映射中为每个角色选择其一）
const COMFY_VOICE_LABELS = [
  '沉稳专业', '温暖治愈', '活力阳光', '冷峻神秘', '儒雅学者', '痞帅不羁',          // 男声 6 类
  '知性优雅', '甜美少女', '御姐干练', '空灵仙气', '泼辣市井', '冷艳疏离'           // 女声 6 类
];
// 标签 -> 自然语言音色描述前缀（后端拼成 voice_description）
const COMFY_VOICE_DESC = {
  '沉稳专业': '一个沉稳专业的男声', '温暖治愈': '一个温暖治愈的男声', '活力阳光': '一个活力阳光的男声',
  '冷峻神秘': '一个冷峻神秘的男声', '儒雅学者': '一个儒雅学者的男声', '痞帅不羁': '一个痞帅不羁的男声',
  '知性优雅': '一个知性优雅的女声', '甜美少女': '一个甜美少女的女声', '御姐干练': '一个御姐干练的女声',
  '空灵仙气': '一个空灵仙气的女声', '泼辣市井': '一个泼辣市井的女声', '冷艳疏离': '一个冷艳疏离的女声'
};
// 旁白无对应标签时使用的默认音色描述
const COMFY_NARRATOR_DESC = '一个沉稳大气的旁白女声';

// ============ 云百炼 (阿里云 DashScope) 语音合成 ============
// 百炼平台 TTS 模型清单：compatible-mode /v1/models 通常不含 TTS 模型，故这里仅作为
// 「平台识别」回退清单——优先实时拉取，仅在 API 未暴露 TTS 模型时使用。
// 若希望彻底不硬编码，可删除此数组（前端已支持手动输入任意模型名）。
const BAILIAN_TTS_MODELS = [
  'qwen-audio-3.0-tts-flash', 'qwen-audio-3.0-tts-plus',
  'qwen3-tts-flash', 'qwen3-tts-instruct-flash', 'qwen3-tts-flash-realtime',
  'cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3-flash', 'cosyvoice-v2'
];

// 百炼各模型「系统音色」清单。官方文档明确：音色不能跨模型混用，
// 错配会返回 InvalidParameter（表现为 [cosyvoice:]Engine error [411]: TTS speak operation failed）。
// 参考 https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
const BAILIAN_QWEN3_VOICES = ['Cherry', 'Ethan', 'Serena', 'Carly', 'Ada', 'Bella', 'Donna', 'Alice'];
const BAILIAN_FLASH_VOICES = [
  'longanhuan_v3.6', 'longjielidou_v3.6', 'loongeva_v3.6', 'loongjohn',
  'longanfengyue', 'longanyuanfei', 'longanlingxi', 'longanxiaoxin',
  'longpaopao_v3.6', 'longhuohuo_v3.6', 'longchuanshu_v3.6', 'loongmary'
];
const BAILIAN_PLUS_VOICES = [
  'longanlingxin', 'longanlufeng',
  'longanhuan_v3.6', 'longjielidou_v3.6', 'loongeva_v3.6', 'loongjohn',
  'longanfengyue', 'longanyuanfei', 'longanlingxi', 'longanxiaoxin',
  'longpaopao_v3.6', 'longhuohuo_v3.6', 'longchuanshu_v3.6', 'loongmary'
];
// CosyVoice 各版本音色互不通用：v2 用经典无后缀音色；v3 / v3.5 必须用 _v3 后缀音色。
// 错配会触发 [cosyvoice:]Engine error [411]: TTS speak operation failed。
// 来源：阿里云百炼 CosyVoice 音色列表（https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list）
const BAILIAN_COSYVOICE_V2_VOICES = [
  'longxiaochun', 'longwan', 'longcheng', 'longhao', 'longshu', 'longjing', 'longmiao',
  'longyue', 'longyuan', 'longfei', 'longtong', 'longbao', 'longxiaoxia', 'longlaotie', 'longtu', 'longqiao'
];
const BAILIAN_COSYVOICE_V3_VOICES = [
  'longanyang', 'longanhuan_v3', 'longanhuan', 'longhuhu_v3', 'longpaopao_v3', 'longjielidou_v3',
  'longxian_v3', 'longling_v3', 'longshanshan_v3', 'longniuniu_v3', 'longjiaxin_v3', 'longjiayi_v3',
  'longanyue_v3', 'longlaotie_v3', 'longshange_v3', 'longanmin_v3', 'longfei_v3', 'longyingxiao_v3',
  'longyingxun_v3', 'longyingjing_v3', 'longyingling_v3', 'longyingtao_v3', 'longxiaochun_v3',
  'longxiaoxia_v3', 'longyumi_v3', 'longanyun_v3', 'longanwen_v3', 'longanli_v3', 'longanlang_v3',
  'longyingmu_v3', 'longantai_v3', 'longhua_v3', 'longcheng_v3', 'longze_v3', 'longzhe_v3',
  'longyan_v3', 'longxing_v3', 'longtian_v3', 'longwan_v3', 'longqiang_v3', 'longfeifei_v3',
  'longhao_v3', 'longanrou_v3', 'longhan_v3', 'longanzhi_v3', 'longanling_v3', 'longanya_v3',
  'longanqin_v3', 'longmiao_v3', 'longsanshu_v3', 'longyuan_v3', 'longyue_v3', 'longxiu_v3',
  'longnan_v3', 'longwanjun_v3', 'longyichen_v3', 'longlaobo_v3', 'longlaoyi_v3', 'longjiqi_v3',
  'longhouge_v3', 'longdaiyu_v3', 'longanran_v3', 'longanxuan_v3', 'longshuo_v3', 'longshu_v3', 'loongbella_v3'
];

/** 某模型是否属于 CosyVoice v3 / v3.5 家族（必须用 _v3 音色） */
function isCosyVoiceV3(model) {
  return /cosyvoice-(v3|v3\.5|3)/.test(model || '');
}
/** 取某模型支持的音色集合（用于前端下拉与后端校验） */
function getBailianVoiceSet(model) {
  if (/qwen-audio-3\.0-tts-flash/.test(model || '')) return BAILIAN_FLASH_VOICES;
  if (/qwen-audio-3\.0-tts-plus/.test(model || '')) return BAILIAN_PLUS_VOICES;
  if (/qwen3-tts-flash-realtime/.test(model || '')) return BAILIAN_QWEN3_VOICES;
  if (isCosyVoiceV3(model)) return BAILIAN_COSYVOICE_V3_VOICES;
  if (/cosyvoice/.test(model || '')) return BAILIAN_COSYVOICE_V2_VOICES; // cosyvoice-v2
  return BAILIAN_QWEN3_VOICES; // qwen3-tts-flash / qwen3-tts-instruct-flash（HTTP）
}
/** 模型默认音色（保证一定合法，避免 411） */
function defaultBailianVoice(model) {
  if (/qwen-audio-3\.0-tts-flash/.test(model || '')) return 'longanhuan_v3.6';
  if (/qwen-audio-3\.0-tts-plus/.test(model || '')) return 'longanlingxin';
  if (/qwen3-tts-flash-realtime/.test(model || '')) return 'Cherry';
  if (isCosyVoiceV3(model)) return 'longanyang';
  if (/cosyvoice/.test(model || '')) return 'longxiaochun'; // cosyvoice-v2
  return 'Cherry';
}
/** 校验 voice 是否属于该模型支持范围 */
function isBailianVoiceValid(model, voice) {
  if (!voice) return false;
  if (/qwen-audio-3\.0-tts/.test(model || '')) {
    // 基础音色（声音复刻）命名形如 qwen-audio-3.0-tts-flash-<suffix>，同样有效
    return getBailianVoiceSet(model).includes(voice) || /^qwen-audio-3\.0-tts-(flash|plus)-/.test(voice || '');
  }
  return getBailianVoiceSet(model).includes(voice);
}

/** 判断是否为阿里云百炼 / DashScope 平台（按 URL 或显式 api_format 识别） */
function isBailianProvider(baseUrl, apiFormat) {
  const u = (baseUrl || '').toLowerCase();
  return apiFormat === 'bailian'
    || u.includes('dashscope.aliyuncs.com')
    || u.includes('bailian')
    || u.includes('aliyun')
    || u.includes('qwen.ai')
    || u.includes('qianwenai');
}

/** 判断是否为「仅支持 WebSocket」的实时模型（CosyVoice 系列、*-realtime 后缀）。
 *  Qwen-Audio-TTS / Qwen3-TTS 系列同时支持 HTTP 与 WebSocket，走 HTTP 生成接口即可。 */
function isBailianRealtimeModel(model) {
  // 仅 WebSocket(tts_v2) 模型走 WS：cosyvoice 系列、*-realtime 实时模型、
  // 以及 qwen-audio-3.0-tts 系列（官方文档明确为 tts_v2 实时接口）。
  // 注意：qwen3-TTS 系列(qwen3-tts-flash / qwen3-tts-instruct-flash) 走 HTTP 旧端点，不在此列。
  return /cosyvoice|qwen-tts-realtime|-realtime$|qwen-audio-3\.0-tts/.test(model || '');
}

/** 是否为 qwen-audio-3.0-tts 系列（仅此系列支持文本内嵌 [tag] 情绪控制标签，
 *  见 https://platform.qianwenai.com/docs/developer-guides/speech/tts）。CosyVoice 不支持。 */
function isQwenAudioTTS(model) {
  return /qwen-audio-3\.0-tts/.test(model || '');
}

/**
 * 中文情绪词 → 千问 AI 平台 TTS 控制标签映射（参考 qianwenai 文档「情感与富语言标签」）。
 * 这些 [tag] 内嵌在 continue-task 文本最前面，服务端据此控制整句情绪，且【不会被念出来】。
 * key 为 AI 输出的情绪短语中会出现的中文片段（情绪副词优先于情绪动作，故先列副词）。
 * 旁白/无情绪对白不会命中任何 key → 返回 ''（不注入标签，保持中性）。
 */
const EMOTION_TAG_MAP = {
  // —— 情绪副词（优先匹配）——
  '激动': '[excited]', '兴奋': '[excited]', '喜悦': '[excited]', '欢快': '[excited]', '开心': '[excited]', '欣喜': '[excited]',
  '愤怒': '[angry]', '生气': '[angry]', '恼怒': '[angry]',
  '悲伤': '[sad]', '难过': '[sad]', '伤心': '[sad]', '哀伤': '[sad]',
  '绝望': '[crying]', '哭': '[crying]', '抽泣': '[crying]', '呜咽': '[crying]',
  '温柔': '[empathetic]', '轻柔': '[empathetic]', '柔声': '[empathetic]', '安抚': '[empathetic]',
  '嘲讽': '[sarcastic]', '讽刺': '[sarcastic]', '讥讽': '[sarcastic]',
  '轻蔑': '[scornful]', '鄙夷': '[scornful]', '不屑': '[scornful]',
  '害羞': '[whispers]', '羞涩': '[whispers]', '腼腆': '[whispers]',
  '坚定': '[serious]', '毅然': '[serious]', '决然': '[serious]',
  '犹豫': '[reluctantly]', '迟疑': '[reluctantly]', '踌躇': '[reluctantly]',
  '冷漠': '[bored]', '冷淡': '[bored]', '漠然': '[bored]',
  '恐惧': '[panicked]', '害怕': '[panicked]', '惊恐': '[panicked]', '畏惧': '[panicked]',
  '惊讶': '[amazed]', '吃惊': '[amazed]', '惊异': '[amazed]', '诧异': '[amazed]',
  '疲惫': '[tired]', '疲倦': '[tired]', '困倦': '[tired]',
  '焦急': '[panicked]', '着急': '[panicked]', '慌张': '[panicked]',
  '轻声': '[whispers]', '低声': '[whispers]', '小声': '[whispers]',
  '神秘': '[like dracula]', '阴森': '[like dracula]', '诡异': '[like dracula]',
  '颤抖': '[trembling]', '战栗': '[trembling]', '发抖': '[trembling]',
  '好奇': '[curious]', '疑惑': '[curious]',
  '戏谑': '[mischievously]', '调皮': '[mischievously]', '俏皮': '[mischievously]',
  // —— 情绪动作（副词之后才匹配；多数已由上方的副词命中，这里补充纯动作短语 ——
  '吼': '[shouting]', '咆哮': '[shouting]', '嘶吼': '[shouting]', '喊': '[shouting]', '叫': '[shouting]',
  '耳语': '[whispers]', '呢喃': '[whispers]', '低语': '[whispers]',
  '质问': '[serious]', '诘问': '[serious]', '哀求': '[serious]', '恳求': '[serious]',
  '冷笑': '[sarcastic]', '嗤笑': '[sarcastic]', '讥笑': '[sarcastic]'
};

/** 从情绪短语（如「用清亮甜美的年轻女声，激动地」或「愤怒地吼道」）中解析出 qwen-audio 控制标签。
 *  返回 '' 表示无情绪（中性）。命中规则：短语中出现任一 map key 即返回对应 [tag]，副词优先。 */
function mapEmotionToTag(phrase) {
  if (!phrase) return '';
  const p = String(phrase).trim();
  for (const key of Object.keys(EMOTION_TAG_MAP)) {
    if (p.includes(key)) return EMOTION_TAG_MAP[key];
  }
  return '';
}

/** 把本地语言代码映射到百炼 language_type（留空则让模型自动检测） */
function mapBailianLang(lang) {
  const l = (lang || 'zh-CN').toLowerCase();
  if (l.startsWith('zh')) return 'Chinese';
  if (l.startsWith('en')) return 'English';
  if (l.startsWith('ja')) return 'Japanese';
  if (l.startsWith('ko')) return 'Korean';
  if (l.startsWith('fr')) return 'French';
  if (l.startsWith('de')) return 'German';
  if (l.startsWith('es')) return 'Spanish';
  return '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// POST JSON 到 ComfyUI，返回 prompt_id（含节点校验错误处理）
async function comfyHttpPost(baseUrl, pathname, bodyObj) {
  const u = new URL(pathname, baseUrl.replace(/\/+$/, ''));
  const data = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Connection': 'close', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data, 'utf8') },
      timeout: 15000, agent: false
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          if (json.error && !json.prompt_id) {
            const errInfo = [];
            if (json.node_errors) {
              for (const [nid, ne] of Object.entries(json.node_errors)) {
                if (ne.errors && ne.errors.length) errInfo.push(`node ${nid}(${ne.class_type}): ${ne.errors.map(e => e.message || JSON.stringify(e)).join('; ')}`);
              }
            }
            reject(new Error(`ComfyUI rejected: ${json.error.type} - ${errInfo.join(' | ') || json.error.message}`));
          } else resolve(json.prompt_id || json);
        } catch (e) { reject(new Error('ComfyUI /prompt 响应解析失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ComfyUI /prompt 连接超时')); });
    // 显式以 UTF-8 写出字节，确保含中文的 voice_description 不会被编码损坏
    req.write(Buffer.from(data, 'utf8'));
    req.end();
  });
}

async function comfyHttpGetJson(urlStr) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    http.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, agent: false, headers: { 'Connection': 'close' }
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('ComfyUI 响应 JSON 解析失败: ' + e.message)); } });
    }).on('error', reject);
  });
}

// 轮询 ComfyUI /history，取 SaveAudioMP3 节点输出（兼容 audio 与 images 两种字段名）
async function comfyWaitForOutput(baseUrl, promptId, maxWait = 600) {
  const base = baseUrl.replace(/\/+$/, '');
  for (let i = 0; i < maxWait; i++) {
    await sleep(2000);
    try {
      const result = await comfyHttpGetJson(`${base}/history/${promptId}`);
      const entry = result && result[promptId];
      if (!entry) continue;
      // ComfyUI 执行失败时 status.status_str === 'error'；此时再等也不会出音频，
      // 立即放弃，避免傻等满超时（否则长对白已失败还会空占单飞锁）。
      const st = entry.status && entry.status.status_str;
      if (st === 'error') return null;
      if (entry.outputs) {
        const outputs = entry.outputs;
        for (const nodeId of Object.keys(outputs)) {
          const node = outputs[nodeId];
          const audio = (node.audio && node.audio[0]) || (node.images && node.images[0]);
          if (audio) return { filename: audio.filename, subfolder: audio.subfolder || '', type: audio.type || 'output' };
        }
      }
    } catch (e) { /* 轮询期间偶发错误，继续重试 */ }
  }
  return null;
}

async function comfyDownloadAudio(baseUrl, fileInfo, savePath) {
  const base = baseUrl.replace(/\/+$/, '');
  const viewUrl = new URL(`/view?filename=${encodeURIComponent(fileInfo.filename)}&subfolder=${encodeURIComponent(fileInfo.subfolder)}&type=${encodeURIComponent(fileInfo.type)}`, base);
  return new Promise((resolve, reject) => {
    http.get({
      hostname: viewUrl.hostname, port: viewUrl.port || (viewUrl.protocol === 'https:' ? 443 : 80),
      path: viewUrl.pathname + viewUrl.search, agent: false, headers: { 'Connection': 'close' }
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`ComfyUI /view 返回 ${res.statusCode}`)); }
      const file = fs.createWriteStream(savePath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
  });
}

function buildTTSRouter(db) {
  const router = Router();

  // ============ TTS Provider CRUD ============

  // GET /api/tts/providers
  router.get('/providers', (req, res) => {
    const rows = db.prepare("SELECT id, name, base_url, model, voice, speed, instruction, api_format, language, voice_map, is_default, created_at FROM tts_providers ORDER BY is_default DESC, name").all();
    res.json(rows);
  });

  // POST /api/tts/providers — create
  router.post('/providers', (req, res) => {
    const { name, base_url, api_key, model, voice, speed, instruction, api_format, language, voice_map, is_default } = req.body;
    if (!name || !base_url) return res.status(400).json({ error: 'name and base_url required' });
    const id = crypto.randomUUID();
    const encKey = api_key ? encrypt(api_key) : '';
    if (is_default) db.prepare("UPDATE tts_providers SET is_default = 0").run();
    db.prepare(`INSERT INTO tts_providers (id, name, base_url, api_key, model, voice, speed, instruction, api_format, language, voice_map, is_default)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, base_url, encKey, model || 'tts-1', voice || 'alloy', speed || 1.0, instruction || '', api_format || 'openai', language || 'zh-CN', JSON.stringify(voice_map || {}), is_default ? 1 : 0);
    res.json({ id, success: true });
  });

  // PUT /api/tts/providers/:id — update
  router.put('/providers/:id', (req, res) => {
    const row = db.prepare("SELECT id FROM tts_providers WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { name, base_url, api_key, model, voice, speed, instruction, api_format, language, voice_map, is_default } = req.body;
    const updates = [];
    const vals = [];
    if (name !== undefined) { updates.push('name = ?'); vals.push(name); }
    if (base_url !== undefined) { updates.push('base_url = ?'); vals.push(base_url); }
    if (api_key !== undefined) { updates.push('api_key = ?'); vals.push(encrypt(api_key)); }
    if (model !== undefined) { updates.push('model = ?'); vals.push(model); }
    if (voice !== undefined) { updates.push('voice = ?'); vals.push(voice); }
    if (speed !== undefined) { updates.push('speed = ?'); vals.push(speed); }
    if (instruction !== undefined) { updates.push('instruction = ?'); vals.push(instruction); }
    if (api_format !== undefined) { updates.push('api_format = ?'); vals.push(api_format); }
    if (voice_map !== undefined) { updates.push('voice_map = ?'); vals.push(JSON.stringify(voice_map)); }
    if (language !== undefined) { updates.push('language = ?'); vals.push(language); }
    if (is_default !== undefined) {
      if (is_default) db.prepare("UPDATE tts_providers SET is_default = 0").run();
      updates.push('is_default = ?'); vals.push(is_default ? 1 : 0);
    }
    updates.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE tts_providers SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true });
  });

  // DELETE /api/tts/providers/:id
  router.delete('/providers/:id', (req, res) => {
    db.prepare("DELETE FROM tts_providers WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // 部分 TTS 网关（如 Volink）的标准 OpenAI /v1/models 只列出 LLM 文本模型，
  // 真正的 TTS 模型暴露在专用 /tts/models 端点（返回 { models: [{ id, name, ... }] }，
  // 与 QwenAPI 格式一致）。本函数作为回退：标准端点无 TTS 模型时再试 /tts/models。
  function fetchTTSModelsEndpoint(baseUrl, apiKey) {
    return new Promise((resolve, reject) => {
      const u = new URL(baseUrl.replace(/\/+$/, '') + '/tts/models');
      const transport = u.protocol === 'https:' ? https : http;
      const headers = { 'Connection': 'close' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const r = transport.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname, method: 'GET', headers, timeout: 15000, agent: false
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (resp.statusCode !== 200) { reject(new Error('HTTP ' + resp.statusCode)); return; }
          try {
            const data = JSON.parse(body);
            const arr = data.models || data.data || data || [];
            const models = arr.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
            resolve(models);
          } catch (e) { reject(new Error('Failed to parse /tts/models response')); }
        });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.end();
    });
  }

  // POST /api/tts/models — fetch available models from any URL+Key (no save needed)
  router.post('/models', async (req, res) => {
    const { base_url, api_key } = req.body;
    if (!base_url) return res.status(400).json({ error: 'base_url required' });
    try {
      const baseUrl = base_url.replace(/\/+$/, '');

      // Qwen3-TTS (local or cloud) — fetch from /qwenapi/v1/models
      // Response format: { models: [{ name, type }, ...] }
      const isQwenAPI = baseUrl.includes('127.0.0.1:7860') || baseUrl.includes('localhost:7860')
        || baseUrl.includes('/qwenapi') || baseUrl.includes('cnb');
      if (isQwenAPI) {
        let qwenModelUrl = baseUrl;
        if (qwenModelUrl.endsWith('/qwenapi/v1')) qwenModelUrl = qwenModelUrl + '/models';
        else if (qwenModelUrl.endsWith('/qwenapi')) qwenModelUrl = qwenModelUrl + '/v1/models';
        else qwenModelUrl = qwenModelUrl + '/qwenapi/v1/models';
        const url = new URL(qwenModelUrl);
        const transport = url.protocol === 'https:' ? https : http;
        const result = await new Promise((resolve, reject) => {
          const r = transport.request({
            hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname, method: 'GET', headers: { 'Connection': 'close' }, timeout: 15000, agent: false
          }, (resp) => {
            const chunks = [];
            resp.on('data', c => chunks.push(c));
            resp.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              // 404 means Qwen3-TTS WebUI is running but --api flag was not used
              if (resp.statusCode === 404) {
                reject(new Error('Qwen3-TTS WebUI 正在运行，但未启用 API。请使用 --api 参数重启 Qwen3-TTS (例如: python launch.py --api)。'));
                return;
              }
              if (resp.statusCode !== 200) {
                reject(new Error(`Qwen3-TTS 返回 HTTP ${resp.statusCode}: ${body.substring(0, 200)}`));
                return;
              }
              try {
                const data = JSON.parse(body);
                // Qwen3-TTS returns { models: [{ name, type }, ...] }
                const arr = data.models || data.data || data || [];
                const models = arr.map(m => typeof m === 'string' ? m : (m.name || m.id || '')).filter(Boolean);
                resolve(models);
              } catch (e) { reject(new Error('Failed to parse QwenAPI models response: ' + body.substring(0, 200))); }
            });
          });
          r.on('error', (e) => {
            // Friendlier message when local Qwen3-TTS service is not running
            if (e.code === 'ECONNREFUSED' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
              reject(new Error(`无法连接到本机 Qwen3-TTS 服务 (${url.host})。请先启动 Qwen3-TTS WebUI (需加 --api 参数启用 API)。`));
            } else {
              reject(e);
            }
          });
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.end();
        });
        res.json(result);
        return;
      }

      // 云百炼 (阿里云 DashScope) — 实时拉取模型清单（compatible-mode /v1/models）
      if (isBailianProvider(baseUrl, null)) {
        try {
          const models = await fetchBailianModels(api_key);
          res.json(models);
        } catch (e) {
          res.status(502).json({ error: 'Failed to fetch 百炼 models: ' + e.message });
        }
        return;
      }

      // Build /models URL for OpenAI-compatible providers
      let modelUrl;
      if (baseUrl.endsWith('/audio/speech') || baseUrl.endsWith('/audio/synthesize') || baseUrl.endsWith('/tts/speech')) {
        modelUrl = baseUrl.replace(/\/audio\/(speech|synthesize)/, '/models').replace(/\/tts\/speech/, '/models');
      } else if (baseUrl.endsWith('/v1') || baseUrl.endsWith('/v2')) {
        modelUrl = baseUrl + '/models';
      } else {
        modelUrl = baseUrl + '/v1/models';
      }
      const url = new URL(modelUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const result = await new Promise((resolve, reject) => {
        const headers = { 'Connection': 'close' };
        if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
        const r = transport.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'GET', headers, timeout: 15000, agent: false
        }, (resp) => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              const models = (data.data || data.models || data || []).map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
              resolve(models);
            } catch (e) { reject(new Error('Failed to parse models response')); }
          });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
        r.end();
      });
      // Filter TTS/voice-related models (wider pattern for Volink gateway)
      const ttsPattern = /tts|speech|audio|voice|cosy|daily|innovation/i;
      const ttsFiltered = result.filter(m => ttsPattern.test(m));
      if (ttsFiltered.length > 0) {
        // 实时从 API 拉取；不本地硬编码模型清单
        res.json(ttsFiltered);
      } else {
        // 标准 /v1/models 未含 TTS 模型：回退到网关专用 /tts/models 端点（Volink 等）
        try {
          const ttsModels = await fetchTTSModelsEndpoint(baseUrl, api_key);
          if (ttsModels.length > 0) { res.json(ttsModels); return; }
        } catch (e) { /* 端点不存在则忽略，走下方空数组 */ }
        // 仍无 TTS 模型：返回空数组，前端提示用户手动输入模型名
        res.json([]);
      }
    } catch (e) {
      res.status(502).json({ error: 'Failed to fetch models' });
    }
  });

  // GET /api/tts/providers/:id/models — fetch models for a saved provider
  router.get('/providers/:id/models', async (req, res) => {
    const provider = db.prepare("SELECT * FROM tts_providers WHERE id = ?").get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Not found' });
    try {
      const apiKey = provider.api_key ? decrypt(provider.api_key) : '';
      const baseUrl = (provider.base_url || '').replace(/\/+$/, '');

      // 云百炼 (阿里云 DashScope) — 实时拉取模型清单（compatible-mode /v1/models）
      if (isBailianProvider(baseUrl, provider.api_format)) {
        try {
          const models = await fetchBailianModels(apiKey);
          res.json(models);
        } catch (e) {
          res.status(502).json({ error: 'Failed to fetch 百炼 models: ' + e.message });
        }
        return;
      }

      // Qwen3-TTS (local or cloud) — fetch from /qwenapi/v1/models
      const isQwenAPI = baseUrl.includes('127.0.0.1:7860') || baseUrl.includes('localhost:7860')
        || baseUrl.includes('/qwenapi') || baseUrl.includes('cnb');
      let modelUrl;
      if (isQwenAPI) {
        if (baseUrl.endsWith('/qwenapi/v1')) modelUrl = baseUrl + '/models';
        else if (baseUrl.endsWith('/qwenapi')) modelUrl = baseUrl + '/v1/models';
        else modelUrl = baseUrl + '/qwenapi/v1/models';
      } else if (baseUrl.endsWith('/audio/speech') || baseUrl.endsWith('/audio/synthesize') || baseUrl.endsWith('/tts/speech')) {
        modelUrl = baseUrl.replace(/\/audio\/(speech|synthesize)/, '/models').replace(/\/tts\/speech/, '/models');
      } else if (baseUrl.endsWith('/v1') || baseUrl.endsWith('/v2')) {
        modelUrl = baseUrl + '/models';
      } else {
        modelUrl = baseUrl + '/v1/models';
      }
      const url = new URL(modelUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const result = await new Promise((resolve, reject) => {
        const headers = { 'Connection': 'close' };
        if (isQwenAPI) {
          // QwenAPI (local Gradio / cloud cnb) does not require auth for /models
        } else if (apiKey) {
          // Gradio built-in auth uses HTTP Basic Auth (username:password)
          // If api_key contains colon, treat as user:pass; otherwise use default admin user
          if (apiKey.includes(':')) {
            headers['Authorization'] = 'Basic ' + Buffer.from(apiKey).toString('base64');
          } else {
            // Single string: assume password with default admin user
            headers['Authorization'] = 'Basic ' + Buffer.from('admin:' + apiKey).toString('base64');
          }
        }
        const r = transport.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'GET', headers, timeout: 15000, agent: false
        }, (resp) => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            // 404 means Qwen3-TTS WebUI is running but --api flag was not used
            if (isQwenAPI && resp.statusCode === 404) {
              reject(new Error('Qwen3-TTS WebUI 正在运行，但未启用 API。请使用 --api 参数重启 Qwen3-TTS。'));
              return;
            }
            if (resp.statusCode !== 200) {
              reject(new Error(`HTTP ${resp.statusCode}: ${body.substring(0, 200)}`));
              return;
            }
            try {
              const data = JSON.parse(body);
              const models = (data.data || data.models || data || []).map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
              resolve(models);
            } catch (e) { reject(new Error('Failed to parse models response: ' + body.substring(0, 200))); }
          });
        });
        r.on('error', (e) => {
          if (e.code === 'ECONNREFUSED' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
            reject(new Error(`无法连接到本机 Qwen3-TTS 服务 (${url.host})。请先启动 Qwen3-TTS WebUI (需加 --api 参数)。`));
          } else {
            reject(e);
          }
        });
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
        r.end();
      });
      if (isQwenAPI) {
        // Return Qwen3-TTS models as-is (already filtered)
        res.json(result);
      } else {
        const ttsFiltered = result.filter(m => /tts|speech|audio|voice|cosy|daily|innovation/i.test(m));
        if (ttsFiltered.length > 0) {
          res.json(ttsFiltered);
        } else {
          // 标准 /v1/models 未含 TTS 模型：回退到网关专用 /tts/models 端点（Volink 等）
          try {
            const ttsModels = await fetchTTSModelsEndpoint(baseUrl, apiKey);
            if (ttsModels.length > 0) { res.json(ttsModels); return; }
          } catch (e) { /* 端点不存在则忽略，走下方空数组 */ }
          res.json([]);
        }
      }
    } catch (e) {
      res.status(502).json({ error: 'Failed to fetch models' });
    }
  });

  // GET /api/tts/voices — return voice presets by provider domain (可选 model 参数做按模型分发)
  router.get('/voices', (req, res) => {
    const baseUrl = (req.query.base_url || '').toLowerCase();
    const model = (req.query.model || '').trim();
    const voices = getVoicePresets(baseUrl, model);
    res.json(voices);
  });

  // ============ TTS Settings ============

  function getSettings() {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TTS_SETTINGS_KEY);
    if (row) try { return JSON.parse(row.value); } catch { }
    return { auto_play: true, narrate_narration: false };
  }

  router.get('/settings', (req, res) => res.json(getSettings()));

  router.put('/settings', (req, res) => {
    const s = { ...getSettings(), ...req.body };
    const existing = db.prepare("SELECT key FROM app_settings WHERE key = ?").get(TTS_SETTINGS_KEY);
    const val = JSON.stringify(s);
    if (existing) db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(val, TTS_SETTINGS_KEY);
    else db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(TTS_SETTINGS_KEY, val);
    res.json({ success: true });
  });

  // ============ TTS Request Queue (bounded concurrency + disk overflow) ============
  // 一次性发送的 TTS 请求过多会导致生成服务端报错。改为：cache-miss 的请求入队，
  // 队列 worker 至多并发 TTS_MAX_CONCURRENCY 个合成（按 provider 再限 TTS_MAX_PER_PROVIDER），
  // 超出部分留在内存队列并持久化到磁盘文件；前一批在飞任务返回后自动拉取下一批。
  // 前端收到 queued 后只拿到目标缓存文件名，由播放器 _waitForCacheFile 轮询等待生成完成。
  // TTS_QUEUE_FILE 已在模块顶部由 server/paths.js 提供（随 DATA_ROOT 外置）
  const TTS_MAX_CONCURRENCY = 10;      // 全局同时在飞上限（用户要求：一次不超过 10 条）
  const TTS_MAX_PER_PROVIDER = 3;      // 单 provider 并发上限（避免对单一服务同时打满 10 个冷启动）
  let ttsQueue = [];                    // 待处理/处理中的任务描述符
  let ttsInFlight = 0;                  // 全局在飞计数
  const ttsProviderInFlight = {};        // providerId -> 在飞计数
  let ttsQueueLoaded = false;

  function persistTTSQueue() {
    try {
      const dir = path.dirname(TTS_QUEUE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TTS_QUEUE_FILE, JSON.stringify(ttsQueue));
    } catch (e) { console.error('[TTS Queue] persist failed:', e.message); }
  }

  function loadTTSQueue() {
    try {
      if (fs.existsSync(TTS_QUEUE_FILE)) {
        const arr = JSON.parse(fs.readFileSync(TTS_QUEUE_FILE, 'utf8'));
        if (Array.isArray(arr)) {
          ttsQueue = arr.filter(j => j && typeof j.cachePath === 'string');
          // 重启后：已完成（文件已存在）的丢弃；被打断的（processing）重置为 pending 重新生成
          ttsQueue = ttsQueue.filter(j => {
            if (j.cachePath && fs.existsSync(j.cachePath)) return false;
            j.status = 'pending';
            j.attempts = 0;
            return true;
          });
        }
      }
    } catch (e) { console.error('[TTS Queue] load failed:', e.message); ttsQueue = []; }
    ttsQueueLoaded = true;
    console.log(`[TTS Queue] loaded ${ttsQueue.length} pending job(s)`);
  }

  function resolveProviderById(id) {
    if (!id) return null;
    try { return db.prepare('SELECT * FROM tts_providers WHERE id = ?').get(id) || null; }
    catch { return null; }
  }

  function clampTTS(text, apiFormat) {
    const limit = (apiFormat === 'nvidia') ? 1900 : (apiFormat === 'volcengine' ? 990 : 990);
    const t = (text || '').trim();
    return t.length > limit ? t.substring(0, limit - 10) + '...' : t;
  }

  async function processTTSJob(job) {
    let provider = resolveProviderById(job.providerId) || resolveProvider();
    if (!provider) throw new Error('No TTS provider configured');
    if (job.body.voice) provider = { ...provider, voice: job.body.voice };
    const safeText = clampTTS(job.body.text, provider.api_format);
    const result = await callSpeechAPI(provider, safeText, job.body.instruction);
    if (!fs.existsSync(TTS_CACHE_DIR)) fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(job.cachePath, result.audio);
    console.log(`[TTS Queue] Generated: ${path.basename(job.cachePath)} (${result.audio.length} bytes)`);
  }

  // ComfyUI 是单张本地 GPU，其执行器本就串行跑 prompt。即便按 provider 各限 1，
  // 只要配置了多个 comfyui provider（如「旁白」与「默认」各一个），仍会多条并发打进
  // 同一 ComfyUI，框架把后续 prompt 排进队列；一旦其中一条是超长对白（生成 100+ 秒
  // 音频），队列会整体堵住，体感就是「卡顿」。故 comfyui 必须【全局单飞】：任意
  // comfyui provider 在跑时，其它 comfyui 任务一律排队，跨 provider 也不允许并发。
  // 云端 provider 仍保留 TTS_MAX_PER_PROVIDER 并发。
  let comfyuiInFlight = 0; // 全局 comfyui 在飞计数（跨所有 provider）
  function isComfyuiProvider(providerId) {
    const p = resolveProviderById(providerId);
    return !!(p && p.api_format === 'comfyui');
  }
  function effectivePerProviderCap(providerId) {
    const p = resolveProviderById(providerId);
    if (p && p.api_format === 'comfyui') return 1;
    return TTS_MAX_PER_PROVIDER;
  }

  function pumpTTSQueue() {
    while (ttsInFlight < TTS_MAX_CONCURRENCY) {
      const job = ttsQueue.find(j =>
        j.status === 'pending' &&
        (ttsProviderInFlight[j.providerId] || 0) < effectivePerProviderCap(j.providerId) &&
        (!isComfyuiProvider(j.providerId) || comfyuiInFlight === 0)
      );
      if (!job) break; // 无待处理，或都被上限/全局单飞挡住（完成时会再次 pump）
      job.status = 'processing';
      ttsInFlight++;
      ttsProviderInFlight[job.providerId] = (ttsProviderInFlight[job.providerId] || 0) + 1;
      if (isComfyuiProvider(job.providerId)) comfyuiInFlight++;
      persistTTSQueue();
      (async () => {
        try {
          await processTTSJob(job);
        } catch (e) {
          console.error('[TTS Queue] job failed:', e.message, '(file=', path.basename(job.cachePath), ')');
          // 失败：丢弃任务，文件缺失后前端播放器轮询超时自动跳过该段（不卡住整条播报）
        } finally {
          ttsInFlight = Math.max(0, ttsInFlight - 1);
          ttsProviderInFlight[job.providerId] = Math.max(0, (ttsProviderInFlight[job.providerId] || 0) - 1);
          if (isComfyuiProvider(job.providerId)) comfyuiInFlight = Math.max(0, comfyuiInFlight - 1);
          const i = ttsQueue.indexOf(job);
          if (i >= 0) { ttsQueue.splice(i, 1); persistTTSQueue(); }
          pumpTTSQueue(); // 一个任务结束后立即补位下一批
        }
      })();
    }
  }

  // ============ TTS Speak ============

  function resolveProvider() {
    return db.prepare("SELECT * FROM tts_providers WHERE is_default = 1").get()
      || db.prepare("SELECT * FROM tts_providers LIMIT 1").get();
  }

  // Per-provider concurrency limiter — serialize TTS calls per provider so the single
  // cloud model never receives parallel cold-start requests (which it cannot serve in
  // parallel and which cascade into timeouts / "operation was aborted due to timeout").
  const _ttsLocks = new Map();
  function withProviderLock(providerId, fn) {
    const key = providerId || 'default';
    const prev = _ttsLocks.get(key) || Promise.resolve();
    let release;
    const p = new Promise(r => release = r);
    const next = prev.then(() => fn()).finally(() => release());
    _ttsLocks.set(key, next.catch(() => { })); // keep chain alive even if fn rejects
    return next;
  }

  // Warm up the Qwen3-TTS model via Gradio SSE queue. Returns true only when the SSE
  // stream reports process_completed(success). Heart beats keep the CNB 60s gateway alive.
  async function warmupQwenModel(apiBase, model) {
    try {
      const sessionHash = 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      await fetch(apiBase + '/gradio_api/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [model, 'warmup', '', 'default', 'auto', false],
          fn_index: 8,
          session_hash: sessionHash
        })
      });
      return await new Promise((resolve) => {
        const sseTimeout = setTimeout(() => {
          console.log('[QwenAPI] SSE warmup timed out (5min)');
          resolve(false);
        }, 300000);
        fetch(apiBase + '/gradio_api/queue/data?session_hash=' + sessionHash)
          .then(r => {
            const reader = r.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            function read() {
              reader.read().then(({ done, value }) => {
                if (done) { clearTimeout(sseTimeout); resolve(true); return; }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  try {
                    const d = JSON.parse(line.substring(6));
                    if (d.msg === 'heartbeat') {
                      // keep gateway alive
                    } else if (d.msg === 'process_completed') {
                      clearTimeout(sseTimeout);
                      resolve(!!d.success);
                      return;
                    } else if (d.msg === 'unexpected_error') {
                      console.log('[QwenAPI] SSE warmup unexpected_error:', d.message);
                      clearTimeout(sseTimeout);
                      resolve(false);
                      return;
                    }
                  } catch { }
                }
                read();
              }).catch(() => { clearTimeout(sseTimeout); resolve(false); });
            }
            read();
          }).catch(() => { clearTimeout(sseTimeout); resolve(false); });
      });
    } catch (e) {
      console.log('[QwenAPI] warmup exception:', e.message);
      return false;
    }
  }

  /** QwenAPI TTS via REST /qwenapi/v1/custom-voice
   *  speaker: voice field (aiden/serena/default etc.)
   *  instruct: instruction field (style description, e.g. "温柔女声")
   *
   *  Strategy: SSE warmup + REST fetch
   *  CNB gateway has 60s socket timeout — REST API can 504 on cold start.
   *  Solution: try REST first (model may be warm); if 504/timeout,
   *  use Gradio SSE to warm up model (heart beats keep connection alive),
   *  then retry REST (model now in memory, responds in seconds).
   */
  async function callQwenAPITTS(provider, text, segmentInstruction) {
    const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
    // Build base URL — strip /qwenapi/v1 if already present
    let apiBase = baseUrl;
    if (apiBase.endsWith('/qwenapi/v1')) {
      apiBase = apiBase.slice(0, -'/qwenapi/v1'.length);
    } else if (apiBase.endsWith('/qwenapi')) {
      apiBase = apiBase.slice(0, -'/qwenapi'.length);
    }
    const apiUrl = apiBase + '/qwenapi/v1/custom-voice';

    const speaker = provider.voice || 'default';
    const segInstr = (segmentInstruction && segmentInstruction.trim()) ? buildEmotionInstruction(segmentInstruction) : '';
    const instruct = (segInstr || (provider.instruction || '').trim());
    // Safety: ensure model is a valid Qwen3-TTS model name (prevent "tts-1" etc. from causing download errors)
    let model = provider.model || '';
    if (!model.includes('Qwen3-TTS')) {
      model = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
    }

    const restBody = JSON.stringify({
      model_name: model, text, instruct, speaker, language: 'auto'
    });

    console.log('[QwenAPI] speaker:', speaker, 'instruct:', instruct.substring(0, 30), 'text:', text.substring(0, 40));

    // Step 1: Try REST directly (model may already be warm)
    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: restBody,
        signal: AbortSignal.timeout(55000) // 55s — leave margin before 60s CNB gateway timeout
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json.audio_files_base64?.length > 0) {
          const audioBuffer = Buffer.from(json.audio_files_base64[0], 'base64');
          if (audioBuffer.length >= 100) {
            console.log('[QwenAPI] REST direct: OK', audioBuffer.length, 'bytes');
            return { audio: audioBuffer, contentType: 'audio/wav' };
          }
        }
        console.log('[QwenAPI] REST direct: bad response, falling back to SSE warmup');
      } else {
        console.log('[QwenAPI] REST direct: HTTP', resp.status, '— model cold, warming up via SSE');
      }
    } catch (e) {
      console.log('[QwenAPI] REST direct:', e.message, '— model cold, warming up via SSE');
    }

    // Step 2: Warm up model via Gradio SSE (heart beats keep connection alive through 60s gateway).
    // warmupQwenModel returns true ONLY if SSE reported process_completed(success) — so we
    // know whether the model actually loaded, instead of blindly assuming it did.
    console.log('[QwenAPI] SSE warmup starting...');
    const warmupOk = await warmupQwenModel(apiBase, model);
    console.log('[QwenAPI] SSE warmup result:', warmupOk);

    // Step 3: Model should be warm now - retry REST with bounded retries.
    // A single REST call cannot beat the 60s CNB gateway limit on a TRULY cold model,
    // so each failed attempt re-warms first (the model may have re-cooled between calls or
    // the platform may throttle after consecutive generations). The SSE queue's generation
    // path cannot be used here: its Gradio function returns audio into a gr.State (not
    // serialized back over the queue API) and rejects named speakers, so REST is the only
    // viable channel for per-character voices.
    let lastErr = null;
    const MAX_REST_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_REST_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[QwenAPI] REST attempt ${attempt} failed (${lastErr ? lastErr.message : ''}); re-warming before retry...`);
        await warmupQwenModel(apiBase, model);
      }
      try {
        const resp2 = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: restBody,
          signal: AbortSignal.timeout(55000)
        });
        if (!resp2.ok) {
          const errText = await resp2.text();
          lastErr = new Error(`QwenAPI REST ${resp2.status} after warmup: ${errText.substring(0, 200)}`);
          continue;
        }
        const json2 = await resp2.json();
        if (!json2.audio_files_base64?.length) {
          lastErr = new Error('No audio in QwenAPI response after warmup');
          continue;
        }
        const audioBuffer2 = Buffer.from(json2.audio_files_base64[0], 'base64');
        if (audioBuffer2.length < 100) {
          lastErr = new Error('Audio too small after warmup: ' + audioBuffer2.length);
          continue;
        }
        console.log('[QwenAPI] REST after warmup: OK', audioBuffer2.length, 'bytes');
        return { audio: audioBuffer2, contentType: 'audio/wav' };
      } catch (e) {
        lastErr = e;
        console.log('[QwenAPI] REST attempt', attempt, 'error:', e.message);
      }
    }
    throw new Error('QwenAPI cloud TTS failed after warmup+retries ' +
      `(warmupOk=${warmupOk}, likely model cooldown/throttle on CNB gateway): ${lastErr ? lastErr.message : 'unknown'}`);
  }

  /** Local Qwen3-TTS (Gradio WebUI at 127.0.0.1:7861)
   *  Same REST API /qwenapi/v1/custom-voice as cloud version,
   *  but no cold-start / SSE warmup needed (model already loaded locally).
   *  No api_key required for local deployment.
   *
   *  speaker: voice field (aiden/serena/default etc.)
   *  instruct: instruction field (style description, e.g. "温柔女声")
   */
  async function callQwenLocalTTS(provider, text, segmentInstruction) {
    const baseUrl = (provider.base_url || 'http://127.0.0.1:7861').replace(/\/+$/, '');
    // Build base URL — strip /qwenapi/v1 if already present
    let apiBase = baseUrl;
    if (apiBase.endsWith('/qwenapi/v1')) {
      apiBase = apiBase.slice(0, -'/qwenapi/v1'.length);
    } else if (apiBase.endsWith('/qwenapi')) {
      apiBase = apiBase.slice(0, -'/qwenapi'.length);
    }
    const apiUrl = apiBase + '/qwenapi/v1/custom-voice';

    const speaker = provider.voice || 'default';
    const segInstr = (segmentInstruction && segmentInstruction.trim()) ? buildEmotionInstruction(segmentInstruction) : '';
    const instruct = (segInstr || (provider.instruction || '').trim());
    // Safety: ensure model is a valid Qwen3-TTS model name (prevent "tts-1" etc. from causing download errors)
    let model = provider.model || '';
    if (!model.includes('Qwen3-TTS')) {
      model = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
    }

    const restBody = JSON.stringify({
      model_name: model, text, instruct, speaker, language: 'auto'
    });

    console.log('[QwenLocal] speaker:', speaker, 'instruct:', instruct.substring(0, 30), 'text:', text.substring(0, 40));

    // Single REST call — local model is always warm
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: restBody,
      signal: AbortSignal.timeout(600000) // 10min — local large-model TTS can take minutes (cold start / long text); short timeout aborts before audio is returned
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`QwenLocal REST ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const json = await resp.json();
    if (!json.audio_files_base64?.length) {
      throw new Error('No audio in QwenLocal response');
    }

    const audioBuffer = Buffer.from(json.audio_files_base64[0], 'base64');
    if (audioBuffer.length < 100) {
      throw new Error('Audio too small: ' + audioBuffer.length);
    }

    console.log('[QwenLocal] REST: OK', audioBuffer.length, 'bytes');
    return { audio: audioBuffer, contentType: 'audio/wav' };
  }

  /**
   * Convert a bare emotion tag (e.g. "愤怒") into a natural-language TTS instruction.
   * If the tag already looks like a full instruction phrase, return as-is.
   * @param {string} tag - emotion tag from butler's （情绪） marker
   * @returns {string} instruction string for OpenAI/Qwen instruct params
   */
  function buildEmotionInstruction(tag) {
    if (!tag || !tag.trim()) return '';
    const t = tag.trim();
    // Already a full instruction phrase? (contains 用/地/语气, or has spaces)
    if (t.includes('用') || t.includes('地') || t.includes('语气') || t.includes(' ')) {
      return t.substring(0, 200);
    }
    return ('用' + t + '的语气').substring(0, 200);
  }

  function callSpeechAPI(provider, text, instruction) {
    const format = provider.api_format || 'openai';
    if (format === 'nvidia') return callNvidiaTTS(provider, text, instruction);
    if (format === 'volcengine') return callVolcengineTTS(provider, text, instruction);
    if (format === 'qwenapi') return callQwenAPITTS(provider, text, instruction);
    if (format === 'qwenapi_local') return callQwenLocalTTS(provider, text, instruction);
    if (format === 'bailian') return callBailianTTS(provider, text, instruction);
    if (format === 'comfyui') return callComfyUITTS(provider, text, instruction);
    return callOpenAITTS(provider, text, instruction);
  }

  /** 实时拉取百炼 (DashScope) TTS 模型清单。
   *  优先从 compatible-mode /v1/models 实时获取并过滤 TTS 模型；
   *  若兼容模式未暴露 TTS 模型（常态），回退到平台已知 TTS 模型清单。 */
  async function fetchBailianModels(apiKey) {
    const url = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
    const transport = https;
    const headers = { 'Connection': 'close', 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const result = await new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname, port: 443, path: url.pathname, method: 'GET',
        headers, timeout: 15000, agent: false
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const models = (data.data || []).map(m => m.id || m.name || '').filter(Boolean);
            resolve(models);
          } catch (e) { reject(new Error('Failed to parse 百炼 models response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    const ttsFiltered = result.filter(m => /qwen-audio|qwen3-tts|qwen-tts|cosyvoice|tts|audio|voice|speech/i.test(m));
    if (ttsFiltered.length > 0) return ttsFiltered;
    // 百炼 compatible-mode 通常不列出 TTS 模型，回退到平台已知 TTS 模型清单
    return BAILIAN_TTS_MODELS;
  }

  /** 阿里云百炼 (DashScope) 语音合成。
   *  Qwen-Audio-TTS / Qwen3-TTS 系列同时支持 HTTP 生成接口与 WebSocket；
   *  CosyVoice 系列仅支持 WebSocket（实时）。这里：实时模型走 WS，其余走 HTTP。
   *  HTTP 端点：POST /api/v1/services/aigc/multimodal-generation/generation
   *  Auth：Authorization: Bearer <api_key> */
  async function callBailianTTS(provider, text, instruction) {
    // 表单直传的明文 key 用 _rawKey 标记，避免对明文再做 AES 解密导致损坏
    const rawKey = provider.api_key
      ? (provider._rawKey ? provider.api_key : decrypt(provider.api_key))
      : '';
    // 净化 key：去除所有非 ASCII 可打印字符（复制粘贴混入的全角空格/智能引号/零宽字符/
    // 换行等），否则塞进 WebSocket 握手头会触发 "Cannot convert argument to a ByteString"。
    const apiKey = (rawKey || '').replace(/[^\x20-\x7E]/g, '').trim();
    const model = provider.model || 'qwen3-tts-flash';
    // 按模型取默认音色，并校验用户所选音色是否属于该模型（错配会 411），非法则回落默认值
    let voice = provider.voice || defaultBailianVoice(model);
    if (!isBailianVoiceValid(model, voice)) voice = defaultBailianVoice(model);

    // 仅 WebSocket 的实时模型（CosyVoice / *-realtime / qwen-audio-3.0-tts）走 WS 协议
    if (isBailianRealtimeModel(model)) {
      const lang = mapBailianLang(provider.language);
      const segInstr = (instruction && instruction.trim()) ? buildEmotionInstruction(instruction) : '';
      const globalInstr = (provider.instruction || '').trim();
      const finalInstr = segInstr || globalInstr;
      return callBailianWSTTS({ apiKey, model, voice, text, lang, instruction: finalInstr });
    }

    // HTTP 生成接口：归一化 base_url 到 /api/v1，再拼 generation 端点
    let base = (provider.base_url || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
    if (base.endsWith('/compatible-mode/v1')) base = base.replace('/compatible-mode/v1', '/api/v1');
    if (!base.endsWith('/v1')) base = base + '/v1';
    const endpoint = base + '/services/aigc/multimodal-generation/generation';

    const input = { text, voice };
    const lang = mapBailianLang(provider.language);
    if (lang) input.language_type = lang;

    const parameters = {};
    const segInstr = (instruction && instruction.trim()) ? buildEmotionInstruction(instruction) : '';
    const globalInstr = (provider.instruction || '').trim();
    const finalInstr = segInstr || globalInstr;
    if (finalInstr) {
      parameters.instructions = finalInstr.substring(0, 200);
      parameters.optimize_instructions = true;
    }

    console.log('[Bailian] model:', model, 'voice:', voice, 'lang:', lang, 'instr:', (finalInstr || '').slice(0, 30));

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input, parameters }),
      signal: AbortSignal.timeout(120000)
    });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json') || !ct.includes('audio')) {
      const json = await resp.json().catch(() => null);
      if (!json) throw new Error(`百炼 TTS 返回非 JSON 且非音频 (HTTP ${resp.status})`);
      // 错误响应形如 { code, message } 或 { output: { code, message } }
      const code = json.code || (json.output && json.output.code);
      if (code && code !== 200 && code !== 0) {
        throw new Error(`百炼 TTS 错误 ${code}: ${json.message || (json.output && json.output.message) || ''}`);
      }
      const audio = json.output && json.output.audio;
      if (!audio) throw new Error('百炼 TTS 未返回音频: ' + JSON.stringify(json).substring(0, 200));
      if (audio.data) {
        const buf = Buffer.from(audio.data, 'base64');
        if (buf.length < 100) throw new Error('百炼 TTS 音频过小');
        return { audio: buf, contentType: 'audio/wav' };
      }
      if (audio.url) {
        const dl = await fetch(audio.url, {
          headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(60000)
        });
        if (!dl.ok) throw new Error(`百炼 TTS 音频下载失败 HTTP ${dl.status}`);
        const buf = Buffer.from(await dl.arrayBuffer());
        const ext = (audio.url.split('?')[0].endsWith('.mp3')) ? 'audio/mpeg' : 'audio/wav';
        return { audio: buf, contentType: ext };
      }
      throw new Error('百炼 TTS 响应缺少 audio.data / audio.url');
    }
    // 直接返回二进制音频
    const buf = Buffer.from(await resp.arrayBuffer());
    return { audio: buf, contentType: ct.includes('mpeg') ? 'audio/mpeg' : 'audio/wav' };
  }

  /** 百炼实时 TTS（WebSocket 协议，用于 CosyVoice / *-realtime 模型）。
   *  协议：run-task → (task-started) → continue-task(text) → [首个二进制音频帧到达后] finish-task
   *        → (剩余音频帧) → task-finished。
   *  注意：finish-task 必须在音频管线启动(收到首帧)后再发；若与 continue-task 同 tick 发送，
   *  服务端会在吐出任何音频前就收到"结束输入"并直接 task-finished，现象为 0 二进制帧。 */
  function callBailianWSTTS({ apiKey, model, voice, text, lang, instruction }) {
    const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    const WS = (typeof WebSocket !== 'undefined') ? WebSocket : null;
    if (!WS) return Promise.reject(new Error('当前 Node 版本不支持 WebSocket（需 Node 21+）'));

    const taskId = crypto.randomUUID();
    // 严格对齐官方 run-task 规范（Qwen-Audio-TTS/CosyVoice WebSocket API）：
    // parameters 仅认 text_type/voice/format/sample_rate/volume/rate/pitch/enable_ssml/seed 等，
    // **没有** language_type / instruction（那两个是 HTTP 多模态端点的参数）。下发未知参数会让
    // 引擎静默不合成（现象：continue+finish 后 0 音频帧、无报错）。故 WS 路径一律不下发它们。
    const parameters = {
      text_type: 'PlainText',
      voice: voice || defaultBailianVoice(model),
      format: 'mp3',
      sample_rate: 22050
    };

    // 实时（duplex）合成协议：文本通过 continue-task 送达，run-task 的 input 固定为空对象 {}
    // （官方明确"input 固定为空对象，待合成文本通过 continue-task 发送"）。早先误写成
    // input:{text:''}，会让服务端把合成缓冲初始化为"已有空文本"，continue-task 的文本不再
    // 被注册，最终 finish-task 强制合成时也无内容 → 0 音频帧。这里改回 {}。
    const runTask = {
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
        model, parameters, input: {}
      }
    };
    // qwen-audio-3.0-tts 系列支持文本内嵌 [tag] 情绪控制（文档明确）。instruction 在 WS 协议里
    // 被丢弃，故把情绪「转译」为 [tag] 前缀写进朗读文本，让默认供应商的对白真正带情绪，
    // 且标签不被念出。旁白/cosyvoice 不命中（或模型不支持）→ 原样，行为不变。
    let speechText = text || '';
    if (isQwenAudioTTS(model)) {
      const tag = mapEmotionToTag(instruction);
      if (tag) speechText = tag + speechText;
      if (tag) console.log('[Bailian WS] prepend emotion tag', tag, '-> speechText:', speechText.slice(0, 50));
    }
    const continueTask = {
      header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: { text: speechText } }
    };
    const finishTask = {
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} }
    };

    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WS(WS_URL, {
          headers: {
            'Authorization': 'bearer ' + (apiKey || ''),
            'X-DashScope-DataInspection': 'enable'
          },
          handshakeTimeout: 15000
        });
      } catch (e) { return reject(new Error('百炼 WS 创建失败: ' + e.message)); }

      // 关键：Node(undici) 的 WebSocket 默认 binaryType='blob'，二进制音频帧会以 Blob 形式
      // 投递，而 toBuffer 无法处理 Blob（Buffer.from(blob) 抛错→返回空Buffer→被 length 检查丢弃），
      // 导致"明明收到了音频却统计为 0 帧"。这里强制改成 arraybuffer，让二进制帧以 ArrayBuffer 到达。
      try { ws.binaryType = 'arraybuffer'; } catch {}

      const audioChunks = [];
      let resolved = false;
      let finished = false;
      let finishSent = false;   // finish-task 是否已发
      let firstFrame = false;   // 是否已收到首个音频帧
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; try { ws.close(); } catch {} reject(new Error('百炼 WS 合成超时')); }
      }, 120000);
      // 无音频快速失败：TTS 应在数秒内产出首个音频帧；若 30s 仍 0 帧且未完成，判定无音频（避免长等 120s）
      const noAudioWatchdog = setTimeout(() => {
        if (!resolved && !finished && audioChunks.length === 0) {
          resolved = true; clearTimeout(timeout); try { ws.close(); } catch {}
          reject(new Error('百炼 WS 未收到音频数据'));
        }
      }, 30000);

      function toBuffer(d) {
        if (Buffer.isBuffer(d)) return d;
        if (d instanceof ArrayBuffer) return Buffer.from(d);
        if (Array.isArray(d)) return Buffer.concat(d.map(toBuffer));
        try { return Buffer.from(d); } catch { return Buffer.alloc(0); }
      }
      function done() {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        clearTimeout(noAudioWatchdog);
        try { ws.close(); } catch {}
        const buf = Buffer.concat(audioChunks);
        if (buf.length < 100) reject(new Error('百炼 WS 未收到音频数据'));
        else resolve({ audio: buf, contentType: 'audio/mpeg' }); // 实时 TTS 默认输出 mp3
      }
      // 收到首个音频帧 / 兜底超时后，才发 finish-task 通知"输入结束"；
      // 服务端随后 flush 剩余音频并回 task-finished。切忌与 continue-task 同 tick 发送。
      function sendFinish() {
        if (finishSent || resolved) return;
        finishSent = true;
        if (ws.readyState === 1) { console.log('[Bailian WS] -> finish-task'); ws.send(JSON.stringify(finishTask)); }
      }

      ws.onopen = () => {
        console.log('[Bailian WS] connected, run-task');
        ws.send(JSON.stringify(runTask));
      };
      ws.onmessage = async (event) => {
        if (typeof event.data !== 'string') {
          // 兜底：若 binaryType 未生效、仍以 Blob 到达，则转 ArrayBuffer 再入 Buffer
          let b;
          if (event.data && typeof event.data.arrayBuffer === 'function') {
            try { b = Buffer.from(await event.data.arrayBuffer()); } catch { b = Buffer.alloc(0); }
          } else {
            b = toBuffer(event.data);
          }
          if (b && b.length) {
            // 首帧到达即证明合成管线已启动，此刻再发 finish-task，避免 0 帧收尾
            if (!firstFrame) { firstFrame = true; console.log('[Bailian WS] first binary frame', b.length, '-> send finish'); sendFinish(); }
            else console.log('[Bailian WS] binary frame', b.length);
            audioChunks.push(b);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        const evt = msg.header && msg.header.event;
        // 部分模型把音频以 base64 嵌在 JSON 的 payload.output.audio 里（而非二进制帧），兜底处理
        const out = msg.payload && msg.payload.output;
        if (out && out.audio && typeof out.audio === 'string') {
          const b = Buffer.from(out.audio, 'base64');
          if (b.length) {
            audioChunks.push(b); console.log('[Bailian WS] base64 audio in JSON', b.length);
            if (!firstFrame) { firstFrame = true; sendFinish(); }
          }
        }
        if (evt === 'task-started') {
          console.log('[Bailian WS] task-started -> continue(text)');
          ws.send(JSON.stringify(continueTask));
          // 兜底：若 3s 内未收到任何音频帧（首帧触发 sendFinish），仍主动发 finish，
          // 让服务端 flush 并回 task-finished，避免卡死；真正的"无音频"由 30s watchdog 判定。
          setTimeout(() => { if (!firstFrame) sendFinish(); }, 3000);
        } else if (evt === 'task-finished') {
          console.log('[Bailian WS] task-finished (binary chunks so far:', audioChunks.length, ')');
          finished = true;
          // 等一小段宽限，捕获可能紧随其后的尾部二进制帧 / 关闭事件，再判定结果
          setTimeout(() => { if (!resolved) done(); }, 800);
        } else if (evt === 'task-failed') {
          const err = (msg.header && msg.header.error_message)
            || (msg.payload && msg.payload.message) || 'unknown';
          console.log('[Bailian WS] task-failed:', err);
          if (!resolved) { resolved = true; clearTimeout(timeout); clearTimeout(noAudioWatchdog); try { ws.close(); } catch {} reject(new Error('百炼 WS 合成失败: ' + err)); }
        }
        // result-generated 仅作句边界标记，音频通过二进制帧 / JSON base64 返回
      };
      ws.onerror = (err) => {
        console.log('[Bailian WS] error:', err && err.message);
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error('百炼 WS 错误: ' + (err && err.message || 'unknown'))); }
      };
      ws.onclose = () => {
        if (!resolved && finished) done();
        else if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error('百炼 WS 连接关闭（未收到完成事件）')); }
      };
    });
  }


  /** 把「类型标签 + 情绪」拼成 Qwen3-TTS VoiceDesign 的自然语言 voice_description。
   *  voice   = 用户在角色音声映射中选的 12 类标签之一（如「甜美少女」）；旁白/缺失时回落默认。
   *  emotion = AI 根据剧情当场给出的情绪短语（如「害羞地」「用愤怒的语气」），可为空。 */
  function buildComfyVoiceDesc(voice, emotion) {
    const base = COMFY_VOICE_DESC[voice] || (voice ? `一个${voice}的声音` : COMFY_NARRATOR_DESC);
    const mood = (emotion || '').trim();
    return mood ? `${base}，${mood}` : base;
  }

  // 由声音类型标签派生【稳定】seed —— Qwen3-TTS VoiceDesign 的 seed 决定音色 timbre，
  // 必须按角色类型固定，否则每句话随机 seed → 同一角色每句声音都不同（听感"不稳定"）。
  // 情绪变化交给 voice_description，不靠 seed。seed 必须为非负整数（ComfyUI 要求 >= -1）。
  function comfyStableSeed(voice) {
    const s = String(voice || COMFY_NARRATOR_DESC);
    let h = 2166136261 >>> 0; // FNV-1a 32-bit（无符号）
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // h 为无符号 32 位（0..4.29e9），取模后 +1 → 稳定、非负、非零的正整数 seed
    return (h % 1000000000) + 1;
  }

  /** 本机 ComfyUI Qwen3-TTS 工作流合成。
   *  provider.base_url = ComfyUI 根地址（如 http://127.0.0.1:8188）
   *  provider.voice     = 本段角色对应的 12 类标签（由 /speak 的 voice 参数覆盖）
   *  instruction        = 情绪短语 */
  async function callComfyUITTS(provider, text, instruction) {
    const baseUrl = (provider.base_url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    let template;
    try {
      template = JSON.parse(fs.readFileSync(COMFY_TTS_WORKFLOW_PATH, 'utf-8'));
    } catch (e) {
      throw new Error('无法读取 ComfyUI TTS 工作流文件 qwen3-tts-01.json: ' + e.message);
    }
    const workflow = JSON.parse(JSON.stringify(template)); // 每次请求深拷贝，避免污染模板
    const node6 = workflow['6'];
    if (!node6 || !node6.inputs) throw new Error('工作流缺少节点 6 (FL_Qwen3TTS_VoiceDesign)');
    node6.inputs.text = text;
    node6.inputs.voice_description = buildComfyVoiceDesc(provider.voice, instruction);
    node6.inputs.seed = comfyStableSeed(provider.voice);
    // ⚠️ 关键：强制确定性解码，锁定音色。工作流模板默认 temperature=0.9 + top_k=50 是
    // 【随机采样】，会导致同一 voice_description 每次合成的声学特征都不同 —— 听感即
    // 「随机声音」（旁白文本长、被 ttsSplitText 切成多段各合成一次，随机次数最多，
    // 故旁白前后不一致最明显）。seed 虽已按角色标签固定，但随机采样会覆盖 seed 的确定性。
    // 修复：temperature 取最小允许值 0.1（节点不允许为 0）+ 固定 seed，使同一
    // (voice标签+文本+情绪) 永远产出完全一致的声音；情绪变化由 voice_description 承载
    // （已含情绪短语），不受 temperature 影响。top_k 保留 50（而非贪心 1）以避免低温度下
    // 的重复/机械伪影；在 temp=0.1 下随机性已可忽略，仍保证音色稳定。
    node6.inputs.temperature = 0.1;
    node6.inputs.top_p = 1;
    node6.inputs.top_k = 50;
    // 关键修复：此前 repetition_penalty 被强制设为 1.0（等于【禁用】重复惩罚），
    // 配合低温度 0.1，自回归解码器在部分句子上会陷入自我重复、始终不输出
    // codec_eos_token_id(4198)，一路跑到 max_new_tokens=2048 上限 —— 日志表现为
    // 反复出现 3926355 samples(≈163s 音频) / 277~312s 生成。恢复到一个能抑制退化
    // 循环的值(1.15)，让模型在句末正常吐出 EOS，生成回到 13s 量级。音色由
    // voice_description + seed 决定，repetition_penalty 仅重加权 token 概率、不影响音色。
    if (node6.inputs.repetition_penalty !== undefined) node6.inputs.repetition_penalty = 1.15;
    // 安全上限：即便个别输入仍触发循环，也把最坏生成时长限制在 ~128s，不再飙到 300s。
    node6.inputs.max_new_tokens = 1536;
    const lang = (provider.language || 'zh-CN').toLowerCase();
    node6.inputs.language = lang.startsWith('zh') ? 'Chinese'
      : lang.startsWith('en') ? 'English'
      : lang.startsWith('ja') ? 'Japanese' : 'Auto';

    const promptId = await comfyHttpPost(baseUrl, '/prompt', { prompt: workflow });
    // 超时放宽到 600×2s≈20 分钟：Qwen3-TTS 是自回归生成，长对白（如一段 160+ 秒的
    // 独白）真实耗时可达 250s+，旧值 120×2s≈240s 会在长生成尚未结束时误判超时、提前
    // 丢弃任务并释放单飞锁，导致下一条 prompt 叠车进 ComfyUI 造成卡顿。放宽后长生成能
    // 正常完成，且锁会持有到真正结束，不再提前释放引发并发。
    const out = await comfyWaitForOutput(baseUrl, promptId, 600);
    if (!out) throw new Error('ComfyUI TTS 生成超时（20分钟）或未返回音频');

    // 下载到临时文件并读入 Buffer；/speak 路由会把它按 cache_game/turn/seg 写盘缓存
    if (!fs.existsSync(TTS_CACHE_DIR)) fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    const tmpPath = path.join(TTS_CACHE_DIR, `.tmp_comfy_${crypto.randomUUID()}.mp3`);
    try {
      await comfyDownloadAudio(baseUrl, out, tmpPath);
      const buf = fs.readFileSync(tmpPath);
      return { audio: buf, contentType: 'audio/mpeg' };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { }
    }
  }

  /** Volcengine/Doubao TTS: POST /api/v1/tts (nested JSON, base64 audio response)
   *  api_key field stores "appid:token" (colon-separated)
   *  voice field stores voice_type (e.g. zh_female_qingxin)
   *  base_url defaults to https://openspeech.bytedance.com/api/v1/tts
   */
  /** Volcengine Ark Agent Plan TTS: POST /api/v3/plan/tts/unidirectional
   *  Auth: X-Api-Key (single API key, no appid needed)
   *  Response: HTTP chunked (NDJSON or binary, collect all chunks)
   *  model field = X-Api-Resource-Id (seed-tts-2.0)
   *  voice field = speaker (e.g. zh_female_gaolengyujie_uranus_bigtts)
   */
  function callVolcengineTTS(provider, text, instruction) {
    return new Promise((resolve, reject) => {
      const apiKey = provider.api_key ? decrypt(provider.api_key) : '';
      const resourceId = provider.model || 'seed-tts-2.0';
      const baseUrl = (provider.base_url || 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional').replace(/\/+$/, '');

      const reqBody = {
        req_params: {
          text,
          speaker: provider.voice || 'zh_female_gaolengyujie_uranus_bigtts',
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            speed_ratio: parseFloat(provider.speed) || 1.0
          }
        }
      };
      const body = JSON.stringify(reqBody);
      const url = new URL(baseUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'Connection': 'keep-alive',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Connect-Id': crypto.randomUUID(),
        'X-Control-Require-Usage-Return': '*'
      };

      const req = transport.request({
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 60000, agent: false
      }, (res) => {
        const chunks = [];
        let lineBuffer = '';
        const audioChunks = [];

        res.on('data', (chunk) => {
          // Try NDJSON first (line-by-line JSON with base64 audio)
          const str = chunk.toString();
          if (str.includes('"code"') || str.includes('"data"')) {
            // NDJSON mode
            lineBuffer += str;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.code === 0 && obj.data) {
                  audioChunks.push(Buffer.from(obj.data, 'base64'));
                } else if (obj.code === 20000000) {
                  // End marker
                } else if (obj.code && obj.code !== 0) {
                  reject(new Error(`Volcengine TTS error code ${obj.code}: ${obj.message || ''}`));
                  return;
                }
              } catch { }
            }
          } else {
            // Binary mode — collect raw audio chunks
            chunks.push(chunk);
          }
        });

        res.on('end', () => {
          // Process remaining NDJSON line
          if (lineBuffer.trim() && lineBuffer.includes('"code"')) {
            try {
              const obj = JSON.parse(lineBuffer);
              if (obj.code === 0 && obj.data) {
                audioChunks.push(Buffer.from(obj.data, 'base64'));
              }
            } catch { }
          }
          if (res.statusCode !== 200) {
            const errBody = chunks.length > 0 ? Buffer.concat(chunks).toString() : lineBuffer;
            return reject(new Error(`Volcengine TTS ${res.statusCode}: ${errBody.substring(0, 200)}`));
          }
          // Prefer NDJSON audio, fallback to binary
          if (audioChunks.length > 0) {
            resolve({ audio: Buffer.concat(audioChunks), contentType: 'audio/mpeg' });
          } else if (chunks.length > 0) {
            resolve({ audio: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'audio/mpeg' });
          } else {
            reject(new Error('Volcengine TTS: no audio data received'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TTS API timeout')); });
      req.write(body);
      req.end();
    });
  }

  /** OpenAI-compatible: POST /v1/audio/speech (JSON body) */
  function callOpenAITTS(provider, text, segmentInstruction) {
    return new Promise((resolve, reject) => {
      const apiKey = provider.api_key ? decrypt(provider.api_key) : '';
      const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
      let fullPath;
      if (baseUrl.endsWith('/audio/speech') || baseUrl.endsWith('/tts/speech')) fullPath = baseUrl;
      else if (baseUrl.endsWith('/v1') || baseUrl.endsWith('/v2')) fullPath = baseUrl + '/audio/speech';
      else fullPath = baseUrl + '/v1/audio/speech';
      const url = new URL(fullPath);
      const transport = url.protocol === 'https:' ? https : http;

      const reqBody = {
        model: provider.model || 'tts-1',
        voice: provider.voice || 'alloy',
        input: text,
        speed: parseFloat(provider.speed) || 1.0,
        response_format: 'mp3'
      }
      // Volink 的 CosyVoice 后端只接受 speed ∈ [0.6, 1.2]，超出（如滑块拖到 0.5 或 ≥1.3）
      // 会被后端 422 拒绝、整段合成失败。这里把 speed 收敛到安全区间，避免硬失败。
      const isVolink = baseUrl.includes('volink');
      if (isVolink) {
        const s = parseFloat(provider.speed);
        if (!isNaN(s)) reqBody.speed = Math.min(1.2, Math.max(0.6, s));
      }
      // Instruction: per-segment emotion (from butler) overrides global provider.instruction
      const globalInstr = (provider.instruction || '').trim();
      const segInstr = (segmentInstruction && segmentInstruction.trim()) ? buildEmotionInstruction(segmentInstruction) : '';
      const finalInstr = segInstr || globalInstr;
      if (finalInstr) {
        const instr = finalInstr.substring(0, 200);
        // StepAudio uses "instruction" (singular), OpenAI/Volink use "instructions" (plural)
        const isStepFun = baseUrl.includes('stepfun');
        if (isStepFun) {
          reqBody.instruction = instr;
        } else {
          reqBody.instructions = instr;
        }
      }

      const isGradio = baseUrl.includes('gradio') || baseUrl.includes(':7860') || baseUrl.includes(':7861');
      // 内联请求辅助：发一次合成请求，成功 resolve 音频，失败 reject（带状态码）
      const doRequest = (bodyStr) => new Promise((res, rej) => {
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'Connection': 'close' };
        if (apiKey) {
          if (isGradio) {
            headers['Authorization'] = apiKey.includes(':')
              ? 'Basic ' + Buffer.from(apiKey).toString('base64')
              : 'Basic ' + Buffer.from('admin:' + apiKey).toString('base64');
          } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
        }
        const req = transport.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'POST', headers, timeout: 60000, agent: false
        }, (r) => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (r.statusCode === 200) res({ audio: buf, contentType: r.headers['content-type'] || 'audio/mpeg' });
            else rej(Object.assign(new Error(`TTS API ${r.statusCode}: ${buf.toString().substring(0, 200)}`), { status: r.statusCode }));
          });
        });
        req.on('error', rej);
        req.on('timeout', () => { req.destroy(); rej(new Error('TTS API timeout')); });
        req.write(bodyStr);
        req.end();
      });

      const body = JSON.stringify(reqBody);
      // 兜底：Volink 若仍因 speed 相关原因 422，去掉 speed 重试一次（回落 1.0），保证不整段失败
      doRequest(body).catch((e) => {
        if (isVolink && e.status === 422 && reqBody.speed !== 1.0) {
          reqBody.speed = 1.0;
          return doRequest(JSON.stringify(reqBody));
        }
        throw e;
      }).then(resolve, reject);
    });
  }

  /** NVIDIA NIM: POST /v1/audio/synthesize (multipart/form-data) */
  function callNvidiaTTS(provider, text, instruction) {
    return new Promise((resolve, reject) => {
      const apiKey = provider.api_key ? decrypt(provider.api_key) : '';
      const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
      let fullPath;
      if (baseUrl.endsWith('/audio/synthesize')) fullPath = baseUrl;
      else if (baseUrl.endsWith('/v1')) fullPath = baseUrl + '/audio/synthesize';
      else fullPath = baseUrl + '/v1/audio/synthesize';
      const url = new URL(fullPath);
      const transport = url.protocol === 'https:' ? https : http;

      // Build multipart/form-data
      const boundary = '----TTS' + Math.random().toString(16).slice(2);
      const parts = [];
      const addField = (name, value) => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      addField('text', text);
      addField('language', provider.language || 'zh-CN');
      if (provider.voice) addField('voice', provider.voice);
      addField('sample_rate_hz', '22050');
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const headers = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Connection': 'close',
        'Accept': 'audio/wav'
      };
      if (apiKey) {
        // NVIDIA cloud uses Authorization: Bearer, local NIM doesn't need it
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const req = transport.request({
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST', headers, timeout: 60000, agent: false
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve({ audio: buf, contentType: res.headers['content-type'] || 'audio/wav' });
          else reject(new Error(`TTS API ${res.statusCode}: ${buf.toString().substring(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TTS API timeout')); });
      req.write(body);
      req.end();
    });
  }

  // POST /api/tts/speak  body: { text }
  //  Cache hit  -> 直接返回音频（快速路径，不变）
  //  Cache miss -> 入队，立即返回 202 { queued:true, cacheFile, position, pending }
  //                队列 worker 在并发上限内合成并写入缓存文件，前端用 /cache-file 轮询等待
  router.post('/speak', async (req, res) => {
    const { text, voice, instruction, cache_game, cache_turn, cache_seg, narrator } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    // 纯标点/符号段落（如分隔线 ---、……）不发请求：无可朗读文字，合成无意义且浪费配额
    const strippedText = text.replace(/\s+/g, '');
    if (strippedText && !/[\p{L}\p{N}]/u.test(strippedText)) {
      return res.status(400).json({ error: 'text contains no readable characters', skipped: true });
    }
    let provider = resolveProvider();
    if (!provider) return res.status(503).json({ error: 'No TTS provider configured. Add one in TTS settings.' });
    // 解析最终生效声线：请求显式 voice > 旁白标记(从 voice_map.narrator 解析) > provider 默认声线。
    // ⚠️ 关键修复：provider 默认声线(本机C="空灵仙气"女声)与 voice_map.narrator("活力阳光"男声)不一致；
    // 若旁白请求漏带 voice，旧逻辑回落到女声默认，导致旁白「女声变男声」随机翻转。
    // 现加 narrator 标记保险：前端旁白段必带 narrator:true，即使 voice 缺失也用 narrator 标签，
    // 绝不回落到 provider 默认声线，保证旁白性别/音色全程一致。
    let effectiveVoice = voice || null;
    if (!effectiveVoice && narrator) {
      try {
        const vm = typeof provider.voice_map === 'string'
          ? JSON.parse(provider.voice_map || '{}') : (provider.voice_map || {});
        effectiveVoice = (vm && vm.narrator) ? vm.narrator : null;
      } catch (e) { /* ignore parse error, fall through */ }
    }
    // Override voice if provided (multi-character TTS)
    if (effectiveVoice) provider = { ...provider, voice: effectiveVoice };
    console.log('[TTS][speak] voice_in=' + JSON.stringify(voice)
      + ' narrator_flag=' + !!narrator
      + ' effective_voice=' + JSON.stringify(effectiveVoice)
      + ' desc=' + buildComfyVoiceDesc(effectiveVoice || provider.voice, instruction).slice(0, 30)
      + ' text=' + (text || '').trim().slice(0, 30));
    // Limit: OpenAI/StepAudio=1000, NVIDIA NIM=2000. Frontend splits, this is safety net.
    const limit = (provider.api_format === 'nvidia') ? 1900 : (provider.api_format === 'volcengine' ? 990 : 990);
    const safeText = text.trim().length > limit ? text.trim().substring(0, limit - 10) + '...' : text.trim();

    // Disk cache: key includes voice + emotion to avoid mixing different characters/emotions
    let cachePath = null;
    if (cache_game && cache_turn !== undefined && cache_seg !== undefined) {
      const game = asciiSafeName(cache_game, 40);
      const turn = asciiSafeName(cache_turn, 20);
      const segKey = asciiSafeName(String(cache_seg), 20);
      const voiceKey = asciiSafeName(effectiveVoice || provider.voice || 'default', 20);
      const moodKey = asciiSafeName(instruction || '', 20);
      // ⚠️ 关键修复：缓存键必须包含 speed。Volink/CosyVoice 等模型的语速由 provider.speed 控制，
      // 若漏掉 speed，旧速度生成的音频会被新速度请求命中（路径相同），导致「调语速无效 / 总是过快」。
      const speedKey = asciiSafeName(String(provider.speed != null ? provider.speed : 1.0), 12);
      const ext = (provider.api_format === 'nvidia' || provider.api_format === 'qwenapi_local') ? 'wav' : 'mp3';
      cachePath = path.resolve(TTS_CACHE_DIR, `${game}_${turn}_${segKey}_${voiceKey}_${speedKey}_${moodKey}.${ext}`);
      // Block path traversal — cache file must remain inside TTS_CACHE_DIR
      if (!isPathWithin(TTS_CACHE_DIR, cachePath)) {
        return res.status(400).json({ error: 'Invalid cache path' });
      }
      // Cache hit — return cached file directly
      if (fs.existsSync(cachePath)) {
        const cached = fs.readFileSync(cachePath);
        const ct = (ext === 'wav') ? 'audio/wav' : 'audio/mpeg';
        res.set('Content-Type', ct);
        res.set('X-TTS-Cache', 'hit');
        res.set('X-TTS-Cache-File', path.basename(cachePath));
        return res.send(cached);
      }
    }

    // 无缓存键（直接手写调用 / 测试）-> 同步生成并返回音频，不走队列
    if (!cachePath) {
      try {
        const result = await callSpeechAPI(provider, safeText, instruction);
        res.set('Content-Type', result.contentType);
        res.set('X-TTS-Cache', 'miss');
        res.send(result.audio);
      } catch (e) {
        console.error('[TTS] Speak error:', e.message);
        res.status(502).json({ error: 'TTS synthesis failed' });
      }
      return;
    }

    // Cache miss -> 入队（并发上限内由 worker 合成；超出部分持久化在磁盘队列文件，等待下一批）
    const descriptor = {
      id: crypto.randomUUID(),
      cachePath,
      providerId: provider.id,
      body: {
        text: safeText,
        voice: effectiveVoice || null,
        instruction: instruction || null,
        cache_game, cache_turn, cache_seg
      },
      status: 'pending',
      enqueuedAt: Date.now(),
      attempts: 0
    };
    // 去重：若已有 pending/processing 任务指向同一缓存文件，复用之，避免重复合成
    const existing = ttsQueue.find(j => j.cachePath === cachePath);
    if (!existing) {
      ttsQueue.push(descriptor);
      persistTTSQueue();
    }
    const target = existing || descriptor;
    const position = ttsQueue.indexOf(target) + 1;
    const pendingAhead = ttsQueue.filter(j => j.status === 'pending').length;
    res.set('X-TTS-Cache-File', path.basename(cachePath));
    res.set('X-TTS-Queued', '1');
    res.status(202).json({
      queued: true,
      cacheFile: path.basename(cachePath),
      position,
      pending: pendingAhead
    });
    // 立即拉起队列 worker（不 await，请求快速返回）
    pumpTTSQueue();
  });

  // GET /api/tts/queue/status — 前端悬浮「排队中」提示轮询用
  router.get('/queue/status', (req, res) => {
    res.json({
      inFlight: ttsInFlight,
      pending: ttsQueue.filter(j => j.status === 'pending').length,
      processing: ttsQueue.filter(j => j.status === 'processing').length,
      total: ttsQueue.length
    });
  });

  // GET /api/tts/cache — list cached files
  router.get('/cache', (req, res) => {
    try {
      if (!fs.existsSync(TTS_CACHE_DIR)) return res.json({ files: [], totalSize: 0 });
      const files = fs.readdirSync(TTS_CACHE_DIR).filter(f => /\.(mp3|wav)$/.test(f)).map(f => {
        const stat = fs.statSync(path.join(TTS_CACHE_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      });
      const totalSize = files.reduce((s, f) => s + f.size, 0);
      res.json({ files: files.sort((a, b) => b.mtime - a.mtime), totalSize, count: files.length });
    } catch (e) { res.status(500).json({ error: 'Failed to list cache' }); }
  });

  // GET /api/tts/cache-file/:filename — serve a cached audio file for playback.
  // The frontend plays these HTTP URLs directly (never the raw TTS stream), and polls
  // 404 -> 200 to wait for a segment that is still being generated.
  //
  // CRITICAL: these files are immutable once written, so we serve them with
  // `Cache-Control: immutable` and NEVER honor conditional requests (no 304). A 304
  // in response to a browser's mid-playback Range re-request makes the <audio> element
  // throw MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) — the "some play, some don't" bug.
  router.get('/cache-file/:filename', (req, res) => {
    const fn = req.params.filename;
    if (!fn || /[\\/]|\.\./.test(fn)) return res.status(400).json({ error: 'invalid filename' });
    const full = path.join(TTS_CACHE_DIR, fn);
    if (!full.startsWith(TTS_CACHE_DIR)) return res.status(400).json({ error: 'invalid path' });
    if (!fs.existsSync(full)) return res.status(404).send('not ready');
    const ext = path.extname(fn).toLowerCase();
    const ct = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
    const stat = fs.statSync(full);
    const total = stat.size;
    res.set('Content-Type', ct);
    res.set('Accept-Ranges', 'bytes');
    // Immutable + long max-age: browser caches the file and never revalidates mid-playback,
    // so it never sends If-None-Match and we never return a 304.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // HEAD is used by the player's 404->200 wait loop; respond with headers, no body.
    if (req.method === 'HEAD') { res.status(200).end(); return; }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end) { start = 0; end = total - 1; }
      const chunk = end - start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', chunk);
      const stream = fs.createReadStream(full, { start, end });
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.pipe(res);
    } else {
      res.set('Content-Length', total);
      const stream = fs.createReadStream(full);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.pipe(res);
    }
  });

  // DELETE /api/tts/cache — clear all cached files
  router.delete('/cache', (req, res) => {
    try {
      if (fs.existsSync(TTS_CACHE_DIR)) {
        const files = fs.readdirSync(TTS_CACHE_DIR).filter(f => /\.(mp3|wav)$/.test(f));
        files.forEach(f => fs.unlinkSync(path.join(TTS_CACHE_DIR, f)));
        res.json({ cleared: files.length });
      } else { res.json({ cleared: 0 }); }
    } catch (e) { res.status(500).json({ error: 'Failed to clear cache' }); }
  });

  // POST /api/tts/test
  router.post('/test', async (req, res) => {
    const body = req.body || {};
    // 优先用前端传来的「当前表单供应商」配置（便于未保存/未设默认时直接测试），
    // 仅当未提供 api_format+base_url 时才回落到 DB 默认供应商。
    let fromForm = !!(body && body.api_format && body.base_url);
    let provider = fromForm ? body : resolveProvider();
    if (!provider) return res.status(503).json({ error: 'No TTS provider' });
    // 表单没填 key、但带供应商 id → 回落到数据库已保存（加密）的 key，避免编辑已保存
    // 供应商时因表单 key 输入框为空而报「No API-key provided」。
    if (fromForm && !body.api_key && body.id) {
      const saved = resolveProviderById(body.id);
      if (saved && saved.api_key) { provider = { ...provider, api_key: saved.api_key }; fromForm = false; }
    }
    try {
      // Allow caller to override voice/text for voice-map preview testing
      const prov = { ...provider };
      prov._rawKey = fromForm; // 表单直传的是明文 key，勿再 decrypt
      if (body.voice) prov.voice = String(body.voice);
      if (body.instruction) prov.instruction = String(body.instruction);
      const text = body.text ? String(body.text).slice(0, 200) : '你好，这是语音合成测试。今天天气真不错。';
      const result = await callSpeechAPI(prov, text, prov.instruction);
      res.set('Content-Type', result.contentType);
      res.send(result.audio);
    } catch (e) {
      console.error('[TTS Test] failed:', e && e.message, e && e.stack);
      res.status(502).json({ error: 'TTS test failed', detail: (e && e.message) || String(e) });
    }
  });

  // ============ TTS Cloud Keep-Alive Heartbeat ============
  // Sends a lightweight probe to the cloud Qwen3-TTS instance at a fixed interval so the
  // CNB/CloudStudio platform does not idle-sleep the GPU instance (which would force a slow
  // cold-start on the next real TTS request). ONLY active when the currently-selected default
  // TTS provider is the "云平台" type (api_format === 'qwenapi'). Commercial APIs (openai /
  // nvidia / volcengine ...) and local Qwen (qwenapi_local) are skipped entirely — no pointless
  // traffic and no local load.
  const HEARTBEAT_DEFAULT_INTERVAL_MS = 180000; // 3 min

  function isCloudTTSProvider(p) {
    return !!p && p.api_format === 'qwenapi';
  }

  // Strip trailing /qwenapi(/v1) to get the Gradio root base URL (same rule as callQwenAPITTS).
  function toQwenApiBase(baseUrl) {
    let u = (baseUrl || '').replace(/\/+$/, '');
    if (u.endsWith('/qwenapi/v1')) u = u.slice(0, -'/qwenapi/v1'.length);
    else if (u.endsWith('/qwenapi')) u = u.slice(0, -'/qwenapi'.length);
    return u;
  }

  // Lightweight liveness probe: GET /qwenapi/v1/models. Cheap, does not trigger model load.
  function probeCloudAlive(baseUrl, timeoutMs) {
    return new Promise((resolve) => {
      let url;
      try {
        const u = toQwenApiBase(baseUrl);
        url = u + '/qwenapi/v1/models';
        // eslint-disable-next-line no-new
        new URL(url);
      } catch { return resolve(false); }
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: 'GET',
        headers: { 'Connection': 'close', 'Accept': 'application/json' },
        timeout: timeoutMs || 8000
      }, (res) => {
        res.resume(); // drain response body
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  async function ttsHeartbeatTick() {
    try {
      const settings = getSettings();
      // Master switch — user can disable keep-alive entirely from TTS settings.
      if (settings.heartbeat_enabled === false) return;
      const provider = resolveProvider();
      // ONLY the cloud platform provider triggers keep-alive. Others are skipped.
      if (!isCloudTTSProvider(provider)) return;
      const base = toQwenApiBase(provider.base_url);
      const ok = await probeCloudAlive(provider.base_url);
      if (ok) {
        console.log('[TTS Heartbeat] cloud="' + provider.name + '" alive=ok');
      } else {
        // Instance asleep or cold — warm it up (this also keeps it alive).
        console.log('[TTS Heartbeat] cloud="' + provider.name + '" probe=fail, warming up...');
        await warmupQwenModel(base, provider.model);
      }
    } catch (e) {
      console.log('[TTS Heartbeat] tick error:', e.message);
    }
  }

  function startTTSHeartbeat() {
    if (_ttsHeartbeatTimer) return; // guard against double-start on hot reload
    const interval = (getSettings().heartbeat_interval_ms) || HEARTBEAT_DEFAULT_INTERVAL_MS;
    _ttsHeartbeatTimer = setInterval(ttsHeartbeatTick, interval);
    // Fire once shortly after boot to re-warm a cold instance early.
    setTimeout(ttsHeartbeatTick, 5000);
    console.log('[TTS Heartbeat] started, interval=' + interval + 'ms (cloud-only, respects settings.heartbeat_enabled)');
  }

  startTTSHeartbeat();

  // 启动时恢复磁盘队列（重启后继续把未完成的 TTS 请求合成出来）
  loadTTSQueue();
  pumpTTSQueue();

  return router;
}

/** Voice presets by provider domain */
function getVoicePresets(baseUrl, model) {
  const url = (baseUrl || '').toLowerCase();
  // StepFun
  if (url.includes('stepfun')) {
    return [
      { id: 'cixingnansheng', name: '磁性男声' },
      { id: 'wenrounansheng', name: '温柔男声' },
      { id: 'yuanqinansheng', name: '元气男声' },
      { id: 'wenrougongzi', name: '温柔公子' },
      { id: 'boyinnansheng', name: '播音男声' },
      { id: 'ruyananshi', name: '儒雅男士' },
      { id: 'shenchennanyin', name: '深沉男音' },
      { id: 'zhengpaiqingnian', name: '正派青年' },
      { id: 'zixinnansheng', name: '自信男声' },
      { id: 'elegantgentle-female', name: '气质温婉 (女)' },
      { id: 'livelybreezy-female', name: '活力轻快 (女)' },
      { id: 'jingdiannvsheng', name: '经典女声' },
      { id: 'wenroushunv', name: '温柔熟女' },
      { id: 'tianmeinvsheng', name: '甜美女声' },
      { id: 'qingchunshaonv', name: '清纯少女' },
      { id: 'yuanqishaonv', name: '元气少女' },
      { id: 'linjiajiejie', name: '邻家姐姐' },
      { id: 'wenrounvsheng', name: '温柔女声' },
      { id: 'jilingshaonv', name: '机灵少女' },
      { id: 'ruanmengnvsheng', name: '软萌女声' },
      { id: 'youyanvsheng', name: '优雅女声' },
      { id: 'lengyanyujie', name: '冷艳御姐' },
      { id: 'shuangkuaijiejie', name: '爽快姐姐' },
      { id: 'wenjingxuejie', name: '文静学姐' },
      { id: 'linjiameimei', name: '邻家妹妹' },
      { id: 'zhixingjiejie', name: '知性姐姐' },
      { id: 'qinqienvsheng', name: '亲切女声' },
    ];
  }
  // OpenAI
  if (url.includes('openai.com') || url.includes('api.openai.com')) {
    return [
      { id: 'alloy', name: 'Alloy' },
      { id: 'nova', name: 'Nova (女)' },
      { id: 'shimmer', name: 'Shimmer (女)' },
      { id: 'echo', name: 'Echo (男)' },
      { id: 'onyx', name: 'Onyx (男)' },
      { id: 'fable', name: 'Fable' },
      { id: 'coral', name: 'Coral' },
      { id: 'sage', name: 'Sage' },
      { id: 'ash', name: 'Ash' },
      { id: 'ballad', name: 'Ballad' },
    ];
  }
  // SiliconFlow / FishAudio
  if (url.includes('siliconflow') || url.includes('fishaudio')) {
    return [
      { id: 'default', name: '默认' },
      { id: 'alex', name: 'Alex' },
      { id: 'benjamin', name: 'Benjamin' },
      { id: 'bella', name: 'Bella' },
      { id: 'claire', name: 'Claire' },
      { id: 'david', name: 'David' },
      { id: 'emma', name: 'Emma' },
    ];
  }
  // Volcengine/Doubao seed-tts-2.0 (Agent Plan) — *_uranus_bigtts format
  if (url.includes('bytedance') || url.includes('volcengine') || url.includes('openspeech')) {
    return [
      // 女声
      { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 (女)' },
      { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi (女)' },
      { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 (女)' },
      { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 (女)' },
      { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 (女)' },
      { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 (女)' },
      { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 (女)' },
      { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 (女)' },
      { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 (女)' },
      { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 (女)' },
      { id: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲 (女)' },
      { id: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 (女)' },
      { id: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本 (女)' },
      { id: 'zh_female_mizai_uranus_bigtts', name: '咪仔 (女)' },
      { id: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女 (女)' },
      { id: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友 (女)' },
      { id: 'zh_female_wenroumama_uranus_bigtts', name: '温柔妈妈 (女)' },
      { id: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声 (女)' },
      { id: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声 (女)' },
      { id: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女 (女)' },
      { id: 'zh_female_gufengshaoyu_uranus_bigtts', name: '古风少御 (女)' },
      { id: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头 (女)' },
      { id: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐 (女)' },
      { id: 'zh_female_linxiao_uranus_bigtts', name: '林潇 (女)' },
      { id: 'zh_female_lingling_uranus_bigtts', name: '玲玲姐姐 (女)' },
      { id: 'zh_female_wuzetian_uranus_bigtts', name: '武则天 (女)' },
      { id: 'zh_female_gujie_uranus_bigtts', name: '顾姐 (女)' },
      { id: 'zh_female_shaoergushi_uranus_bigtts', name: '少儿故事 (女)' },
      { id: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子 (女)' },
      { id: 'zh_female_popo_uranus_bigtts', name: '婆婆 (女)' },
      // 男声
      { id: 'zh_male_m191_uranus_bigtts', name: '云舟 (男)' },
      { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 (男)' },
      { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 (男)' },
      { id: 'zh_male_dayi_uranus_bigtts', name: '大壹 (男)' },
      { id: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰 (男)' },
      { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明 (男)' },
      { id: 'zh_male_yizhipiannan_uranus_bigtts', name: '译制片男 (男)' },
      { id: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩 (男)' },
      { id: 'zh_male_silang_uranus_bigtts', name: '四郎 (男)' },
      { id: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年 (男)' },
      { id: 'zh_male_qingcang_uranus_bigtts', name: '擎苍 (男)' },
      { id: 'zh_male_xionger_uranus_bigtts', name: '熊二 (男)' },
      { id: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎 (男)' },
      { id: 'zh_male_naiqimengwa_uranus_bigtts', name: '奶气萌娃 (男)' },
      { id: 'zh_male_aojiaobazong_uranus_bigtts', name: '傲娇霸总 (男)' },
      { id: 'zh_male_fanjuanqingnian_uranus_bigtts', name: '反卷青年 (男)' },
      { id: 'zh_male_baqiqingshu_uranus_bigtts', name: '霸气青叔 (男)' },
      { id: 'zh_male_xuanyijieshuo_uranus_bigtts', name: '悬疑解说 (男)' },
      { id: 'zh_male_cixingjieshuonan_uranus_bigtts', name: '磁性解说 (男)' },
      { id: 'zh_male_gaolengchenwen_uranus_bigtts', name: '高冷沉稳 (男)' },
      { id: 'zh_male_shenyeboke_uranus_bigtts', name: '深夜播客 (男)' },
      { id: 'zh_male_tangseng_uranus_bigtts', name: '唐僧 (男)' },
      { id: 'zh_male_zhuangzhou_uranus_bigtts', name: '庄周 (男)' },
      { id: 'zh_male_zhubajie_uranus_bigtts', name: '猪八戒 (男)' },
      { id: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥 (男)' },
      { id: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛 (男)' },
      { id: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年 (男)' },
      { id: 'zh_male_wenrouxiaoge_uranus_bigtts', name: '温柔小哥 (男)' },
      { id: 'zh_male_tiancaitongsheng_uranus_bigtts', name: '天才童声 (男)' },
      { id: 'zh_male_guanggaojieshuo_uranus_bigtts', name: '广告解说 (男)' },
    ];
  }
  // Volink CosyVoice2-0.5B voices
  if (url.includes('volink')) {
    return [
      // 女声 (19)
      { id: '68f05ee2fa7d57c78f362dfa', name: '暖心外婆 (女)' },
      { id: '68f05ee2fa7d57c78f362dfb', name: '魅惑女神 (女)' },
      { id: '68f05ee2fa7d57c78f362dfc', name: '热销达人 (女)' },
      { id: '68f05ee2fa7d57c78f362dfd', name: '访谈主持 (女)' },
      { id: '68f05ee2fa7d57c78f362dfe', name: '宝岛甜心 (女)' },
      { id: '68f05ee2fa7d57c78f362dff', name: '温柔女神 (女)' },
      { id: '68f05ee2fa7d57c78f362e00', name: '冰山美人 (女)' },
      { id: '68f05ee2fa7d57c78f362e01', name: '卡通女孩 (女)' },
      { id: '68f05ee2fa7d57c78f362e02', name: '甜蜜恋人 (女)' },
      { id: '68f05ee2fa7d57c78f362e03', name: '魅力女生 (女)' },
      { id: '68f05ee2fa7d57c78f362e0e', name: '艾娃 (女)' },
      { id: '68f05ee2fa7d57c78f362e0f', name: '贝拉 (女)' },
      { id: '68f05ee2fa7d57c78f362e10', name: '莎拉 (女)' },
      { id: '68f05ee2fa7d57c78f362e11', name: '艾玛 (女)' },
      { id: '68f05ee2fa7d57c78f362e12', name: '妮可 (女)' },
      { id: '68f05ee2fa7d57c78f362e13', name: '凯瑟琳 (女)' },
      { id: '68f05ee2fa7d57c78f362e14', name: '丽莎 (女)' },
      { id: '68f05ee2fa7d57c78f362e15', name: '米娅 (女)' },
      { id: '68f05ee2fa7d57c78f362e17', name: '菲奥娜 (女)' },
      // 男声 (17)
      { id: '68f05ee2fa7d57c78f362e04', name: '高冷领导 (男)' },
      { id: '68f05ee2fa7d57c78f362e05', name: '温柔男友 (男)' },
      { id: '68f05ee2fa7d57c78f362e06', name: '忧郁少年 (男)' },
      { id: '68f05ee2fa7d57c78f362e07', name: '专业播报 (男)' },
      { id: '68f05ee2fa7d57c78f362e08', name: '睿智老爹 (男)' },
      { id: '68f05ee2fa7d57c78f362e09', name: '翩翩公子 (男)' },
      { id: '68f05ee2fa7d57c78f362e0a', name: '邻家男孩 (男)' },
      { id: '68f05ee2fa7d57c78f362e0b', name: '儒雅青年 (男)' },
      { id: '68f05ee2fa7d57c78f362e0c', name: '职场新星 (男)' },
      { id: '68f05ee2fa7d57c78f362e0d', name: '卖萌男孩 (男)' },
      { id: '68f05ee2fa7d57c78f362e18', name: '欢乐圣诞老人 (男)' },
    ];
  }
  // QwenAPI TTS (REST /qwenapi/v1/custom-voice — speaker IDs are English names)
  // Matches both cloud (cnb.run) and local (127.0.0.1:7860 / localhost:7860) Qwen3-TTS
  if (url.includes('cnb.run') || url.includes('qwenapi')
    || url.includes('127.0.0.1:7860') || url.includes('localhost:7860')) {
    return [
      { id: 'default', name: '默认 (default)' },
      { id: 'aiden', name: 'Aiden (男)' },
      { id: 'dylan', name: 'Dylan (男)' },
      { id: 'eric', name: 'Eric (男)' },
      { id: 'ryan', name: 'Ryan (男)' },
      { id: 'uncle_fu', name: 'Fu大叔 (男)' },
      { id: 'ono_anna', name: 'Anna (女)' },
      { id: 'serena', name: 'Serena (女)' },
      { id: 'sohee', name: 'Sohee (女)' },
      { id: 'vivian', name: 'Vivian (女)' }
    ];
  }

  // 阿里云百炼 / DashScope TTS 音色（按模型分发；音色不能跨模型混用，错配会 411）
  if (url.includes('dashscope') || url.includes('bailian') || url.includes('aliyun')
    || url.includes('qwen.ai') || url.includes('qianwenai')) {
    if (model && /qwen-audio-3\.0-tts-flash/.test(model)) {
      return BAILIAN_FLASH_VOICES.map(v => ({ id: v, name: v }));
    }
    if (model && /qwen-audio-3\.0-tts-plus/.test(model)) {
      return BAILIAN_PLUS_VOICES.map(v => ({ id: v, name: v }));
    }
    if (model && /qwen3-tts-flash-realtime/.test(model)) {
      return BAILIAN_QWEN3_VOICES.map(v => ({ id: v, name: v }));
    }
    if (model && isCosyVoiceV3(model)) {
      return BAILIAN_COSYVOICE_V3_VOICES.map(v => ({ id: v, name: v }));
    }
    if (model && /cosyvoice-v2/.test(model)) {
      return BAILIAN_COSYVOICE_V2_VOICES.map(v => ({ id: v, name: v }));
    }
    // 默认：qwen3-tts（HTTP）内置音色
    return [
      { id: 'Cherry', name: 'Cherry (女)' },
      { id: 'Ethan', name: 'Ethan (男)' },
      { id: 'Serena', name: 'Serena (女)' },
      { id: 'Carly', name: 'Carly (女)' },
      { id: 'Ada', name: 'Ada (女)' },
      { id: 'Bella', name: 'Bella (女)' },
      { id: 'Donna', name: 'Donna (女)' },
      { id: 'Alice', name: 'Alice (女)' },
    ];
  }

  // Default/generic
  return [
    { id: 'alloy', name: 'Alloy' },
    { id: 'nova', name: 'Nova' },
    { id: 'echo', name: 'Echo' },
    { id: 'onyx', name: 'Onyx' },
  ];
}

module.exports = buildTTSRouter;

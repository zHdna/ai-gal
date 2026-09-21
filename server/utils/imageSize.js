/**
 * imageSize.js — 生图尺寸的唯一规范化入口（前端 app.js 里有一份等价实现）。
 *
 * 为什么需要它
 * ------------
 * anima-turbo-cg（stable-diffusion.cpp）的 OpenAI 路由这样解析尺寸：
 *
 *     std::string size = j.value("size", "");
 *     auto pos = size.find('x');            // ★ 只找小写 'x'
 *     if (pos != std::string::npos) { width = stoi(...); height = stoi(...); }
 *     // 找不到 → 【静默】沿用启动参数 --width/--height
 *
 * 于是 `1536X1024`（大写 X）、`1536×1024`（全角）、`1536*1024`、`1536 x 1024` 全部会被
 * **无声忽略**，出图回到服务默认尺寸 —— 用户看到的现象就是"AI-GAL 里设的分辨率无效"。
 * 实测（RTX 5090，master-872-cc515a0）：`512x512` → 512x512；`1536X1024` → 1024x1024。
 *
 * 规矩：**任何进入请求体或写进数据库的尺寸，都必须先过这里**。
 * 解析不出宽高时返回 ''（= 不指定尺寸，让服务用默认值），绝不把看不懂的串发出去。
 */

/** 允许的分隔符：小写/大写 x、全角 ×、乘号 *、✕ ╳，两侧可带空格 */
const SIZE_RE = /^(\d{1,5})\s*[xX×*✕╳]\s*(\d{1,5})$/;

/** 各引擎的建议范围（仅用于 warn / 对齐，不做硬拒绝——引擎本身不校验尺寸） */
const SIZE_LIMITS = {
  // Anima-Turbo 原生 1024²；README 建议 512~1536，sd.cpp 实测到 3072 也能出（只是更慢）
  anima: { min: 256, max: 3072, recommendedMin: 512, recommendedMax: 1536, snap: 8, native: 1024 },
  // NovelAI 要求 64 的倍数，上限 3072
  novelai: { min: 64, max: 3072, recommendedMin: 512, recommendedMax: 1536, snap: 64, native: 1024 },
  // 云端 OpenAI 兼容 / Stability：交给服务商自己的校验，这边只做基本规范化
  default: { min: 64, max: 4096, recommendedMin: 256, recommendedMax: 2048, snap: 0, native: 1024 },
};

/** '1536X1024' → {width:1536, height:1024}；解析不出 → null */
function parseImageSize(raw) {
  const m = String(raw == null ? '' : raw).trim().match(SIZE_RE);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/** '1536 × 1024' → '1536x1024'（小写 x、无空格）；解析不出 → '' */
function normalizeImageSize(raw) {
  const d = parseImageSize(raw);
  return d ? (d.width + 'x' + d.height) : '';
}

function limitsFor(mode) {
  return SIZE_LIMITS[mode] || SIZE_LIMITS.default;
}

/**
 * 按引擎把尺寸对齐到"引擎能舒服吃下"的档位。
 * 返回 { size, changed, notes }：
 *   size    —— 规范化后的 `宽x高`（或 ''）
 *   changed —— 与入参字面不同（调用方据此打一条日志，让用户第一眼看到被改过）
 *   notes   —— 给人看的说明（为什么改、建议值）
 */
function sizeForEngine(mode, raw) {
  const original = String(raw == null ? '' : raw).trim();
  const dims = parseImageSize(original);
  if (!dims) {
    return {
      size: '',
      changed: !!original,
      notes: original
        ? `尺寸 "${original}" 无法解析为「宽x高」，已按"不指定尺寸"处理（引擎会用它自己的默认值）`
        : '',
    };
  }
  const lim = limitsFor(mode);
  const notes = [];
  let { width, height } = dims;

  // 1) 对齐到引擎要求的倍数（anima/sd.cpp 走 8 的倍数即可；NovelAI 必须 64）
  if (lim.snap > 0) {
    const sw = Math.round(width / lim.snap) * lim.snap;
    const sh = Math.round(height / lim.snap) * lim.snap;
    if (sw !== width || sh !== height) {
      notes.push(`已对齐到 ${lim.snap} 的倍数：${width}x${height} → ${sw}x${sh}`);
      width = sw; height = sh;
    }
  }
  // 2) 夹到引擎上下限
  const clamp = (v) => Math.max(lim.min, Math.min(lim.max, v));
  const cw = clamp(width), ch = clamp(height);
  if (cw !== width || ch !== height) {
    notes.push(`已夹到 ${lim.min}~${lim.max}：${width}x${height} → ${cw}x${ch}`);
    width = cw; height = ch;
  }
  // 3) 超出"推荐范围"只提醒，不改（本地引擎照样能出，只是慢/画质未必更好）
  if (Math.max(width, height) > lim.recommendedMax || Math.min(width, height) < lim.recommendedMin) {
    notes.push(`建议把尺寸放在 ${lim.recommendedMin}~${lim.recommendedMax} 之间（${mode === 'anima' ? '本地模型原生 ' + lim.native + '²' : '画质与耗时更均衡'}）`);
  }

  const size = width + 'x' + height;
  const changed = size !== original;
  if (changed && /[^0-9x]/.test(original)) {
    // 只有"分隔符写法"变了才单独说一句 —— 这正是用户踩的那个坑
    notes.unshift(`已把 "${original}" 规范化成 "${size}"（本地引擎只认小写 x）`);
  } else if (changed) {
    notes.unshift(`已把 "${original}" 调整为 "${size}"`);
  }
  return { size, changed, notes };
}

module.exports = { parseImageSize, normalizeImageSize, sizeForEngine, SIZE_LIMITS };

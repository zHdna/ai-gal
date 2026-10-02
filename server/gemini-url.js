/**
 * Gemini OpenAI 兼容地址的归一化 —— 全仓唯一实现。
 *
 * 背景（缺陷）：旧代码只判断「字符串里有没有 /v1beta/openai」来决定是否追加：
 *
 *     if (!url.includes('/v1beta/openai')) url = url + '/v1beta/openai';
 *
 * 于是 base_url 填成 `https://generativelanguage.googleapis.com/v1beta`（只到版本号，
 * 很自然的填法）时，会拼成 `.../v1beta/v1beta/openai/chat/completions` → 必然 404。
 * 而正确填法 `.../v1beta/openai` 又恰好能过，所以这个 bug 长期潜伏。
 *
 * 归一化规则（按路径段，不看子串）：
 *   .../v1beta                     → .../v1beta/openai
 *   .../v1beta/openai[/...]        → 原样（已正确）
 *   https://<host>[/]              → .../v1beta/openai
 *   .../v1beta/v1beta/openai       → 自愈为 .../v1beta/openai（救回被旧 bug 存坏的配置）
 * 并剥掉误粘贴进来的 /chat/completions、/models 结尾，避免二次拼接。
 *
 * @param {string} url 用户填写的 base_url
 * @returns {string} OpenAI 兼容根地址（不含 /chat/completions 或 /models）
 */
function normalizeGeminiBase(url) {
  let u = String(url || '').replace(/\/+$/, '');
  // 用户可能把完整端点粘进来，先剥掉，保证拼出来只有一个端点段
  u = u.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
  // 自愈：已被旧 bug 写成重复 /v1beta 的值
  u = u.replace(/\/v1beta\/v1beta\/openai/, '/v1beta/openai');
  u = u.replace(/(\/v1beta\/openai)(\/v1beta\/openai)+/, '$1');
  if (u.includes('/v1beta/openai')) return u;
  if (/\/v1beta$/.test(u)) return u + '/openai';
  return u + '/v1beta/openai';
}

module.exports = { normalizeGeminiBase };

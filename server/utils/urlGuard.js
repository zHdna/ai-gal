/**
 * URL 安全校验工具
 * 防止 SSRF 攻击：阻止访问内网地址和云元数据端点
 */

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',  // AWS / Azure 元数据
  'metadata.google.internal',  // GCP 元数据
  '0.0.0.0',
  '::1',
  '[::1]',
]);

// 内网 IP 前缀（IPv4 私有地址段）
const PRIVATE_IP_PATTERNS = [
  /^127\./,           // loopback
  /^10\./,            // class A private
  /^192\.168\./,      // class C private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // class B private
];

/**
 * 校验 URL 是否安全（非内网、非元数据端点）
 * 本地工具默认允许 127.0.0.1 和 192.168.* 访问（用于 ComfyUI/llama.cpp 等）
 * 如需严格模式，设置环境变量 SSRF_STRICT=1
 * @param {string} rawUrl - 待校验的 URL
 * @returns {{ ok: boolean, reason: string }}
 */
function isUrlSafe(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'Invalid URL' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }

  // 仅允许 http/https 协议
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Protocol ${parsed.protocol} not allowed` };
  }

  const host = parsed.hostname.toLowerCase();

  // 阻止云元数据地址
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, reason: 'Blocked: cloud metadata endpoint' };
  }

  // 严格模式：阻止所有内网地址
  if (process.env.SSRF_STRICT === '1') {
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(host)) {
        return { ok: false, reason: 'Blocked: private IP in strict mode' };
      }
    }
  }

  return { ok: true, reason: '' };
}

module.exports = { isUrlSafe, BLOCKED_HOSTS };

/**
 * Unified Crypto Module
 * Single source of truth for API key encryption/decryption.
 * All routes must require this module instead of implementing their own.
 *
 * Algorithm: AES-256-GCM
 * Key derivation: scryptSync with CRYPTO_PASSWORD + CRYPTO_SALT
 *
 * SECURITY: every user of this build MUST supply their own CRYPTO_PASSWORD.
 * There is deliberately no usable default: if the env vars are missing we
 * derive a per-machine random key and refuse to persist it, so an encrypted
 * key written by one installation can never be decrypted by another.
 * (Previous builds shipped a hardcoded default password + salt, which made
 * every stored API key trivially recoverable by anyone with the database.)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENC_ALGO = 'aes-256-gcm';

let ENC_KEY;
let KEY_IS_EPHEMERAL = false;

if (process.env.CRYPTO_PASSWORD && process.env.CRYPTO_SALT) {
  ENC_KEY = crypto.scryptSync(process.env.CRYPTO_PASSWORD, process.env.CRYPTO_SALT, 32);
} else {
  // Generate (and persist) a random per-installation secret instead of a
  // shared hardcoded one. Deleting this file simply invalidates stored keys.
  const secretFile = path.join(__dirname, 'db', '.crypto_secret');
  let secret;
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    secret = crypto.randomBytes(48).toString('hex');
    try {
      fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    } catch {
      KEY_IS_EPHEMERAL = true;
    }
  }
  ENC_KEY = crypto.scryptSync(secret, 'ai-galgame-local', 32);
  console.warn(
    '[Crypto] CRYPTO_PASSWORD/CRYPTO_SALT not set — using a machine-local random key' +
    (KEY_IS_EPHEMERAL
      ? ' (in-memory only; stored API keys will not survive a restart).'
      : ' stored in server/db/.crypto_secret.')
  );
}

/**
 * Encrypt a plaintext string to base64.
 * Format: iv(16) + authTag(16) + ciphertext → base64
 */
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENC_ALGO, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext back to plaintext.
 * Returns original data string on failure (backward compat with plaintext keys).
 */
function decrypt(data) {
  if (!data) return '';
  try {
    const buf = Buffer.from(data, 'base64');
    const iv = buf.subarray(0, 16);
    const tag = buf.subarray(16, 32);
    const encrypted = buf.subarray(32);
    const decipher = crypto.createDecipheriv(ENC_ALGO, ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    // 解密失败返回空字符串，不降级为返回原密文（安全优先）
    console.error('[Crypto] Decrypt failed — returning empty string');
    return '';
  }
}

module.exports = { encrypt, decrypt, ENC_ALGO };

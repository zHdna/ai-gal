/**
 * Roll 点：行动选项的成功率解析（格式侧）。
 *
 * 判定内核在 server/utils/dice.js；这里只是把它接到 aigalFormat 的校验链上。
 * 之所以格式层也要剥一次：G3/G3l 会检查选项行的长度、以及是否有选项行漏进正文，
 * 带成功率后缀的行若原样参与比对，口径会漂移。
 */
const { parseRate: parseRollRate } = require('./dice');

/** 从选项行剥掉成功率后缀（保留干净文案）。返回 {text, rate} */
function stripRateSuffix(line) {
  return parseRollRate(line);
}

module.exports = { stripRateSuffix };

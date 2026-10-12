/**
 * 记忆表格（memory table）的构建与重建 —— **唯一真源**。
 * ---------------------------------------------------------------------------
 * 以前这段逻辑内联在 routes/chat.js 的闭包里（buildMemoryTable / injectMemoryTable），
 * 只有"到达 N 的倍数轮"这一条路径会用。于是出现两个问题（2026-10-12 用户实测）：
 *
 *   1) 删轮次会清空 memory_context（turnCleanup.cleanupEventLog），
 *      而重建要等到下一个 20 轮边界 —— 中间最多 19 轮都显示黄灯（未注入）。
 *   2) 注入判据是 `round % N === 0`（**精确等于**边界）。
 *      一旦错过那个轮号（删楼、生成失败、改过 N），就要再干等一整轮 N 才补上。
 *
 * 抽到这里之后：
 *   · routes/chat.js 的注入仍走同一份构建逻辑（不再各写一份）
 *   · turnCleanup 删轮次后可以**立刻重建**（A 方案）
 *   · 注入判据改为"距上次注入 ≥ N 轮"（B 方案），在 chat.js 侧生效
 *
 * ⚠️ 表格是**完整**的（不裁剪行）：它每 N 轮才注入一次，把全量塞进去正是设计目的
 *    —— 早期剧情在被裁剪后仍能靠它保住。
 */
const path = require('path');
const fs = require('fs');
const { MEMORY_KEYS } = require('../constants');

/**
 * 从 event_log.md 构建 markdown 表格。
 * @param {string} eventLogPath
 * @returns {{table: string, rows: number}}
 */
function buildMemoryTable(eventLogPath) {
  if (!eventLogPath || !fs.existsSync(eventLogPath)) return { table: '', rows: 0 };
  const allLines = fs.readFileSync(eventLogPath, 'utf-8').split('\n').filter(l => l.trim());
  if (allLines.length === 0) return { table: '', rows: 0 };
  const tableHeader = '| 轮次 | 时间 | 地点 | 人物 | 事件 |\n|------|------|------|------|------|\n';
  const rows = allLines.map(line => {
    const parts = line.replace(/^第\d+轮\s*\|\s*/, '').split('|').map(p => p.trim());
    const roundMatch = line.match(/^第(\d+)轮/);
    const round = roundMatch ? roundMatch[1] : '?';
    return `| ${round} | ${parts[0] || ''} | ${parts[1] || ''} | ${parts[2] || ''} | ${parts[3] || ''} |`;
  });
  return { table: tableHeader + rows.join('\n'), rows: rows.length };
}

/**
 * 把当前 event_log 的完整表格写入 conversations.memory_context。
 *
 * @param {object} db
 * @param {string} conversationId
 * @param {string} eventLogPath
 * @param {number} currentRound 当前轮次（写入 INJECTED_AT，供 buildApiMessages 判断）
 * @returns {{table: string, rows: number}|null} 无内容时返回 null（**不清空**已有上下文）
 */
function writeMemoryContext(db, conversationId, eventLogPath, currentRound) {
  if (!conversationId || !eventLogPath) return null;
  const { table, rows } = buildMemoryTable(eventLogPath);
  // 表格为空时保持原样：宁可留着旧表，也不要把已有上下文清成空（那会让灯全变黄）
  if (!table) return null;
  const round = Math.max(0, parseInt(currentRound, 10) || 0);
  db.prepare('UPDATE conversations SET memory_context = ? WHERE id = ?')
    .run(JSON.stringify({
      [MEMORY_KEYS.EVENT_LOG]: table,
      [MEMORY_KEYS.LAST_ROUND]: round,
      [MEMORY_KEYS.INJECTED_AT]: round,
    }), conversationId);
  return { table, rows };
}

/**
 * 删轮次之后的重建（A 方案）。
 *
 * 与 cleanupEventLog 配套：清理完 event_log 后**立刻**按删减后的内容重建 memory_context，
 * 而不是留下一个空对象、干等下一个 N 轮边界。
 * 新写入的 INJECTED_AT = 当前轮数，于是 buildApiMessages 会立刻恢复注入。
 *
 * @returns {{table: string, rows: number}|null}
 */
function rebuildMemoryContextAfterCleanup(db, conversationId) {
  try {
    const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(conversationId);
    if (!save) return null;
    const eventLogPath = path.join(save.save_path, 'event_log.md');
    // 当前轮数 = user 消息条数（与 chat.js countRounds 同口径；**不加 hidden 过滤**）
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(conversationId);
    const currentRound = row ? row.n : 0;
    const res = writeMemoryContext(db, conversationId, eventLogPath, currentRound);
    if (res) {
      console.log('[TurnCleanup] memory_context rebuilt after cleanup: ' + res.rows + ' entries (round=' + currentRound + ')');
    } else {
      // 表格为空（例如把全部轮次删光了）→ 明确写空是**正确**的：确实没有记忆了
      db.prepare('UPDATE conversations SET memory_context = ? WHERE id = ?').run(JSON.stringify({}), conversationId);
      console.log('[TurnCleanup] memory_context cleared (event_log empty after cleanup)');
    }
    return res;
  } catch (e) {
    console.warn('[TurnCleanup] memory_context rebuild failed:', e.message);
    return null;
  }
}

module.exports = { buildMemoryTable, writeMemoryContext, rebuildMemoryContextAfterCleanup };

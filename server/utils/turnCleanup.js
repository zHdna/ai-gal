/**
 * 回合清理工具（Round cleanup helpers）
 * ---------------------------------------------------------------------------
 * 「一轮」= 一条 user 消息 + 它的 assistant 回复。删除某一轮（或某一轮里的单条
 * 回复）时，除了 messages 表里的行，还要清掉服务端派生出来的管家 AI 处理结果：
 *   · event_log.md 里该轮的记忆行（管家 summarize 写入的长期记忆）
 *   · conversations.memory_context（强制下次重建，避免指向已被删掉的轮次）
 *
 * 这两个函数原先内联在 routes/messages.js 里，「删除单条回复」与「重新生成」
 * 两条链路都需要同一套语义，抽到这里共用，避免两边各写一份、行为漂移。
 *
 * ⚠️ 两条硬规则（都踩过）：
 *
 * 1) 轮次定义必须与 chat.js 的 countRounds() 一致：
 *    «轮次 = 该消息之前（含自身）的 user 消息条数»（**不看 hidden**），
 *    开场的问候语（预置的 assistant）折进第 1 轮，不单独占一个轮号。
 *    旧实现用的是 `ceil(message_position / 2)`（按总消息数折半）—— 那正是
 *    countRounds() 注释里写明的「设计错误」，在带开场问候的存档里会算错一轮
 *    （删第 1 轮的回复却去 event_log 里删了第 2 轮的记忆）。
 *    ⚠️ 同样**不能**加 `hidden = 0`：hidden 只是「这条不进 AI 上下文」，
 *    用它筛轮号会让 /hide 1-10 之后所有轮号前移，与正文/记忆表格的轮次矛盾。
 *
 * 2) **一律用 rowid（真实插入顺序）定位，不要用 created_at 排序。**
 *    messages.created_at 默认是 `datetime('now')`，只有**秒级**精度：
 *    用户发言与它的 AI 回复落在同一秒并不罕见（本地小模型 / 快速中转），
 *    此时 `ORDER BY created_at DESC, id DESC` 的 id 是随机 uuid，排序结果是随机的
 *    —— 对「删掉当前轮」这种不可逆操作，会删错楼层（实测：把开场问候删了）。
 *    rowid 是 SQLite 的隐式自增行号，永远等于写入顺序，没有歧义。
 */
const path = require('path');
const fs = require('fs');
const { EVENT_LOG_FILE } = require('../constants');

/**
 * 某一行所属的轮次（与 chat.js 的 countRounds 同口径）。
 * @param {object} db
 * @param {string} conversationId
 * @param {number} rowId  messages.rowid（插入顺序）
 * @returns {number} 1 起的轮次；0 = 这一行之前没有任何用户发言（如开场问候）
 */
function roundOfRowId(db, conversationId, rowId) {
  if (!conversationId || rowId == null) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE conversation_id = ? AND role = 'user' AND rowid <= ?
  `).get(conversationId, rowId);
  return row ? row.n : 0;
}

/**
 * 取这些消息所属的轮次集合（删除前调用）。
 * @returns {Set<number>} 轮次集合（忽略 0：开场问候没有对应轮次）
 */
function getAffectedRounds(db, messageIds) {
  if (!messageIds || messageIds.length === 0) return new Set();

  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT rowid AS rid, id, conversation_id FROM messages WHERE id IN (${placeholders})`).all(...messageIds);
  if (rows.length === 0) return new Set();

  const rounds = new Set();
  for (const row of rows) {
    const n = roundOfRowId(db, row.conversation_id, row.rid);
    if (n > 0) rounds.add(n);
  }
  return rounds;
}

/**
 * Remove entries for deleted rounds from event_log.md and relabel the rest.
 * Format: one line per round: "第N轮 | time | place | chars | event"
 * Also clears memory_context to force rebuild.
 *
 * ⚠️ 重标规则（2026-09-21 修正）：**不是**按 1..M 重排，而是
 *    «删掉第 k 轮后，k 之后的轮次整体前移一位»。两者只在"每一轮都有记忆行"时才等价。
 *    一旦某一轮缺行（模型没产出 summarize —— 数据中心会显示成红色缺失），按 1..M 重排
 *    会**填掉那个空档**，把后面的记忆行错标到别的轮上，从此整张记忆表格与剧情错位
 *    （实测 ai-rp-tool：表格第 33 行写的是第 32 轮的剧情，之后每一行都差一轮，越删越乱）。
 *    按「大于 k 的减 1」重标则与真实轮次一致，空缺保持空缺。
 */
function cleanupEventLog(db, conversation_id, affectedRounds) {
  if (!affectedRounds || affectedRounds.size === 0) return;
  if (!conversation_id) return;

  const save = db.prepare('SELECT * FROM saves WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(conversation_id);
  if (!save) return;

  const eventLogPath = path.join(save.save_path, EVENT_LOG_FILE);
  if (!fs.existsSync(eventLogPath)) return;

  const content = fs.readFileSync(eventLogPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return;

  const deleted = [...affectedRounds].map(Number).filter(n => n > 0).sort((a, b) => a - b);
  if (deleted.length === 0) return;

  const remaining = [];
  for (const line of lines) {
    const m = line.match(/^第(\d+)轮/);
    if (!m) continue;                        // 无归属行（没有轮号前缀）直接丢掉
    const n = parseInt(m[1]);
    if (deleted.includes(n)) continue;       // 这一轮的记忆行被删了
    // 删掉 k 轮 ⇒ 每一轮 k 之后的轮次都往前挪一位
    const shift = deleted.filter(d => d < n).length;
    remaining.push(line.replace(/^第\d+轮/, `第${n - shift}轮`));
  }

  fs.writeFileSync(eventLogPath, remaining.join('\n') + '\n', 'utf-8');

  // Clear memory_context (will be rebuilt at next 20-round boundary)
  db.prepare('UPDATE conversations SET memory_context = ? WHERE id = ?')
    .run(JSON.stringify({}), conversation_id);

  console.log('[TurnCleanup] Event log cleaned: removed rounds', deleted, '→', remaining.length, 'entries remain (relabelled, gaps kept)');
}

module.exports = { roundOfRowId, getAffectedRounds, cleanupEventLog };

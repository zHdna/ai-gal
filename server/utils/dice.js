/**
 * Roll 点判定内核 —— 行动的成败由代码裁定，不由 AI 自述。
 *
 * 骰制：**D100**（1-100）
 *   · **1-5**   = 大失败（critical failure）
 *   · **96-100** = 大成功（critical success）
 *   · 两者**绝对优先**：成功率再高也挡不住 1-5 的大失败，再低也挡不住 96-100 的大成功。
 *   · 其余点数按成功率判定：**点数 > (100 - 成功率)** 即成功。
 *       例：75% → 点数 > 25 成功（26-100，恰好 75 个点 = 75%）
 *           10% → 点数 > 90 成功（91-100，10 个点 = 10%）
 *       这个写法让"成功率"与"骰点区间"一一对应，不再有 D20 那种
 *       "75% 到底对应几点"的换算歧义（旧版就是在这里出的 bug：
 *       拿 D20 点数直接跟 75 比 → 恒真 → 所有选项成功率都一样）。
 *
 * 成功率来源：
 *   ① 主 AI 在选项行尾写【成功率 65%】② 管家补全 ③ 都没写 → 默认档
 *   ④ 玩家手动输入（不点选项）→ 75% 加成档
 *
 * 可见性（三档受众）：
 *   · 骰值 / 成功率 / 判定线 → **对 AI 可见**（AI 要知道难度与掷点才能把
 *     "险胜" 与 "轻松成功" 演出不同质感），也写进幕后控制台供玩家核对；
 *   · 主界面**只显示成败**，不显示骰值（沉浸感）。
 *
 * 本模块【零依赖、零 I/O、纯函数】—— 可单独 require 做单测，不碰 db / express。
 */

'use strict';

// ── 判定档位 ──────────────────────────────────────────────────────────────────
const OUTCOME = {
  CRITICAL_SUCCESS: 'critical_success',
  SUCCESS: 'success',
  FAILURE: 'failure',
  CRITICAL_FAILURE: 'critical_failure',
};

/** 判定来源，落库用（便于日后调参：哪一档成功率给得离谱一眼可查） */
const SOURCE = {
  MAIN_AI: 'main_ai',   // 主 AI 在选项行尾写了成功率
  BUTLER: 'butler',     // 管家补全的成功率
  DEFAULT: 'default',   // 都没写 → 默认档
  MANUAL: 'manual',     // 玩家手动输入 → 75% 加成档
};

// ── 骰制常量（D100）──────────────────────────────────────────────────────────
const DIE_MIN = 1;
const DIE_MAX = 100;
/** 大失败区间：1-5（含） */
const CRIT_FAIL_MAX = 5;
/** 大成功区间：96-100（含） */
const CRIT_SUCCESS_MIN = 96;
/** 无成功率时的默认档：50%（即点数 > 50 成功，51-100 共 50 个点） */
const DEFAULT_RATE = 50;
/** 玩家手动输入的加成档位 */
const MANUAL_RATE = 75;
/** 成功率夹取范围：防止 AI 写 100% / 0% 让骰子彻底失去意义 */
const RATE_MIN = 5;
const RATE_MAX = 95;

/**
 * 掷骰。默认 1-100。
 * @param {number} [min=1]
 * @param {number} [max=100]
 * @returns {number} 闭区间内的均匀随机整数
 */
function roll(min, max) {
  let lo = Number.isFinite(min) ? Math.floor(min) : DIE_MIN;
  let hi = Number.isFinite(max) ? Math.floor(max) : DIE_MAX;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 把任意输入夹成合法的成功率阈值（5-95）。无法解析 → null */
function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n)));
}

/**
 * 成功率 → 成功所需的最小点数（判定线）。
 *   点数 > (100 - rate) 即成功  ⇔  点数 >= 101 - rate
 *   用整数运算，避免 100*(1-0.9) = 9.999... 这类浮点误差把线算歪。
 *   rate=75 → 26；rate=10 → 91；rate=50 → 51；rate=95 → 6；rate=5 → 96
 */
function successLine(rate) {
  const r = clampRate(rate);
  if (r === null) return null;
  return (DIE_MAX + 1) - r;   // = 101 - rate
}

/**
 * 核心判定。**纯函数**：给定骰值与成功率，返回结论（不掷骰，便于复用与测试）。
 *
 * @param {number} die   骰值 1-100
 * @param {number|null} rate 成功率（5-95）；null/undefined → 走默认档
 * @returns {{outcome: string, die: number, rate: number, source: string, isCritical: boolean}}
 */
function judge(die, rate, source) {
  // ⚠️ 这里**不能**把超出范围的输入夹进 1-100 —— 那会把越界值伪造成合法点数
  // （旧代码曾把 die=63 夹成 20，凭空造出一个"大成功"）。
  // 只做"至少 1 的整数"归一；越界由调用方（roll）保证不会产生。
  const n = Math.floor(Number(die));
  const d = Number.isFinite(n) && n >= DIE_MIN ? n : DIE_MIN;

  // ① 天然大失败 / 大成功 —— 先判，不被成功率覆盖
  if (d >= CRIT_SUCCESS_MIN) {
    return { outcome: OUTCOME.CRITICAL_SUCCESS, die: d, rate: null, source: source || SOURCE.DEFAULT, isCritical: true };
  }
  if (d <= CRIT_FAIL_MAX) {
    return { outcome: OUTCOME.CRITICAL_FAILURE, die: d, rate: null, source: source || SOURCE.DEFAULT, isCritical: true };
  }

  // ② 常规判定
  const hasRate = rate !== null && rate !== undefined && Number.isFinite(Number(rate));
  const r = hasRate ? clampRate(rate) : DEFAULT_RATE;
  const line = successLine(r);
  return {
    outcome: d >= line ? OUTCOME.SUCCESS : OUTCOME.FAILURE,
    die: d,
    rate: r,
    source: source || (hasRate ? SOURCE.MAIN_AI : SOURCE.DEFAULT),
    isCritical: false,
  };
}

/**
 * 掷骰 + 判定一步到位。
 * @param {number|null} rate 成功率；null → 默认档(50%)
 * @param {string} [source] 来源标记
 */
function rollAndJudge(rate, source) {
  const hasRate = rate !== null && rate !== undefined && Number.isFinite(Number(rate));
  const die = roll();
  const res = judge(die, hasRate ? rate : null, hasRate ? (source || SOURCE.MAIN_AI) : SOURCE.DEFAULT);
  // 天然大成功/大失败时 judge 会把 rate 抹成 null（成功率没参与判定）——
  // 但 AI 与控制台仍需要知道"这条行动的难度线是多少"，所以补回去。
  if (res.isCritical) res.rate = hasRate ? clampRate(rate) : DEFAULT_RATE;
  return res;
}

/** 玩家手动输入：固定 75% 加成档 */
function rollManual() {
  const die = roll();
  const res = judge(die, MANUAL_RATE, SOURCE.MANUAL);
  if (res.isCritical) res.rate = MANUAL_RATE;
  return res;
}

// ── 成功率解析 ────────────────────────────────────────────────────────────────
/**
 * 从选项文案里抠出成功率，并返回**剥离后**的干净文案。
 *
 * 兼容主 AI 可能写出的各种漂移写法（全角/半角括号、有无空格冒号）：
 *   【成功率 65%】 (成功率65%) [成功率: 65%] 成功率65% 【成功率65％】
 * 末尾裸百分比 `65%` 也接受（但仅当它明显是标注、不在句中时）。
 *
 * @param {string} text
 * @returns {{text: string, rate: number|null}}
 */
function parseRate(text) {
  let s = String(text == null ? '' : text);
  let rate = null;

  // ① 带"成功率"字样的标注（最可靠）：全角/半角括号均可，冒号空格可选
  const labeled = /[（(\[【]\s*成功率\s*[:：]?\s*(\d{1,3})\s*[%％]\s*[）)\]】]/;
  const m1 = s.match(labeled);
  if (m1) {
    rate = clampRate(m1[1]);
    s = s.replace(labeled, ' ');
  } else {
    // ② 无括号但带字样：成功率 65% / 成功率:65％
    const bare = /成功率\s*[:：]?\s*(\d{1,3})\s*[%％]/;
    const m2 = s.match(bare);
    if (m2) {
      rate = clampRate(m2[1]);
      s = s.replace(bare, ' ');
    } else {
      // ③ 末尾裸百分比：只在行尾（容尾随标点）才认，避免误吃正文里的 "50%的人"
      const tail = /[（(\[【]?\s*(\d{1,3})\s*[%％]\s*[）)\]】]?\s*[。.!！]?\s*$/;
      const m3 = s.match(tail);
      if (m3) {
        const candidate = clampRate(m3[1]);
        // 只接受像成功率的量级（5-95）；且必须位于行尾才算标注
        if (candidate !== null) {
          rate = candidate;
          s = s.slice(0, m3.index);
        }
      }
    }
  }

  // ⚠️ 只有【真的剥到成功率】时才做清理 —— 否则本函数会顺手改掉无关文案
  // （曾经无条件 trim 行尾的 ；、顿号，导致"立刻上了她；"被改成"立刻上了她"，
  //  被 aigal-format-golden 对拍抓到）。没剥到东西就必须原样返回。
  if (rate === null) return { text: s, rate: null };

  // 剥离后清理：合并多余空格、去掉悬空的括号与标点
  s = s.replace(/[（(\[【]\s*[）)\]】]/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .replace(/\s+([，。！？、；：])/g, '$1')
       .replace(/[\s，、；]+$/, '')
       .trim();

  return { text: s, rate };
}

/**
 * 选项归一化：把 **两种历史形态** 统一成 {text, rate}。
 *   · 旧形态（老存档 / 开场白兜底）：纯字符串 → rate = null
 *   · 新形态：{text, rate} 结构体
 * 这是"老存档不会坏"的保障点。
 *
 * @param {string|{text?:string, rate?:number, action?:string}} item
 * @returns {{text: string, rate: number|null}}
 */
function coerceAction(item) {
  if (item == null) return { text: '', rate: null };
  if (typeof item === 'object') {
    const raw = item.text != null ? item.text : (item.action != null ? item.action : '');
    const t = String(raw).trim();
    // 结构体里若已带 rate 就直接用；否则从文案里再抠一次（兼容两种情况混写）
    if (item.rate !== null && item.rate !== undefined && Number.isFinite(Number(item.rate))) {
      return { text: t, rate: clampRate(item.rate) };
    }
    const p = parseRate(t);
    return { text: p.text || t, rate: p.rate };
  }
  const parsed = parseRate(String(item));
  return { text: parsed.text || String(item).trim(), rate: parsed.rate };
}

/** 批量归一化 */
function coerceActions(list) {
  if (!Array.isArray(list)) return [];
  return list.map(coerceAction).filter(a => a.text);
}

// ── 违规校验（"阳奉阴违"检测）───────────────────────────────────────────────
/**
 * 判定为"成功"时，正文若出现下列**高置信度**否定措辞 ⇒ 认为 AI 违背了系统裁定。
 *
 * ⚠️ 刻意收窄：像"虽然 A 失败了，但 B 成功了"是完全合理的叙事，宽泛匹配会误杀。
 * 这里只抓**明确否定本次行动结果**的写法，宁可漏放不可误杀。
 * 重试仍违背即放行（见 chat.js），不会卡死。
 */
const CONTRADICT_SUCCESS = [
  /虽然[^。！？\n]{0,20}但[^。！？\n]{0,12}(失败了|没能成功|未能成功|没有成功|落空了|还是失败)/,
  /(最终|最后|结果)[^。！？\n]{0,15}(失败了|没能成功|未能成功|没有成功|以失败告终)/,
  /(功亏一篑|功败垂成|以失败告终|前功尽弃)/,
  /就在[^。！？\n]{0,15}(即将|快要|马上)[^。！？\n]{0,10}(成功|得手)[^。！？\n]{0,15}(时|之际)?[^。！？\n]{0,10}(却|被|遭|忽然|突然)/,
  /(眼看|本以为)[^。！？\n]{0,15}(就要|即将)[^。！？\n]{0,10}成功[^。！？\n]{0,15}(却|但|可)/,
];

/** 判定为"失败"时，正文若宣称行动意外得手 ⇒ 同样算违背 */
const CONTRADICT_FAILURE = [
  /(意外|竟然|居然|反倒|反而)[^。！？\n]{0,12}(成功|得手|办到了|做到了)/,
  /(出人意料|出乎意料)[^。！？\n]{0,12}(成功|得手)/,
];

/**
 * 检查主 AI 正文是否违背判定。
 * @param {string} storyText 主 AI 的 ### story 正文
 * @param {string} outcome   判定结果（OUTCOME.*）
 * @returns {{violated: boolean, matched: string|null}}
 */
function checkContradiction(storyText, outcome) {
  const s = String(storyText || '');
  if (!s) return { violated: false, matched: null };

  let patterns = null;
  if (outcome === OUTCOME.SUCCESS || outcome === OUTCOME.CRITICAL_SUCCESS) {
    patterns = CONTRADICT_SUCCESS;
  } else if (outcome === OUTCOME.FAILURE || outcome === OUTCOME.CRITICAL_FAILURE) {
    patterns = CONTRADICT_FAILURE;
  }
  if (!patterns) return { violated: false, matched: null };

  for (const re of patterns) {
    const m = s.match(re);
    if (m) return { violated: true, matched: m[0] };
  }
  return { violated: false, matched: null };
}

// ── 给 AI / 控制台用的文案 ─────────────────────────────────────────────────────
/** 中文档位名 */
function outcomeLabel(outcome) {
  switch (outcome) {
    case OUTCOME.CRITICAL_SUCCESS: return '大成功';
    case OUTCOME.SUCCESS: return '成功';
    case OUTCOME.CRITICAL_FAILURE: return '大失败';
    case OUTCOME.FAILURE: return '失败';
    default: return '未知';
  }
}

/** 主界面 genStatus 用的短提醒 */
function outcomeBadgeText(outcome) {
  switch (outcome) {
    case OUTCOME.CRITICAL_SUCCESS: return '◆ 大成功！';
    case OUTCOME.SUCCESS: return '◇ 上一段行动：成功';
    case OUTCOME.CRITICAL_FAILURE: return '☠ 大失败！';
    case OUTCOME.FAILURE: return '✕ 行动失败';
    default: return '';
  }
}

/**
 * 构造注入给主 AI 的【行动判定】块。
 * 骰值/成功率/判定线**都对 AI 可见** —— AI 需要据此区分"险胜"与"轻松成功"的写法。
 */
function buildJudgementBlock(judgement, actionText) {
  if (!judgement) return '';
  const label = outcomeLabel(judgement.outcome);
  const die = judgement.die;
  const rate = judgement.rate;

  let head = '【行动判定·系统已裁定，不得更改】\n';
  head += '玩家选择：' + String(actionText || '').trim() + '\n';
  head += '掷骰：D100 = ' + die + '\n';
  if (rate !== null && rate !== undefined) {
    const line = successLine(rate);
    head += '成功率：' + rate + '%';
    if (judgement.isCritical) {
      head += '（天然 ' + die + ' → ' + label + '，大小成功/失败优先，不参考成功率）';
    } else {
      head += '（判定线：点数 ≥ ' + line + ' 成功，即 ' + die + (die >= line ? ' ≥ ' : ' < ') + line + '）';
    }
    head += '\n';
  } else {
    head += '成功率：未提供（走默认档 ' + DEFAULT_RATE + '%）\n';
  }
  head += '判定结果：' + label + '\n';

  // 按档位给出差异化的写作要求
  let tail;
  switch (judgement.outcome) {
    case OUTCOME.CRITICAL_SUCCESS:
      tail = '· 这是**大成功**：玩家行动不仅达成目的，还须带来超出预期的额外收获（意外情报、额外盟友、\n' +
             '  意外之财、对方露出破绽……），写得比普通成功更痛快、更有回报感。';
      break;
    case OUTCOME.SUCCESS: {
      // 距判定线很近 → 写成险胜
      const near = rate !== null && rate !== undefined && (die - successLine(rate)) <= 15;
      tail = '· 这是**成功**：让玩家的行动真实生效、达成其意图。' +
             (near ? '\n  骰值勉强压过判定线 —— 请写成**险胜**：过程有阻力、有惊无险，不是轻松做到。' : '');
      break;
    }
    case OUTCOME.CRITICAL_FAILURE:
      tail = '· 这是**大失败**：行动以最糟的方式落空，必须写出**明确且代价性的恶果**' +
             '（受伤、被发觉、失去信任、错失时机、引来更强敌意……），且该恶果会在后续产生回响。';
      break;
    case OUTCOME.FAILURE:
      tail = '· 这是**失败**：玩家的行动未能达成意图，须写出**具体的原因与阻碍**，' +
             '并让局势朝不利方向推进一步；不要用"其实也算成功了"的方式软化它。';
      break;
    default:
      tail = '';
  }

  const body = head + '\n⚠️ 这是系统已经完成的判定，是**既定事实**，不是建议、不是参考、不可推翻：\n' +
    '· 你**必须**按「' + label + '」的结果推进剧情；\n' +
    '· 严禁把结果写成相反的样子，严禁"虽然……但是失败了"、"就在即将成功时被打断"这类架空写法；\n' +
    '· 严禁让 NPC 或旁白否定该结果，也不得用"看起来成功了，其实……"的方式绕开它；\n' +
    tail + '\n' +
    '· 判定结果已经落库，你的输出会被系统校验；若违背，本轮将被驳回重写。';

  return body;
}

module.exports = {
  OUTCOME, SOURCE,
  DIE_MIN, DIE_MAX, CRIT_FAIL_MAX, CRIT_SUCCESS_MIN,
  DEFAULT_RATE, MANUAL_RATE, RATE_MIN, RATE_MAX,
  roll, clampRate, successLine, judge, rollAndJudge, rollManual,
  parseRate, coerceAction, coerceActions,
  checkContradiction,
  outcomeLabel, outcomeBadgeText, buildJudgementBlock,
};

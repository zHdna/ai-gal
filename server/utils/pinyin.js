// Lightweight Chinese -> pinyin romanization (best-effort, zero external deps).
//
// ⛔ 已停用（2026-09，用户定稿）：**不要再拿它当名册 english_name 的来源**。
//    理由：拼音不等于角色的官方英文名（柊沙耶 → ZhongShaYe 是错的读法），而且拼音表永远补不全，
//    补不到的字会原样返回中文，历史上正是这条路径把「english_name 写成中文」写进了名册。
//    名册的 english_name 现在**只**来自热门二次元角色译名查询表 server/utils/anime-names.js，
//    原创角色一律没有该字段。详见 ENGLISH_NAME_CN_ROOT_CAUSE.md。
//    本文件保留只为兼容旧脚本/测试，应用代码里已无引用。
//
// Coverage: a curated set of common surname / given-name characters plus a few
// everyday words. Characters not present in MAP are returned verbatim so the
// name stays identifiable (e.g. a rare character falls through unchanged).
//
// This is intentionally NOT a full Unihan dictionary — it only needs to produce
// a reasonable English reading for character names so image-generation models
// can treat them as labelled fan-art subjects.

const MAP = {
  // 常见姓氏
  '艾': 'Ai', '安': 'An', '白': 'Bai', '包': 'Bao', '毕': 'Bi', '曹': 'Cao', '陈': 'Chen', '程': 'Cheng',
  '楚': 'Chu', '崔': 'Cui', '戴': 'Dai', '邓': 'Deng', '丁': 'Ding', '东方': 'Dongfang', '董': 'Dong',
  '杜': 'Du', '范': 'Fan', '方': 'Fang', '冯': 'Feng', '凤': 'Feng', '高': 'Gao', '宫': 'Gong', '古': 'Gu',
  '顾': 'Gu', '郭': 'Guo', '韩': 'Han', '何': 'He', '洪': 'Hong', '胡': 'Hu', '黄': 'Huang', '霍': 'Huo',
  '姬': 'Ji', '江': 'Jiang', '金': 'Jin', '康': 'Kang', '柯': 'Ke', '雷': 'Lei', '李': 'Li', '梁': 'Liang',
  '林': 'Lin', '刘': 'Liu', '柳': 'Liu', '龙': 'Long', '卢': 'Lu', '陆': 'Lu', '罗': 'Luo', '吕': 'Lyu',
  '马': 'Ma', '孟': 'Meng', '莫': 'Mo', '慕容': 'Murong', '南宫': 'Nangong', '欧阳': 'Ouyang', '潘': 'Pan',
  '庞': 'Pang', '裴': 'Pei', '彭': 'Peng', '秦': 'Qin', '乔': 'Qiao', '邱': 'Qiu', '屈': 'Qu', '任': 'Ren',
  '沈': 'Shen', '司': 'Si', '司马': 'Sima', '苏': 'Su', '孙': 'Sun', '谭': 'Tan', '唐': 'Tang', '陶': 'Tao',
  '田': 'Tian', '王': 'Wang', '卫': 'Wei', '魏': 'Wei', '温': 'Wen', '吴': 'Wu', '夏': 'Xia', '夏侯': 'Xiahou',
  '萧': 'Xiao', '谢': 'Xie', '辛': 'Xin', '徐': 'Xu', '许': 'Xu', '薛': 'Xue', '叶': 'Ye', '易': 'Yi',
  '殷': 'Yin', '尹': 'Yin', '应': 'Ying', '尤': 'You', '余': 'Yu', '元': 'Yuan', '岳': 'Yue', '云': 'Yun',
  '张': 'Zhang', '赵': 'Zhao', '郑': 'Zheng', '钟': 'Zhong', '周': 'Zhou', '朱': 'Zhu', '诸葛': 'Zhuge',
  '庄': 'Zhuang', '卓': 'Zhuo', '宗': 'Zong', '邹': 'Zou',
  // 常见名字用字
  '若': 'Ruo', '烟': 'Yan', '星': 'Xing', '辉': 'Hui', '西': 'Xi', '亚': 'Ya', '莉': 'Li', '雪': 'Xue',
  '月': 'Yue', '影': 'Ying', '霜': 'Shuang', '露': 'Lu', '兰': 'Lan', '莲': 'Lian', '薇': 'Wei', '雨': 'Yu',
  '晴': 'Qing', '云': 'Yun', '风': 'Feng', '花': 'Hua', '梦': 'Meng', '蝶': 'Die', '瑶': 'Yao', '琳': 'Lin',
  '玲': 'Ling', '璐': 'Lu', '珊': 'Shan', '婷': 'Ting', '婉': 'Wan', '妍': 'Yan', '嫣': 'Yan', '雅': 'Ya',
  '静': 'Jing', '怡': 'Yi', '悦': 'Yue', '柔': 'Rou', '萱': 'Xuan', '涵': 'Han', '汐': 'Xi', '诺': 'Nuo',
  '沫': 'Mo', '浅': 'Qian', '凌': 'Ling', '寒': 'Han', '夜': 'Ye', '墨': 'Mo', '羽': 'Yu', '音': 'Yin',
  '紫': 'Zi', '蓝': 'Lan', '红': 'Hong', '翠': 'Cui', '青': 'Qing', '白': 'Bai', '黑': 'Hei', '银': 'Yin',
  '金': 'Jin', '光': 'Guang', '明': 'Ming', '暗': 'An', '烈': 'Lie', '炎': 'Yan', '冰': 'Bing',
  '水': 'Shui', '火': 'Huo', '海': 'Hai', '山': 'Shan', '川': 'Chuan', '河': 'He', '石': 'Shi', '木': 'Mu',
  '森': 'Sen', '阳': 'Yang', '晨': 'Chen', '夕': 'Xi', '晚': 'Wan', '宇': 'Yu', '辰': 'Chen',
  '心': 'Xin', '灵': 'Ling', '魂': 'Hun', '思': 'Si', '念': 'Nian', '忆': 'Yi', '寻': 'Xun', '晓': 'Xiao',
  '乐': 'Le', '欢': 'Huan', '笑': 'Xiao', '泪': 'Lei', '悲': 'Bei', '哀': 'Ai', '怒': 'Nu', '喜': 'Xi',
  '一': 'Yi', '二': 'Er', '三': 'San', '七': 'Qi', '九': 'Jiu', '子': 'Zi', '儿': 'Er', '小': 'Xiao',
  '大': 'Da', '美': 'Mei', '丽': 'Li', '佳': 'Jia', '秀': 'Xiu', '英': 'Ying', '华': 'Hua', '文': 'Wen',
  '武': 'Wu', '勇': 'Yong', '刚': 'Gang', '强': 'Qiang', '宁': 'Ning', '安': 'An', '平': 'Ping', '和': 'He',
  '正': 'Zheng', '直': 'Zhi', '真': 'Zhen', '善': 'Shan', '纯': 'Chun', '洁': 'Jie', '清': 'Qing', '澈': 'Che',
  '永': 'Yong', '恒': 'Heng', '远': 'Yuan', '飞': 'Fei', '翔': 'Xiang', '逸': 'Yi', '驰': 'Chi', '骏': 'Jun'
};

// Characters that should be treated as separators / kept as-is in a name.
const SEP = /[\s·.\-]/;

/**
 * Convert a Chinese (or mixed) name to a romanized English string.
 * - Already-ASCII names are returned unchanged.
 * - Unknown CJK characters fall through verbatim (name stays identifiable).
 */
function chineseToPinyin(name) {
  if (!name) return '';
  const s = String(name).trim();
  if (s === '') return '';
  // Already ASCII (contains only latin/punct) -> return as-is
  if (/^[\x00-\x7F]+$/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    if (SEP.test(ch) || /^[\x00-\x7F]$/.test(ch)) {
      out += ch;
      continue;
    }
    out += (MAP[ch] || ch);
  }
  return out.replace(/\s+/g, ' ').trim();
}

module.exports = { chineseToPinyin };

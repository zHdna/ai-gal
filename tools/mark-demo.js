/**
 * 一次性：给设计稿的「演示数据」打 data-demo 标记，并在侧栏插入真实容器 #characterList。
 * 幂等：已改过就跳过。
 */
const fs = require('fs');
const path = require('path');
const MOCK = path.join(__dirname, '..', 'design/mockups/desktop-vn.html');
let s = fs.readFileSync(MOCK, 'utf8');
const before = s;

if (s.includes('id="characterList"')) {
  console.log('已改过，跳过');
  process.exit(0);
}

/* 1. 竖条演示小头像 */
s = s.replace(/<span class="strip-av([^"]*)"/g, '<span class="strip-av$1" data-demo="1"');
/* 2. 标签栏演示标签 */
s = s.replace(/<span class="side-tag([^"]*)"/g, '<span class="side-tag$1" data-demo="1"');
/* 3. 侧栏演示角色卡 */
s = s.replace(/<div class="save-char([^"]*)">/g, '<div class="save-char$1" data-demo="1">');

/* 4. 真实角色列表容器（app.js 会渲染进来） */
const anchor = '<div class="grp">角 色 卡 · 存 档 进 度</div>';
if (!s.includes(anchor)) throw new Error('找不到侧栏分组标签');
s = s.replace(anchor, anchor + '\n            <div class="character-list" id="characterList"></div>');

/* 5. 演示存档面板里那些「预览稿」按钮也标记掉 */
s = s.replace(/(<div class="save-item new"[^>]*)data-toast="预览稿[^"]*"/g, '$1data-demo="1"');

if (s === before) throw new Error('没有任何改动');
fs.writeFileSync(MOCK, s, 'utf8');
console.log('已插入 #characterList，并给',
  (s.match(/data-demo="1"/g) || []).length, '个演示元素打了标');

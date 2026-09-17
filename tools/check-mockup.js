/* 设计稿自检：UTF-8 读取 → 内联脚本语法检查 → HTML 标签配对检查 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
console.log('file bytes(utf8):', Buffer.byteLength(src, 'utf8'));

/* ---- 1. 内联脚本语法检查 ---- */
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('inline scripts:', scripts.length);
scripts.forEach((js, i) => {
  try {
    new Function(js);
    console.log(`  script[${i}] syntax: OK (${js.length} chars)`);
  } catch (e) {
    console.log(`  script[${i}] SYNTAX ERROR: ${e.message}`);
  }
});

/* ---- 2. 标签配对（栈式，忽略 void 元素与注释/脚本内容） ---- */
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'col', 'area', 'base', 'wbr', 'embed', 'track', 'param']);
let html = src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script>[\s\S]*?<\/script>/g, '')
  .replace(/<style>[\s\S]*?<\/style>/g, '');

const stack = [];
const errors = [];
const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
let m;
while ((m = re.exec(html))) {
  const [full, slash, rawName, attrs] = m;
  const name = rawName.toLowerCase();
  if (VOID.has(name) || /\/$/.test(attrs.trim())) continue;
  const line = html.slice(0, m.index).split('\n').length;
  if (!slash) {
    stack.push({ name, line });
  } else {
    if (!stack.length) { errors.push(`L${line}: 多余的 </${name}>`); continue; }
    const top = stack[stack.length - 1];
    if (top.name === name) { stack.pop(); }
    else {
      // 找栈里最近的同名
      const idx = [...stack].reverse().findIndex(s => s.name === name);
      if (idx === -1) { errors.push(`L${line}: </${name}> 没有对应的开标签（栈顶是 <${top.name}> 开于 L${top.line}）`); }
      else {
        const drop = stack.splice(stack.length - idx);
        errors.push(`L${line}: </${name}> 关闭时跨层，以下标签未闭合 → ${drop.map(d => `<${d.name}>(L${d.line})`).join(', ')}`);
      }
    }
  }
}
console.log('未闭合标签:', stack.length ? stack.map(s => `<${s.name}>(L${s.line})`).join(', ') : '无');
console.log('结构问题:', errors.length ? '\n  ' + errors.join('\n  ') : '无');

/* ---- 3. 引用的 id / 关键类是否存在（防止 JS 指向不存在的节点） ---- */
const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]));
const used = new Set([...scripts.join('\n').matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(x => x[1]));
const missing = [...used].filter(i => !ids.has(i));
console.log('JS 引用的 id 共', used.size, '个；缺失:', missing.length ? missing.join(', ') : '无');

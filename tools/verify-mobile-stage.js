/**
 * 移动端演出验证脚本：写入一条含 story + dialog 的 AI 消息，检查逐段演出。
 * 用法：node tools/verify-mobile-stage.js <conversationId> [--cleanup]
 */
'use strict';
const http = require('http');

const BASE = 'http://127.0.0.1:3211';
const convId = process.argv[2];

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const u = new URL(BASE + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {}
    }, res => {
      let buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(buf).toString('utf8') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const SAMPLE = `傍晚的檐廊没有开灯。海风从庭院那头穿过来，把纸门吹得轻轻作响。

示例角色丙：『……那封信，你是从哪里得到的？』

示例角色丁：『哥，别问了。那是妈留下来的东西。』

远处传来渡轮靠岸的汽笛，一声长、一声短。绣球花被风吹得低低的，叶尖还挂着午后那场阵雨的余水。

示例角色丙：『原来你也知道。』
`;

(async () => {
  if (!convId) {
    console.error('缺少 conversationId');
    process.exit(1);
  }
  const r = await req('POST', '/api/messages', {
    conversation_id: convId, role: 'assistant', content: SAMPLE
  });
  console.log('写入消息:', r.status, r.text.slice(0, 120));
})();

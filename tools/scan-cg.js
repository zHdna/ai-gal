// 扫描每个存档：有没有 CG 图片 / 末楼是否含图（用来挑「无 CG 的新存档」验证卡面背景）
const B = 'http://127.0.0.1:3215';
(async () => {
  const convs = await (await fetch(B + '/api/conversations')).json();
  const rows = [];
  for (const c of convs) {
    const r = await (await fetch(B + '/api/messages/conversation/' + c.id)).json();
    const msgs = Array.isArray(r) ? r : (r.messages || []);
    let cgCount = 0, lastCgIdx = -1, imgCount = 0;
    msgs.forEach((m, i) => {
      const t = String(m.content || '');
      const n = (t.match(/cg-image|images\//g) || []).length;
      if (n) { cgCount += n; lastCgIdx = i; }
      imgCount += (t.match(/<img/g) || []).length;
    });
    rows.push({ id: c.id.slice(0, 8), char: (c.character_id || '').slice(0, 8), blocks: msgs.length, cgCount, lastCgIdx, imgCount, title: c.title });
  }
  rows.sort((a, b) => a.cgCount - b.cgCount);
  console.log(JSON.stringify(rows, null, 1));
})();

const fs = require('fs');
const d = fs.readFileSync(process.argv[2] || '.probe-tmp/real-dom.html', 'utf8');
const key = 'id="characterList"';
let from = 0, i, n = 0;
while ((i = d.indexOf(key, from)) >= 0) {
  n++;
  const start = d.lastIndexOf('<', i);
  console.log('--- #characterList #' + n + ' @' + i + ' (shell=' + (i < d.indexOf('id="vnLegacyDom"')) + ') ---');
  console.log(JSON.stringify(d.slice(start, start + 520)));
  console.log();
  from = i + 1;
}
console.log('total #characterList:', n);
console.log('character-item count:', (d.match(/class="character-item[^"]*"/g) || []).length);
console.log('data-demo count:', (d.match(/data-demo="1"/g) || []).length);
console.log('strip-avatar count:', (d.match(/class="strip-avatar[^"]*"/g) || []).length);

const fs = require('fs');
const d = fs.readFileSync(process.argv[2] || '.probe-tmp/real-dom.html', 'utf8');
function show(key, before, after) {
  const i = d.indexOf(key);
  console.log('=== ' + key + ' @' + i + ' ===');
  console.log(JSON.stringify(d.slice(Math.max(0, i - before), i + after)));
  console.log();
}
show('id="vnLegacyDom"', 120, 420);
show('class="messages-area"', 80, 300);
show('story-block', 400, 200);
console.log('dump bytes', d.length);

const fs = require('fs');
const t = JSON.parse(fs.readFileSync(__dirname + '/tape.json', 'utf8'));
const s = JSON.stringify(t);
console.log('keys:', Object.keys(t).join(','), 'bytes:', s.length);
const re = /ZPWTM\|[^"\\]*/g;
const m = s.match(re) || [];
console.log('marks:', m.length);
console.log(m.slice(-45).join('\n'));

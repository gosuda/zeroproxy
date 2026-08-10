// bvsd.min.js 루프 계측 — **모든 for 형태 포함**.
// 앞선 bvsd-instrument.js 는 `while(` 과 `for(;;)` 만 감싸 `for(a;b;c)` 를
// 통째로 빠뜨렸고, 그래서 "루프 0회" 라는 틀린 값을 냈다(함정노트 2026-08-10).
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wtm2-raw.js', 'utf8');

const ID = /[A-Za-z0-9_$]/;
const skipString = (s, i) => {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q) return j;
  }
  return s.length;
};
const regexOk = (prev) => !prev || (!ID.test(prev) && !')]}'.includes(prev));
const skipRegex = (s, i) => {
  let cls = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return i;
    if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) { let k = j + 1; while (k < s.length && ID.test(s[k])) k++; return k - 1; }
  }
  return i;
};
const matchParen = (s, pos) => {
  let d = 0, prev = '';
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); prev = c; continue; }
    if (c === '/' && regexOk(prev)) { const e = skipRegex(s, i); if (e > i) { i = e; prev = '/'; continue; } }
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
};
const forSemis = (s, open, close) => {
  const out = [];
  let d = 0, prev = '';
  for (let i = open; i < close; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); prev = c; continue; }
    if (c === '/' && regexOk(prev)) { const e = skipRegex(s, i); if (e > i) { i = e; prev = '/'; continue; } }
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ';' && d === 1) out.push(i);
    if (!/\s/.test(c)) prev = c;
  }
  return out;
};

const edits = [];
const kinds = [];
let id = 0;
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
  if (!ID.test(c)) continue;
  let j = i;
  while (j < src.length && ID.test(src[j])) j++;
  const word = src.slice(i, j);
  const before = i > 0 ? src[i - 1] : '';
  i = j - 1;
  if (word !== 'while' && word !== 'for') continue;
  if (ID.test(before) || before === '.') continue;
  let k = j;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== '(') continue;
  const close = matchParen(src, k);
  if (close < 0) continue;

  if (word === 'while') {
    edits.push({ at: k + 1, text: `__BW(${id})&&(` });
    edits.push({ at: close, text: ')' });
    kinds.push('while');
    id++;
  } else {
    const semis = forSemis(src, k, close);
    if (semis.length !== 2) continue;          // for-of / for-in
    const bs = semis[0] + 1, be = semis[1];
    if (src.slice(bs, be).trim() === '') {
      edits.push({ at: bs, text: `__BW(${id})` });
    } else {
      edits.push({ at: bs, text: `__BW(${id})&&(` });
      edits.push({ at: be, text: ')' });
    }
    kinds.push('for');
    id++;
  }
}
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

const LIMIT = Number(process.env.BVSD_LIMIT || 300000);
const prelude = `/*ZP_BVSD_LOOPS*/
var __BN=${id},__BC=new Array(__BN).fill(0),__BT0=Date.now(),__Bbusy=false;
var __BnThen=Promise.prototype.then;
function __BS(m){
  if(__Bbusy) return; __Bbusy=true;
  try{ __BnThen.call(fetch('http://127.0.0.1:18099/m?BL|'+encodeURIComponent(m),{mode:'no-cors',keepalive:true}),function(){},function(){}); }catch(e){}
  __Bbusy=false;
}
function __BW(i){
  var c=++__BC[i];
  if(c===1) __BS('enter|'+i+'|t='+(Date.now()-__BT0));
  else if(c%20000===0) __BS('tick|'+i+'|n='+c+'|t='+(Date.now()-__BT0));
  if(c>${LIMIT}){ __BC[i]=0; __BS('CAP|'+i+'|t='+(Date.now()-__BT0)); throw new Error('BVSD_CAP#'+i); }
  return true;
}
__BS('boot|loops=${id}');
`;

fs.writeFileSync(__dirname + '/bvsd-instrumented.js', prelude + out);
console.log('loops=' + id + ' for=' + kinds.filter(k => k === 'for').length + ' while=' + kinds.filter(k => k === 'while').length);

// `27b3366….js` = bvsd.min.js (UMD `nhom…` = nhomz 정의자, 606,914자).
// 루프 21개(`for(;;)`×1, `while(`×20)를 카운터로 감싸고,
// anti-bot 이 47번 쓰는 `toString` 과 `currentScript` 를 계측한다.
// 마커는 저볼륨(첫 1회 + N회마다) — 고볼륨이 관측을 오염시킨 전례가 있다.
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
    else if (c === '/' && !cls) {
      let k = j + 1;
      while (k < s.length && ID.test(s[k])) k++;
      return k - 1;
    }
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

const edits = [];
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
  const head = src.slice(k + 1, close);
  if (word === 'while') {
    edits.push({ at: k + 1, text: `__BW(${id})&&(` });
    edits.push({ at: close, text: ')' });
    id++;
  } else if (head.trim() === ';;') {
    edits.push({ at: k + 2, text: `__BW(${id})` });
    id++;
  }
}
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

const LIMIT = Number(process.env.BVSD_LIMIT || 200000);
const prelude = `/*ZP_BVSD_INSTR*/
var __BN=${id},__BC=new Array(__BN).fill(0),__BT0=Date.now(),__Bbusy=false;
var __BnThen=Promise.prototype.then;
function __BS(m){
  if(__Bbusy) return; __Bbusy=true;
  try{ __BnThen.call(fetch('http://127.0.0.1:18099/m?BVSD|'+encodeURIComponent(m),{mode:'no-cors',keepalive:true}),function(){},function(){}); }catch(e){}
  __Bbusy=false;
}
function __BW(i){
  var c=++__BC[i];
  if(c===1) __BS('loop-enter|'+i+'|t='+(Date.now()-__BT0));
  else if(c%50000===0) __BS('loop-tick|'+i+'|n='+c+'|t='+(Date.now()-__BT0));
  if(c>${LIMIT}){ __BC[i]=0; __BS('LOOP-CAP|'+i+'|t='+(Date.now()-__BT0)); throw new Error('BVSD_LOOP_CAP#'+i); }
  return true;
}
(function(){
  var n={};
  function tick(tag,d){ var c=(n[tag]=(n[tag]||0)+1); if(c===1||c%500===0) __BS(tag+'|n='+c+'|t='+(Date.now()-__BT0)+'|'+String(d||'').slice(0,90)); }
  try{ var ts=Function.prototype.toString;
    Function.prototype.toString=function(){ var r=ts.apply(this,arguments); tick('fn.toString', String(this.name||'?')+'->'+String(r).slice(0,40)); return r; };
  }catch(e){}
  try{ var d=Object.getOwnPropertyDescriptor(Document.prototype,'currentScript');
    if(d&&d.get) Object.defineProperty(Document.prototype,'currentScript',{configurable:true,get:function(){ var v=d.get.call(this); tick('currentScript', v?String(v.src).slice(-50):'NULL'); return v; }});
  }catch(e){}
  __BS('boot|loops=${id}');
})();
`;

fs.writeFileSync(__dirname + '/bvsd-instrumented.js', prelude + out);
console.log('loops=' + id + ' bytes=' + (prelude.length + out.length));

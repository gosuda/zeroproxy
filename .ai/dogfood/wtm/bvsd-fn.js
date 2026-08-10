// 루프가 하나도 안 도는데 굳는다 = 직선 코드 또는 재귀.
// 모든 function 본문 첫머리에 `__BF(id)` 를 넣어 **마지막으로 진입한 함수**와
// **호출 깊이**를 잡는다. 마커는 저볼륨(깊이 임계 + 주기적 스냅샷)만.
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
  if (word !== 'function') continue;
  if (ID.test(before) || before === '.') continue;
  // function [name] (params) {
  let k = j;
  while (k < src.length && /[\s*]/.test(src[k])) k++;
  while (k < src.length && ID.test(src[k])) k++;          // 선택적 이름
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== '(') continue;
  const close = matchParen(src, k);
  if (close < 0) continue;
  let b = close + 1;
  while (b < src.length && /\s/.test(src[b])) b++;
  if (src[b] !== '{') continue;
  edits.push({ at: b + 1, text: `__BF(${id});` });
  id++;
}
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

const prelude = `/*ZP_BVSD_FN*/
var __BFN=${id},__BFd=0,__BFmax=0,__BFlast=-1,__BFn=0,__BFbusy=false,__BFrep=false;
var __BFthen=Promise.prototype.then;
function __BSS(m){
  if(__BFbusy) return; __BFbusy=true;
  try{ __BFthen.call(fetch('http://127.0.0.1:18099/m?BFN|'+encodeURIComponent(m),{mode:'no-cors',keepalive:true}),function(){},function(){}); }catch(e){}
  __BFbusy=false;
}
function __BF(i){
  __BFlast=i;
  if((++__BFn)%2000===0) __BSS('ops|n='+__BFn+'|last='+i+'|depth='+__BFd+'|max='+__BFmax);
}
setTimeout(function(){ __BSS('snap|n='+__BFn+'|last='+__BFlast+'|max='+__BFmax); },1500);
setTimeout(function(){ __BSS('snap2|n='+__BFn+'|last='+__BFlast+'|max='+__BFmax); },4000);
__BSS('boot|fns=${id}');
(function(){ var nx={};
  function t2(tag,d){ var c=(nx[tag]=(nx[tag]||0)+1); if(c===1||c%2000===0) __BSS(tag+'|n='+c+'|fn='+__BFn+'|'+String(d||'').slice(0,70)); }
  try{ var re=RegExp.prototype.exec, rt=RegExp.prototype.test;
    RegExp.prototype.exec=function(s){ t2('re.exec', String(this.source).slice(0,36)+'|len='+String(s).length); return re.apply(this,arguments); };
    RegExp.prototype.test=function(s){ t2('re.test', String(this.source).slice(0,36)+'|len='+String(s).length); return rt.apply(this,arguments); };
  }catch(e){}
  ['replace','match','split'].forEach(function(k){ try{ var f=String.prototype[k]; String.prototype[k]=function(){ t2('str.'+k,'len='+this.length); return f.apply(this,arguments); }; }catch(e){} });
  try{ var jp=JSON.parse; JSON.parse=function(x){ t2('JSON.parse','len='+String(x).length); return jp.apply(this,arguments); }; }catch(e){}
})();
`;

fs.writeFileSync(__dirname + '/bvsd-instrumented.js', prelude + out);
console.log('fns=' + id + ' bytes=' + (prelude.length + out.length));

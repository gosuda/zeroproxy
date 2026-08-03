// WTM wedge 계측기.
// `for(;;)` 는 조건이 빈 = 항상 참이므로 `for(;__ZPW(i);)` 로 바꿔도 의미가 같다.
// 본문이 블록이든 단일 문이든 무관하게 안전한 유일한 지점이라 이 형태를 택했다.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');

const LIMIT = Number(process.env.ZP_LOOP_LIMIT || 3e6);

let i = 0;
const out = src.replace(/for\(;;\)/g, () => `for(;__ZPW(${i++});)`);
if (i !== 19) throw new Error('expected 19 loops, got ' + i);

const prelude = `/*ZP_INSTRUMENTED*/
var __ZPN=${i},__ZPC=new Array(__ZPN).fill(0),__ZPS=new Array(__ZPN).fill(null),__ZPLIM=${LIMIT},__ZPT0=Date.now();
function __ZPFLUSH(tag){
  try{
    var p={tag:tag||'',t:Date.now()-__ZPT0,c:__ZPC,s:__ZPS};
    localStorage.setItem('__zp_wtm',JSON.stringify(p));
  }catch(e){}
}
function __ZPW(i){
  var c=++__ZPC[i];
  if(c===1){ try{__ZPS[i]=String(new Error('enter#'+i).stack).slice(0,1200);}catch(e){} __ZPFLUSH('enter'+i); }
  else if(c%500000===0){ __ZPFLUSH('tick'+i); }
  if(c>__ZPLIM){ __ZPC[i]=0; __ZPFLUSH('CAP'+i); throw new Error('ZP_LOOP_CAP#'+i); }
  return true;
}
try{localStorage.removeItem('__zp_wtm');}catch(e){}
__ZPFLUSH('boot');
`;

fs.writeFileSync(__dirname + '/wtm-instrumented.js', prelude + out);
console.log('loops=' + i + ' limit=' + LIMIT + ' bytes=' + (prelude.length + out.length));

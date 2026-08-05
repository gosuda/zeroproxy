// v2: 모든 루프 형태(`for(A;B;C)`, `while(X)`, `do..while(X)`)에 카운터를 건다.
// v1(`for(;;)` 19개)은 최대 3회만 돌았으므로 폭주 루프는 다른 형태에 있거나 없다.
//
// 텍스트 변환이지만 문자열/정규식 리터럴을 건너뛰는 스캐너로 괄호를 맞추고,
// 최종적으로 `node --check` 로 문법을 검증한다.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');

const ID = /[A-Za-z0-9_$]/;

// `/` 가 나눗셈인지 정규식 시작인지 판별하기 위한 직전 유의미 문자.
function regexAllowedAfter(prev) {
  if (!prev) return true;
  if (ID.test(prev)) return false;
  return !')]}'.includes(prev);
}

// pos = '(' 의 인덱스. 짝이 맞는 ')' 인덱스를 반환.
function matchParen(s, pos) {
  let depth = 0, prev = '';
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i);
      prev = c;
      continue;
    }
    if (c === '/' && regexAllowedAfter(prev)) {
      const end = skipRegex(s, i);
      if (end > i) { i = end; prev = '/'; continue; }
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q) return j;
  }
  return s.length;
}

function skipRegex(s, i) {
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return i; // 정규식이 아니었다
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < s.length && ID.test(s[k])) k++;
      return k - 1;
    }
  }
  return i;
}

// for 헤더의 top-level `;` 두 개를 찾는다.
function forSemis(s, open, close) {
  const out = [];
  let depth = 0, prev = '';
  for (let i = open; i < close; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); prev = c; continue; }
    if (c === '/' && regexAllowedAfter(prev)) {
      const end = skipRegex(s, i);
      if (end > i) { i = end; prev = '/'; continue; }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 1) out.push(i);
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

const edits = [];
let id = 0;
const kinds = [];

for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
  if (!ID.test(c)) continue;
  let j = i;
  while (j < src.length && ID.test(src[j])) j++;
  const word = src.slice(i, j);
  const before = i > 0 ? src[i - 1] : '';
  i = j - 1;
  if (word !== 'for' && word !== 'while') continue;
  if (ID.test(before) || before === '.') continue;
  let k = j;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== '(') continue;
  const close = matchParen(src, k);
  if (close < 0) continue;

  if (word === 'while') {
    // while(X) → while(__ZPW(id)&&(X))
    edits.push({ at: k + 1, text: `__ZPW(${id})&&(` });
    edits.push({ at: close, text: ')' });
    kinds.push('while');
    id++;
  } else {
    const semis = forSemis(src, k, close);
    if (semis.length !== 2) continue; // for-of 1개뿐 — 변환 위험 대비 이득 없음
    // for(A;B;C) → for(A;__ZPW(id)&&(B||1===1&&false||true),__ZPW2:  단순화
    // B 가 비어 있으면(=for(;;)) 그냥 __ZPW(id) 로, 아니면 __ZPW(id)&&(B).
    const bodyStart = semis[0] + 1, bodyEnd = semis[1];
    const cond = src.slice(bodyStart, bodyEnd).trim();
    if (cond === '') {
      edits.push({ at: bodyStart, text: `__ZPW(${id})` });
    } else {
      edits.push({ at: bodyStart, text: `__ZPW(${id})&&(` });
      edits.push({ at: bodyEnd, text: ')' });
    }
    kinds.push('for');
    id++;
  }
}

edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

const LIMIT = Number(process.env.ZP_LOOP_LIMIT || 2e6);
const prelude = `/*ZP_INSTRUMENTED_V2*/
var __ZPN=${id},__ZPC=new Array(__ZPN).fill(0),__ZPS=new Array(__ZPN).fill(null),__ZPLIM=${LIMIT},__ZPT0=Date.now(),__ZPLAST=-1;
var __ZPnThen=Promise.prototype.then;
function __ZPSINK(m){ try{ var u='http://127.0.0.1:18099/m?'+encodeURIComponent(m); if(typeof fetch==='function') __ZPnThen.call(fetch(u,{mode:'no-cors',keepalive:true}),function(){},function(){}); else new Image().src=u; }catch(e){} }
function __ZPFLUSH(tag){
  __ZPSINK('F|'+(tag||'')+'|t='+(Date.now()-__ZPT0)+'|last='+__ZPLAST);
}
function __ZPG(i,it){ return { [Symbol.iterator]: function(){ var inner = (it && it[Symbol.iterator]) ? it[Symbol.iterator]() : it; return { next: function(){ __ZPW(i); return inner.next(); }, return: function(v){ return inner.return ? inner.return(v) : {done:true,value:v}; } }; } }; }
function __ZPW(i){
  __ZPLAST=i;
  var c=++__ZPC[i]; __ZPTICK();
  if(c===1){ __ZPSINK('E|'+i+'|t='+(Date.now()-__ZPT0)); }
  if(c%50000===0){ __ZPFLUSH('tick'+i); }
  if(c>__ZPLIM){ __ZPC[i]=0; __ZPFLUSH('CAP'+i); throw new Error('ZP_LOOP_CAP#'+i); }
  return true;
}
function __ZPDOM(){
  try{
    var all=document.getElementsByTagName('*'), n=all.length, dmax=0;
    for(var i=0;i<n;i+=Math.max(1,Math.floor(n/300))){ var e=all[i],d=0; while(e&&d<500){ e=e.parentNode; d++; } if(d>dmax) dmax=d; }
    return 'nodes='+n+'|depth='+dmax+'|style='+document.getElementsByTagName('style').length+'|link='+document.getElementsByTagName('link').length+'|ifr='+document.getElementsByTagName('iframe').length+'|svg='+document.getElementsByTagName('svg').length;
  }catch(e){ return 'err'; }
}
var __hbN=0;
setInterval(function(){ __ZPFLUSH('hb'); if((++__hbN)%5===0) __ZPSINK('DOM|t='+(Date.now()-__ZPT0)+'|'+__ZPDOM()); },20);
var __zprafn=0;(function raf(){ try{ requestAnimationFrame(function(){ __ZPSINK('RAF|'+(++__zprafn)+'|t='+(Date.now()-__ZPT0)); raf(); }); }catch(e){} })();
// v3: 루프가 아니라 **동기 블로킹**이 의심된다(하트비트조차 안 뜀).
// 메인 스레드를 멈출 수 있는 API 를 호출 직전/직후로 감싸 마지막 흔적을 남긴다.
var __ZPMARKS=[],__ZPOPS=0,__ZPTHEN=0;
function __ZPTICK(){ if((++__ZPOPS)%20000===0) __ZPSINK('OPS|'+__ZPOPS+'|then='+__ZPTHEN+'|t='+(Date.now()-__ZPT0)+'|last='+__ZPLAST); }
function __ZPM(m){ __ZPTICK();
  // 정규식을 쓰면 안 된다: RegExp.prototype.test 가 계측 대상이라 무한 재귀한다.
  var keep=['iframe','wasm','xhr','alert','atomics','write','beacon'];
  for(var q=0;q<keep.length;q++){ if(m.indexOf(keep[q])>=0){ __ZPSINK('M|'+(Date.now()-__ZPT0)+'|'+m); return; } } }
(function(){
  var g=globalThis;
  function wrap(obj,name,tag){
    try{
      var f=obj[name]; if(typeof f!=='function') return;
      obj[name]=function(){
        var d=''; try{ d=Array.prototype.slice.call(arguments,0,3).map(function(a){return String(a).slice(0,60)}).join('|'); }catch(e){}
        __ZPM('>'+tag+'('+d+')');
        try{ var r=f.apply(this,arguments); __ZPM('<'+tag); return r; }
        catch(e){ __ZPM('!'+tag+':'+String(e&&e.message).slice(0,80)); throw e; }
      };
    }catch(e){}
  }
  ['alert','confirm','prompt','print'].forEach(function(n){ wrap(g,n,n); });
  try{ wrap(g.XMLHttpRequest.prototype,'open','xhr.open'); wrap(g.XMLHttpRequest.prototype,'send','xhr.send'); }catch(e){}
  try{ wrap(g.document,'write','doc.write'); wrap(g.document,'writeln','doc.writeln'); }catch(e){}
  try{ ['compile','compileStreaming','instantiate','instantiateStreaming','validate'].forEach(function(n){ wrap(g.WebAssembly,n,'wasm.'+n); }); }catch(e){}
  try{ wrap(g.Atomics,'wait','atomics.wait'); }catch(e){}
  try{ wrap(g,'importScripts','importScripts'); }catch(e){}
  try{ wrap(g.navigator,'sendBeacon','beacon'); }catch(e){}
  try{ wrap(g.Worker&&g.Worker.prototype,'postMessage','worker.post'); }catch(e){}
  try{ wrap(g.crypto&&g.crypto.subtle,'digest','subtle.digest'); }catch(e){}







  // v13: RIP 히스토그램이 LayoutNG PhysicalFragment 삽입 + major GC 를 짚었다.
  // 레이아웃 축을 집계형으로 계측한다: 관찰자 콜백, resize/scroll 발화,
  // 강제 동기 레이아웃 유발자(offsetWidth/gBCR/getComputedStyle).
  try{
    var LC={ro:0,io:0,rz:0,sc:0,fl:0};
    var __lcBusy=false;
    function lcTick(k){
      LC[k]++;
      var tot=LC.ro+LC.io+LC.rz+LC.sc+LC.fl;
      if(tot===1||tot%20000===0){ if(__lcBusy) return; __lcBusy=true;
        __ZPSINK("LAY|ro="+LC.ro+"|io="+LC.io+"|rz="+LC.rz+"|sc="+LC.sc+"|fl="+LC.fl+"|t="+(Date.now()-__ZPT0));
        __lcBusy=false; }
    }
    [["ResizeObserver","ro"],["IntersectionObserver","io"]].forEach(function(pair){
      var N=g[pair[0]], key=pair[1]; if(typeof N!=="function") return;
      function W(cb,opt){ return Reflect.construct(N,[function(){ lcTick(key); return cb.apply(this,arguments); },opt], new.target||W); }
      W.prototype=N.prototype; try{ Object.setPrototypeOf(W,N); }catch(e){}
      g[pair[0]]=W;
    });
    var ael=g.EventTarget.prototype.addEventListener;
    g.EventTarget.prototype.addEventListener=function(t,f,o){
      if((t==="resize"||t==="scroll") && typeof f==="function"){
        var key=(t==="resize")?"rz":"sc";
        return ael.call(this,t,function(){ lcTick(key); return f.apply(this,arguments); },o);
      }
      return ael.apply(this,arguments);
    };
    // 강제 동기 레이아웃 유발자
    var ep=g.Element.prototype, gb=ep.getBoundingClientRect;
    if(gb) ep.getBoundingClientRect=function(){ lcTick("fl"); return gb.apply(this,arguments); };
    var gcs=g.getComputedStyle;
    if(gcs) g.getComputedStyle=function(){ lcTick("fl"); return gcs.apply(this,arguments); };
    ["offsetWidth","offsetHeight","clientWidth","clientHeight"].forEach(function(n){
      var hp=g.HTMLElement.prototype, d=Object.getOwnPropertyDescriptor(hp,n)||Object.getOwnPropertyDescriptor(g.Element.prototype,n);
      if(!d||!d.get) return; var og=d.get;
      try{ Object.defineProperty(hp,n,{configurable:true,enumerable:d.enumerable,get:function(){ lcTick("fl"); return og.call(this); }}); }catch(e){}
    });
  }catch(e){}

  // v12: 마지막 미측정 축 = 마이크로태스크 체인. 루프 카운터에도 재귀 깊이에도
  // 안 잡히면서 이벤트 루프를 굶긴다. 이전 시도는 sink 의 .catch 가 이 래퍼를
  // 다시 타서 무한재귀했다 — 이번엔 __ZPnThen(네이티브)만 쓴다.
  try{
    var __zpThenN=0, __zpQN=0;
    Promise.prototype.then=function(){
      var c=++__zpThenN;
      if(c===1||c%20000===0) __ZPSINK("THEN|n="+c+"|q="+__zpQN+"|t="+(Date.now()-__ZPT0));
      return __ZPnThen.apply(this,arguments);
    };
    if(typeof g.queueMicrotask==="function"){
      var qm=g.queueMicrotask;
      g.queueMicrotask=function(f){
        var c=++__zpQN;
        if(c===1||c%20000===0) __ZPSINK("QMT|n="+c+"|t="+(Date.now()-__ZPT0));
        return qm.apply(this,arguments);
      };
    }
  }catch(e){}

  // v11: WASM 경계도 아니었다. 리라이트된 코드의 **모든** 프로퍼티 접근이
  // 지나는 멤브레인 헬퍼(__zp_get/__zp_set/__zp_call/...)의 호출 깊이를 센다.
  try{
    var __zpHD=0, __zpHMax=0, __zpHRep=false;
    ["__zp_get","__zp_set","__zp_call","__zp_assign","__zp_update","__zp_construct","__zp_has"].forEach(function(n){
      var f=g[n]; if(typeof f!=="function") return;
      g[n]=function(){
        var d=++__zpHD;
        if(d>__zpHMax){ __zpHMax=d;
          if(d===50||d===200||d===600) __ZPSINK("HD|"+d+"|"+n+"|t="+(Date.now()-__ZPT0));
          if(d>900 && !__zpHRep){ __zpHRep=true;
            var st=""; try{ st=String(new Error("deep").stack).slice(0,900); }catch(e){}
            __ZPSINK("HDEEP|"+d+"|"+n+"|"+st); } }
        try{ return f.apply(this,arguments); } finally { __zpHD--; }
      };
    });
  }catch(e){}

  // v9: 스핀 프로필이 StackFrameIterator/CaptureSimpleStackTrace/AddDataProperty/
  // young GC = **Error 폭풍**이다. 누가 만드는지 잡는다.
  // 주의: 엔진이 던지는 TypeError(Proxy 불변식 위반 등)는 전역 생성자를 안 거치므로
  // Error.prepareStackTrace 로 .stack 접근도 따로 센다(모든 에러에 대해 호출됨).
  try{
    var __zpErrN=0, __zpErrSample=null, __zpErrBusy=false;
    function __zpErrTick(){
      var c=++__zpErrN;
      if(c===1||c%20000===0){
        if(__zpErrBusy) return; __zpErrBusy=true;
        var st=""; try{ st=String(__zpNativeErr.prototype.stack||""); }catch(e){}
        try{ st=__zpErrSample||""; }catch(e){}
        __ZPSINK("ERR|n="+c+"|t="+(Date.now()-__ZPT0)+"|"+String(st).slice(0,600));
        __zpErrBusy=false;
      }
    }
    var __zpNativeErr=g.Error;
    ["Error","TypeError","RangeError","ReferenceError","SyntaxError","EvalError","URIError"].forEach(function(n){
      var N=g[n]; if(typeof N!=="function") return;
      function W(){
        var e=Reflect.construct(N, arguments, new.target||W);
        try{ if(__zpErrN===0||(__zpErrN+1)%20000===0) __zpErrSample=n+": "+String(arguments[0]).slice(0,80)+" @ "+String(e.stack).slice(0,300); }catch(x){}
        __zpErrTick();
        return e;
      }
      W.prototype=N.prototype; try{ Object.setPrototypeOf(W,N); }catch(x){}
      g[n]=W;
    });
    // .stack 접근 계수 (엔진 throw 포함). 반환값은 기본 포맷을 흉내낸다.
    var __zpPrepN=0;
    g.Error.prepareStackTrace=function(err,frames){
      var c=++__zpPrepN;
      if(c===1||c%20000===0){
        var top=""; try{ top=frames.slice(0,4).map(function(f){return String(f)}).join(" | "); }catch(e){}
        __ZPSINK("STK|n="+c+"|t="+(Date.now()-__ZPT0)+"|"+String(err).slice(0,60)+" @ "+top.slice(0,500));
      }
      var out=String(err); try{ for(var i=0;i<frames.length;i++) out+=String.fromCharCode(10)+"    at "+frames[i]; }catch(e){}
      return out;
    };
  }catch(e){}

  // v8: JS/WASM 이 전부 반환했는데 네이티브가 스핀한다. JS 없이 CPU 를 태우는
  // Blink 경로 중 anti-bot 이 반드시 쓰는 것: canvas 래스터화 / 텍스트 측정 /
  // 폰트 로딩. 크기 인자를 같이 찍어 비정상 값(가상화된 screen/DPR 유래)을 본다.
  try{
    var cproto=g.HTMLCanvasElement && g.HTMLCanvasElement.prototype;
    if(cproto){
      ["toDataURL","toBlob","getContext"].forEach(function(n){
        var f=cproto[n]; if(typeof f!=="function") return;
        cproto[n]=function(){ __ZPSINK("CV>"+n+"|"+this.width+"x"+this.height+"|t="+(Date.now()-__ZPT0));
          var r=f.apply(this,arguments); __ZPSINK("CV<"+n+"|t="+(Date.now()-__ZPT0)); return r; };
      });
    }
    var ctxp=g.CanvasRenderingContext2D && g.CanvasRenderingContext2D.prototype;
    if(ctxp){
      ["getImageData","putImageData","measureText","fillText","strokeText","drawImage"].forEach(function(n){
        var f=ctxp[n]; if(typeof f!=="function") return;
        ctxp[n]=function(){ var a=arguments;
          __ZPSINK("CV>"+n+"|"+(a[2]||0)+"x"+(a[3]||0)+"|t="+(Date.now()-__ZPT0));
          var r=f.apply(this,a); __ZPSINK("CV<"+n+"|t="+(Date.now()-__ZPT0)); return r; };
      });
    }
    if(g.document.fonts && g.document.fonts.load){
      var fl=g.document.fonts.load;
      g.document.fonts.load=function(){ __ZPSINK("FONT>"+String(arguments[0]).slice(0,50)+"|t="+(Date.now()-__ZPT0)); return fl.apply(this,arguments); };
    }
  }catch(e){}

  // v7: 이 번들은 __table.get(ptr) 로 WASM 함수를 꺼내 DOM 이벤트 리스너로
  // 등록한다 — exports 를 안 거치므로 위 래퍼가 못 본다. 유일하게 남은 구멍.
  try{
    var tget=g.WebAssembly.Table.prototype.get;
    g.WebAssembly.Table.prototype.get=function(i){
      var f=tget.call(this,i);
      if(typeof f!=='function') return f;
      var w=function(){ __ZPSINK('TBL>'+i+'|t='+(Date.now()-__ZPT0));
        try{ var r=f.apply(this,arguments); __ZPSINK('TBL<'+i+'|t='+(Date.now()-__ZPT0)); return r; }
        catch(e){ __ZPSINK('TBL!'+i+'|'+String(e&&e.message).slice(0,60)); throw e; } };
      return w;
    };
  }catch(e){}

  // v6: minidump 3샘플의 스택 공통 프레임이 0개 = 한 루프가 아니라 계속 다른
  // 코드를 실행 중이다. 우리 계측이 닿지 않는 realm 이 있다면 iframe 뿐이다
  // (직접 로드 체인: 3e66…js → .wasm → iframe.html).
  try{
    var ce=g.document.createElement;
    g.document.createElement=function(n){
      var el=ce.apply(this,arguments);
      try{ if(/^i?frame$/i.test(String(n))) __ZPM('iframe:create'); }catch(e){}
      return el;
    };
    var sa=g.Element.prototype.setAttribute;
    g.Element.prototype.setAttribute=function(k,v){
      try{ if(/^i?frame$/i.test(this.tagName)&&/^src$/i.test(String(k))) __ZPM('iframe:src='+String(v).slice(0,90)); }catch(e){}
      return sa.apply(this,arguments);
    };
    var ac=g.Node.prototype.appendChild;
    g.Node.prototype.appendChild=function(c){
      try{ if(c&&/^i?frame$/i.test(c.tagName||'')) __ZPM('iframe:append='+String(c.src||'').slice(0,90)); }catch(e){}
      return ac.apply(this,arguments);
    };
  }catch(e){}

  // v5: 렌더러가 풀코어로 스핀하는데 231개 JS 루프 카운터가 전혀 안 움직인다.
  // JS 루프 밖에서 CPU 를 태우는 대표적 경로가 **정규식 파국적 백트래킹**이다
  // (V8 regex 엔진 = 네이티브 코드라 JS 계측에 안 잡힌다).
  // 프록시에서만 길이/모양이 달라지는 입력(프록시 URL, toString 결과 등)을
  // 물면 직접 로드에서는 멀쩡하고 프록시에서만 터진다 — 증상과 정확히 맞는다.
  try{
    var reExec=RegExp.prototype.exec, reTest=RegExp.prototype.test, __ren=0;
    function reMark(self,input){
      var id=++__ren;
      __ZPM('>re#'+id+'|'+String(self.source).slice(0,70)+'|len='+String(input).length);
      return id;
    }
    RegExp.prototype.exec=function(s){ var id=reMark(this,s); var r=reExec.call(this,s); __ZPM('<re#'+id); return r; };
    RegExp.prototype.test=function(s){ var id=reMark(this,s); var r=reTest.call(this,s); __ZPM('<re#'+id); return r; };
    ['match','matchAll','replace','replaceAll','search','split'].forEach(function(n){
      var f=String.prototype[n]; if(typeof f!=='function') return;
      String.prototype[n]=function(){
        var p=arguments[0];
        var id=++__ren;
        __ZPM('>str.'+n+'#'+id+'|'+String(p&&p.source||p).slice(0,70)+'|len='+this.length);
        var r=f.apply(this,arguments);
        __ZPM('<str.'+n+'#'+id);
        return r;
      };
    });
  }catch(e){}

  // v4: JS 루프도, 위 블로킹 API 도 아니었다. 남은 동기 블로킹 지점은
  // WASM export 호출이다(2026-06-01 debugger 스냅샷의 \`$_start\`).
  // \`exports\` 는 WebAssembly.Instance.prototype 의 접근자라 인스턴스에
  // own 데이터 프로퍼티를 심으면 가려진다.
  function wrapInstance(inst){
    try{
      var ex=inst&&inst.exports; if(!ex) return inst;
      var proxied={};
      Object.keys(ex).forEach(function(k){
        var v=ex[k];
        if(typeof v==='function'){
          proxied[k]=function(){
            __ZPM('>wasm:'+k);
            try{ var r=v.apply(this,arguments); __ZPM('<wasm:'+k); return r; }
            catch(e){ __ZPM('!wasm:'+k+':'+String(e&&e.message).slice(0,60)); throw e; }
          };
        } else proxied[k]=v;
      });
      Object.defineProperty(inst,'exports',{value:proxied,configurable:true});
      __ZPM('wasm:wrapped:'+Object.keys(ex).length);
    }catch(e){ __ZPM('wasm:wrapfail:'+String(e&&e.message).slice(0,60)); }
    return inst;
  }
  function hookResult(r){
    try{
      if(!r) return r;
      if(r.instance) wrapInstance(r.instance);
      else if(r.exports) wrapInstance(r);
    }catch(e){}
    return r;
  }
    // v10: 재귀 지점 특정. 이 번들은 asdom 바인딩이라 WASM import 로
    // location 의 href/protocol/host/... 를 직접 호출한다. JS<->WASM 경계의
    // 호출 깊이를 세서 폭주 재귀가 이 경계를 지나는지 본다.
    var __zpImpDepth=0, __zpImpMax=0, __zpImpRep=false;
    function wrapImports(io){
      try{
        if(!io||typeof io!=="object") return io;
        Object.keys(io).forEach(function(ns){
          var m=io[ns]; if(!m||typeof m!=="object") return;
          Object.keys(m).forEach(function(k){
            var f=m[k]; if(typeof f!=="function") return;
            m[k]=function(){
              var d=++__zpImpDepth;
              if(d>__zpImpMax){ __zpImpMax=d;
                if(d===50||d===200||d===600){ __ZPSINK("IMPD|"+d+"|"+ns+"."+k+"|t="+(Date.now()-__ZPT0)); }
                if(d>800 && !__zpImpRep){ __zpImpRep=true;
                  var st=""; try{ st=String(new Error("deep").stack).slice(0,700); }catch(e){}
                  __ZPSINK("IMPDEEP|"+d+"|"+ns+"."+k+"|"+st); }
              }
              try{ return f.apply(this,arguments); } finally { __zpImpDepth--; }
            };
          });
        });
      }catch(e){}
      return io;
    }
  try{
    ['instantiate','instantiateStreaming'].forEach(function(n){
      var f=g.WebAssembly[n];
      g.WebAssembly[n]=function(){
        try{ if(arguments[1]) wrapImports(arguments[1]); }catch(e){}
        var p=f.apply(this,arguments);
        return (p&&typeof p.then==='function')?p.then(hookResult):hookResult(p);
      };
    });
    var NI=g.WebAssembly.Instance;
    g.WebAssembly.Instance=function(){
      var inst=Reflect.construct(NI,arguments,g.WebAssembly.Instance);
      return wrapInstance(inst);
    };
    g.WebAssembly.Instance.prototype=NI.prototype;
  }catch(e){}
})();
try{localStorage.removeItem('__zp_wtm2');}catch(e){}
__ZPFLUSH('boot');
`;

fs.writeFileSync(__dirname + '/wtm-instrumented.js', prelude + out);
console.log('forof=' + kinds.filter(k=>k==='forof').length + ' loops=' + id + ' for=' + kinds.filter(k => k === 'for').length + ' while=' + kinds.filter(k => k === 'while').length + ' bytes=' + (prelude.length + out.length));

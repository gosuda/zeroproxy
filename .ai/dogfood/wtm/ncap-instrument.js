// ncaptcha-api.js(9.5KB, 난독화) 용 계측본 생성.
// 정적 스캔은 문자열 디코더 때문에 무력하므로, 런타임에 self-discovery 표면을
// 감싸 "무엇을 읽고 무엇을 못 찾는가" 를 본다.
// 마커는 저볼륨(첫 1회 + 200회마다)이어야 한다 — 고볼륨이 트레이스를 오염시킨 전례.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ncap-raw.js', 'utf8');

const prelude = `/*ZP_NCAP_INSTR*/
(function(){
  var T0=Date.now(), n={}, busy=false;
  var nThen=Promise.prototype.then;
  function sink(m){
    if(busy) return; busy=true;
    try{ nThen.call(fetch('http://127.0.0.1:18099/m?NCAP|'+encodeURIComponent(m),{mode:'no-cors',keepalive:true}),function(){},function(){}); }catch(e){}
    busy=false;
  }
  function tick(tag, detail){
    var c=(n[tag]=(n[tag]||0)+1);
    if(c===1||c%200===0) sink(tag+'|n='+c+'|t='+(Date.now()-T0)+'|'+String(detail||'').slice(0,110));
  }
  try{
    var d=Object.getOwnPropertyDescriptor(Document.prototype,'currentScript');
    if(d&&d.get){ Object.defineProperty(Document.prototype,'currentScript',{configurable:true,get:function(){
      var v=d.get.call(this); tick('currentScript', v?('src='+String(v.src).slice(-60)):'NULL'); return v; }}); }
  }catch(e){}
  ['querySelector','querySelectorAll'].forEach(function(k){
    try{ var f=Document.prototype[k]; Document.prototype[k]=function(sel){ tick('doc.'+k, sel); return f.apply(this,arguments); }; }catch(e){}
  });
  try{ var g=Document.prototype.getElementsByTagName;
    Document.prototype.getElementsByTagName=function(t){ var r=g.apply(this,arguments); tick('getByTag', String(t)+'->'+(r?r.length:'?')); return r; };
  }catch(e){}
  try{ var ga=Element.prototype.getAttribute;
    Element.prototype.getAttribute=function(k){ var v=ga.apply(this,arguments); tick('getAttr', String(k)+'='+String(v).slice(0,50)); return v; };
  }catch(e){}
  try{ var sd=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');
    if(sd&&sd.get){ Object.defineProperty(HTMLScriptElement.prototype,'src',{configurable:true,set:sd.set,get:function(){
      var v=sd.get.call(this); tick('script.src', String(v).slice(-70)); return v; }}); }
  }catch(e){}
  sink('boot');
})();
`;

fs.writeFileSync(__dirname + '/ncap-instrumented.js', prelude + src);
console.log('bytes=' + (prelude.length + src.length));

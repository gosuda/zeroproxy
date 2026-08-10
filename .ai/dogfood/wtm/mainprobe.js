// 메인 번들(3e66f2) 앞에 **환경 프로브**를 붙인다. 번들 자체는 그대로 실행된다.
//
// 노리는 것: webpack publicPath 유도부가 보는 값.
//   n.p = document.currentScript.src 의 디렉터리
//   wasm URL = n.p + "353dfc48bf11b066595a.wasm"
// 실브라우저는 이 wasm 을 받는데 프록시에서는 **요청조차 없다**. 그래서
// currentScript / src / WebAssembly / fetch 가 무엇으로 보이는지 직접 찍는다.
//
// 회수는 DOM 속성 — exec-js 는 멤브레인 밖이라 페이지 전역이 안 보인다.
const fs = require('fs');
const raw = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');

const probe = `/*ZP_MAIN_PROBE*/
(function(){
  function put(k,v){ try{ document.documentElement.setAttribute(k, typeof v==='string'?v:JSON.stringify(v)); }catch(e){} }
  var info={};
  try{
    var cs=document.currentScript;
    info.hasCurrentScript=!!cs;
    info.tagName=cs&&cs.tagName;
    info.src=cs&&cs.src;
    info.getAttrSrc=cs&&cs.getAttribute&&cs.getAttribute('src');
    // 번들이 쓰는 유도식을 그대로 재현한다.
    var t=cs&&cs.src;
    if(t){ info.publicPath=String(t).replace(/^blob:/,'').replace(/#.*$/,'').replace(/\\?.*$/,'').replace(/\\/[^\\/]+$/,'/'); }
    var scr=document.getElementsByTagName('script');
    info.scriptCount=scr.length;
    info.lastSrcs=[].slice.call(scr,-3).map(function(s){return String(s.src||'').slice(0,90);});
    info.typeofWebAssembly=typeof WebAssembly;
    info.instantiateStreaming=typeof (window.WebAssembly&&WebAssembly.instantiateStreaming);
    info.instantiate=typeof (window.WebAssembly&&WebAssembly.instantiate);
    info.compileStreaming=typeof (window.WebAssembly&&WebAssembly.compileStreaming);
    info.typeofFetch=typeof fetch;
  }catch(e){ info.err=String(e&&e.message||e); }
  put('data-wtmpp', info);

  // wasm 요청 시도를 잡는다. 요청이 아예 없는 건지, 나갔다가 실패하는 건지 구분.
  var wasmLog=[];
  function note(kind,arg,extra){
    try{ wasmLog.push(kind+'|'+String(arg).slice(0,120)+(extra?'|'+extra:'')); put('data-wtmwasm', wasmLog); }catch(e){}
  }
  try{
    var nf=window.fetch;
    window.fetch=function(u){
      try{ if(/\\.wasm/.test(String(u&&u.url||u))) note('fetch', u&&u.url||u); }catch(e){}
      return nf.apply(this, arguments);
    };
  }catch(e){ note('hookfetch-failed', e && e.message); }
  ['instantiateStreaming','compileStreaming','instantiate','compile'].forEach(function(m){
    try{
      if(!window.WebAssembly||typeof WebAssembly[m]!=='function') { note('missing', m); return; }
      var orig=WebAssembly[m];
      WebAssembly[m]=function(){
        note('WA.'+m, (arguments[0]&&arguments[0].url)||typeof arguments[0]);
        try{
          var p=orig.apply(WebAssembly, arguments);
          if(p&&p.then) p.then(function(){note('WA.'+m+'-ok','');},function(e){note('WA.'+m+'-REJECT', e&&e.message);});
          return p;
        }catch(e){ note('WA.'+m+'-THROW', e&&e.message); throw e; }
      };
    }catch(e){ note('hook-failed', m+' '+(e&&e.message)); }
  });
})();
`;

fs.writeFileSync(__dirname + '/main-probe.js', probe + raw);
console.log('main-probe.js = ' + (probe.length + raw.length) + ' bytes');

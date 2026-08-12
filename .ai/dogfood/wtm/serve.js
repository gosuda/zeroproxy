// 계측/원본 파일 제공 + 마커 수집.
// 경로별로 다른 파일을 준다 — 예전엔 어떤 경로든 같은 파일을 줘서
// "wtm 의 모든 .js 가 같은 번들로 대체" 되는 치명적 혼선을 만들었다(2026-08-10).
const http = require('http');
const fs = require('fs');
const D = __dirname + '/';
const marks = D + 'marks.log';

const FILES = {
  '/main': 'wtm-raw.js',            // 3e66f2… 원본
  '/second': 'bvsd-instrumented.js',         // 27b3366… 원본
  '/ncap.js': 'ncap-instrumented.js',
  '/zp-dev-wtm.js': 'wtm-instrumented.js',
};

// 히트 로그 — **페이지와 무관한 채널**. 마커가 한 건도 안 오던 빌드에서
// "싱크가 쓰였는가" 를 페이지 쪽 신호로 판정하려다 세 번 틀렸다(2026-08-10).
// 서버가 직접 기록하면 렌더러가 굳어도 남는다.
http.createServer((req, res) => {
  try { fs.appendFileSync(D + 'hits.log', Date.now() + ' ' + req.url.split('?')[0] + '\n'); } catch {}
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  };
  if (req.url.startsWith('/m?')) {
    try { fs.appendFileSync(marks, Date.now() + ' ' + decodeURIComponent(req.url.slice(3)) + '\n'); } catch {}
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('ok');
  }
  const path = req.url.split('?')[0];
  // 리라이트 배수 측정용 페이지. 프록시로 이걸 열면 inline script 가
  // zp-htmltx → zp-rewriter 를 타므로, "리라이트된 코드가 쓸 수 있는 재귀 깊이" 를
  // NAVER 와 무관하게 잴 수 있다. 같은 코드를 exec-js(리라이트 없음)로도 재서 비교.
  if (path === '/probe.html') {
    // 두 형태를 잰다. plain 은 리라이터가 손대지 않아 배수가 1이고,
    // member 는 `o.g()` → `__zp_call(__zp_get(...))` 로 프레임이 늘어난다.
    // 실제 SDK 코드는 거의 전부 member 형태다.
    // (a) 재귀 깊이 (b) **identity 안정성**.
    // (b) 가 핵심 가설: 같은 객체를 읽을 때마다 다른 래퍼가 나오면, 객체 그래프를
    // 재귀 순회하는 코드의 `seen` 집합이 무력화돼 종료하지 못하고 스택을 넘긴다.
    // 그러면 "스택 오버플로 3,228회 vs 직접 2회" 가 설명된다.
    // inline script 라서 zp-htmltx→zp-rewriter 를 타고, 그래야 __zp_get 이 돈다.
    const html = '<!doctype html><meta charset=utf-8><title>zp probe</title><body><script>'
      + 'var dp=0; function gp(){ dp++; gp(); } try{ gp(); }catch(e){}'
      + 'var o={}; var dm=0; o.g=function(){ dm++; o.g(); }; try{ o.g(); }catch(e){}'
      + 'function id(f){ try{ return f()===f(); }catch(e){ return "ERR:"+e.message; } }'
      + 'var ids = {'
      + '  top:        id(function(){ return window.top; }),'
      + '  parent:     id(function(){ return window.parent; }),'
      + '  self:       id(function(){ return window.self; }),'
      + '  location:   id(function(){ return window.location; }),'
      + '  defaultView:id(function(){ return document.defaultView; }),'
      + '  docLoc:     id(function(){ return document.location; }),'
      + '  body:       id(function(){ return document.body; }),'
      + '  navigator:  id(function(){ return window.navigator; }),'
      + '  history:    id(function(){ return window.history; }),'
      + '  storage:    id(function(){ return window.localStorage; })'
      + '};'
      + 'var selfEq = { winIsSelf: (window===window.self), topIsWin: (window.top===window),'
      + '  docWin: (document.defaultView===window) };'
      // `get()` 은 postMessage 를 매번 bind 하고 constructor 를 dynamicWrapperFor 로 감싼다.
      // 새 객체가 매번 나오면 `.constructor` 체인을 도는 코드가 종료하지 못한다 —
      // 실브라우저에서는 Object→Function→Function 으로 2~3 스텝에 닫힌다.
      + 'var fnId = { postMessage: id(function(){ return window.postMessage; }),'
      + '  ctorObj: id(function(){ return ({}).constructor; }),'
      + '  ctorWin: id(function(){ return window.constructor; }),'
      + '  createElement: id(function(){ return document.createElement; }) };'
      + 'function chain(start){ var seen=[]; var c=start; var n=0;'
      + '  while(c && n<5000){ var dup=false;'
      + '    for(var i=0;i<seen.length;i++){ if(seen[i]===c){ dup=true; break; } }'
      + '    if(dup) break; seen.push(c); c=c.constructor; n++; }'
      + '  return n; }'
      + 'var chains = { fromObj: chain({}), fromWin: chain(window), fromDoc: chain(document) };'
      // **멤브레인이 실제로 도는가**를 이 한 줄로 판정한다. 리라이트를 타면
      // location.href 는 가상 URL(원본 타깃)이고, 안 타면 프록시 URL 이다.
      // 이걸 확인 안 하고 잰 값은 전부 무의미하다(실제로 두 번 당했다).
      // 전역 표면 크기. 오버플로가 3,220회(직접 2회)인데, 이런 수는 보통
      // "무언가마다 한 번" 이다. SDK 가 전역을 훑으며 프로브를 돌린다면
      // 우리 realm 의 전역 수가 곧 배수가 된다. 직접 로드와 비교한다.
      + 'function names(o){ try{ return Object.getOwnPropertyNames(o); }catch(e){ return []; } }'
      + 'var wn = names(window);'
      + 'var surface = { win: wn.length, doc: names(document).length,'
      + '  proto: names(Object.getPrototypeOf(window)||{}).length,'
      + '  zp: wn.filter(function(n){ return n.indexOf("__zp")===0 || n.indexOf("ZP")===0 || n.indexOf("__ZP")===0; }) };'
      + 'var membrane = { loc: String(location.href).slice(0,60),'
      + '  isVirtual: String(location.href).indexOf("127.0.0.1:18099")>=0,'
      + '  isProxy: String(location.href).indexOf("/zp/p/")>=0 };'
      + 'window.__ZPDEPTH = { plain: dp, member: dm, ids: ids, selfEq: selfEq, fnId: fnId, chains: chains, membrane: membrane, surface: surface };'
      + 'document.title = "probe done";'
      + '</' + 'script>';
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, cors));
    return res.end(html);
  }
  const file = FILES[path];
  if (!file || !fs.existsSync(D + file)) {
    res.writeHead(404, cors);
    return res.end('no mapping for ' + path);
  }
  const body = fs.readFileSync(D + file);
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': String(body.length),
  }, cors));
  res.end(body);
}).listen(18099, '127.0.0.1', () => console.log('wtm sink on 18099'));

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
    const html = '<!doctype html><meta charset=utf-8><title>zp depth probe</title><body><script>'
      + 'var dp=0; function gp(){ dp++; gp(); } try{ gp(); }catch(e){}'
      + 'var o={}; var dm=0; o.g=function(){ dm++; o.g(); }; try{ o.g(); }catch(e){}'
      + 'window.__ZPDEPTH = { plain: dp, member: dm };'
      + 'document.title = "plain=" + dp + " member=" + dm;'
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

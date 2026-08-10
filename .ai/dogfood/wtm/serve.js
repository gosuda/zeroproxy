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

// 계측/원본 파일 제공 + 마커 수집.
// 경로별로 다른 파일을 준다 — 예전엔 어떤 경로든 같은 파일을 줘서
// "wtm 의 모든 .js 가 같은 번들로 대체" 되는 치명적 혼선을 만들었다(2026-08-10).
const http = require('http');
const fs = require('fs');
const D = __dirname + '/';
const marks = D + 'marks.log';

const FILES = {
  '/main': 'wtm-raw.js',            // 3e66f2… 원본
  '/second': 'wtm2-raw.js',         // 27b3366… 원본
  '/ncap.js': 'ncap-instrumented.js',
  '/zp-dev-wtm.js': 'wtm-instrumented.js',
};

http.createServer((req, res) => {
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

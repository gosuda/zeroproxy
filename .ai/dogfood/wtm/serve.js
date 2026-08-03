// 계측본 정적 제공 + 마커 수집.
// localStorage 는 멤브레인 facade 가 비동기라 wedge 를 못 넘기고,
// taskweaver 의 dump-recording 은 counts=0 으로 여전히 비어 있다.
// 네트워크 요청은 렌더러가 굳기 전에 이미 브라우저 프로세스로 넘어가므로
// 유일하게 신뢰할 수 있는 wedge-proof 채널이다.
const http = require('http');
const fs = require('fs');
const bundle = __dirname + '/wtm-instrumented.js';
const marks = __dirname + '/marks.log';

http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  };
  if (req.url.startsWith('/m?')) {
    try {
      fs.appendFileSync(marks, Date.now() + ' ' + decodeURIComponent(req.url.slice(3)) + '\n');
    } catch {}
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('ok');
  }
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, cors));
  res.end(fs.readFileSync(bundle));
}).listen(18099, '127.0.0.1', () => console.log('wtm-instr on 18099'));

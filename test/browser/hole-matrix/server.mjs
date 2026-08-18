// ZeroProxy 구멍 매트릭스 — 페이지가 URL 을 내보낼 수 있는 경로를 전수 나열하고
// 프록시가 각각을 덮는지 잰다.
//
// 두 축을 동시에 본다:
//   ① 재현성  — 바이트가 타깃(18099/18098)에 도착했는가  → 이 서버의 히트 로그
//   ② 격리    — 브라우저가 외부로 **직접** 갔는가        → 브라우저 네트워크 로그
// ①만 보면 "프록시가 대신 가져온 것" 과 "브라우저가 샌 것" 을 구분할 수 없다
// (2026-08-14 에 이걸로 오진했다). 두 축을 반드시 같이 볼 것.
//
// 리소스 이름 규약:  <id>__<same|cross>.png   — 서버 로그만 보고 케이스를 역추적한다.
import http from 'node:http';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ORIGIN = 18099, CDN = 18098;
let hits = { [ORIGIN]: [], [CDN]: [] };

const CASES = [];
const C = (id, cross, code) => CASES.push({ id, cross: !!cross, code });
const U = (id, cross) => `${cross ? `http://127.0.0.1:${CDN}` : ''}/img/${id}__${cross ? 'cross' : 'same'}.png`;

// ── A. 정적 HTML 속성 (htmltx 가 서빙 바이트에서 고쳐야 하는 것) ──────────
// 이 그룹은 문서 HTML 에 직접 박아 넣는다 (아래 STATIC_HTML).

// ── B. 런타임 DOM: 요소 생성 경로 ────────────────────────────────────────
C('b1-img-prop', 0, `var i=new Image();i.src=U;document.body.appendChild(i)`);
C('b2-img-setattr', 0, `var i=document.createElement('img');i.setAttribute('src',U);document.body.appendChild(i)`);
// setAttributeNS(null,…) 는 명세상 setAttribute 와 같은 속성을 만드는데 훅이
// 따로 있었고, 그쪽만 타깃 절대 URL 을 그대로 썼다(2026-08-18). 매트릭스에
// setAttribute 만 있어서 못 잡았다 — **같은 뜻의 다른 문**은 별도 칸이 필요하다.
C('b2b-img-setattrns', 0, `var i=document.createElement('img');i.setAttributeNS(null,'src',U);document.body.appendChild(i)`);
C('b2c-svg-xlink', 0, `var s=document.createElementNS('http://www.w3.org/2000/svg','svg');var m=document.createElementNS('http://www.w3.org/2000/svg','image');m.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',U);s.appendChild(m);document.body.appendChild(s)`);
C('b3-innerhtml', 0, `var d=document.createElement('div');d.innerHTML='<img src="'+U+'">';document.body.appendChild(d)`);
C('b4-insertadjacent', 0, `document.body.insertAdjacentHTML('beforeend','<img src="'+U+'">')`);
C('b5-srcset', 0, `var i=document.createElement('img');i.srcset=U+' 1x';document.body.appendChild(i)`);
C('b6-picture-source', 0, `var p=document.createElement('picture');var s=document.createElement('source');s.srcset=U;var i=document.createElement('img');p.appendChild(s);p.appendChild(i);document.body.appendChild(p)`);
C('b7-img-cross', 1, `var i=new Image();i.src=U;document.body.appendChild(i)`);
C('b8-preload-link', 0, `var l=document.createElement('link');l.rel='preload';l.as='image';l.href=U;document.head.appendChild(l)`);
C('b9-object-data', 0, `var o=document.createElement('object');o.data=U;document.body.appendChild(o)`);
C('b10-embed-src', 0, `var e=document.createElement('embed');e.src=U;document.body.appendChild(e)`);

// ── C. 스크립트 API ──────────────────────────────────────────────────────
C('c1-fetch', 0, `fetch(U,{mode:'no-cors'}).catch(function(){})`);
C('c2-fetch-cross', 1, `fetch(U,{mode:'no-cors'}).catch(function(){})`);
C('c3-xhr', 0, `var x=new XMLHttpRequest();x.open('GET',U);x.send()`);
C('c4-xhr-cross', 1, `var x=new XMLHttpRequest();x.open('GET',U);x.send()`);
C('c5-beacon', 0, `navigator.sendBeacon(U,'x')`);
C('c6-beacon-cross', 1, `navigator.sendBeacon(U,'x')`);
C('c7-worker', 0, `var b=new Blob(["fetch('"+location.origin+U+"',{mode:'no-cors'}).catch(function(){})"],{type:'text/javascript'});new Worker(URL.createObjectURL(b))`);
C('c8-worker-cross', 1, `var b=new Blob(["fetch('"+U+"',{mode:'no-cors'}).catch(function(){})"],{type:'text/javascript'});new Worker(URL.createObjectURL(b))`);
C('c9-dynamic-import', 0, `import(U.replace('.png','.js')).catch(function(){})`);
C('c10-eventsource', 1, `try{new EventSource(U)}catch(e){}`);
C('c11-ping-attr', 1, `var a=document.createElement('a');a.href='#';a.ping=U;document.body.appendChild(a);a.click()`);

// ── D. CSS (2026-08-14 에 6개 닫은 그룹 — 회귀 감시용으로 남긴다) ────────
C('d1-style-abs', 0, `var s=document.createElement('style');s.textContent='#d1{background-image:url('+U+')}';document.head.appendChild(s);var e=document.createElement('div');e.id='d1';document.body.appendChild(e)`);
C('d2-insertrule', 0, `var s=document.createElement('style');document.head.appendChild(s);s.sheet.insertRule('#d2{background-image:url('+U+')}',0);var e=document.createElement('div');e.id='d2';document.body.appendChild(e)`);
C('d3-elstyle', 0, `var e=document.createElement('div');e.id='d3';document.body.appendChild(e);e.style.backgroundImage='url('+U+')'`);
C('d4-fontface', 0, `var s=document.createElement('style');s.textContent='@font-face{font-family:zpm;src:url('+U+')}#d4{font-family:zpm}';document.head.appendChild(s);var e=document.createElement('div');e.id='d4';e.textContent='x';document.body.appendChild(e)`);
C('d5-adopted', 0, `var sh=new CSSStyleSheet();sh.replaceSync('#d5{background-image:url('+U+')}');document.adoptedStyleSheets=[].concat(document.adoptedStyleSheets,[sh]);var e=document.createElement('div');e.id='d5';document.body.appendChild(e)`);
C('d6-style-cross', 1, `var s=document.createElement('style');s.textContent='#d6{background-image:url('+U+')}';document.head.appendChild(s);var e=document.createElement('div');e.id='d6';document.body.appendChild(e)`);
C('d7-import', 0, `var s=document.createElement('style');s.textContent='@import url('+U.replace('.png','.css')+');';document.head.appendChild(s)`);

// ── E. 통제받지 않는 문서 (document.write 로 채운 srcless iframe) ─────────
C('e1-adframe-img', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<img src="'+U+'">');d.close()`);
C('e2-adframe-fetch', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<scr'+'ipt>fetch("'+U+'",{mode:"no-cors"}).catch(function(){})</scr'+'ipt>');d.close()`);
C('e3-srcdoc-img', 1, `var f=document.createElement('iframe');f.srcdoc='<img src="'+U+'">';document.body.appendChild(f)`);
C('e4-blank-iframe-img', 1, `var f=document.createElement('iframe');f.src='about:blank';document.body.appendChild(f);setTimeout(function(){try{var i=f.contentDocument.createElement('img');i.src=U;f.contentDocument.body.appendChild(i)}catch(e){}},100)`);
// SW 를 못 거치는 프레임의 서브리소스는 부모가 대신 받아 blob 으로 물려준다.
// src 하나만 덮으면 반쪽이다 — 반응형 크리에이티브는 srcset 만 쓰기도 하고,
// srcset 은 URL 이 아니라 `url 1x, url 2x` 후보 목록이라 별도 처리가 필요하다.
C('e5-adframe-srcset', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<img srcset="'+U+' 1x">');d.close()`);
C('e6-adframe-css-link', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<link rel="stylesheet" href="'+U.replace('.png','.css')+'">');d.close()`);

const STATIC_HTML = `
<img src="/img/a1-static-img__same.png">
<img srcset="/img/a2-static-srcset__same.png 1x">
<picture><source srcset="/img/a3-static-source__same.png"><img></picture>
<img src="http://127.0.0.1:${CDN}/img/a4-static-img__cross.png">
<style>#a5{background-image:url(/img/a5-static-style__same.png)}</style><div id="a5"></div>
<div id="a6" style="background-image:url(/img/a6-static-styleattr__same.png)"></div>
<link rel="stylesheet" href="/style/a7.css"><div class="a7"></div>
<video poster="/img/a8-static-poster__same.png"></video>
<object data="/img/a9-static-object__same.png"></object>
`;

function page() {
  // 케이스마다 독립 스코프 + 독립 try. 하나가 던져도 나머지는 계속 돈다
  // (한 케이스의 실패가 뒤를 전부 가리면 매트릭스의 의미가 없다).
  const body = CASES.map(c =>
    `  try { (function(){ var U=${JSON.stringify(U(c.id, c.cross))}; ${c.code}; })(); __ok.push(${JSON.stringify(c.id)}); }\n` +
    `  catch(e) { __err[${JSON.stringify(c.id)}] = String(e).slice(0,80); }`
  ).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>zp-hole-matrix</title>
${STATIC_HTML}
<script>
window.__ok = []; window.__err = {};
${body}
window.__matrixDone = true;
</script>`;
}

function mk(port) {
  http.createServer((req, res) => {
    const u = req.url;
    if (u === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(hits));
    }
    if (u === '/reset') {
      hits = { [ORIGIN]: [], [CDN]: [] };
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (u === '/cases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(CASES.map(c => ({ id: c.id, cross: c.cross }))));
    }
    hits[port].push(u);
    if (u.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    if (u.endsWith('.css')) {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      return res.end('.a7{background-image:url(/img/a7-netcss-url__same.png)}\n.a7x{background-image:url(http://127.0.0.1:' + CDN + '/img/a7x-netcss-cross__cross.png)}');
    }
    if (u.endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end('export default 1;');
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(PNG);
  }).listen(port, '127.0.0.1', () => console.log('listening', port));
}
mk(ORIGIN);
mk(CDN);

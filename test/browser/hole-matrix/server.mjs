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

// 마크업에 박혀 온 `<iframe src>`. 런타임 생성 프레임(e1/e4)과 달리 세터 훅을
// 타지 않으므로 서버측 htmltx 가 잡아야 한다 — 2026-08-19 까지 htmltx 의
// 서브리소스 목록에 iframe 이 없어 `csp-only` 였다(frame-src 가 막아 줬을 뿐).
C('a10-static-iframe', 1, '');

// 아래 a11~a20 은 2026-08-20 에 추가한 **파싱 시점** 칸이다.
// a10(정적 iframe src)을 잡고 나서 매트릭스를 다시 보니, 정적 그룹은
// img/srcset/source/style/link/poster/object 열 개뿐이고 나머지 표면은
// 전부 런타임 경로로만 있었다. htmltx 의 (tag, attr) 서브리소스 목록과
// 대조해서 **목록에 없는 조합**을 한 칸씩 만든 것이 이 묶음이다.
// 전부 cross 로 둔다 — 원본 오리진으로 직접 나가는지가 유일한 판정이고,
// same-origin 상대 URL 은 리라이트를 안 해도 어차피 SW 를 지나기 때문이다.
C('a11-static-inputimage', 1, ''); // <input type=image src> — 진짜 이미지 요청을 낸다
C('a12-static-poster-cross', 1, ''); // poster 는 URL 속성 필터에조차 없다
C('a13-static-svgimage', 1, ''); // SVG <image href>
C('a14-static-svgxlink', 1, ''); // SVG <image xlink:href>
C('a15-static-legacy-image', 1, ''); // <image> — 파서는 img 로 만들지만 토큰 이름은 image
C('a16-static-td-background', 1, ''); // 레거시 background 속성
C('a17-static-srcdoc', 1, ''); // 마크업에 박힌 srcdoc (런타임 e3 만 있었다)
C('a18-static-import', 1, ''); // 인라인 <style> 의 @import (런타임 d7 만 있었다)
C('a19-static-script', 1, ''); // <script src> cross
// ★<use> 는 **same-origin 으로만** 잰다. 크롬은 cross-origin 외부 참조 `<use>` 를
// 아예 거부해서(보안) 대조군에서도 요청이 안 나가고, 그러면 이 칸은 영영
// '판정불가' 다 — 실제로 오래 그 상태로 있었다. 조각 식별자(`#i`)가 살아서
// 넘어가는지를 재는 게 이 칸의 목적이므로 same-origin 이면 충분하다.
C('a20-static-use', 0, ''); // SVG <use href> (same-origin: 크롬이 cross 를 거부)
C('a21-static-feimage', 1, ''); // SVG 필터의 이미지 입력
C('a22-static-imageset', 1, ''); // image-set() 의 맨 문자열 (url() 없는 형태)
// object/embed 는 `object-src 'none'` 으로 **로드를 막는 것**이 정책이다. 그런데
// 그것과 "원본 URL 이 DOM 에 남아도 되는가" 는 다른 질문이다. 프렐류드는 후자를
// 아니라고 보고 리라이트하는데(isURLBearing 에 object[data] 있음) htmltx 는 안 한다.
// 지금까지 **정적 cross-origin object 칸이 없어서** 그 상태가 안 드러났다.
C('a23-static-object-cross', 1, '');

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
// ★e6 은 **스타일시트 자체**가 도착하는지만 본다. 그 안의 `url()` 이 도착하는지는
// 아무도 안 봤고, 실제로 거기가 뚫려 있었다 — SW-less 문서는 릴레이로 시트를 받는데
// 그 시트 안의 URL 이 `/zp/api/fetch`(SW 전용 경로)라 403 이 된다.
// e7 은 시트가 아니라 **시트 안의 이미지**가 도착하는지를 본다.
C('e7-adframe-css-image', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<link rel="stylesheet" href="http://127.0.0.1:${CDN}/style/e7.css"><div class="e7" style="width:2px;height:2px"></div>');d.close()`);


// ── G. 페이지 realm 이 만든 HTML (프렐류드 transformHTML 경로) ────────────
// 정적 그룹(a*)이 **Rust htmltx** 를 전수한다면, 이 그룹은 같은 표면을
// **JS transformHTML** 로 보낸다. 둘은 같은 정책의 서로 다른 구현이고 실제로
// 갈라졌었다 — 2026-08-20 에 meta refresh 가 htmltx 에만 들어가 srcdoc 프레임이
// csp-only 였다. 구현이 두 벌인 한 표도 두 벌이어야 한다.
const G = (id, inner) => C(id, 1, `var f=document.createElement('iframe');f.srcdoc=${JSON.stringify(inner)};document.body.appendChild(f)`);
G('g1-realm-inputimage', `<input type="image" src="http://127.0.0.1:${CDN}/img/g1-realm-inputimage__cross.png">`);
G('g2-realm-poster', `<video poster="http://127.0.0.1:${CDN}/img/g2-realm-poster__cross.png"></video>`);
G('g3-realm-svgimage', `<svg><image href="http://127.0.0.1:${CDN}/img/g3-realm-svgimage__cross.png"></image></svg>`);
G('g4-realm-td-background', `<table><tr><td background="http://127.0.0.1:${CDN}/img/g4-realm-td-background__cross.png">x</td></tr></table>`);
G('g5-realm-feimage', `<svg><filter id="g5f"><feImage href="http://127.0.0.1:${CDN}/img/g5-realm-feimage__cross.png"></feImage></filter><rect width="1" height="1" filter="url(#g5f)"></rect></svg>`);
G('g6-realm-imageset', `<style>#g6{background-image:image-set("http://127.0.0.1:${CDN}/img/g6-realm-imageset__cross.png" 1x)}</style><div id="g6" style="width:1px;height:1px"></div>`);
// g7 도 같은 이유로 same-origin. srcdoc 프레임의 base 는 프록시 오리진이라
// 루트 상대 경로가 픽스처 서버로 안 간다 — 절대 URL 로 준다.
C('g7-realm-use', 0, `var f=document.createElement('iframe');f.srcdoc='<svg width="4" height="4"><use href="http://127.0.0.1:${ORIGIN}/img/g7-realm-use__same.svg#i"></use></svg>';document.body.appendChild(f)`);
G('g8-realm-legacy-image', `<image src="http://127.0.0.1:${CDN}/img/g8-realm-legacy-image__cross.png">`);
// srcset 은 요소 훅 세 경로(setAttribute / 프로퍼티 / 서브트리 스윕)로 들어오는데
// 2026-08-21 실측 시점에 **스윕에만** 후보 분해가 있었다. 나머지 둘은
//   setAttribute → 목록 전체를 URL 하나로 삼킴(후보 둘 다 사망)
//   프로퍼티     → 리라이트를 통째로 건너뜀(원본 URL 이 DOM 에 남음)
// 이었고, `img-src` CSP 만이 방어였다. 경로마다 칸을 둔다.
C('g9-realm-srcset-setattr', 1, `var i=document.createElement('img');i.setAttribute('srcset',U+' 1x');document.body.appendChild(i)`);
C('g10-realm-srcset-prop', 1, `var i=document.createElement('img');i.srcset=U+' 1x';document.body.appendChild(i)`);
C('g11-realm-imagesrcset-prop', 1, `var l=document.createElement('link');l.rel='preload';l.as='image';l.imageSrcset=U+' 1x';document.head.appendChild(l)`);
// `data:` 후보는 본문에 쉼표를 담는다. 쉼표로 자르는 구현은 여기서 **이웃 후보**를
// 통째로 놓친다 — 데이터 URL 뒷조각이 URL 로 오인되면서 진짜 후보가 밀려난다.
C('g12-realm-srcset-data-neighbour', 1, `var i=document.createElement('img');i.setAttribute('srcset','data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg> 2x, '+U+' 1x');document.body.appendChild(i)`);

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
<iframe src="http://127.0.0.1:${CDN}/frame/a10-static-iframe" width="10" height="10"></iframe>
<input type="image" src="http://127.0.0.1:${CDN}/img/a11-static-inputimage__cross.png">
<video poster="http://127.0.0.1:${CDN}/img/a12-static-poster-cross__cross.png"></video>
<svg width="1" height="1"><image href="http://127.0.0.1:${CDN}/img/a13-static-svgimage__cross.png" width="1" height="1"></image></svg>
<svg width="1" height="1"><image xlink:href="http://127.0.0.1:${CDN}/img/a14-static-svgxlink__cross.png" width="1" height="1"></image></svg>
<image src="http://127.0.0.1:${CDN}/img/a15-static-legacy-image__cross.png">
<table><tr><td background="http://127.0.0.1:${CDN}/img/a16-static-td-background__cross.png">x</td></tr></table>
<iframe srcdoc="&lt;img src=&#34;http://127.0.0.1:${CDN}/img/a17-static-srcdoc__cross.png&#34;&gt;" width="10" height="10"></iframe>
<style>@import url("http://127.0.0.1:${CDN}/img/a18-static-import__cross.css");</style>
<script src="http://127.0.0.1:${CDN}/img/a19-static-script__cross.js"></script>
<svg width="4" height="4"><use href="/img/a20-static-use__same.svg#i"></use></svg>
<svg width="1" height="1"><filter id="a21f"><feImage href="http://127.0.0.1:${CDN}/img/a21-static-feimage__cross.png"></feImage></filter><rect width="1" height="1" filter="url(#a21f)"></rect></svg>
<style>#a22{background-image:image-set("http://127.0.0.1:${CDN}/img/a22-static-imageset__cross.png" 1x)}</style><div id="a22" style="width:1px;height:1px"></div>
<object data="http://127.0.0.1:${CDN}/img/a23-static-object-cross__cross.png"></object>
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
    // 프레임 케이스용 문서. 안에서 자기 id 의 이미지를 부르므로 도착 판정은
    // 기존 /img/<id>__<cross>.png 매처를 그대로 쓴다.
    // meta refresh 탈출 벡터 확인용 일회성 라우트. 서브리소스가 아니라
    // **최상위 내비게이션**이라 매트릭스 본표(도착=바이트 수신)로는 못 잰다 —
    // 브라우저가 타깃 오리진으로 이동해 버리는지를 URL 로 본다.
    if (u === '/meta-refresh') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=http://127.0.0.1:' + CDN + '/img/mr-escape__cross.png"><title>mr</title>');
    }
    if (u.startsWith('/frame/')) {
      const id = u.slice('/frame/'.length);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><img src="/img/' + id + '__cross.png">');
    }
    // e7 전용 시트 — 안에 cross-origin 이미지 하나만 둔다. 이 이미지가 도착하면
    // "릴레이로 받은 시트 안의 url() 이 실제로 동작한다" 가 증명된다.
    // 응답 헤더 정책 관측용. 타깃이 브라우저를 조종하려 드는 헤더를 한꺼번에
    // 실어 보낸다 — 프록시를 지난 뒤 무엇이 남는지 브라우저 쪽에서 확인한다.
    // Go 의 ConstructorPolicy 는 이 목록을 걷어내지만 **문서 응답은 커널→SW
    // 경로로 와서 Go 를 안 지난다**(2026-08-20 Refresh 탈출이 그 사고였다).
    // 리다이렉트 깊이 상한(SW: MAX_REDIRECT_DEPTH=5)을 넘기면 마지막 3xx 가
    // 그대로 브라우저로 간다. 그 응답에 Location 이 살아 있으면 **브라우저가
    // 따라가서 프록시 밖으로 나간다**. Go 는 Location 을 리다이렉트 엔진 밖으로
    // 안 흘리는데 SW 는 그대로 복사한다(2026-08-21 실측). 그 차이를 여기서 잰다.
    // 상대 URL 정규화 관측용. htmltx 의 resolve_against_base 는 손으로 쓴
    // 문자열 결합이라 `..`/`.` 를 정규화하지 않는다(나머지 리졸버 넷은
    // new URL()/Url::join 이라 정규화한다). 그 차이가 타깃에 도착하는 **경로**로
    // 드러나는지 본다 — 서버가 받은 u 를 그대로 히트 로그에 남기므로 눈에 보인다.
    if (u.startsWith('/deep/nest/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><title>deep</title>'
        + '<img src="../../img/a24-dotdot__same.png">'
        + '<img src="./sibling/../../../img/a25-dotdot2__same.png">');
    }
    if (u.startsWith('/redirloop')) {
      const n = Number(u.split('/redirloop/')[1] || '0');
      const next = n >= 5
        ? 'http://127.0.0.1:' + CDN + '/img/redirloop-escape__cross.png'
        : '/redirloop/' + (n + 1);
      res.writeHead(302, { location: next, 'cache-control': 'no-store' });
      return res.end('');
    }
    if (u.startsWith('/hdrprobe')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // hop-by-hop — Go 는 걷어내고 SW 는 안 걷어낸다(감사 지적)
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        trailer: 'X-Zp-Probe',
        'proxy-authenticate': 'Basic realm="zp"',
        // Go 는 Location 을 리다이렉트 엔진 밖으로 안 흘린다
        location: 'http://127.0.0.1:' + CDN + '/img/hdrprobe-location__cross.png',
        // 이미 막고 있는 것들 — 회귀 감시로 같이 싣는다
        'clear-site-data': '"storage"',
        'alt-svc': 'h3=":443"',
        link: '<http://127.0.0.1:' + CDN + '/img/hdrprobe-link__cross.png>; rel=preload; as=image',
      });
      return res.end('<!doctype html><meta charset="utf-8"><title>hdrprobe</title><p>hdr</p>');
    }
    if (u.startsWith('/style/e7')) {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      return res.end('.e7{background-image:url(http://127.0.0.1:' + CDN + '/img/e7-adframe-css-image__cross.png)}');
    }
    if (u.endsWith('.css')) {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      return res.end('.a7{background-image:url(/img/a7-netcss-url__same.png)}\n.a7x{background-image:url(http://127.0.0.1:' + CDN + '/img/a7x-netcss-cross__cross.png)}');
    }
    // 외부 참조 `<use>` / CSS `url(sprite.svg#id)` 용 스프라이트.
    // **조각 식별자가 의미**인 유일한 서브리소스라 진짜 SVG 여야 한다 —
    // 예전엔 `.svg` 도 PNG 로 내주고 있어서 `<use>` 케이스가 대조군에서도
    // 아무것도 안 불러 영영 판정불가였다.
    if (u.endsWith('.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg">'
        + '<symbol id="i" viewBox="0 0 4 4"><rect width="4" height="4" fill="#0f0"></rect></symbol>'
        + '<symbol id="other" viewBox="0 0 4 4"><rect width="4" height="4" fill="#f00"></rect></symbol>'
        + '</svg>');
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

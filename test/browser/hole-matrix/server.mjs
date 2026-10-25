// Target fixture server for the subresource hole matrix.
// Tracks both target arrivals (`/hits` on ports 18099/18098) and idle TCP
// connections (`/conns` on port 18097 for preconnect).
// Resource naming convention: `<id>__<same|cross>.png`.
import http from 'node:http';
import crypto from 'node:crypto';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ORIGIN = 18099, CDN = 18098;
// Dedicated port for `preconnect` so subsequent prefetch/preload requests on CDN (18098)
// do not reuse the socket and clear its idle state.
const PRE = 18097;
let hits = { [ORIGIN]: [], [CDN]: [], [PRE]: [] };
// Count sockets that close or remain open for 1.5s without sending an HTTP request
// to distinguish browser `preconnect` sockets from proxy upstream dials.
let conns = { [ORIGIN]: 0, [CDN]: 0, [PRE]: 0 };
let idleConns = { [ORIGIN]: 0, [CDN]: 0, [PRE]: 0 };

const CASES = [];
const C = (id, cross, code) => CASES.push({ id, cross: !!cross, code });
const U = (id, cross) => `${cross ? `http://127.0.0.1:${CDN}` : ''}/img/${id}__${cross ? 'cross' : 'same'}.png`;

// Cases intentionally blocked in proxied mode (compared against control runs to detect regressions or stale entries).
const EXPECT_BLOCKED = {
  'a23-static-object-cross': "Plugin surface blocked by CSP `object-src 'none'`; the URL is rewritten for hygiene, but loading is denied by policy.",
  'b9-object-data': "Runtime-created `<object data>` surface blocked by CSP `object-src 'none'`.",
  'b10-embed-src': "Runtime-created `<embed src>` plugin surface blocked by CSP `object-src 'none'`.",
  'b8b-prefetch-link': 'Dynamic `<link rel=prefetch>` has its `rel` suppressed in the page realm (a dynamic `preload` is routed through the proxy like a static one; `prefetch`, `modulepreload`, `preconnect`, `dns-prefetch`, `prerender` and `manifest` are not).',
  'c7-worker': 'Page-created JS Blobs are replaced with a blocking stub in `URL.createObjectURL` so unrewritten code cannot run inside a worker outside the membrane.',
  'c8-worker-cross': 'Same as c7-worker (blob worker issuing a cross-origin fetch).',
  'c11-ping-attr': '`<a ping>` tracking beacons are stripped so the browser does not issue direct POST requests.',
};

// Group A: Static HTML attributes rewritten by server-side htmltx (embedded in STATIC_HTML below).
C('a10-static-iframe', 1, '');
C('a11-static-inputimage', 1, '');
C('a12-static-poster-cross', 1, '');
C('a13-static-svgimage', 1, '');
C('a14-static-svgxlink', 1, '');
C('a15-static-legacy-image', 1, '');
C('a16-static-td-background', 1, '');
C('a17-static-srcdoc', 1, '');
C('a18-static-import', 1, '');
C('a19-static-script', 1, '');
// Test SVG `<use>` with a same-origin URL because Chrome blocks cross-origin `<use>` references even in control runs.
C('a20-static-use', 0, '');
C('a21-static-feimage', 1, '');
C('a22-static-imageset', 1, '');
C('a23-static-object-cross', 1, '');

// Group B: Runtime DOM element creation and attribute setters.
C('b1-img-prop', 0, `var i=new Image();i.src=U;document.body.appendChild(i)`);
C('b2-img-setattr', 0, `var i=document.createElement('img');i.setAttribute('src',U);document.body.appendChild(i)`);
C('b2b-img-setattrns', 0, `var i=document.createElement('img');i.setAttributeNS(null,'src',U);document.body.appendChild(i)`);
C('b2c-svg-xlink', 0, `var s=document.createElementNS('http://www.w3.org/2000/svg','svg');var m=document.createElementNS('http://www.w3.org/2000/svg','image');m.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',U);s.appendChild(m);document.body.appendChild(s)`);
C('b3-innerhtml', 0, `var d=document.createElement('div');d.innerHTML='<img src="'+U+'">';document.body.appendChild(d)`);
C('b4-insertadjacent', 0, `document.body.insertAdjacentHTML('beforeend','<img src="'+U+'">')`);
C('b5-srcset', 0, `var i=document.createElement('img');i.srcset=U+' 1x';document.body.appendChild(i)`);
C('b6-picture-source', 0, `var p=document.createElement('picture');var s=document.createElement('source');s.srcset=U;var i=document.createElement('img');p.appendChild(s);p.appendChild(i);document.body.appendChild(p)`);
C('b7-img-cross', 1, `var i=new Image();i.src=U;document.body.appendChild(i)`);
C('b8-preload-link', 0, `var l=document.createElement('link');l.rel='preload';l.as='image';l.href=U;document.head.appendChild(l)`);
C('b8b-prefetch-link', 0, `var l=document.createElement('link');l.rel='prefetch';l.href=U;document.head.appendChild(l)`);
C('b9-object-data', 0, `var o=document.createElement('object');o.data=U;document.body.appendChild(o)`);
C('b10-embed-src', 0, `var e=document.createElement('embed');e.src=U;document.body.appendChild(e)`);

// Group C: Imperative network APIs.
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

// Group D: CSS URL surfaces.
C('d1-style-abs', 0, `var s=document.createElement('style');s.textContent='#d1{background-image:url('+U+')}';document.head.appendChild(s);var e=document.createElement('div');e.id='d1';document.body.appendChild(e)`);
C('d2-insertrule', 0, `var s=document.createElement('style');document.head.appendChild(s);s.sheet.insertRule('#d2{background-image:url('+U+')}',0);var e=document.createElement('div');e.id='d2';document.body.appendChild(e)`);
C('d3-elstyle', 0, `var e=document.createElement('div');e.id='d3';document.body.appendChild(e);e.style.backgroundImage='url('+U+')'`);
C('d4-fontface', 0, `var s=document.createElement('style');s.textContent='@font-face{font-family:zpm;src:url('+U+')}#d4{font-family:zpm}';document.head.appendChild(s);var e=document.createElement('div');e.id='d4';e.textContent='x';document.body.appendChild(e)`);
C('d5-adopted', 0, `var sh=new CSSStyleSheet();sh.replaceSync('#d5{background-image:url('+U+')}');document.adoptedStyleSheets=[].concat(document.adoptedStyleSheets,[sh]);var e=document.createElement('div');e.id='d5';document.body.appendChild(e)`);
C('d6-style-cross', 1, `var s=document.createElement('style');s.textContent='#d6{background-image:url('+U+')}';document.head.appendChild(s);var e=document.createElement('div');e.id='d6';document.body.appendChild(e)`);
C('d7-import', 0, `var s=document.createElement('style');s.textContent='@import url('+U.replace('.png','.css')+');';document.head.appendChild(s)`);
// A style filled through the tree, with a layout read after it: the style recalculation (and the image fetch) can run before any MutationObserver callback, so the rewrite has to be synchronous.
C('d8-style-textnode', 0, `var e=document.createElement('div');e.id='d8';document.body.appendChild(e);var s=document.createElement('style');s.appendChild(document.createTextNode('#d8{background-image:url('+U+')}'));document.head.appendChild(s);getComputedStyle(e).backgroundImage`);
C('d9-style-textnode-cross', 1, `var e=document.createElement('div');e.id='d9';document.body.appendChild(e);var s=document.createElement('style');document.head.appendChild(s);s.appendChild(document.createTextNode('#d9{background-image:url('+U+')}'));getComputedStyle(e).backgroundImage`);

// Static `<link rel>` resource hints rewritten by htmltx (`preconnect` and `dns-prefetch` are measured via socket counts).
C('a28-static-prefetch', 1, '');
C('a29-static-preload', 1, '');
C('a30-static-modulepreload', 1, '');

// Group E: Uncontrolled child documents (`document.write`, `srcdoc`, and `about:blank` iframes).
C('e1-adframe-img', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<img src="'+U+'">');d.close()`);
C('e2-adframe-fetch', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<scr'+'ipt>fetch("'+U+'",{mode:"no-cors"}).catch(function(){})</scr'+'ipt>');d.close()`);
C('e3-srcdoc-img', 1, `var f=document.createElement('iframe');f.srcdoc='<img src="'+U+'">';document.body.appendChild(f)`);
C('e4-blank-iframe-img', 1, `var f=document.createElement('iframe');f.src='about:blank';document.body.appendChild(f);setTimeout(function(){try{var i=f.contentDocument.createElement('img');i.src=U;f.contentDocument.body.appendChild(i)}catch(e){}},100)`);
C('e5-adframe-srcset', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<img srcset="'+U+' 1x">');d.close()`);
C('e6-adframe-css-link', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<link rel="stylesheet" href="'+U.replace('.png','.css')+'">');d.close()`);
// Verify that `url(...)` references inside stylesheets fetched by uncontrolled frames also resolve.
C('e7-adframe-css-image', 1, `var f=document.createElement('iframe');document.body.appendChild(f);var d=f.contentDocument;d.open();d.write('<link rel="stylesheet" href="http://127.0.0.1:${CDN}/style/e7.css"><div class="e7" style="width:2px;height:2px"></div>');d.close()`);


// Group G: Page-realm HTML transformation (`transformHTML` via `iframe.srcdoc` and `srcset` hooks).
const G = (id, inner) => C(id, 1, `var f=document.createElement('iframe');f.srcdoc=${JSON.stringify(inner)};document.body.appendChild(f)`);
G('g1-realm-inputimage', `<input type="image" src="http://127.0.0.1:${CDN}/img/g1-realm-inputimage__cross.png">`);
G('g2-realm-poster', `<video poster="http://127.0.0.1:${CDN}/img/g2-realm-poster__cross.png"></video>`);
G('g3-realm-svgimage', `<svg><image href="http://127.0.0.1:${CDN}/img/g3-realm-svgimage__cross.png"></image></svg>`);
G('g4-realm-td-background', `<table><tr><td background="http://127.0.0.1:${CDN}/img/g4-realm-td-background__cross.png">x</td></tr></table>`);
G('g5-realm-feimage', `<svg><filter id="g5f"><feImage href="http://127.0.0.1:${CDN}/img/g5-realm-feimage__cross.png"></feImage></filter><rect width="1" height="1" filter="url(#g5f)"></rect></svg>`);
G('g6-realm-imageset', `<style>#g6{background-image:image-set("http://127.0.0.1:${CDN}/img/g6-realm-imageset__cross.png" 1x)}</style><div id="g6" style="width:1px;height:1px"></div>`);
// Use an explicit origin URL because `srcdoc` frames inherit the proxy origin as their base URI.
C('g7-realm-use', 0, `var f=document.createElement('iframe');f.srcdoc='<svg width="4" height="4"><use href="http://127.0.0.1:${ORIGIN}/img/g7-realm-use__same.svg#i"></use></svg>';document.body.appendChild(f)`);
G('g8-realm-legacy-image', `<image src="http://127.0.0.1:${CDN}/img/g8-realm-legacy-image__cross.png">`);
C('g9-realm-srcset-setattr', 1, `var i=document.createElement('img');i.setAttribute('srcset',U+' 1x');document.body.appendChild(i)`);
C('g10-realm-srcset-prop', 1, `var i=document.createElement('img');i.srcset=U+' 1x';document.body.appendChild(i)`);
C('g11-realm-imagesrcset-prop', 1, `var l=document.createElement('link');l.rel='preload';l.as='image';l.imageSrcset=U+' 1x';document.head.appendChild(l)`);
// Verify that a `data:` candidate containing a comma does not corrupt parsing of subsequent `srcset` candidates.
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
<link rel="preconnect" href="http://127.0.0.1:${PRE}/">
<link rel="dns-prefetch" href="http://127.0.0.1:${PRE}/">
<link rel="prefetch" href="http://127.0.0.1:${CDN}/img/a28-static-prefetch__cross.png">
<link rel="preload" as="image" href="http://127.0.0.1:${CDN}/img/a29-static-preload__cross.png">
<link rel="modulepreload" href="http://127.0.0.1:${CDN}/img/a30-static-modulepreload__cross.js">
`;

function page() {
  // Isolate each case in its own try/IIFE block so a throwing case does not abort subsequent cases.
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
  const srv = http.createServer((req, res) => {
    const u = req.url;
    if (u === '/conns') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ total: conns, idle: idleConns }));
    }
    if (u === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(hits));
    }
    if (u === '/reset') {
      hits = { [ORIGIN]: [], [CDN]: [], [PRE]: [] };
      conns = { [ORIGIN]: 0, [CDN]: 0, [PRE]: 0 };
      idleConns = { [ORIGIN]: 0, [CDN]: 0, [PRE]: 0 };
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (u === '/cases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(CASES.map(c => ({ id: c.id, cross: c.cross, blockedWhy: EXPECT_BLOCKED[c.id] || null }))));
    }
    if (req.socket) req.socket.__zpUsed = true;
    hits[port].push(u);
    if (u.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    // Auxiliary routes for SharedWorker isolation, static SRI stripping, `<base href>`, and `<meta http-equiv="refresh">`.
    if (u === '/sharedworker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end('let n=0;onconnect=function(e){const p=e.ports[0];n++;const mine=n;p.onmessage=function(){p.postMessage(mine)};p.start()};');
    }
    if (u === '/sripage') {
      const body = 'window.__sri_ran = true;';
      const hash = crypto.createHash('sha384').update(body).digest('base64');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><title>sri</title>'
        + '<script src="/sri.js" integrity="sha384-' + hash + '"></script>');
    }
    if (u === '/sri.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end('window.__sri_ran = true;');
    }
    if (u === '/basepage') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><base href="http://127.0.0.1:' + CDN + '/deep/">'
        + '<title>basepage</title><img id="rel" src="base-rel__cross.png">');
    }
    if (u === '/meta-refresh') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=http://127.0.0.1:' + CDN + '/img/mr-escape__cross.png"><title>mr</title>');
    }
    if (u.startsWith('/frame/')) {
      const id = u.slice('/frame/'.length);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><img src="/img/' + id + '__cross.png">');
    }
    // Routes for dot-segment URL normalization, redirect-depth limits, and response header stripping.
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
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        trailer: 'X-Zp-Probe',
        'proxy-authenticate': 'Basic realm="zp"',
        location: 'http://127.0.0.1:' + CDN + '/img/hdrprobe-location__cross.png',
        'clear-site-data': '"storage"',
        'alt-svc': 'h3=":443"',
        link: '<http://127.0.0.1:' + CDN + '/img/hdrprobe-link__cross.png>; rel=preload; as=image',
        'report-to': '{"group":"zp","max_age":86400,"endpoints":[{"url":"http://127.0.0.1:' + CDN + '/img/hdrprobe-reportto__cross.png"}]}',
        'reporting-endpoints': 'zp="http://127.0.0.1:' + CDN + '/img/hdrprobe-endpoints__cross.png"',
        nel: '{"report_to":"zp","max_age":86400}',
        'content-security-policy-report-only': "default-src 'self'; report-uri http://127.0.0.1:" + CDN + '/img/hdrprobe-cspro__cross.png',
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
    // Serve a real SVG sprite with `<symbol id="i">` so `<use href="...#i">` triggers an actual subresource fetch.
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
  });
  srv.on('connection', (sock) => {
    conns[port] += 1;
    sock.__zpUsed = false;
    // Count a socket as idle on whichever comes first: the 1.5s timer or socket close without any HTTP request.
    let counted = false;
    const countIdle = () => {
      if (counted || sock.__zpUsed) return;
      counted = true;
      idleConns[port] += 1;
    };
    const t = setTimeout(countIdle, 1500);
    sock.on('close', () => { clearTimeout(t); countIdle(); });
  });
  srv.listen(port, '127.0.0.1', () => console.log('listening', port));
}
mk(ORIGIN);
mk(CDN);
mk(PRE);

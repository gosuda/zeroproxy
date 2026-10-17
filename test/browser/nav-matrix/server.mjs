// Navigation matrix fixture server testing top-level and child-frame document navigation vectors.
import http from 'node:http';

const ORIGIN = 18087, LAND = 18086;
let hits = { [ORIGIN]: [], [LAND]: [] };
const landURL = id => `http://127.0.0.1:${LAND}/landed/${id}`;

const CASES = [];
const C = (id, html) => CASES.push({ id, html });

// Markup-driven top-level navigations.
C('n1-meta-refresh', id => `<meta http-equiv="refresh" content="0;url=${landURL(id)}">`);
C('n2-meta-refresh-quoted', id => `<meta http-equiv="REFRESH" content="0; URL='${landURL(id)}'">`);
C('n3-base-href', id => `<base href="http://127.0.0.1:${LAND}/"><a id="go" href="landed/${id}">go</a><script>document.getElementById('go').click()</script>`);

// Script-driven top-level navigations.
C('n4-location-href', id => `<script>location.href=${JSON.stringify(landURL(id))}</script>`);
C('n5-location-replace', id => `<script>location.replace(${JSON.stringify(landURL(id))})</script>`);
C('n6-location-assign', id => `<script>location.assign(${JSON.stringify(landURL(id))})</script>`);
C('n7-top-location', id => `<script>top.location=${JSON.stringify(landURL(id))}</script>`);
C('n8-anchor-click', id => `<a id="go" href="${landURL(id)}">go</a><script>document.getElementById('go').click()</script>`);
C('n9-form-submit', id => `<form id="f" method="GET" action="${landURL(id)}"></form><script>document.getElementById('f').submit()</script>`);
C('n10-window-open', id => `<script>window.open(${JSON.stringify(landURL(id))},'_self')</script>`);

// Child-frame and target-attribute navigation cases.
const FRAME_CASES = [];
const F = (id, html) => FRAME_CASES.push({ id, html });

F('f1-iframe-src-prop', id => `<iframe id="t"></iframe><script>document.getElementById('t').src=${JSON.stringify(landURL(id))}</script>`);
F('f2-iframe-src-static', id => `<iframe src="${landURL(id)}"></iframe>`);
F('f3-iframe-setattr', id => `<iframe id="t"></iframe><script>document.getElementById('t').setAttribute('src',${JSON.stringify(landURL(id))})</script>`);
F('f4-child-location', id => `<iframe id="t" src="about:blank"></iframe><script>setTimeout(function(){try{document.getElementById('t').contentWindow.location=${JSON.stringify(landURL(id))}}catch(e){}},300)</script>`);
F('f5-anchor-target-blank', id => `<a id="go" target="_blank" href="${landURL(id)}">go</a><script>document.getElementById('go').click()</script>`);
F('f6-anchor-target-top', id => `<a id="go" target="_top" href="${landURL(id)}">go</a><script>document.getElementById('go').click()</script>`);
F('f7-form-target-top', id => `<form id="f" target="_top" method="GET" action="${landURL(id)}"></form><script>document.getElementById('f').submit()</script>`);
F('f8-window-open-blank', id => `<script>window.open(${JSON.stringify(landURL(id))},'_blank')</script>`);
F('f9-base-target', id => `<base target="_blank"><a id="go" href="${landURL(id)}">go</a><script>document.getElementById('go').click()</script>`);
F('f10-frame-meta-refresh', id => `<iframe id="t" srcdoc='<meta http-equiv="refresh" content="0;url=${landURL(id)}">'></iframe>`);

function framePage(c) {
  return `<!doctype html><meta charset="utf-8"><title>fnav-${c.id}</title>${c.html(c.id)}<p>frame fixture ${c.id}</p>`;
}

function page(c) {
  return `<!doctype html><meta charset="utf-8"><title>nav-${c.id}</title>${c.html(c.id)}<p>nav fixture ${c.id}</p>`;
}

function mk(port) {
  http.createServer((req, res) => {
    const u = req.url;
    if (u === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(hits));
    }
    if (u === '/reset') { hits = { [ORIGIN]: [], [LAND]: [] }; res.writeHead(200); return res.end('ok'); }
    if (u === '/cases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([
        ...CASES.map(c => ({ id: c.id, axis: 'top', path: '/nav/' + c.id })),
        ...FRAME_CASES.map(c => ({ id: c.id, axis: 'frame', path: '/fnav/' + c.id })),
      ]));
    }
    hits[port].push(u);
    // HTTP `Refresh` response header (must be stripped by the service worker header policy).
    if (u.startsWith('/nav/n11-refresh-header')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        refresh: '0;url=' + landURL('n11-refresh-header'),
      });
      return res.end('<!doctype html><meta charset="utf-8"><title>nav-n11</title><p>header refresh</p>');
    }
    // 60-hop redirect chain ending in an external `Location` URL: verifies that
    // exceeding the redirect limit does not forward a raw 3xx `Location` to the browser.
    if (u.startsWith('/nav/n13-redirect-limit')) {
      const hop = Number(u.split('?hop=')[1] || '0');
      const next = hop >= 60
        ? landURL('n13-redirect-limit')
        : '/nav/n13-redirect-limit?hop=' + (hop + 1);
      res.writeHead(302, { location: next, 'cache-control': 'no-store' });
      return res.end('');
    }
    if (u.startsWith('/nav/n12-server-redirect')) {
      res.writeHead(302, { location: landURL('n12-server-redirect'), 'cache-control': 'no-store' });
      return res.end('');
    }
    if (u.startsWith('/fnav/')) {
      const id = u.slice('/fnav/'.length);
      const c = FRAME_CASES.find(x => x.id === id);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(c ? framePage(c) : '<!doctype html>unknown frame case');
    }
    if (u.startsWith('/nav/')) {
      const id = u.slice('/nav/'.length);
      const c = CASES.find(x => x.id === id);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(c ? page(c) : '<!doctype html>unknown case');
    }
    if (u.startsWith('/landed/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><title>LANDED</title><h1>landed</h1>');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('ok');
  }).listen(port, '127.0.0.1', () => console.log('nav fixture listening', port));
}
CASES.push({ id: 'n11-refresh-header', html: () => '' });
CASES.push({ id: 'n12-server-redirect', html: () => '' });
CASES.push({ id: 'n13-redirect-limit', html: () => '' });
mk(ORIGIN);
mk(LAND);

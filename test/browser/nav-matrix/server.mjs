// 내비게이션 축 매트릭스 — 페이지가 **문서째** 타깃으로 나갈 수 있는 경로를
// 전수 나열한다.
//
// 왜 별도 매트릭스인가: 구멍 매트릭스는 판정축이 "바이트가 타깃에 도착했는가"
// 라서 **서브리소스 전용**이다. 최상위 내비게이션은 페이지가 떠나 버리므로 같은
// 표로 못 잰다. 축이 없으면 칸도 없고, 칸이 없으면 영영 안 나온다 — 2026-08-20
// 에 `<meta http-equiv=refresh>` 가 정확히 그렇게 숨어 있었다(진짜 탈출이었다).
//
// 판정: 로드 후 **브라우저가 어디에 있는가**.
//   프록시 오리진 밖 = 탈출 (그 뒤 모든 요청이 맨몸이다)
//   프록시 오리진 안 = ok  (타깃 바이트는 우리를 거쳐 온다)
import http from 'node:http';

const ORIGIN = 18087, LAND = 18086;
let hits = { [ORIGIN]: [], [LAND]: [] };
const landURL = id => `http://127.0.0.1:${LAND}/landed/${id}`;

// code 는 문서 안에서 실행되는 스크립트. L 은 착지 URL.
const CASES = [];
const C = (id, html) => CASES.push({ id, html });

// ── 마크업이 스스로 내비게이션하는 것 ──────────────────────────────────
C('n1-meta-refresh', id => `<meta http-equiv="refresh" content="0;url=${landURL(id)}">`);
C('n2-meta-refresh-quoted', id => `<meta http-equiv="REFRESH" content="0; URL='${landURL(id)}'">`);
// `<base>` 는 그 문서의 **모든 상대 URL 해석 기준**을 바꾼다. 살아남으면
// 상대 링크 한 번에 타깃 오리진으로 나간다.
C('n3-base-href', id => `<base href="http://127.0.0.1:${LAND}/"><a id="go" href="landed/${id}">go</a><script>document.getElementById('go').click()</script>`);

// ── 스크립트가 내비게이션하는 것 ───────────────────────────────────────
C('n4-location-href', id => `<script>location.href=${JSON.stringify(landURL(id))}</script>`);
C('n5-location-replace', id => `<script>location.replace(${JSON.stringify(landURL(id))})</script>`);
C('n6-location-assign', id => `<script>location.assign(${JSON.stringify(landURL(id))})</script>`);
C('n7-top-location', id => `<script>top.location=${JSON.stringify(landURL(id))}</script>`);
C('n8-anchor-click', id => `<a id="go" href="${landURL(id)}">go</a><script>document.getElementById('go').click()</script>`);
C('n9-form-submit', id => `<form id="f" method="GET" action="${landURL(id)}"></form><script>document.getElementById('f').submit()</script>`);
C('n10-window-open', id => `<script>window.open(${JSON.stringify(landURL(id))},'_self')</script>`);

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
      return res.end(JSON.stringify(CASES.map(c => ({ id: c.id }))));
    }
    hits[port].push(u);
    // ★`Refresh:` 는 비표준이지만 크롬이 지원하는 **헤더판 meta refresh** 다.
    // 마크업이 아니라 응답 헤더로 오므로 htmltx 가 보지 못한다 — SW 의 헤더
    // 정책이 걷어내야 하는 자리다.
    if (u.startsWith('/nav/n11-refresh-header')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        refresh: '0;url=' + landURL('n11-refresh-header'),
      });
      return res.end('<!doctype html><meta charset="utf-8"><title>nav-n11</title><p>header refresh</p>');
    }
    // 서버가 타깃 오리진으로 3xx 를 준다. 트랜스포트가 따라가되 결과는 여전히
    // 프록시 오리진이어야 한다.
    if (u.startsWith('/nav/n12-server-redirect')) {
      res.writeHead(302, { location: landURL('n12-server-redirect'), 'cache-control': 'no-store' });
      return res.end('');
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
// 헤더/리다이렉트 케이스는 CASES 에 마크업이 없으므로 따로 등록한다.
CASES.push({ id: 'n11-refresh-header', html: () => '' });
CASES.push({ id: 'n12-server-redirect', html: () => '' });
mk(ORIGIN);
mk(LAND);

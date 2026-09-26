  // Mirror of zp-htmltx::proxied_navigation_url. Build a proxy-origin
  // "go-via launcher" URL so dynamically-created anchor/form attributes
  // never expose the target host to browser-native UI. Inert URL schemes
  // (#fragment / javascript: / data: / blob: / about: / mailto: /
  // vbscript:) pass through unchanged.
  // 2026-08-13 — 런타임이 만드는 수동 서브리소스 URL 을 서버측 htmltx 와
  // 같은 모양으로 맞춘다.
  //
  // htmltx 는 초기 HTML 의 `img/source/video/audio/track/link` URL 을
  // `/zp/api/fetch?url=…` 로 리라이트한다("strict CSP would otherwise block
  // external origins before the SW gets to intercept"). 그런데 프렐류드는
  // 같은 속성에 **절대 타깃 URL 을 그대로** 써 왔다. 그래서 JS 가 만든
  // 이미지만 원본 URL 로 남고(실측: React 가 만든 `<img>` 는
  // `https://ssl.pstatic.net/…`, htmltx 가 처리한 `<link>` 는
  // `/zp/api/fetch?url=…`), 그게 두 가지를 낳았다:
  //   (a) CSP 를 `img-src 'self'` 로 못 죈다 — 죄면 전부 깨진다.
  //   (b) srcdoc / blob 문서에서는 SW 가 클라이언트를 탭에 귀속시키지 못해
  //       그 URL 이 통째로 거절된다 (UNCLASSIFIED).
  // `tab` 을 URL 에 실어 두면 (b) 는 귀속 자체가 필요 없어진다 —
  // `/zp/api/fetch` 는 이미 명시 `?tab=` 을 받는다.
  // ★`?url=` 파라미터 인코딩은 Rust `URL_PARAM_ENCODE` 와 **바이트 단위로**
  // 같아야 한다. `encodeURIComponent` 는 `!'()*` 를 남기는데 Rust 쪽은
  // (RFC 3986 unreserved 만 남기므로) 인코딩한다. SW 는 `URLSearchParams` 로
  // 읽어서 둘 다 풀리지만, 출력이 다르면 **같은 리소스에 캐시 키가 둘** 생기고
  // `alreadyMapped` 단축이 어긋난다. 그래서 남는 다섯 글자를 마저 인코딩한다.
  function encodeURLParam(s) {
    return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  function subresourceProxyPath(absolute) {
    const s = String(absolute || '');
    if (!s || s[0] === '#') return s;
    if (!/^https?:/i.test(s)) return s;
    // ★프래그먼트는 파라미터 **밖**에 둔다. 안으로 넣으면 `#` 가 `%23` 이 돼
    // 브라우저가 조각을 못 고르고, 외부 SVG 스프라이트를 참조하는 `<use>` 와
    // CSS `url(sprite.svg#icon)` 이 빈 채로 렌더된다. 서버측 htmltx 는 이미
    // 이렇게 하고 있었는데 페이지 realm 만 삼키고 있었다 — 같은 규칙의
    // 구현이 갈라진 자리다. 프래그먼트는 요청에 실리지 않으므로 SW 가 받는
    // URL 은 그대로다.
    const hash = s.indexOf('#');
    const head = hash < 0 ? s : s.slice(0, hash);
    const frag = hash < 0 ? '' : s.slice(hash);
    let out = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURLParam(head);
    if (boot && boot.tabId) out += '&tab=' + encodeURLParam(boot.tabId);
    return out + frag;
  }
  // ★SW-less 문서용 서브리소스 경로.
  //
  // `/zp/api/fetch` 는 **SW 안에서만 존재하는 가상 경로**다 — Go 에는 핸들러가
  // 없어서 default 로 떨어져 403 이다. 그러니 SW 클라이언트가 아닌 문서에 그
  // 경로를 박는 것은 애초에 잘못된 리라이트다. 없는 주소를 적어 주고 브라우저가
  // 403 을 받아 오는 걸 지켜보는 셈이고, 지금까지는 그걸 blob 으로 뒤늦게
  // 덮어써 왔다(그래서 로드마다 403 이 쌓였다).
  //
  // 대신 동기 XHR 이 쓰던 릴레이를 그대로 쓴다. 그 엔드포인트는 Go 가 응답을
  // park 해 두고 **SW 에 일을 넘기는** 구조라, 실제 전송은 여전히 SW 의
  // `transportFetch` 하나뿐이다 — 새 egress 도, 새 TLS 지문도 안 생긴다.
  // 동기 XHR 도 "SW 가 가로채지 못하는 요청" 이라는 점에서 같은 범주였고,
  // 그때 이미 blob 우회가 아니라 경로 교체로 푼 전례가 있다.
  function swLessRelayURL(absolute, kind) {
    const s = String(absolute || '');
    if (!/^https?:/i.test(s)) return '';
    let u = proxyOrigin + ZP.apiPath('sync-fetch')
      + '?rid=' + encodeURIComponent('sr' + ZP.randomId())
      + '&u=' + encodeURIComponent(s)
      + '&m=GET'
      + '&tab=' + encodeURIComponent((boot && boot.tabId) || '')
      + '&entry=' + encodeURIComponent(activeEntryId || '');
    if (kind) u += '&kind=' + encodeURIComponent(kind);
    return u;
  }
  // 이미 `/zp/api/fetch?url=…` 로 리라이트된 값을 릴레이 경로로 옮긴다.
  // 리라이트 단계에서 목적지 문서가 SW-less 임을 알 때만 부른다.
  function relayFromProxyPath(proxied, kind) {
    const s = String(proxied || '');
    const at = s.indexOf(ZP.apiPath('fetch') + '?url=');
    if (at < 0) return '';
    let target = '';
    try { target = new URL(s, proxyOrigin).searchParams.get('url') || ''; } catch { return ''; }
    return target ? swLessRelayURL(target, kind) : '';
  }
  // ★릴레이로 보낼 수 있는 것은 **서브리소스뿐**이다. 내비게이션(`a`/`area`/
  // `form`/`iframe`/`frame`)은 절대 여기 오면 안 된다 — 그것들은 share URL 로
  // 항해해야 하고, 릴레이는 문서가 아니라 바이트를 돌려주는 자리다.
  // `object`/`embed` 는 정책상 이미 막혀 있으므로 굳이 열지 않는다.
  // ★이미지까지 릴레이로 보내면 안 된다 — 실측으로 확인했다. 릴레이는 본문을
  // base64 로 실어 나르고 SW 가 잡을 하나씩 폴링해 처리하는 구조라, 이미지
  // 수십 건을 태우면 15초 안에 스타일시트가 못 붙는다(naver 19회 중 8회에서
  // `deadSheets` 2~4, 30초를 주면 0). blob 경로는 부모가 바이트를 바로 받아
  // 넘기므로 대량 이미지에 훨씬 유리하다.
  //
  // 그래서 역할을 나눈다: **적고 치명적인 것(스타일시트)은 릴레이**,
  // 많고 가벼운 것(이미지)은 기존 blob. 스타일시트는 403 이 text/html 본문을
  // 돌려주는 탓에 "Refused to apply style" 까지 나서 blob 으로 덮기 전까지
  // 사실상 깨진 시트였다.
  // ★이미지를 릴레이로 보내면 안 된다 — **HTTP/1.1 커넥션 한계** 때문이다.
  // 릴레이 요청은 Go 가 park 한 채 SW 가 답할 때까지 커넥션을 붙잡는다. 호스트당
  // ~6개뿐이라 이미지 수십 건이 그 자리를 채우면 스타일시트 요청이 브라우저
  // 큐에서 줄을 선다. 실측으로 확인했다: 이미지 포함 릴레이는 `deadSheets` 가
  // 6회 중 5회(1~4), `<link>` 한정은 6회 모두 0.
  //
  // base64 를 바이너리로 바꾸고 폴링을 배치로 묶어도 그대로였다 — 페이로드나
  // 왕복 수가 아니라 **점유된 커넥션 수**가 병목이라는 뜻이다. 이 벽은 프록시
  // 오리진이 HTTP/2 를 말하기 전에는 안 없어진다(멀티플렉싱이 필요하다).
  function swLessRelayable(tag, localKey) {
    return tag === 'link' && localKey === 'href';
  }
  function relayKindForElement(node, tag, localKey) {
    if (tag === 'link' && localKey === 'href') {
      const rel = String(Native.getAttribute.call(node, 'rel') || '').toLowerCase();
      // stylesheet 일 때만 CSS 리라이트를 요구한다. icon/manifest 는 원본 바이트다.
      return /(^|\s)stylesheet(\s|$)/.test(rel) ? 'style' : '';
    }
    if (tag === 'script' && localKey === 'src') return 'script';
    return '';
  }
  // ── SW 를 못 거치는 프레임의 서브리소스 (e1/e4) ────────────────────────
  // `document.write` 로 만들어진 iframe 의 document 는 SW 클라이언트가 아니다.
  // 그래서 그 안의 `/zp/api/fetch?url=…` 요청은 SW 를 지나쳐 Go 서버로 직행하고
  // 403 POLICY_BLOCKED 로 죽는다. 실측(naver 메인): safeframe 광고 프레임 6개의
  // 이미지 8건이 전부 403 인데 **같은 URL 이 최상위 문서에서는 200** 이다.
  //
  // 해결: 부모 realm 의 native fetch 로 받아서 blob URL 을 물려준다. 이미
  // `__ZP_LOAD_EXTERNAL_SCRIPT` 가 자식 스크립트에 쓰는 것과 같은 수법이고,
  // 나가는 요청은 여전히 부모의 SW 한 곳만 지난다 — 출구는 하나로 유지된다.
  // (`img-src 'self' blob:` 이라 CSP 도 그대로 통과한다.)
  const swLessDocs = new WeakMap();
  function documentIsSWLess(doc) {
    if (!doc || doc === document) return false;
    let cached = swLessDocs.get(doc);
    if (cached !== undefined) return cached;
    let url = null;
    const desc = Native.documentURLDesc;
    if (desc && desc.get) { try { url = String(desc.get.call(doc) || ''); } catch { url = null; } }
    // 판정할 수 없으면 기존 동작(직접 프록시 경로)을 쓴다 — 모르는 채로
    // blob 경로에 태우면 멀쩡한 프레임까지 느려진다.
    // 실측(naver 메인): `document.write` 로 만들어진 프레임의 document URL 은
    // **최상위 문서의 URL 그대로**다 — 자기 navigation 이 없었으니 부모 URL 을
    // 상속한다. 반대로 src 를 타고 실제로 내비게이션한 프레임은 각자 다른
    // `/zp/p/<share>` 를 갖고, 그것들은 SW 클라이언트라 지금도 200 이 온다.
    // 그래서 "내 URL 이 최상위와 같다"가 SW 클라이언트가 아니라는 신호다.
    // 프래그먼트는 떼고 비교한다 — 최상위 문서 URL 에는 `#k=…&server=…` 가
    // 붙어 있고 상속된 프레임 URL 에는 없다. 이걸 빼먹어서 한 번 헛짚었다.
    const bare = s => { const i = s.indexOf('#'); return i < 0 ? s : s.slice(0, i); };
    let topURL = null;
    if (desc && desc.get) { try { topURL = String(desc.get.call(document) || ''); } catch {} }
    const value = url === null ? false
      : (!url || url === 'about:blank' || (!!topURL && bare(url) === bare(topURL)));
    swLessDocs.set(doc, value);
    if (value) installSWLessObserver(doc);
    return value;
  }
  const swLessBlobs = new Map();
  // kind='style' 은 CSS 리라이트가 **반드시** 걸려야 한다. 부모가 대신 받는
  // 이 fetch 는 destination 이 'empty' 라 SW 의 `req.destination === 'style'`
  // 판정을 못 탄다 — 그대로 두면 `url(../../res/x.png)` 가 상대경로로 남고,
  // blob: 을 base 로 해석돼 배경이 통째로 깨진다. 문서 요청의
  // `X-ZP-Document-Request` 와 같은 방식으로 명시 신호를 준다.
  function swLessBlobURL(proxied, kind) {
    const ck = (kind || '') + '\n' + proxied;
    const hit = swLessBlobs.get(ck);
    if (hit) return hit;
    const make = Native.createObjectURL || (blob => URL.createObjectURL(blob));
    const init = kind === 'style' ? { headers: { 'X-ZP-Style-Request': '1' } } : undefined;
    let p;
    try {
      p = Promise.resolve(init ? Native.fetch(proxied, init) : Native.fetch(proxied))
        .then(r => (r && r.ok) ? r.blob() : Promise.reject(new Error('status ' + (r && r.status))))
        .then(b => make(b))
        .catch(err => { swLessBlobError = String(err && err.message || err).slice(0, 120); reportSWLessError(); return null; });
    } catch (err) {
      swLessBlobError = 'sync ' + String(err && err.message || err).slice(0, 110);
      p = Promise.resolve(null);
    }
    // 상한선 — 광고 프레임 몇 개가 만드는 양은 수십 건이다. 넘치면 캐시만
    // 포기하고 계속 동작한다.
    if (swLessBlobs.size < 400) swLessBlobs.set(ck, p);
    return p;
  }
  // 실패는 페이지가 볼 수 있는 곳에 남기지 않는다 — DOM 속성으로 찍으면
  // 그 자체가 지문이다.
  var swLessBlobError = null;
  function reportSWLessError() {
    if (!swLessBlobError) return;
    try {
      const diag = root.__zp_diagnostics;
      if (diag && diag.length < 200) diag.push({ t: 'swless-blob', msg: swLessBlobError });
    } catch {}
  }
  // 한 요소가 src 와 srcset 을 동시에 갖는 게 정상이므로 요소 단위가 아니라
  // (요소, 속성) 단위로 기억한다.
  const swLessUpgraded = new WeakMap();
  function markSWLessUpgraded(el, key) {
    let keys = swLessUpgraded.get(el);
    if (!keys) { keys = new Set(); swLessUpgraded.set(el, keys); }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }
  function upgradeSWLessURL(el, key, raw) {
    if (raw.indexOf(ZP.apiPath('fetch')) < 0) return;
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!documentIsSWLess(doc)) return;
    if (!markSWLessUpgraded(el, key)) return;
    if (key === 'srcset' || key === 'imagesrcset') return upgradeSWLessSrcset(el, key, raw);
    swLessBlobURL(raw, key === 'href' ? 'style' : '').then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  // srcset 은 URL 하나가 아니라 `url 1x, url 2x` 후보 목록이다. 후보마다
  // 따로 blob 을 받아 URL 부분만 갈아끼운다 — 디스크립터(`1x`/`320w`)는
  // 그대로 둬야 브라우저의 후보 선택이 원본과 같다. 프록시 URL 은 타깃을
  // (예전 주석은 "프록시 URL 에는 쉼표가 없으니 split(',') 이 안전하다" 고
  //  적혀 있었다. 전제가 틀렸다 — 쉼표는 **아직 리라이트 안 된** data: 후보에
  //  들어 있다. splitSrcsetCandidates 를 쓴다.)
  function upgradeSWLessSrcset(el, key, raw) {
    const parts = splitSrcsetCandidates(raw);
    const jobs = parts.map(c => {
      if (!c.url || c.url.indexOf(ZP.apiPath('fetch')) < 0) return Promise.resolve(c.lead + c.url + c.tail);
      return swLessBlobURL(c.url, '').then(u => c.lead + (u || c.url) + c.tail);
    });
    Promise.all(jobs).then(list => { try { Native.setAttribute.call(el, key, list.join('')); } catch {} });
  }
  // `document.write` 로 만들어진 프레임 안의 서브리소스는 요소 훅도 서브트리
  // 스윕도 안 탄다 — 그 문서에 우리 MutationObserver 가 없고, adm 은 HTML
  // 문자열 단계에서 리라이트되므로 요소 경로를 아예 지나간다. 부모 쪽 백스톱
  // 스윕이 같은 오리진 자식 문서까지 훑는 것이 이들을 만나는 유일한 지점이다.
  function sweepSWLessFrames(w) {
    let frames = null;
    try { frames = (w || window).document.querySelectorAll('iframe,frame'); } catch { return; }
    if (!frames) return;
    for (const f of frames) {
      let d = null;
      try { d = f.contentDocument; } catch { continue; }
      // 분류만 해 두면 된다 — SW-less 로 판정되는 순간 옵저버가 붙는다.
      if (d) documentIsSWLess(d);
    }
  }
  function sweepSWLessDoc(doc) {
    let els = null;
    try { els = doc.querySelectorAll('img[src],img[srcset],source[src],source[srcset],video[poster],input[src],embed[src],link[rel~="stylesheet"][href],meta[http-equiv]'); } catch { return; }
    for (const el of els) {
      // Meta refresh inside a SW-less frame must re-arm on the via-URL too —
      // a raw target URL here is a same-origin refresh request the server 403s.
      if (el.localName === 'meta') { try { enforceMetaPolicy(el); } catch {} continue; }
      // `<link>` 가 403 을 받으면 광고 프레임이 스타일 없이 남는다 — naver
      // 메인의 timeboard / rollingboard 크리에이티브가 정확히 이 경로였다.
      // img/source 는 src 와 srcset 을 **동시에** 가질 수 있고, 반응형
      // 크리에이티브는 srcset 만 쓰기도 한다.
      const tag = el.localName;
      const keys = tag === 'video' ? ['poster']
        : tag === 'link' ? ['href']
        : (tag === 'img' || tag === 'source') ? ['src', 'srcset']
        : ['src'];
      for (const key of keys) {
        let raw = null;
        try { raw = Native.getAttribute.call(el, key); } catch {}
        if (raw) upgradeSWLessURL(el, key, String(raw));
      }
    }
  }
  // 광고 프레임은 **비어 있는 채로 먼저 생기고** 크리에이티브는 몇 초 뒤에
  // 들어온다. 타이머 스윕(500/1500/3000ms)으로는 못 잡아서 옵저버가 필요했다.
  // 최상위 문서에 MutationObserver 를 달았다가 NAVER 하이드레이션 폭풍에
  // 렌더러가 멎은 전례가 있으므로(위 installNavigationBackstop 주석) **SW-less
  // 로 판정된 문서에만** 단다 — 광고 프레임 몇 개, 노드 수십 개짜리다.
  function installSWLessObserver(doc) {
    try {
      // ★반드시 Document 노드를 관찰한다. `document.write` 는 documentElement
      // 를 **통째로 갈아치우므로** 초기 about:blank 의 `<html>` 에 붙여 두면
      // 그 뒤 광고 마크업이 들어가는 새 트리를 하나도 못 본다 — 실측에서
      // 옵저버 16개가 붙었는데 콜백은 한 번도 안 돌았다.
      const obs = new MutationObserver(() => sweepSWLessDoc(doc));
      obs.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href', 'http-equiv', 'content'] });
    } catch {}
    sweepSWLessDoc(doc);
  }
  // SW-less 문서의 이미지 자리끼우개. **네트워크 요청을 아예 안 내는** 1×1
  // 투명 PNG 다 — 그래서 원본 오리진으로 나갈 길이 없다(fail-closed 유지).
  const SWLESS_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 자리끼우개를 써도 되는 자리 = **이미지뿐**이다. script/link 는 src 를 나중에
  // 바꿔도 다시 실행/적용되지 않거나 별도 경로(릴레이, __ZP_LOAD_EXTERNAL_SCRIPT)
  // 가 이미 담당하므로 건드리지 않는다.
  function swLessPixelable(el, key) {
    const tag = el && el.localName;
    if (key === 'poster') return tag === 'video';
    if (key !== 'src') return false;
    return tag === 'img' || tag === 'image' || tag === 'input';
  }
  function setSubresourceAttribute(el, key, proxied) {
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!documentIsSWLess(doc)) { Native.setAttribute.call(el, key, proxied); return; }
    // ★2026-08-20 — 여기에 프록시 경로를 박으면 **반드시 403 이 한 번 난다.**
    // `/zp/api/fetch` 는 SW 안에만 있는 가상 경로이고 이 문서는 SW 클라이언트가
    // 아니다. 지금까지는 그 403 을 blob 으로 뒤늦게 덮어써 왔다 — 그림은 결국
    // 뜨지만(실측: broken 0) 로드마다 헛왕복과 콘솔 에러가 쌓였다
    // (naver 메인 1회에 6건).
    //
    // 원래 프록시 경로를 박아 둔 이유는 fail-closed 였다 — blob 이 늦거나
    // 실패해도 브라우저가 타깃 오리진으로 직접 나가면 안 된다. 그 요구는
    // **요청을 아예 안 내는 값**으로 더 강하게 만족된다. 그래서 이미지에는
    // 1×1 투명 PNG 를 먼저 넣고 blob 이 오면 교체한다. 실패해도 1×1 로 남고,
    // 어느 쪽이든 밖으로 나가는 요청은 0 이다.
    const placeholder = swLessPixelable(el, key);
    Native.setAttribute.call(el, key, placeholder ? SWLESS_PIXEL : proxied);
    swLessBlobURL(proxied).then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  function proxyViaURL(absolute) {
    const s = String(absolute || '');
    if (!s) return s;
    if (s[0] === '#') return s;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(s)) return s;
    if (!/^https?:/i.test(s)) return s;
    const prefix = (typeof ZP !== 'undefined' && ZP && ZP.CONTROL_PREFIX) || '/zp/';
    return proxyOrigin + prefix + '?via=' + encodeURIComponent(s);
  }
  // 2026-06-06 backstop: NAVER / GitHub / other SPA sites use code paths
  // outside `installURLProp` setter + `setAttribute` wrap to put raw target
  // hrefs on the DOM — e.g. `cloneNode(true)` on a server-rendered template,
  // `DocumentFragment` building via direct DOM APIs that don't trip our
  // setter wraps, or strips of `data-zp-*` attributes post-load (NAVER's
  // anti-bot scrubber, see trap-notebook 2026-06-02 NAVER fingerprint
  // hide). MutationObserver re-checks every anchor / form attribute change
  // and re-applies the proxy `?via=` URL. `urlMeta` is the authoritative
  // source the click handler reads, so even if the page later strips
  // `data-zp-target-url`, the click still routes via the proxy.
  function applyNavigationBackstop(el) {
    if (!el || el.nodeType !== 1) return;
    const ln = el.localName;
    let attrName;
    if (ln === 'a' || ln === 'area') attrName = 'href';
    else if (ln === 'form') attrName = 'action';
    else if (ln === 'input' || ln === 'button') {
      if (!el.hasAttribute || !el.hasAttribute('formaction')) return;
      attrName = 'formaction';
    } else return;
    const raw = Native.getAttribute.call(el, attrName);
    if (!raw) return;
    if (raw.indexOf(proxyOrigin) === 0) return; // already proxied
    if (raw[0] === '#') return;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(raw)) return;
    let abs;
    if (/^https?:/i.test(raw)) abs = raw;
    else if (raw.indexOf('//') === 0) abs = 'https:' + raw;
    else { try { abs = new URL(raw, virtualURL.href).href; } catch { return; } }
    if (!/^https?:/i.test(abs)) return;
    urlMeta.set(el, abs);
    try { Native.setAttribute.call(el, 'data-zp-target-url', abs); } catch {}
    try { Native.setAttribute.call(el, attrName, proxyViaURL(abs)); } catch {}
  }
  // 서버측 htmltx 가 파싱 시점 `srcdoc` 을 `data-zp-srcdoc` 으로 옮겨 둔 것을
  // 되돌린다. 되돌리는 순간 후킹된 경로가 프렐류드 주입 + URL 리라이트를 한다.
  //
  // ★왜 별도 스윕이 필요한가: 최초 파싱 문서에는 MutationObserver 가 안 걸린다
  // (이 파일의 `observedDocuments` TDZ 주석 참조 — 고치면 이중 계측으로 더 크게
  // 깨진다). 그리고 기존 즉시 스윕은 `a/form/input/button/style` 만 훑는다.
  // 그래서 iframe 은 아무도 보지 않았고, 되돌리기가 영영 실행되지 않았다.
  //
  // 순서 주의: **먼저 만들고, 성공했을 때만 옮긴다.** 지우고 나서 만들면
  // injectSrcdoc 이 던졌을 때 원본까지 사라져 iframe 이 통째로 빈다.
  // 실패하면 data-zp-srcdoc 을 그대로 둔다 — 파싱되지 않으므로 fail-closed 다.
  // htmltx 가 이름만 옮겨 둔 `<iframe src>` 를 되돌린다.
  //
  // 되돌릴 때 네이티브 세터를 쓰면 안 된다 — 그러면 원본 URL 이 그대로 박혀
  // 처음 문제로 돌아간다. **후킹된 setAttribute** 를 타야 iframe 전용 경로
  // (about:blank 로 먼저 세우고 activatedFrameURL 로 share 경로를 물리는)가
  // 돈다. 실패하면 data 속성을 남겨 둔다(fail-closed): 지우고 나서 던지면
  // 프레임이 영영 빈 채로 남는다.
  function restorePendingFrameSrc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-frame-src')) return;
    const pending = Native.getAttribute.call(el, 'data-zp-frame-src') || '';
    if (!pending) { try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {} return; }
    try {
      el.setAttribute('src', pending);
      try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {}
    } catch (e) {
      try { console.warn('[ZP] frame src restore failed', String(e && (e.message || e))); } catch {}
    }
  }
  function restorePendingSrcdoc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-srcdoc')) return;
    const pending = Native.getAttribute.call(el, 'data-zp-srcdoc') || '';
    if (!setInjectedSrcdoc(el, pending)) return;
    try { Native.removeAttribute.call(el, 'data-zp-srcdoc'); } catch {}
  }
  function scanNavigationBackstop(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll(
        'a[href], area[href], form[action], input[formaction], button[formaction]'
      ).forEach(applyNavigationBackstop);
    } catch {}
    // iframe 은 위 목록에 없다 — 되돌리기를 여기서 같이 돈다.
    try {
      // ★우리 자신의 스텔스 멤브레인이 이 스윕을 가린다: 후킹된
      // querySelectorAll 은 `data-zp-*` 를 페이지에서 숨기려고 걸러내므로
      // 셀렉터가 **0개**를 돌려준다(실측: iframe 1개, 매칭 0). 내부 스윕은
      // 반드시 네이티브 쪽으로 물어야 한다.
      const qsa = Native.elementQuerySelectorAll || root.querySelectorAll;
      const found = qsa.call(root, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]');
      Array.prototype.forEach.call(found, restorePendingSrcdoc);
      const pendingSrc = qsa.call(root, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]');
      Array.prototype.forEach.call(pendingSrc, restorePendingFrameSrc);
    } catch {}
    // `<style>` 도 같은 백스톱이 필요하다. 두 가지가 새기 때문이다:
    // (a) 파서가 넣은 style 은 MutationObserver 가 붙기 **전**에 이미 문서에
    //     있어서 childList 로 안 잡힌다,
    // (b) 서버측 htmltx 는 zp_css 파싱이 실패하면 **원본을 그대로** 돌려준다
    //     (조용한 폴백) — 큰 시트 하나가 통째로 원본으로 남을 수 있다.
    // 실제로 naver 장바구니의 GNB 시트(39 KB, 원본 URL 25개)가 이 상태로
    // 남아 스프라이트가 `img-src 'self'` 에 걸렸다.
    try { root.querySelectorAll('style').forEach(enforceStyleElementCSS); } catch {}
  }
  function installNavigationBackstop(w, docEl) {
    if (!w || !docEl) return;
    // Single deferred sweep. Earlier draft also installed a
    // MutationObserver — that wedged the renderer on NAVER (Tauri/WebView2
    // can't drain the storm of attribute mutations a SPA emits during
    // hydration, even with `attributeFilter`). Setter / setAttribute wraps
    // already cover the JS hydration path; this sweep catches whatever the
    // server-side zp-htmltx rewrite missed on the initial document.
    scanNavigationBackstop(docEl);
    if (typeof w.requestIdleCallback === 'function') {
      try { w.requestIdleCallback(() => scanNavigationBackstop(docEl), { timeout: 2000 }); } catch {}
    } else if (typeof w.setTimeout === 'function') {
      try { w.setTimeout(() => scanNavigationBackstop(docEl), 1000); } catch {}
    }
    // 스타일시트는 위 두 번으로 부족하다. GNB 처럼 **로드 이후** 큰 `<style>`
    // 을 주입하는 모듈이 흔해서, 문서 생애주기 이벤트에 한 번씩 더 건다.
    // 이미 프록시 URL 인 시트는 `cssProxyURL` 이 걸러내므로 재실행은 무해하다.
    // 파싱 시점에 이름만 옮겨 둔 프레임 속성(`data-zp-frame-src` /
    // `data-zp-srcdoc`)을 되돌린다.
    //
    // 위의 백스톱은 "즉시 1회 + requestIdleCallback 1회" 인데 **스트리밍 문서에서
    // 그 두 번으로는 부족하다**: 즉시 스윕은 프렐류드가 문서 맨 앞에서 도는
    // 시점이라 body 가 아직 파싱되기 전이고, rIC 는 이 환경에서 안 도는 것으로
    // 보였다(실측: readyState=complete 인데 pending 이 그대로 남고 실패 경고도
    // 없다 = 아예 호출되지 않았다). 그래서 문서 생애주기 이벤트 + 타이머에
    // 얹어 다섯 번 더 기회를 준다. 이미 되돌아간 요소는 속성이 없어 재실행이
    // 무해하다.
    const sweepPendingFrames = () => {
      try {
        const qsa = Native.elementQuerySelectorAll || docEl.querySelectorAll;
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]'),
          restorePendingFrameSrc,
        );
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]'),
          restorePendingSrcdoc,
        );
      } catch {}
    };
    const sweepStyles = () => {
      try { docEl.querySelectorAll('style').forEach(enforceStyleElementCSS); } catch {}
      sweepSWLessFrames(w);
      sweepPendingFrames();
      // meta 는 파싱 도중에 늦게 나타날 수 있다 — 같은 청소 주기에 얹는다.
      reportMetaReferrerPolicy();
    };
    try { w.document.addEventListener('DOMContentLoaded', sweepStyles); } catch {}
    try { w.addEventListener('load', sweepStyles); } catch {}
    if (typeof w.setTimeout === 'function') {
      for (const ms of [500, 1500, 3000]) { try { w.setTimeout(sweepStyles, ms); } catch {} }
    }
  }
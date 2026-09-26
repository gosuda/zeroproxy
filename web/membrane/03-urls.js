  function preservedShareFragment(hash) {
    if (!hash) return '';
    try {
      const raw = hash[0] === '#' ? hash.slice(1) : hash;
      const params = new URLSearchParams(raw);
      const key = params.get('k');
      return key ? ZP.makeShareFragment(key, activeServers) : '';
    } catch { return ''; }
  }
  function shareFragmentForKey(key) { return ZP.makeShareFragment(String(key), activeServers); }
  function proxyHistoryURL() { return activeProxyPath + activeProxyFragment; }
  // ★프록시 경로를 **상대 경로 그대로** 브라우저에 넘기면 안 된다.
  // `location.assign` / `location.replace` / `history.pushState` 는 인자를
  // **문서의 base URL** 로 푼다. 타깃이 `<base href="http://other/">` 를 두면
  // 우리 `/zp/p/<토큰>` 이 **그 오리진**에 붙어 문서째 프록시 밖으로 나간다.
  // nav-matrix `n3-base-href` 실측: 착지 주소가
  // `http://127.0.0.1:18086/zp/p/23YKGo…` — 우리 경로인데 오리진이 타깃이다.
  // 프레임 경로(`activatedFrameURL`)는 이미 절대 URL 을 쓰고 있었다. 여기만
  // 빠져 있었고, 그래서 이 탈출은 `<base href>` 한 줄이면 성립했다.
  function proxyAbsoluteURL(pathAndFragment) {
    const raw = String(pathAndFragment || '');
    try { return new URL(raw, proxyOrigin).href; } catch { return proxyOrigin + raw; }
  }
  function nativeLocationURL() {
    try {
      const href = Native.locationHref && Native.locationHref.get && Native.locationHref.get.call(root.location);
      if (href) return new URL(href);
    } catch {}
    try { return new URL(proxyHistoryURL(), proxyOrigin); } catch { return new URL(initialProxyURL.href); }
  }
  function visibleProxyURL() { const u = nativeLocationURL(); return u.pathname + u.search + u.hash; }
  function setActiveShareRoute(share) {
    activeProxyPath = ZP.makeSharePath(share.encrypted);
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
  }
  function replaceVisibleProxyURL() {
    const next = proxyHistoryURL();
    if (visibleProxyURL() !== next) {
      try { Native.historyReplace(root.history.state, '', proxyAbsoluteURL(next)); } catch {}
    }
  }
  function refreshVisibleShareRoute(entryId, target, base) {
    const version = ++activeShareVersion;
    ZP.encryptShareURL(target).then(share => {
      return ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: base, replace: true }).then(() => share);
    }).then(share => {
      if (version !== activeShareVersion || entryId !== activeEntryId || target !== virtualURL.href) return;
      setActiveShareRoute(share);
      replaceVisibleProxyURL();
    }).catch(()=>{});
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function hasExecutableURLScheme(raw) { return /^(?:javascript|data|vbscript):/i.test(String(raw).trim()); }
  function hasDangerousURLScheme(raw) { return /^(?:javascript|vbscript):/i.test(String(raw).trim()); }
  // ★스킴이 http(s) 가 아닌 **절대** URL 은 그대로 돌려준다 (2026-08-26).
  //
  // URL 프로퍼티 게터가 값을 무조건 `targetURL()` 에 넣고 있었다. 그건
  // http(s) 만 받으므로 `blob:` / `data:` / `about:` / `mailto:` / `tel:` 은
  // 전부 **읽는 순간 TARGET_PROTOCOL_BLOCKED 를 던졌다**. 쓰기는 멀쩡히
  // 저장되므로(속성엔 원본이 그대로 있다) 증상이 "쓰고 나서 읽으면 폭발" 이다.
  //
  // CNN 실측: Max 플레이어가 `video.src = URL.createObjectURL(mediaSource)`
  // 뒤 `video.src` 를 읽다가 죽어 **비디오 세그먼트가 한 건도 안 나갔다**
  // (대조군 115건 vs 프록시 0건). `a.href` 가 `mailto:` 에서 던지는 것도
  // 같은 한 줄이다 — CNN 만의 문제가 아니다.
  //
  // 진짜 브라우저는 스킴이 있는 절대 URL 을 base 로 풀지 않고 파서 정규화만
  // 해서 돌려준다. 상대 URL(`/x`)과 조각(`#x`)은 여전히 타깃 기준으로
  // 풀어야 하므로 **스킴이 있을 때만** 이 경로를 탄다.
  function nonHTTPAbsoluteURL(raw) {
    const s = String(raw).trim();
    const m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return null;
    try { return new URL(s).href; } catch { return s; }
  }
  // Single-parse equivalent of `isHTTPURL(v) && targetURL(v)` — the previous
  // pattern parsed the URL twice (once for scheme check, once for canonical
  // form). For long URLs (signed CDN, encoded query) `new URL()` is ~1300ns
  // each, so the redundant parse doubled hot-path cost. targetURL throws
  // TARGET_PROTOCOL_BLOCKED on non-HTTP, so the catch covers both
  // "not http/https" and "malformed" cases.
  //
  // Consults tickURLCache when active (set during MutationObserver callback)
  // — same raw URL repeating within one tick parses once.
  function targetURLIfHTTP(raw) {
    const key = String(raw);
    if (tickURLCache) {
      const cached = tickURLCache.get(key);
      if (cached !== undefined) return cached;
    }
    let result;
    try { result = targetURL(key); }
    catch { result = null; }
    if (tickURLCache) tickURLCache.set(key, result);
    return result;
  }
  // Tick-local URL classification cache. Set by MO callback at tick start,
  // cleared at tick end. Pre-populated with `null` for non-HTTP URLs when
  // rt batch-classify is available, eliminating new URL() parse for those.
  // HTTP URLs are NOT pre-populated (would still need canonicalization).
  let tickURLCache = null;

  // Per-element raw → target cache. When React / Vue / similar reconciler
  // re-applies the same `src=...` to the same element across renders, we
  // skip the `new URL()` parse and return the cached canonical target.
  //
  // Distinct from tickURLCache:
  //   - tickURLCache  : dedup within a tick across all elements (by raw)
  //   - urlClassifyCache : dedup across ticks per element (raw → target)
  //
  // Stored as { lastRaw, target } per element. Overwritten on new raw.
  // WeakMap so GC removes entries when element is detached.
  const urlClassifyCache = new WeakMap();
  function targetURLForElement(el, raw) {
    const key = String(raw);
    const cached = urlClassifyCache.get(el);
    if (cached && cached.lastRaw === key) return cached.target;
    const target = targetURLIfHTTP(key);
    if (target) urlClassifyCache.set(el, { lastRaw: key, target });
    return target;
  }
  function shouldBlockURLAttribute(el, key, raw, _localKey, _tag) {
    const tag = _tag != null ? _tag : (el && el.localName);
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    const strict = localKey === 'src' && tag === 'script' || localKey === 'src' && (tag === 'iframe' || tag === 'frame') || usesRawURLAttribute(el, key, localKey);
    return strict ? hasExecutableURLScheme(raw) : hasDangerousURLScheme(raw);
  }
  // A3 hardening: blob: URLs are legitimate for <img>/<video>/<audio>/<source>
  // (target sites build them from Blob data) but must never feed <script>,
  // <iframe>, <frame>, or <embed>/<object> — those would bypass the
  // OXC rewrite pipeline and run unclassified target code.
  function hasContextBlockedScheme(el, raw) {
    const s = String(raw).trim();
    if (!/^blob:/i.test(s)) return false;
    const tag = el && el.localName;
    return tag === 'script' || tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object';
  }
  function blockedURLValue(el, key) { const tag = el && el.localName; return key === 'src' && (tag === 'iframe' || tag === 'frame') ? 'about:blank' : key === 'src' && tag === 'script' ? ZP.errorPath('POLICY_BLOCKED') : '#'; }
  function blockExecutableURL(el, key, raw) {
    // D4: 런타임이 꽂은 `a.href="javascript:…"` / `form action="javascript:…"`
    // 도 정적 htmltx 와 같은 의미로 — 재작성된 본문을 data-zp-jsurl 에 stash
    // 하고 속성은 void(0) 로 둔다. 위임 click/submit 핸들러가 실행한다.
    const tag = el && el.localName;
    const s = String(raw).trim();
    const colon = s.indexOf(':');
    if (/^javascript:/i.test(s) && ((key === 'href' && (tag === 'a' || tag === 'area')) || (key === 'action' && tag === 'form'))) {
      try {
        const code = callPageRewriter(s.slice(colon + 1), 'classic');
        Native.setAttribute.call(el, 'data-zp-jsurl', code);
        Native.setAttribute.call(el, 'data-zp-jsurl-kind', tag === 'form' ? 'form' : 'anchor');
        Native.setAttribute.call(el, key, 'javascript:void(0)');
        return;
      } catch {}
    }
    urlMeta.delete(el); Native.setAttribute.call(el, 'data-zp-target-url', ''); Native.setAttribute.call(el, 'data-zp-blocked-url', s); Native.setAttribute.call(el, key, blockedURLValue(el, key)); if (key === 'src' && (el.localName === 'iframe' || el.localName === 'frame')) instrumentIframe(el);
  }
  // ★타깃이 페이지 realm 에서 `<meta http-equiv="Content-Security-Policy">` 를
  // 꽂으면 그 정책이 **우리 문서에 실제로 적용된다**(2026-08-21 실측: 주입 전
  // 이미지 LOADED → `img-src 'none'` 주입 후 BLOCKED). 서버측 htmltx 는 정적
  // HTML 의 같은 표면을 이미 무력화하는데 페이지 realm 에만 없었다.
  //
  // **탈출은 아니다** — 정책은 교집합이라 타깃이 느슨하게 만들 수 없고,
  // `report-uri` 는 브라우저가 meta 전달 시 무시한다(크롬이 직접 그렇게 찍는다:
  // "'report-uri' is ignored when delivered via a <meta> element"). 즉 릴레이를
  // 우회하는 보고 egress 도 안 열린다. 문제는 **우리 런타임을 죽일 수 있다는 것**
  // 이다 — `script-src 'none'` 이면 멤브레인이 붙인 스크립트가, `connect-src 'none'`
  // 이면 릴레이 트랜스포트가 막힌다. 그리고 정책이 먹히는지 여부 자체가 지문이다.
  //
  // htmltx 와 **같은 백업 속성**을 쓴다.
  // `origin-trial` sits in the same bucket: a token is signed for ONE
  // registered origin — but anyone can register a trial for any origin
  // string, including our proxy origin. Left live, a target document could
  // arm an origin trial on OUR realm. Renamed like CSP so page code
  // reading its own meta still finds the value.
  const CSP_EQUIV = ['content-security-policy', 'content-security-policy-report-only', 'origin-trial'];
  function isCSPHttpEquiv(value) {
    return CSP_EQUIV.indexOf(String(value || '').trim().toLowerCase()) >= 0;
  }
  // E2: meta CSP 는 헤더 CSP 와 합성 적용이라 살려 둬도 엄격화만 가능하다.
  // filterMetaCSP(zp-shared::csp::filter_meta_csp 의 JS 미러)가 배관 필수
  // 소스를 얹은 교집합을 만든다 — 남는 지시어가 없을 때만 무력화한다.
  // origin-trial 은 토큰이지 CSP 가 아니다 — 무조건 무력화.
  function neutralizeCSPMeta(el, value) {
    Native.setAttribute.call(el, 'data-zp-blocked-http-equiv', String(value));
    const eq = String(value || '').trim().toLowerCase();
    if (eq === 'content-security-policy' || eq === 'content-security-policy-report-only') {
      const content = Native.getAttribute ? Native.getAttribute.call(el, 'content') : null;
      const filtered = content != null ? ZP.filterMetaCSP(content) : '';
      if (filtered) {
        // observer 가 이 setAttribute 를 다시 본다 — 이미 필터된 값이면
        // (content === filtered) 스태시를 덮지 않고 쓰지도 않는다.
        if (content !== filtered) {
          try { Native.setAttribute.call(el, 'data-zp-blocked-content', String(content)); } catch {}
          try { Native.setAttribute.call(el, 'content', filtered); } catch {}
        }
        // http-equiv 가 content 보다 먼저 처리돼 지워진 경우 되살린다.
        if (Native.getAttribute.call(el, 'http-equiv') == null) {
          try { Native.setAttribute.call(el, 'http-equiv', eq); } catch {}
        }
        return;
      }
    }
    if (Native.removeAttribute) { try { Native.removeAttribute.call(el, 'http-equiv'); } catch {} }
  }
  function isIntegrityBearing(el) { const tag = el && el.localName; return tag === 'script' || tag === 'link'; }
  function backedIntegrity(el) { return isIntegrityBearing(el) ? Native.getAttribute.call(el, integrityBackupAttr) : null; }
  function setBackedIntegrity(el, value) { Native.setAttribute.call(el, integrityBackupAttr, String(value)); if (Native.removeAttribute) Native.removeAttribute.call(el, 'integrity'); }
  // ★프록시 정체가 페이지로 샌 값을 **소비 지점에서** 되돌리는 단일 게이트.
  //
  // 왜 원천 차단이 아니라 게이트인가: `location` 의 프로퍼티는
  // [LegacyUnforgeable] (own, `configurable:false`) 이라 멤브레인이 가릴 수
  // 없다. 게다가 동적/난독화 코드는 `eval("this")` 로 진짜 window 를 잡은 뒤
  // `w[decode("location")]` 같은 **computed access** 로 읽어서 리라이터도 그
  // 자리를 정적으로 볼 수 없다. 즉 이 누출은 원천 차단이 불가능하고,
  // **값이 타깃 URL 이 되는 지점**에서 되돌리는 것만이 가능하다.
  //
  // 페이지가 준 raw 가 타깃이 되는 입구는 딱 셋이다. 셋 다 여길 통과한다:
  //   targetURL()        — DOM URL 속성 / 네비게이션 / form action
  //   requestTargetURL() — fetch / XHR / EventSource
  //   targetWSURL()      — WebSocket
  //
  // 인식 대상은 **우리 라우팅 어휘뿐**이다. `/zp/` 로 시작한다고 무조건
  // 삼키면 타깃 사이트에 진짜 `/zp/…` 경로가 있을 때 그 사이트를 깨뜨린다.
  //
  // 반환값: 교체할 raw 문자열, 또는 `null` = "우리 것이다 — 현재 가상 문서
  // URL 로 대체하라". ws/wss 로 바꿔야 하는 쪽이 있어서 문자열 하나로
  // 뭉뚱그리지 않고 호출자가 스킴을 결정하게 둔다.
  function proxyLocalPath(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';
    // 루트 상대 경로. `//host/x` 는 프로토콜 상대라 아래에서 따로 본다.
    if (s[0] === '/' && s[1] !== '/') { const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h); }
    const abs = s.slice(0, 2) === '//' ? 'http:' + s : s;
    // 스킴 없는 상대 경로(`foo.js`)를 프록시 오리진에 붙여 보면 안 된다 —
    // 전부 우리 것으로 오인한다.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(abs)) return '';
    let u;
    try { u = new URL(abs); } catch { return ''; }
    return u.host === proxyHost ? u.pathname + u.search : '';
  }
  function unleakedTargetRaw(raw) {
    const s = String(raw == null ? '' : raw);
    // 이미 **타깃 오리진에 붙어 버린** 우리 경로도 잡는다. 페이지가
    // `new URL(location.pathname, document.baseURI)` 로 만들면 호스트가
    // 타깃이라 아래 프록시-호스트 검사에 안 걸린다. 지금 share 경로와
    // **바이트가 같을 때만** 본다 — 그건 고엔트로피 암호 토큰이라 타깃
    // 사이트의 실제 경로와 겹칠 수 없다.
    if (activeProxyPath && s.indexOf(activeProxyPath) >= 0) {
      try { if (new URL(s, baseURL).pathname === activeProxyPath) return null; } catch {}
    }
    const local = proxyLocalPath(s);
    if (!local) return s;
    const qi = local.indexOf('?');
    const path = qi < 0 ? local : local.slice(0, qi);
    const params = qi < 0 ? null : new URLSearchParams(local.slice(qi + 1));
    // (a) 서브리소스 래퍼 — 진짜 타깃이 안에 들어 있다.
    if ((path === ZP.apiPath('fetch') || path === ZP.apiPath('v2/fetch')) && params && params.get('url')) return params.get('url');
    // (b) 네비게이션 런처 — 마찬가지.
    if (path === ZP.controlPath('') && params && params.get('via')) return params.get('via');
    // (c) share 경로 — 암호화된 우리 라우팅 키다. 타깃에 실려 나가면 안 되고,
    //     타깃 오리진에 붙여 dial 해도 언제나 오답이다.
    //     Cloudflare 챌린지가 통과 직후 `form.action = location.pathname` 으로
    //     정확히 이 값을 심어 `https://<target>/zp/p/<token>` 을 POST 했다.
    if (ZP.isSharePath(path)) return null;
    return s;
  }
  function targetURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalTargetURL(g === null ? virtualURL.href : g, base).href;
  }
  function targetWSURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalWebSocketURL(g === null ? virtualURL.href.replace(/^http/, 'ws') : g, base.replace(/^http/, 'ws')).href;
  }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin, activeServers); }
  function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
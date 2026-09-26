  // ★★ 이 `const` 를 위(선언 블록)로 올리지 말 것 — "명백한 TDZ 버그" 처럼
  // 보이지만, 올리면 더 크게 깨진다. 실제로 올려서 측정했다(2026-08-16):
  //  - 지금은 prelude 초기화 중 installNetworkContainment → installBaseObserver
  //    호출이 TDZ 로 던지고 아래 `catch { return }` 가 삼켜서, **최초 문서에는
  //    이 옵저버가 안 걸린다**. (Cloudflare 인터스티셜에서 pause-on-exception
  //    으로 `ReferenceError: Cannot access 'bn' before initialization` 확인.)
  //  - 선언을 올려 그 호출이 성공하게 만들면 옵저버가 곧바로
  //    enforceSubtreePolicies / instrumentDescendantIframes 를 돌리는데, 이미
  //    계측된 창을 **두 번째로** 계측하면서 `TypeError: Cannot redefine
  //    property: <userAgent|href|innerHTML|serviceWorker|…>` 가 로드당 85건
  //    쏟아진다(= 위 "두 번째 시도는 무조건 던진다" 그 자리들).
  //    구멍 매트릭스 회귀: c5-beacon, c6-beacon-cross, e4-blank-iframe-img 가
  //    새로 깨진다(6건 → 9건). 나머지 축(진짜 유출 0)은 유지.
  // 즉 TDZ 가 **이중 계측 버그를 가려 주고 있다**. 순서를 고치려면 계측
  // 멱등성부터 고쳐야 한다 — 그건 별건이다.
  const observedDocuments = new WeakSet();
  function installBaseObserver(doc) {
    doc = doc || document;
    try { if (observedDocuments.has(doc)) return; } catch { return; }
    syncBaseElement(doc);
    // iframe Document 도 root.MutationObserver 로 관찰 가능 (cross-realm —
    // observer 는 부모 realm 의 MO 라도 child doc 을 정상 observe 한다).
    const MO = (doc.defaultView && doc.defaultView.MutationObserver) || root.MutationObserver;
    if (!MO || !doc.documentElement) return;
    try {
      new MO(records => {
        try { zpTrace('mo', 'n=' + records.length); } catch {}
        // Tick-scoped URL canonicalization cache — eliminates duplicate
        // `new URL()` parses for the same raw URL appearing across multiple
        // records (targetURLIfHTTP consults this cache; cached null short-
        // circuits the parse for definitively non-HTTP URLs).
        //
        // Pre-classify URL-attribute mutations with rt.classifySchemeOnly
        // when available — its ASCII fast path (~120-140 ns/op, beats JS
        // regex 153-200 ns) is cheap per call. Bench (Q round): schemeOnly
        // N times beats classifyBatch 2.1× because the batch ABI carries
        // ~280 ns/item production overhead (lens write, result view, scratch
        // layout) and does intern work the MO callback doesn't need.
        //
        // No threshold gate — the per-call cost is small enough that even
        // a single-mutation tick benefits when the URL turns out to be
        // non-HTTP (saves the 1300 ns new URL throw cost). For HTTP URLs
        // the ~120 ns is overhead but dwarfed by the main loop's parse.
        // Keep this cache scoped to one mutation batch; DOM bases may change later.
        tickURLCache = new Map();
        try {
          if (rt) {
            const HTTP = rt.UrlClass.HTTP, WS = rt.UrlClass.WS;
            for (const r of records) {
              if (r.type !== 'attributes') continue;
              const raw = Native.getAttribute.call(r.target, String(r.attributeName || ''));
              if (!raw || tickURLCache.has(raw)) continue;
              try {
                const cls = rt.classifySchemeOnly(raw);
                if (cls !== HTTP && cls !== WS) tickURLCache.set(raw, null);
              } catch { /* WASM hiccup — fall through to per-record main loop */ }
            }
          }
          for (const r of records) {
            if (r.type === 'attributes') enforceObservedAttribute(r.target, String(r.attributeName || '').toLowerCase());
            else for (const n of r.addedNodes || []) { syncBaseElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n); }
          }
        } finally {
          tickURLCache = null;
        }
      }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'data', 'http-equiv', 'content', 'ping'] });
      observedDocuments.add(doc);
    } catch {}
  }
  function enforceObservedAttribute(el, key) {
    if (!el || !key) return;
    const localKey = attrLocalName(key);
    const tag = el.localName;
    if (tag === 'base' && localKey === 'href') { syncBaseElement(el); return; }
    if (tag === 'link' && (localKey === 'rel' || localKey === 'href')) { enforceLinkPolicy(el); return; }
    // Meta mutations that bypassed the setAttribute hook (Attr.value writes,
    // parser-inserted nodes): re-arm refresh on the proxied URL, neutralize CSP.
    if (tag === 'meta' && (localKey === 'http-equiv' || localKey === 'content')) { enforceMetaPolicy(el); return; }
    // `ping` on parser-inserted anchors — the browser POSTs this beacon list
    // itself on click; CSP can't see it, only we can strip it.
    if (localKey === 'ping' && (tag === 'a' || tag === 'area')) {
      const raw = Native.getAttribute.call(el, key);
      if (raw != null) { Native.setAttribute.call(el, 'data-zp-blocked-ping', raw); Native.removeAttribute.call(el, key); }
      return;
    }
    if (localKey === 'sandbox' && isFrameElement(el)) { sanitizeFrameSandbox(el); return; }
    if (localKey === 'target' && isNavigationTargetElement(el)) { const raw = Native.getAttribute.call(el, key); if (raw && raw !== '_self') setSafeNavigationTarget(el, key, raw); return; }
    if (tag === 'script' && (localKey === 'src' || localKey === 'href' || localKey === 'type')) {
      const target = urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || '';
      if (target && Native.getAttribute.call(el, 'src') === scriptProxyPath(target, executableScriptKindForElement(el) || 'classic')) return;
      const raw = target || Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
      if (raw) setScriptSource(el, raw);
      return;
    }
    if (localKey === 'integrity' && isIntegrityBearing(el)) {
      const raw = Native.getAttribute.call(el, 'integrity');
      if (raw !== null) setBackedIntegrity(el, raw);
      return;
    }
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'srcdoc') {
      const raw = Native.getAttribute.call(el, 'srcdoc');
      // 재주입 방지는 이제 WeakMap 이 본다. 문자열 접두 비교는 `?v=` 버전
      // 쿼리를 달고 다녀서 늘 아슬아슬했다 — 뒤의 비교는 남은 안전망이다.
      if (raw && !srcdocMeta.has(el) && !raw.startsWith(injectSrcdoc(''))) setInjectedSrcdoc(el, raw);
      instrumentIframe(el);
      return;
    }
    if (!isURLBearing(el, key, localKey, tag)) return;
    if (localKey === 'srcset' || localKey === 'imagesrcset') {
      const list = Native.getAttribute.call(el, key);
      if (list) enforceSrcsetAttribute(el, key, String(list));
      return;
    }
    const raw = Native.getAttribute.call(el, key);
    if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || hasContextBlockedScheme(el, raw)) { blockExecutableURL(el, localKey, raw); return; }
    if (!raw) return;
    // 이미 프록시 경로인 값도 그냥 지나치면 안 된다: SW 를 못 거치는 프레임
    // 안이면 그 경로가 Go 서버로 직행해 403 이 된다. HTML 워커가 문자열
    // 단계에서 리라이트한 URL 은 요소 훅을 아예 안 타므로, 여기(서브트리
    // 스윕)가 그것들을 만나는 유일한 지점이다.
    if (String(raw).startsWith(proxyOrigin)) { upgradeSWLessURL(el, key, String(raw)); return; }
    // ★blob: 은 그냥 둔다. 위험한 태그(script/iframe/embed/object)는 바로 위
    // hasContextBlockedScheme 이 이미 막았고, 남은 건 봉인된 값이다 — SW-less
    // 프레임에 우리가 물려준 것이거나 페이지가 자기 Blob 으로 만든 것이고
    // 어느 쪽이든 밖으로 못 나간다. 여기서 target 을 다시 계산해 프록시
    // 경로로 덮으면 방금 넣은 blob 이 되돌려져 403 이 나고, 그 403 이 또
    // blob 업그레이드를 불러 왕복이 된다. e4-blank-iframe-img 가 이것 때문에
    // 간헐적으로 깨졌다.
    if (/^blob:/i.test(String(raw))) return;
    // 자리끼우개도 같은 이유로 그냥 둔다 — 여기서 프록시 경로로 되돌리면
    // 방금 없앤 403 왕복이 그대로 되살아난다.
    if (String(raw) === SWLESS_PIXEL) return;
    const target = targetURLForElement(el, raw);
    if (!target) return;
    const usesRaw = usesRawURLAttribute(el, key, localKey);
    const alreadyMapped = urlMeta.get(el) === target && (!usesRaw ? Native.getAttribute.call(el, 'data-zp-target-url') === target : true);
    urlMeta.set(el, target);
    if (!usesRaw) Native.setAttribute.call(el, 'data-zp-target-url', target);
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src') {
      Native.setAttribute.call(el, key, 'about:blank');
      activatedFrameURL(target).then(u => { Native.setAttribute.call(el, key, u); rememberFrameOrigin(el); }).catch(()=>{});
      instrumentIframe(el);
      return;
    }
    if (alreadyMapped) return;
    // 수동 서브리소스는 프록시 경로로 (htmltx 와 동일). navigation 속성은
    // usesRaw 쪽에서 이미 '?via=' 형태로 처리된다.
    if (!usesRaw) setSubresourceAttribute(el, key, subresourceProxyPath(target));
  }
  // `<style>` 의 텍스트가 **자식 텍스트 노드로** 들어오는 경로. prelude 의
  // textContent/innerHTML 훅은 프로퍼티 쓰기만 덮으므로
  //   s = createElement('style'); head.appendChild(s);
  //   s.appendChild(document.createTextNode(css));
  // 는 통째로 새어 나간다. jQuery 계열이 쓰는 아주 흔한 관용구다 —
  // naver.com 장바구니의 GNB 스프라이트가 정확히 이 경로로 원본 URL 을
  // 유지한 채 `img-src 'self'` 에 걸려 아이콘이 통째로 안 떴다.
  function enforceStyleElementCSS(el) {
    if (!el || el.localName !== 'style') return;
    const get = Native.nodeTextContent && Native.nodeTextContent.get;
    const raw = (get ? get.call(el) : el.textContent) || '';
    if (!raw) return;
    const mapped = rewriteCSSText(raw);
    if (mapped === raw) return;
    // 프로퍼티 훅(`HTMLStyleElement.prototype.textContent`)을 **일부러** 탄다.
    // 네이티브 setter 를 직접 부르는 판이 실측에서 이 시트를 안 고쳤다.
    // 훅 경로는 같은 시트를 25/25 고치는 것이 확인됐고, 이미 프록시 URL 인
    // 값은 `cssProxyURL` 이 걸러내므로 재진입해도 idempotent 다.
    try { el.textContent = mapped; } catch {}
  }
  function enforceSubtreePolicies(node) {
    if (!node || typeof node !== 'object') return;
    // 추가된 것이 텍스트 노드면 그 자체는 정책 대상이 아니지만, 부모가
    // `<style>` 이면 방금 CSS 가 주입된 것이다.
    if (node.nodeType === 3 && node.parentNode) enforceStyleElementCSS(node.parentNode);
    if (node.nodeType === 1) enforceElementPolicy(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('script,link,iframe,frame,a,area,form,input,button,img,source,audio,video,track,object,embed,svg a,svg image,svg use').forEach(enforceElementPolicy);
      node.querySelectorAll('style').forEach(enforceStyleElementCSS);
    }
  }
  function enforceElementPolicy(el) {
    if (!el || !el.localName) return;
    if (el.localName === 'style') enforceStyleElementCSS(el);
    if (el.localName === 'script') instrumentScriptElement(el);
    if (el.localName === 'link') enforceLinkPolicy(el);
    if (el.localName === 'iframe' || el.localName === 'frame') instrumentIframe(el);
    if (Native.getAttributeNames) {
      for (const name of Native.getAttributeNames.call(el)) enforceObservedAttribute(el, String(name).toLowerCase());
    }
  }
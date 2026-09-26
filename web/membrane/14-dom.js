
  function installStealthMembrane(w) {
    if (!w || !w.Document || !w.Element) return;
    try { if (w[stealthMarker]) return; Object.defineProperty(w, stealthMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    const docGetTags = w.Document.prototype.getElementsByTagName;
    const elemGetTags = w.Element.prototype.getElementsByTagName;
    if (typeof docGetTags === 'function') define(w.Document.prototype, 'getElementsByTagName', function(tag) {
      const raw = docGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    if (typeof elemGetTags === 'function') define(w.Element.prototype, 'getElementsByTagName', function(tag) {
      const raw = elemGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    const scriptsDesc = Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts') || Native.documentScripts;
    if (scriptsDesc && scriptsDesc.get) try { defineMasked(w.Document.prototype, 'scripts', { get() { return filteredCollection(scriptsDesc.get.call(this), node => !isZPAssetNode(node)); }, configurable: false }); } catch {}
    const docQS = w.Document.prototype.querySelector;
    const docQSA = w.Document.prototype.querySelectorAll;
    const elemQS = w.Element.prototype.querySelector;
    const elemQSA = w.Element.prototype.querySelectorAll;
    if (typeof docQS === 'function') define(w.Document.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(docQS.apply(this, arguments)); });
    if (typeof elemQS === 'function') define(w.Element.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(elemQS.apply(this, arguments)); });
    // ★표면이 raw 를 따라가므로 **빈 결과에도 진짜 NodeList** 를 줘야 한다.
    // 빈 배열을 감싸면 `item` 이 없고 `forEach` 는 있는, NodeList 도
    // HTMLCollection 도 아닌 잡종이 나온다. 분리된 요소에 네이티브 qSA 를 걸면
    // 언제나 비어 있는 진짜 NodeList 다.
    let emptyList = null;
    const emptyNodeList = () => {
      if (!emptyList) {
        try { emptyList = Native.elementQuerySelectorAll.call(w.document.createElement('i'), '*'); }
        catch { emptyList = []; }
      }
      return emptyList;
    };
    if (typeof docQSA === 'function') define(w.Document.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(docQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    if (typeof elemQSA === 'function') define(w.Element.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(elemQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    const matches = w.Element.prototype.matches;
    const closest = w.Element.prototype.closest;
    if (typeof matches === 'function') define(w.Element.prototype, 'matches', function(sel) { return selectorTargetsZP(sel) ? false : matches.apply(this, arguments); });
    if (typeof closest === 'function') define(w.Element.prototype, 'closest', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(closest.apply(this, arguments)); });
    const nodeIterator = w.Document.prototype.createNodeIterator;
    if (typeof nodeIterator === 'function') define(w.Document.prototype, 'createNodeIterator', function() { return filteredTraversal(nodeIterator.apply(this, arguments)); });
    const treeWalker = w.Document.prototype.createTreeWalker;
    if (typeof treeWalker === 'function') define(w.Document.prototype, 'createTreeWalker', function() { return filteredTraversal(treeWalker.apply(this, arguments)); });
  }
  function shouldFilterTag(tag) {
    const t = String(tag || '').toLowerCase();
    return t === '*' || t === 'script' || t === 'meta' || t === 'link';
  }
  function selectorTargetsZP(selector) {
    const s = String(selector || '').toLowerCase();
    return s.includes('data-zp-') || s.includes('#__zp-boot') || s.includes('/zp/assets/') || s.includes('x-zeroproxy-icon');
  }
  function filterSelectorOne(node) { return isZPAssetNode(node) ? null : node; }
  function filteredTraversal(raw) {
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'nextNode' || prop === 'previousNode') return function() {
          let node;
          do { node = target[prop](); } while (node && isZPAssetNode(node));
          return node;
        };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      // ★receiver 를 기본값(=이 프록시)으로 두면 안 된다. 기본 set 트랩은
      // 프로토타입의 **네이티브 세터**를 receiver 로 호출하는데, 프록시에는
      // 내부 슬롯이 없어 `Illegal invocation` 으로 거부된다. 읽기는 get 트랩이
      // 언랩해 주므로 멀쩡해 보이고 쓰기만 조용히 죽는다.
      // Lit 의 템플릿 생성 경로가 모듈 스코프 워커를 재사용하며
      // `walker.currentNode = tpl.content` 를 쓴다 → Lit 기반 사이트가 통째로
      // 깨진다(developer.mozilla.org 실측: 로드당 Illegal invocation 77건,
      // 직접 로드에서는 0건).
      set(target, prop, value) { return Reflect.set(target, prop, value, target); }
    });
  }


  function installDOMHooks(w) {
    const inIframeRealm = (w !== root);
    const transformHTMLOpts = inIframeRealm ? { inIframe: true } : undefined;
    // `document.write` 는 **목적지 문서를 인자로 들고 있는 유일한 지점**이다
    // (`this`). 그 문서가 SW 클라이언트가 아니면 서브리소스 경로를 릴레이로
    // 바꿔야 하는데, 그 판정을 할 수 있는 곳이 여기뿐이다.
    const writeOptsFor = doc => {
      let swLess = false;
      try { swLess = documentIsSWLess(doc); } catch {}
      if (!swLess) return transformHTMLOpts;
      return inIframeRealm ? { inIframe: true, swLess: true } : { swLess: true };
    };
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      // Hot path: cache `this.localName` (10× read across branches → 1 DOM getter)
      // and inline `attrLocalName` since `key` is already lowercase (avoids
      // redundant String/toLowerCase inside attrLocalName).
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // ★`data-zp-*` 는 **닫힌 이름공간**이다 — 읽기가 이미 null 이므로 쓰기도
      // 없던 일로 해야 앞뒤가 맞는다. 안 막았더니 페이지가 `data-zp-internal`
      // 을 자기 노드에 심어 **자기 자신을 querySelectorAll 에서 지울 수** 있었다
      // (실측: 1건 → 0건).
      if (isZPAttrName(key)) return undefined;
      // `ping` 은 프로퍼티뿐 아니라 속성으로도 들어온다. 여기서도 삼킨다
      // (위 프로퍼티 훅과 같은 이유 — CSP 가 아니라 우리가 막아야 한다).
      if (localKey === 'ping' && (ln === 'a' || ln === 'area')) {
        try { Native.setAttribute.call(this, 'data-zp-blocked-ping', String(v)); } catch {}
        try { Native.removeAttribute.call(this, 'ping'); } catch {}
        return;
      }
      // meta 로 실려 온 CSP 는 무력화한다(htmltx 와 같은 처리).
      if (ln === 'meta' && localKey === 'http-equiv' && isCSPHttpEquiv(v)) return neutralizeCSPMeta(this, v);
      // Dynamic meta refresh: `http-equiv=refresh` + `content` arming happens
      // natively the moment both attrs exist — rewrite the URL arm before the
      // browser can fire it, in whichever order the attrs are written.
      if (ln === 'meta' && localKey === 'http-equiv' && String(v).trim().toLowerCase() === 'refresh') {
        const cur = Native.getAttribute.call(this, 'content');
        if (cur != null) { const next = proxiedRefreshContent(cur); if (next) Native.setAttribute.call(this, 'content', next); }
        return Native.setAttribute.call(this, k, v);
      }
      if (ln === 'meta' && localKey === 'content' && String(Native.getAttribute.call(this, 'http-equiv') || '').trim().toLowerCase() === 'refresh') {
        const next = proxiedRefreshContent(v);
        return Native.setAttribute.call(this, k, next || v);
      }
      // E2: http-equiv=CSP 가 먼저 stash 된 meta 에 content 가 뒤에 오는 순서.
      // MutationObserver 의 비동기 재장전만 믿으면 그 사이 시작된 로드가
      // 정책 없이 나간다(실측: append 직후 img.src 가 img-src 'none' 을 무시).
      // content 를 쓰는 즉시 필터 + http-equiv 재장전으로 **동기적** 무장.
      if (ln === 'meta' && localKey === 'content') {
        const eqLive = String(Native.getAttribute.call(this, 'http-equiv') || '').trim().toLowerCase();
        const eqStash = String(Native.getAttribute.call(this, 'data-zp-blocked-http-equiv') || '').trim().toLowerCase();
        const cspEq = isCSPHttpEquiv(eqLive) ? eqLive : isCSPHttpEquiv(eqStash) ? eqStash : '';
        if (cspEq) {
          try { Native.setAttribute.call(this, k, v); } catch {}
          neutralizeCSPMeta(this, cspEq);
          return;
        }
      }
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (localKey === 'target' && isNavigationTargetElement(this)) return setSafeNavigationTarget(this, k, v);
      if (ln === 'link' && localKey === 'rel') {
        const value = String(v);
        if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
        const ret = Native.setAttribute.call(this, k, v);
        enforceLinkPolicy(this);
        return ret;
      }
      if (ln === 'link' && localKey === 'href' && (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this))) return blockLinkURL(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (key.startsWith('on') && key.length > 2) return Native.setAttribute.call(this, k, rewriteEventAttribute(String(v)));
      if (ln === 'base' && localKey === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      // `style` 속성도 url() 을 실어 나른다 — CSSStyleDeclaration 훅은 프로퍼티
      // 경로만 덮으므로 여기서 따로 잡는다.
      if (localKey === 'style' && v != null) { litSet(this, 'style', v); return Native.setAttribute.call(this, k, rewriteCSSText(v)); }
      if (isURLBearing(this, key, localKey, ln)) {
        // ★srcset 은 URL 하나가 아니다 — 여기 분기가 **없어서** 아래 단일 URL
        // 경로가 후보 목록 전체를 한 덩어리 URL 로 삼켰다. 2026-08-21 실측:
        //   img.setAttribute('srcset', '/a.png 1x, /b.png 2x')
        //   → ?url=…%2Fa.png%25201x%2C%2520%2Fb.png%25202x  (후보 둘 다 사망)
        // 서브트리 스윕에는 이 분기가 있었는데 요소 훅에는 없었다 — 또 같은
        // "한쪽 경로에만 넣은" 사고다.
        if (localKey === 'srcset' || localKey === 'imagesrcset') {
          litSet(this, localKey, v == null ? '' : v);
          Native.setAttribute.call(this, k, v == null ? '' : String(v));
          enforceSrcsetAttribute(this, k, String(v == null ? '' : v));
          return;
        }
        // 2026-08-13 — fragment-only URL (`#`, `#tab`) 은 same-document 앵커다.
        // 절대 URL 로 풀어 "?via=" launcher 로 바꾸면 두 가지가 깨진다:
        // (a) 문서 내 이동이 전체 내비게이션처럼 보이고,
        // (b) clickNavigationTarget 의 `raw === '#'` 위임 경로가 무력화된다 —
        //     raw 가 더 이상 '#' 이 아니라 절대 URL 이므로. 그 결과 클릭이
        //     preventDefault + stopImmediatePropagation 으로 삼켜져 페이지의
        //     onClick 이 영영 실행되지 않는다. NAVER 로그인 후 MY 패널의
        //     메일/카페 **탭**(`<a href="#" role="tab">`)이 정확히 이 케이스로
        //     죽어 있었다. fragment 는 origin 을 벗어나지 않으므로 그대로
        //     둬도 탈출 위험이 없다.
        const rawURLValue = v == null ? '' : String(v);
        if (rawURLValue.charCodeAt(0) === 35 /* '#' */) {
          urlMeta.delete(this);
          litDel(this, localKey);
          if (Native.removeAttribute) { try { Native.removeAttribute.call(this, 'data-zp-target-url'); } catch {} }
          return Native.setAttribute.call(this, k, rawURLValue);
        }
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln) || hasContextBlockedScheme(this, v)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          litSet(this, localKey, rawURLValue);
          // 2026-06-06 escape vector fix: always stash absolute target on
          // data-zp-target-url + write a proxy-origin "?via=" URL on the raw
          // attribute for anchor/area href / form action / formaction.
          // Previously `usesRaw ? v : t` put the absolute target on the DOM
          // attribute (leaking to hover/middle-click/copy-link).
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          if ((ln === 'iframe' || ln === 'frame') && localKey === 'src') {
            Native.setAttribute.call(this, k, 'about:blank');
            activatedFrameURL(t).then(u => { Native.setAttribute.call(this, k, u); rememberFrameOrigin(this); }).catch(()=>{});
            return;
          }
          if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, t);
          if (usesRaw) return Native.setAttribute.call(this, k, proxyViaURL(t));
          return setSubresourceAttribute(this, k, subresourceProxyPath(t));
        }
      }
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc') { setInjectedSrcdoc(this, v); return undefined; }
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // `setAttributeNS(null, name, v)` 는 명세상 HTML 요소에서 `setAttribute`
      // 와 같은 속성을 만든다. 그런데 여기 로직은 위 setAttribute 훅의 **부분
      // 집합**이라 같은 호출이 다른 결과를 냈다 — 실측: `img.setAttribute` 는
      // 프록시 경로를 쓰는데 `img.setAttributeNS(null,'src',…)` 는 타깃 절대
      // URL 을 그대로 써서 원본 요청이 그대로 나갔다(CSP 만 막고 있었다).
      // ping/srcdoc/iframe/base/style/fragment 처리도 전부 여기엔 없다.
      // 그래서 **같은 뜻이면 같은 코드로 보낸다**: 이름이 이미 소문자이고
      // (setAttribute 는 HTML 요소에서 이름을 소문자화하므로 그때만 등가다)
      // 네임스페이스가 없으면 setAttribute 훅에 위임한다. xlink:href 같은
      // 진짜 네임스페이스 속성만 아래 경로로 남는다.
      if ((ns === null || ns === undefined || ns === '') && String(k) === key) {
        return this.setAttribute(k, v);
      }
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (isURLBearing(this, key, localKey, ln)) {
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          litSet(this, localKey, v);
          // 2026-06-06 escape vector fix: same rationale as setAttribute
          // path above — anchor/area href / form action / formaction must
          // not leak the absolute target URL through the raw DOM attribute.
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          // 서브리소스는 **프록시 경로**를 쓴다. 예전엔 `t`(타깃 절대 URL)를
          // 그대로 썼는데, 그러면 브라우저가 타깃으로 직접 나간다.
          return Native.setAttributeNS.call(this, ns, k, usesRaw ? proxyViaURL(t) : subresourceProxyPath(t));
        }
      }
      return Native.setAttributeNS.call(this, ns, k, key.startsWith('on') && key.length > 2 ? rewriteEventAttribute(String(v)) : v);
    });
    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) {
      const owner = namedNodeMapOwners.get(this);
      return owner ? attachAttributeNode(owner, attr, false) : Native.namedSetNamedItem.call(this, attr);
    });
    if (Native.namedSetNamedItemNS && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItemNS', function(attr) {
      const owner = namedNodeMapOwners.get(this);
      return owner ? attachAttributeNode(owner, attr, true) : Native.namedSetNamedItemNS.call(this, attr);
    });
    if (Native.attrValue && Native.attrValue.set && w.Attr) try { defineMasked(w.Attr.prototype, 'value', {
      get() {
        const owner = this.ownerElement;
        if (!owner) return Native.attrValue.get.call(this);
        return this.namespaceURI ? owner.getAttributeNS(this.namespaceURI, this.localName) : owner.getAttribute(this.name);
      },
      set(v) {
        const owner = this.ownerElement;
        if (!owner) return Native.attrValue.set.call(this, v);
        if (this.namespaceURI) return owner.setAttributeNS(this.namespaceURI, this.name, v);
        return owner.setAttribute(this.name, v);
      },
      configurable: false
    }); } catch {}
    define(w.Element.prototype, 'getAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        const backed = backedIntegrity(this);
        return backed !== null ? backed : Native.getAttribute.call(this, k);
      }
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return frameSandboxMeta.get(this);
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc' && srcdocMeta.has(this)) return srcdocMeta.get(this);
      const raw = Native.getAttribute.call(this, k);
      // URL decoding consumes strings; DOM absence must stay null, and an empty
      // attribute must not pick up a stale URL stash from an earlier value.
      if (raw === null || raw === '') return raw;
      // ★리터럴 parity — 네이티브 getAttribute 는 **작성자 원문**을 돌려준다.
      // 우리가 리라이트한 URL/style 속성은 WeakMap(런타임 set) 또는
      // `data-zp-lit-*`(htmltx 초기 마크업)에 원문이 남아 있다. 어느 쪽도
      // 없으면 기존 절대-타깃 되돌리기로 떨어진다.
      if (localKey === 'style' || localKey === 'srcset' || localKey === 'imagesrcset'
          || isURLBearing(this, key, localKey, ln) || (ln === 'script' && localKey === 'src')) {
        const lit = litGet(this, localKey);
        if (lit !== undefined) return lit;
        const stashed = Native.getAttribute.call(this, litAttrName(key)) ?? Native.getAttribute.call(this, litAttrName(localKey));
        if (stashed !== null) return stashed;
      }
      // ★`style` 은 URL 표면 목록에 없다. 그런데 우리가 그 안의 url() 을
      // 프록시 URL 로 바꿔 **쓴다** — 되돌려 주지 않으면 페이지가 자기
      // 스타일을 다시 읽는 것만으로 프록시 오리진과 /zp/api 경로를 읽어 낸다.
      // 실측(2026-09-10): style 을 읽는 표면 16개가 전부 샜다.
      // `Attr.prototype.value` 와 NS 변종이 이 훅에 위임하므로 여기 한 곳이
      // getAttributeNode / attributes[i] / getNamedItem 까지 함께 덮는다.
      if (localKey === 'style') return deproxyURL(raw, { scan: true });
      if (localKey === 'srcset' || localKey === 'imagesrcset') {
        // 기억한 값이 이미 프록시 URL 일 수 있다(위 주석과 같은 이유).
        const recalled = recalledSrcset(this, key);
        return deproxyURL(recalled !== undefined ? recalled : raw, { scan: true });
      }
      // `script:src` 는 URL 표면 목록에 없다(전용 경로로 다룬다) — 그래서
      // 아래 isURLBearing 분기가 안 먹고 원시 값이 나간다. 프로퍼티는 가려지는데
      // 속성은 안 가려지는 비대칭은 이 저장소가 이미 한 번 밟은 함정이다
      // (NAVER 폼 제출, real-site-compat 2026-06-xx).
      if (ln === 'script' && localKey === 'src') {
        const stashed = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
        if (stashed) return stashed;
        return deproxyURL(raw, { scan: true });
      }
      // 같은 이유로 여기도 마지막에 한 번 더 되돌린다(이 세션 네 번째 같은 부류).
      // usesRaw(앵커 href 등)도 raw 공유 URL 을 페이지에 그대로 돌려주면 안 된다
      // — direct-vs-proxy 차분이 `getAttribute('href')` 에서 /zp/?via= 누출을
      // 잡았다. 스태시(절대 타깃)→deproxy 순으로 되돌린다. 리터럴 복원(상대 경로
      // 그대로)은 htmltx 가 별도 stash 를 심어야 해서 잔여 호환 갭으로 남는다.
      if (isURLBearing(this, key, localKey, ln)) return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || deproxyURL(raw, { scan: true });
      return raw;
    });
    if (Native.hasAttribute) define(w.Element.prototype, 'hasAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (key === 'integrity' && isIntegrityBearing(this)) return backedIntegrity(this) !== null || Native.hasAttribute.call(this, k);
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return true;
      return Native.hasAttribute.call(this, k);
    });
    if (Native.removeAttribute) define(w.Element.prototype, 'removeAttribute', function(k) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // 없는 속성을 지우는 것은 진짜 브라우저에서도 no-op 이다. 읽기가 null 인
      // 이상 여기서도 no-op 이어야 한다 — 안 막았을 때 페이지가 앵커의
      // `data-zp-target-url` 스태시를 실제로 **지워** 버렸다(실측).
      if (isZPAttrName(key)) return undefined;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        Native.removeAttribute.call(this, integrityBackupAttr);
        return Native.removeAttribute.call(this, k);
      }
      if (localKey === 'sandbox' && isFrameElement(this)) frameSandboxMeta.delete(this);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) {
        urlMeta.delete(this);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-target-url');
        return Native.removeAttribute.call(this, k);
      }
      if (ln === 'link' && localKey === 'rel') {
        const ret = Native.removeAttribute.call(this, k);
        enforceLinkPolicy(this);
        return ret;
      }
      // 리터럴/타깃 스태시도 같이 지운다 — 속성을 지운 뒤 되읽기에서
      // stale 값이 살아나면 안 된다.
      litDel(this, localKey);
      urlMeta.delete(this);
      try { Native.removeAttribute.call(this, litAttrName(key)); } catch {}
      try { Native.removeAttribute.call(this, litAttrName(localKey)); } catch {}
      return Native.removeAttribute.call(this, k);
    });
    if (Native.getAttributeNames) define(w.Element.prototype, 'getAttributeNames', function() {
      const names = Native.getAttributeNames.call(this).filter(name => !isZPAttrName(name));
      if (isIntegrityBearing(this) && backedIntegrity(this) !== null && !names.some(name => String(name).toLowerCase() === 'integrity')) names.push('integrity');
      if (isFrameElement(this) && frameSandboxMeta.has(this) && !names.some(name => String(name).toLowerCase() === 'sandbox')) names.push('sandbox');
      return names;
    });
    if (Native.elementAttributes && Native.elementAttributes.get) try { defineMasked(w.Element.prototype, 'attributes', { get() { return filteredNamedNodeMap(Native.elementAttributes.get.call(this), this); }, configurable: false }); } catch {}
    installZPAttrNamespace(w);
    installIntegrityProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installIntegrityProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installScriptProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installScriptTextProps(w);
    installStyleHooks(w);
    installLinkProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
    // ShadowRoot.innerHTML is a SEPARATE IDL attribute — patch it too or
    // `el.attachShadow(); shadow.innerHTML = '<img src=target>'` writes raw
    // markup (and raw URLs) behind the membrane. Same treatment as
    // Element: transformed on write, scrubbed on read.
    if (w.ShadowRoot && w.ShadowRoot.prototype) {
      patchHTMLSetter(w.ShadowRoot.prototype, 'innerHTML');
      if (typeof w.ShadowRoot.prototype.setHTMLUnsafe === 'function') {
        const nativeSetHTML = w.ShadowRoot.prototype.setHTMLUnsafe;
        define(w.ShadowRoot.prototype, 'setHTMLUnsafe', function(html) {
          return nativeSetHTML.call(this, transformHTML(String(html), transformHTMLOpts));
        });
      }
      if (typeof w.ShadowRoot.prototype.getHTML === 'function') {
        const nativeGetHTML = w.ShadowRoot.prototype.getHTML;
        define(w.ShadowRoot.prototype, 'getHTML', function(opts) {
          // cloneNode can't carry a shadow root, so scrub at string level:
          // strip our backup attributes and de-proxy every URL in the
          // serialized markup.
          const out = nativeGetHTML.call(this, opts);
          return typeof out === 'string'
            ? deproxyURL(out.replace(/\sdata-zp-[a-z-]+="[^"]*"/g, ''), { scan: true, fallback: 'share' })
            : out;
        });
      }
    }
    // Element.setHTMLUnsafe has the same bypass on the light-DOM side.
    if (typeof w.Element.prototype.setHTMLUnsafe === 'function') {
      const nativeElSetHTML = w.Element.prototype.setHTMLUnsafe;
      define(w.Element.prototype, 'setHTMLUnsafe', function(html) {
        return nativeElSetHTML.call(this, transformHTML(String(html), transformHTMLOpts));
      });
    }
    // Element.setHTML / Document.parseHTMLUnsafe — the Sanitizer path. The
    // sanitizer filters markup but does NOT rewrite URL attributes, so
    // untransformed HTML would produce CSP-blocked raw-target requests.
    // Transform first, then let the sanitizer see the already-rewritten DOM.
    if (typeof w.Element.prototype.setHTML === 'function') {
      const nativeElSetHTML = w.Element.prototype.setHTML;
      define(w.Element.prototype, 'setHTML', function(html, opts) {
        const ret = nativeElSetHTML.call(this, transformHTML(String(html), transformHTMLOpts), opts);
        try { if (ceUpgradeSubtree) ceUpgradeSubtree(this); } catch {}
        return ret;
      });
    }
    if (typeof w.ShadowRoot !== 'undefined' && w.ShadowRoot.prototype && typeof w.ShadowRoot.prototype.setHTML === 'function') {
      const nativeShadowSetHTML = w.ShadowRoot.prototype.setHTML;
      define(w.ShadowRoot.prototype, 'setHTML', function(html, opts) {
        const ret = nativeShadowSetHTML.call(this, transformHTML(String(html), transformHTMLOpts), opts);
        try { if (ceUpgradeSubtree) ceUpgradeSubtree(this); } catch {}
        return ret;
      });
    }
    if (typeof w.Document.parseHTMLUnsafe === 'function') {
      const nativeParseUnsafe = w.Document.parseHTMLUnsafe;
      define(w.Document, 'parseHTMLUnsafe', function(html) {
        const out = nativeParseUnsafe.call(w.Document, transformHTML(String(html), transformHTMLOpts));
        try { if (ceUpgradeSubtree && out && out.documentElement) ceUpgradeSubtree(out.documentElement); } catch {}
        return out;
      });
    }
    // getHTML/getHTMLUnsafe serialize the RAW DOM — proxy URLs and our
    // data-zp-* stash attributes leak verbatim. Scrub like getHTML above.
    const scrubSerialized = out => typeof out === 'string'
      ? deproxyURL(out.replace(/\sdata-zp-[a-z-]+="[^"]*"/g, ''), { scan: true, fallback: 'share' })
      : out;
    for (const [proto, m] of [[w.Element && w.Element.prototype, 'getHTML'], [w.Element && w.Element.prototype, 'getHTMLUnsafe'], [w.ShadowRoot && w.ShadowRoot.prototype, 'getHTMLUnsafe']]) {
      if (!proto || typeof proto[m] !== 'function') continue;
      const nativeGet = proto[m];
      define(proto, m, function(opts) { return scrubSerialized(nativeGet.call(this, opts)); });
    }
    // ★2026-08-22 — `innerHTML`/`outerHTML` 만 세정하고 있었다.
    // `new XMLSerializer().serializeToString(document.documentElement)` 은 훅이
    // 아예 없어서 같은 문서에서 **38건**의 흔적이 그대로 나왔다(실측). 직렬화는
    // 표면이 하나가 아니다 — 세정을 게터가 아니라 **복제본**에 걸어 둔 덕에
    // 여기서는 그 복제본을 그대로 재사용하면 된다.
    if (w.XMLSerializer && w.XMLSerializer.prototype && typeof w.XMLSerializer.prototype.serializeToString === 'function') {
      const nativeSerialize = w.XMLSerializer.prototype.serializeToString;
      define(w.XMLSerializer.prototype, 'serializeToString', function(node) {
        const clone = node && typeof node.cloneNode === 'function' ? scrubbedClone(node) : null;
        return nativeSerialize.call(this, clone || node);
      });
    }
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) { const ret = Native.insertAdjacentHTML.call(this, pos, transformHTML(String(html), transformHTMLOpts)); syncBaseElement(this); enforceSubtreePolicies(this); try { if (ceUpgradeSubtree) ceUpgradeSubtree(this.parentNode || this); } catch {} return ret; });
    // Document.prototype.write / writeln wrap. 인스턴스 레벨이 아니라 proto
    // 레벨이라 같은 realm 의 모든 Document 인스턴스에 적용. 부모 install 시
    // 부모 Document.prototype, iframe install 시 iframe Document.prototype.
    // NAVER GFP SafeFrame ad iframe 이 부모 ad code 의 `iframe.contentDocument.write(template)`
    // 와 자신의 `document.write(adm)` 모두 transformHTML 통과시켜 외부 스크립트
    // src 가 scriptProxyPath 로 라우팅됨.
    if (w.Document && w.Document.prototype) {
      const docProto = w.Document.prototype;
      if (docProto.write) {
        const protoWrite = docProto.write;
        define(docProto, 'write', function(...parts) {
          const html = parts.map(p => transformHTML(String(p), writeOptsFor(this))).join('');
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          return protoWrite.apply(this, [html]);
        });
      }
      if (docProto.writeln) {
        const protoWriteln = docProto.writeln;
        define(docProto, 'writeln', function(...parts) {
          const html = parts.map(p => transformHTML(String(p), writeOptsFor(this))).join('') + '\n';
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          return protoWriteln.apply(this, [html]);
        });
      }
    }
    // installBaseObserver 가 doc 인자를 받아 부모/iframe 양쪽 호환. iframe
    // 경로는 installNetworkContainment 가 별도로 호출 (w.document 전달).
    installBaseObserver(w.document || document);
    function patchHTMLSetter(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        defineMasked(proto, prop, {
          get() {
            // <style> 는 세정이 아니라 CSS 재작성 대상이다. 예전엔
            // HTMLStyleElement.prototype 에 별도 own 훅이 있었는데, 프로토타입
            // 모양 축(2026-09-10)이 그 own 자체를 지문으로 잡아서 여기로
            // 합쳤다 — Element.prototype 은 어차피 브라우저가 innerHTML 을
            // 두는 자리라 own 이 하나도 안 늘어난다.
            if (prop === 'innerHTML' && this && this.localName === 'style') {
              return d.get ? originalStyleText(this, d.get.call(this)) : '';
            }
            // ShadowRoot (nodeType 11) can't be cloned — scrub the string.
            if (this && this.nodeType === 11) {
              const out = d.get ? String(d.get.call(this)) : '';
              return deproxyURL(out.replace(/\sdata-zp-[a-z-]+="[^"]*"/g, ''), { scan: true, fallback: 'share' });
            }
            return d.get ? sanitizeSerializedNode(this, prop === 'outerHTML') : '';
          },
          set(v) {
            if (this && this.localName === 'template' && prop === 'innerHTML') {
              d.set.call(this, String(v));
              enforceSubtreePolicies(this.content);
              instrumentDescendantIframes(this.content);
              return;
            }
            if (prop === 'innerHTML' && this && this.localName === 'style') {
              originalTextMeta.set(this, String(v == null ? '' : v));
              d.set.call(this, rewriteCSSText(v));
              return;
            }
            // outerHTML 은 `this` 자체가 교체된다 — 업그레이드 루트는 부모다.
            const upRoot = prop === 'outerHTML' ? this.parentNode : this;
            d.set.call(this, transformHTML(String(v), transformHTMLOpts));
            syncBaseElement(this);
            instrumentDescendantIframes(this);
            enforceSubtreePolicies(this);
            try { if (ceUpgradeSubtree) ceUpgradeSubtree(upRoot || this); } catch {}
          },
          configurable: false
        });
      } catch {}
    }
  }
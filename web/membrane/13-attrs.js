  function attrLocalName(key) {
    const s = String(key || '').toLowerCase();
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function tokenListContains(list, token) {
    return String(list || '').toLowerCase().split(/[\s,]+/).includes(token);
  }
  function isBlockedLinkRelValue(rel) {
    for (const token of ['modulepreload','preload','prefetch','preconnect','dns-prefetch','prerender','manifest']) {
      if (tokenListContains(rel, token)) return true;
    }
    return false;
  }
  function isIconLinkRelValue(rel) {
    for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) {
      if (token === 'icon' || token === 'mask-icon' || token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed' || token === 'apple-touch-startup-image' || token === 'fluid-icon') return true;
    }
    return false;
  }
  function isBlockedLink(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function isIconLink(el) { return el && el.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function hasSuppressedBlockedLinkRel(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'data-zp-blocked-rel') || ''); }
  function visibleLinkTarget(el) { return urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || ''; }
  function suppressBlockedLinkRel(el, rawRel) {
    Native.setAttribute.call(el, 'data-zp-blocked-rel', String(rawRel));
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'rel');
    blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
  }
  function blockLinkURL(el, raw) {
    if (raw != null && String(raw) !== '') Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw));
    urlMeta.delete(el);
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
  }
  function suppressIconLinkHref(el, raw) {
    const value = raw == null ? '' : String(raw);
    let visible = value;
    if (value) {
      const t = targetURLForElement(el, value);
      if (t) visible = t;
    }
    const currentVisible = Native.getAttribute.call(el, 'data-zp-target-url') || '';
    const currentHref = Native.getAttribute.call(el, 'href') || '';
    if (visible) {
      urlMeta.set(el, visible);
      if (currentVisible !== visible) Native.setAttribute.call(el, 'data-zp-target-url', visible);
    } else {
      urlMeta.delete(el);
      if (currentVisible && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-target-url');
    }
    if (currentHref !== hiddenIconHref) Native.setAttribute.call(el, 'href', hiddenIconHref);
  }
  function enforceLinkPolicy(el) {
    if (!el || el.localName !== 'link') return;
    const rel = Native.getAttribute.call(el, 'rel') || '';
    if (isBlockedLinkRelValue(rel)) {
      suppressBlockedLinkRel(el, rel);
      return;
    }
    if (rel && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-blocked-rel');
    if (hasSuppressedBlockedLinkRel(el)) {
      blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (isIconLinkRelValue(rel)) {
      suppressIconLinkHref(el, visibleLinkTarget(el) || Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (Native.getAttribute.call(el, 'href') === hiddenIconHref) {
      const restored = visibleLinkTarget(el);
      if (restored) Native.setAttribute.call(el, 'href', restored);
      else if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
    }
    const href = Native.getAttribute.call(el, 'href') || '';
    if (href && !String(href).startsWith(proxyOrigin)) {
      const target = targetURLForElement(el, href);
      if (target) {
        const alreadyMapped = urlMeta.get(el) === target && Native.getAttribute.call(el, 'data-zp-target-url') === target && Native.getAttribute.call(el, 'href') === target;
        urlMeta.set(el, target);
        if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
        const proxied = subresourceProxyPath(target);
        if (!alreadyMapped && Native.getAttribute.call(el, 'href') !== proxied) Native.setAttribute.call(el, 'href', proxied);
      }
    }
  }
  function restoreVisibleLinkState(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(node, 'rel') || '')) {
      const target = Native.getAttribute.call(node, 'data-zp-target-url') || '';
      if (target) Native.setAttribute.call(node, 'href', target);
    }
  }
  function isNavigationTargetElement(el) {
    const tag = el && el.localName;
    return tag === 'a' || tag === 'area' || tag === 'form' || tag === 'button' || tag === 'input';
  }
  function isFrameElement(el) {
    const tag = el && el.localName;
    return tag === 'iframe' || tag === 'frame';
  }
  // The dangerous combination: with both tokens together browsers refuse to
  // enforce the sandbox at all, so target sites use this as a hostile-embed
  // detection signal. Membrane already isolates the iframe; we virtualize the
  // attribute so the detection sees its set value while the DOM remains clean.
  function frameSandboxAllowsEscape(raw) {
    const tokens = new Set(String(raw || '').toLowerCase().split(/\s+/).filter(Boolean));
    return tokens.has('allow-scripts') && tokens.has('allow-same-origin');
  }
  function setFrameSandboxAttribute(el, raw) {
    const value = String(raw == null ? '' : raw);
    if (frameSandboxAllowsEscape(value)) {
      frameSandboxMeta.set(el, value);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
      return;
    }
    frameSandboxMeta.delete(el);
    Native.setAttribute.call(el, 'sandbox', value);
  }
  // Called from insertion / srcdoc / src enforcement paths: if the element
  // already carries a dangerous sandbox attribute when it appears in the DOM,
  // virtualize it before the browser commits the sandbox enforcement.
  function sanitizeFrameSandbox(el) {
    if (!isFrameElement(el)) return;
    const raw = Native.getAttribute.call(el, 'sandbox');
    if (raw !== null && frameSandboxAllowsEscape(raw)) {
      frameSandboxMeta.set(el, raw);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
    }
  }
  function setSafeNavigationTarget(el, attrName, value) {
    const raw = String(value || '');
    if (raw && raw !== '_self') Native.setAttribute.call(el, 'data-zp-blocked-target', raw);
    return Native.setAttribute.call(el, attrName, '_self');
  }
  function isZPAttrName(name) { return String(name || '').toLowerCase().startsWith('data-zp-'); }
  function isZeroProxyAssetURL(raw) {
    if (!raw) return false;
    try {
      const u = new URL(String(raw), proxyOrigin);
      // 목록은 zp-core 단일 소스다. 예전에는 여기가 sw.js 목록의
      // **부분집합**(3/7)이라 빠진 자산은 직렬화 세정에서 안 지워졌다.
      return u.origin === proxyOrigin && ZP.isInternalAssetScriptPath(u.pathname);
    } catch { return false; }
  }
  // ★2026-08-22 — `iframe.srcdoc` 은 우리가 프렐류드 주입 + URL 리라이트를 한
  // 결과로 **덮어쓴다**. 그래서 페이지가 그 값을 다시 읽으면(속성 / 프로퍼티 /
  // 직렬화) 주입한 스크립트 태그와 `data-zp-*` 가 통째로 보인다. 지문 측정에서
  // 남은 9건이 전부 여기였다 — 살아 있는 속성은 세정기가 훑지만 **속성 값 안의
  // 중첩 마크업**까지는 안 들어갔다. 값을 사후에 문자열로 씻는 대신 페이지가
  // 준 원본을 붙들어 두고 읽기 표면이 그것을 돌려주게 한다(재현성도 같이 맞다).
  const srcdocMeta = new WeakMap();
  function setInjectedSrcdoc(el, raw) {
    const s = String(raw == null ? '' : raw);
    let injected = null;
    try { injected = injectSrcdoc(s); }
    catch (e) { try { let dg = root.__zp_diagnostics; try { if (root.top && root.top.__zp_diagnostics) dg = root.top.__zp_diagnostics; } catch {} if (dg && dg.length < 200) dg.push({ t: 'srcdoc-fail', msg: String(e && (e.name + ':' + (e.message || e))).slice(0, 200), stack: String(e && e.stack || '').slice(0, 400) }); } catch {} try { console.warn('[ZP] srcdoc restore failed', String(e && (e.message || e))); } catch {} }
    if (injected == null) return false;
    srcdocMeta.set(el, s);
    Native.setAttribute.call(el, 'srcdoc', injected);
    return true;
  }
  function isZPAssetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === '__zp-boot') return true;
    // SW 가 문서 앞에 박는 인라인 스크립트 / CSP meta 는 src 가 없어
    // URL 로 못 알아본다 — 표식을 보고 떼어낸다.
    if (Native.hasAttribute && Native.hasAttribute.call(node, 'data-zp-internal')) return true;
    return node.localName === 'script' && isZeroProxyAssetURL(Native.getAttribute.call(node, 'src'));
  }
  // 진짜 DOM 은 `el.attributes === el.attributes` 가 true 다. 접근마다 새
  // 프록시를 만들면 그 자체가 후킹을 드러낸다(컬렉션 메서드 동일성과 같은 이유).
  const namedNodeMapCache = new WeakMap();
  const namedNodeMapOwners = new WeakMap();
  function filteredNamedNodeMap(raw, owner) {
    if (!raw) return raw;
    namedNodeMapOwners.set(raw, owner);
    const hit = namedNodeMapCache.get(raw);
    if (hit) return hit;
    const wrapped = filteredCollection(raw, attr => attr && !isZPAttrName(attr.name));
    namedNodeMapOwners.set(wrapped, owner);
    namedNodeMapCache.set(raw, wrapped);
    return wrapped;
  }
  function attachAttributeNode(el, attr, namespaced) {
    const attach = namespaced ? Native.setAttributeNodeNS : Native.setAttributeNode;
    if (!attr || attr.nodeType !== 2 || (attr.ownerElement && attr.ownerElement !== el)) return attach.call(el, attr);
    if (isZPAttrName(attr.name)) return null;
    const ns = attr.namespaceURI;
    const previous = namespaced ? Native.getAttributeNodeNS.call(el, ns, attr.localName) : Native.getAttributeNode.call(el, attr.name);
    if (previous === attr) return attr;
    const previousValue = previous && previous.value;
    // Never attach a raw executable URL, even briefly. The existing setter
    // owns URL activation, srcdoc, CSS, handlers and private metadata policy.
    const value = Native.attrValue.get.call(attr);
    if (ns) el.setAttributeNS(ns, attr.name, value);
    else el.setAttribute(attr.name, value);
    const mapped = Native.getAttributeNodeNS.call(el, ns, attr.localName);
    if (!mapped) return previous;
    Native.attrValue.set.call(attr, Native.attrValue.get.call(mapped));
    attach.call(el, attr);
    if (previous && previous.ownerElement === null) Native.attrValue.set.call(previous, previousValue);
    return previous;
  }
  // ★`data-zp-*` 이름공간을 **규칙으로** 닫는다(2026-08-26).
  //
  // 예전에는 훅이 `getAttribute`/`hasAttribute`/`getAttributeNames`/
  // `attributes` **네 개뿐**이었다. 손으로 고른 목록이라 나머지가 전부
  // 뚫려 있었다 — 실측(example.com, 프록시):
  //
  //   읽기  el.attributes['data-zp-target-url']   → Attr (named getter 폴백)
  //         'data-zp-target-url' in el.attributes → true
  //         el.getAttributeNode / getAttributeNodeNS → Attr
  //         el.getAttributeNS / hasAttributeNS       → 값 / true
  //         el.dataset.zpTargetUrl                   → 값
  //   쓰기  setAttribute / setAttributeNS / toggleAttribute /
  //         setAttributeNode / attributes.setNamedItem / dataset → 전부 씀
  //   삭제  removeAttribute / removeAttributeNS → 우리 스태시가 실제로 지워졌다
  //
  // 링크의 진짜 타깃 URL 이 그대로 새어 나오고, `data-zp-internal` 을 심으면
  // 자기 노드를 컬렉션에서 지울 수 있었다(1건 → 0건) — 진짜 브라우저가
  // 재현하지 못하는 **한 줄짜리 ZeroProxy 탐지기**다.
  //
  // 그래서 표면을 나열하지 않고 **한 규칙**으로 닫는다: 이름이 `data-zp-` 로
  // 시작하면 읽기는 "없음", 쓰기·삭제는 no-op. 이 저장소가 srcset·엔티티·
  // 컬렉션에서 이미 세 번 배운 것과 같은 교훈이다 — 목록으로 따라가는 자리는
  // 결국 뚫린다.
  function datasetKeyToAttrName(key) {
    return 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  }
  function isZPDatasetKey(key) {
    // dataset 은 사이트가 초당 수백 번 읽는 자리다 — 우리 접두사가 아니면
    // 문자열을 만들기 전에 두 글자 비교로 빠져나간다.
    if (typeof key !== 'string' || key.charCodeAt(0) !== 122 || key.charCodeAt(1) !== 112) return false;
    return isZPAttrName(datasetKeyToAttrName(key));
  }
  const datasetCache = new WeakMap();
  function filteredDataset(raw) {
    if (!raw) return raw;
    const hit = datasetCache.get(raw);
    if (hit) return hit;
    const proxied = new Proxy(raw, {
      get(t, prop) { if (isZPDatasetKey(prop)) return undefined; const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; },
      has(t, prop) { return isZPDatasetKey(prop) ? false : prop in t; },
      set(t, prop, v) { if (isZPDatasetKey(prop)) return true; t[prop] = v; return true; },
      deleteProperty(t, prop) { if (isZPDatasetKey(prop)) return true; delete t[prop]; return true; },
      ownKeys(t) { return Reflect.ownKeys(t).filter(k => !isZPDatasetKey(k)); },
      getOwnPropertyDescriptor(t, prop) { return isZPDatasetKey(prop) ? undefined : Reflect.getOwnPropertyDescriptor(t, prop); },
    });
    datasetCache.set(raw, proxied);
    return proxied;
  }
  function installZPAttrNamespace(w) {
    const E = w.Element && w.Element.prototype;
    if (!E) return;
    // NS 변종은 `setAttributeNS` 훅이 이미 그러듯 **같은 뜻이면 같은 코드로**
    // 보낸다 — 부분집합 훅이 다시 생기지 않게.
    const plainNS = (ns, k, key) => (ns === null || ns === undefined || ns === '') && String(k) === key;
    if (Native.getAttributeNS) define(E, 'getAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (plainNS(ns, k, key)) return this.getAttribute(k);
      return Native.getAttributeNS.call(this, ns, k);
    });
    if (Native.hasAttributeNS) define(E, 'hasAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (plainNS(ns, k, key)) return this.hasAttribute(k);
      return Native.hasAttributeNS.call(this, ns, k);
    });
    if (Native.removeAttributeNS) define(E, 'removeAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return undefined;
      if (plainNS(ns, k, key)) return this.removeAttribute(k);
      return Native.removeAttributeNS.call(this, ns, k);
    });
    if (Native.getAttributeNode) define(E, 'getAttributeNode', function(k) {
      return isZPAttrName(k) ? null : Native.getAttributeNode.call(this, k);
    });
    if (Native.getAttributeNodeNS) define(E, 'getAttributeNodeNS', function(ns, k) {
      return isZPAttrName(k) ? null : Native.getAttributeNodeNS.call(this, ns, k);
    });
    // Attr 노드를 통한 쓰기도 같은 규칙. 진짜 브라우저는 교체된 Attr 이나 null
    // 을 돌려주므로 null 이 정직한 "없었다" 다.
    if (Native.setAttributeNode) define(E, 'setAttributeNode', function(attr) {
      return attachAttributeNode(this, attr, false);
    });
    if (Native.setAttributeNodeNS) define(E, 'setAttributeNodeNS', function(attr) {
      return attachAttributeNode(this, attr, true);
    });
    if (Native.removeAttributeNode) define(E, 'removeAttributeNode', function(attr) {
      return attr && isZPAttrName(attr.name) ? attr : Native.removeAttributeNode.call(this, attr);
    });
    if (Native.toggleAttribute) define(E, 'toggleAttribute', function(k, force) {
      // 읽기가 "없음" 이므로 토글 결과도 "없음"(false)이어야 한다.
      return isZPAttrName(k) ? false : Native.toggleAttribute.call(this, k, force);
    });
    if (Native.namedRemoveNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'removeNamedItem', function(k) {
      // 진짜 브라우저는 없는 이름에 NotFoundError 를 던진다 — 읽기와 같은
      // 그림을 유지하려면 여기서도 던져야 한다.
      if (isZPAttrName(k)) throw new w.DOMException("Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '" + String(k) + "' was found.", 'NotFoundError');
      return Native.namedRemoveNamedItem.call(this, k);
    });
    if (Native.htmlDataset && Native.htmlDataset.get && w.HTMLElement) installDatasetHook(w.HTMLElement.prototype, Native.htmlDataset);
    if (Native.svgDataset && Native.svgDataset.get && w.SVGElement) installDatasetHook(w.SVGElement.prototype, Native.svgDataset);
  }
  function installDatasetHook(proto, desc) {
    try { defineMasked(proto, 'dataset', { get() { return filteredDataset(desc.get.call(this)); }, enumerable: desc.enumerable, configurable: false }); } catch {}
  }
  function isIndexKey(prop) {
    return typeof prop !== 'symbol' && /^(?:0|[1-9]\d*)$/.test(String(prop));
  }
  // 컬렉션의 **항목**인가 (Node 이거나 Attr). 술어는 항목에만 뜻이 있다.
  function isFilterableItem(value) {
    return !!value && typeof value === 'object' && (value.nodeType !== undefined || value.ownerElement !== undefined);
  }
  // 프록시 트랩이 즉석에서 만드는 메서드에 네이티브 소스를 입힌다.
  function maskedBound(fn, key) {
    maskNativeFunction(fn, key);
    return fn;
  }
  function filteredCollection(raw, predicate) {
    // ★2026-08-24 — 예전에는 `nth`/`length` 가 **호출될 때마다 원본 전체를
    // 다시 훑었다.** 그리고 순회는 `for (i = 0; i < length(); i++) yield nth(i)`
    // 라 걸음마다 두 번씩 훑었다 — 즉 **한 번 순회가 O(N²)** 이고, 술어
    // (`isZPAssetNode`)는 script 마다 `getAttribute` 를 부른다.
    //
    // CNN 에서 렌더러가 통째로 멎었다. GPT(`pubads_impl.js`)가
    // `querySelectorAll('script')` 결과를 for-of 로 도는데, 스크립트가 ~900개라
    // 900 × 1800 ≈ 1.6M 번의 술어 평가 = **getAttribute 1,733,614회**(실측).
    // 대조군(직접 로드)의 같은 계수기는 **2,087** 이었다 — 830배. 페이지 코드가
    // 아니라 **우리가 만든 호출**이다.
    //
    // 한 번만 훑어 배열로 만들어 둔다. 원본 길이가 변하면 다시 만든다 —
    // `querySelectorAll` 결과는 정적이라 한 번으로 끝나고, live 컬렉션
    // (`attributes`/`document.scripts`)은 항목이 늘거나 줄 때 길이가 바뀐다.
    let cache = null;
    let cacheLen = -1;
    const items = () => {
      const rawLen = raw ? raw.length : 0;
      if (cache && cacheLen === rawLen) return cache;
      const out = [];
      for (let i = 0; i < rawLen; i++) {
        const item = raw[i];
        if (predicate(item)) out.push(item);
      }
      cache = out;
      cacheLen = rawLen;
      return out;
    };
    const nth = index => {
      const arr = items();
      return index >= 0 && index < arr.length ? arr[index] : null;
    };
    const length = () => items().length;
    // ★표면은 **raw 가 실제로 가진 것만** 노출한다(2026-08-24).
    //
    // 예전에는 여섯 호출처에 한 벌의 가짜 표면을 씌웠다. 실브라우저 실측:
    //   NodeList        forEach/values/keys/entries 있음
    //   HTMLCollection  넷 다 undefined   (document.scripts, getElementsByTagName)
    //   NamedNodeMap    넷 다 undefined   (attributes)
    // 그래서 `'forEach' in c === false` 인데 `typeof c.forEach === 'function'` 인
    // **자기모순**이 났다 — 사이트와 무관한 한 줄짜리 탐지기다(실측: 어느 사이트든
    // 똑같이 15건).
    //
    // `prop in raw` 로 게이트하면 live/static 구분이 저절로 맞고, 유지할 목록이
    // 따로 없다 — 감싼 대상이 곧 명세다.
    const inRaw = (prop) => { try { return !!raw && prop in raw; } catch { return false; } };
    // 실제 DOM 은 `nl.forEach === nl.forEach`, `hc.item === hc.item` 이 true 다.
    // `get` 트랩에서 매번 새로 만들면 그 자체가 후킹을 드러낸다.
    let itemFn = null;
    let getNamedItemFn = null;
    const boundFns = new Map();
    const collection = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'length') return length();
        // 프록시 트랩이 만드는 함수는 설치 시점 마스킹이 못 닿는다 —
        // 만들 때 가린다(캐시하므로 한 번뿐이다).
        if (prop === 'item' && inRaw('item')) return itemFn || (itemFn = maskedBound(index => nth(Number(index) || 0), 'item'));
        if (prop === 'getNamedItem' && inRaw('getNamedItem')) return getNamedItemFn || (getNamedItemFn = maskedBound(name => {
          const lower = String(name || '').toLowerCase();
          if (isZPAttrName(lower)) return null;
          for (let i = 0; raw && i < raw.length; i++) if (raw[i] && String(raw[i].name).toLowerCase() === lower && predicate(raw[i])) return raw[i];
          return null;
        }, 'getNamedItem'));
        // 순회는 **실제 DOM 이 쓰는 바로 그 함수**를 돌려준다. 셋 다 @@iterator 가
        // `Array.prototype.values` 이고(측정), 그 함수들에는 브랜드 체크가 없어
        // `this` 의 `length`/인덱스만 읽는다 — 즉 프록시를 `this` 로 받으면
        // 우리 트랩을 타므로 **필터가 그대로 유지된다**(측정 확인).
        // 덤으로 live 컬렉션이 순회 중 원본 변화를 다시 본다(스냅샷은 못 봤다).
        // @@iterator 만은 게이트하지 않는다 — NodeList·HTMLCollection·NamedNodeMap
        // **셋 다** 가지고 있고(측정), 빈 결과로 쓰는 배열도 가진다. 게이트를 달아
        // 뒀더니 변이로 떼어도 아무 가드가 안 물었다 = 한 번도 발화하지 않는
        // 조건이었다. 안 쓰이는 분기는 남기지 않는다.
        if (prop === Symbol.iterator) return Array.prototype.values;
        if (isIndexKey(prop)) {
          const arr = items();
          const index = Number(prop);
          return index < arr.length ? arr[index] : undefined;
        }
        // 이것들을 raw 에 **바인딩**하면 필터를 우회한다 —
        // `document.querySelectorAll('script').forEach(…)` 가 ZP 부트 스크립트를
        // 그대로 넘겨줬다. 바인딩하지 않고 `Array.prototype.*` 를 그대로 주면
        // `this` 가 프록시라 필터를 지나면서 동일성까지 맞는다.
        if (prop === 'forEach' || prop === 'values' || prop === 'keys' || prop === 'entries') {
          return inRaw(prop) ? Array.prototype[prop] : undefined;
        }
        const value = raw && raw[prop];
        // ★이름 기반 접근(WebIDL named getter)도 **항목을 돌려준다** —
        // `el.attributes['data-zp-target-url']` 이 Attr 를 그대로 내줬다.
        // 인덱스 경로만 거르고 여기를 안 걸렀던 것이라, 값이 노드면 술어를
        // 지나게 한다. 함수/스칼라 폴백은 그대로 둔다.
        if (isFilterableItem(value)) {
          try { return predicate(value) ? value : undefined; } catch { return undefined; }
        }
        if (typeof value !== 'function') return value;
        // 바인딩한 것도 접근마다 같은 객체여야 한다.
        let bound = boundFns.get(prop);
        if (!bound) { bound = value.bind(raw); boundFns.set(prop, bound); }
        return bound;
      },
      // 2026-08-15 — `has` 의 인덱스 정규식이 `\\d` 로 이중 이스케이프되어 있었다.
      // 정규식 리터럴 안에서 `\\d` 는 "역슬래시 + d" 라, `[1-9]` 뒤에 역슬래시를
      // 요구하는 셈이 되어 **"0" 말고는 어떤 인덱스도 매치되지 않았다**.
      // `get` 은 올바른 `\d` 를 쓰니 `list[3]` 은 멀쩡했고, 그래서 오래 안 보였다.
      //
      // 그런데 `Array.prototype.map/filter/forEach/…` 는 인덱스를 읽기 전에
      // **HasProperty 로 hole 을 판정**한다. 그래서 `Array.prototype.map.call(
      // nodeList, fn)` 이 0번만 돌고 나머지는 전부 hole 이 됐다 — 배열에는
      // 구멍이 남고 사이트 코드는 `undefined` 를 집는다. wikipedia 포털이
      // `l10n/undefined-<hash>.json` 을 8번 긁던 것이 바로 이것이다.
      has(_target, prop) {
        if (isIndexKey(prop)) return Number(prop) < length();
        // 인덱스가 아닌 이름은 진짜 컬렉션의 판정을 그대로 쓴다. `'item' in list`,
        // `'forEach' in list`, `Symbol.iterator in list` 가 전부 true 여야 한다.
        try {
          if (prop === 'length') return true;
          if (!raw || !(prop in raw)) return false;
          // `in` 도 named getter 를 본다 — 걸러 낸 항목이 여기서 true 로
          // 되살아나면 이름 목록에 없는 것이 `in` 만 true 인 자기모순이 된다.
          const value = raw[prop];
          return isFilterableItem(value) ? !!predicate(value) : true;
        } catch { return prop === 'length'; }
      },
      // 진짜 NodeList/NamedNodeMap 은 인덱스를 **열거 가능한 own 속성**으로 가진다.
      // 이 두 트랩이 없으면 `Object.keys(list)` 가 `[]` 라, 값이 있는데 키가 없는
      // 자기모순이 그대로 지문이 된다. target 은 own 속성이 없는 `{}` 이므로
      // 반드시 `configurable: true` 로 보고해야 불변식 위반이 나지 않는다.
      ownKeys() {
        const keys = [];
        for (let i = 0, n = length(); i < n; i++) keys.push(String(i));
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (isIndexKey(prop) && Number(prop) < length()) {
          return { value: nth(Number(prop)), writable: false, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
    return collection;
  }
  // ★직렬화 세정은 **복제본**에 한다. 예전에는 문자열을 `div.innerHTML` 에 넣고
  // 다시 뽑았는데, HTML 파서가 `<html>/<head>/<body>` 껍데기를 벗긴다. 그래서
  // `document.documentElement.outerHTML` 이 `<html …>` 로 **시작하지 않았다** —
  // 대조군(프록시 없이)은 시작한다(2026-08-22 실측). 재현성 결함이면서 동시에
  // 한 줄로 끝나는 지문이다(`/^<html/.test(...)`).
  //
  // 복제본을 훑어 우리 속성만 떼고 네이티브 게터로 직렬화하면 구조가 그대로다.
  // 재파싱도 없어져 긴 문서에서 더 싸다.
  // 복제 + 세정만 떼어 둔다 — `XMLSerializer.serializeToString` 도 같은
  // 복제본이 필요한데 거기엔 outerHTML 이 없다(Document 를 받는다).
  // 프록시 URL 을 그 안에 실린 타깃으로 되돌린다. 한 값에 여럿이 들어있을 수
  // 있으므로(style 의 url(…), srcset 목록) 전역 치환이다.
  // ★프록시 URL → 타깃 되돌리기는 **구현이 세 벌이었고 표가 서로 달랐다**
  // (2026-08-22 정리). 내비게이션판은 `?url=`/`&u=` 를 몰라서 'virtualURL'
  // 을 돌려줬다 — 틀렸는데 그럴듯한 값이라 조용히 지나간다. 한 벌로 묶고
  // 호출자별 차이를 **옵션으로만** 남긴다.
  //
  //   scan     : 한 값 안에 여럿이 들어 있을 수 있다(style 의 url(…), srcset 목록).
  //   fallback : 모르는 모양을 만났을 때 무엇을 돌려줄 것인가.
  //              'none'  — 원본 그대로(직렬화: 없는 값을 지어내지 않는다)
  //              'share' — 공유 문서 경로면 현재 가상 URL(리소스 타이밍)
  //              'any'   — 프록시 오리진이면 무조건 현재 가상 URL(폼 액션)
  function deproxyURL(raw, opts) {
    const s = String(raw == null ? '' : raw);
    if (!s || s.indexOf(proxyOrigin) < 0) return s;
    const scan = !!(opts && opts.scan);
    const fallback = (opts && opts.fallback) || 'none';
    const one = (m) => {
      let u;
      try { u = new Native.URL(m); } catch { return m; }
      if (u.origin !== proxyOrigin) return m;
      const p = u.pathname;
      if (p === ZP.apiPath('fetch') || p === ZP.apiPath('v2/fetch')) return u.searchParams.get('url') || m;
      if (p === ZP.apiPath('script') || p === ZP.apiPath('worker-script') || p === ZP.apiPath('sourcemap')) return u.searchParams.get('u') || m;
      // 런처(`/zp/?via=<target>`) 와 문서 경로(`/zp/p/<token>`) 는 둘 다 페이지 URL
      // 을 대신한다. 토큰은 암호화돼 있어 클라이언트에서 풀 수 없다.
      const via = u.searchParams.get('via');
      if (via) return via;
      if (fallback === 'any') return virtualURL.href;
      // share 폴백은 `/zp/p/`·`?via=` 만이 아니라 **모든 `/zp/` 내부 경로**를
      // 흡수한다 — `/zp/assets/*`·`/zp/control/*` 가 스택 프레임이나 속성
      // 직렬화에 그대로 새어 나가는 것보다 페이지 가상 URL 로 매핑하는 쪽이
      // 항상 안전하다(§L errorStack 지문 경로).
      if (fallback === 'share' && (ZP.isSharePath(p) || p.startsWith('/zp/'))) return virtualURL.href;
      return m;
    };
    if (scan) return s.replace(proxyURLScanRE(), one);
    return s.lastIndexOf(proxyOrigin, 0) === 0 ? one(s) : s;
  }
  let proxyURLScanCache = null;
  function proxyURLScanRE() {
    if (!proxyURLScanCache) {
      const esc = proxyOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // URL 로 허용되는 문자만 이어 붙인다. 따옴표/공백/괄호로 끊는 방식보다
      // 이쪽이 `style` 안의 `url("…")` 같은 자리에서 덜 위험하다.
      proxyURLScanCache = new RegExp(esc + '[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]*', 'g');
    }
    proxyURLScanCache.lastIndex = 0;
    return proxyURLScanCache;
  }
  // ★2026-08-22 — `<style>` 와 인라인 `<script>` 의 **텍스트**는 우리가
  // 덮어쓴다(CSS URL 리라이트 / 실행 래퍼). 그런데 읽기를 안 고쳤어서
  // 페이지가 자기 스타일/스크립트를 다시 읽으면 그대로 보였다. 실측:
  // 픽스처에서 style 8개 중 4개가 `zp/api` 를, script 2개 중 1개가
  // 래퍼를 노출했다 — 직렬화만의 문제가 아니다.
  //
  // 우리가 덮어쓸 때 원본을 붙들어 둔다. srcdoc 과 같은 방식이고, 마찬가지로
  // 재현성도 같이 맞는다(페이지가 쓴 값을 그대로 돌려주는 게 원래 옴다).
  const originalTextMeta = new WeakMap();
  // 서버측 htmltx 가 고친 것은 WeakMap 이 없다 — 그때는 값 안의 프록시
  // URL 만이라도 푸는다(CSS 는 URL 만 바뀌므로 사실상 원본이 된다).
  // ★되돌리기는 **보관한 값에도** 태운다. 기억해 둔 ‘원본’ 이 이미 프록시
  // URL 일 수 있기 때문이다 — 서버가 고쳐 내려보낸 CSS 를 멤브레인이
  // 나중에 다시 심으면 그 순간의 값을 원본으로 기억한다. 위키피디아의
  // 120KB 스타일 하나가 정확히 그랬다(2026-08-22 실측, 픽스처는 재현 못 함).
  // srcset 에서 같은 함정을 밟았다 — 규칙은 하나다: **마지막에 항상 한 번 더.**
  function originalStyleText(el, raw) {
    return deproxyURL(originalTextMeta.has(el) ? originalTextMeta.get(el) : raw, { scan: true });
  }
  // 페이지가 만든 인라인 스크립트는 래퍼 페이로드가 **원본 그대로**라
  // 되돌리기가 정확하다. 서버가 미리 리라이트한 것
  // (`__ZP_EXEC_INLINE_REWRITTEN`)은 페이로드가 **리라이트된 코드**라 원본을
  // 복구할 수 없다 — 그 경계는 함정노트에 측정값과 함께 적어 됀다.
  const INLINE_WRAPPERS = ['__ZP_EXEC_INLINE_SCRIPT', '__ZP_EXEC_INLINE_MODULE'];
  function originalScriptText(el, raw) {
    // 위와 같은 이유로 보관한 값에도 되돌리기를 태운다. 원본 소스에",
    // 우리 프록시 URL 이 들어 있다면 그건 우리가 넣은 것이다.",
    if (originalTextMeta.has(el)) return deproxyURL(originalTextMeta.get(el), { scan: true });
    const s = String(raw == null ? '' : raw);
    for (const name of INLINE_WRAPPERS) {
      if (s.lastIndexOf(name + '(', 0) !== 0) continue;
      const body = s.slice(name.length + 1, s.lastIndexOf(')'));
      try { return deproxyURL(String(JSON.parse(body)), { scan: true }); } catch { return s; }
    }
    return s;
  }
  function scrubbedClone(node) {
    let clone;
    try { clone = node.cloneNode(true); } catch { clone = null; }
    if (!clone) return null;
    // `origin` 은 복제본에 대응하는 **원본** 요소다. WeakMap 에 매달아 둔 것
    // (srcdoc 원본)은 복제본으로는 못 찾으므로 두 트리를 나란히 걷는다 —
    // cloneNode(true) 는 순서를 보존하므로 인덱스가 그대로 맞는다.
    const scrub = (el, origin) => {
      restoreVisibleLinkState(el);
      if (isZPAssetNode(el)) { try { el.remove(); } catch {} return; }
      // 직렬화도 같은 복구를 거친다 — 게터만 고치면 `outerHTML` 과
      // `getAttribute` 가 서로 다른 말을 하고, 그 불일치가 다시 탐지기다.
      const ln = el.localName;
      if (origin && (ln === 'style' || ln === 'script') && Native.nodeTextContent && Native.nodeTextContent.get) {
        const raw = String(Native.nodeTextContent.get.call(el) || '');
        const want = ln === 'style' ? originalStyleText(origin, raw) : originalScriptText(origin, raw);
        if (want !== raw && Native.nodeTextContent.set) { try { Native.nodeTextContent.set.call(el, want); } catch {} }
      }
      if (origin && srcdocMeta.has(origin)) {
        try { Native.setAttribute.call(el, 'srcdoc', srcdocMeta.get(origin)); } catch {}
      }
      // ★직렬화는 URL 도 되돌려야 한다. `getAttribute('src')` 는 타깃 URL 을
      // 돌려주는데 `outerHTML` 은 프록시 URL 을 그대로 보여 줬다 — 그
      // 불일치 자체가 한 줄짜리 탐지기다(둘을 비교하면 끝).
      //
      // 서버측 htmltx 가 고친 값에는 `data-zp-target-url` 이 **없다**(실측: 41개
      // 전부 null). 그래서 원본을 기억해 둔 것이 있으면 그걸 쓰고, 없으면
      // **값 안에 박힌 프록시 URL 을 그자리에서 푸는다** — `?url=` 에 타깃이
      // 들어 있으므로 별도 장부가 필요 없다. `style` 의 url(…) 과 srcset
      // 목록처럼 한 값에 여럿이 들어있는 경우까지 같은 규칙으로 덩는다.
      if (Native.getAttributeNames) {
        const tag = el.localName;
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) continue;
          const localKey = attrLocalName(name);
          let want;
          if (origin && isURLBearing(el, name, localKey, tag) && !usesRawURLAttribute(el, name, localKey)) {
            const recalled = (localKey === 'srcset' || localKey === 'imagesrcset') ? recalledSrcset(origin, name) : undefined;
            want = recalled !== undefined ? recalled : (urlMeta.get(origin) || Native.getAttribute.call(origin, 'data-zp-target-url') || undefined);
          }
          // ★되돌리기는 **마지막에 항상** 태운다. 기억해 둔 ‘원본’ 이 이미
          // 프록시 URL 일 수 있기 때문이다 — 서버가 고쳐 내려보낸 정적 srcset 을
          // 멤브레인이 나중에 스윗하면 그 순간의 값(=프록시 URL)을 원본으로
          // 기억한다. 그걸 그대로 돌려주면 원본을 복원한 것처럼 보이면서 샐다.
          const raw = Native.getAttribute.call(el, name);
          const base = want !== undefined && want !== null ? String(want) : raw;
          const out = deproxyURL(base, { scan: true });
          if (out !== raw) { try { Native.setAttribute.call(el, name, out); } catch {} }
        }
      }
      if (Native.getAttributeNames) {
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) { try { Native.removeAttribute.call(el, name); } catch {} }
        }
      }
    };
    try {
      if (clone.nodeType === 1) scrub(clone, node);
      // ★말려든 자리: 멤브레인의 `querySelectorAll` 은 **우리 에셋
      // 스크립트를 숨긴다**. 그걸 그대로 쓰면 세정기가 그 노드를
      // 못 보고 복제본에 그대로 남긴다 — 즉 자기 은폐에 자기가 눈이
      // 멀었다. 실측: `outerHTML` 에 zp-core.js / zp-page-bundle.js 태그가
      // 그대로 남아 있었다. 네이티브로 훑어야 한다.
      // Document(9) 와 Element(1) 은 같은 메서드가 아니다 — XMLSerializer 는
      // Document 를 받을 수 있으므로 틀리면 던져서 세정이 통째로 생략된다.
      const all = (n) => {
        const nt = n && n.nodeType;
        const native = nt === 9 ? Native.querySelectorAll
          : nt === 11 ? Native.fragmentQuerySelectorAll
          : Native.elementQuerySelectorAll;
        if (native) { try { return native.call(n, '*'); } catch {} }
        return n && n.querySelectorAll ? n.querySelectorAll('*') : [];
      };
      // ★`<template>` 안은 어떤 querySelectorAll 로도 안 걸린다 — 내용이
      // 문서 트리의 자식이 아니라 별도 DocumentFragment 이기 때문이다.
      // 그런데 **직렬화는 그 안을 그대로 뱉는다.** 즉 세정기가 못 보는 곳을
      // 직렬화기는 본다. reddit 실측: 라이트 DOM 의 zp 속성 241 / 프록시 URL
      // 293 은 전부 세정됐는데, 템플릿 14개 안의 1 / 2 가 그대로 나갔다.
      // 템플릿은 중첩될 수 있으므로 재귀한다.
      const contentOf = (el) => {
        if (!el || el.localName !== 'template') return null;
        try {
          return Native.templateContent && Native.templateContent.get
            ? Native.templateContent.get.call(el) : el.content;
        } catch { return null; }
      };
      const walk = (cloneRoot, originRoot, depth) => {
        const cloned = all(cloneRoot);
        const origins = all(originRoot);
        const paired = origins.length === cloned.length;
        for (let i = 0; i < cloned.length; i++) {
          const origin = paired ? origins[i] : null;
          scrub(cloned[i], origin);
          if (depth < 8) {
            const cc = contentOf(cloned[i]);
            if (cc) walk(cc, contentOf(origin), depth + 1);
          }
        }
      };
      if (clone.nodeType === 1) {
        const cc = contentOf(clone);
        if (cc) walk(cc, contentOf(node), 1);
      }
      walk(clone, node, 0);
    } catch {}
    return clone;
  }
  function sanitizeSerializedNode(node, wantOuter) {
    const clone = scrubbedClone(node);
    if (!clone) return '';
    try {
      if (wantOuter) {
        return Native.elementOuterHTML && Native.elementOuterHTML.get
          ? Native.elementOuterHTML.get.call(clone) : clone.outerHTML;
      }
      return Native.elementInnerHTML && Native.elementInnerHTML.get
        ? Native.elementInnerHTML.get.call(clone) : clone.innerHTML;
    } catch { return ''; }
  }
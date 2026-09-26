
  function readBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try {
        const parsed = JSON.parse(el.textContent || '{}');
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
    return root.__ZP_BOOT || {};
  }

  function clearBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try { el.remove(); } catch {}
    }
    try { delete root.__ZP_BOOT; } catch { try { Object.defineProperty(root, '__ZP_BOOT', { value: undefined, enumerable: false }); } catch {} }
  }
  function captureNative(w) {
    const d = w.document;
    // sandboxed(opaque) 컨텍스트에서 navigator.serviceWorker 읽기는 SecurityError
    // 를 던진다 — 읽다가 죽으면 prelude 전체가 무너져 자식 스크립트 전부가 죽는다.
    const navGet = f => { try { return f(); } catch { return undefined; } };
    return {
      fetch: w.fetch && w.fetch.bind(w),
      // 가상 URL 로 덮기 **전**의 진짜 document.URL. 자식 프레임이 SW 를 거칠
      // 수 있는지 판정하는 유일하게 정직한 신호다 — `doc.URL` 은 우리가
      // 가상 URL 을 돌려주도록 훅해 놨으므로 오라클로 못 쓴다.
      documentURLDesc: Object.getOwnPropertyDescriptor(w.Document && w.Document.prototype, 'URL'),
      XMLHttpRequest: w.XMLHttpRequest,
      WebSocket: w.WebSocket,
      // D4: native WebTransport for the virtual-class pass-through to
      // the ZeroProxy gateway. Captured here so target code that
      // overwrites `globalThis.WebTransport` later can't break our
      // shim. May be undefined on browsers that don't ship WT —
      // ZPWebTransport falls back to the rejected-promise stub.
      WebTransport: w.WebTransport,
      EventSource: w.EventSource,
      Worker: w.Worker,
      FunctionCtor: w.Function,
      // Native `eval`, captured before `define(root, 'eval', dynamicEval)`
      // swaps it for the scoped jail variant. Only used through
      // `execGlobalScript` to give inline <script> bodies real global scope —
      // site-called `eval()` still goes through `dynamicEval`.
      globalEval: w.eval,
      SharedWorker: w.SharedWorker,
      FormData: w.FormData,
      URL: w.URL,
      Blob: w.Blob,
      DOMException: w.DOMException,
      Request: w.Request,
      Response: w.Response,
      serviceWorkerController: navGet(() => w.navigator && w.navigator.serviceWorker && w.navigator.serviceWorker.controller),
      Headers: w.Headers,
      navigatorSendBeacon: navGet(() => w.navigator && w.navigator.sendBeacon && w.navigator.sendBeacon.bind(w.navigator)),
      serviceWorker: navGet(() => w.navigator && w.navigator.serviceWorker),
      createElement: d.createElement.bind(d),
      createElementNS: d.createElementNS && d.createElementNS.bind(d),
      appendChild: w.Node.prototype.appendChild,
      insertBefore: w.Node.prototype.insertBefore,
      replaceChild: w.Node.prototype.replaceChild,
      setAttribute: w.Element.prototype.setAttribute,
      getAttribute: w.Element.prototype.getAttribute,
      removeAttribute: w.Element.prototype.removeAttribute,
      hasAttribute: w.Element.prototype.hasAttribute,
      getAttributeNames: w.Element.prototype.getAttributeNames,
      insertAdjacentHTML: w.Element.prototype.insertAdjacentHTML,
      elementInnerHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML'),
      elementOuterHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'outerHTML'),
      elementAttributes: Object.getOwnPropertyDescriptor(w.Element.prototype, 'attributes'),
      setAttributeNS: w.Element.prototype.setAttributeNS,
      getAttributeNS: w.Element.prototype.getAttributeNS,
      hasAttributeNS: w.Element.prototype.hasAttributeNS,
      removeAttributeNS: w.Element.prototype.removeAttributeNS,
      getAttributeNode: w.Element.prototype.getAttributeNode,
      getAttributeNodeNS: w.Element.prototype.getAttributeNodeNS,
      setAttributeNode: w.Element.prototype.setAttributeNode,
      setAttributeNodeNS: w.Element.prototype.setAttributeNodeNS,
      removeAttributeNode: w.Element.prototype.removeAttributeNode,
      toggleAttribute: w.Element.prototype.toggleAttribute,
      namedRemoveNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.removeNamedItem,
      htmlDataset: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'dataset'),
      svgDataset: w.SVGElement && Object.getOwnPropertyDescriptor(w.SVGElement.prototype, 'dataset'),
      namedSetNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItem,
      namedSetNamedItemNS: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItemNS,
      attrValue: w.Attr && Object.getOwnPropertyDescriptor(w.Attr.prototype, 'value'),
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      querySelector: w.Document.prototype.querySelector,
      querySelectorAll: w.Document.prototype.querySelectorAll,
      elementQuerySelectorAll: w.Element.prototype.querySelectorAll,
      fragmentQuerySelectorAll: w.DocumentFragment && w.DocumentFragment.prototype && w.DocumentFragment.prototype.querySelectorAll,
      elementQuerySelector: w.Element.prototype.querySelector,
      // `<template>` 의 내용은 **별도의 DocumentFragment** 라 어떤
      // querySelectorAll 로도 도달하지 않는다. 그런데 HTML 직렬화는 그 안을
      // 그대로 뱉는다 — 세정기가 못 걷는 곳을 직렬화기는 걷는다(reddit 실측).
      fragmentQuerySelectorAll: w.DocumentFragment && w.DocumentFragment.prototype.querySelectorAll,
      templateContent: w.HTMLTemplateElement
        && Object.getOwnPropertyDescriptor(w.HTMLTemplateElement.prototype, 'content'),
      documentGetElementsByTagName: w.Document.prototype.getElementsByTagName,
      elementGetElementsByTagName: w.Element.prototype.getElementsByTagName,
      documentScripts: Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts'),
      createNodeIterator: w.Document.prototype.createNodeIterator,
      createTreeWalker: w.Document.prototype.createTreeWalker,
      createHTMLDocument: d.implementation && d.implementation.createHTMLDocument && d.implementation.createHTMLDocument.bind(d.implementation),
      scriptText: w.HTMLScriptElement && Object.getOwnPropertyDescriptor(w.HTMLScriptElement.prototype, 'text'),
      nodeTextContent: Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent'),
      htmlInnerText: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'innerText'),
      formSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.submit,
      formRequestSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.requestSubmit,
      documentOpen: d.open && d.open.bind(d),
      documentWrite: d.write && d.write.bind(d),
      documentWriteln: d.writeln && d.writeln.bind(d),
      documentClose: d.close && d.close.bind(d),
      historyPush: w.history.pushState.bind(w.history),
      historyReplace: w.history.replaceState.bind(w.history),
      locationAssign: w.location && w.location.assign && w.location.assign.bind(w.location),
      locationReplace: w.location && w.location.replace && w.location.replace.bind(w.location),
      locationHref: Object.getOwnPropertyDescriptor(w.Location && w.Location.prototype, 'href') || Object.getOwnPropertyDescriptor(w.location, 'href'),
      locationReload: w.location && w.location.reload && w.location.reload.bind(w.location),
      createObjectURL: w.URL && w.URL.createObjectURL && w.URL.createObjectURL.bind(w.URL),
      revokeObjectURL: w.URL && w.URL.revokeObjectURL && w.URL.revokeObjectURL.bind(w.URL),
      open: w.open && w.open.bind(w),
      setTimeout: w.setTimeout && w.setTimeout.bind(w),
      setInterval: w.setInterval && w.setInterval.bind(w),
      clearTimeout: w.clearTimeout && w.clearTimeout.bind(w),
      clearInterval: w.clearInterval && w.clearInterval.bind(w),
      DOMParserParseFromString: w.DOMParser && w.DOMParser.prototype && w.DOMParser.prototype.parseFromString,
      rangeCreateContextualFragment: w.Range && w.Range.prototype && w.Range.prototype.createContextualFragment,
      windowAddEventListener: w.addEventListener && w.addEventListener.bind(w),
      windowRemoveEventListener: w.removeEventListener && w.removeEventListener.bind(w),
    };
  }
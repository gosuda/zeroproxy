
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
  function restoreEarlyNatives(w) {
    try {
      const saved = w && w.__zp_early_natives;
      if (!saved) return;
      try { delete w.__zp_early_natives; } catch {}
      for (const k of Object.keys(saved)) {
        const d = saved[k];
        try {
          if (d) Object.defineProperty(w, k, d);
          else delete w[k];
        } catch {}
      }
    } catch {}
  }
  function captureNative(w) {
    restoreEarlyNatives(w);
    const d = w.document;
    // Accessing navigator.serviceWorker throws SecurityError in sandboxed opaque contexts.
    const navGet = f => { try { return f(); } catch { return undefined; } };
    return {
      fetch: w.fetch && w.fetch.bind(w),
      // Native Document.prototype.URL descriptor captured before virtual URL hooks are installed.
      documentURLDesc: Object.getOwnPropertyDescriptor(w.Document && w.Document.prototype, 'URL'),
      XMLHttpRequest: w.XMLHttpRequest,
      WebSocket: w.WebSocket,
      // Native WebTransport constructor for gateway routing; undefined if unsupported.
      WebTransport: w.WebTransport,
      EventSource: w.EventSource,
      Worker: w.Worker,
      FunctionCtor: w.Function,
      // Native eval captured before dynamicEval replacement; used by execGlobalScript
      // to execute inline <script> bodies in global scope.
      globalEval: w.eval,
      // Capture TrustedTypes brand check and stringifier before page scripts can replace them.
      trustedTypes: navGet(() => w.trustedTypes),
      ttIsScript: navGet(() => w.TrustedTypePolicyFactory.prototype.isScript),
      ttScriptText: navGet(() => w.TrustedScript.prototype.toString),
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
      documentCreateElement: w.Document.prototype.createElement,
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
      // <template>.content is an isolated DocumentFragment; HTML serialization
      // traverses into it even though document.querySelectorAll does not.
      fragmentQuerySelectorAll: w.DocumentFragment && w.DocumentFragment.prototype.querySelectorAll,
      templateContent: w.HTMLTemplateElement
        && Object.getOwnPropertyDescriptor(w.HTMLTemplateElement.prototype, 'content'),
      documentGetElementsByTagName: w.Document.prototype.getElementsByTagName,
      elementGetElementsByTagName: w.Element.prototype.getElementsByTagName,
      documentScripts: Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts'),
      createNodeIterator: w.Document.prototype.createNodeIterator,
      createTreeWalker: w.Document.prototype.createTreeWalker,
      createHTMLDocument: d.implementation && d.implementation.createHTMLDocument && d.implementation.createHTMLDocument.bind(d.implementation),
      importNode: w.Document.prototype.importNode,
      scriptText: w.HTMLScriptElement && Object.getOwnPropertyDescriptor(w.HTMLScriptElement.prototype, 'text'),
      nodeTextContent: Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent'),
      htmlInnerText: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'innerText'),
      // Native contentWindow getters bypass containFrameWindow when resolving frame windows internally.
      iframeContentWindow: w.HTMLIFrameElement && Object.getOwnPropertyDescriptor(w.HTMLIFrameElement.prototype, 'contentWindow'),
      frameContentWindow: w.HTMLFrameElement && Object.getOwnPropertyDescriptor(w.HTMLFrameElement.prototype, 'contentWindow'),
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
/* ZeroProxy Service Worker transport request helpers. */
(self => {
  'use strict';

  function createTransportHelpers({ inflightFetches, uploadStreams, readableStreamFromUpload }) {
    function takeHeader(headers, name) {
      const value = headers.get(name) || '';
      headers.delete(name);
      return value;
    }

    function buildTransportHeaders(opt, u) {
      const headers = new Headers(opt.headers || (opt.request && opt.request.headers) || undefined);
      setTrustedTransportHeaders(headers, opt);
      setDocumentTransportHeaders(headers, opt, u);
      setFetchPolicyHeaders(headers, opt);
      return headers;
    }

    function setTrustedTransportHeaders(headers, opt) {
      headers.set('X-ZP-Tab-Id', opt.tab.tabId);
      headers.set('X-ZP-Entry-Id', opt.entryId || opt.tab.activeEntryId || '');
      headers.set('X-ZP-Stream-Isolation-Key', opt.tab.streamIsolationKey);
      headers.set('X-ZP-Runtime-Token', opt.tab.runtimeToken || '');
      headers.set('X-ZP-Relay-Servers', JSON.stringify(opt.tab.servers || []));
    }

    function setDocumentTransportHeaders(headers, opt, u) {
      if (opt.document) headers.set('X-ZP-Document-Request', '1');
      if (!headers.has('X-ZP-Document-URL')) {
        const entry = transportDocumentEntry(opt);
        headers.set('X-ZP-Document-URL', entry && (entry.baseUrl || entry.targetUrl) || u);
      }
      if (opt.document && !headers.has('X-ZP-Document-Referrer')) {
        const entry = transportDocumentEntry(opt);
        headers.set('X-ZP-Document-Referrer', entry && entry.referrerUrl || '');
      }
    }

    function setFetchPolicyHeaders(headers, opt) {
      const req = opt.request;
      const credentials = opt.document ? 'include' : reqProp(req, 'credentials', 'same-origin');
      const mode = reqProp(req, 'mode', opt.document ? 'navigate' : 'cors');
      setDefaultHeader(headers, 'X-ZP-Fetch-Credentials', credentials);
      setDefaultHeader(headers, 'X-ZP-Fetch-Mode', mode);
      setDefaultHeader(headers, 'X-ZP-Fetch-Cache', reqProp(req, 'cache', 'default'));
      if (opt.document) headers.set('X-ZP-Fetch-Redirect', 'follow');
      else setDefaultHeader(headers, 'X-ZP-Fetch-Redirect', reqProp(req, 'redirect', 'follow'));
      setDefaultHeader(headers, 'X-ZP-Fetch-Referrer', reqProp(req, 'referrer', 'about:client'));
      setDefaultHeader(headers, 'X-ZP-Fetch-Referrer-Policy', reqProp(req, 'referrerPolicy', ''));
    }

    function reqProp(req, key, fallback) {
      return req && req[key] || fallback;
    }

    function setDefaultHeader(headers, name, value) {
      if (!headers.has(name)) headers.set(name, value);
    }

    function transportDocumentEntry(opt) {
      return opt.tab.entries && opt.tab.entries.get(opt.entryId || opt.tab.activeEntryId);
    }

    function setupTransportAbort(opt, init, requestId) {
      if (!needsTransportAbort(opt, requestId)) return null;
      const controller = new AbortController();
      init.signal = controller.signal;
      if (requestId) inflightFetches.set(requestId, controller);
      const listener = attachRequestAbortSignal(opt, controller);
      return { controller, listener };
    }

    function needsTransportAbort(opt, requestId) {
      return !!(requestId || requestSignal(opt));
    }

    function requestSignal(opt) {
      return opt.request && opt.request.signal;
    }

    function attachRequestAbortSignal(opt, controller) {
      const signal = requestSignal(opt);
      if (!signal) return null;
      const listener = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', listener, { once: true });
      return listener;
    }

    function detachTransportAbort(opt, abort) {
      const signal = requestSignal(opt);
      if (abort && abort.listener && signal) {
        try { signal.removeEventListener('abort', abort.listener); } catch {}
      }
    }

    function attachTransportBody(init, opt, uploadStreamId) {
      if (opt.body != null) {
        init.body = opt.body;
      } else if (uploadStreamId) {
        const upload = uploadStreams.get(uploadStreamId);
        if (!upload || upload.tabId !== opt.tab.tabId) return true;
        init.body = readableStreamFromUpload(uploadStreamId, upload);
        init.duplex = 'half';
      } else if (opt.request && opt.request.body) {
        init.body = opt.request.body;
        init.duplex = 'half';
      }
      return false;
    }

    return Object.freeze({
      attachTransportBody,
      buildTransportHeaders,
      detachTransportAbort,
      setupTransportAbort,
      takeHeader,
    });
  }

  self.ZPSWTransport = Object.freeze({ createTransportHelpers });
})(self);

  function requestTargetURL(input) {
    const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
    const gated = unleakedTargetRaw(raw);
    if (gated === null) return virtualURL.href;
    const parsed = new URL(gated, baseURL);
    if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + parsed.search + parsed.hash, baseURL).href;
    return ZP.canonicalTargetURL(parsed.href, baseURL).href;
  }
  async function requestBodyBytes(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    const ab = await req.clone().arrayBuffer();
    return new Uint8Array(ab);
  }
  // `/zp/api/v2/fetch` 는 바이너리 봉투를 받는다. realm 생애 동안 한 번이라도
  // "구 SW" 신호(메타 헤더 없는 404)를 받으면 v1(base64-in-JSON)으로 내려앉는다.
  // 진짜 업스트림 404 는 `X-ZP-Fetch-Meta` 를 달고 오므로 헷갈리지 않는다.
  let v2FetchOK = true;
  async function postRuntimeEnvelope(target, payload, bodyBytes, extraInit) {
    const label = '?url=' + encodeURLParam(target);
    if (v2FetchOK) {
      try {
        const r = await Native.fetch(proxyOrigin + ZP.apiPath('v2/fetch') + label,
          Object.assign({ method: 'POST', headers: { 'Content-Type': ZP.ENVELOPE_MIME }, body: ZP.encodeEnvelope(payload, bodyBytes) }, extraInit || {}));
        if (r.status === 404 && !r.headers.get('X-ZP-Fetch-Meta')) { v2FetchOK = false; try { r.arrayBuffer().catch(() => {}); } catch {} }
        else return r;
      } catch (e) { /* v1 으로 한 번 더 — 거기서도 실패하면 그 에러가 나간다 */ }
    }
    payload.init.body = bodyBytes ? ZP.bytesToBase64Url(bodyBytes) : null;
    const r = await Native.fetch(proxyOrigin + ZP.apiPath('fetch') + label,
      Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, extraInit || {}));
    v2FetchOK = false; // v1 이 살았는데 v2 가 죽었다 — 엔드포인트 없음으로 확정
    return r;
  }
  // blob: / data: 는 브라우저가 그 자리에서 푸는 **인라인 리소스**다. 타깃이
  // 없으니 프록시로 보낼 것도 없고, 보내면 페이지가 넣은 내용 대신 우리 응답이
  // 돌아온다 — 실측(2026-08-26): fetch(URL.createObjectURL(new Blob(["HELLO"])))
  // 이 HELLO 대신 프록시 HTML 을 돌려줬다. 페이지가 자기가 만든 데이터를 다시
  // 읽는 흔한 패턴(파일 미리보기, 워커 없는 파서, 캔버스 내보내기)이 통째로
  // 깨진다. 둘 다 인라인이라 우회 통로가 되지 않는다.
  function inlineSchemeFetchURL(input) {
    try {
      const href = typeof input === 'string' ? input
        : (input && typeof input === 'object' && typeof input.url === 'string') ? input.url
        : String(input);
      return /^(?:blob|data):/i.test(String(href).trim()) ? String(href).trim() : null;
    } catch { return null; }
  }
  async function fetchThroughRuntime(input, init = {}) {
    if (!Native.fetch || !Native.Request || !Native.Headers) throw normalizedError('NetworkError');
    // 인라인 스킴은 브라우저에게 그대로 넘긴다 (위 주석 참고).
    if (inlineSchemeFetchURL(input)) return Native.fetch(input, init);
    const target = requestTargetURL(input);
    try { zpTrace('fetch', target.slice(0, 180)); } catch {}
    const req = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function' ? new Native.Request(input, init) : new Native.Request(target, init);
    // Capture before reading a body: history/base may change while that read awaits.
    const requestEntryId = activeEntryId;
    const documentURL = virtualURL.href;
    const referrerPolicy = req.referrerPolicy || documentReferrerPolicy();
    const bodyBytes = await requestBodyBytes(req);
    const payload = {
      tabId: boot.tabId,
      entryId: requestEntryId,
      documentURL,
      url: target,
      init: {
        method: req.method,
        headers: Array.from(req.headers.entries()),
        // v2 는 봉투 꼬리가 바디다 — head 에는 null. v1 폴백 시
        // postRuntimeEnvelope 가 base64 로 채운다.
        body: null,
        credentials: req.credentials,
        mode: req.mode,
        referrer: req.referrer,
        // 페이지가 `fetch(u, { referrerPolicy })` 로 명시한 값. SW 는
        // /zp/api/fetch 요청에 대해 브라우저가 계산한 정책을 볼 수 없으므로
        // (그 요청의 정책은 프록시 문서의 것이다) 여기서 넘겨준다.
        //
        // 명시가 없으면 **문서의 정책**을 여기서 읽어 채운다. `<meta
        // name=referrer>` 로만 선언한 문서가 그렇다 — 문서 정책은 Request
        // 객체에 반영되지 않으므로(`req.referrerPolicy` 가 빈 문자열) 이 자리를
        // 비워 두면 SW 는 기본값으로 떨어진다. 실측(로컬 픽스처): meta 가
        // no-referrer/origin 이어도 프록시만 전체 URL 을 보냈다.
        //
        // 메시지로 미리 알려 주는 경로(ZP_REFERRER_POLICY)만으로는 부족하다 —
        // 페이지의 첫 fetch 는 파싱 도중에 나가서 그 메시지보다 **빠르다.**
        referrerPolicy,
        redirect: req.redirect,
        cache: req.cache,
        integrity: req.integrity
      }
    };
    const extraInit = req.signal ? { signal: req.signal } : null;
    // Absolute proxy URL — virtual baseURI resolves root-relative paths
    // against the target host. See scriptProxyPath for the companion bug.
    // The target also rides in the query string even though the SW reads it
    // from the JSON body. Without it every membrane fetch produced a resource
    // timing entry named exactly `<proxy>/zp/api/fetch`, which (a) is
    // indistinguishable between requests and (b) carries no target, so the
    // de-proxy getter on `PerformanceEntry.name` cannot recover one. NAVER's
    // ad SDK locates itself through resource timing and then resolved
    // `./gfp-display-sdk.js` against that bare path — producing a 404 on
    // `<proxy>/zp/api/gfp-display-sdk.js`. Routing is unaffected: the SW
    // matches on `url.pathname` only.
    // 인코더는 subresourceProxyPath 와 공유한다. 프래그먼트/`&tab=` 은 여기에
    // 없는 게 맞다 — 이 URL 은 **라벨**이고(SW 는 pathname 으로만 라우팅하고
    // 타깃은 JSON 바디에서 읽는다) fetch 는 프래그먼트를 어차피 버린다.
    return postRuntimeEnvelope(target, payload, bodyBytes, extraInit).then(r => {
      try { zpTrace('fetch:ok', target.slice(0,80) + ' s=' + r.status); } catch {}
      return decodeFetchResponse(r);
    }, e => { try { zpTrace('fetch:err', target.slice(0,80) + ' ' + String(e).slice(0,60)); } catch {} throw e; });
  }
  function fireEvent(target, type) {
    let ev;
    try { ev = new Event(type); } catch { ev = { type }; }
    return target.dispatchEvent(ev);
  }
  function installHTTPAPIs() {
    if (Native.Response) decodeFetchResponse = ZP.createFetchResponseAdapter(Native.Response, Native.Headers, defineAccessor, define);
    if (Native.fetch && Native.Request && Native.Headers) define(root, 'fetch', function fetch(input, init) { return fetchThroughRuntime(input, init); });
    if (Native.XMLHttpRequest && Native.fetch && Native.Request && Native.Headers) {
      const UNSENT = 0, OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;
      function ZPXMLHttpRequest() {
        this.readyState = UNSENT;
        this.response = this.responseText = '';
        // Native defaults are null, not undefined — the accessors added below
        // would otherwise report `undefined` for an untouched request.
        this.responseXML = null;
        this.onreadystatechange = null;
        this.responseType = '';
        this.responseURL = '';
        this.status = 0;
        this.statusText = '';
        this.timeout = 0;
        this.withCredentials = false;
        this.upload = {};
        this._headers = [];
        this._responseHeaders = null;
        this._method = 'GET';
        this._url = '';
        this._sent = false;
        this._controller = null;
        this._timer = 0;
      }
      function xhrReady(xhr, state) {
        xhr.readyState = state;
        fireEvent(xhr, 'readystatechange');
      }
      function xhrDone(xhr, type) {
        clearTimeout(xhr._timer);
        xhr._timer = 0;
        xhrReady(xhr, DONE);
        fireEvent(xhr, type);
        fireEvent(xhr, 'loadend');
      }
      installEventMethods(ZPXMLHttpRequest.prototype);
      // Native XHR exposes its state as PROTOTYPE accessors, not instance data
      // properties. We wrote them straight onto the instance, so
      // `XMLHttpRequest.prototype` carried 16 names where Chrome has 27
      // (measured 2026-08-02) — both a loud proxy tell and a real compat break:
      // `'readyState' in XMLHttpRequest.prototype` was false, and any library
      // that wraps `XMLHttpRequest.prototype.responseText` (analytics shims,
      // mocking libs) saw nothing to wrap.
      //
      // Backing them with `_zp`-prefixed fields keeps every existing
      // `this.readyState = …` write working — the assignment now routes through
      // the setter instead of creating an own property, so instance shape gets
      // closer to native too. defineAccessor masks the pair's toString.
      for (const _n of ['readyState', 'response', 'responseText', 'responseXML', 'responseType',
        'responseURL', 'status', 'statusText', 'timeout', 'withCredentials', 'upload',
        'onreadystatechange']) {
        const _k = '_zp' + _n;
        defineAccessor(ZPXMLHttpRequest.prototype, _n,
          function () { return this[_k]; },
          function (v) { this[_k] = v; },
          Native.XMLHttpRequest && Native.XMLHttpRequest.prototype);
      }
      // 동기 XHR 을 same-origin 중계로 보낸다.
      //
      // 네이티브 XHR 을 쓰되 **목적지는 우리 origin** 이다. 타깃 URL 은 쿼리로
      // 넘기고, Go 가 그 응답을 park 한 채 SW 에 일을 시킨다. 브라우저가 타깃으로
      // 직접 나가는 일이 없으므로 IP 가 새지 않는다(그게 원래 차단의 이유였다).
      // 쿠키는 여기서 다루지 않는다 — 기존 경로대로 커널의 jar 가 붙인다.
      function sendSyncThroughRelay(xhr, body) {
        xhr._sent = true;
        try {
          const rid = 'sx' + ZP.randomId();
          let u = proxyOrigin + ZP.apiPath('sync-fetch')
            + '?rid=' + encodeURIComponent(rid)
            + '&u=' + encodeURIComponent(xhr._url)
            + '&m=' + encodeURIComponent(xhr._method)
            + '&tab=' + encodeURIComponent(boot.tabId || '')
            + '&entry=' + encodeURIComponent(activeEntryId || '');
          for (const kv of xhr._headers) u += '&h=' + encodeURIComponent(kv[0] + ':' + kv[1]);

          const nx = new Native.XMLHttpRequest();
          nx.open(xhr._method, u, false);
          if (xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob') {
            // 동기 XHR 은 responseType 을 못 바꾼다(스펙). 텍스트로 받고 아래에서 변환.
          }
          nx.send(body != null && xhr._method !== 'GET' && xhr._method !== 'HEAD' ? body : null);

          xhr.status = nx.status;
          xhr.statusText = nx.statusText || '';
          try {
            const h = new Native.Headers();
            String(nx.getAllResponseHeaders() || '').split(/\r?\n/).forEach(line => {
              const i = line.indexOf(':');
              if (i > 0) { try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch {} }
            });
            xhr._responseHeaders = h;
          } catch {}
          xhrReady(xhr, HEADERS_RECEIVED);
          xhrReady(xhr, LOADING);
          xhr.responseText = nx.responseText || '';
          if (xhr.responseType === 'json') {
            try { xhr.response = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { xhr.response = null; }
          } else {
            xhr.response = xhr.responseText;
          }
          xhr._sent = false;
          xhrDone(xhr, 'load');
        } catch (e) {
          xhr._sent = false;
          xhr.status = 0;
          xhr.statusText = '';
          try {
            const diag = root.__zp_diagnostics;
            if (diag && diag.length < 200) diag.push({
              t: 'sync-xhr-relay-failed',
              url: String(xhr._url || '').slice(0, 160),
              msg: String((e && e.message) || e).slice(0, 120),
            });
          } catch {}
          xhrDone(xhr, 'error');
        }
      }
      // readyState 상수는 실제 브라우저에서 **쓰기도 재정의도 불가**하다
      // (`{value, enumerable: true, writable: false, configurable: false}`).
      // Object.assign 으로 얹으면 writable+configurable 이 되어 실제보다 무르고,
      // 디스크립터 모양 대조에 그대로 잡힌다(실측 2026-08-16: 직접 `D-e-` vs
      // 프록시 `Dcew`). 상수만 따로 심는다.
      for (const [k, v] of [['UNSENT', UNSENT], ['OPENED', OPENED], ['HEADERS_RECEIVED', HEADERS_RECEIVED], ['LOADING', LOADING], ['DONE', DONE]]) {
        try { Object.defineProperty(ZPXMLHttpRequest.prototype, k, { value: v, enumerable: true, writable: false, configurable: false }); } catch {}
        try { Object.defineProperty(ZPXMLHttpRequest, k, { value: v, enumerable: true, writable: false, configurable: false }); } catch {}
      }
      assignMasked(ZPXMLHttpRequest.prototype, {
        constructor: ZPXMLHttpRequest,
        // Chrome-only Privacy Sandbox hooks. We do not implement either — the
        // proxy never forwards attribution or private-token material — but
        // their ABSENCE is itself a fingerprint (XHR.prototype 25 vs 27), and
        // `xhr.setPrivateToken` throwing "not a function" reads differently
        // from a browser that has the method. Accept-and-ignore matches what a
        // browser does when the feature is disabled by policy.
        setAttributionReporting() {},
        setPrivateToken() {},
        open(method, url, async = true, user, password) {
          // 2026-08-13 — 동기 XHR 을 **감옥 안에서** 지원한다.
          //
          // Service Worker 는 동기 XHR 을 가로채지 못한다(실측: 같은 페이지·같은
          // URL 에서 동기 XHR 은 Go 까지 내려가 403, 비동기 fetch 는 SW 가 503).
          // 그래서 예전에는 그냥 막았는데, NAVER 캡차가 UI(`rcaptUi`)·문제
          // (`question`)·**JS 토큰 검증**(`verifyJs`)을 전부 동기 XHR 로 가져오는
          // 탓에 답이 맞아도 "틀렸다" 가 나왔다(진단 버퍼로 확인).
          //
          // 이제는 same-origin 중계 엔드포인트로 던진다. Go 는 그 응답을 park 한 채
          // SW 에 작업을 넘기고, 실제 전송은 기존 `transportFetch` 가 한다 —
          // 브라우저가 타깃으로 직접 나가지 않으므로 감옥은 그대로다.
          this._sync = (async === false);
          this.abort();
          this._method = String(method || 'GET').toUpperCase();
          const target = new URL(requestTargetURL(url));
          if (user != null) target.username = String(user);
          if (password != null) target.password = String(password);
          this._url = target.href;
          this.responseURL = this._url;
          this._headers = [];
          this._responseHeaders = null;
          this.status = 0;
          this.statusText = '';
          this.response = this.responseText = '';
          xhrReady(this, OPENED);
        },
        setRequestHeader(name, value) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          this._headers.push([String(name), String(value)]);
        },
        send(body = null) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          if (this._sync) return sendSyncThroughRelay(this, body);
          this._sent = true;
          this._controller = new AbortController();
          const init = { method: this._method, headers: this._headers, credentials: this.withCredentials ? 'include' : 'same-origin', signal: this._controller.signal };
          if (body != null && this._method !== 'GET' && this._method !== 'HEAD') init.body = body;
          if (this.timeout > 0) this._timer = setTimeout(() => { try { this._controller.abort(); } catch {} this._sent = false; xhrDone(this, 'timeout'); }, this.timeout);
          fetchThroughRuntime(this._url, init).then(async resp => {
            if (!this._sent) return;
            this.status = resp.status;
            this.statusText = resp.statusText;
            this.responseURL = resp.url || this._url;
            this._responseHeaders = resp.headers;
            xhrReady(this, HEADERS_RECEIVED);
            xhrReady(this, LOADING);
            if (this.responseType === 'arraybuffer') this.response = await resp.arrayBuffer();
            else if (this.responseType === 'blob') this.response = await resp.blob();
            else if (this.responseType === 'json') { const text = await resp.text(); try { this.response = text ? JSON.parse(text) : null; } catch { this.response = null; } }
            else { this.responseText = await resp.text(); this.response = this.responseText; }
            this._sent = false;
            xhrDone(this, 'load');
          }).catch(() => {
            if (!this._sent) return;
            this._sent = false;
            this.status = 0;
            this.statusText = '';
            xhrDone(this, 'error');
          });
        },
        abort() {
          if (this._controller) { try { this._controller.abort(); } catch {} }
          clearTimeout(this._timer);
          this._timer = 0;
          const active = this._sent;
          this._sent = false;
          this._controller = null;
          if (active) xhrDone(this, 'abort');
        },
        getResponseHeader(name) { return this._responseHeaders ? this._responseHeaders.get(String(name)) : null; },
        getAllResponseHeaders() { if (!this._responseHeaders) return ''; let out = ''; this._responseHeaders.forEach((v, k) => { out += k + ': ' + v + '\r\n'; }); return out; },
        overrideMimeType() {}
      });
      maskMethods(ZPXMLHttpRequest.prototype, ['open','setRequestHeader','send','abort','getResponseHeader','getAllResponseHeaders','overrideMimeType']);
      brandLikeNative(ZPXMLHttpRequest, ZPXMLHttpRequest.prototype, 'XMLHttpRequest');
      define(root, 'XMLHttpRequest', ZPXMLHttpRequest);
    }
    if (Native.EventSource && Native.fetch && Native.Request && Native.Headers) {
      // B4: EventSource fidelity. WHATWG HTML SSE §9.2 — auto-reconnect after
      // soft transport errors with the server-supplied `retry:` interval,
      // Last-Event-ID echo on reconnect, Content-Type enforcement, 204 clean
      // close, non-2xx hard fail (no reconnect).
      const CONNECTING = 0, OPEN = 1, CLOSED = 2;
      const DEFAULT_RECONNECT_MS = 3000;
      function ZPEventSource(url, init = {}) {
        this.url = requestTargetURL(url);
        this.withCredentials = !!(init && init.withCredentials);
        this.readyState = CONNECTING;
        this._closed = false;
        this._controller = new AbortController();
        this._lastEventId = '';
        this._reconnectMs = DEFAULT_RECONNECT_MS;
        this._reconnectTimer = 0;
        this._init = init || {};
        runEventSource(this);
      }
      installEventMethods(ZPEventSource.prototype);
      assignMasked(ZPEventSource.prototype, {
        constructor: ZPEventSource,
        CONNECTING, OPEN, CLOSED,
        close() {
          this._closed = true;
          this.readyState = CLOSED;
          if (this._reconnectTimer) { try { clearTimeout(this._reconnectTimer); } catch {} this._reconnectTimer = 0; }
          try { this._controller.abort(); } catch {}
        }
      });
      maskMethods(ZPEventSource.prototype, ['close']);
      mirrorNativeProto(ZPEventSource.prototype,
        ['url', 'withCredentials', 'readyState', 'onopen', 'onmessage', 'onerror'],
        Native.EventSource && Native.EventSource.prototype);
      brandLikeNative(ZPEventSource, ZPEventSource.prototype, 'EventSource');
      define(root, 'EventSource', ZPEventSource);

      function scheduleReconnect(es) {
        if (es._closed) return;
        es.readyState = CONNECTING;
        fireEvent(es, 'error');
        if (es._closed) return;
        es._reconnectTimer = setTimeout(() => {
          es._reconnectTimer = 0;
          if (es._closed) return;
          // New controller per attempt so prior abort doesn't poison next fetch.
          es._controller = new AbortController();
          runEventSource(es);
        }, es._reconnectMs);
      }

      function runEventSource(es) {
        const headers = [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']];
        if (es._lastEventId) headers.push(['Last-Event-ID', es._lastEventId]);
        fetchThroughRuntime(es.url, { method: 'GET', headers, credentials: es._init.withCredentials ? 'include' : 'same-origin', cache: 'no-store', signal: es._controller.signal }).then(async resp => {
          if (es._closed) return;
          // 204 = end of stream, close cleanly (no reconnect).
          if (resp.status === 204) {
            es.readyState = CLOSED;
            return;
          }
          const ct = (resp.headers && resp.headers.get('Content-Type')) || '';
          // Per spec wrong MIME or non-2xx is a HARD fail — no reconnect.
          if (!resp.ok || !/^text\/event-stream\b/i.test(ct)) {
            es.readyState = CLOSED;
            fireEvent(es, 'error');
            return;
          }
          es.readyState = OPEN;
          fireEvent(es, 'open');
          if (!resp.body || !resp.body.getReader) {
            consumeSSE(es, await resp.text(), true);
            if (!es._closed) scheduleReconnect(es);
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              buf = consumeSSE(es, buf + decoder.decode(part.value, { stream: true }), false);
            }
            consumeSSE(es, buf + decoder.decode(), true);
          } catch {}
          if (!es._closed) scheduleReconnect(es);
        }).catch(() => {
          if (es._closed) return;
          scheduleReconnect(es);
        });
      }
      function consumeSSE(es, text, final) {
        let buf = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          dispatchSSE(es, buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
        if (final && buf) {
          dispatchSSE(es, buf);
          return '';
        }
        return buf;
      }
      function dispatchSSE(es, block) {
        if (es._closed) return;
        let data = '', eventType = 'message', eventLastId = null;
        for (const line of String(block).split('\n')) {
          if (!line || line[0] === ':') continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value[0] === ' ') value = value.slice(1);
          if (field === 'data') data += value + '\n';
          else if (field === 'event') eventType = value || 'message';
          else if (field === 'id') eventLastId = value;
          else if (field === 'retry') {
            // Per spec only digit-strings update reconnect interval.
            if (/^\d+$/.test(value)) es._reconnectMs = parseInt(value, 10);
          }
        }
        // Per spec the "last event ID buffer" updates on EVERY id field.
        if (eventLastId !== null) es._lastEventId = eventLastId;
        if (!data) return;
        data = data.slice(0, -1);
        let ev;
        const origin = new URL(es.url).origin;
        try { ev = new MessageEvent(eventType, { data, origin, lastEventId: es._lastEventId }); }
        catch { ev = new Event(eventType); try { Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, lastEventId: { value: es._lastEventId } }); } catch {} }
        es.dispatchEvent(ev);
      }
    }
  }
  function installWebSocket() {
    // C1: WebSocket boundary fidelity (RFC 6455). Sub-protocol selection
    // §4.2.2, close code/reason validation §7.4 (code: 1000 or [3000,4999];
    // reason ≤ 123 UTF-8 bytes), binaryType setter validation,
    // bufferedAmount accounting. Close events report the peer's handshake,
    // never a requested status disguised as a successful transport close.
    const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
    const tokenRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function protocolList(protocols) {
      if (protocols == null) return [];
      const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.slice() : null;
      if (!list) throw normalizedError('SyntaxError');
      const out = [];
      const seen = new Set();
      for (const p of list) {
        const s = String(p);
        if (!s || !tokenRE.test(s) || seen.has(s)) throw normalizedError('SyntaxError');
        seen.add(s);
        out.push(s);
      }
      return out;
    }
    // RFC 6455 §7.4: close code must be 1000 or in [3000, 4999].
    function validateCloseCode(code) {
      if (code === undefined) return;
      const n = Number(code);
      if (!Number.isFinite(n) || (n !== 1000 && (n < 3000 || n > 4999))) {
        throw normalizedError('InvalidAccessError');
      }
    }
    // RFC 6455 §7.4.1: close reason ≤ 123 UTF-8 bytes.
    function validateReason(reason) {
      if (reason === undefined || reason === '') return;
      const enc = (typeof TextEncoder === 'function') ? new TextEncoder().encode(String(reason)) : null;
      const len = enc ? enc.length : String(reason).length;
      if (len > 123) throw normalizedError('SyntaxError');
    }
    function utf8ByteLength(s) {
      if (typeof TextEncoder === 'function') {
        try { return new TextEncoder().encode(s).length; } catch {}
      }
      return s.length;
    }
    function payloadByteLength(data) {
      if (typeof data === 'string') return utf8ByteLength(data);
      if (data instanceof ArrayBuffer) return data.byteLength;
      if (Native.Blob && data instanceof Native.Blob) return data.size;
      if (data && typeof data.byteLength === 'number') return data.byteLength;
      return 0;
    }
    function closeEvent(code, reason, wasClean) {
      try { return new CloseEvent('close', { code, reason, wasClean }); }
      catch { const ev = new Event('close'); try { Object.defineProperties(ev, { code: { value: code }, reason: { value: reason }, wasClean: { value: wasClean } }); } catch {} return ev; }
    }
    function finish(ws, code, reason, wasClean) {
      if (ws._closed) return;
      ws._closed = true;
      ws.readyState = CLOSED;
      if (ws._closeGuard != null) { try { Native.clearTimeout(ws._closeGuard); } catch {} ws._closeGuard = null; }
      if (ws._port) {
        ws._port.onmessage = null;
        try { ws._port.close(); } catch {}
        ws._port = null;
      }
      ws.dispatchEvent(closeEvent(code, reason, wasClean));
    }
    function abort(ws) {
      try { if (ws._port) ws._port.postMessage({ type: 'abort' }); } catch {}
    }
    function fail(ws) {
      if (ws._closed) return;
      abort(ws);
      ws.dispatchEvent(new Event('error'));
      finish(ws, 1006, '', false);
    }
    function ZPWebSocket(url, protocols) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      this.url = targetWSURL(url);
      this.protocol = '';
      this.extensions = '';
      this.readyState = CONNECTING;
      this._port = null;
      this._closed = false;
      this._closeGuard = null;
      this._bufferedAmount = 0;
      this._binaryType = 'blob';
      const plist = protocolList(protocols);
      this._requestedProtocols = plist;
      ctx.bridge.send({ type: ZP.MSG.WS_OPEN, url: this.url, protocols: plist, tabId: boot.tabId, entryId: activeEntryId }).then(reply => {
        if (this._closed || this.readyState === CLOSING) {
          // close() canceled the opening handshake; do not leave the late
          // kernel stream waiting for an echo or dispatch a second close.
          try { if (reply.port) reply.port.postMessage({ type: 'abort' }); }
          finally { if (reply.port) reply.port.close(); }
          return;
        }
        this._port = reply.port;
        const negotiated = String(reply.protocol || '');
        // RFC 6455 §4.2.2: server must pick from the offered list.
        if (negotiated && plist.indexOf(negotiated) < 0) {
          fail(this);
          return;
        }
        this.protocol = negotiated;
        this._port.onmessage = ev => {
          if (this._closed) return;
          const m = ev.data || {};
          if (m.type === 'message') {
            let data = m.data;
            if (this._binaryType === 'blob' && data instanceof ArrayBuffer && Native.Blob) {
              data = new Native.Blob([data]);
            } else if (this._binaryType === 'arraybuffer' && Native.Blob && data instanceof Native.Blob) {
              data.arrayBuffer().then(buf => {
                if (this._closed) return;
                this.dispatchEvent(new MessageEvent('message', { data: buf, origin: new URL(this.url).origin }));
              }).catch(() => fail(this));
              return;
            }
            this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
          } else if (m.type === 'error') {
            fail(this);
          } else if (m.type === 'close') {
            finish(this, m.code, m.reason || '', m.code !== 1006);
          } else if (m.type === 'senddrained' && typeof m.bytes === 'number') {
            // The kernel acknowledges bytes consumed from the send queue.
            this._bufferedAmount = Math.max(0, this._bufferedAmount - m.bytes);
          }
        };
        this._port.start && this._port.start();
        this.readyState = OPEN;
        this.dispatchEvent(new Event('open'));
      }).catch(() => fail(this));
    }
    ZPWebSocket.CONNECTING = CONNECTING; ZPWebSocket.OPEN = OPEN; ZPWebSocket.CLOSING = CLOSING; ZPWebSocket.CLOSED = CLOSED;
    ZPWebSocket.prototype = { CONNECTING, OPEN, CLOSING, CLOSED };
    installEventMethods(ZPWebSocket.prototype);
    assignMasked(ZPWebSocket.prototype, {
      constructor: ZPWebSocket,
      send(data) {
        if (this.readyState === CONNECTING) throw normalizedError('InvalidStateError');
        if (this.readyState !== OPEN || !this._port) {
          // CLOSING/CLOSED: spec silently grows bufferedAmount and drops.
          this._bufferedAmount += payloadByteLength(data);
          return;
        }
        const bytes = payloadByteLength(data);
        this._bufferedAmount += bytes;
        if (Native.Blob && data instanceof Native.Blob) {
          data.arrayBuffer().then(buf => {
            if (this.readyState === OPEN && this._port) {
              this._port.postMessage({ type: 'send', data: buf, bytes });
            } else {
              this._bufferedAmount = Math.max(0, this._bufferedAmount - bytes);
            }
          }).catch(() => fail(this));
          return;
        }
        this._port.postMessage({ type: 'send', data, bytes });
      },
      close(code, reason) {
        validateCloseCode(code);
        validateReason(reason);
        if (this._closed || this.readyState === CLOSING || this.readyState === CLOSED) return;
        const finalCode = code === undefined ? 1000 : Number(code);
        const finalReason = reason === undefined ? '' : String(reason);
        this.readyState = CLOSING;
        if (!this._port) {
          // A canceled opening handshake has no peer close status. Dispatch
          // asynchronously so handlers installed after close() still observe it.
          this._closeGuard = Native.setTimeout(() => fail(this), 0);
          return;
        }
        // Wait for the peer's close frame; a missing echo is an abnormal close.
        this._closeGuard = Native.setTimeout(() => {
          if (this._closed) return;
          abort(this);
          finish(this, 1006, '', false);
        }, 30000);
        try { this._port.postMessage({ type: 'close', code: finalCode, reason: finalReason }); }
        catch { fail(this); }
      }
    });
    // bufferedAmount: read-only per IDL.
    try {
      // ZPWebSocket.prototype is a fresh object literal, so unlike XHR/EventSource
      // (which reuse a function's default .prototype) it has no inherited
      // non-enumerable `constructor` slot — Object.assign created an enumerable
      // one, putting `constructor` into Object.keys where no browser has it.
      Object.defineProperty(ZPWebSocket.prototype, 'constructor', {
        value: ZPWebSocket, writable: true, enumerable: false, configurable: true,
      });
      defineMasked(ZPWebSocket.prototype, 'bufferedAmount', {
        configurable: false,
        enumerable: true, // Web IDL attributes are enumerable; these two were the
                          // only members of the replaced classes still hiding.
        get() { return this._bufferedAmount | 0; },
      });
    } catch {}
    // binaryType: strict enum; invalid assignments silently dropped (browser-equivalent).
    try {
      defineMasked(ZPWebSocket.prototype, 'binaryType', {
        configurable: false,
        enumerable: true,
        get() { return this._binaryType; },
        set(v) {
          const s = String(v);
          if (s === 'blob' || s === 'arraybuffer') this._binaryType = s;
        },
      });
    } catch {}
    mirrorNativeProto(ZPWebSocket.prototype,
      ['url', 'readyState', 'onopen', 'onerror', 'onclose', 'onmessage', 'extensions', 'protocol'],
      Native.WebSocket && Native.WebSocket.prototype);
    brandLikeNative(ZPWebSocket, ZPWebSocket.prototype, 'WebSocket');
    define(root, 'WebSocket', ZPWebSocket);
  }

  function installWebSocketStream() {
    if (!root.WebSocket || !root.ReadableStream || !root.WritableStream) return;
    const states = new WeakMap();
    const stateOf = receiver => {
      const state = states.get(receiver);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    };
    function ZPWebSocketStream(url, options = {}) {
      if (!new.target) throw new TypeError("Failed to construct 'WebSocketStream': Please use the 'new' operator.");
      if (!arguments.length) throw new TypeError('WebSocketStream requires a URL');
      options = options || {};
      const ws = new root.WebSocket(url, options.protocols);
      ws.binaryType = 'arraybuffer';
      let openResolve, openReject, closeResolve, closeReject;
      let readableController, writableController;
      let opened = false, finished = false, canceled = false;
      const state = {
        ws,
        opened: new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; }),
        closed: new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; })
      };
      states.set(this, state);
      // Both promises remain rejectable for consumers; an unused lifecycle
      // promise must not create an unrelated unhandled rejection.
      state.opened.catch(() => {});
      state.closed.catch(() => {});
      const signal = options.signal;
      const cleanup = () => { if (signal) signal.removeEventListener('abort', abort); };
      const fail = error => {
        if (finished) return;
        finished = true;
        cleanup();
        if (!opened) openReject(error);
        closeReject(error);
        if (!canceled) readableController.error(error);
        writableController.error(error);
      };
      const readable = new root.ReadableStream({
        start(controller) { readableController = controller; },
        cancel() { canceled = true; ws.close(); return state.closed.then(() => undefined); }
      });
      const writable = new root.WritableStream({
        start(controller) { writableController = controller; },
        write(chunk) {
          if (ws.readyState !== 1) throw normalizedError('InvalidStateError');
          ws.send(chunk);
        },
        close() { ws.close(); return state.closed.then(() => undefined); },
        abort() { ws.close(); return state.closed.then(() => undefined); }
      });
      function abort() { fail(signal.reason || normalizedError('AbortError')); ws.close(); }
      ws.onopen = () => {
        if (finished) return;
        opened = true;
        cleanup();
        openResolve({ readable, writable, protocol: ws.protocol, extensions: ws.extensions || '' });
      };
      ws.onmessage = event => { if (!finished && !canceled) readableController.enqueue(event.data); };
      ws.onerror = () => fail(normalizedError('NetworkError'));
      ws.onclose = event => {
        if (finished) return;
        if (!opened || !event.wasClean) { fail(normalizedError('NetworkError')); return; }
        finished = true;
        cleanup();
        if (!canceled) readableController.close();
        closeResolve({ closeCode: event.code, reason: event.reason });
      };
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    }
    definePropertiesMasked(ZPWebSocketStream.prototype, {
      url: { get() { return stateOf(this).ws.url; }, enumerable: true },
      opened: { get() { return stateOf(this).opened; }, enumerable: true },
      closed: { get() { return stateOf(this).closed; }, enumerable: true }
    });
    define(ZPWebSocketStream.prototype, 'close', function close(options = {}) {
      const ws = stateOf(this).ws;
      options = options || {};
      ws.close(options.closeCode, options.reason);
    });
    brandLikeNative(ZPWebSocketStream, ZPWebSocketStream.prototype, 'WebSocketStream');
    define(root, 'WebSocketStream', ZPWebSocketStream);
  }
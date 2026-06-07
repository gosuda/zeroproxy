/* ZeroProxy Service Worker response helpers. */
(self => {
  'use strict';

  function isCORSPreflight(req) {
    return req.method === 'OPTIONS' && req.headers.has('Access-Control-Request-Method');
  }

  function corsPreflight(req) {
    const h = new Headers();
    applyCORS(h, req);
    h.set('Access-Control-Max-Age', '86400');
    h.set('Cache-Control', 'no-store');
    return new Response(null, { status: 204, headers: h });
  }

  function applyCORS(h, req) {
    const origin = (req && req.headers.get('Origin')) || '*';
    h.set('Access-Control-Allow-Origin', origin);
    if (origin !== '*') h.set('Vary', h.get('Vary') ? `${h.get('Vary')}, Origin` : 'Origin');
    h.set('Access-Control-Allow-Credentials', 'true');
    h.set(
      'Access-Control-Allow-Methods',
      (req && req.headers.get('Access-Control-Request-Method')) ||
        'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    h.set('Access-Control-Allow-Headers', (req && req.headers.get('Access-Control-Request-Headers')) || '*');
    h.set('Access-Control-Expose-Headers', '*');
  }

  function normalizedByteStream(body) {
    if (!body || typeof body.getReader !== 'function') return body || null;
    const reader = body.getReader();
    const encoder = new TextEncoder();
    return new ReadableStream({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          closeReader(controller, reader);
          return;
        }
        if (next.value != null) await enqueueNormalizedValue(controller, next.value, encoder);
      },
      cancel(reason) {
        try {
          reader.cancel(reason);
        } catch {}
        releaseReader(reader);
      },
    });
  }

  function closeReader(controller, reader) {
    controller.close();
    releaseReader(reader);
  }

  function releaseReader(reader) {
    try {
      reader.releaseLock();
    } catch {}
  }

  async function enqueueNormalizedValue(controller, value, encoder) {
    if (value instanceof Uint8Array) {
      controller.enqueue(value);
    } else if (value instanceof ArrayBuffer) {
      controller.enqueue(new Uint8Array(value));
    } else if (value && value.buffer instanceof ArrayBuffer) {
      controller.enqueue(new Uint8Array(value.buffer, value.byteOffset || 0, byteLengthFor(value)));
    } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      controller.enqueue(new Uint8Array(await value.arrayBuffer()));
    } else if (typeof value === 'string') {
      controller.enqueue(encoder.encode(value));
    } else {
      controller.enqueue(encoder.encode(String(value)));
    }
  }

  function byteLengthFor(value) {
    return value.byteLength || value.buffer.byteLength;
  }

  function addCSP(resp, req, servers) {
    const h = new Headers(resp.headers);
    const allowDynamicCompile = h.get('X-ZP-Dynamic-Compile') === '1';
    h.delete('X-ZP-Dynamic-Compile');
    h.delete('Permissions-Policy');
    h.delete('Feature-Policy');
    h.set('Content-Security-Policy', ZP.fixedCSP(servers || [], { allowDynamicCompile }));
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Cache-Control', h.get('Cache-Control') || 'no-store');
    applyCORS(h, req);
    const out = new Response(normalizedByteStream(resp.body), {
      status: resp.status,
      statusText: resp.statusText,
      headers: h,
    });
    copyTransportTiming(resp, out);
    return out;
  }

  function copyTransportTiming(src, dst) {
    if (!src || !src.__zpTransportTiming) return;
    try {
      Object.defineProperty(dst, '__zpTransportTiming', {
        value: src.__zpTransportTiming,
        enumerable: false,
        configurable: false,
      });
    } catch {}
  }

  function safeError(code, status = 400, targetUrl = '', timing = null) {
    const safeCode = ZP.ERRORS.includes(code) ? code : 'POLICY_BLOCKED';
    const hostHTML = targetHostHTML(targetUrl);
    const body =
      '<!doctype html><meta charset="utf-8"><title>ZeroProxy ' +
      safeCode +
      '</title><main><h1>ZeroProxy</h1><p>' +
      safeCode +
      '</p>' +
      hostHTML +
      '<button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>';
    const resp = new Response(body, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': ZP.fixedCSP(),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
      },
    });
    if (timing && typeof timing === 'object') {
      try {
        Object.defineProperty(resp, '__zpTransportTiming', {
          value: timing,
          enumerable: false,
          configurable: false,
        });
      } catch {}
    }
    return resp;
  }

  function targetHostHTML(targetUrl) {
    let host = '';
    try {
      host = targetUrl ? new URL(targetUrl).host : '';
    } catch {}
    return host ? '<p>Target host: ' + escapeHTML(host) + '</p>' : '';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[ch]);
  }

  function scriptResponseHeaders(resp) {
    const h = new Headers(resp.headers);
    h.set('Content-Type', 'text/javascript; charset=utf-8');
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Security-Policy', ZP.fixedCSP([]));
    applyCORS(h, null);
    return h;
  }

  self.ZPSWResponses = Object.freeze({
    addCSP,
    applyCORS,
    corsPreflight,
    escapeHTML,
    isCORSPreflight,
    normalizedByteStream,
    safeError,
    scriptResponseHeaders,
  });
})(self);

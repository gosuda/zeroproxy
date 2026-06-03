/* Shared ZeroProxy HTTP body rewriter facade for service worker and target realms. */
(() => {
  'use strict';
  if (globalThis.ZPHTTPRewriter) return;

  const BLOCK_CODE = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";

  function rewriteError(code) {
    let err;
    try { err = new DOMException('Blocked by ZeroProxy rewrite policy', 'NotSupportedError'); }
    catch {
      err = new Error('Blocked by ZeroProxy rewrite policy');
      err.name = 'NotSupportedError';
    }
    try { Object.defineProperty(err, 'zpErrorCode', { value: code || 'REWRITE_FAILED' }); }
    catch {}
    return err;
  }

  function api() {
    const rw = globalThis.ZPRewriter;
    return rw && rw.ready ? rw : null;
  }

  function requireScriptAPI() {
    const rw = api();
    if (!rw || typeof rw.rewriteScript !== 'function') throw rewriteError('REWRITER_UNAVAILABLE');
    return rw;
  }

  function rewriteScriptCall(source, options = {}) {
    const rw = requireScriptAPI();
    return rw.rewriteScript(String(source || ''), {
      kind: options.kind || 'classic',
      targetUrl: options.targetUrl || options.url || '',
      strict: options.strict !== false,
      controlPrefix: options.controlPrefix || (globalThis.ZP && globalThis.ZP.CONTROL_PREFIX) || '/zp/',
      tabId: options.tabId || options.tab || '',
      runtimeToken: options.runtimeToken || options.rt || '',
    });
  }

  function stableFailureCode(raw, fallback) {
    if (typeof raw !== 'string' || !/^[A-Z0-9_:-]{1,64}$/.test(raw)) return fallback;
    return raw;
  }

  function rewriteFailureCode(value) {
    const raw = value && (value.zpErrorCode || value.errorCode || value.error);
    return stableFailureCode(raw, 'REWRITE_FAILED');
  }

  function rewriteScriptResult(source, options = {}) {
    const out = rewriteScriptCall(source, options);
    if (!out || !out.ok || typeof out.code !== 'string') throw rewriteError(rewriteFailureCode(out));
    return out.code;
  }

  function rewriteScriptSource(source, options = {}) {
    return rewriteScriptResult(source, options);
  }

  function rewriteScriptOrBlock(source, options = {}) {
    return rewriteScriptOutcome(source, options).code;
  }

  function rewriteScriptOutcome(source, options = {}) {
    try {
      const out = rewriteScriptCall(source, options);
      if (out && out.ok && typeof out.code === 'string') return { blocked: false, code: out.code, errorCode: '' };
      return { blocked: true, code: blockSource(), errorCode: rewriteFailureCode(out) };
    } catch (err) {
      return { blocked: true, code: blockSource(), errorCode: rewriteFailureCode(err) };
    }
  }

  function rewriteFunctionBody(source, params, targetUrl, controlPrefix) {
    const rw = api();
    if (!rw || typeof rw.rewriteFunctionBody !== 'function') throw rewriteError();
    const out = rw.rewriteFunctionBody(
      String(source || ''),
      Array.isArray(params) ? params : [],
      targetUrl || '',
      controlPrefix || (globalThis.ZP && globalThis.ZP.CONTROL_PREFIX) || '/zp/',
    );
    if (!out || !out.ok || typeof out.code !== 'string') throw rewriteError();
    return out.code;
  }

  function rewriteCSSSource(source, options = {}) {
    const fallback = typeof options.fallback === 'function' ? options.fallback : () => '';
    const rw = api();
    if (!rw || typeof rw.rewriteCSS !== 'function') return fallback(source, options.baseUrl);
    const out = rw.rewriteCSS(String(source || ''), {
      baseUrl: options.baseUrl || options.url || '',
      controlPrefix: options.controlPrefix || (globalThis.ZP && globalThis.ZP.CONTROL_PREFIX) || '/zp/',
    });
    return out && out.ok && typeof out.code === 'string' ? out.code : fallback(source, options.baseUrl);
  }

  function blockSource() {
    const rw = api();
    return rw && typeof rw.blockSource === 'function' ? rw.blockSource() : BLOCK_CODE;
  }

  const shared = Object.freeze({
    ready() { return !!api(); },
    rewriteScriptSource,
    rewriteScriptOrBlock,
    rewriteScriptOutcome,
    rewriteFunctionBody,
    rewriteCSSSource,
    blockSource,
  });

  Object.defineProperty(globalThis, 'ZPHTTPRewriter', {
    value: shared,
    enumerable: false,
    configurable: false,
    writable: false,
  });
})();

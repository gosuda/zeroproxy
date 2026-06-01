/* Shared ZeroProxy HTTP body rewriter facade for service worker and target realms. */
(() => {
  'use strict';
  if (globalThis.ZPHTTPRewriter) return;

  const BLOCK_CODE = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";

  function rewriteError() {
    try { return new DOMException('Blocked by ZeroProxy rewrite policy', 'NotSupportedError'); }
    catch {
      const err = new Error('Blocked by ZeroProxy rewrite policy');
      err.name = 'NotSupportedError';
      return err;
    }
  }

  function api() {
    const rw = globalThis.ZPRewriter;
    return rw && rw.ready ? rw : null;
  }

  function requireScriptAPI() {
    const rw = api();
    if (!rw || typeof rw.rewriteScript !== 'function') throw rewriteError();
    return rw;
  }

  function rewriteScriptResult(source, options = {}) {
    const rw = requireScriptAPI();
    const out = rw.rewriteScript(String(source || ''), {
      kind: options.kind || 'classic',
      targetUrl: options.targetUrl || options.url || '',
      strict: options.strict !== false,
      controlPrefix: options.controlPrefix || (globalThis.ZP && globalThis.ZP.CONTROL_PREFIX) || '/zp/',
    });
    if (!out || !out.ok || typeof out.code !== 'string') throw rewriteError();
    return out.code;
  }

  function rewriteScriptSource(source, options = {}) {
    return rewriteScriptResult(source, options);
  }

  function rewriteScriptOrBlock(source, options = {}) {
    try { return rewriteScriptResult(source, options); }
    catch { return blockSource(); }
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
    const fallback = typeof options.fallback === 'function' ? options.fallback : (value) => String(value || '');
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

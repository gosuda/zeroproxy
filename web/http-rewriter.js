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
    const first = attemptRewriteScript(source, options);
    if (!first.blocked) return first;
    const recovery = [];
    for (const variant of safeRewriteVariants(source, options, first.errorCode)) {
      recovery.push(variant.kind);
      const out = attemptRewriteScript(variant.source, Object.assign({}, options, variant.options || {}));
      if (!out.blocked) return Object.assign(out, { recovery: { attempted: recovery, used: variant.kind } });
    }
    return Object.assign(first, recovery.length ? { recovery: { attempted: recovery, used: '' } } : {});
  }

  function attemptRewriteScript(source, options) {
    try {
      const out = rewriteScriptCall(source, options);
      if (out && out.ok && typeof out.code === 'string') return { blocked: false, code: out.code, errorCode: '' };
      const errorCode = rewriteFailureCode(out);
      return { blocked: true, code: blockSource(), errorCode, failureTelemetry: rewriteFailureTelemetry(source, options, errorCode) };
    } catch (err) {
      const errorCode = rewriteFailureCode(err);
      return { blocked: true, code: blockSource(), errorCode, failureTelemetry: rewriteFailureTelemetry(source, options, errorCode) };
    }
  }

  function rewriteFailureTelemetry(source, options, errorCode) {
    const text = String(source || '');
    return {
      schema: 'zp.rewrite.failure.v1',
      rewriteKind: String(options.kind || 'classic'),
      sourceSizeBucket: sourceSizeBucket(text.length),
      parserErrorKind: errorCode === 'PARSE_FAILED' ? 'parse-failed' : '',
      contentType: String(options.contentType || ''),
      charset: String(options.charset || ''),
      finalAction: 'block',
    };
  }

  function sourceSizeBucket(size) {
    if (size <= 0) return '0B';
    if (size < 1024) return '<1KiB';
    if (size < 16 * 1024) return '<16KiB';
    if (size < 256 * 1024) return '<256KiB';
    return '>=256KiB';
  }

  function safeRewriteVariants(source, options, errorCode) {
    if (errorCode !== 'PARSE_FAILED') return [];
    const text = String(source || '');
    const out = [];
    if (text.charCodeAt(0) === 0xfeff) out.push({ kind: 'strip-bom', source: text.slice(1) });
    pushKindRecoveryVariants(out, text, rewriteKind(options));
    return out;
  }

  function pushKindRecoveryVariants(out, text, kind) {
    if (kind === 'classic') return pushClassicRecoveryVariants(out, text);
    if (kind === 'module' && !hasModuleSyntax(text)) {
      out.push({ kind: 'module-to-classic', source: text, options: { kind: 'classic' } });
    }
  }

  function pushClassicRecoveryVariants(out, text) {
    const htmlCommentSafe = normalizeClassicHTMLComments(text);
    if (htmlCommentSafe !== text) out.push({ kind: 'classic-html-comment', source: htmlCommentSafe });
    if (hasModuleSyntax(text)) {
      out.push({ kind: 'classic-to-module', source: text, options: { kind: 'module' } });
    }
  }

  function rewriteKind(options) {
    return options && options.kind || 'classic';
  }

  function hasModuleSyntax(text) {
    return /^\s*(?:import|export)\b/m.test(text);
  }

  function normalizeClassicHTMLComments(source) {
    return String(source || '')
      .replace(/^(\s*)<!--/, '$1//<!--')
      .replace(/(^|\n)(\s*)-->/g, '$1$2//-->');
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

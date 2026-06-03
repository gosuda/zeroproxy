/* ZeroProxy Service Worker route helpers. */
(self => {
  'use strict';

  function internalPath(path) {
    return path === '/favicon.ico' ||
      path === ZP.assetPath('zp-core.js') ||
      path === ZP.assetPath('rust-rewriter.js') ||
      path === ZP.assetPath('rust-rewriter.wasm') ||
      path === ZP.assetPath('http-rewriter.js') ||
      path === ZP.assetPath('runtime-prelude.js') ||
      path === ZP.assetPath('worker-prelude.js') ||
      path === ZP.assetPath('wasm_exec.js') ||
      path === ZP.controlPath('kernel.wasm') ||
      path === ZP.controlPath('worker-bootstrap.js') ||
      path === ZP.assetPath('favicon.ico') ||
      path === ZP.assetPath('manifest.webmanifest');
  }

  function isInternalAssetPath(pathname) {
    return pathname === ZP.CONTROL_PREFIX ||
      pathname === ZP.controlPath('index.html') ||
      pathname === ZP.controlPath('sw.js') ||
      internalPath(pathname);
  }

  function isRuntimeAPIPath(path) {
    return path === ZP.apiPath('fetch') ||
      path === ZP.apiPath('script') ||
      path === ZP.apiPath('worker-script');
  }

  function parseSharePath(path) {
    const m = /^\/zp\/p\/([^/]+)$/.exec(path);
    if (!m) return null;
    return { routeKey: m[1] };
  }

  function sameOriginTargetURL(sameOriginURL, ctx) {
    const baseTargetURL = ctx.baseUrl || ctx.targetUrl;
    if (sameOriginURL.pathname.startsWith(ZP.controlPath('p/'))) {
      return new URL(
        sameOriginURL.pathname.slice(ZP.controlPath('p/').length) + sameOriginURL.search,
        baseTargetURL,
      ).href;
    }
    const path = sameOriginURL.pathname.startsWith(ZP.CONTROL_PREFIX) ?
      '/' + sameOriginURL.pathname.slice(ZP.CONTROL_PREFIX.length) :
      sameOriginURL.pathname;
    return new URL(path + sameOriginURL.search, baseTargetURL).href;
  }

  self.ZPSWRoutes = Object.freeze({
    internalPath,
    isInternalAssetPath,
    isRuntimeAPIPath,
    parseSharePath,
    sameOriginTargetURL,
  });
})(self);

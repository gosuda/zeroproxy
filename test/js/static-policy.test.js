const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRuntimeSource() {
  return [
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/abi/artifact-masking.mjs', 'utf8'),
    fs.readFileSync('web/runtime/abi/native-capture.mjs', 'utf8'),
    fs.readFileSync('web/runtime/dynamic-code/facade.mjs', 'utf8'),
    fs.readFileSync('web/runtime/dynamic-code/source.mjs', 'utf8'),
    fs.readFileSync('web/runtime/dom/attributes.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/document.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/events.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/fingerprinting.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/history.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/location.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/navigator.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/storage.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/accessors.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/child-rewrite.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/messaging.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/policy.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/sandbox.mjs', 'utf8'),
    fs.readFileSync('web/runtime/network/http.mjs', 'utf8'),
    fs.readFileSync('web/runtime/network/websocket.mjs', 'utf8'),
    fs.readFileSync('web/runtime/workers/facades.mjs', 'utf8'),
  ].join('\n');
}

const legacyServiceWorkerPaths = [
  'web/sw.js',
  'web/sw-entry.mjs',
  'web/sw/kernel.js',
  'web/sw/routes.js',
  'web/sw/transport.js',
  'web/sw/responses.js',
];

function assertLegacyServiceWorkerDeleted() {
  for (const file of legacyServiceWorkerPaths) {
    assert.equal(fs.existsSync(file), false, `${file} must be deleted after QuickJS cutover`);
  }
}

function htmlFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(p);
  }
  return out.sort();
}

function runtimeSrcdocHelpers() {
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  return {
    runtimePreludeMarkup: rt.match(
      /function runtimePreludeMarkup\(bootValue\) \{\s+return `([^`]+)`;\s+\}/,
    ),
    fullSource: rt,
  };
}

test('legacy service worker source path is deleted', () => {
  assertLegacyServiceWorkerDeleted();
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.equal(build.includes('sw-entry.mjs'), false);
  assert.equal(server.includes('controlPrefix + "sw.js"'), false);
});

test('runtime avoids stale escape gaps and forbidden harness markers', () => {
  const rt = readRuntimeSource();
  assert.ok(rt.includes('installToStringMasking'));
  assert.equal(rt.includes('Object.getOwnPropertyDescriptor ='), false);
  assert.equal(rt.includes('window.__zp'), false);
  assert.equal(rt.includes('queueMicrotask'), false);
  assert.ok(rt.includes('Function.prototype.toString'));
});

test('runtime membrane uses captured native WeakMap lookup for raw unwrapping', () => {
  const rt = readRuntimeSource();
  assert.ok(rt.includes("weakMapGet: value(proto(w, 'WeakMap'), 'get')"));
  assert.match(rt, /function proto\(w, name\)[\s\S]*return value\(w\[name\], 'prototype'\)/);
  assert.ok(rt.includes('reflectApply(Native.weakMapGet, membraneRawTargets, [value])'));
  assert.ok(rt.includes('return reflectApply(fn, rawBase, callArgs);'));
});

test('runtime dynamic constructor descriptors stay assignable for app bundles', () => {
  const rt = readRuntimeSource();
  assert.match(
    rt,
    /ctor\.prototype,\s*'constructor',\s*\{\s*value: wrapper,\s*enumerable: false,\s*configurable: true,\s*writable: true\s*\}/,
  );
  assert.match(rt, /const containedFunction = containedChildFunction\(childFunction\);/);
  assert.match(rt, /define\(w,\s*'Function',\s*containedFunction\)/);
  assert.match(
    rt,
    /childFunction\.prototype,\s*'constructor',\s*\{\s*value: containedFunction,\s*enumerable: false,\s*configurable: true,\s*writable: true\s*\}/,
  );
  assert.equal(
    rt.includes(
      "ctor.prototype, 'constructor', { value: wrapper, enumerable: false, configurable: false, writable: false }",
    ),
    false,
  );
  assert.equal(
    rt.includes(
      "childFunction.prototype, 'constructor', { value: root.Function, enumerable: false, configurable: false, writable: false }",
    ),
    false,
  );
  assert.equal(rt.includes("define(w, 'Function', root.Function)"), false);
});

test('runtime preserves native direct eval for lexical generated functions', () => {
  const rt = readRuntimeSource();
  assert.ok(
    rt.includes('eval: w.eval'),
    'native eval capture is required for string timer compatibility',
  );
  assert.equal(
    rt.includes("defineReplacingNative(root, 'eval'"),
    false,
    'bare eval must keep native direct-eval lexical scope',
  );
  assert.equal(
    rt.includes("if (name === 'eval')"),
    false,
    'global helper reads must not redirect bare eval through a facade',
  );
  assert.ok(
    rt.includes('function rewritePageSource()'),
    'legacy native page-source rewrite hook must be reduced to a fail-closed stub',
  );
  assert.ok(
    rt.includes("throw normalizedError('NotSupportedError');"),
    'legacy native dynamic/eval source must fail closed after QuickJS cutover',
  );
  assert.ok(
    rt.includes('return current === Native.eval ? indirectEval : current;'),
    'native window.eval reads must receive the indirect fail-closed eval wrapper',
  );
  assert.equal(
    rt.includes('with(__zp_eval_scope())'),
    false,
    'direct eval must not use a with-scope wrapper',
  );
  const dynamic = fs.readFileSync('web/runtime/dynamic-code/facade.mjs', 'utf8');
  assert.ok(
    dynamic.includes("throw normalizedError('NotSupportedError');"),
    'string timers and dynamic Function wrappers must fail closed in native prelude',
  );
  assert.equal(
    dynamic.includes('__ZP_EVAL_SCOPE'),
    false,
    'string timers must not use with-scope eval state',
  );
  assert.equal(
    rt.includes('return compileEvalSource(text).call(root, scope);'),
    false,
    'dynamic eval must not fall back to rewritten Function compilation',
  );
  assert.equal(
    rt.includes('function compileEvalSource'),
    false,
    'dynamic eval fallback compiler must not exist',
  );
});

test('runtime reads boot config from self-removing prelude state', () => {
  const rt = readRuntimeSource();
  const tx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  assert.ok(rt.includes('root.__ZP_BOOT'));
  assert.ok(rt.includes('delete root.__ZP_BOOT'));
  assert.ok(tx.includes('document.currentScript.remove()'));
  assert.equal(tx.includes('id=__zp-boot'), false);
  assert.equal(rt.includes("getElementById('__zp-boot')"), false);
});

test('runtime installs required escape-vector hooks', () => {
  const rt = readRuntimeSource();
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  for (const needle of [
    "document.addEventListener('click'",
    "root.addEventListener('click'",
    'HTMLFormElement.prototype',
    'popstate',
    'ZP_RESOLVE_ENTRY',
    'ZP_SCROLL_UPDATE',
    'runtimeToken',
    "define(w.document, 'createElement'",
    "define(w, 'open'",
    "'appendChild'",
    "'insertBefore'",
    "'replaceChild'",
    "'append'",
    "'prepend'",
    "'before'",
    "'after'",
    "'replaceWith'",
    "'insertAdjacentHTML'",
    "'getAttribute'",
    'installNetworkContainment',
    "'contentWindow'",
    "'contentDocument'",
    'new WeakSet',
    "attributeFilter: ['href', 'xlink:href', 'src', 'srcset', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'style', 'name', 'http-equiv', 'content']",
    'enforceObservedAttribute',
    'data-zp-integrity',
    'installIntegrityProp',
    'installScriptProp',
    'installLinkProp',
    'installResourceURLProps',
    'shouldBlockURLAttribute',
    'installToStringMasking',
    'toStringMap',
    'installPerformanceMasking',
    'PerformanceObserver',
    'performanceObserverListFacade',
    'installCanvasAntiFingerprinting',
    'getImageData',
    'toDataURL',
    'installAudioAntiFingerprinting',
    'getChannelData',
    'speechSynthesis',
    'getVoices',
    'installStorageFacades',
    'localStorage',
    'indexedDB',
    'caches',
    'documentCookieString',
    'normalizeSameSite',
    'ZP_COOKIE_SYNC',
    'X-ZP-Tab-Id',
    'X-ZP-Runtime-Token',
    'syncReferrerPolicyElement',
    'documentReferrerPolicy',
    'suppressMetaPolicyElement',
    "localKey === 'http-equiv'",
    'unwrapRaw(base === scope ? root : base)',
    "trimmed.startsWith('blob:')",
    'src*="zp"',
    "objectDefineProperty(root, 'Worker'",
    "objectDefineProperty(root, 'SharedWorker'",
    "throw normalizedError('NotSupportedError')",
    "maskNativeFunction(ZPWorker, 'Worker')",
    "maskNativeFunction(ZPSharedWorker, 'SharedWorker')",
    "define(wk, 'addModule', function(){ return Promise.reject(normalizedError('NotSupportedError')); })",
    "objectDefineProperty(URL, 'createObjectURL'",
    'return Native.createObjectURL(blob);',
    "throw normalizedError('NotSupportedError')",
    'configurable: true',
    'w.addEventListener && reflectApply(functionBind, w.addEventListener, [w])',
    'rawPostMessageTarget(target)',
    "objectDefineProperty(ev, 'origin'",
    "name === 'origin'",
    "base === document && prop === 'location'",
    'frameOriginForSource(ev.source)',
    'shouldContainFrameWindow: isInitialAboutBlankFrame',
    'shouldContainFrameWindow && shouldContainFrameWindow(this, childWin)',
    'installRequestFacade',
    'return new Native.Request(requestLike ? input : requestTargetURL(input), init)',
    'eventHandlerBindings',
    'data-zp-event-',
    "Native.FunctionCtor('event'",
    'bindEventAttribute',
    "'WebSocketStream'",
    'getUserMedia',
    'mediaDevices',
    'installPhase2Membrane',
    '__zp_runClassic',
    '__zp_get',
    '__zp_assign',
    "defineReplacingNative(root, 'setTimeout'",
    "defineReplacingNative(root, 'setInterval'",
    'installDocumentWriteHooks',
    'createContextualFragment',
    'parseFromString',
    'rewriteEventAttribute',
    'enforceSubtreePolicies',
    'installTargetServiceWorkerBlocker',
    'shareRouteForTarget',
    'makeShareURL',
    'postMessageWrapperFor',
    'frameSandboxAllowsEscape',
    'setFrameSandboxAttribute',
    'sanitizeFrameSandbox',
    'objectGetPrototypeOf: nativeObjectGetPrototypeOf',
    'reflectGetPrototypeOf: nativeReflectGetPrototypeOf',
  ])
    assert.ok(rt.includes(needle), `missing ${needle}`);
  assert.equal(rt.includes("document.addEventListener('submit'"), false);
  for (const needle of [
    'makeWorkerLocationFacade',
    "objectDefineProperty(self, 'location'",
    "'WorkerLocation'",
    "objectDefineProperty(self, 'origin'",
    'maskNativeFunction',
    "maskNativeFunction(self.fetch, 'fetch')",
    "maskNativeFunction(self.importScripts, 'importScripts')",
  ])
    assert.ok(worker.includes(needle), `missing worker ${needle}`);
});

test('runtime keeps native JavaScript rewrite path fail-closed after QuickJS cutover', () => {
  const rt = readRuntimeSource();
  assert.equal(
    rt.includes('fallbackRewritePageSource'),
    false,
    'page script rewriting must not use a regex fallback',
  );
  assert.ok(rt.includes('function rewritePageSource()'));
  assert.equal(rt.includes('ZPHTTPRewriter'), false);
  assert.equal(rt.includes('ZPRewriter'), false);
  assert.equal(rt.includes('function scriptProxyPath'), false);
  assert.equal(rt.includes("ZP.apiPath('script')"), false);
  assert.equal(rt.includes("params.set('u', target)"), false);
  assert.ok(rt.includes("return blockExecutableURL(el, 'src', value);"));
});

test('runtime hardens late helper calls with captured method-level natives', () => {
  const rt = readRuntimeSource();
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  for (const needle of [
    'functionBind: NativeFunctionBind',
    'objectDefineProperty: nativeObjectDefineProperty',
    'reflectApply: nativeReflectApply',
    'reflectConstruct: nativeReflectConstruct',
    'urlSearchParamsToString: nativeURLSearchParamsToString',
    'return reflectApply(fn, rawBase, callArgs);',
    'return reflectConstruct(dynamic || ctor, arrayIsArray(args) ? args : []);',
    "const nativePostMessage = reflectGet(Object(target), 'postMessage');",
    'return arguments.length > 2 ? reflectApply(nativePostMessage, target, [message, mapped, transfer])',
    "objectDefineProperty(proto, 'contentWindow'",
  ]) {
    assert.ok(rt.includes(needle), `missing captured native use: ${needle}`);
  }
  for (const needle of [
    'const nativeReflectApply = NativeReflect.apply',
    "objectDefineProperty(self, '__ZP_WORKER_PRELUDE'",
    'return reflectApply(get(target, prop), actual, arrayIsArray(args) ? args : []);',
  ]) {
    assert.ok(worker.includes(needle), `missing worker captured native use: ${needle}`);
  }
  assert.equal(worker.includes('urls.map(importScriptURL)'), false);
  assert.equal(worker.includes('/zp/api/'), false);
});

test('generated and dynamic JavaScript paths stay inside runtime hooks', () => {
  const rt = readRuntimeSource();
  const dynamic = fs.readFileSync('web/runtime/dynamic-code/facade.mjs', 'utf8');
  const quickjs = fs.readFileSync('web/runtime/quickjs/engine.mjs', 'utf8');
  for (const needle of [
    'function installDocumentWriteHooks',
    'transformHTML(String(markup))',
    'createContextualFragment',
    'rewriteEventAttribute(val)',
    'function rewriteSrcdocDocument(source, frame)',
    'return `$' + '{prelude}$' + '{transformHTML(source)}`',
  ]) {
    assert.ok(rt.includes(needle), `missing generated runtime hook: ${needle}`);
  }
  for (const needle of [
    'function compileDynamic(_ctor, _args, _kind)',
    "throw normalizedError('NotSupportedError')",
    'function compileTimerString()',
  ]) {
    assert.ok(dynamic.includes(needle), `missing dynamic runtime hook: ${needle}`);
  }
  assert.ok(quickjs.includes('evalClassic'));
});

test('filtered DOM collections expose numeric indexes to native slice', () => {
  const rt = readRuntimeSource();
  assert.match(
    rt,
    /has\(_target, prop\) \{[\s\S]*Number\(prop\) < length\(\)[\s\S]*\}/,
    'filtered collection HasProperty must recognize all numeric indexes',
  );
  assert.ok(rt.includes("prop === 'length'"));
  assert.equal(
    rt.includes(
      "has(_target, prop) { return prop === 'length' || (/^(?:0|[1-9]\\\\d*)$/.test(String(prop)) && Number(prop) < length()); }",
    ),
    false,
    'filtered collection HasProperty must not match a literal backslash-d',
  );
});

test('blocked selector NodeList facades do not use array-backed filtered collections', () => {
  const rt = readRuntimeSource();
  assert.equal(
    rt.includes('filteredCollection([], () => false)'),
    false,
    'blocked querySelectorAll results must preserve a native NodeList prototype',
  );
  assert.ok(rt.includes("querySelectorAll.call(self, ':not(*)')"));
});

test('legacy HTML document transform bridge is fail-closed after QuickJS raw mode cutover', () => {
  const tx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(tx.includes('DocumentStreamRewriter'));
  assert.equal(kernel.includes('DocumentStreamRewriter: rewriteHTMLDocumentStreamFromJS'), false);
  assert.equal(kernel.includes('createHTMLDocumentRewriter'), false);
  assert.equal(build.includes('wasm_bindgen.create_html_document_rewriter'), false);
  assert.equal(
    build.includes('createHTMLDocumentRewriter: createHTMLDocumentRewriterPublic'),
    false,
  );
  assert.ok(kernel.includes('legacyDocumentTransformBlocked'));
  assert.ok(kernel.includes('HTML_DOCUMENT_TRANSFORM_UNAVAILABLE'));
});

test('target script source now enters QuickJS without Service Worker charset routing', () => {
  const loader = fs.readFileSync('web/runtime/resources/loader.mjs', 'utf8');
  const quickjs = fs.readFileSync('web/runtime/quickjs/engine.mjs', 'utf8');
  assert.ok(loader.includes('executeInlineScript'));
  assert.ok(loader.includes('executeExternalScript'));
  assert.ok(loader.includes('this.realm.evalClassic'));
  assert.ok(quickjs.includes('evalClassic'));
  assert.equal(loader.includes('/zp/api/'), false);
});

test('runtime HTTP facade resolves relative requests without site-specific host maps', () => {
  const http = fs.readFileSync('web/runtime/network/http.mjs', 'utf8');
  assert.equal(/naver|pstatic|shopsquare|recoshopping/i.test(http), false);
  assert.ok(http.includes('const parsed = new URL(raw, getBaseURL())'));
});

test('QuickJS runtime is built directly from QuickJS-NG source instead of Rust rewriter assets', () => {
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(build.includes('makeQuickJSRuntime'));
  assert.ok(build.includes('quickjs.c'));
  assert.ok(build.includes('emcc is required to build QuickJS-NG from source'));
  assert.equal(build.includes('bootstrapInit();'), false);
  assert.equal(build.includes('rust-rewriter.wasm'), false);
});

test('response wrappers strip target permissions policy headers', () => {
  const headersPolicy = fs.readFileSync('internal/headers/policy.go', 'utf8');
  assert.ok(headersPolicy.includes('"permissions-policy"'));
  assert.ok(headersPolicy.includes('"feature-policy"'));
});

test('runtime sync XHR avoids native sync requests when policy disables them', () => {
  const rt = readRuntimeSource();
  assert.ok(rt.includes("policy.allowsFeature('sync-xhr')"));
  assert.ok(rt.includes('if (!syncXHRAllowed()) return failSyncXHR(xhr);'));
});

test('legacy htmltx wrapper is no longer wired to browser-packaged Rust document rewrite', () => {
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const rustLib = fs.readFileSync('rewriter-rs/src/lib.rs', 'utf8');

  assert.match(
    htmltx,
    /DocumentRewriter\s+func\(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers \[\]string\)/,
  );
  assert.equal(kernel.includes('DocumentRewriter:'), false);
  assert.equal(kernel.includes('rewriteHTMLDocumentFromJS'), false);
  assert.ok(kernel.includes('legacyDocumentTransformBlocked'));
  assert.ok(kernel.includes('HTML_DOCUMENT_TRANSFORM_UNAVAILABLE'));
  assert.equal(build.includes('wasm_bindgen.rewrite_html_document'), false);
  assert.equal(build.includes('rewriteHTMLDocument: rewriteHTMLDocumentPublic'), false);
  assert.equal(build.includes('virtual:zeroproxy-rust-rewriter'), false);
  assert.ok(
    rustLib.includes('rewrite_css('),
    'Rust helper crate may retain CSS/resource helpers during cleanup',
  );
});

test('runtime import maps fail closed without Rust AST rewriter ABI', () => {
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  const match = rt.match(/function rewriteImportMapText\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'runtime import-map fail-closed function missing');
  const body = match[1];
  assert.equal(body.includes('ZPRewriter'), false);
  assert.equal(body.includes('rewriteImportMap'), false);
  assert.ok(body.includes("return '{}';"));
  assert.equal(body.includes('scriptProxyPath'), false);
  assert.equal(body.includes('new URL'), false);
});

test('Rust helper crate is not browser-packaged after AST cutover', () => {
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const cargo = fs.readFileSync('rewriter-rs/Cargo.toml', 'utf8');
  const rust = fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8');

  assert.ok(cargo.includes('lol_html'));
  assert.ok(rust.includes('rewrite_str'));
  assert.equal(rust.includes('html5ever'), false);
  assert.equal(rust.includes('swc_html'), false);
  assert.equal(build.includes('wasm_bindgen.rewrite_html_document'), false);
  assert.equal(build.includes('rewriteHTMLDocument: rewriteHTMLDocumentPublic'), false);
});

test('html transformer fails closed without Rust document rewriter hook', () => {
  const src = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  assert.match(
    src,
    /if opt\.DocumentRewriter == nil \{\s*return fmt\.Errorf\("%w: document rewriter unavailable", ErrMalformedHTML\)\s*\}/,
  );
});

test('runtime CSS rewriting still fails closed without unsafe fallback hooks', () => {
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  const sanitizerCSS = fs.readFileSync('internal/htmlsanitize/css.go', 'utf8');
  assert.equal(htmltx.includes('func rewriteInlineStyle'), false);
  assert.equal(kernel.includes('func rewriteCSSFromJS'), false);
  assert.equal(kernel.includes('return source, nil'), false);
  assert.equal(rt.includes('fallbackRewriteCSS'), false);
  assert.equal(rt.includes('cssUrlToken'), false);
  assert.ok(sanitizerCSS.includes('cssrewrite.RewriteWithMapper'));
  assert.equal(sanitizerCSS.includes('/zp/api/'), false);
  assert.equal(fs.existsSync('web/http-rewriter.js'), false);
});

test('runtime maps postMessage targetOrigin for proxied iframe windows', () => {
  const rt = readRuntimeSource();
  assert.ok(
    rt.includes('requestedOrigin === frameOrigin'),
    'postMessage does not recognize proxied frame origins',
  );
  assert.ok(
    rt.includes('if (frameOrigin && requestedOrigin === frameOrigin) return proxyOrigin;'),
    'postMessage does not map proxied frame targetOrigin to proxy origin',
  );
  assert.ok(
    rt.includes('return new MessageEvent(ev.type, { data: ev.data, origin'),
    'message origin virtualization must synthesize a MessageEvent before falling back to own origin override',
  );
  assert.ok(
    rt.indexOf('return new MessageEvent(ev.type') < rt.indexOf("objectDefineProperty(ev, 'origin'"),
    'message origin virtualization must avoid own-origin override as the first path',
  );
  assert.ok(
    rt.includes('if (httpOrigin(s)) return proxyOrigin;'),
    'targetOrigin must not bypass proxied iframe origin mapping',
  );
});

test('host shell boots GoNetworkBackend without service worker control', () => {
  assertLegacyServiceWorkerDeleted();
  const index = fs.readFileSync('web/index.html', 'utf8');
  const host = fs.readFileSync('web/host-shell-entry.mjs', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  assert.ok(index.includes('/zp/assets/host-shell.js'));
  assert.equal(index.includes('navigator.serviceWorker'), false);
  assert.equal(index.includes("register('/zp/sw.js'"), false);
  assert.equal(index.includes('ZP_OPEN_SHARE'), false);
  assert.ok(host.includes('new GoNetworkBackend'));
  assert.ok(host.includes("workerURL: '/zp/assets/network-worker.js'"));
  assert.ok(host.includes("from './runtime/quickjs/engine.mjs'"));
  assert.ok(host.includes("from './runtime/webapi/core.mjs'"));
  assert.ok(host.includes('lazyForegroundBackend'));
  assert.ok(host.includes('forceForeground()'));
  assert.ok(host.includes('/zp/assets/wasm_exec.js'));
  assert.ok(host.includes('/zp/kernel.wasm'));
  assert.ok(host.includes('__ZP_NETWORK_BACKEND'));
  assert.ok(host.includes('__ZP_CURRENT_SHARE'));
  assert.ok(host.includes('__ZP_QUICKJS_READY'));
  assert.ok(host.includes('initQuickJSRuntime'));
  assert.equal(host.includes('/zp/api/'), false);
  assert.ok(kernel.includes('js.Global().Set("__zp_kernel_init"'), 'kernel init export missing');
  assert.ok(kernel.includes('js.Global().Set("__zp_cookie_set"'), 'kernel cookie export missing');
  assert.ok(kernel.includes('Target host:'), 'kernel error page does not expose target host');
});

test('server response wrappers force nosniff without service worker routes', () => {
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.ok(server.includes('X-Content-Type-Options'));
  assert.ok(server.includes('nosniff'));
  assert.equal(server.includes('serveSW'), false);
  assert.equal(server.includes('workerBootstrap'), false);
  assert.equal(server.includes('/zp/api/'), false);
});

test('native JS rewriter hot path is disabled after QuickJS cutover', () => {
  const rt = readRuntimeSource();
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const index = fs.readFileSync('web/index.html', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const cargo = fs.readFileSync('rewriter-rs/Cargo.toml', 'utf8');
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  const loader = fs.readFileSync('web/runtime/resources/loader.mjs', 'utf8');
  for (const src of [build, server, worker, loader]) {
    assert.equal(src.includes('/zp/api/'), false);
  }
  assert.equal(build.includes('sw-entry.mjs'), false);
  assert.equal(build.includes('virtual:zeroproxy-sw-body'), false);
  assert.ok(build.includes('quickjs-ng'));
  assert.ok(build.includes('quickjs-runtime.mjs'));
  assert.ok(build.includes('quickjs-runtime.wasm'));
  assert.equal(build.includes('__zp_rust_b64'), false);
  assert.equal(build.includes('__ZP_RUST_WASM_BYTES'), false);
  assert.equal(build.includes('cargoBinPath'), false);
  assert.equal(build.includes('virtual:zeroproxy-rust-rewriter'), false);
  assert.equal(build.includes('rust-rewriter.wasm'), false);
  assert.ok(fs.existsSync('rewriter-rs/Cargo.toml'), 'Rust helper manifest missing');
  assert.ok(fs.existsSync('rewriter-rs/src/lib.rs'), 'Rust helper source missing');
  assert.equal(cargo.includes('html5ever'), false);
  assert.equal(cargo.includes('swc_html_parser'), false);
  assert.equal(cargo.includes('swc_html_ast'), false);
  assert.ok(cargo.includes('lol_html'));
  assert.ok(build.includes('wasm_exec.js'));
  assert.equal(fs.existsSync('web/js-rewriter.js'), false);
  assert.equal(fs.existsSync('web/wasm_exec.js'), false);
  assert.match(rt, /setAttributeNS/);
  assert.match(rt, /NamedNodeMap/);
  assert.equal(/connect-src\s+\*/.test(core), false);
  assert.ok(core.includes('connect-src '));
  assert.equal(/script-src \*/.test(core), false);
  assert.equal(/script-src \*/.test(server), false);
  assert.ok(core.includes("'unsafe-eval'"));
  assert.equal(server.includes("'unsafe-eval'"), false);
  assert.ok(core.includes("'wasm-unsafe-eval'"));
  assert.ok(core.includes("script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'"));
  assert.ok(core.includes('allowDynamicCompile'));
  assert.equal(/http-equiv=["']Content-Security-Policy/i.test(index), false);
  assert.equal(index.includes("'wasm-unsafe-eval'"), false);
  assert.ok(server.includes("script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'"));
  assert.ok(server.includes("script-src 'self' blob: 'wasm-unsafe-eval'"));
  assert.match(htmltx, /runtimePrelude[\s\S]*runtime-prelude\.js/);
  assert.match(rt, /injectSrcdoc[\s\S]*runtime-prelude\.js/);
  assert.equal(rt.includes('Reflect.construct(Native.FunctionCtor'), false);
  assert.match(server, /connect-src 'self'/);
  assert.equal(core.includes('navigate-to'), false);
  assert.equal(server.includes('navigate-to'), false);
  assert.equal(worker.includes('MAX_REQUEST_BODY_BYTES'), false);
  assert.equal(worker.includes('pendingSubmissions'), false);
  assert.equal(worker.includes('ZP_SUBMIT_PREPARE'), false);
  assert.equal(worker.includes('zp_submit'), false);
  assert.equal(worker.includes('REQUEST_BODY_TOO_LARGE'), false);
  assert.ok(rt.includes('root.open(nav.href, nav.target)'));
  assert.ok(rt.includes('data-zp-blocked-target'));
  const bridge = fs.readFileSync('internal/swhttp/bridge_js.go', 'utf8');
  assert.ok(bridge.includes('getReader'));
  assert.ok(bridge.includes('X-ZP-Upload-Replayable'));
  assert.ok(
    fs.readFileSync('internal/shareurl/shareurl.go', 'utf8').includes('unsupported target URL'),
  );
  assert.ok(server.includes('closeBoth'));
});

test('committed HTML does not carry CSP meta policy', () => {
  for (const file of htmlFiles('web')) {
    const html = fs.readFileSync(file, 'utf8');
    assert.equal(
      /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?Content-Security-Policy/i.test(html),
      false,
      `${file} must receive ZeroProxy CSP from headers or SW responses, not a committed meta tag`,
    );
  }
});

test('runtime srcdoc injection inventory stays single-runtime-asset', () => {
  const { runtimePreludeMarkup, fullSource } = runtimeSrcdocHelpers();
  assert.ok(runtimePreludeMarkup, 'runtime srcdoc prelude template missing');
  const tmpl = runtimePreludeMarkup[1];
  assert.equal((tmpl.match(/<script\b/g) || []).length, 2);
  assert.equal((tmpl.match(/\/zp\/assets\/runtime-prelude\.js/g) || []).length, 1);
  for (const forbidden of [
    '/zp/assets/zp-core.js',
    '/zp/assets/rust-rewriter.js',
    '/zp/assets/http-rewriter.js',
    '/zp/error/POLICY_BLOCKED',
  ]) {
    assert.equal(tmpl.includes(forbidden), false, `${forbidden} must not be injected into srcdoc`);
  }
  assert.ok(tmpl.includes('__ZP_BOOT'));
  assert.ok(tmpl.includes('document.currentScript.remove()'));
  assert.equal(fullSource.includes('rw.rewriteHTMLDocument(source, opts)'), false);
  assert.ok(fullSource.includes('documentReferrer: referrer'));
  assert.ok(fullSource.includes('targetUrl,'));
  assert.ok(fullSource.includes('return `$' + '{prelude}$' + '{transformHTML(source)}`'));
});

test('core names every required safe error class', () => {
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  for (const code of [
    'BAD_HMAC',
    'INVALID_SHARE_LINK',
    'MALFORMED_ROUTE',
    'SW_NOT_READY',
    'TARGET_PROTOCOL_BLOCKED',
    'TLS_CERTIFICATE_INVALID',
    'TLS_HANDSHAKE_FAILED',
    'TARGET_CONNECT_FAILED',
    'MALFORMED_HTML',
    'REALM_INJECTION_FAILURE',
    'REQUEST_BODY_TOO_LARGE',
    'SUBMISSION_EXPIRED',
    'POLICY_BLOCKED',
  ]) {
    assert.ok(core.includes(code), `missing ${code}`);
  }
});

test('active browsing emits only encrypted prefixed p routes', () => {
  const rt = readRuntimeSource();
  const host = fs.readFileSync('web/host-shell-entry.mjs', 'utf8');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.equal(host.includes('/v/'), false, 'host shell must not produce legacy /v routes');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
  assert.ok(host.includes('openShare'), 'host shell must open encrypted /p share routes');
});

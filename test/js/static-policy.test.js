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

function readServiceWorkerSource() {
  return [
    fs.readFileSync('web/sw.js', 'utf8'),
    fs.readFileSync('web/sw/kernel.js', 'utf8'),
    fs.readFileSync('web/sw/routes.js', 'utf8'),
    fs.readFileSync('web/sw/transport.js', 'utf8'),
    fs.readFileSync('web/sw/responses.js', 'utf8'),
  ].join('\n');
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

function runtimeSrcdocInjectionTemplate() {
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  const match = rt.match(/function injectSrcdoc\(s\) \{ return `([^`]+)`; \}/);
  assert.ok(match, 'runtime srcdoc injection template missing');
  return match[1];
}

test('service worker has no unclassified native fetch fallback', () => {
  const sw = readServiceWorkerSource();
  assert.equal(/return\s+fetch\s*\(\s*event\.request\s*\)/.test(sw), false);
  assert.match(sw, /event\.respondWith\(handleFetch\(event\)\)/);
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
  assert.ok(rt.includes('Native.reflectApply(Native.weakMapGet, membraneRawTargets, [value])'));
  assert.ok(rt.includes('Native.reflectApply ? Native.reflectApply(fn, rawBase, callArgs)'));
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

test('runtime dynamic eval uses one native-scoped path without rewritten fallback', () => {
  const rt = readRuntimeSource();
  assert.ok(
    rt.includes('eval: w.eval'),
    'native eval capture is required for strict app-bundle compatibility',
  );
  assert.ok(
    rt.includes('return runScopedNativeEval(String(source));'),
    'dynamic eval must use the single scoped eval path',
  );
  assert.ok(
    rt.includes('(0, Native.eval)(`with(__ZP_EVAL_SCOPE){${expr}\\n}`)'),
    'scoped eval must preserve native eval semantics',
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
    "Object.defineProperty(root, 'Worker'",
    "Object.defineProperty(root, 'SharedWorker'",
    '__ZP_WORKER_LOCATION',
    'virtualBlobWorkerLocation',
    'workerBlobURLs',
    'workerBlobURLMap',
    'blobURLRawMap',
    'workerBootstrapBlobURL',
    'scriptBlobURLForPage',
    'workerBlobURLMap.get(parsed.href)',
    "params.set('loc', requestTargetURL(raw))",
    "Object.defineProperty(URL, 'createObjectURL'",
    'try { Native.revokeObjectURL(raw); } catch {}',
    'dataWorkerURL',
    'rewriteDynamicFunctionBody',
    'configurable: true',
    'w.addEventListener && w.addEventListener.bind(w)',
    'rawPostMessageTarget(target)',
    "Object.defineProperty(ev, 'origin'",
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
    "define(root, 'setTimeout'",
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
    "Object, 'getPrototypeOf'",
    "Reflect, 'getPrototypeOf'",
  ])
    assert.ok(rt.includes(needle), `missing ${needle}`);
  assert.equal(rt.includes("document.addEventListener('submit'"), false);
  for (const needle of [
    'makeWorkerLocationFacade',
    "Object.defineProperty(self, 'location'",
    "'WorkerLocation'",
    "Object.defineProperty(self, 'origin'",
    'maskNativeFunction',
    "maskNativeFunction(self.fetch, 'fetch')",
    "maskNativeFunction(self.importScripts, 'importScripts')",
  ])
    assert.ok(worker.includes(needle), `missing worker ${needle}`);
});

test('runtime keeps JavaScript rewriting fail-closed and canonicalizes module URLs', () => {
  const rt = readRuntimeSource();
  assert.equal(
    rt.includes('fallbackRewritePageSource'),
    false,
    'page script rewriting must not use a regex fallback',
  );
  assert.ok(
    rt.includes(
      "if (!root.ZPHTTPRewriter || typeof root.ZPHTTPRewriter.rewriteScriptSource !== 'function') throw normalizedError('NotSupportedError');",
    ),
  );
  const start = rt.indexOf('function scriptProxyPath(target, kind)');
  const end = rt.indexOf('function setScriptSource', start);
  const body = rt.slice(start, end);
  assert.ok(
    body.includes("if (kind !== 'module')"),
    'module proxy URLs must keep referrer data out',
  );
  assert.ok(
    body.indexOf("params.set('tab'") < body.indexOf("if (kind !== 'module')"),
    'runtime tab token must be part of module graph identity',
  );
  assert.ok(
    body.indexOf("params.set('rt'") < body.indexOf("if (kind !== 'module')"),
    'runtime token must be part of module graph identity',
  );
  assert.ok(
    body.indexOf("if (kind !== 'module')") < body.indexOf("params.set('ref'"),
    'ref/rp must not be part of module identity',
  );
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

test('classic script rewrite carries document charset for legacy Korean news scripts', () => {
  const rt = readRuntimeSource();
  const sw = readServiceWorkerSource();
  assert.ok(rt.includes("const documentCharset = String(boot.documentCharset || '')"));
  assert.ok(rt.includes("params.set('dc', documentCharset)"));
  assert.ok(sw.includes("const documentCharset = url.searchParams.get('dc') || ''"));
  assert.ok(sw.includes('scriptResponseText(resp, opt.documentCharset ||'));
  assert.ok(sw.includes('new TextDecoder(charset).decode(bytes)'));
});

test('runtime HTTP facade resolves relative requests without site-specific host maps', () => {
  const http = fs.readFileSync('web/runtime/network/http.mjs', 'utf8');
  assert.equal(/naver|pstatic|shopsquare|recoshopping/i.test(http), false);
  assert.ok(http.includes('const parsed = new URL(raw, getBaseURL())'));
});

test('Rust rewriter bootstrap falls back to async WASM load if sync bytes fail', () => {
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(build.includes("policy.allowsFeature('sync-xhr')"));
  assert.ok(build.includes("typeof XMLHttpRequest !== 'function' || !syncXHRAllowed()"));
  assert.ok(build.includes('function bootstrapInit()'));
  assert.ok(build.includes('try { if (initSync()) return; } catch {} init().catch(() => {})'));
  assert.ok(build.includes('bootstrapInit();'));
});

test('response wrappers strip target permissions policy headers', () => {
  const swResponses = fs.readFileSync('web/sw/responses.js', 'utf8');
  assert.ok(swResponses.includes("h.delete('Permissions-Policy')"));
  assert.ok(swResponses.includes("h.delete('Feature-Policy')"));
});

test('runtime sync XHR avoids native sync requests when policy disables them', () => {
  const rt = readRuntimeSource();
  assert.ok(rt.includes("policy.allowsFeature('sync-xhr')"));
  assert.ok(rt.includes('if (!syncXHRAllowed()) return failSyncXHR(xhr);'));
});

test('HTML document transform is a thin Go wrapper over Rust lol_html policy', () => {
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const rust = fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8');

  assert.match(
    htmltx,
    /DocumentRewriter\s+func\(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers \[\]string\)/,
  );
  assert.ok(htmltx.includes('opt.DocumentRewriter('));
  assert.equal(htmltx.includes('golang.org/x/net/html'), false);
  for (const forbidden of [
    'xhtml.',
    'streamTransformer',
    'tokenRewriter',
    'rewriteToken',
    'wrapScriptURL',
    'wrapFetchURL',
    'rewriteSrcset',
    'resolveVisibleTargetURL',
    'baseSyncScript',
    'classifyAttrPolicy',
    'classifyScriptType',
    'rewriteInlineStyle',
    'rewriteInlineScript',
    'rewriteInlineImportMap',
  ]) {
    assert.equal(htmltx.includes(forbidden), false, `${forbidden} must not remain in Go htmltx`);
  }
  assert.match(kernel, /DocumentRewriter:\s+rewriteHTMLDocumentFromJS/);
  assert.ok(kernel.includes('rewriteHTMLDocumentFromJS'));
  assert.ok(kernel.includes('"tabId":         tabID'));
  assert.ok(kernel.includes('"runtimeToken":  runtimeToken'));
  assert.ok(build.includes('wasm_bindgen.rewrite_html_document'));
  assert.ok(build.includes('rewriteHTMLDocument: rewriteHTMLDocumentPublic'));
  for (const needle of [
    'rewrite_script(',
    'script_url(',
    'fetch_url(',
    'srcset(',
    'target_url(',
    'new_with_servers',
    'link_rel_kind',
    'blocked_element_kind',
    'meta_policy_kind',
    'attr_policy_kind',
    'script_type_kind',
    'event_handler_attr_kind',
    'rewrite_inline_script',
    'rewrite_inline_style',
    'import_map::rewrite',
    'srcdoc',
  ]) {
    assert.ok(rust.includes(needle), `Rust document policy missing ${needle}`);
  }
});

test('runtime import maps delegate rewrite policy to Rust rewriter ABI', () => {
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  const match = rt.match(/function rewriteImportMapText\(source\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'runtime import-map rewrite function missing');
  const body = match[1];
  assert.ok(body.includes('root.ZPRewriter'));
  assert.ok(body.includes('rw.rewriteImportMap'));
  assert.ok(body.includes('baseUrl: baseURL'));
  assert.ok(body.includes('tabId: boot.tabId'));
  assert.ok(body.includes('runtimeToken'));
  assert.ok(body.includes('controlPrefix: ZP.CONTROL_PREFIX'));
  assert.ok(body.includes("return '{}';"));
  assert.equal(body.includes('JSON.parse'), false);
  assert.equal(body.includes('scriptProxyPath'), false);
  assert.equal(body.includes('new URL'), false);
});

test('Rust HTML document rewrite surface is backed by lol_html', () => {
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const cargo = fs.readFileSync('rewriter-rs/Cargo.toml', 'utf8');
  const rust = fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8');

  assert.ok(cargo.includes('lol_html'));
  assert.ok(rust.includes('rewrite_str'));
  assert.equal(rust.includes('html5ever'), false);
  assert.equal(rust.includes('swc_html'), false);
  assert.ok(build.includes('wasm_bindgen.rewrite_html_document'));
  assert.ok(build.includes('rewriteHTMLDocument: rewriteHTMLDocumentPublic'));
});

test('html transformer fails closed without Rust document rewriter hook', () => {
  const src = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  assert.match(
    src,
    /if opt\.DocumentRewriter == nil \{\s*return fmt\.Errorf\("%w: document rewriter unavailable", ErrMalformedHTML\)\s*\}/,
  );
});

test('runtime CSS rewriting still fails closed without Rust rewriter hook', () => {
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const http = fs.readFileSync('web/http-rewriter.js', 'utf8');
  assert.equal(htmltx.includes('func rewriteInlineStyle'), false);
  assert.equal(kernel.includes('func rewriteCSSFromJS'), false);
  assert.equal(kernel.includes('return source, nil'), false);
  assert.equal(rt.includes('fallbackRewriteCSS'), false);
  assert.equal(rt.includes('cssUrlToken'), false);
  assert.ok(
    rt.includes(
      "return root.ZPHTTPRewriter.rewriteCSSSource(String(source || ''), { baseUrl: base, controlPrefix: ZP.CONTROL_PREFIX, fallback: () => '' });",
    ),
  );
  assert.equal(sw.includes("fallback: value => String(value || '')"), false);
  assert.ok(sw.includes("fallback: () => ''"));
  assert.equal(sw.includes("new Response(await resp.text().catch(() => '')"), false);
  assert.ok(
    http.includes(
      "const fallback = typeof options.fallback === 'function' ? options.fallback : () => '';",
    ),
  );
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
    rt.indexOf('return new MessageEvent(ev.type') <
      rt.indexOf("Object.defineProperty(ev, 'origin'"),
    'message origin virtualization must avoid own-origin override as the first path',
  );
  assert.ok(
    rt.includes('if (httpOrigin(s)) return proxyOrigin;'),
    'targetOrigin must not bypass proxied iframe origin mapping',
  );
});

test('service worker waits for initialized WASM transport and cookie bridge', () => {
  const sw = readServiceWorkerSource();
  const index = fs.readFileSync('web/index.html', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  assert.ok(sw.includes('__zp_kernel_init'), 'service worker does not require transport init');
  assert.match(
    sw,
    /^importScripts\('\/zp\/assets\/wasm_exec\.js'\);/m,
    'wasm_exec must be imported during service worker installation',
  );
  assert.ok(
    sw.includes('__zp_cookie_set'),
    'service worker does not bridge document.cookie to kernel jar',
  );
  assert.ok(
    sw.includes('runtimeTabForMessage'),
    'service worker does not gate runtime messages by tab',
  );
  assert.ok(
    sw.includes('runtimeMessageAuthorized'),
    'service worker does not validate runtime capability tokens',
  );
  assert.ok(
    sw.includes('runtimeToken: ZP.randomId'),
    'service worker does not generate runtime capability tokens',
  );
  assert.ok(
    sw.includes('X-ZP-Runtime-Token'),
    'service worker does not pass runtime capability to documents',
  );
  assert.ok(sw.includes('startupPhase: readinessStartupPhase()'));
  assert.ok(sw.includes("if (readiness === 'WASM_LOADING') return 'wasm-downloading';"));
  assert.ok(sw.includes("if (readiness === 'WASM_LOADED') return 'wasm-starting';"));
  assert.ok(
    index.includes(
      "if (!(await waitForController(5000))) await startupReload('service-worker-not-controlling');",
    ),
  );
  assert.ok(index.includes('function startupProgressing(state)'));
  assert.ok(index.includes("state.startupPhase === 'wasm-downloading'"));
  assert.ok(index.includes("state.startupPhase === 'wasm-starting'"));
  assert.equal(
    index.includes('state.kernelStarting && state.readinessAgeMs'),
    false,
    'index must not wait just because the service worker has a kernel promise',
  );
  assert.ok(kernel.includes('js.Global().Set("__zp_kernel_init"'), 'kernel init export missing');
  assert.ok(kernel.includes('js.Global().Set("__zp_cookie_set"'), 'kernel cookie export missing');
  assert.ok(kernel.includes('Target host:'), 'kernel error page does not expose target host');
  assert.ok(sw.includes('Target host:'), 'service worker error page does not expose target host');
});

test('service worker response wrappers force nosniff', () => {
  const sw = readServiceWorkerSource();
  assert.match(sw, /h\.set\('X-Content-Type-Options', 'nosniff'\)/);
  assert.match(sw, /'X-Content-Type-Options': 'nosniff'/);
});

test('phase 3 script rewriting pipeline is fail-closed', () => {
  const sw = readServiceWorkerSource();
  const rt = readRuntimeSource();
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  const index = fs.readFileSync('web/index.html', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const cargo = fs.readFileSync('rewriter-rs/Cargo.toml', 'utf8');
  assert.ok(sw.includes("importScripts('/zp/assets/rust-rewriter.js')"));
  assert.ok(sw.includes("importScripts('/zp/assets/http-rewriter.js')"));
  assert.equal(sw.includes("importScripts('/zp/assets/js-rewriter.js')"), false);
  assert.ok(sw.includes('/zp/api/script'));
  assert.ok(sw.includes('rewriteScriptResponse'));
  assert.ok(sw.includes('rewriteScriptOutcome'));
  assert.ok(build.includes('rewriter-rs'));
  assert.ok(build.includes('wasm-bindgen'));
  assert.ok(build.includes('ZPRewriter'));
  assert.ok(build.includes('ZPRustRewriter'));
  assert.ok(build.includes('http-rewriter.js'));
  assert.ok(build.includes('rust-rewriter.wasm'));
  assert.equal(build.includes('__zp_rust_b64'), false);
  assert.equal(build.includes('__ZP_RUST_WASM_BYTES'), false);
  assert.ok(fs.readFileSync('web/http-rewriter.js', 'utf8').includes('ZPHTTPRewriter'));
  assert.ok(build.includes('phase3-rust-wasm-ast-4-import-map'));
  assert.ok(build.includes('cargoBinPath'));
  assert.ok(fs.existsSync('rewriter-rs/Cargo.toml'), 'Rust rewriter manifest missing');
  assert.ok(fs.existsSync('rewriter-rs/src/lib.rs'), 'Rust rewriter AST walker missing');
  assert.equal(cargo.includes('html5ever'), false);
  assert.equal(cargo.includes('swc_html_parser'), false);
  assert.equal(cargo.includes('swc_html_ast'), false);
  assert.ok(cargo.includes('lol_html'));
  assert.ok(build.includes('wasm_exec.js'));
  assert.ok(sw.includes("ZP.assetPath('rust-rewriter.wasm')"));
  assert.equal(fs.existsSync('web/js-rewriter.js'), false);
  assert.equal(fs.existsSync('web/wasm_exec.js'), false);
  assert.match(rt, /setAttributeNS/);
  assert.match(rt, /setAttributeNode/);
  assert.match(rt, /setAttributeNodeNS/);
  assert.match(rt, /getAttributeNode/);
  assert.match(rt, /removeAttributeNode/);
  assert.match(rt, /NamedNodeMap/);
  assert.match(rt, /setNamedItemNS/);
  assert.match(rt, /Attr\.prototype/);
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
  assert.equal(/runtimePrelude[\s\S]*zp-core\.js/.test(htmltx), false);
  assert.equal(/runtimePrelude[\s\S]*rust-rewriter\.js/.test(htmltx), false);
  assert.equal(/runtimePrelude[\s\S]*http-rewriter\.js/.test(htmltx), false);
  assert.equal(rt.includes('Reflect.construct(Native.FunctionCtor'), false);
  assert.match(server, /connect-src 'self'/);
  assert.equal(core.includes('navigate-to'), false);
  assert.equal(server.includes('navigate-to'), false);
  assert.equal(sw.includes('MAX_REQUEST_BODY_BYTES'), false);
  assert.equal(sw.includes('pendingSubmissions'), false);
  assert.equal(sw.includes('ZP_SUBMIT_PREPARE'), false);
  assert.equal(sw.includes('zp_submit'), false);
  assert.equal(sw.includes('REQUEST_BODY_TOO_LARGE'), false);
  assert.ok(sw.includes('runtimeFetchContext'));
  assert.ok(sw.includes('scriptRequestContext'));
  assert.equal(/url\.pathname === '\/zp\/api\/fetch'[\s\S]{0,240}firstTab\(\)/.test(sw), false);
  assert.equal(sw.includes('firstTab'), false);
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
  const tmpl = runtimeSrcdocInjectionTemplate();
  assert.equal((tmpl.match(/<script\b/g) || []).length, 2);
  assert.equal((tmpl.match(/\/zp\/assets\/runtime-prelude\.js/g) || []).length, 1);
  for (const forbidden of [
    '/zp/assets/zp-core.js',
    '/zp/assets/rust-rewriter.js',
    '/zp/assets/http-rewriter.js',
    '/zp/api/script',
  ]) {
    assert.equal(tmpl.includes(forbidden), false, `${forbidden} must not be injected into srcdoc`);
  }
  assert.ok(tmpl.includes('__ZP_BOOT'));
  assert.ok(tmpl.includes('document.currentScript.remove()'));
  assert.ok(tmpl.includes('${transformHTML(String(s))}'));
});

test('service worker names every required safe error class', () => {
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
  const sw = readServiceWorkerSource();
  const rt = readRuntimeSource();
  assert.equal(sw.includes('/v/'), false, 'service worker must not produce legacy /v routes');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.ok(sw.includes('PROXY_DOCUMENT'), 'service worker must handle /zp/p documents');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
});

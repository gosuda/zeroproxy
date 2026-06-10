import { createQuickJSRuntime } from './runtime/quickjs/engine.mjs';
import { VirtualEventLoop } from './runtime/quickjs/event-loop.mjs';
import { VirtualResourceLoader } from './runtime/resources/loader.mjs';
import { NativeRenderer, ensureRenderRoot, installVirtualDOM } from './runtime/dom/virtual-dom.mjs';
import { ForegroundBackend, GoNetworkBackend } from './runtime/network/gonetworkbackend.mjs';
import { installVirtualNetworkAPIs, VirtualHTTPCache } from './runtime/network/api.mjs';
import { installWebAPICore } from './runtime/webapi/core.mjs';
import { VirtualStorageManager } from './runtime/webapi/storage.mjs';

(() => {

  const status = document.getElementById('status');
  const form = document.getElementById('open');
  const urlInput = document.getElementById('url');
  const foregroundKernel = { promise: null };
  let backendPromise = null;
  let quickJSPromise = null;
  const storageManager = new VirtualStorageManager({ indexedDB: globalThis.indexedDB });
  let resourceLoader = null;

  function setStatus(text, err = false) {
    status.textContent = text;
    status.className = err ? 'err' : '';
  }

  function proxyOrigin() {
    const u = new URL(location.href);
    if (u.hostname === 'proxy.localhost') return u.origin;
    if (isLoopbackHost(u.hostname)) u.hostname = 'proxy.localhost';
    return u.origin;
  }

  function enterControlScope() {
    if (location.pathname.startsWith(ZP.CONTROL_PREFIX)) return true;
    location.replace(ZP.CONTROL_PREFIX + location.search + location.hash);
    return false;
  }

  function relayOptions() {
    return { allowLoopbackWS: ZP.isLoopbackHost(location.hostname), origin: proxyOrigin() };
  }

  function currentServers() {
    return ZP.parseRelayServersFromFragment(location.hash, relayOptions());
  }

  function forceForeground() {
    const search = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
    return search.get('zp_backend') === 'foreground' || hash.get('zp_backend') === 'foreground';
  }

  async function initTransport(servers = currentServers()) {
    if (!backendPromise) backendPromise = startBackend(servers);
    return backendPromise;
  }

  async function startBackend(servers) {
    setStatus('Preparing isolated network backend…');
    const backend = new GoNetworkBackend({
      workerURL: '/zp/assets/network-worker.js',
      bootTimeoutMs: 10000,
      forceForeground: forceForeground(),
      foregroundBackend: lazyForegroundBackend(),
    });
    const result = await backend.init({ tabId: 'shell', servers });
    globalThis.__ZP_NETWORK_BACKEND = backend;
    globalThis.__ZP_NETWORK_BACKEND_READY = result;
    await initQuickJSRuntime();
    setStatus(`Network backend ready (${result.backend}).`);
    return { backend, result, servers };
  }

  async function initQuickJSRuntime() {
    if (!quickJSPromise) {
      quickJSPromise = createQuickJSRuntime().then((runtime) => {
        const realm = runtime.createRealm();
        const eventLoop = new VirtualEventLoop(realm, { href: location.href });
        const probe = realm.evalClassic('globalThis.__zp_quickjs_probe = 6 * 7');
        globalThis.__ZP_QUICKJS_RUNTIME = runtime;
        globalThis.__ZP_QUICKJS_REALM = realm;
        globalThis.__ZP_QUICKJS_EVENT_LOOP = eventLoop;
        globalThis.__ZP_QUICKJS_READY = { version: runtime.version, probe };
        return { runtime, realm, eventLoop, ready: globalThis.__ZP_QUICKJS_READY };
      });
    }
    return quickJSPromise;
  }

  async function resetVirtualRealm(href) {
    const state = await initQuickJSRuntime();
    state.eventLoop?.hardNavigate(href);
    state.realm?.destroy();
    state.realm = state.runtime.createRealm();
    state.eventLoop = new VirtualEventLoop(state.realm, { href });
    globalThis.__ZP_QUICKJS_REALM = state.realm;
    globalThis.__ZP_QUICKJS_EVENT_LOOP = state.eventLoop;
    return state;
  }

  function lazyForegroundBackend() {
    let backend = null;
    const ensure = async () => {
      if (!backend) {
        await loadForegroundKernel();
        backend = new ForegroundBackend({ kernelExports: globalThis });
      }
      return backend;
    };
    return {
      async init(options) { return (await ensure()).init(options); },
      async fetchRaw(record) { return (await ensure()).fetchRaw(record); },
      async sanitizeDocument(record) { return (await ensure()).sanitizeDocument(record); },
      async sanitizeStylesheet(record) { return (await ensure()).sanitizeStylesheet(record); },
      async openWebSocket(record) { return (await ensure()).openWebSocket(record); },
      async setCookie(record) { return (await ensure()).setCookie(record); },
      async getDocumentCookie(record) { return (await ensure()).getDocumentCookie(record); },
      async cancel(requestId) { return (await ensure()).cancel(requestId); },
      async health() { return (await ensure()).health(); },
      async shutdown() { return (await ensure()).shutdown(); },
    };
  }

  async function loadForegroundKernel() {
    if (globalThis.__zp_kernel_ready && typeof globalThis.__go_jshttp === 'function') return true;
    if (!foregroundKernel.promise) foregroundKernel.promise = loadForegroundKernelOnce();
    return foregroundKernel.promise;
  }

  async function loadForegroundKernelOnce() {
    if (typeof globalThis.Go !== 'function') await loadScript('/zp/assets/wasm_exec.js');
    const go = new globalThis.Go();
    const wasm = await instantiateKernel(go);
    go.run(wasm.instance);
    await waitForKernelExports();
    return true;
  }

  async function instantiateKernel(go) {
    try {
      return await WebAssembly.instantiateStreaming(fetch('/zp/kernel.wasm', { cache: 'no-store' }), go.importObject);
    } catch {
      const resp = await fetch('/zp/kernel.wasm', { cache: 'no-store' });
      return WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error(`Unable to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function waitForKernelExports() {
    const deadline = Date.now() + 15000;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (globalThis.__zp_kernel_ready && typeof globalThis.__go_jshttp === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('KERNEL_BOOT_TIMEOUT'));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  async function openTarget(targetUrl) {
    const target = ZP.canonicalTargetURL(targetUrl).href;
    const share = await ZP.encryptShareURL(target);
    const servers = currentServers();
    const path = ZP.makeSharePath(share.encrypted);
    location.assign(proxyOrigin() + path + ZP.makeShareFragment(share.key, servers));
  }

  async function handleShare() {
    if (!ZP.isSharePath(location.pathname)) return false;
    const encrypted = ZP.shareRouteKey(location.pathname);
    const key = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash).get('k');
    if (!key) {
      location.replace(ZP.errorPath('INVALID_SHARE_LINK'));
      return true;
    }
    await openShare(encrypted, key);
    return true;
  }

  async function openShare(encrypted, key) {
    const targetUrl = await ZP.decryptShareURL(encrypted, key);
    const transport = await initTransport(currentServers());
    const qjs = await resetVirtualRealm(targetUrl);
    const loader = createResourceLoader(transport.backend, qjs.realm, transport.servers);
    globalThis.__ZP_CURRENT_SHARE = { encrypted, targetUrl, servers: transport.servers, backend: transport.result.backend };
    setStatus(`Loading virtual document (${transport.result.backend})…`);
    const documentState = await loader.loadDocument({
      targetUrl,
      docId: `doc-${encrypted.slice(0, 12)}`,
      beforeProcess: (state) => installVirtualDocument(qjs.realm, state, targetUrl, transport.backend, transport.servers, loader),
    });
    globalThis.__ZP_VIRTUAL_DOCUMENT = summarizeVirtualDocument(documentState);
    globalThis.__ZP_CURRENT_SHARE.document = globalThis.__ZP_VIRTUAL_DOCUMENT;
    setStatus(`Virtual document ready (${transport.result.backend}; ${documentState.fetchedResources.length} resources).`);
  }

  function createResourceLoader(backend, realm, servers) {
    if (resourceLoader) resourceLoader.revokeAll();
    resourceLoader = new VirtualResourceLoader({ backend, realm, servers, tabId: 'shell' });
    globalThis.__ZP_RESOURCE_LOADER = resourceLoader;
    return resourceLoader;
  }

  async function installVirtualDocument(realm, state, targetUrl, backend, servers, loader) {
    const renderer = new NativeRenderer(ensureRenderRoot(), { href: targetUrl, onNavigate: openTarget });
    installVirtualDOM({
      realm,
      records: state.records,
      renderer,
      state,
      href: targetUrl,
      viewport: currentViewport(),
      onNavigate: openTarget,
      onMutation: (record) => {
        void loader.handleDOMMutation(state, record);
      },
    });
    const storagePartition = storageManager.partitionFor(state.finalUrl || targetUrl, { tabId: 'shell' });
    const storageSnapshot = await storageManager.loadSnapshot(storagePartition).catch(() => ({}));
    const httpCache = new VirtualHTTPCache({
      entries: storageSnapshot.httpCache || [],
      storageManager,
      storagePartition,
    });
    state.network = installVirtualNetworkAPIs({
      realm,
      backend,
      tabId: 'shell',
      documentUrl: state.finalUrl || targetUrl,
      servers,
      state,
      cache: httpCache,
    });
    installWebAPICore({
      realm,
      config: { userAgent: navigator.userAgent, platform: navigator.platform },
      storage: { manager: storageManager, partitionKey: storagePartition, snapshot: storageSnapshot },
    });
    state.renderer = renderer;
  }

  function currentViewport() {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      now: performance.now(),
    };
  }

  function summarizeVirtualDocument(documentState) {
    return {
      docId: documentState.docId,
      targetUrl: documentState.targetUrl,
      finalUrl: documentState.finalUrl,
      status: documentState.status,
      recordTypes: documentState.records.map((record) => record.type),
      records: documentState.records,
      fetchedResources: documentState.fetchedResources,
      executedScripts: documentState.executedScripts,
      errors: documentState.errors,
      blobUrls: Array.from(documentState.blobUrls.entries()),
    };
  }

  async function start() {
    if (!enterControlScope()) return;
    if (!(await handleShare())) await initTransport(currentServers());
  }

  function isLoopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      setStatus('Opening through ZeroProxy…');
      await openTarget(urlInput.value);
    } catch (error) {
      setStatus(error.message || 'Unable to open target', true);
    }
  });

  globalThis.__ZP_HOST_SHELL = { initTransport, initQuickJSRuntime, openTarget, handleShare };
  start().catch((error) => setStatus(error.message || 'Startup failed', true));
})();

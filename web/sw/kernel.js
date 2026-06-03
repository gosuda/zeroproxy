/* ZeroProxy Service Worker kernel readiness helpers. */
(self => {
  'use strict';

  function createKernelController({ nativeFetch }) {
    let readiness = 'UNINITIALIZED';
    let readinessSince = Date.now();
    let readinessError = '';
    let kernelPromise = null;

    function setReadiness(next) {
      if (readiness === next) return;
      readiness = next;
      readinessSince = Date.now();
      if (next !== 'UNINITIALIZED') readinessError = '';
    }

    function readinessState() {
      return {
        readiness,
        readinessAgeMs: Date.now() - readinessSince,
        startupPhase: readinessStartupPhase(),
        kernelStarting: !!kernelPromise,
        wasmLoading: readiness === 'WASM_LOADING',
        lastError: readinessError,
      };
    }

    function readinessStartupPhase() {
      if (readiness === 'REWRITE_LOADING') return 'rewriter-loading';
      if (readiness === 'WASM_LOADING') return 'wasm-downloading';
      if (readiness === 'WASM_LOADED') return 'wasm-starting';
      if (readiness === 'READY') return 'ready';
      return 'idle';
    }

    async function initKernel(servers) {
      if (readiness === 'READY') return;
      if (kernelPromise) return kernelPromise;
      kernelPromise = (async () => {
        setReadiness('REWRITE_LOADING');
        await initRewriter();
        setReadiness('WASM_LOADING');
        const go = new Go();
        const resp = await nativeFetch('/zp/kernel.wasm', { cache: 'no-store' });
        if (!resp.ok) throw new Error('SW_NOT_READY');
        const result = await WebAssembly.instantiateStreaming(resp, go.importObject);
        setReadiness('WASM_LOADED');
        go.run(result.instance);
        await waitForKernelExports();
        await self.__zp_kernel_init({ servers: servers || [] });
        setReadiness('READY');
      })().catch(err => {
        readinessError = err && err.message || 'SW_NOT_READY';
        setReadiness('UNINITIALIZED');
        kernelPromise = null;
        throw err;
      });
      return kernelPromise;
    }

    async function waitForKernelExports() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !kernelExportsReady()) {
        await new Promise(r => setTimeout(r, 20));
      }
      if (!kernelExportsReady()) throw new Error('SW_NOT_READY');
    }

    function kernelExportsReady() {
      return typeof self.__go_jshttp === 'function' &&
        typeof self.__zp_stream === 'function' &&
        typeof self.__zp_kernel_init === 'function';
    }

    async function initRewriter() {
      if (
        !self.ZPRewriter ||
        typeof self.ZPRewriter.init !== 'function' ||
        typeof self.ZPRewriter.rewriteScript !== 'function'
      ) {
        throw new Error('REALM_INJECTION_FAILURE');
      }
      await self.ZPRewriter.init();
      if (!self.ZPRewriter.ready) throw new Error('REALM_INJECTION_FAILURE');
      if (!self.ZPHTTPRewriter || typeof self.ZPHTTPRewriter.rewriteScriptOutcome !== 'function') {
        throw new Error('REALM_INJECTION_FAILURE');
      }
    }

    function isReady() {
      return readiness === 'READY';
    }

    return Object.freeze({
      initKernel,
      initRewriter,
      isReady,
      readinessState,
    });
  }

  self.ZPSWKernel = Object.freeze({ createKernelController });
})(self);

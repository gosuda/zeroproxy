const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const TARGET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TARGET_CH_UA = '"Chromium";v="148", "Not:A-Brand";v="24", "Google Chrome";v="148"';
const TARGET_CH_UA_FULL_VERSION = '"148.0.7778.217"';
const TARGET_CH_UA_FULL_VERSION_LIST =
  '"Chromium";v="148.0.7778.217", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="148.0.7778.217"';
const TARGET_UA_BRANDS = [
  { brand: 'Chromium', version: '148' },
  { brand: 'Not:A-Brand', version: '24' },
  { brand: 'Google Chrome', version: '148' },
];
const TARGET_UA_FULL_VERSION_LIST = [
  { brand: 'Chromium', version: '148.0.7778.217' },
  { brand: 'Not:A-Brand', version: '24.0.0.0' },
  { brand: 'Google Chrome', version: '148.0.7778.217' },
];
const TARGET_UA_HIGH_ENTROPY = {
  architecture: 'x86',
  bitness: '64',
  brands: TARGET_UA_BRANDS,
  fullVersionList: TARGET_UA_FULL_VERSION_LIST,
  mobile: false,
  model: '',
  platform: 'Windows',
  platformVersion: '15.0.0',
  uaFullVersion: '148.0.7778.217',
  fullVersion: '148.0.7778.217',
  wow64: false,
};
const JQUERY_SOURCE = fs.readFileSync(require.resolve('jquery'), 'utf8');
const EXPECTED_DELTAS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'expected-deltas.json'), 'utf8'),
);

const {
  run,
  isBenignSocketError,
  ignoreBenignSocketErrors,
  listen,
  closeServer,
  waitForHTTP,
  waitForPage,
} = require('./helpers');

function createTargetServer(requests) {
  const server = http.createServer((req, res) => {
    ignoreBenignSocketErrors(req);
    ignoreBenignSocketErrors(res);
    requests.push({
      url: req.url,
      method: req.method,
      host: req.headers.host || '',
      userAgent: req.headers['user-agent'] || '',
      secChUa: req.headers['sec-ch-ua'] || '',
      secChUaFullVersion: req.headers['sec-ch-ua-full-version'] || '',
      secChUaFullVersionList: req.headers['sec-ch-ua-full-version-list'] || '',
      secChUaPlatform: req.headers['sec-ch-ua-platform'] || '',
      secChUaPlatformVersion: req.headers['sec-ch-ua-platform-version'] || '',
      cookie: req.headers.cookie || '',
      contentType: req.headers['content-type'] || '',
      origin: req.headers.origin || '',
      referer: req.headers.referer || '',
    });
    const url = new URL(req.url, 'http://target.local');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Home</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'"><meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'none'; connect-src 'none'"><link rel="stylesheet" href="/site.css"><link id="icon-link" rel="icon" href="/site-icon.png"></head><body>
        <main id="style-probe" class="root-stylesheet-probe"><h1>E2E Home</h1><img id="image-probe" src="/image-probe.png" alt=""><span class="masked-item"></span><span class="masked-item"></span><a id="next" href="/next">Next page</a></main>
        <script>
          window.__ua = navigator.userAgent;
          window.__platform = navigator.platform;
          window.__phase2Location = { href: location.href, windowHref: window.location.href };
          window.__storageInitial = { local: localStorage.getItem('zp-persist'), session: sessionStorage.getItem('zp-session') };
          window.__phase2DynamicFunction = Function('return location.href')();
          window.__phase2EvalLocation = eval('location.href');
          window.__phase2WindowEvalLocation = window.eval('location.href');
          const indirectEvalAlias = window.eval;
          window.__phase2IndirectEvalLocation = indirectEvalAlias('location.href');
          window.__maskedSelectorEval = (() => {
            const localCollector = (root, className) => root.getElementsByClassName(className);
            const buildSelector = () => {
              const generated = "(function(root) { return localCollector(root, 'masked-item').length; })";
              eval('var compiledSelector = ' + generated + ';');
              return compiledSelector;
            };
            return buildSelector()(document);
          })();
          window.__messageEvents = [];
          window.addEventListener('message', ev => {
            if (ev.data && ev.data.type) window.__messageEvents.push({ type: ev.data.type, origin: ev.origin, href: ev.data.href || '' });
          });
          (function(w,d,s,l,i){
            w[l]=w[l]||[];
            w[l].push({'gtm.start': Date.now(), event:'gtm.js'});
            var f=d.getElementsByTagName(s)[0], j=d.createElement(s), dl=l!='dataLayer'?'&l='+l:'';
            j.async=true;
            j.id='gtm-fixture';
            j.src='/gtm.js?id='+i+dl;
            f.parentNode.insertBefore(j,f || d.head.firstChild);
          })(window,document,'script','dataLayer','GTM-ZP');
          const dynamicScript = document.createElement('script');
          dynamicScript.id = 'dynamic-script-probe';
          dynamicScript.src = '/dynamic-script.js?from=createElement';
          document.head.appendChild(dynamicScript);
          const dynamicImage = document.createElement('img');
          dynamicImage.id = 'dynamic-image-probe';
          dynamicImage.src = '/image-probe.png?dynamic=1';
          document.body.appendChild(dynamicImage);
          const dynamicRelativeLink = document.createElement('a');
          dynamicRelativeLink.id = 'dynamic-relative-next';
          dynamicRelativeLink.setAttribute('href', '/next');
          dynamicRelativeLink.textContent = 'Dynamic next page';
          document.body.appendChild(dynamicRelativeLink);
          const dynamicCSP = document.createElement('meta');
          dynamicCSP.setAttribute('http-equiv', 'Content-Security-Policy');
          dynamicCSP.setAttribute('content', "default-src 'none'");
          document.head.appendChild(dynamicCSP);
          const dynamicReportOnly = document.createElement('meta');
          dynamicReportOnly.setAttribute('http-equiv', 'Content-Security-Policy-Report-Only');
          dynamicReportOnly.setAttribute('content', "default-src 'none'");
          document.head.appendChild(dynamicReportOnly);
          document.head.insertAdjacentHTML(
            'beforeend',
            '<meta http-equiv="Content-Security-Policy" content="script-src \\'none\\'">' +
              '<meta http-equiv="Content-Security-Policy-Report-Only" content="connect-src \\'none\\'">'
          );
          const innerHTMLMetaHost = document.createElement('div');
          innerHTMLMetaHost.innerHTML = '<meta http-equiv="Content-Security-Policy" content="img-src \\'none\\'">';
          if (innerHTMLMetaHost.firstChild) document.head.appendChild(innerHTMLMetaHost.firstChild);
          window.__metaPolicyParserProbe = (() => {
            const parsed = new DOMParser().parseFromString(
              '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'"></head><body><p>ok</p></body></html>',
              'text/html'
            );
            return {
              live: Array.from(parsed.querySelectorAll('meta[http-equiv]')).map((el) => ({
                httpEquiv: el.getAttribute('http-equiv'),
                content: el.getAttribute('content')
              })),
              text: parsed.body && parsed.body.textContent
            };
          })();
          const innerHTMLScript = document.createElement('script');
          innerHTMLScript.innerHTML = "window.__innerHTMLScriptFixture = ((row) => row.startsWith('x'))('x') && location.href;";
          document.body.appendChild(innerHTMLScript);
          try {
            const template = document.createElement('template');
            template.innerHTML = '<link rel="preconnect" href="https://preconnect.invalid">';
            const first = template.content.firstChild;
            const clone = first && first.cloneNode(true);
            if (clone) document.head.appendChild(clone);
            const rowTemplate = document.createElement('template');
            rowTemplate.innerHTML = '<tr><td>cell</td></tr>';
            const row = rowTemplate.content.firstChild;
            window.__templateLinkFixture = {
              childCount: template.content.childNodes.length,
              firstNode: first && first.localName,
              rel: first && first.getAttribute('rel'),
              href: first && first.getAttribute('href'),
              blockedRel: first && first.getAttribute('data-zp-blocked-rel'),
              blockedURL: first && first.getAttribute('data-zp-blocked-url'),
              cloneRel: clone && clone.getAttribute('rel'),
              cloneHref: clone && clone.getAttribute('href'),
              tableRowNode: row && row.nodeName,
              tableRowText: row && row.textContent
            };
          } catch (err) {
            window.__templateLinkFixture = { error: err && err.message || String(err) };
          }
        </script>
        <script src="/jquery.js"></script>
        <script src="/jquery-fixture.js"></script>
        <script src="/rewrite-fixture.js"></script>
        <script type="module" src="/module-worker.js"></script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Next</title></head><body>
        <main><h1>E2E Next</h1><p id="ua"></p></main>
        <script>document.getElementById('ua').textContent = navigator.userAgent;</script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/differential-fixture') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html><html><head><title>Differential Fixture</title></head><body>
        <main><h1>Differential Fixture</h1><pre id="fingerprint-report">{}</pre></main>
        <script>
          (async () => {
            const writeFingerprintReport = (value) => {
              const report = document.getElementById('fingerprint-report');
              if (report) report.textContent = JSON.stringify(value, null, 2);
            };
            const fnSource = (fn) => {
              try {
                return Function.prototype.toString.call(fn);
              } catch (err) {
                return 'error:' + ((err && err.name) || 'Error');
              }
            };
            const descriptorShape = (obj, key) => {
              const d = Object.getOwnPropertyDescriptor(obj, key);
              if (!d) return null;
              const out = {
                configurable: d.configurable,
                enumerable: d.enumerable,
                writable: Object.hasOwn(d, 'writable') ? d.writable : null,
                hasGet: typeof d.get === 'function',
                hasSet: typeof d.set === 'function',
                valueType: typeof d.value
              };
              if (typeof d.value === 'function') out.valueSource = fnSource(d.value);
              if (typeof d.get === 'function') out.getSource = fnSource(d.get);
              if (typeof d.set === 'function') out.setSource = fnSource(d.set);
              return out;
            };
            const hiddenArtifactKeys = () => Reflect.ownKeys(window)
              .map(k => typeof k === 'symbol' ? k.toString() : String(k))
              .filter(k => /^ZP$|ZPRewriter|ZPRustRewriter|ZPHTTPRewriter|__zp_|__ZP_|zeroproxy/i.test(k));
            const frameDescriptorProbe = (obj, key) => {
              try {
                const descriptor = Object.getOwnPropertyDescriptor(obj, key);
                return descriptor
                  ? {
                      ok: true,
                      configurable: descriptor.configurable,
                      enumerable: descriptor.enumerable,
                      valueType: typeof descriptor.value,
                      hasGet: typeof descriptor.get === 'function',
                      hasSet: typeof descriptor.set === 'function',
                    }
                  : { ok: true, missing: true };
              } catch (err) {
                return { ok: false, error: err && err.name || 'Error' };
              }
            };
            const fingerprintSurfaceObservations = () => {
              const canvas = document.createElement('canvas');
              canvas.width = 80;
              canvas.height = 24;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.fillStyle = '#f60';
                ctx.fillRect(0, 0, 80, 24);
                ctx.font = '13px Arial';
                ctx.fillStyle = '#069';
                ctx.fillText('ZeroProxy fp', 4, 16);
              }
              const canvasA = canvas.toDataURL();
              const canvasB = canvas.toDataURL();
              const rectProbe = document.createElement('div');
              rectProbe.style.cssText = 'position:absolute;left:11.25px;top:17.5px;width:33.5px;height:19.25px;padding:3px;border:2px solid transparent;';
              document.body.appendChild(rectProbe);
              const rect = rectProbe.getBoundingClientRect();
              rectProbe.remove();
              const glCanvas = document.createElement('canvas');
              const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
              const debugInfo = gl && gl.getExtension('WEBGL_debug_renderer_info');
              return {
                screen: {
                  width: screen.width,
                  height: screen.height,
                  availWidth: screen.availWidth,
                  availHeight: screen.availHeight,
                  colorDepth: screen.colorDepth,
                  pixelDepth: screen.pixelDepth,
                  devicePixelRatio,
                },
                locale: {
                  language: navigator.language,
                  languages: Array.from(navigator.languages || []),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                },
                canvas: {
                  stableRead: canvasA === canvasB,
                  prefix: canvasA.slice(0, 22),
                  length: canvasA.length,
                  toDataURLSource: fnSource(HTMLCanvasElement.prototype.toDataURL),
                  getImageDataSource: fnSource(CanvasRenderingContext2D.prototype.getImageData),
                },
                webgl: gl
                  ? {
                      vendor: String(gl.getParameter(gl.VENDOR) || ''),
                      renderer: String(gl.getParameter(gl.RENDERER) || ''),
                      debugVendor: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '') : '',
                      debugRenderer: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '') : '',
                      extensionCount: (gl.getSupportedExtensions() || []).length,
                    }
                  : null,
                domRect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  source: fnSource(Element.prototype.getBoundingClientRect),
                },
              };
            };
            // ============================================================================
            // 1. OBJECT PROPERTY COLLECTION MODULE
            // ============================================================================
            const getPrototypeChainKeys = (obj) => {
              let keys = [];
              for (let current = obj; current !== null; current = Object.getPrototypeOf(current)) {
                keys = keys.concat(Object.keys(current));
              }
              return keys;
            };
            const deduplicate = (array) => {
              array.sort();
              for (let i = 0; i < array.length; ) {
                if (array[i + 1] === array[i]) {
                  array.splice(i + 1, 1);
                } else {
                  i++;
                }
              }
              return array;
            };
            const extractUniqueKeys = (win, obj) => {
              let keys = getPrototypeChainKeys(obj);
              if (win.Object.getOwnPropertyNames) {
                keys = keys.concat(win.Object.getOwnPropertyNames(obj));
              }
              if (win.Array.from && win.Set) {
                return win.Array.from(new win.Set(keys));
              }
              return deduplicate(keys);
            };

            // ============================================================================
            // 2. TYPE DETECTION & SHORTCODE MAPPING MODULE
            // ============================================================================
            const checkNativeFunction = (win, value) => {
              const isFunctionInstance = value instanceof win.Function;
              const hasNativeCodeSignature = win.Function.prototype.toString.call(value).indexOf('[native code]') > 0;
              return isFunctionInstance && hasNativeCodeSignature;
            };
            const getSafeTypeOrNull = (win, obj, key) => {
              try {
                obj[key].catch(() => {});
                return 'p';
              } catch {}
              try {
                if (obj[key] === null || obj[key] === undefined) {
                  return obj[key] === undefined ? 'u' : 'x';
                }
              } catch {
                return 'i';
              }
              return null;
            };
            const getStandardTypeChar = (win, value) => {
              if (win.Array.isArray(value)) return 'a';
              if (value === win.Array) return 'q0';
              if (value === true) return 'T';
              if (value === false) return 'F';
              const rawType = typeof value;
              if (rawType === 'function') {
                return checkNativeFunction(win, value) ? 'N' : 'f';
              }
              const typeMap = {
                object: 'o',
                string: 's',
                undefined: 'u',
                symbol: 'z',
                number: 'n',
                bigint: 'I',
                boolean: 'b',
              };
              return typeMap[rawType] || '?';
            };
            const resolvePropertyType = (win, obj, key) => {
              const safeType = getSafeTypeOrNull(win, obj, key);
              if (safeType !== null) return safeType;
              return getStandardTypeChar(win, obj[key]);
            };

            // ============================================================================
            // 3. DATA AGGREGATION & INVERTED INDEXING MODULE
            // ============================================================================
            const saveRecord = (accumulator, storageKey, path) => {
              if (!Object.prototype.hasOwnProperty.call(accumulator, storageKey)) {
                accumulator[storageKey] = [];
              }
              accumulator[storageKey].push(path);
            };
            const analyzeSingleProperty = (win, obj, key, prefix, accumulator) => {
              const fullPath = prefix + key;
              const typeChar = resolvePropertyType(win, obj, key);
              const valueStoreTypes = ['n', 's', 'a', 'b'];
              if (!valueStoreTypes.includes(typeChar)) {
                saveRecord(accumulator, typeChar, fullPath);
                return;
              }
              if (fullPath === 'd.cookie') {
                saveRecord(accumulator, typeChar, fullPath);
                return;
              }
              const isNumericString = typeChar === 's' && !win.isNaN(obj[key]);
              if (!isNumericString) {
                saveRecord(accumulator, obj[key], fullPath);
              }
            };
            const buildObjectSnapshot = (win, targetObj, prefix, accumulator) => {
              if (targetObj === null || targetObj === undefined) return accumulator;
              const allKeys = extractUniqueKeys(win, targetObj);
              for (let i = 0; i < allKeys.length; i++) {
                analyzeSingleProperty(win, targetObj, allKeys[i], prefix, accumulator);
              }
              return accumulator;
            };
            const sortFingerprintRecords = (records) => {
              for (const key of Object.keys(records || {})) {
                if (Array.isArray(records[key])) records[key].sort();
              }
              return records;
            };

            // ============================================================================
            // 4. MAIN EXECUTION CONTROLLER (SANDBOX ISOLATION)
            // ============================================================================
            const waitForFrameLayout = () => new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            });
            const getFingerPrint = async () => {
              const doc = window.document;
              try {
                const iframe = doc.createElement('iframe');
                iframe.style.display = 'none';
                iframe.tabIndex = '-1';
                doc.body.appendChild(iframe);
                await waitForFrameLayout();
                const iframeWin = iframe.contentWindow;
                let dataStore = {};
                dataStore = buildObjectSnapshot(iframeWin, iframeWin, '', dataStore);
                dataStore = buildObjectSnapshot(iframeWin, iframeWin.clientInformation || iframeWin.navigator, 'n.', dataStore);
                dataStore = buildObjectSnapshot(iframeWin, iframe.contentDocument, 'd.', dataStore);
                doc.body.removeChild(iframe);
                return { r: dataStore, e: null };
              } catch (error) {
                return {
                  r: {},
                  e: error && {
                    name: error.name || 'Error',
                    message: error.message || String(error),
                  },
                };
              }
            };
            const objectPropertyCollectionFingerprint = async () => {
              const result = await getFingerPrint();
              if (result.e === null) {
                sortFingerprintRecords(result.r);
                let jsonString = JSON.stringify(result.r);
                jsonString = jsonString.replace(/\\d{2}\\/\\d{2}\\/\\d{4} \\d{2}:\\d{2}:\\d{2}/, '%timestamp%');
                console.log(jsonString);
                return { r: JSON.parse(jsonString), e: null };
              }
              console.error('Fingerprinting Failed:', result.e);
              return result;
            };
            const frameLocationKind = (href) => {
              if (href === 'about:blank') return 'about:blank';
              if (href === location.href) return 'parent-virtual';
              return 'other';
            };
            const frameObservations = () => {
              const frame = document.createElement('iframe');
              document.body.appendChild(frame);
              const child = frame.contentWindow;
              const childDoc = frame.contentDocument;
              const out = {
                contentWindowObject: !!child,
                contentDocumentObject: !!childDoc,
                childParentIsWindow: child && child.parent === window,
                childTopIsWindow: child && child.top === window,
                childOpenerIsNull: child && child.opener === null,
                childDocumentDefaultView: !!(childDoc && childDoc.defaultView === child),
                childLocationKind: child && child.location && frameLocationKind(child.location.href),
                childPostMessageSource: child && fnSource(child.postMessage),
                childFunctionDescriptor: child && frameDescriptorProbe(child, 'Function'),
                childOwnKeysHasFunction: child && Reflect.ownKeys(child).includes('Function')
              };
              frame.remove();
              return out;
            };
            const frameDocumentObservations = () => new Promise((resolve) => {
              const before = location.href;
              const frame = document.createElement('iframe');
              const finish = (value) => {
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                try {
                  frame.remove();
                } catch {}
                resolve(value);
              };
              const timer = setTimeout(() => {
                finish({
                  timeout: true,
                  frameSrc: frame.src || ''
                });
              }, 5000);
              function onMessage(ev) {
                if (!ev.data || ev.data.type !== 'frame-child-ready') return;
                const child = frame.contentWindow;
                const childDoc = frame.contentDocument;
                finish({
                  origin: ev.origin,
                  href: ev.data.href,
                  topOrigin: ev.data.topOrigin,
                  functionHref: ev.data.functionHref,
                  fetchSource: ev.data.fetchSource,
                  selfIsGlobalThis: ev.data.selfIsGlobalThis,
                  sourceIsFrame: ev.source === frame.contentWindow,
                  contentWindowObject: !!child,
                  contentDocumentObject: !!childDoc,
                  contentWindowHref: child && child.location ? child.location.href : '',
                  contentWindowParentIsWindow: child && child.parent === window,
                  contentWindowTopIsWindow: child && child.top === window,
                  contentDocumentURL: childDoc && childDoc.URL || '',
                  contentDocumentDefaultView: !!(childDoc && childDoc.defaultView === child),
                  parentBefore: before,
                  parentAfter: location.href,
                  frameSrc: frame.src || ''
                });
              }
              window.addEventListener('message', onMessage);
              frame.src = '/frame-child?diff=document';
              document.body.appendChild(frame);
            });
            const srcdocFrameObservations = () => new Promise((resolve) => {
              const frame = document.createElement('iframe');
              const finish = (value) => {
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                try {
                  frame.remove();
                } catch {}
                resolve(value);
              };
              const timer = setTimeout(() => {
                const child = frame.contentWindow;
                const childDoc = frame.contentDocument;
                finish({
                  timeout: true,
                  contentWindowObject: !!child,
                  contentDocumentObject: !!childDoc,
                  contentWindowHref: child && child.location ? child.location.href : '',
                  contentDocumentURL: childDoc && childDoc.URL || '',
                });
              }, 5000);
              function onMessage(ev) {
                if (!ev.data || ev.data.type !== 'frame-srcdoc-ready') return;
                const child = frame.contentWindow;
                const childDoc = frame.contentDocument;
                finish({
                  origin: ev.origin,
                  href: ev.data.href,
                  topOrigin: ev.data.topOrigin,
                  sourceIsFrame: ev.source === child,
                  contentWindowObject: !!child,
                  contentDocumentObject: !!childDoc,
                  contentWindowHref: child && child.location ? child.location.href : '',
                  contentWindowParentIsWindow: child && child.parent === window,
                  contentWindowTopIsWindow: child && child.top === window,
                  contentDocumentURL: childDoc && childDoc.URL || '',
                  contentDocumentDefaultView: !!(childDoc && childDoc.defaultView === child),
                });
              }
              window.addEventListener('message', onMessage);
              frame.srcdoc = '<!doctype html><html><body><p>srcdoc child</p><script>' +
                "parent.postMessage({ type: 'frame-srcdoc-ready', href: location.href, topOrigin: top.location.origin }, '*');" +
                '<\\/script></body></html>';
              document.body.appendChild(frame);
            });
            const workerObservations = () => new Promise((resolve) => {
              let worker;
              try {
                worker = new Worker('/worker-differential.js');
                const timer = setTimeout(() => {
                  try {
                    worker.terminate();
                  } catch {}
                  resolve({ timeout: true });
                }, 5000);
                worker.onmessage = (ev) => {
                  clearTimeout(timer);
                  try {
                    worker.terminate();
                  } catch {}
                  resolve(ev.data || null);
                };
                worker.onerror = (ev) => {
                  clearTimeout(timer);
                  try {
                    worker.terminate();
                  } catch {}
                  resolve({ error: ev && ev.message || 'worker-error' });
                };
              } catch (err) {
                resolve({ error: err && (err.name + ':' + err.message) || String(err) });
              }
            });
            const sharedWorkerObservations = () => new Promise((resolve) => {
              if (!('SharedWorker' in window)) {
                resolve({ supported: false });
                return;
              }
              let worker;
              try {
                worker = new SharedWorker('/shared-worker-differential.js', { name: 'diff-shared-worker' });
                const timer = setTimeout(() => resolve({ supported: true, timeout: true }), 5000);
                worker.onerror = (ev) => {
                  clearTimeout(timer);
                  resolve({ supported: true, error: ev && ev.message || 'sharedworker-error' });
                };
                worker.port.onmessage = (ev) => {
                  clearTimeout(timer);
                  try {
                    worker.port.close();
                  } catch {}
                  resolve({ supported: true, data: ev.data });
                };
                worker.port.start();
              } catch (err) {
                resolve({
                  supported: true,
                  error: err && (err.name + ':' + err.message) || String(err),
                });
              }
            });
            const withDeadline = (promise, label, ms = 5000) =>
              Promise.race([
                promise,
                new Promise(resolve => setTimeout(() => resolve({ timeout: label }), ms))
              ]);
            const out = {
              locationHref: location.href,
              locationOrigin: location.origin,
              functionHref: Function('return location.href')(),
              evalOrigin: eval('location.origin'),
              surface: {
                globals: {
                  windowIsSelf: window === self,
                  globalThisIsWindow: globalThis === window,
                  documentDefaultViewIsWindow: document.defaultView === window,
                  topIsWindow: top === window,
                  parentIsWindow: parent === window,
                  openerIsNull: opener === null
                },
                sources: {
                  fetch: fnSource(fetch),
                  xhr: fnSource(XMLHttpRequest),
                  websocket: fnSource(WebSocket),
                  eventSource: fnSource(EventSource),
                  worker: fnSource(Worker),
                  Function: fnSource(Function),
                  eval: fnSource(eval),
                  setTimeout: fnSource(setTimeout),
                  locationAssign: fnSource(location.assign),
                  historyPushState: fnSource(history.pushState)
                },
                descriptors: {
                  fetch: descriptorShape(window, 'fetch'),
                  XMLHttpRequest: descriptorShape(window, 'XMLHttpRequest'),
                  WebSocket: descriptorShape(window, 'WebSocket'),
                  EventSource: descriptorShape(window, 'EventSource'),
                  Worker: descriptorShape(window, 'Worker'),
                  Function: descriptorShape(window, 'Function'),
                  eval: descriptorShape(window, 'eval'),
                  location: descriptorShape(window, 'location'),
                  history: descriptorShape(window, 'history'),
                  postMessage: descriptorShape(window, 'postMessage')
                },
                ownKeys: {
                  hiddenArtifacts: hiddenArtifactKeys(),
                  hasLocation: Reflect.ownKeys(window).includes('location'),
                  hasHistory: Reflect.ownKeys(window).includes('history')
                },
                prototypes: {
                  locationTag: Object.prototype.toString.call(location),
                  historyTag: Object.prototype.toString.call(history),
                  documentTag: Object.prototype.toString.call(document)
                },
                frame: frameObservations(),
                fingerprint: {
                  ...fingerprintSurfaceObservations(),
                  objectPropertyCollection: await objectPropertyCollectionFingerprint()
                }
              }
            };
            out.surface.frameDocument = await frameDocumentObservations();
            out.surface.frameSrcdoc = await srcdocFrameObservations();
            out.surface.workerRealm = await workerObservations();
            out.surface.sharedWorkerRealm = await sharedWorkerObservations();
            out.stringTimerOrigin = await new Promise(resolve => {
              window.__diffTimerOrigin = '';
              setTimeout('window.__diffTimerOrigin = location.origin', 0);
              setTimeout(() => resolve(window.__diffTimerOrigin), 25);
            });
            out.stringIntervalOrigin = await new Promise(resolve => {
              window.__diffIntervalOrigin = '';
              const id = setInterval('window.__diffIntervalOrigin = location.origin', 5);
              setTimeout(() => {
                clearInterval(id);
                resolve(window.__diffIntervalOrigin);
              }, 25);
            });
            out.dynamicImport = (await import('/differential-module.js')).observation;
            out.eventSource = await new Promise(resolve => {
              let es;
              try {
                es = new EventSource('/sse-differential?diff=1');
                const timer = setTimeout(() => {
                  resolve({ timeout: true });
                  try {
                    es.close();
                  } catch {}
                }, 5000);
                es.onmessage = ev => {
                  clearTimeout(timer);
                  const result = {
                    url: es.url,
                    readyState: es.readyState,
                    data: ev.data,
                    origin: ev.origin || '',
                    lastEventId: ev.lastEventId || ''
                  };
                  resolve(result);
                  try {
                    es.close();
                  } catch {}
                };
                es.onerror = ev => {
                  clearTimeout(timer);
                  resolve({ error: ev && ev.type || 'eventsource-error' });
                  try {
                    es.close();
                  } catch {}
                };
              } catch (err) {
                resolve({ error: err && (err.name + ':' + err.message) || String(err) });
              }
            });
            out.policyHeaders = await withDeadline((async () => {
              const policyHeaders = await fetch('/policy-header-fixture?diff=1', { cache: 'no-store' });
              return {
                text: await policyHeaders.text(),
                csp: policyHeaders.headers.get('Content-Security-Policy') || '',
                reportOnly: policyHeaders.headers.get('Content-Security-Policy-Report-Only') || '',
                permissionsPolicy: policyHeaders.headers.get('Permissions-Policy') || '',
                featurePolicy: policyHeaders.headers.get('Feature-Policy') || ''
              };
            })(), 'policy-headers');
            const redirected = await fetch('/redirect302?diff=1', { cache: 'no-store' });
            out.redirect = { status: redirected.status, text: await redirected.text(), url: redirected.url, redirected: redirected.redirected, type: redirected.type };
            const post = await fetch('/request-echo?diff=post', { method: 'POST', body: 'diff-body', headers: { 'Content-Type': 'text/plain' }, cache: 'no-store' });
            out.post = await post.json();
            out.xhr = await new Promise(resolve => {
              const xhr = new XMLHttpRequest();
              const events = [];
              xhr.onreadystatechange = () => events.push('rs:' + xhr.readyState + ':' + xhr.status + ':' + (xhr.responseText || '').length);
              xhr.onprogress = ev => events.push('progress:' + xhr.readyState + ':' + ev.loaded + ':' + ev.lengthComputable);
              xhr.onload = () => events.push('load:' + xhr.readyState + ':' + xhr.status + ':' + xhr.responseText.length);
              xhr.onloadend = () => { events.push('loadend:' + xhr.readyState + ':' + xhr.status + ':' + xhr.responseText.length); resolve({ status: xhr.status, text: xhr.responseText, hasLoading: events.some(e => e.startsWith('rs:3:200:')), hasProgress: events.some(e => e.startsWith('progress:3:')), last: events.slice(-2) }); };
              xhr.open('GET', '/stream?diff=xhr');
              xhr.send();
            });
            out.ws = await new Promise((resolve, reject) => {
              const ws = new WebSocket('ws://' + location.host + '/ws', ['diff']);
              const timer = setTimeout(() => reject(new Error('ws-timeout')), 5000);
              ws.onerror = () => { clearTimeout(timer); reject(new Error('ws-error')); };
              ws.onopen = () => ws.send('differential');
              ws.onmessage = ev => { clearTimeout(timer); const value = String(ev.data); const result = { url: ws.url, protocol: ws.protocol, data: value }; try { ws.close(); } catch {} resolve(result); };
            });
            writeFingerprintReport(out.surface.fingerprint);
            window.__differential = out;
          })().catch(err => {
            const error = { error: err && (err.name + ':' + err.message) || String(err) };
            const report = document.getElementById('fingerprint-report');
            if (report) report.textContent = JSON.stringify(error, null, 2);
            window.__differential = error;
          });
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/site-icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      return;
    }
    if (url.pathname === '/site.css') {
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`.root-stylesheet-probe{border-top:7px solid rgb(12, 34, 56); padding-left:13px}`);
      return;
    }
    if (url.pathname === '/image-probe.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      return;
    }
    if (url.pathname === '/gtm.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`window.__gtmFixture = {
        loaded: true,
        href: location.href,
        currentSrc: document.currentScript && document.currentScript.src,
        currentAttr: document.currentScript && document.currentScript.attributes.getNamedItem('src') && document.currentScript.attributes.getNamedItem('src').value
      };
      window.postMessage({ type: 'gtm-loaded', href: location.href }, location.origin);`);
      return;
    }
    if (url.pathname === '/jquery.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JQUERY_SOURCE);
      return;
    }
    if (url.pathname === '/jquery-fixture.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`(($) => {
        const root = $('<section id="jquery-fixture-root"><button class="trigger">Go</button><ul><li class="item">one</li><li class="item">two</li></ul></section>').appendTo(document.body);
        const found = root.find('.item');
        const ended = found.end();
        let delegated = 0;
        root.on('click', '.trigger', function() {
          delegated++;
          $(this).data('clicked', true).attr('data-clicked', 'yes');
        });
        root.find('.trigger').trigger('click');
        root.append($.parseHTML('<div class="parsed"><span>parsed</span></div>'));
        const emptyHtml = $('<div id="empty-html-probe"></div>').appendTo(root);
        emptyHtml.html('<span>filled</span>');
        const deferred = $.Deferred();
        const ajax = $.ajax({ url: '/jquery-ajax.json', dataType: 'json' });
        const script = $.getScript('/jquery-plugin.js');
        $.globalEval('window.__jqueryGlobalEvalHref = location.href;');
        deferred.resolve('resolved');
        $.when(deferred, ajax, script).done(function(deferredValue, ajaxValue) {
          const ajaxData = Array.isArray(ajaxValue) ? ajaxValue[0] : ajaxValue;
          window.__jqueryFixture = {
            ready: true,
            version: $.fn.jquery,
            selectorText: found.map(function(_, el) { return $(el).text(); }).get().join(','),
            endMatchesRoot: ended[0] === root[0],
            delegated,
            dataClicked: root.find('.trigger').data('clicked') === true,
            attrClicked: root.find('.trigger').attr('data-clicked'),
            parsedText: root.find('.parsed span').text(),
            param: $.param({ a: 1, b: ['x', 'y'] }),
            htmlProbeText: emptyHtml.find('span').text(),
            htmlProbeChildren: emptyHtml.children().length,
            ajaxData,
            plugin: window.__jqueryPlugin || null,
            globalEvalHref: window.__jqueryGlobalEvalHref || null,
            locationHref: window.location.href
          };
        }).fail(function(xhr, status, err) {
          window.__jqueryFixture = { ready: false, error: String(err || status || 'jquery-failed') };
        });
      })(jQuery);`);
      return;
    }
    if (url.pathname === '/jquery-ajax.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, path: '/jquery-ajax.json' }));
      return;
    }
    if (url.pathname === '/jquery-plugin.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        `window.__jqueryPlugin = { loaded: true, href: location.href, jquery: !!window.jQuery };`,
      );
      return;
    }
    if (url.pathname === '/dynamic-script.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`window.__dynamicScriptLoaded = {
        loaded: true,
        href: location.href,
        currentSrc: document.currentScript && document.currentScript.src,
        currentAttr: document.currentScript && document.currentScript.attributes.getNamedItem('src') && document.currentScript.attributes.getNamedItem('src').value
      };`);
      return;
    }
    if (url.pathname === '/module-worker.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`const worker = new Worker(new URL('/worker-fixture.js', import.meta.url).href, { name: 'module-worker-fixture' });
        worker.onmessage = ev => { window.__moduleWorkerFixture = ev.data; worker.terminate(); };
        worker.onerror = ev => { window.__moduleWorkerFixture = { error: ev && ev.message || 'worker-error' }; };
        const moduleTypeWorker = new Worker('/module-type-worker-fixture.js', { type: 'module', name: 'module-type-worker-fixture' });
        moduleTypeWorker.onmessage = ev => { window.__moduleTypeWorkerFixture = ev.data; moduleTypeWorker.terminate(); };
        moduleTypeWorker.onerror = ev => { window.__moduleTypeWorkerFixture = { error: ev && ev.message || 'module-type-worker-error' }; };`);
      return;
    }
    if (url.pathname === '/module-type-worker-fixture.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`import { moduleTypeWorkerDep } from './module-type-worker-dep.js';
        postMessage({
          loaded: true,
          href: location.href,
          origin: location.origin,
          importMetaURL: import.meta.url,
          dep: moduleTypeWorkerDep,
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          fetchSource: Function.prototype.toString.call(fetch)
        });`);
      return;
    }
    if (url.pathname === '/module-type-worker-dep.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`export const moduleTypeWorkerDep = 'module-worker-dep-ok';`);
      return;
    }
    if (url.pathname === '/worker-fixture.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`(async () => {
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('worker-upload')); controller.close(); } });
        let upload = null;
        try {
          const resp = await fetch('/post-echo', { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'text/plain' } });
          upload = { status: resp.status, text: await resp.text(), serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
        } catch (err) {
          upload = { error: err && (err.name + ':' + err.message) || String(err), serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
        }
        postMessage({ loaded: true, href: location.href, userAgent: navigator.userAgent, platform: navigator.platform, upload });
      })();`);
      return;
    }
    if (url.pathname === '/worker-differential.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`(async () => {
        try {
          importScripts('/worker-imported-fixture.js');
        } catch (err) {
          self.__workerImportedFixture = { error: err && (err.name + ':' + err.message) || String(err) };
        }
        const fnSource = (fn) => {
          try {
            return Function.prototype.toString.call(fn);
          } catch (err) {
            return 'error:' + ((err && err.name) || 'Error');
          }
        };
        const descriptorShape = (obj, key) => {
          const d = Object.getOwnPropertyDescriptor(obj, key);
          if (!d) return null;
          const out = {
            configurable: d.configurable,
            enumerable: d.enumerable,
            writable: Object.hasOwn(d, 'writable') ? d.writable : null,
            hasGet: typeof d.get === 'function',
            hasSet: typeof d.set === 'function',
            valueType: typeof d.value
          };
          if (typeof d.value === 'function') out.valueSource = fnSource(d.value);
          if (typeof d.get === 'function') out.getSource = fnSource(d.get);
          if (typeof d.set === 'function') out.setSource = fnSource(d.set);
          return out;
        };
        const hiddenArtifactKeys = () => Reflect.ownKeys(self)
          .map(k => typeof k === 'symbol' ? k.toString() : String(k))
          .filter(k => /^ZP$|ZPRewriter|ZPRustRewriter|ZPHTTPRewriter|__zp_|__ZP_|zeroproxy/i.test(k));
        const out = {
          href: location.href,
          origin,
          globals: {
            selfIsGlobalThis: self === globalThis,
            locationTag: Object.prototype.toString.call(location)
          },
          sources: {
            fetch: fnSource(fetch),
            importScripts: fnSource(importScripts),
            Function: fnSource(Function),
            eval: fnSource(eval),
            setTimeout: fnSource(setTimeout),
            postMessage: fnSource(postMessage)
          },
          descriptors: {
            fetch: descriptorShape(self, 'fetch'),
            importScripts: descriptorShape(self, 'importScripts'),
            Function: descriptorShape(self, 'Function'),
            eval: descriptorShape(self, 'eval'),
            location: descriptorShape(self, 'location'),
            postMessage: descriptorShape(self, 'postMessage')
          },
          ownKeys: {
            hiddenArtifacts: hiddenArtifactKeys(),
            hasLocation: Reflect.ownKeys(self).includes('location')
          },
          imported: self.__workerImportedFixture || null
        };
        postMessage(out);
      })();`);
      return;
    }
    if (url.pathname === '/worker-imported-fixture.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`self.__workerImportedFixture = {
        loaded: true,
        href: location.href,
        origin,
        fetchSource: Function.prototype.toString.call(fetch)
      };`);
      return;
    }
    if (url.pathname === '/shared-worker-differential.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`onconnect = ev => {
        const port = ev.ports && ev.ports[0];
        if (!port) return;
        port.postMessage({
          href: location.href,
          origin,
          selfIsGlobalThis: self === globalThis,
          fetchSource: Function.prototype.toString.call(fetch),
          locationTag: Object.prototype.toString.call(location)
        });
      };`);
      return;
    }
    if (url.pathname === '/differential-module.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`export const observation = {
        href: location.href,
        origin: location.origin,
        importMetaURL: import.meta.url,
        defaultViewHref: document.defaultView.location.href,
        fetchSource: Function.prototype.toString.call(fetch)
      };`);
      return;
    }
    if (url.pathname === '/sse-differential') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.write('id: diff-id\\ndata: event-source-ok\\n\\n');
      setTimeout(() => {
        try {
          res.end();
        } catch {}
      }, 250);
      return;
    }
    if (url.pathname === '/policy-header-fixture') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'none'",
        'Content-Security-Policy-Report-Only': "default-src 'none'; connect-src 'none'",
        'Permissions-Policy': 'sync-xhr=()',
        'Feature-Policy': "sync-xhr 'none'",
      });
      res.end('policy-header-ok');
      return;
    }
    if (url.pathname === '/frame-child') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html><html><body><p>frame child</p><script>
        parent.postMessage({
          type: 'frame-child-ready',
          href: location.href,
          topOrigin: top.location.origin,
          functionHref: Function('return location.href')(),
          fetchSource: Function.prototype.toString.call(fetch),
          selfIsGlobalThis: self === globalThis
        }, location.origin);
      </script></body></html>`);
      return;
    }
    if (url.pathname === '/frame-relation') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html><html><body><p>frame relation</p><script>
        const params = new URL(location.href).searchParams;
        const key = params.get('key') || '';
        const readParent = (fn) => {
          try { return fn(); } catch (err) { return 'error:' + ((err && err.name) || 'Error'); }
        };
        parent.postMessage({
          type: 'frame-relation',
          key,
          href: location.href,
          origin: location.origin,
          topOrigin: readParent(() => top.location.origin),
          cookie: document.cookie,
          local: localStorage.getItem(key),
          session: sessionStorage.getItem(key),
          parentLocal: readParent(() => parent.localStorage.getItem(key)),
          parentLocationHref: readParent(() => parent.location.href)
        }, '*');
      </script></body></html>`);
      return;
    }
    if (url.pathname === '/rewrite-fixture.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`(() => {
        const NativeWebSocket = window.WebSocket;
        window.__rewriteAdvanced = { initialHref: window.location.href, constructorSource: NativeWebSocket.toString() };
        location.href += '#compound';
        window.location.hash += '-tail';
        window.__rewriteAdvanced.compoundHref = location.href;
        window.__rewriteAdvanced.compoundHash = location.hash;
        const ws = new NativeWebSocket('/ws', ['zp-rewrite']);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ws.send('rewrite-script');
        ws.onmessage = ev => {
          window.__rewriteAdvanced.wsURL = ws.url;
          window.__rewriteAdvanced.wsProtocol = ws.protocol;
          window.__rewriteAdvanced.wsMessage = String(ev.data);
          ws.close(1000, 'done');
        };
        ws.onerror = () => { window.__rewriteAdvanced.wsError = true; };
        function JQueryLike() { return { length: 0 }; }
        JQueryLike.prototype = {
          constructor: JQueryLike,
          pushStack() { return this.constructor(); }
        };
        window.__rewriteAdvanced.jqueryConstructorLength = Object.create(JQueryLike.prototype).pushStack().length;
        try {
          window.__rewriteAdvanced.constructorEscapeHref = ({}).constructor.constructor('return location.href')();
        } catch (err) {
          window.__rewriteAdvanced.constructorEscapeHref = 'error:' + (err && err.message || String(err));
        }
      })();`);
      return;
    }
    if (url.pathname === '/set-cookie') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'target_server=from-target; Path=/; SameSite=Lax',
      });
      res.end('set-cookie-ok');
      return;
    }
    if (url.pathname === '/account/set-cookie-scope') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': [
          'target_root=visible-root; Path=/; SameSite=Lax',
          'target_scoped=visible-account; Path=/account; SameSite=Lax',
          'target_secret=hidden; Path=/; HttpOnly; SameSite=Lax',
          'target_gone=deleted; Path=/; Max-Age=0; SameSite=Lax',
        ],
      });
      res.end('set-cookie-scope-ok');
      return;
    }
    if (url.pathname === '/cookie-echo') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(req.headers.cookie || '');
      return;
    }
    if (url.pathname === '/request-echo') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          method: req.method,
          cookie: req.headers.cookie || '',
          origin: req.headers.origin || '',
          referer: req.headers.referer || '',
          contentType: req.headers['content-type'] || '',
        }),
      );
      return;
    }
    if (url.pathname === '/xml') {
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('<?xml version="1.0"?><root><item>ok</item></root>');
      return;
    }
    if (url.pathname === '/account/cookie-echo') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(req.headers.cookie || '');
      return;
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.write('chunk-one\n');
      setTimeout(() => res.end('chunk-two\n'), 600);
      return;
    }
    if (url.pathname === '/slow-headers') {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('late-headers');
      }, 1000);
      return;
    }
    if (url.pathname === '/slow-body') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.write('body-one\n');
      setTimeout(() => {
        if (!res.destroyed) res.end('body-two\n');
      }, 1000);
      return;
    }
    if (url.pathname === '/slow-upload') {
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        req.pause();
        setTimeout(() => req.resume(), 50);
      });
      req.on('end', () => {
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(String(bytes));
      });
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.end('data: sse-ok\n\n');
      return;
    }
    if (url.pathname === '/form-echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const kind = url.searchParams.get('kind') || '';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(`<!doctype html><html><head><title>Form Echo ${kind}</title></head><body>
          <main id="form-result" data-method="${req.method}" data-kind="${kind}" data-content-type="${req.headers['content-type'] || ''}">
            <pre id="form-body">${body.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch])}</pre>
            <a id="next" href="/next">Next page</a>
          </main>
          <script>window.__formEcho=${JSON.stringify({ kind, method: req.method, contentType: req.headers['content-type'] || '', body })};</script>
        </body></html>`);
      });
      return;
    }
    if (url.pathname === '/post-echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }
    if (url.pathname === '/redirect307') {
      res.writeHead(307, { Location: '/post-echo', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (url.pathname === '/redirect302') {
      res.writeHead(302, { Location: '/redirect-final', 'Cache-Control': 'no-store' });
      res.end('redirecting');
      return;
    }
    if (url.pathname === '/redirect-cookie') {
      res.writeHead(302, {
        Location: '/cookie-echo?after-redirect=1',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'redirect_hop=stored; Path=/; SameSite=Lax',
      });
      res.end('redirecting-cookie');
      return;
    }
    if (url.pathname === '/redirect-final') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('redirect-final-ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) {
      if (isBenignSocketError(err)) socket.destroy();
      else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket, requests));
  return server;
}

function handleWebSocketUpgrade(req, socket, requests) {
  requests.push({
    url: req.url,
    method: req.method,
    host: req.headers.host || '',
    userAgent: req.headers['user-agent'] || '',
    cookie: req.headers.cookie || '',
    origin: req.headers.origin || '',
    protocol: req.headers['sec-websocket-protocol'] || '',
    upgrade: true,
  });
  if (new URL(req.url, 'http://target.local').pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const requestedProtocol =
    String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0] || '';
  ignoreBenignSocketErrors(socket);
  const protocolHeader = requestedProtocol
    ? `\r\nSec-WebSocket-Protocol: ${requestedProtocol}`
    : '';
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}${protocolHeader}\r\n\r\n`,
  );
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const frame = readWebSocketFrame(buffered);
      if (!frame) break;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        writeWebSocketFrame(socket, 0x8);
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        writeWebSocketFrame(socket, 0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0x1)
        writeWebSocketFrame(socket, 0x1, Buffer.from(`echo:${frame.payload.toString('utf8')}`));
      if (frame.opcode === 0x2) writeWebSocketFrame(socket, 0x2, frame.payload);
    }
  });
}

function readWebSocketFrame(buffer) {
  const b0 = buffer[0];
  const b1 = buffer[1];
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode: b0 & 0x0f, payload, consumed: offset + length };
}

function writeWebSocketFrame(socket, opcode, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

test('browser traffic uses internal SOCKS5 mode and covers proxied runtime integrations', {
  timeout: 120000,
}, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-e2e-'));
  const buildOut = path.join(temp, 'dist');
  run('node', ['scripts/build.mjs', '--out', buildOut]);
  const kernelPath = path.join(buildOut, 'kernel.wasm');
  const serverPath = path.join(
    buildOut,
    process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server',
  );
  const webPath = path.join(buildOut, 'web');

  const requests = [];
  const target = createTargetServer(requests);
  const targetPort = await listen(target);
  t.after(() => closeServer(target));
  const crossRequests = [];
  const crossTarget = createTargetServer(crossRequests);
  const crossPort = await listen(crossTarget);
  t.after(() => closeServer(crossTarget));
  const targetHost = 'localhost';

  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
  const proxy = childProcess.spawn(
    serverPath,
    [
      '-addr',
      `127.0.0.1:${proxyPort}`,
      '-web',
      webPath,
      '-kernel',
      kernelPath,
      '-socks',
      'internal',
    ],
    {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => proxy.kill('SIGTERM'));
  let proxyLog = '';
  proxy.stdout.on('data', (chunk) => {
    proxyLog += chunk;
  });
  proxy.stderr.on('data', (chunk) => {
    proxyLog += chunk;
  });
  await waitForHTTP(`http://127.0.0.1:${proxyPort}/`).catch((err) => {
    throw new Error(`${err.message}\nproxy output:\n${proxyLog}`);
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
    ],
  });
  t.after(() => browser.close());
  let page = await browser.newPage();
  const pageEvents = [];
  page.on('pageerror', (err) => {
    pageEvents.push(`pageerror:${(err && err.message) || String(err)}`);
  });
  page.on('console', (msg) => {
    pageEvents.push(`console:${msg.type()}:${msg.text()}`);
  });
  page.on('framenavigated', (frame) => {
    pageEvents.push(
      `framenavigated:${frame === page.mainFrame() ? 'main' : 'child'}:${frame.url()}`,
    );
  });
  await page.goto(`http://proxy.localhost:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
  await waitForPage(
    page,
    () =>
      navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      document.querySelector('#status')?.textContent === 'Ready.',
  );
  await page.type('#url', `http://${targetHost}:${targetPort}/`);
  await page.click('button');
  try {
    await waitForPage(page, () => document.title === 'E2E Home');
  } catch (err) {
    const state = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      body: document.body && document.body.innerText,
      status: document.querySelector('#status')?.textContent || '',
    }));
    throw new Error(
      `${err.message}; nav state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}; proxy=${proxyLog}`,
    );
  }
  await waitForPage(
    page,
    () =>
      document.getElementById('image-probe')?.complete &&
      document.getElementById('dynamic-image-probe')?.complete,
  );

  const home = await page.evaluate(async () => {
    const userAgentData = navigator.userAgentData
      ? {
          brands: navigator.userAgentData.brands,
          mobile: navigator.userAgentData.mobile,
          platform: navigator.userAgentData.platform,
          highEntropy: await navigator.userAgentData.getHighEntropyValues([
            'architecture',
            'bitness',
            'brands',
            'fullVersionList',
            'mobile',
            'model',
            'platform',
            'platformVersion',
            'uaFullVersion',
            'fullVersion',
            'wow64',
          ]),
          json: navigator.userAgentData.toJSON(),
        }
      : null;
    return {
      href: location.href,
      hash: location.hash,
      title: document.title,
      shellVisible: Boolean(document.querySelector('#open')),
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      userAgentData,
      templateLink: window.__templateLinkFixture,
      dynamicRelativeLink: (() => {
        const el = document.getElementById('dynamic-relative-next');
        return (
          el && {
            href: el.getAttribute('href'),
            hrefProp: el.href,
            outerHTML: el.outerHTML,
          }
        );
      })(),
      phase2Location: window.__phase2Location,
      phase2DynamicFunction: window.__phase2DynamicFunction,
      phase2EvalLocation: window.__phase2EvalLocation,
      phase2WindowEvalLocation: window.__phase2WindowEvalLocation,
      phase2IndirectEvalLocation: window.__phase2IndirectEvalLocation,
      maskedSelectorEval: window.__maskedSelectorEval,
      innerHTMLScriptFixture: window.__innerHTMLScriptFixture,
      styleProbe: (() => {
        const el = document.getElementById('style-probe');
        const cs = el && getComputedStyle(el);
        return (
          cs && {
            borderTopWidth: cs.borderTopWidth,
            borderTopColor: cs.borderTopColor,
            paddingLeft: cs.paddingLeft,
          }
        );
      })(),
      imageProbe: (() => {
        const el = document.getElementById('image-probe');
        const attr = el && el.attributes.getNamedItem('src');
        return (
          el && {
            complete: el.complete,
            naturalWidth: el.naturalWidth,
            src: el.getAttribute('src'),
            srcProp: el.src,
            currentSrc: el.currentSrc,
            attrValue: attr && attr.value,
            outerHTML: el.outerHTML,
          }
        );
      })(),
      dynamicImageProbe: (() => {
        const el = document.getElementById('dynamic-image-probe');
        const attr = el && el.attributes.getNamedItem('src');
        return (
          el && {
            complete: el.complete,
            naturalWidth: el.naturalWidth,
            src: el.getAttribute('src'),
            srcProp: el.src,
            attrValue: attr && attr.value,
            outerHTML: el.outerHTML,
          }
        );
      })(),
      faviconProbe: (() => {
        const el = document.getElementById('icon-link');
        const hrefAttr = el && el.attributes.getNamedItem('href');
        return (
          el && {
            rel: el.getAttribute('rel'),
            href: el.getAttribute('href'),
            hrefProp: el.href,
            hrefAttrValue: hrefAttr && hrefAttr.value,
            outerHTML: el.outerHTML,
          }
        );
      })(),
      metaPolicyProbe: {
        live: Array.from(document.querySelectorAll('meta[http-equiv]')).map((el) => ({
          httpEquiv: el.getAttribute('http-equiv'),
          content: el.getAttribute('content'),
        })),
        blocked: Array.from(document.querySelectorAll('meta[data-zp-blocked-http-equiv]')).map(
          (el) => ({
            blocked: el.getAttribute('data-zp-blocked-http-equiv'),
            httpEquiv: el.getAttribute('http-equiv'),
            content: el.getAttribute('content'),
          }),
        ),
        parser: window.__metaPolicyParserProbe,
      },
    };
  });
  assert.equal(home.title, 'E2E Home');
  assert.match(home.hash, /^#k=/);
  assert.equal(home.shellVisible, false);
  assert.equal(home.userAgent, TARGET_UA);
  assert.equal(home.appVersion, TARGET_UA.replace(/^Mozilla\//, ''));
  assert.deepEqual(home.userAgentData, {
    brands: TARGET_UA_BRANDS,
    mobile: false,
    platform: 'Windows',
    highEntropy: TARGET_UA_HIGH_ENTROPY,
    json: {
      brands: TARGET_UA_BRANDS,
      mobile: false,
      platform: 'Windows',
    },
  });
  const rootDocumentRequest = requests.find((r) => r.url === '/');
  assert.deepEqual(
    rootDocumentRequest && {
      secChUa: rootDocumentRequest.secChUa,
      secChUaFullVersion: rootDocumentRequest.secChUaFullVersion,
      secChUaFullVersionList: rootDocumentRequest.secChUaFullVersionList,
      secChUaPlatform: rootDocumentRequest.secChUaPlatform,
      secChUaPlatformVersion: rootDocumentRequest.secChUaPlatformVersion,
    },
    {
      secChUa: TARGET_CH_UA,
      secChUaFullVersion: TARGET_CH_UA_FULL_VERSION,
      secChUaFullVersionList: TARGET_CH_UA_FULL_VERSION_LIST,
      secChUaPlatform: '"Windows"',
      secChUaPlatformVersion: '"15.0.0"',
    },
  );
  assert.deepEqual(home.templateLink, {
    childCount: 1,
    firstNode: 'link',
    rel: null,
    href: null,
    blockedRel: null,
    blockedURL: null,
    cloneRel: null,
    cloneHref: null,
    tableRowNode: 'TR',
    tableRowText: 'cell',
  });
  assert.deepEqual(
    home.faviconProbe && {
      rel: home.faviconProbe.rel,
      href: home.faviconProbe.href,
      hrefProp: home.faviconProbe.hrefProp,
      hrefAttrValue: home.faviconProbe.hrefAttrValue,
    },
    {
      rel: 'icon',
      href: `http://${targetHost}:${targetPort}/site-icon.png`,
      hrefProp: `http://${targetHost}:${targetPort}/site-icon.png`,
      hrefAttrValue: `http://${targetHost}:${targetPort}/site-icon.png`,
    },
  );
  assert.doesNotMatch(home.faviconProbe.outerHTML, /x-zeroproxy-icon|data-zp-target-url/);
  assert.equal(home.platform, 'Win32');
  assert.match(home.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  assert.deepEqual(home.phase2Location, {
    href: `http://${targetHost}:${targetPort}/`,
    windowHref: `http://${targetHost}:${targetPort}/`,
  });
  assert.equal(home.phase2DynamicFunction, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.phase2EvalLocation, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.phase2WindowEvalLocation, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.phase2IndirectEvalLocation, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.maskedSelectorEval, 2);
  assert.equal(home.innerHTMLScriptFixture, `http://${targetHost}:${targetPort}/`);
  assert.deepEqual(home.styleProbe, {
    borderTopWidth: '7px',
    borderTopColor: 'rgb(12, 34, 56)',
    paddingLeft: '13px',
  });
  assert.ok(
    requests.some((r) => r.url === '/site.css' && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.equal(
    requests.some((r) => r.url === '/site-icon.png'),
    false,
    `favicon must not be fetched: ${JSON.stringify(requests)}`,
  );
  assert.deepEqual(home.metaPolicyProbe.live, []);
  assert.deepEqual(home.metaPolicyProbe.blocked, []);
  assert.deepEqual(home.metaPolicyProbe.parser, { live: [], text: 'ok' });
  assert.equal(home.imageProbe.complete, true);
  assert.equal(home.imageProbe.naturalWidth, 1);
  assert.equal(home.imageProbe.src, `http://${targetHost}:${targetPort}/image-probe.png`);
  assert.equal(home.imageProbe.srcProp, `http://${targetHost}:${targetPort}/image-probe.png`);
  assert.equal(home.imageProbe.currentSrc, `http://${targetHost}:${targetPort}/image-probe.png`);
  assert.equal(home.imageProbe.attrValue, `http://${targetHost}:${targetPort}/image-probe.png`);
  assert.doesNotMatch(home.imageProbe.outerHTML, /\/zp\/api\/fetch|data-zp-target/);
  assert.equal(home.dynamicImageProbe.complete, true);
  assert.equal(home.dynamicImageProbe.naturalWidth, 1);
  assert.equal(
    home.dynamicImageProbe.src,
    `http://${targetHost}:${targetPort}/image-probe.png?dynamic=1`,
  );
  assert.equal(
    home.dynamicImageProbe.srcProp,
    `http://${targetHost}:${targetPort}/image-probe.png?dynamic=1`,
  );
  assert.equal(
    home.dynamicImageProbe.attrValue,
    `http://${targetHost}:${targetPort}/image-probe.png?dynamic=1`,
  );
  assert.doesNotMatch(home.dynamicImageProbe.outerHTML, /\/zp\/api\/fetch|data-zp-target/);
  assert.ok(
    requests.some((r) => r.url === '/image-probe.png' && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url === '/image-probe.png?dynamic=1' && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url === '/' && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  const addressBarShare = page.url();
  const relayServerParam = new RegExp(
    `server=ws%3A%2F%2Fproxy\\.localhost%3A${proxyPort}%2Fzp%2Fws-pipe`,
  );
  assert.match(addressBarShare, /#k=/);
  assert.match(addressBarShare, relayServerParam);
  const staticNextHref = await page.$eval('#next', (el) => el.getAttribute('href') || '');
  assert.equal(staticNextHref, `http://${targetHost}:${targetPort}/next`);
  assert.deepEqual(home.dynamicRelativeLink, {
    href: `http://${targetHost}:${targetPort}/next`,
    hrefProp: `http://${targetHost}:${targetPort}/next`,
    outerHTML: `<a id="dynamic-relative-next" href="http://${targetHost}:${targetPort}/next">Dynamic next page</a>`,
  });
  const rawDynamicRelativeLink = await (async () => {
    const client = await page.target().createCDPSession();
    const deadline = Date.now() + 5000;
    let last = null;
    while (Date.now() < deadline) {
      const snap = await client.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [],
        includeDOMRects: false,
        includePaintOrder: false,
      });
      const strings = snap.strings;
      for (const doc of snap.documents) {
        const attrs = doc.nodes.attributes || [];
        for (const nodeAttrs of attrs) {
          const pairs = {};
          for (let i = 0; i < (nodeAttrs || []).length; i += 2) {
            pairs[strings[nodeAttrs[i]]] = strings[nodeAttrs[i + 1]];
          }
          if (pairs.id === 'dynamic-relative-next') {
            last = pairs;
            if (/^\/zp\/p\//.test(pairs.href || '')) return pairs;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return last;
  })();
  assert.match((rawDynamicRelativeLink && rawDynamicRelativeLink.href) || '', /^\/zp\/p\//);
  assert.match((rawDynamicRelativeLink && rawDynamicRelativeLink.href) || '', /#k=/);
  assert.equal(
    rawDynamicRelativeLink && rawDynamicRelativeLink['data-zp-target-url'],
    `http://${targetHost}:${targetPort}/next`,
  );
  const externalContext = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  try {
    const externalPage = await externalContext.newPage();
    await externalPage.goto(addressBarShare, { waitUntil: 'domcontentloaded' });
    await waitForPage(externalPage, () => document.title === 'E2E Home');
    assert.match(externalPage.url(), /#k=/);
    assert.match(externalPage.url(), relayServerParam);
  } finally {
    await externalContext.close();
  }
  await waitForPage(
    page,
    () => window.__rewriteAdvanced && window.__rewriteAdvanced.wsMessage === 'echo:rewrite-script',
  );
  const rewriteAdvanced = await page.evaluate(() => window.__rewriteAdvanced);
  assert.equal(rewriteAdvanced.initialHref, `http://${targetHost}:${targetPort}/`);
  assert.equal(rewriteAdvanced.wsURL, `ws://${targetHost}:${targetPort}/ws`);
  assert.equal(rewriteAdvanced.wsProtocol, 'zp-rewrite');
  assert.equal(rewriteAdvanced.wsMessage, 'echo:rewrite-script');
  assert.equal(rewriteAdvanced.wsError, undefined);
  assert.equal(rewriteAdvanced.jqueryConstructorLength, 0);
  assert.equal(
    rewriteAdvanced.constructorEscapeHref,
    `http://${targetHost}:${targetPort}/#compound-tail`,
  );
  assert.equal(rewriteAdvanced.compoundHash, '#compound-tail');
  assert.equal(rewriteAdvanced.compoundHref, `http://${targetHost}:${targetPort}/#compound-tail`);
  assert.ok(
    requests.some(
      (r) =>
        r.upgrade &&
        r.url === '/ws' &&
        r.protocol === 'zp-rewrite' &&
        r.userAgent === TARGET_UA &&
        r.origin === `http://${targetHost}:${targetPort}`,
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  try {
    await waitForPage(
      page,
      () =>
        window.__gtmFixture &&
        window.__gtmFixture.loaded &&
        window.__dynamicScriptLoaded &&
        window.__dynamicScriptLoaded.loaded &&
        window.__moduleWorkerFixture &&
        window.__moduleWorkerFixture.loaded &&
        window.__moduleTypeWorkerFixture &&
        window.__moduleTypeWorkerFixture.loaded,
    );
  } catch (err) {
    const state = await page.evaluate(() => ({
      gtm: window.__gtmFixture || null,
      dynamic: window.__dynamicScriptLoaded || null,
      moduleWorker: window.__moduleWorkerFixture || null,
      moduleTypeWorker: window.__moduleTypeWorkerFixture || null,
      scripts: Array.from(document.scripts).map((s) => ({
        id: s.id,
        src: s.attributes.getNamedItem('src')?.value || '',
        type: s.type || '',
        blocked: s.hasAttribute('data-zp-blocked-script'),
      })),
      messages: window.__messageEvents || [],
    }));
    throw new Error(
      `${err.message}; dynamic state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}`,
    );
  }
  const dynamicScripts = await page.evaluate(() => ({
    gtm: window.__gtmFixture,
    dynamic: window.__dynamicScriptLoaded,
    moduleWorker: window.__moduleWorkerFixture,
    moduleTypeWorker: window.__moduleTypeWorkerFixture,
    gtmAttr: document.getElementById('gtm-fixture')?.attributes.getNamedItem('src')?.value || '',
    dynamicAttr:
      document.getElementById('dynamic-script-probe')?.attributes.getNamedItem('src')?.value || '',
    messages: window.__messageEvents || [],
  }));
  assert.ok(
    dynamicScripts.gtm.href.startsWith(`http://${targetHost}:${targetPort}/`),
    dynamicScripts.gtm.href,
  );
  assert.ok(
    dynamicScripts.dynamic.href.startsWith(`http://${targetHost}:${targetPort}/`),
    dynamicScripts.dynamic.href,
  );
  assert.match(dynamicScripts.gtm.currentAttr, /^\/zp\/api\/script\?/);
  assert.equal(
    dynamicScripts.moduleWorker.href,
    `http://${targetHost}:${targetPort}/worker-fixture.js`,
  );
  assert.equal(dynamicScripts.moduleWorker.userAgent, TARGET_UA);
  assert.equal(dynamicScripts.moduleWorker.platform, 'Win32');
  assert.deepEqual(dynamicScripts.moduleWorker.upload, {
    status: 200,
    text: 'worker-upload',
    serviceWorker: false,
  });
  assert.equal(
    dynamicScripts.moduleTypeWorker.href,
    `http://${targetHost}:${targetPort}/module-type-worker-fixture.js`,
  );
  assert.equal(dynamicScripts.moduleTypeWorker.origin, `http://${targetHost}:${targetPort}`);
  assert.equal(
    dynamicScripts.moduleTypeWorker.importMetaURL,
    `http://${targetHost}:${targetPort}/module-type-worker-fixture.js`,
  );
  assert.equal(dynamicScripts.moduleTypeWorker.dep, 'module-worker-dep-ok');
  assert.equal(dynamicScripts.moduleTypeWorker.userAgent, TARGET_UA);
  assert.equal(dynamicScripts.moduleTypeWorker.platform, 'Win32');
  assert.match(dynamicScripts.moduleTypeWorker.fetchSource, /\[native code\]/);
  assert.match(dynamicScripts.dynamic.currentAttr, /^\/zp\/api\/script\?/);
  assert.match(dynamicScripts.gtmAttr, /^\/zp\/api\/script\?/);
  assert.match(dynamicScripts.dynamicAttr, /^\/zp\/api\/script\?/);
  assert.ok(
    dynamicScripts.messages.some((m) => m.type === 'gtm-loaded'),
    `messages: ${JSON.stringify(dynamicScripts.messages)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/gtm.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/dynamic-script.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/module-worker.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/worker-fixture.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) => r.url.startsWith('/module-type-worker-fixture.js') && r.userAgent === TARGET_UA,
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) => r.url.startsWith('/module-type-worker-dep.js') && r.userAgent === TARGET_UA,
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );

  try {
    await waitForPage(page, () => window.__jqueryFixture && window.__jqueryFixture.ready);
  } catch (err) {
    const state = await page.evaluate(() => ({
      jquery: window.__jqueryFixture || null,
      plugin: window.__jqueryPlugin || null,
      hasJQuery: Boolean(window.jQuery),
      scripts: Array.from(document.scripts).map((s) => ({
        id: s.id,
        src: s.attributes.getNamedItem('src')?.value || '',
        type: s.type || '',
        blocked: s.hasAttribute('data-zp-blocked-script'),
      })),
    }));
    throw new Error(
      `${err.message}; jquery state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}`,
    );
  }
  const jquery = await page.evaluate(() => window.__jqueryFixture);
  assert.match(jquery.version, /^3\./);
  assert.equal(jquery.selectorText, 'one,two');
  assert.equal(jquery.endMatchesRoot, true);
  assert.equal(jquery.delegated, 1);
  assert.equal(jquery.dataClicked, true);
  assert.equal(jquery.attrClicked, 'yes');
  assert.equal(jquery.parsedText, 'parsed');
  assert.equal(jquery.htmlProbeText, 'filled');
  assert.equal(jquery.htmlProbeChildren, 1);
  assert.equal(jquery.param, 'a=1&b%5B%5D=x&b%5B%5D=y');
  assert.deepEqual(jquery.ajaxData, { ok: true, path: '/jquery-ajax.json' });
  assert.equal(jquery.plugin && jquery.plugin.loaded, true);
  assert.equal(jquery.plugin && jquery.plugin.jquery, true);
  assert.ok(
    jquery.plugin.href.startsWith(`http://${targetHost}:${targetPort}/`),
    jquery.plugin.href,
  );
  assert.ok(
    jquery.globalEvalHref.startsWith(`http://${targetHost}:${targetPort}/`),
    jquery.globalEvalHref,
  );
  assert.ok(
    jquery.locationHref.startsWith(`http://${targetHost}:${targetPort}/`),
    jquery.locationHref,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/jquery.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/jquery-fixture.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/jquery-ajax.json') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/jquery-plugin.js') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );

  const iframeTarget = `http://${targetHost}:${targetPort}/next?frame=dynamic`;
  const iframeIsolation = await page.evaluate(async (target) => {
    const blockedByPolicy = (fn) => {
      try {
        fn();
        return '';
      } catch (err) {
        return (err && err.message) || String(err);
      }
    };

    const sync = document.createElement('iframe');
    document.body.appendChild(sync);
    const syncRTC = blockedByPolicy(() => new sync.contentWindow.RTCPeerConnection());
    const docRTC = blockedByPolicy(() => new sync.contentDocument.defaultView.RTCPeerConnection());

    const modern = document.createElement('iframe');
    document.body.append(modern);
    const modernRTC = blockedByPolicy(() => new modern.contentWindow.RTCPeerConnection());
    const websocketShared = modern.contentWindow.WebSocket === window.WebSocket;
    const ws = new modern.contentWindow.WebSocket('ws://evil.example/socket');
    const websocketURL = ws.url;
    const childCanvasMask = modern.contentWindow.HTMLCanvasElement.prototype.toDataURL.toString();
    const childFunctionShared = modern.contentWindow.Function === window.Function;
    const childFunctionSelfInstance =
      modern.contentWindow.Function instanceof modern.contentWindow.Function;
    const childEvalInstance = modern.contentWindow.eval instanceof modern.contentWindow.Function;
    const childFunctionSource = modern.contentWindow.Function.prototype.toString.call(
      modern.contentWindow.Function,
    );
    const childFunctionHref = modern.contentWindow.Function('return location.href')();
    try {
      ws.close();
    } catch {}

    const docwrite = document.createElement('iframe');
    document.body.appendChild(docwrite);
    const childDoc = docwrite.contentDocument;
    childDoc.open();
    childDoc.write(`<!doctype html><body>
      <script>window.__docwriteInlineRan = true;<\/script>
      <script src="/dynamic-script.js?from=docwrite-frame"><\/script>
    </body>`);
    childDoc.close();
    await new Promise((resolve) => {
      const deadline = Date.now() + 1000;
      (function poll() {
        const pendingExternal = Array.from(docwrite.contentDocument.scripts).some(
          (script) => script.type === 'application/x-zeroproxy-docwrite-external',
        );
        if (
          docwrite.contentWindow.__dynamicScriptLoaded ||
          !pendingExternal ||
          Date.now() > deadline
        ) {
          resolve();
          return;
        }
        setTimeout(poll, 25);
      })();
    });
    const docwriteHTML = docwrite.contentDocument.documentElement.outerHTML;
    const docwriteHelperType = typeof docwrite.contentWindow.__zp_runClassic;
    const docwriteInlineRan = docwrite.contentWindow.__docwriteInlineRan === true;
    const docwriteDynamic = docwrite.contentWindow.__dynamicScriptLoaded || null;

    const observed = document.createElement('iframe');
    document.body.appendChild(observed);
    const waitForVisibleFrameSrc = (frame, label) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        (function poll() {
          const current = frame.src || '';
          if (current === target) {
            resolve(current);
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error(`${label} src not virtualized: ${current}`));
            return;
          }
          setTimeout(poll, 25);
        })();
      });
    const waitForLoadedNextFrame = (frame, label) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        (function poll() {
          let title = '';
          try {
            title = frame.contentDocument && frame.contentDocument.title;
          } catch {}
          if (title === 'E2E Next') {
            resolve(title);
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error(`${label} frame did not load target document: ${title}`));
            return;
          }
          setTimeout(poll, 25);
        })();
      });
    const attr = document.createAttribute('src');
    attr.value = target;
    observed.attributes.setNamedItem(attr);
    const rewrittenSrc = await waitForVisibleFrameSrc(observed, 'setNamedItem');
    await waitForLoadedNextFrame(observed, 'setNamedItem');

    const nsFrame = document.createElement('iframe');
    document.body.appendChild(nsFrame);
    nsFrame.setAttributeNS(null, 'src', target);
    const nsFrameSrc = await waitForVisibleFrameSrc(nsFrame, 'setAttributeNS');
    await waitForLoadedNextFrame(nsFrame, 'setAttributeNS');

    const nodeFrame = document.createElement('iframe');
    document.body.appendChild(nodeFrame);
    const nodeAttr = document.createAttribute('src');
    nodeAttr.value = target;
    nodeFrame.setAttributeNode(nodeAttr);
    const nodeFrameSrc = await waitForVisibleFrameSrc(nodeFrame, 'setAttributeNode');
    await waitForLoadedNextFrame(nodeFrame, 'setAttributeNode');

    const ownedAttrFrame = document.createElement('iframe');
    document.body.appendChild(ownedAttrFrame);
    const ownedAttr = document.createAttribute('src');
    ownedAttr.value = 'about:blank';
    ownedAttrFrame.setAttributeNode(ownedAttr);
    ownedAttr.value = target;
    const ownedAttrFrameSrc = await waitForVisibleFrameSrc(ownedAttrFrame, 'owned Attr.value');
    await waitForLoadedNextFrame(ownedAttrFrame, 'owned Attr.value');

    sync.remove();
    modern.remove();
    docwrite.remove();
    observed.remove();
    nsFrame.remove();
    nodeFrame.remove();
    ownedAttrFrame.remove();
    return {
      syncRTC,
      docRTC,
      modernRTC,
      websocketShared,
      websocketURL,
      childCanvasMask,
      childFunctionShared,
      childFunctionSelfInstance,
      childEvalInstance,
      childFunctionSource,
      childFunctionHref,
      docwriteHTML,
      docwriteHelperType,
      docwriteInlineRan,
      docwriteDynamic,
      rewrittenSrc,
      nsFrameSrc,
      nodeFrameSrc,
      ownedAttrFrameSrc,
    };
  }, iframeTarget);
  assert.equal(iframeIsolation.syncRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.docRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.modernRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.websocketShared, true);
  assert.equal(iframeIsolation.websocketURL, 'ws://evil.example/socket');
  assert.equal(iframeIsolation.rewrittenSrc, iframeTarget);
  assert.equal(iframeIsolation.nsFrameSrc, iframeTarget);
  assert.equal(iframeIsolation.nodeFrameSrc, iframeTarget);
  assert.equal(iframeIsolation.ownedAttrFrameSrc, iframeTarget);
  assert.ok(
    requests.some((r) => r.url === '/next?frame=dynamic' && r.userAgent === TARGET_UA),
    `dynamic iframe transport request missing: ${JSON.stringify(requests)}`,
  );
  assert.equal(iframeIsolation.childCanvasMask, 'function toDataURL() { [native code] }');
  assert.equal(iframeIsolation.childFunctionShared, false);
  assert.equal(iframeIsolation.childFunctionSelfInstance, true);
  assert.equal(iframeIsolation.childEvalInstance, true);
  assert.equal(iframeIsolation.childFunctionSource, 'function Function() { [native code] }');
  assert.equal(
    iframeIsolation.childFunctionHref,
    `http://${targetHost}:${targetPort}/#compound-tail`,
  );
  assert.equal(iframeIsolation.docwriteHelperType, 'function');
  assert.doesNotMatch(
    iframeIsolation.docwriteHTML,
    /\/zp\/api\/script|data-zp-|application\/x-zeroproxy-docwrite-external|application\/x-zeroproxy-blocked/,
  );
  assert.equal(iframeIsolation.docwriteInlineRan, true);
  assert.equal(iframeIsolation.docwriteDynamic && iframeIsolation.docwriteDynamic.loaded, true);

  const frameMessage = await page.evaluate(async (target) => {
    const before = location.href;
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame postMessage timed out')), 10000);
      window.addEventListener('message', function onMessage(ev) {
        if (!ev.data || ev.data.type !== 'frame-child-ready') return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve({
          origin: ev.origin,
          href: ev.data.href,
          topOrigin: ev.data.topOrigin,
          functionHref: ev.data.functionHref,
          fetchSource: ev.data.fetchSource,
          selfIsGlobalThis: ev.data.selfIsGlobalThis,
        });
      });
    });
    const frame = document.createElement('iframe');
    frame.src = target;
    document.body.appendChild(frame);
    const message = await got;
    frame.remove();
    return { before, after: location.href, message };
  }, `http://${targetHost}:${targetPort}/frame-child`);
  assert.equal(frameMessage.before, frameMessage.after);
  assert.equal(frameMessage.message.origin, `http://${targetHost}:${targetPort}`);
  assert.equal(frameMessage.message.href, `http://${targetHost}:${targetPort}/frame-child`);
  assert.equal(frameMessage.message.topOrigin, `http://${targetHost}:${targetPort}`);
  assert.equal(frameMessage.message.functionHref, `http://${targetHost}:${targetPort}/frame-child`);
  assert.equal(frameMessage.message.fetchSource, 'function fetch() { [native code] }');
  assert.equal(frameMessage.message.selfIsGlobalThis, true);

  const readFrameRelations = (probePage) =>
    probePage.evaluate(
      async (targetPort, crossPort) => {
        const key = `frame-shared-${Date.now()}`;
        const cookieValue = `parent-${key}`;
        localStorage.setItem(key, 'parent-local');
        sessionStorage.setItem(key, 'parent-session');
        document.cookie = `frame_cookie=${cookieValue}; Path=/`;
        async function loadRelationFrame(src) {
          return new Promise((resolve, reject) => {
            const frame = document.createElement('iframe');
            const timer = setTimeout(() => {
              try {
                frame.remove();
              } catch {}
              reject(new Error(`frame relation timed out: ${src}`));
            }, 10000);
            window.addEventListener('message', function onMessage(ev) {
              if (!ev.data || ev.data.type !== 'frame-relation' || ev.data.key !== key) return;
              window.removeEventListener('message', onMessage);
              clearTimeout(timer);
              const out = {
                eventOrigin: ev.origin,
                sourceIsFrame: ev.source === frame.contentWindow,
                frameSrc: frame.src,
                data: ev.data,
              };
              frame.remove();
              resolve(out);
            });
            frame.src = src;
            document.body.appendChild(frame);
          });
        }
        const same = await loadRelationFrame(
          `http://localhost:${targetPort}/frame-relation?key=${encodeURIComponent(key)}&same=1`,
        );
        const cross = await loadRelationFrame(
          `http://localhost:${crossPort}/frame-relation?key=${encodeURIComponent(key)}&cross=1`,
        );
        return {
          key,
          cookieValue,
          parentLocal: localStorage.getItem(key),
          parentSession: sessionStorage.getItem(key),
          same,
          cross,
        };
      },
      targetPort,
      crossPort,
    );
  const frameRelationSummary = (value) => ({
    parentLocal: value.parentLocal,
    parentSession: value.parentSession,
    same: summarizeFrameRelation(value.same, value.cookieValue),
    cross: summarizeFrameRelation(value.cross, value.cookieValue),
  });
  const frameRelations = await readFrameRelations(page);
  const nativeFrameContext = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const nativeFramePage = await nativeFrameContext.newPage();
  const nativeFrameRequestStart = requests.length;
  const nativeCrossFrameRequestStart = crossRequests.length;
  try {
    await nativeFramePage.goto(`http://${targetHost}:${targetPort}/next`, {
      waitUntil: 'domcontentloaded',
    });
    const nativeFrameRelations = await readFrameRelations(nativeFramePage);
    assert.deepEqual(
      frameRelationSummary(frameRelations),
      frameRelationSummary(nativeFrameRelations),
    );
  } finally {
    await nativeFrameContext.close();
    requests.splice(nativeFrameRequestStart);
    crossRequests.splice(nativeCrossFrameRequestStart);
  }
  assert.equal(
    normalizeRelationURL(frameRelations.same.frameSrc),
    normalizeRelationURL(frameRelations.same.data.href),
  );
  assert.equal(
    normalizeRelationURL(frameRelations.cross.frameSrc),
    normalizeRelationURL(frameRelations.cross.data.href),
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/frame-relation?') && r.userAgent === TARGET_UA),
    `same-origin frame relation transport request missing: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    crossRequests.some((r) => r.url.startsWith('/frame-relation?') && r.userAgent === TARGET_UA),
    `cross-origin frame relation transport request missing: ${JSON.stringify(crossRequests)}`,
  );

  const fingerprintMasking = await page.evaluate(() => {
    const canvasMask = HTMLCanvasElement.prototype.toDataURL.toString();
    const voicesMask = speechSynthesis.getVoices.toString();

    const canvasA = document.createElement('canvas');
    canvasA.width = 16;
    canvasA.height = 16;
    const ctxA = canvasA.getContext('2d');
    ctxA.fillStyle = '#123456';
    ctxA.fillRect(0, 0, 16, 16);
    const urlA = canvasA.toDataURL();

    const canvasB = document.createElement('canvas');
    canvasB.width = 16;
    canvasB.height = 16;
    const ctxB = canvasB.getContext('2d');
    ctxB.fillStyle = '#123456';
    ctxB.fillRect(0, 0, 16, 16);
    const urlB = canvasB.toDataURL();

    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelCtx = pixelCanvas.getContext('2d');
    pixelCtx.fillStyle = 'rgba(0,0,0,1)';
    pixelCtx.fillRect(0, 0, 1, 1);
    const pixel = Array.from(pixelCtx.getImageData(0, 0, 1, 1).data);

    let audioDelta = null;
    if (window.AudioBuffer) {
      const buffer = new AudioBuffer({ length: 128, numberOfChannels: 1, sampleRate: 44100 });
      const channel = buffer.getChannelData(0);
      channel[0] = 0.01;
      for (let i = 0; i < 5; i++) buffer.getChannelData(0);
      audioDelta = buffer.getChannelData(0)[0] - 0.01;
    }

    const voices = speechSynthesis.getVoices();
    return {
      canvasMask,
      voicesMask,
      canvasVaries: urlA !== urlB,
      pixel,
      audioDelta,
      voiceCount: voices.length,
      voiceNames: voices.map((v) => v.name),
    };
  });
  assert.equal(fingerprintMasking.canvasMask, 'function toDataURL() { [native code] }');
  assert.equal(fingerprintMasking.voicesMask, 'function getVoices() { [native code] }');
  assert.deepEqual(fingerprintMasking.pixel.slice(0, 4), [1, 0, 1, 255]);
  assert.ok(fingerprintMasking.audioDelta === null || Math.abs(fingerprintMasking.audioDelta) > 0);
  assert.equal(fingerprintMasking.voiceCount, 2);
  assert.deepEqual(fingerprintMasking.voiceNames, [
    'Google US English',
    'Microsoft David - English (United States)',
  ]);
  const runtimeIntegration = await page.evaluate(
    async (targetPort, crossPort) => {
      const performanceRows = (entries) =>
        Array.from(entries || []).map((entry) => ({
          name: entry.name,
          entryType: entry.entryType,
          initiatorType: entry.initiatorType || '',
          duration: Math.round(Number(entry.duration) || 0),
          serverTiming: Array.from(entry.serverTiming || []).map((metric) => metric.name),
        }));
      const observedPerformance = [];
      const performanceObserver =
        typeof PerformanceObserver === 'function'
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                observedPerformance.push({
                  name: entry.name,
                  entryType: entry.entryType,
                  initiatorType: entry.initiatorType || '',
                  duration: Math.round(Number(entry.duration) || 0),
                  serverTiming: Array.from(entry.serverTiming || []).map((metric) => metric.name),
                });
              }
            })
          : null;
      performanceObserver?.observe({ type: 'resource', buffered: true });
      async function readText(path) {
        const resp = await fetch(path, { cache: 'no-store' });
        return resp.text();
      }
      async function waitForCookieHeader(needle) {
        let last = '';
        for (let i = 0; i < 30; i++) {
          last = await readText(`/cookie-echo?needle=${encodeURIComponent(needle)}&i=${i}`);
          if (last.includes(needle)) return last;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`cookie header never contained ${needle}: ${last}`);
      }
      async function waitForDocumentCookie(needle) {
        let last = '';
        for (let i = 0; i < 30; i++) {
          last = document.cookie;
          if (last.includes(needle)) return last;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`document.cookie never contained ${needle}: ${last}`);
      }
      async function waitForPathCookie(path, needle) {
        let last = '';
        for (let i = 0; i < 30; i++) {
          last = await readText(`${path}${path.includes('?') ? '&' : '?'}i=${i}`);
          if (last.includes(needle)) return last;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`${path} never contained ${needle}: ${last}`);
      }
      async function readStream() {
        const started = performance.now();
        const resp = await fetch(`/stream?ts=${Date.now()}`, { cache: 'no-store' });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        const firstMs = performance.now() - started;
        let body = first.value ? decoder.decode(first.value, { stream: true }) : '';
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          body += decoder.decode(next.value, { stream: true });
        }
        body += decoder.decode();
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          firstText: first.value ? decoder.decode(first.value) : '',
          firstMs,
          body,
        };
      }
      function withDeadline(promise, label, ms = 5000) {
        return Promise.race([
          promise,
          new Promise((resolve) => setTimeout(() => resolve({ timeout: label }), ms)),
        ]);
      }
      function xhrEventProbe(path, configure) {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          const events = [];
          const mark = (name) =>
            events.push(
              `${name}:${xhr.readyState}:${xhr.status}:${(xhr.responseText || '').length}`,
            );
          xhr.onreadystatechange = () => mark('readystatechange');
          xhr.onloadstart = () => mark('loadstart');
          xhr.onprogress = (ev) =>
            events.push(`progress:${xhr.readyState}:${ev.loaded}:${ev.lengthComputable}`);
          xhr.onload = () => mark('load');
          xhr.onerror = () => mark('error');
          xhr.ontimeout = () => mark('timeout');
          xhr.onabort = () => mark('abort');
          xhr.onloadend = () => {
            mark('loadend');
            resolve({
              status: xhr.status,
              readyState: xhr.readyState,
              text: xhr.responseText || '',
              events,
            });
          };
          xhr.open('GET', path);
          if (configure) configure(xhr);
          xhr.send();
        });
      }
      function xhrUploadProbe(body, contentType) {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          const uploadEvents = [];
          xhr.upload.onloadstart = (ev) =>
            uploadEvents.push(`loadstart:${ev.loaded}:${ev.lengthComputable}`);
          xhr.upload.onprogress = (ev) =>
            uploadEvents.push(`progress:${ev.loaded}:${ev.lengthComputable}`);
          xhr.upload.onload = (ev) => uploadEvents.push(`load:${ev.loaded}:${ev.lengthComputable}`);
          xhr.upload.onloadend = (ev) =>
            uploadEvents.push(`loadend:${ev.loaded}:${ev.lengthComputable}`);
          xhr.onloadend = () =>
            resolve({
              status: xhr.status,
              uploadEvents,
              textStart: String(xhr.responseText || '').slice(0, 40),
            });
          xhr.open('POST', '/post-echo?xhr=upload');
          if (contentType) xhr.setRequestHeader('Content-Type', contentType);
          xhr.send(body);
        });
      }
      function xhrRestrictionProbe() {
        const out = {};
        const sync = new XMLHttpRequest();
        sync.open('GET', '/post-echo', false);
        try {
          sync.responseType = 'arraybuffer';
          out.syncResponseType = 'allowed';
        } catch (err) {
          out.syncResponseType = (err && err.name) || 'Error';
        }
        try {
          sync.timeout = 10;
          out.syncTimeout = 'allowed';
        } catch (err) {
          out.syncTimeout = (err && err.name) || 'Error';
        }
        const async = new XMLHttpRequest();
        async.open('GET', '/stream?xhr=restriction');
        async.send();
        return new Promise((resolve) => {
          async.onreadystatechange = () => {
            if (async.readyState === 3 && !out.loadingResponseType) {
              try {
                async.responseType = 'json';
                out.loadingResponseType = 'allowed';
              } catch (err) {
                out.loadingResponseType = (err && err.name) || 'Error';
              }
              try {
                async.withCredentials = true;
                out.sentWithCredentials = 'allowed';
              } catch (err) {
                out.sentWithCredentials = (err && err.name) || 'Error';
              }
            }
          };
          async.onloadend = () => resolve(out);
        });
      }
      function xhrXMLProbe(asyncMode) {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.onloadend = () =>
            resolve({
              status: xhr.status,
              readyState: xhr.readyState,
              responseText: xhr.responseText,
              xmlText:
                (xhr.responseXML &&
                  xhr.responseXML.getElementsByTagName('item')[0] &&
                  xhr.responseXML.getElementsByTagName('item')[0].textContent) ||
                '',
            });
          xhr.open('GET', `/xml?async=${asyncMode}`, asyncMode);
          xhr.send();
          if (!asyncMode) xhr.onloadend();
        });
      }
      async function postText(path, body) {
        const resp = await fetch(path, { method: 'POST', body, cache: 'no-store' });
        return { status: resp.status, text: await resp.text() };
      }
      async function readJSON(path, init) {
        const resp = await fetch(path, Object.assign({ cache: 'no-store' }, init || {}));
        return { status: resp.status, json: await resp.json() };
      }
      async function responseShape(path, init) {
        const resp = await fetch(path, Object.assign({ cache: 'no-store' }, init || {}));
        const clone = resp.clone();
        return {
          status: resp.status,
          url: resp.url,
          redirected: resp.redirected,
          type: resp.type,
          internalURLHeader: resp.headers.get('X-ZP-Response-URL'),
          cloneText: await clone.text(),
        };
      }
      async function noCORSShape() {
        const resp = await fetch(`http://localhost:${crossPort}/request-echo?mode=no-cors`, {
          mode: 'no-cors',
          cache: 'no-store',
        });
        const clone = resp.clone();
        return {
          status: resp.status,
          statusText: resp.statusText,
          ok: resp.ok,
          url: resp.url,
          redirected: resp.redirected,
          type: resp.type,
          body: resp.body === null,
          bodyUsed: resp.bodyUsed,
          contentType: resp.headers.get('content-type'),
          text: await clone.text(),
        };
      }
      function websocketEcho() {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${targetPort}/ws`, ['zp-test']);
          let settled = false;
          const finish = (fn) => (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
          };
          const timer = setTimeout(
            () => finish(reject)(new Error('websocket echo timed out')),
            10000,
          );
          ws.onerror = () => finish(reject)(new Error('websocket error'));
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => ws.send(new Uint8Array([1, 2, 3]).buffer);
          ws.onmessage = (ev) => {
            const data =
              ev.data instanceof ArrayBuffer
                ? Array.from(new Uint8Array(ev.data)).join(',')
                : String(ev.data);
            const result = { url: ws.url, data, protocol: ws.protocol, readyState: ws.readyState };
            try {
              ws.close(1000, 'done');
            } catch {}
            finish(resolve)(result);
          };
        });
      }
      async function websocketStreamEcho() {
        const stream = new WebSocketStream(`ws://localhost:${targetPort}/ws`, {
          protocols: ['zp-stream'],
        });
        const opened = await stream.opened;
        const writer = opened.writable.getWriter();
        await writer.write('stream');
        const reader = opened.readable.getReader();
        const first = await reader.read();
        await writer.close();
        const closed = await stream.closed;
        return {
          protocol: opened.protocol,
          data: String(first.value),
          closeCode: closed.closeCode,
        };
      }

      const setCookieBody = await readText(`/set-cookie?ts=${Date.now()}`);
      const serverCookie = await waitForCookieHeader('target_server=from-target');
      document.cookie = 'client_runtime=from-runtime; Path=/';
      const visibleCookie = document.cookie;
      const clientCookie = await waitForCookieHeader('client_runtime=from-runtime');
      const credentialsOmitCookie = await fetch('/cookie-echo?credentials=omit', {
        credentials: 'omit',
        cache: 'no-store',
      }).then((resp) => resp.text());
      const credentialsSameOriginCookie = await fetch('/cookie-echo?credentials=same-origin', {
        credentials: 'same-origin',
        cache: 'no-store',
      }).then((resp) => resp.text());
      const noReferrerEcho = await readJSON('/request-echo?referrer=no', {
        referrerPolicy: 'no-referrer',
      });
      const originReferrerEcho = await readJSON('/request-echo?referrer=origin', {
        referrerPolicy: 'origin',
      });
      const postHeaderEcho = await readJSON('/request-echo?origin=post', {
        method: 'POST',
        body: 'header-body',
        headers: { 'Content-Type': 'text/plain' },
      });
      const directResponseShape = await responseShape('/post-echo?shape=direct', {
        method: 'POST',
        body: 'shape-body',
      });
      const noCORS = await noCORSShape();
      const referrerMeta = document.createElement('meta');
      referrerMeta.setAttribute('name', 'referrer');
      referrerMeta.setAttribute('content', 'no-referrer');
      document.head.appendChild(referrerMeta);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const metaNoReferrerEcho = await readJSON('/request-echo?referrer=meta-no-referrer');
      referrerMeta.setAttribute('content', 'origin');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const metaOriginEcho = await readJSON('/request-echo?referrer=meta-origin');
      const scopedCookieBody = await readText(`/account/set-cookie-scope?ts=${Date.now()}`);
      await waitForCookieHeader('target_root=visible-root');
      const visibleAfterScopedSet = await waitForDocumentCookie('target_root=visible-root');
      const accountCookie = await waitForPathCookie(
        `/account/cookie-echo?ts=${Date.now()}`,
        'target_scoped=visible-account',
      );
      const syncXHR = (() => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/post-echo', false);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.send('sync-upload');
        return { status: xhr.status, text: xhr.responseText, readyState: xhr.readyState };
      })();
      const stream = await readStream();
      const post = await postText('/post-echo', 'small-upload');
      const redirectFollow = await fetch('/redirect302?mode=follow', { cache: 'no-store' }).then(
        async (resp) => ({ status: resp.status, text: await resp.text() }),
      );
      const redirectShape = await responseShape('/redirect302?shape=follow');
      const redirectManual = await fetch('/redirect302?mode=manual', {
        redirect: 'manual',
        cache: 'no-store',
      }).then(async (resp) => ({ status: resp.status, text: await resp.text(), type: resp.type }));
      const redirectError = await fetch('/redirect302?mode=error', {
        redirect: 'error',
        cache: 'no-store',
      }).then(
        () => 'resolved',
        (err) => (err && err.name) || 'Error',
      );
      const redirectCookie = await fetch('/redirect-cookie?mode=follow', {
        cache: 'no-store',
      }).then((resp) => resp.text());
      const redirectPost = await postText('/redirect307', 'redirect-body');
      const oversizedResp = await postText('/post-echo', 'x'.repeat(8 * 1024 * 1024 + 1));
      const oversized = {
        status: oversizedResp.status,
        length: oversizedResp.text.length,
        first: oversizedResp.text.slice(0, 1),
      };
      const ws = await websocketEcho();
      const wsStream = await websocketStreamEcho();
      const xhrSuccess = await withDeadline(
        xhrEventProbe(`/stream?xhr=success&ts=${Date.now()}`),
        'xhr-success',
      );
      const xhrBlobUpload = await xhrUploadProbe(
        new Blob(['x'.repeat(128 * 1024)], { type: 'text/plain' }),
        'text/plain',
      );
      const form = new FormData();
      form.append('alpha', 'one');
      form.append('file', new Blob(['form-body'], { type: 'text/plain' }), 'probe.txt');
      const xhrFormDataUpload = await xhrUploadProbe(form);
      const xhrRestrictions = await xhrRestrictionProbe();
      const xhrXMLAsync = await xhrXMLProbe(true);
      const xhrXMLSync = await xhrXMLProbe(false);
      const xhr404 = await withDeadline(xhrEventProbe(`/missing-xhr?ts=${Date.now()}`), 'xhr-404');
      const xhrRedirect = await withDeadline(
        xhrEventProbe('/redirect302?xhr=redirect'),
        'xhr-redirect',
      );
      const takeRecords = performanceObserver
        ? performanceRows(performanceObserver.takeRecords())
        : [];
      performanceObserver?.disconnect();
      const performanceResources = performanceRows(performance.getEntriesByType('resource'));
      const syntheticTimingGaps = globalThis.__zpSyntheticTimingGaps || { script: 0, resource: 0 };
      return {
        setCookieBody,
        serverCookie,
        visibleCookie,
        clientCookie,
        credentialsOmitCookie,
        credentialsSameOriginCookie,
        noReferrerEcho,
        originReferrerEcho,
        postHeaderEcho,
        directResponseShape,
        noCORS,
        metaNoReferrerEcho,
        metaOriginEcho,
        scopedCookieBody,
        visibleAfterScopedSet,
        accountCookie,
        stream,
        xhrSuccess,
        xhrBlobUpload,
        xhrFormDataUpload,
        xhrRestrictions,
        xhrXMLAsync,
        xhrXMLSync,
        xhr404,
        xhrRedirect,
        ws,
        wsStream,
        post,
        syncXHR,
        redirectFollow,
        redirectShape,
        redirectManual,
        redirectError,
        redirectCookie,
        redirectPost,
        oversized,
        performance: {
          resources: performanceResources,
          observed: observedPerformance,
          takeRecords,
          syntheticTimingGaps,
        },
      };
    },
    targetPort,
    crossPort,
  );
  assert.equal(runtimeIntegration.setCookieBody, 'set-cookie-ok');
  assert.match(runtimeIntegration.serverCookie, /target_server=from-target/);
  assert.match(runtimeIntegration.visibleCookie, /client_runtime=from-runtime/);
  assert.match(runtimeIntegration.clientCookie, /target_server=from-target/);
  assert.match(runtimeIntegration.clientCookie, /client_runtime=from-runtime/);
  assert.doesNotMatch(runtimeIntegration.credentialsOmitCookie, /target_server=from-target/);
  assert.doesNotMatch(runtimeIntegration.credentialsOmitCookie, /client_runtime=from-runtime/);
  assert.match(runtimeIntegration.credentialsSameOriginCookie, /target_server=from-target/);
  assert.match(runtimeIntegration.credentialsSameOriginCookie, /client_runtime=from-runtime/);
  assert.deepEqual(runtimeIntegration.noReferrerEcho, {
    status: 200,
    json: {
      method: 'GET',
      cookie: runtimeIntegration.credentialsSameOriginCookie,
      origin: '',
      referer: '',
      contentType: '',
    },
  });
  assert.equal(runtimeIntegration.originReferrerEcho.status, 200);
  assert.match(
    runtimeIntegration.originReferrerEcho.json.referer,
    new RegExp(`^http://${targetHost}:${targetPort}/$`),
  );
  assert.equal(runtimeIntegration.postHeaderEcho.status, 200);
  assert.equal(runtimeIntegration.postHeaderEcho.json.origin, `http://${targetHost}:${targetPort}`);
  assert.match(
    runtimeIntegration.postHeaderEcho.json.referer,
    new RegExp(`^http://${targetHost}:${targetPort}/`),
  );
  assert.equal(runtimeIntegration.metaNoReferrerEcho.status, 200);
  assert.equal(runtimeIntegration.metaNoReferrerEcho.json.referer, '');
  assert.equal(runtimeIntegration.metaOriginEcho.status, 200);
  assert.equal(
    runtimeIntegration.metaOriginEcho.json.referer,
    `http://${targetHost}:${targetPort}/`,
  );
  assert.deepEqual(runtimeIntegration.directResponseShape, {
    status: 200,
    url: `http://${targetHost}:${targetPort}/post-echo?shape=direct`,
    redirected: false,
    type: 'basic',
    internalURLHeader: null,
    cloneText: 'shape-body',
  });
  assert.deepEqual(runtimeIntegration.noCORS, {
    status: 0,
    statusText: '',
    ok: false,
    url: '',
    redirected: false,
    type: 'opaque',
    body: true,
    bodyUsed: false,
    contentType: null,
    text: '',
  });
  assert.ok(
    crossRequests.some((r) => r.url === '/request-echo?mode=no-cors' && r.userAgent === TARGET_UA),
    `cross requests: ${JSON.stringify(crossRequests)}`,
  );
  assert.equal(runtimeIntegration.scopedCookieBody, 'set-cookie-scope-ok');
  assert.match(runtimeIntegration.visibleAfterScopedSet, /target_root=visible-root/);
  assert.doesNotMatch(runtimeIntegration.visibleAfterScopedSet, /target_scoped=visible-account/);
  assert.doesNotMatch(runtimeIntegration.visibleAfterScopedSet, /target_secret=hidden/);
  assert.doesNotMatch(runtimeIntegration.visibleAfterScopedSet, /target_gone=deleted/);
  assert.match(runtimeIntegration.accountCookie, /target_root=visible-root/);
  assert.match(runtimeIntegration.accountCookie, /target_scoped=visible-account/);
  assert.match(runtimeIntegration.accountCookie, /target_secret=hidden/);
  assert.doesNotMatch(runtimeIntegration.accountCookie, /target_gone=deleted/);
  assert.equal(runtimeIntegration.stream.status, 200);
  assert.match(runtimeIntegration.stream.contentType, /^text\/plain/);
  assert.equal(runtimeIntegration.stream.firstText, 'chunk-one\n');
  assert.equal(runtimeIntegration.stream.body, 'chunk-one\nchunk-two\n');
  assert.ok(
    runtimeIntegration.stream.firstMs < 500,
    `stream first chunk was buffered for ${runtimeIntegration.stream.firstMs}ms`,
  );
  assert.ok(
    runtimeIntegration.performance.resources.some(
      (entry) =>
        (entry.name.startsWith(`http://${targetHost}:${targetPort}/jquery.js`) ||
          entry.name.startsWith(`http://${targetHost}:${targetPort}/image-probe.png`)) &&
        entry.entryType === 'resource',
    ),
    `visible static resource timing missing: ${JSON.stringify(runtimeIntegration.performance.resources)}`,
  );
  assert.ok(
    runtimeIntegration.performance.resources.some(
      (entry) =>
        entry.name.startsWith(`http://${targetHost}:${targetPort}/stream?ts=`) &&
        entry.entryType === 'resource',
    ),
    `visible fetch timing missing: ${JSON.stringify(runtimeIntegration.performance.resources)}`,
  );
  assert.ok(
    runtimeIntegration.performance.observed.some(
      (entry) =>
        entry.name.startsWith(`http://${targetHost}:${targetPort}/stream?ts=`) &&
        entry.entryType === 'resource',
    ) ||
      runtimeIntegration.performance.takeRecords.some(
        (entry) =>
          entry.name.startsWith(`http://${targetHost}:${targetPort}/stream?ts=`) &&
          entry.entryType === 'resource',
      ),
    `PerformanceObserver resource entry missing: ${JSON.stringify(runtimeIntegration.performance)}`,
  );
  assert.ok(runtimeIntegration.performance.syntheticTimingGaps.script >= 0);
  assert.equal(runtimeIntegration.xhrSuccess.status, 200);
  assert.equal(runtimeIntegration.xhrSuccess.readyState, 4);
  assert.equal(runtimeIntegration.xhrSuccess.text, 'chunk-one\nchunk-two\n');
  assert.ok(
    runtimeIntegration.xhrSuccess.events.some((e) => e.startsWith('readystatechange:3:200:')),
    `XHR did not expose LOADING: ${JSON.stringify(runtimeIntegration.xhrSuccess.events)}`,
  );
  assert.ok(
    runtimeIntegration.xhrSuccess.events.some((e) => /^progress:3:\d+:/.test(e)),
    `XHR progress missing: ${JSON.stringify(runtimeIntegration.xhrSuccess.events)}`,
  );
  assert.ok(
    runtimeIntegration.xhrSuccess.events.at(-2).startsWith('load:4:200:'),
    `XHR load order wrong: ${JSON.stringify(runtimeIntegration.xhrSuccess.events)}`,
  );
  assert.ok(
    runtimeIntegration.xhrSuccess.events.at(-1).startsWith('loadend:4:200:'),
    `XHR loadend order wrong: ${JSON.stringify(runtimeIntegration.xhrSuccess.events)}`,
  );
  assert.equal(runtimeIntegration.xhrBlobUpload.status, 200);
  assert.ok(
    runtimeIntegration.xhrBlobUpload.uploadEvents.some((e) => e.startsWith('progress:')),
    `XHR Blob upload progress missing: ${JSON.stringify(runtimeIntegration.xhrBlobUpload.uploadEvents)}`,
  );
  assert.ok(
    runtimeIntegration.xhrBlobUpload.uploadEvents.at(-1).startsWith('loadend:'),
    `XHR Blob upload loadend missing: ${JSON.stringify(runtimeIntegration.xhrBlobUpload.uploadEvents)}`,
  );
  assert.equal(runtimeIntegration.xhrFormDataUpload.status, 200);
  assert.ok(
    runtimeIntegration.xhrFormDataUpload.uploadEvents.some((e) => e.startsWith('progress:')),
    `XHR FormData upload progress missing: ${JSON.stringify(runtimeIntegration.xhrFormDataUpload.uploadEvents)}`,
  );
  assert.ok(
    runtimeIntegration.xhrFormDataUpload.uploadEvents.at(-1).startsWith('loadend:'),
    `XHR FormData upload loadend missing: ${JSON.stringify(runtimeIntegration.xhrFormDataUpload.uploadEvents)}`,
  );
  assert.deepEqual(runtimeIntegration.xhrRestrictions, {
    syncResponseType: 'InvalidAccessError',
    syncTimeout: 'InvalidAccessError',
    loadingResponseType: 'InvalidStateError',
    sentWithCredentials: 'InvalidStateError',
  });
  assert.deepEqual(runtimeIntegration.xhrXMLAsync, {
    status: 200,
    readyState: 4,
    responseText: '<?xml version="1.0"?><root><item>ok</item></root>',
    xmlText: 'ok',
  });
  assert.ok(
    (runtimeIntegration.xhrXMLSync.status === 200 &&
      runtimeIntegration.xhrXMLSync.xmlText === 'ok') ||
      runtimeIntegration.xhrXMLSync.status === 0,
    `sync XHR XML must either parse responseXML or fail closed, got ${JSON.stringify(runtimeIntegration.xhrXMLSync)}`,
  );
  assert.equal(runtimeIntegration.xhr404.status, 404);
  assert.equal(runtimeIntegration.xhr404.readyState, 4);
  assert.ok(
    runtimeIntegration.xhr404.events.at(-2).startsWith('load:4:404:'),
    `XHR 404 load order wrong: ${JSON.stringify(runtimeIntegration.xhr404.events)}`,
  );
  assert.ok(
    runtimeIntegration.xhr404.events.at(-1).startsWith('loadend:4:404:'),
    `XHR 404 loadend missing: ${JSON.stringify(runtimeIntegration.xhr404.events)}`,
  );
  assert.equal(runtimeIntegration.xhrRedirect.status, 200);
  assert.equal(runtimeIntegration.xhrRedirect.text, 'redirect-final-ok');
  assert.ok(
    runtimeIntegration.xhrRedirect.events.at(-2).startsWith('load:4:200:'),
    `XHR redirect load order wrong: ${JSON.stringify(runtimeIntegration.xhrRedirect.events)}`,
  );
  assert.equal(runtimeIntegration.ws.url, `ws://${targetHost}:${targetPort}/ws`);
  assert.equal(runtimeIntegration.ws.data, '1,2,3');
  assert.equal(runtimeIntegration.ws.protocol, 'zp-test');
  assert.deepEqual(runtimeIntegration.wsStream, {
    protocol: 'zp-stream',
    data: 'echo:stream',
    closeCode: 1000,
  });
  assert.deepEqual(runtimeIntegration.post, { status: 200, text: 'small-upload' });
  assert.equal(runtimeIntegration.syncXHR.readyState, 4);
  assert.ok(
    (runtimeIntegration.syncXHR.status === 200 &&
      runtimeIntegration.syncXHR.text === 'sync-upload') ||
      runtimeIntegration.syncXHR.status === 0,
    `sync XHR must either pass through the active Service Worker or fail closed, got ${JSON.stringify(runtimeIntegration.syncXHR)}`,
  );
  assert.deepEqual(runtimeIntegration.redirectFollow, { status: 200, text: 'redirect-final-ok' });
  assert.deepEqual(runtimeIntegration.redirectShape, {
    status: 200,
    url: `http://${targetHost}:${targetPort}/redirect-final`,
    redirected: true,
    type: 'basic',
    internalURLHeader: null,
    cloneText: 'redirect-final-ok',
  });
  assert.equal(runtimeIntegration.redirectManual.status, 302);
  assert.equal(runtimeIntegration.redirectManual.text, 'redirecting');
  assert.equal(runtimeIntegration.redirectError, 'TypeError');
  assert.match(runtimeIntegration.redirectCookie, /redirect_hop=stored/);
  assert.deepEqual(runtimeIntegration.redirectPost, { status: 200, text: 'redirect-body' });
  assert.deepEqual(runtimeIntegration.oversized, {
    status: 200,
    length: 8 * 1024 * 1024 + 1,
    first: 'x',
  });
  assert.ok(
    requests.some((r) => r.url.startsWith('/set-cookie') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/stream') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) =>
        r.upgrade &&
        r.url === '/ws' &&
        r.userAgent === TARGET_UA &&
        r.origin === `http://${targetHost}:${targetPort}`,
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) =>
        r.upgrade &&
        r.url === '/ws' &&
        r.protocol === 'zp-stream' &&
        r.userAgent === TARGET_UA &&
        r.origin === `http://${targetHost}:${targetPort}`,
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) =>
        r.url.startsWith('/cookie-echo') &&
        r.cookie.includes('target_server=from-target') &&
        r.cookie.includes('client_runtime=from-runtime'),
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );

  const storageSeed = `stored-${Date.now()}`;
  const storageBeforeReload = await page.evaluate((seed) => {
    localStorage.setItem('zp-persist', seed);
    sessionStorage.setItem('zp-session', `${seed}-session`);
    return {
      local: localStorage.getItem('zp-persist'),
      session: sessionStorage.getItem('zp-session'),
    };
  }, storageSeed);
  assert.deepEqual(storageBeforeReload, { local: storageSeed, session: `${storageSeed}-session` });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPage(page, () => document.title === 'E2E Home');
  const storageAfterReload = await page.evaluate(() => ({
    initial: window.__storageInitial,
    local: localStorage.getItem('zp-persist'),
    session: sessionStorage.getItem('zp-session'),
  }));
  assert.deepEqual(storageAfterReload, {
    initial: { local: storageSeed, session: `${storageSeed}-session` },
    local: storageSeed,
    session: `${storageSeed}-session`,
  });
  const escapeMatrix = await page.evaluate(async (targetPort) => {
    const directBase = `http://localhost:${targetPort}`;
    const out = {};
    out.fetch = await fetch(`${directBase}/direct-fetch`, { cache: 'no-store' })
      .then((r) => `ok:${r.status}`)
      .catch((err) => `blocked:${(err && err.name) || 'Error'}`);
    out.xhr = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => resolve(`ok:${xhr.status}`);
      xhr.onerror = () => resolve('blocked:error');
      try {
        xhr.open('GET', `${directBase}/direct-xhr`);
        xhr.send();
      } catch (err) {
        resolve(`blocked:${(err && err.name) || 'Error'}`);
      }
    });
    out.eventSource = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          try {
            es.close();
          } catch {}
          resolve(value);
        }
      };
      let es;
      try {
        es = new EventSource(`${directBase}/sse`);
        es.onmessage = (ev) => finish(`ok:${ev.data}`);
        es.onerror = () => finish('blocked:error');
        setTimeout(() => finish('blocked:timeout'), 1000);
      } catch (err) {
        resolve(`blocked:${(err && err.name) || 'Error'}`);
      }
    });
    out.websocket = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${targetPort}/ws`);
      const timer = setTimeout(() => reject(new Error('internal-mode websocket timed out')), 10000);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('internal-mode websocket failed'));
      };
      ws.onopen = () => ws.send('direct');
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        const value = String(ev.data);
        try {
          ws.close();
        } catch {}
        resolve(value);
      };
    });
    out.stringTimer = await new Promise((resolve) => {
      try {
        window.__timerRan = 0;
        setTimeout('window.__timerRan=1', 0);
        setTimeout(() => resolve(window.__timerRan === 1 ? 'ran' : 'not-ran'), 25);
      } catch (err) {
        resolve((err && err.message) || String(err));
      }
    });
    out.blobWorker = await new Promise((resolve) => {
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([`postMessage('ran')`], { type: '' }));
        worker = new Worker(url);
        const timer = setTimeout(() => {
          try {
            worker.terminate();
          } catch {}
          resolve('no-message');
        }, 500);
        worker.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(String(ev.data));
        };
        worker.onerror = (ev) => {
          clearTimeout(timer);
          resolve(`error:${(ev && ev.message) || 'worker-error'}`);
        };
      } catch (err) {
        resolve(`throw:${(err && err.message) || String(err)}`);
      }
    });
    out.dataWorker = await new Promise((resolve) => {
      let worker;
      try {
        worker = new Worker('data:text/javascript,postMessage(%22ran%22)');
        const timer = setTimeout(() => {
          try {
            worker.terminate();
          } catch {}
          resolve('no-message');
        }, 500);
        worker.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(String(ev.data));
        };
        worker.onerror = () => {
          clearTimeout(timer);
          resolve('error');
        };
      } catch (err) {
        resolve(`throw:${(err && err.message) || String(err)}`);
      }
    });
    out.sandboxSecurityDelta = (() => {
      const cases = [
        { id: 'scripts-same-origin', value: 'allow-scripts allow-same-origin', dangerous: true },
        {
          id: 'same-origin-scripts-case',
          value: 'allow-same-origin ALLOW-SCRIPTS',
          dangerous: true,
        },
        { id: 'scripts-only', value: 'allow-scripts', dangerous: false },
        { id: 'same-origin-only', value: 'allow-same-origin', dangerous: false },
        { id: 'popups-only', value: 'allow-popups', dangerous: false },
        { id: 'empty', value: '', dangerous: false },
      ];
      return cases.map((item) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', item.value);
        document.body.appendChild(frame);
        const names = frame.getAttributeNames().map((name) => String(name).toLowerCase());
        const serialized = frame.outerHTML;
        const result = {
          ...item,
          getAttribute: frame.getAttribute('sandbox'),
          hasAttribute: frame.hasAttribute('sandbox'),
          getAttributeNamesHasSandbox: names.includes('sandbox'),
          serializedHasSandbox: /\ssandbox(?:=|\s|>)/i.test(serialized),
          serializedHasZPAttribute: /\sdata-zp-/i.test(serialized),
        };
        frame.remove();
        return result;
      });
    })();
    out.unsupportedFrameSchemes = await (async () => {
      const messages = new Set();
      const onMessage = (ev) => {
        if (ev.data && ev.data.type === 'unsupported-frame') messages.add(ev.data.scheme);
      };
      const srcKind = (value) => {
        const text = String(value || '');
        if (text === 'about:blank') return 'about:blank';
        if (text.startsWith('data:')) return 'data';
        if (text.startsWith('blob:')) return 'blob';
        if (text.startsWith('javascript:')) return 'javascript';
        return text ? 'other' : 'empty';
      };
      const classify = async (scheme, source) => {
        const frame = document.createElement('iframe');
        window.addEventListener('message', onMessage);
        try {
          frame.src = source;
          document.body.appendChild(frame);
          await new Promise((resolve) => setTimeout(resolve, 150));
          const visibleSrcKind = srcKind(frame.getAttribute('src'));
          const propertySrcKind = srcKind(frame.src);
          const messageDelivered = messages.has(scheme);
          return {
            scheme,
            visibleSrcKind,
            propertySrcKind,
            messageDelivered,
            classification:
              visibleSrcKind === 'about:blank' &&
              propertySrcKind === 'about:blank' &&
              !messageDelivered
                ? 'blocked'
                : 'unsupported',
            serializedHasZPAttribute: /\sdata-zp-/i.test(frame.outerHTML),
          };
        } finally {
          window.removeEventListener('message', onMessage);
          try {
            frame.remove();
          } catch {}
        }
      };
      const blobURL = URL.createObjectURL(
        new Blob(
          [`<script>parent.postMessage({type:'unsupported-frame',scheme:'blob'}, '*')<\/script>`],
          { type: 'text/html' },
        ),
      );
      try {
        return [
          await classify(
            'data',
            `data:text/html,<script>parent.postMessage({type:'unsupported-frame',scheme:'data'}, '*')<\/script>`,
          ),
          await classify(
            'javascript',
            `javascript:parent.postMessage({type:'unsupported-frame',scheme:'javascript'}, '*')`,
          ),
          await classify('blob', blobURL),
        ];
      } finally {
        URL.revokeObjectURL(blobURL);
      }
    })();
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.__eventHandlerLocation = location.href');
    document.body.appendChild(button);
    out.eventHandlerExpectedLocation = __zp_get(globalThis, 'location').href;
    button.click();
    out.eventHandlerLocation = window.__eventHandlerLocation || '';
    button.remove();
    const loc = __zp_get(globalThis, 'window').location;
    out.locationReplaceSource = loc.replace.toString();
    loc.hash = '#zp-fragment';
    out.virtualHash = loc.hash;
    out.virtualHref = loc.href;
    const beforeSrcdoc = location.href;
    const evil = document.createElement('iframe');
    const evilSrcdoc = `<script>top.location.href='https://evil.example/'; parent.postMessage({type:'evil-srcdoc'}, '*')<\/script>`;
    evil.srcdoc = evilSrcdoc;
    out.evilSrcdocVisible = (evil.getAttribute('srcdoc') || '') === evilSrcdoc;
    document.body.appendChild(evil);
    await new Promise((resolve) => setTimeout(resolve, 100));
    out.afterSrcdocHref = location.href;
    out.afterSrcdocVirtualHref = loc.href;
    out.topOrigin = __zp_get(globalThis, 'top').location.origin;
    out.beforeSrcdoc = beforeSrcdoc;
    evil.remove();
    return out;
  }, targetPort);
  assert.equal(escapeMatrix.fetch, 'ok:404');
  assert.equal(escapeMatrix.xhr, 'ok:404');
  assert.equal(escapeMatrix.eventSource, 'ok:sse-ok');
  assert.equal(escapeMatrix.websocket, 'echo:direct');
  assert.equal(escapeMatrix.locationReplaceSource, 'function replace() { [native code] }');
  assert.equal(escapeMatrix.virtualHash, '#zp-fragment');
  assert.match(escapeMatrix.virtualHref, /#zp-fragment$/);
  assert.equal(escapeMatrix.afterSrcdocVirtualHref, escapeMatrix.virtualHref);
  assert.equal(escapeMatrix.evilSrcdocVisible, true);
  assert.equal(escapeMatrix.topOrigin, `http://${targetHost}:${targetPort}`);
  assert.equal(page.url().startsWith(`http://proxy.localhost:${proxyPort}/`), true);
  assert.equal(escapeMatrix.stringTimer, 'ran');
  assert.equal(escapeMatrix.blobWorker, 'ran');
  assert.notEqual(escapeMatrix.dataWorker, 'ran');
  for (const row of escapeMatrix.sandboxSecurityDelta) {
    assert.equal(row.getAttribute, row.value, `sandbox getAttribute mismatch: ${row.id}`);
    assert.equal(row.hasAttribute, true, `sandbox hasAttribute mismatch: ${row.id}`);
    assert.equal(
      row.getAttributeNamesHasSandbox,
      true,
      `sandbox getAttributeNames mismatch: ${row.id}`,
    );
    assert.equal(row.serializedHasZPAttribute, false, `sandbox leaked ZP attr: ${row.id}`);
    assert.equal(
      row.serializedHasSandbox,
      !row.dangerous,
      `sandbox native visibility mismatch: ${JSON.stringify(row)}`,
    );
  }
  assert.deepEqual(
    escapeMatrix.unsupportedFrameSchemes.map((row) => ({
      scheme: row.scheme,
      classification: row.classification,
      visibleSrcKind: row.visibleSrcKind,
      propertySrcKind: row.propertySrcKind,
      messageDelivered: row.messageDelivered,
      serializedHasZPAttribute: row.serializedHasZPAttribute,
    })),
    [
      {
        scheme: 'data',
        classification: 'blocked',
        visibleSrcKind: 'about:blank',
        propertySrcKind: 'about:blank',
        messageDelivered: false,
        serializedHasZPAttribute: false,
      },
      {
        scheme: 'javascript',
        classification: 'blocked',
        visibleSrcKind: 'about:blank',
        propertySrcKind: 'about:blank',
        messageDelivered: false,
        serializedHasZPAttribute: false,
      },
      {
        scheme: 'blob',
        classification: 'blocked',
        visibleSrcKind: 'about:blank',
        propertySrcKind: 'about:blank',
        messageDelivered: false,
        serializedHasZPAttribute: false,
      },
    ],
  );
  assert.ok(
    escapeMatrix.eventHandlerLocation === '' ||
      escapeMatrix.eventHandlerLocation === escapeMatrix.eventHandlerExpectedLocation,
    `event handler location: ${escapeMatrix.eventHandlerLocation}`,
  );
  assert.equal(
    requests.filter((r) => r.userAgent && r.userAgent !== TARGET_UA).length,
    0,
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url.startsWith('/direct-fetch') && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );

  let serviceWorkerPolicy;
  try {
    serviceWorkerPolicy = await page.evaluate(async () => {
      const out = {
        exposed: 'serviceWorker' in navigator,
        controller: navigator.serviceWorker && navigator.serviceWorker.controller,
        registrationCount: null,
        registerError: '',
      };
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations)
        out.registrationCount = (await navigator.serviceWorker.getRegistrations()).length;
      try {
        await navigator.serviceWorker.register('/target-sw.js');
      } catch (err) {
        out.registerError = (err && err.name) || String(err);
      }
      return out;
    });
  } catch (err) {
    throw new Error(
      `serviceWorkerPolicy evaluate failed: ${(err && err.message) || String(err)}; page=${page.url()}; events=${JSON.stringify(pageEvents)}`,
    );
  }
  assert.equal(serviceWorkerPolicy.exposed, true);
  assert.equal(serviceWorkerPolicy.controller, null);
  assert.equal(serviceWorkerPolicy.registrationCount, 0);
  assert.equal(serviceWorkerPolicy.registerError, 'NotSupportedError');
  const bootLeak = await page.evaluate(() => ({
    bootType: typeof window.__ZP_BOOT,
    scriptContainsRuntimeToken: Array.from(document.scripts).some((s) =>
      s.textContent.includes('runtimeToken'),
    ),
    selectorArtifacts: document.querySelectorAll(
      'script[src*="zp"],script[src*="zeroproxy"],#__zp-boot,[data-zp-target-url],[data-zp-blocked-url]',
    ).length,
    scriptArtifacts: Array.from(document.scripts)
      .filter((s) =>
        /\/zp\/assets\/|\/zp\/api\/script|zeroproxy/i.test(
          s.src || s.getAttribute('src') || s.outerHTML || '',
        ),
      )
      .map((s) => s.src || s.outerHTML),
    tagArtifacts: Array.from(document.getElementsByTagName('script'))
      .filter((s) =>
        /\/zp\/assets\/|\/zp\/api\/script|zeroproxy/i.test(
          s.src || s.getAttribute('src') || s.outerHTML || '',
        ),
      )
      .map((s) => s.src || s.outerHTML),
    iteratorArtifacts: (() => {
      const out = [];
      const it = document.createNodeIterator(document, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = it.nextNode())) {
        if (
          node.localName === 'script' &&
          /\/zp\/assets\/|\/zp\/api\/script|zeroproxy/i.test(
            node.src || node.getAttribute('src') || node.outerHTML || '',
          )
        )
          out.push(node.src || node.outerHTML);
      }
      return out;
    })(),
    treeWalkerArtifacts: (() => {
      const out = [];
      const tw = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = tw.nextNode())) {
        if (
          node.localName === 'script' &&
          /\/zp\/assets\/|\/zp\/api\/script|zeroproxy/i.test(
            node.src || node.getAttribute('src') || node.outerHTML || '',
          )
        )
          out.push(node.src || node.outerHTML);
      }
      return out;
    })(),
    serializedLeaks: (() => {
      const html = document.documentElement.outerHTML;
      const out = [];
      const re =
        /__ZP_BOOT|runtimeToken|data-zp-[\w-]*|\/zp\/assets\/|\/zp\/api\/script|zeroproxy/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 12)
        out.push(html.slice(Math.max(0, m.index - 80), Math.min(html.length, m.index + 120)));
      return out;
    })(),
    ownKeys: Reflect.ownKeys(window)
      .map((k) => (typeof k === 'symbol' ? k.toString() : String(k)))
      .filter((k) =>
        /^ZP$|ZPRewriter|ZPRustRewriter|ZPHTTPRewriter|__zp_|__ZP_|zeroproxy/i.test(k),
      ),
    propertyNames: Object.getOwnPropertyNames(window).filter((k) =>
      /^ZP$|ZPRewriter|ZPRustRewriter|ZPHTTPRewriter|__zp_|__ZP_/i.test(k),
    ),
    propertySymbols: Object.getOwnPropertySymbols(window)
      .map(String)
      .filter((k) => /zeroproxy/i.test(k)),
    descriptors: Reflect.ownKeys(Object.getOwnPropertyDescriptors(window))
      .map((k) => (typeof k === 'symbol' ? k.toString() : String(k)))
      .filter((k) =>
        /^ZP$|ZPRewriter|ZPRustRewriter|ZPHTTPRewriter|__zp_|__ZP_|zeroproxy/i.test(k),
      ),
    directDescriptorLeaks: [
      'ZP',
      'ZPRewriter',
      'ZPRustRewriter',
      'ZPHTTPRewriter',
      '__ZP_BOOT',
      '__ZP_SET_BASE',
      '__zp_get',
      '__zp_set',
      '__zp_call',
      '__zp_ownKeys',
    ].filter((k) => Object.getOwnPropertyDescriptor(window, k)),
    performanceArtifacts: performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((name) =>
        /\/zp\/assets\/|\/zp\/kernel\.wasm|\/zp\/api\/script|zeroproxy/i.test(name),
      ),
  }));
  assert.equal(bootLeak.bootType, 'undefined');
  assert.equal(bootLeak.scriptContainsRuntimeToken, false);
  assert.equal(bootLeak.selectorArtifacts, 0, JSON.stringify(bootLeak));
  assert.deepEqual(bootLeak.scriptArtifacts, []);
  assert.deepEqual(bootLeak.tagArtifacts, []);
  assert.deepEqual(bootLeak.iteratorArtifacts, []);
  assert.deepEqual(bootLeak.treeWalkerArtifacts, []);
  assert.deepEqual(bootLeak.serializedLeaks, []);
  assert.deepEqual(bootLeak.ownKeys, []);
  assert.deepEqual(bootLeak.propertyNames, []);
  assert.deepEqual(bootLeak.propertySymbols, []);
  assert.deepEqual(bootLeak.descriptors, []);
  assert.deepEqual(bootLeak.directDescriptorLeaks, []);
  assert.deepEqual(bootLeak.performanceArtifacts, []);

  async function submitFormFixture(kind) {
    await page.evaluate((kind) => {
      const f = document.createElement('form');
      f.method = 'POST';
      f.enctype =
        kind === 'multipart'
          ? 'multipart/form-data'
          : kind === 'plain'
            ? 'text/plain'
            : 'application/x-www-form-urlencoded';
      f.action = '/form-echo?kind=wrong';
      const input = document.createElement('input');
      input.name = 'alpha';
      input.value = 'one';
      f.appendChild(input);
      if (kind === 'multipart') {
        const file = document.createElement('input');
        file.type = 'file';
        file.name = 'upload';
        const dt = new DataTransfer();
        dt.items.add(new File(['file-body'], 'hello.txt', { type: 'text/plain' }));
        file.files = dt.files;
        f.appendChild(file);
      }
      const button = document.createElement('button');
      button.type = 'submit';
      button.name = 'submitter';
      button.value = kind;
      button.setAttribute('formaction', `/form-echo?kind=${kind}`);
      f.appendChild(button);
      document.body.appendChild(f);
      f.requestSubmit(button);
    }, kind);
    await waitForPage(page, (k) => window.__formEcho && window.__formEcho.kind === k, [kind]);
    return page.evaluate(() => {
      const loc = __zp_get(globalThis, 'location');
      return {
        echo: window.__formEcho,
        virtualHref: loc.href,
        virtualHash: loc.hash,
        documentURL: __zp_get(document, 'URL'),
        baseURI: __zp_get(document, 'baseURI'),
      };
    });
  }
  const urlencodedForm = await submitFormFixture('urlencoded');
  assert.equal(urlencodedForm.echo.method, 'POST');
  assert.match(urlencodedForm.echo.contentType, /^application\/x-www-form-urlencoded/);
  assert.equal(urlencodedForm.echo.body, 'alpha=one&submitter=urlencoded');
  const plainForm = await submitFormFixture('plain');
  assert.match(plainForm.echo.contentType, /^text\/plain/);
  assert.match(plainForm.echo.body, /alpha=one/);
  assert.match(plainForm.echo.body, /submitter=plain/);
  const multipartForm = await submitFormFixture('multipart');
  assert.match(multipartForm.echo.contentType, /^multipart\/form-data; boundary=/);
  assert.match(multipartForm.echo.body, /name="upload"; filename="hello.txt"/);
  assert.match(multipartForm.echo.body, /file-body/);
  const preventedForm = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const before = location.href;
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = '/form-echo?kind=prevented';
        const input = document.createElement('input');
        input.name = 'alpha';
        input.value = 'blocked';
        f.appendChild(input);
        const button = document.createElement('button');
        button.type = 'submit';
        f.appendChild(button);
        f.addEventListener('submit', (ev) => ev.preventDefault());
        document.body.appendChild(f);
        f.requestSubmit(button);
        setTimeout(() => resolve({ before, after: location.href }), 100);
      }),
  );
  assert.equal(preventedForm.after, preventedForm.before);
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = '/form-echo?kind=script-post-wrong';
    const input = document.createElement('input');
    input.name = 'alpha';
    input.value = 'one';
    f.appendChild(input);
    const button = document.createElement('button');
    button.type = 'submit';
    button.name = 'submitter';
    button.value = 'script-post';
    f.appendChild(button);
    f.addEventListener('submit', () => {
      f.action = '/form-echo?kind=script-post';
      input.value = 'two';
    });
    document.body.appendChild(f);
    f.requestSubmit(button);
  });
  await waitForPage(page, () => window.__formEcho && window.__formEcho.kind === 'script-post');
  const scriptPostForm = await page.evaluate(() => window.__formEcho);
  assert.equal(scriptPostForm.method, 'POST');
  assert.equal(scriptPostForm.body, 'alpha=two&submitter=script-post');
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = '/form-echo?kind=formdata';
    const input = document.createElement('input');
    input.name = 'alpha';
    input.value = 'one';
    f.appendChild(input);
    const button = document.createElement('button');
    button.type = 'submit';
    button.name = 'submitter';
    button.value = 'formdata';
    f.appendChild(button);
    f.addEventListener('formdata', (ev) => {
      ev.formData.set('alpha', 'from-formdata');
      ev.formData.append('beta', 'two');
    });
    document.body.appendChild(f);
    f.requestSubmit(button);
  });
  await waitForPage(page, () => window.__formEcho && window.__formEcho.kind === 'formdata');
  const formdataForm = await page.evaluate(() => window.__formEcho);
  assert.equal(formdataForm.body, 'alpha=from-formdata&submitter=formdata&beta=two');
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = '/form-echo?kind=form-submit';
    const input = document.createElement('input');
    input.name = 'alpha';
    input.value = 'one';
    f.appendChild(input);
    f.addEventListener('submit', () => {
      const marker = document.createElement('input');
      marker.name = 'submitEvent';
      marker.value = 'fired';
      f.appendChild(marker);
    });
    f.addEventListener('formdata', (ev) => {
      ev.formData.append('formdata', 'yes');
    });
    document.body.appendChild(f);
    f.submit();
  });
  await waitForPage(page, () => window.__formEcho && window.__formEcho.kind === 'form-submit');
  const formSubmitForm = await page.evaluate(() => window.__formEcho);
  assert.equal(formSubmitForm.body, 'alpha=one&formdata=yes');
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'GET';
    f.action = '/form-echo';
    for (const [name, value] of [
      ['kind', 'get-native'],
      ['alpha', 'one'],
    ]) {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      f.appendChild(input);
    }
    const button = document.createElement('button');
    button.type = 'submit';
    button.name = 'submitter';
    button.value = 'get-native';
    f.appendChild(button);
    document.body.appendChild(f);
    f.requestSubmit(button);
  });
  await waitForPage(page, () => window.__formEcho && window.__formEcho.kind === 'get-native');
  const getForm = await page.evaluate(() => window.__formEcho);
  assert.equal(getForm.method, 'GET');
  assert.equal(getForm.body, '');
  const rawAfterSubmit = page.url();
  const rawKey = new URL(rawAfterSubmit).hash
    ? new URLSearchParams(new URL(rawAfterSubmit).hash.slice(1)).get('k')
    : '';
  assert.match(rawAfterSubmit, /#k=/);
  assert.equal(rawAfterSubmit.includes('zp_submit='), false);
  for (const surface of [
    multipartForm.virtualHref,
    multipartForm.virtualHash,
    multipartForm.documentURL,
    multipartForm.baseURI,
  ]) {
    assert.equal(surface.includes('zp_submit='), false, surface);
    if (rawKey) assert.equal(surface.includes(rawKey), false, surface);
  }
  assert.ok(
    requests.some(
      (r) =>
        r.url.startsWith('/form-echo?kind=urlencoded') &&
        r.contentType.startsWith('application/x-www-form-urlencoded'),
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) => r.url.startsWith('/form-echo?kind=plain') && r.contentType.startsWith('text/plain'),
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) =>
        r.url.startsWith('/form-echo?kind=multipart') &&
        r.contentType.startsWith('multipart/form-data'),
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some(
      (r) =>
        r.url.startsWith('/form-echo?kind=script-post') &&
        r.contentType.startsWith('application/x-www-form-urlencoded'),
    ),
    `target requests: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    requests.some((r) => r.url === '/form-echo?kind=get-native&alpha=one&submitter=get-native'),
    `target requests: ${JSON.stringify(requests)}`,
  );
  await page.click('#next');
  await waitForPage(page, () => document.title === 'E2E Next');
  const next = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    title: document.title,
    shellVisible: Boolean(document.querySelector('#open')),
    userAgent: navigator.userAgent,
  }));
  assert.equal(next.title, 'E2E Next');
  assert.match(next.hash, /^#k=/);
  assert.equal(next.shellVisible, false);
  assert.equal(next.userAgent, TARGET_UA);
  assert.match(next.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  assert.ok(
    requests.some((r) => r.url === '/next' && r.userAgent === TARGET_UA),
    `target requests: ${JSON.stringify(requests)}`,
  );

  const readDifferential = (p) => p.evaluate(() => window.__differential);
  const readFingerprintReport = (p) =>
    p.evaluate(() =>
      JSON.parse(document.querySelector('#fingerprint-report')?.textContent || '{}'),
    );
  const comparableDifferential = (value) => ({
    locationHref: value.locationHref,
    locationOrigin: value.locationOrigin,
    functionHref: value.functionHref,
    evalOrigin: value.evalOrigin,
    stringTimerOrigin: value.stringTimerOrigin,
    stringIntervalOrigin: value.stringIntervalOrigin,
    dynamicImport: value.dynamicImport,
    eventSource: value.eventSource,
    policyHeaders: normalizePolicyHeaders(value.policyHeaders),
    redirect: value.redirect,
    post: value.post,
    xhr: value.xhr,
    ws: value.ws,
    surface: normalizeSurface(value.surface),
  });
  // Use in-page navigation for the second shell flow. Under load Chromium can
  // starve Puppeteer's same-tab page.goto/page.close command until the test-level
  // timeout, even though the page has reached the asserted title state.
  await page.evaluate((url) => {
    location.href = url;
  }, `http://proxy.localhost:${proxyPort}/`);
  await waitForPage(
    page,
    () =>
      navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      document.querySelector('#status')?.textContent === 'Ready.',
  );
  await page.type('#url', `http://${targetHost}:${targetPort}/differential-fixture`);
  await page.click('button');
  await waitForPage(
    page,
    () => document.title === 'Differential Fixture' && window.__differential,
  ).catch((err) => {
    throw new Error(`${err.message}\npage events:\n${pageEvents.slice(-20).join('\n')}`);
  });
  const proxyRawDiff = await readDifferential(page);
  const proxyDiff = comparableDifferential(proxyRawDiff);
  assert.deepEqual(await readFingerprintReport(page), proxyRawDiff.surface.fingerprint);
  assert.deepEqual(
    await page.evaluate(() => {
      const out = {};
      for (const name of ['setTimeout', 'setInterval']) {
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        Object.defineProperty(window, name, {
          value: descriptor.value,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          writable: descriptor.writable,
        });
        out[name] = Object.getOwnPropertyDescriptor(window, name).configurable;
      }
      return out;
    }),
    { setTimeout: true, setInterval: true },
  );
  assert.equal(proxyDiff.surface.workerRealm.imported.loaded, true);
  assert.ok(
    requests.some((r) => r.url === '/worker-imported-fixture.js' && r.userAgent === TARGET_UA),
    `worker importScripts request missing: ${JSON.stringify(requests)}`,
  );
  const abortMatrix = await page.evaluate(async () => {
    function withDeadline(promise, label, ms = 5000) {
      return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve({ timeout: label }), ms)),
      ]);
    }
    async function fetchAbortBeforeHeaders() {
      const controller = new AbortController();
      const pending = fetch(`/slow-headers?fetch=abort-before-headers&ts=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      }).then(
        () => 'resolved',
        (err) => (err && err.name) || 'Error',
      );
      setTimeout(() => controller.abort(), 50);
      return pending;
    }
    async function fetchAbortDuringDownload() {
      const controller = new AbortController();
      const resp = await fetch(`/slow-body?fetch=abort-download&ts=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const first = await reader.read();
      controller.abort();
      const second = await reader.read().then(
        () => 'resolved',
        (err) => (err && err.name) || 'Error',
      );
      return {
        status: resp.status,
        firstText: first.value ? decoder.decode(first.value) : '',
        second,
      };
    }
    async function fetchAbortDuringUpload() {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let produced = 0;
      let timer = 0;
      const stream = new ReadableStream({
        start(ctrl) {
          timer = setInterval(() => {
            produced++;
            ctrl.enqueue(encoder.encode(`upload-${produced}\n`));
            if (produced > 100) {
              clearInterval(timer);
              ctrl.close();
            }
          }, 25);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      const pending = fetch(`/slow-upload?fetch=abort-upload&ts=${Date.now()}`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'text/plain' },
      }).then(
        () => 'resolved',
        (err) => (err && err.name) || 'Error',
      );
      setTimeout(() => controller.abort(), 140);
      return { result: await pending, produced };
    }
    function xhrEventProbe(path, configure) {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        const events = [];
        const mark = (name) =>
          events.push(`${name}:${xhr.readyState}:${xhr.status}:${(xhr.responseText || '').length}`);
        xhr.onreadystatechange = () => mark('readystatechange');
        xhr.onloadstart = () => mark('loadstart');
        xhr.onprogress = (ev) =>
          events.push(`progress:${xhr.readyState}:${ev.loaded}:${ev.lengthComputable}`);
        xhr.onload = () => mark('load');
        xhr.onerror = () => mark('error');
        xhr.ontimeout = () => mark('timeout');
        xhr.onabort = () => mark('abort');
        xhr.onloadend = () => {
          mark('loadend');
          resolve({
            status: xhr.status,
            readyState: xhr.readyState,
            text: xhr.responseText || '',
            events,
          });
        };
        xhr.open('GET', path);
        if (configure) configure(xhr);
        xhr.send();
      });
    }
    return {
      abortBeforeHeaders: await withDeadline(
        fetchAbortBeforeHeaders(),
        'fetch-abort-before-headers',
      ),
      abortDuringDownload: await withDeadline(fetchAbortDuringDownload(), 'fetch-abort-download'),
      xhrTimeout: await withDeadline(
        xhrEventProbe(`/slow-headers?xhr=timeout&ts=${Date.now()}`, (xhr) => {
          xhr.timeout = 50;
        }),
        'xhr-timeout',
      ),
      xhrAbort: await withDeadline(
        xhrEventProbe(`/slow-headers?xhr=abort&ts=${Date.now()}`, (xhr) => {
          setTimeout(() => xhr.abort(), 50);
        }),
        'xhr-abort',
      ),
      abortDuringUpload: await withDeadline(fetchAbortDuringUpload(), 'fetch-abort-upload'),
    };
  });
  assert.equal(abortMatrix.abortBeforeHeaders, 'AbortError');
  assert.deepEqual(abortMatrix.abortDuringDownload, {
    status: 200,
    firstText: 'body-one\n',
    second: 'AbortError',
  });
  assert.equal(abortMatrix.abortDuringUpload.result, 'AbortError');
  assert.ok(
    abortMatrix.abortDuringUpload.produced > 0,
    `upload stream did not start: ${JSON.stringify(abortMatrix.abortDuringUpload)}`,
  );
  assert.equal(abortMatrix.xhrTimeout.status, 0);
  assert.ok(
    abortMatrix.xhrTimeout.events.some((e) => e.startsWith('timeout:4:0:')),
    `XHR timeout missing: ${JSON.stringify(abortMatrix.xhrTimeout.events)}`,
  );
  assert.ok(
    abortMatrix.xhrTimeout.events.at(-1).startsWith('loadend:4:0:'),
    `XHR timeout loadend order wrong: ${JSON.stringify(abortMatrix.xhrTimeout.events)}`,
  );
  assert.equal(abortMatrix.xhrAbort.status, 0);
  assert.ok(
    abortMatrix.xhrAbort.events.some((e) => e.startsWith('abort:4:0:')),
    `XHR abort missing: ${JSON.stringify(abortMatrix.xhrAbort.events)}`,
  );
  assert.ok(
    abortMatrix.xhrAbort.events.at(-1).startsWith('loadend:4:0:'),
    `XHR abort loadend order wrong: ${JSON.stringify(abortMatrix.xhrAbort.events)}`,
  );
  await page.goto(`http://${targetHost}:${targetPort}/differential-fixture`, {
    waitUntil: 'domcontentloaded',
  });
  await waitForPage(page, () => window.__differential);
  const nativeRawDiff = await readDifferential(page);
  const nativeDiff = comparableDifferential(nativeRawDiff);
  assert.deepEqual(await readFingerprintReport(page), nativeRawDiff.surface.fingerprint);
  const rawSetDelta = diffObjectsSetAware(proxyRawDiff, nativeRawDiff);
  const comparableDelta = diffObjects(proxyDiff, nativeDiff);
  if (process.env.ZP_WRITE_SET_DELTA) {
    const deltaPath = path.resolve(process.env.ZP_WRITE_SET_DELTA);
    fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
    fs.writeFileSync(
      deltaPath,
      JSON.stringify(
        sortObjectKeys({
          generatedAt: new Date().toISOString(),
          nativeUrl: `http://${targetHost}:${targetPort}/differential-fixture`,
          proxyUrl: `http://proxy.localhost:${proxyPort}/`,
          nativeVsZeroProxyRawSetDifferential: rawSetDelta,
          nativeVsZeroProxyComparableDifferential: comparableDelta,
        }),
        null,
        2,
      ),
    );
  }
  assertExpectedRawSetDeltas(
    rawSetDelta,
    EXPECTED_DELTAS.nativeVsZeroProxyRawSetDifferentialAllowlist,
  );
  assert.deepEqual(comparableDelta, EXPECTED_DELTAS.nativeVsZeroProxyDifferential);
});

function normalizePolicyHeaders(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    csp: normalizePolicyHeader(value.csp),
  };
}

function normalizeSurface(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    frameDocument: normalizeFrameDocument(value.frameDocument),
    frameSrcdoc: normalizeFrameDocument(value.frameSrcdoc),
    fingerprint: normalizeFingerprintSurface(value.fingerprint),
  };
}

function normalizeFrameDocument(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    origin: normalizeFrameOrigin(value.origin),
    href: normalizeFrameURL(value.href),
    topOrigin: normalizeFrameOrigin(value.topOrigin),
    timeout: normalizeFrameValue(value.timeout),
    sourceIsFrame: normalizeFrameValue(value.sourceIsFrame),
    functionHref: normalizeFrameURL(value.functionHref, value.href),
    contentWindowParentIsWindow: normalizeFrameValue(value.contentWindowParentIsWindow),
    contentWindowTopIsWindow: normalizeFrameValue(value.contentWindowTopIsWindow),
    contentDocumentDefaultView: normalizeFrameValue(value.contentDocumentDefaultView),
    frameSrc: normalizeFrameURL(value.frameSrc, value.href),
    contentWindowHref: normalizeFrameURL(value.contentWindowHref, value.href),
    contentDocumentURL: normalizeFrameURL(value.contentDocumentURL, value.href),
  };
}

function normalizeFingerprintSurface(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    screen: value.screen && {
      ...value.screen,
      width: normalizePositiveNumber(value.screen.width),
      height: normalizePositiveNumber(value.screen.height),
      availWidth: normalizePositiveNumber(value.screen.availWidth),
      availHeight: normalizePositiveNumber(value.screen.availHeight),
      devicePixelRatio: normalizePositiveNumber(value.screen.devicePixelRatio),
    },
    canvas: value.canvas && {
      ...value.canvas,
      stableRead: '<canvas-randomized>',
      prefix: '<canvas-data-url>',
      length: '<canvas-data-url-length>',
    },
    webgl: value.webgl && {
      ...value.webgl,
      vendor: normalizeNonEmptyString(value.webgl.vendor),
      renderer: normalizeNonEmptyString(value.webgl.renderer),
      debugVendor: normalizeOptionalString(value.webgl.debugVendor),
      debugRenderer: normalizeOptionalString(value.webgl.debugRenderer),
      extensionCount: normalizePositiveNumber(value.webgl.extensionCount),
    },
    domRect: value.domRect && {
      ...value.domRect,
      x: normalizeFiniteNumber(value.domRect.x),
      y: normalizeFiniteNumber(value.domRect.y),
      width: normalizeFiniteNumber(value.domRect.width),
      height: normalizeFiniteNumber(value.domRect.height),
    },
    objectPropertyCollection: normalizeObjectPropertyCollection(value.objectPropertyCollection),
  };
}

function normalizeObjectPropertyCollection(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.e) {
    return {
      ok: false,
      error: value.e.name || String(value.e),
    };
  }
  const paths = [];
  for (const entries of Object.values(value.r || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) paths.push(String(entry));
  }
  const hasPath = (path) => paths.includes(path);
  return {
    ok: true,
    bucketCount: normalizePositiveNumber(Object.keys(value.r || {}).length),
    pathCount: normalizePositiveNumber(paths.length),
    probes: {
      window: hasPath('window') || hasPath('self') || hasPath('globalThis'),
      navigator: hasPath('n.userAgent') && hasPath('n.platform'),
      document: paths.some((path) => path.startsWith('d.')),
      nativeFunctionBucket: Object.prototype.hasOwnProperty.call(value.r || {}, 'N'),
    },
  };
}

function normalizePositiveNumber(value) {
  return typeof value === 'number' && value > 0 ? '<positive-number>' : value;
}

function normalizeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? '<finite-number>' : value;
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? '<non-empty-string>' : value;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? '<non-empty-string>' : value;
}

function normalizeFrameURL(value, targetHref) {
  if (value === undefined) return '<missing>';
  const href = String(value || '');
  if (href === 'about:srcdoc') return '<srcdoc-url>';
  if (/^http:\/\/proxy\.localhost:\d+\/zp\/p\//.test(href)) return '<zeroproxy-frame-route>';
  if (/^http:\/\/localhost:\d+\/differential-fixture(?:[?#].*)?$/.test(href))
    return '<target-document-url>';
  if (targetHref && href === targetHref) return '<target-frame-url>';
  return href;
}

function normalizeFrameOrigin(value) {
  if (value === undefined) return '<missing>';
  const origin = String(value || '');
  if (/^http:\/\/localhost:\d+$/.test(origin)) return '<target-origin>';
  if (/^http:\/\/proxy\.localhost:\d+$/.test(origin)) return '<proxy-origin>';
  return origin;
}

function normalizeFrameValue(value) {
  return value === undefined ? '<missing>' : value;
}

function normalizePolicyHeader(value) {
  const csp = String(value || '');
  if (
    csp.includes("default-src 'none'") &&
    csp.includes("script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'") &&
    /connect-src 'self' ws:\/\/proxy\.localhost:\d+/.test(csp)
  ) {
    return '<zeroproxy-membrane-csp>';
  }
  return csp;
}

function summarizeFrameRelation(value, cookieValue) {
  const data = (value && value.data) || {};
  return {
    eventOrigin: value && value.eventOrigin,
    sourceIsFrame: value && value.sourceIsFrame,
    href: normalizeRelationURL(data.href),
    origin: data.origin,
    cookieShared: String(data.cookie || '').includes(`frame_cookie=${cookieValue}`),
    local: data.local,
    session: data.session,
  };
}

function normalizeRelationURL(value) {
  if (!value) return '';
  const url = new URL(String(value));
  url.searchParams.set('key', '<key>');
  return url.href;
}

function diffObjects(proxyValue, nativeValue, prefix = '') {
  if (Object.is(proxyValue, nativeValue)) return {};
  if (Array.isArray(proxyValue) && Array.isArray(nativeValue)) {
    const out = {};
    const length = Math.max(proxyValue.length, nativeValue.length);
    for (let i = 0; i < length; i++) {
      Object.assign(out, diffObjects(proxyValue[i], nativeValue[i], `${prefix}[${i}]`));
    }
    return out;
  }
  if (!isPlainObject(proxyValue) || !isPlainObject(nativeValue)) {
    return { [prefix || '<root>']: { proxy: proxyValue, native: nativeValue } };
  }
  const out = {};
  for (const key of Array.from(
    new Set([...Object.keys(proxyValue), ...Object.keys(nativeValue)]),
  )) {
    Object.assign(
      out,
      diffObjects(proxyValue[key], nativeValue[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diffObjectsSetAware(proxyValue, nativeValue, prefix = '') {
  if (Object.is(proxyValue, nativeValue)) return {};
  if (Array.isArray(proxyValue) && Array.isArray(nativeValue)) {
    return diffArrayAsSet(proxyValue, nativeValue, prefix);
  }
  if (!isPlainObject(proxyValue) || !isPlainObject(nativeValue)) {
    return { [prefix || '<root>']: { proxy: proxyValue, native: nativeValue } };
  }
  const out = {};
  for (const key of Array.from(
    new Set([...Object.keys(proxyValue), ...Object.keys(nativeValue)]),
  )) {
    Object.assign(
      out,
      diffObjectsSetAware(proxyValue[key], nativeValue[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return out;
}

function assertExpectedRawSetDeltas(rawSetDelta, allowlist) {
  assert.ok(Array.isArray(allowlist) && allowlist.length > 0, 'raw Set delta allowlist missing');
  const unmatched = [];
  for (const key of Object.keys(rawSetDelta || {}).sort()) {
    const match = allowlist.find((entry) => {
      assert.equal(typeof entry.id, 'string', 'raw Set delta allowlist entry id missing');
      assert.equal(typeof entry.reason, 'string', `raw Set delta reason missing: ${entry.id}`);
      assert.equal(typeof entry.pattern, 'string', `raw Set delta pattern missing: ${entry.id}`);
      return new RegExp(entry.pattern).test(key);
    });
    if (!match) unmatched.push(key);
  }
  assert.deepEqual(unmatched, [], 'unexpected native-vs-ZeroProxy raw Set deltas');
}

function diffArrayAsSet(proxyValue, nativeValue, prefix) {
  const proxyMap = indexedSet(proxyValue);
  const nativeMap = indexedSet(nativeValue);
  const onlyProxy = [];
  const onlyNative = [];
  for (const [key, value] of proxyMap) {
    if (!nativeMap.has(key)) onlyProxy.push(value);
  }
  for (const [key, value] of nativeMap) {
    if (!proxyMap.has(key)) onlyNative.push(value);
  }
  if (onlyProxy.length === 0 && onlyNative.length === 0) return {};
  return {
    [prefix || '<root>']: {
      proxyCount: proxyValue.length,
      nativeCount: nativeValue.length,
      commonCount: proxyValue.length - onlyProxy.length,
      onlyProxy: onlyProxy.sort(compareStableValues),
      onlyNative: onlyNative.sort(compareStableValues),
    },
  };
}

function indexedSet(values) {
  return new Map(values.map((value) => [stableValueKey(value), value]));
}

function stableValueKey(value) {
  return JSON.stringify(sortObjectKeys(value));
}

function compareStableValues(a, b) {
  return stableValueKey(a).localeCompare(stableValueKey(b));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortObjectKeys(value[key]);
  return out;
}

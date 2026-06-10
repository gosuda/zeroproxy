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

const JQUERY_SOURCE = fs.readFileSync(require.resolve('jquery'), 'utf8');

const {
  run,
  isBenignSocketError,
  ignoreBenignSocketErrors,
  listen,
  closeServer,
  waitForHTTP,
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
    if (url.pathname === '/phase5') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        Link: '</phase5-preload.png>; rel=preload; as=image',
      });
      res.end(`<!doctype html><html><head>
        <title>Phase 5</title>
        <link rel="preconnect" href="https://preconnect.invalid">
        <link rel="stylesheet" href="/phase5.css">
        <link rel="icon" href="/phase5-icon.png">
        <style>.inline-css{background:url('/phase5-inline-bg.png')}</style>
        <script>globalThis.__phase5Inline = true;</script>
        <script src="/phase5.js"></script>
        <script type="module" src="/phase5-module.js"></script>
      </head><body>
        <img src="/phase5-img.png" srcset="/phase5-img-small.png 1x, /phase5-img-large.png 2x" alt="">
        <noscript><div id="noscript-fallback">Phase 5 JavaScript disabled fallback</div></noscript>
        <a href="/phase5-next">next</a>
        <form action="/phase5-submit"><input name="q" value="phase5"><button name="submit" value="go" formaction="/phase5-button">go</button></form>
        <iframe src="/phase5-frame"></iframe>
      </body></html>`);
      return;
    }
    if (url.pathname === '/phase5-button') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body><main>phase5 button ${url.searchParams.get('q') || ''}</main></body></html>`,
      );
      return;
    }
    if (url.pathname === '/phase5.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(`.external-css{background:url('/phase5-bg.png')}`);
      return;
    }
    if (url.pathname === '/phase5.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(`globalThis.__phase5External = true;
        const lateStyle = document.createElement('style');
        lateStyle.type = 'text/css';
        lateStyle.appendChild(document.createTextNode('.phase5-late-style{color:red}'));
        document.body.appendChild(lateStyle);
        const dynamicImg = new Image();
        dynamicImg.alt = 'dynamic';
        dynamicImg.src = '/phase5-dynamic.png';
        dynamicImg.srcset = '/phase5-dynamic-small.png 1x, /phase5-dynamic-large.png 2x';
        document.body.appendChild(dynamicImg);
        const dynamicLink = document.createElement('link');
        dynamicLink.rel = 'stylesheet';
        dynamicLink.href = '/phase5-dynamic.css';
        document.head.appendChild(dynamicLink);
        const formInput = document.querySelector('input[name="q"]');
        const formEcho = document.createElement('span');
        formEcho.id = 'phase5-form-echo';
        document.body.appendChild(formEcho);
        formInput.addEventListener('input', (event) => { formEcho.textContent = 'echo:' + event.target.value; });`);
      return;
    }
    if (url.pathname === '/phase5-dynamic.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(`.phase5-dynamic-css{background:url('/phase5-dynamic-bg.png')}`);
      return;
    }
    if (url.pathname === '/phase5-module.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(`globalThis.__phase5Module = true; export const ok = true;`);
      return;
    }
    if (
      url.pathname.startsWith('/phase5-') &&
      (url.pathname.endsWith('.png') || url.pathname === '/phase5-frame')
    ) {
      res.writeHead(200, {
        'Content-Type': url.pathname.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
      });
      res.end(
        url.pathname.endsWith('.png')
          ? Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
              'base64',
            )
          : '<!doctype html><p>frame</p>',
      );
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
              .filter(k => /^ZP$|__zp_|__ZP_|zeroproxy/i.test(k));
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
          .filter(k => /^ZP$|__zp_|__ZP_|zeroproxy/i.test(k));
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

async function waitForShellReady(page, backendKind) {
  return waitForShellState(
    page,
    (state) => state.statusText === `Network backend ready (${backendKind}).`,
  );
}

async function waitForShareReady(page) {
  return waitForShellState(page, (state) =>
    Boolean(state.currentShare && state.href.includes('/zp/p/')),
  );
}

async function waitForVirtualDocumentReady(page) {
  return waitForShellState(page, (state) =>
    Boolean(state.currentShare?.document && state.statusText.startsWith('Virtual document ready')),
  );
}

async function waitForShellState(page, accept, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let state = {};
  while (Date.now() < deadline) {
    state = await shellState(page);
    if (accept(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for shell state: ${JSON.stringify(state)}`);
}

async function shellState(page) {
  return page.evaluate(async () => ({
    href: location.href,
    statusText: document.querySelector('#status')?.textContent || '',
    serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
    serviceWorkerRegistrations: navigator.serviceWorker?.getRegistrations
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
    hostShell: typeof window.__ZP_HOST_SHELL?.initTransport,
    hostShellScript: Array.from(document.scripts).some((script) =>
      script.src.endsWith('/zp/assets/host-shell.js'),
    ),
    quickJSReady: Boolean(window.__ZP_QUICKJS_READY),
    quickJSProbe: window.__ZP_QUICKJS_READY?.probe,
    quickJSVersion: window.__ZP_QUICKJS_READY?.version || '',
    currentShare: window.__ZP_CURRENT_SHARE || null,
    virtualDocument: window.__ZP_VIRTUAL_DOCUMENT || null,
    renderText: document.querySelector('#zp-render-root')?.textContent || '',
    renderedResourceUrls: Array.from(
      document.querySelectorAll(
        '#zp-render-root [src], #zp-render-root [poster], #zp-render-root [href]',
      ),
    ).flatMap((node) =>
      ['src', 'poster', 'href'].map((name) => node.getAttribute(name)).filter(Boolean),
    ),
    rendererStyleTexts: Array.from(document.querySelectorAll('style[data-zp-style-id]')).map(
      (node) => node.textContent || '',
    ),
  }));
}

async function waitForTargetPaths(requests, expectedPaths, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertTargetPaths(requests, expectedPaths);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('timed out waiting for target paths');
}

function assertTargetPaths(requests, expectedPaths) {
  const paths = new Set(
    requests.map((request) => new URL(request.url, 'http://target.local').pathname),
  );
  for (const pathName of expectedPaths) {
    assert.ok(
      paths.has(pathName),
      `missing backend target fetch for ${pathName}; got ${JSON.stringify([...paths])}`,
    );
  }
  for (const blockedPath of ['/phase5-preload.png', '/phase5-icon.png', '/phase5-frame']) {
    assert.equal(
      paths.has(blockedPath),
      false,
      `blocked/virtual resource was fetched: ${blockedPath}`,
    );
  }
}

function assertNoTargetBrowserRequests(requests, targetPort) {
  const targetOrigin = `http://localhost:${targetPort}`;
  const leaked = requests.filter((requestURL) => requestURL.startsWith(targetOrigin));
  assert.deepEqual(
    leaked,
    [],
    `native browser target-origin requests leaked: ${JSON.stringify(leaked)}`,
  );
}

test('host shell boots without service worker and initializes GoNetworkBackend', {
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

  const proxyPort = await freePort();
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

  const targetURL = `http://localhost:${targetPort}/phase5`;
  const page = await browser.newPage();
  const nativeRequests = [];
  page.on('request', (request) => nativeRequests.push(request.url()));
  await page.goto(`http://proxy.localhost:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
  const workerState = await waitForShellReady(page, 'worker');
  assert.equal(workerState.statusText, 'Network backend ready (worker).');
  assert.equal(workerState.serviceWorkerController, false);
  assert.equal(workerState.serviceWorkerRegistrations, 0);
  assert.equal(workerState.hostShell, 'function');
  assert.equal(workerState.hostShellScript, true);
  assert.equal(workerState.quickJSReady, true);
  assert.equal(workerState.quickJSProbe, 42);
  assert.match(workerState.quickJSVersion, /^0\.15\./);

  await page.type('#url', targetURL);
  await page.click('button');
  const shareState = await waitForVirtualDocumentReady(page);
  assert.match(shareState.href, /^http:\/\/proxy\.localhost:\d+\/zp\/p\//);
  assert.equal(shareState.currentShare.targetUrl, targetURL);
  assert.equal(shareState.serviceWorkerController, false);
  assert.equal(shareState.virtualDocument.targetUrl, targetURL);
  assert.ok(shareState.virtualDocument.recordTypes.includes('script.inline'));
  assert.ok(shareState.virtualDocument.recordTypes.includes('script.external'));
  assert.ok(shareState.virtualDocument.recordTypes.includes('module.external'));
  assert.ok(shareState.virtualDocument.recordTypes.includes('resource.blob.ready'));
  assert.ok(shareState.virtualDocument.executedScripts.length >= 3);
  await waitForTargetPaths(
    requests,
    [
      '/phase5',
      '/phase5.css',
      '/phase5.js',
      '/phase5-module.js',
      '/phase5-img.png',
      '/phase5-img-small.png',
      '/phase5-img-large.png',
      '/phase5-inline-bg.png',
      '/phase5-bg.png',
      '/phase5-dynamic.png',
      '/phase5-dynamic-small.png',
      '/phase5-dynamic-large.png',
      '/phase5-dynamic.css',
      '/phase5-dynamic-bg.png',
    ],
    15000,
  );
  assert.match(shareState.renderText, /next/);
  assert.match(
    await page.$eval('#zp-render-root a[href]', (anchor) => anchor.getAttribute('href')),
    /^about:blank#zp-nav-/,
  );
  assert.doesNotMatch(shareState.renderText, /JavaScript disabled fallback/);
  assert.doesNotMatch(shareState.renderText, /phase5-late-style/);
  assert.ok(
    shareState.renderedResourceUrls.some((url) => url.startsWith('blob:')),
    `expected at least one renderer blob URL, got ${JSON.stringify(shareState.renderedResourceUrls)}`,
  );
  assert.ok(shareState.rendererStyleTexts.some((text) => text.includes('.phase5-dynamic-css')));
  assert.ok(shareState.rendererStyleTexts.some((text) => text.includes('.phase5-late-style')));
  assert.ok(
    shareState.rendererStyleTexts.every((text) => !text.includes('zp-internal://resource/')),
    `renderer style leaked internal URL text: ${JSON.stringify(shareState.rendererStyleTexts)}`,
  );
  assert.ok(
    nativeRequests.every((url) => !url.startsWith('zp-internal://resource/')),
    `renderer leaked internal resource URLs: ${nativeRequests.filter((url) => url.startsWith('zp-internal://resource/')).join(', ')}`,
  );

  await page.evaluate(() => {
    const input = document.querySelector('#zp-render-root form input[name="q"]');
    input.value = 'phase5-native';
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() =>
    document.querySelector('#zp-render-root')?.textContent.includes('echo:phase5-native'),
  );
  assertNoTargetBrowserRequests(nativeRequests, targetPort);

  await page.click('#zp-render-root form button');
  const formState = await waitForVirtualDocumentReady(page);
  assert.equal(
    formState.virtualDocument.targetUrl,
    targetURL.replace('/phase5', '/phase5-button?q=phase5-native&submit=go'),
  );
  assertTargetPaths(requests, ['/phase5-button']);

  const fgPage = await browser.newPage();
  const foregroundNativeRequests = [];
  fgPage.on('request', (request) => foregroundNativeRequests.push(request.url()));
  const foregroundShareURL = await page.evaluate(async (target) => {
    const share = await ZP.encryptShareURL(target);
    return `${location.origin}${ZP.makeSharePath(share.encrypted)}${ZP.makeShareFragment(share.key, [])}&zp_backend=foreground`;
  }, targetURL);
  const beforeForegroundRequests = requests.length;
  await fgPage.goto(foregroundShareURL, { waitUntil: 'domcontentloaded' });
  const foregroundState = await waitForVirtualDocumentReady(fgPage);
  assert.equal(foregroundState.currentShare.backend, 'foreground');
  assert.equal(foregroundState.serviceWorkerController, false);
  assert.equal(foregroundState.quickJSReady, true);
  assert.equal(foregroundState.quickJSProbe, 42);
  assert.ok(requests.length > beforeForegroundRequests);
  assertNoTargetBrowserRequests(foregroundNativeRequests, targetPort);
});

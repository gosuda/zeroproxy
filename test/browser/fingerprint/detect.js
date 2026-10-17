// Probe DOM, storage, timing, CSS, and prototype surfaces that a target page
// can inspect to detect the proxy membrane.
(function () {
  const hits = [];
  const add = (where, what) => hits.push({ where, what: String(what).slice(0, 160) });
  const ZP = /(^|[^a-z])zp[^a-z]|zeroproxy|__zp/i;

  // Global property names on window.
  try {
    for (const k of Object.getOwnPropertyNames(window)) {
      if (/^__zp|^ZP$|zeroproxy/i.test(k)) add('window prop', k);
    }
  } catch (e) { add('window prop', 'err:' + e.name); }

  // Document outerHTML markup and proxy URLs.
  try {
    const html = document.documentElement.outerHTML;
    for (const m of html.match(/data-zp-[a-z-]+/gi) || []) add('outerHTML attr', m);
    for (const m of html.match(/[a-z-]*zeroproxy[a-z-]*/gi) || []) add('outerHTML text', m);
    if (/\/zp\/(assets|api)\//.test(html)) add('outerHTML url', (html.match(/\/zp\/(assets|api)\/[^"'\s]{0,40}/) || [])[0]);
  } catch (e) { add('outerHTML', 'err:' + e.name); }

  // Attribute enumeration via getAttributeNames() and element.attributes.
  try {
    const els = document.querySelectorAll('*');
    const seen = new Set();
    for (let i = 0; i < els.length && i < 400; i++) {
      const el = els[i];
      for (const n of el.getAttributeNames()) if (/^data-zp-/i.test(n) && !seen.has(n)) { seen.add(n); add('getAttributeNames', n); }
      for (const a of el.attributes) if (/^data-zp-/i.test(a.name) && !seen.has('A' + a.name)) { seen.add('A' + a.name); add('attributes[]', a.name); }
    }
  } catch (e) { add('attributes', 'err:' + e.name); }

  // Injected script tags in document.scripts.
  try {
    for (const s of document.scripts) {
      const src = s.src || '';
      if (/\/zp\/|zeroproxy|prelude|zp-core|zp_page/i.test(src)) add('document.scripts', src);
    }
  } catch (e) { add('scripts', 'err:' + e.name); }

  // Storage keys in localStorage and sessionStorage.
  try {
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (ZP.test(k)) add('localStorage', k); }
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (ZP.test(k)) add('sessionStorage', k); }
  } catch (e) { add('storage', 'err:' + e.name); }

  // Function.prototype.toString checks for proxy-specific identifiers.
  // Pages legitimately wrap their own globals (e.g., fetch), so only flag
  // non-native wrappers that leak proxy identifiers.
  try {
    const fns = [
      ['fetch', window.fetch], ['setAttribute', Element.prototype.setAttribute],
      ['getAttribute', Element.prototype.getAttribute], ['appendChild', Node.prototype.appendChild],
      ['createObjectURL', URL.createObjectURL], ['Worker', window.Worker],
    ];
    const OURS = /__zp|__ZP|ZeroProxy|ZPBundle|proxy\.localhost|\/zp\//;
    for (const [name, fn] of fns) {
      if (typeof fn !== 'function') continue;
      const s = Function.prototype.toString.call(fn);
      if (/\{\s*\[native code\]\s*\}/.test(s)) continue;
      if (OURS.test(s)) add('toString', name + ' => ' + s.slice(0, 60));
    }
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (d && d.get) {
      const g = Function.prototype.toString.call(d.get);
      if (!/\{\s*\[native code\]\s*\}/.test(g) && OURS.test(g)) add('toString', 'cookie getter');
    }
  } catch (e) { add('toString', 'err:' + e.name); }

  // Resource timing entry names.
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (/\/zp\/|zeroproxy|prelude|zp-core|zp_page|__zp/i.test(e.name)) add('resource timing', e.name);
    }
  } catch (e) { add('resource timing', 'err:' + e.name); }

  // Resource and navigation timing consistency with navigator.serviceWorker.controller.
  try {
    var es = performance.getEntriesByType('resource');
    var controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (!controlled && es.length) {
      var worker = 0, emptyProto = 0;
      for (var i = 0; i < es.length; i++) {
        if (es[i].workerStart > 0) worker++;
        if (es[i].nextHopProtocol === '') emptyProto++;
      }
      if (worker) add('timing', 'workerStart>0 on ' + worker + '/' + es.length + ' with no controller');
      if (emptyProto === es.length) add('timing', 'nextHopProtocol empty on all ' + es.length);
    }
    var nav = performance.getEntriesByType('navigation')[0];
    if (nav && !controlled) {
      if (nav.workerStart > 0) add('timing', 'navigation workerStart>0 with no controller');
      if (nav.deliveryType === 'cache' && !nav.transferSize && nav.encodedBodySize > 0) {
        add('timing', 'navigation claims cache but was not cached');
      }
    }
    // Synthetic service-worker responses report encodedBodySize == decodedBodySize
    // unless the upstream encoded size is forwarded.
    var sized = 0, compressed = 0;
    for (var j = 0; j < es.length; j++) {
      if (!es[j].decodedBodySize) continue;
      sized++;
      if (es[j].encodedBodySize < es[j].decodedBodySize) compressed++;
    }
    if (sized >= 20 && compressed === 0) {
      add('timing', 'no response compressed (' + sized + ' sized entries) — known open item');
    }
    if (nav && nav.decodedBodySize > 50000 && nav.encodedBodySize === nav.decodedBodySize) {
      add('timing', 'navigation body uncompressed — known open item (streaming path)');
    }
  } catch (e) { add('timing', 'err:' + e.name); }

  // Collection wrapper surface and method identity checks on NodeList, HTMLCollection, and NamedNodeMap.
  try {
    var hc = document.scripts;
    var nl = document.querySelectorAll('*');
    var nn = document.body && document.body.attributes;
    var pairs = [['document.scripts', hc], ['attributes', nn]];
    for (var pi = 0; pi < pairs.length; pi++) {
      var nm = pairs[pi][0], c = pairs[pi][1];
      if (!c) continue;
      var meth = ['forEach', 'values', 'keys', 'entries'];
      for (var mi = 0; mi < meth.length; mi++) {
        var k = meth[mi];
        if (typeof c[k] === 'function' && !(k in c)) add('collection', nm + '.' + k + ' exists but not `in`');
        else if (typeof c[k] === 'function') add('collection', nm + '.' + k + ' should be undefined');
      }
    }
    var iters = [['document.scripts', hc], ['querySelectorAll', nl], ['attributes', nn]];
    for (var ii = 0; ii < iters.length; ii++) {
      var inm = iters[ii][0], ic = iters[ii][1];
      if (!ic) continue;
      if (ic[Symbol.iterator] !== Array.prototype.values) add('collection', inm + ' @@iterator is not Array.prototype.values');
    }
    if (nl.forEach !== Array.prototype.forEach) add('collection', 'NodeList.forEach is not Array.prototype.forEach');
    if (nl.forEach !== nl.forEach) add('collection', 'NodeList.forEach identity unstable');
    if (hc.item !== hc.item) add('collection', 'HTMLCollection.item identity unstable');
    if (nn && nn.getNamedItem !== nn.getNamedItem) add('collection', 'NamedNodeMap.getNamedItem identity unstable');
    var named = hc['__zp-boot'] || (hc.namedItem && hc.namedItem('__zp-boot'));
    if (named) add('collection', 'named access returns a hidden node: ' + (named.id || named.src || '?'));
  } catch (e) { add('collection', 'err:' + e.name); }

  // Verify that `data-zp-*` attributes are hidden across all read, write, dataset, and Attr node surfaces.
  try {
    var ZPNAMES = ['data-zp-target-url', 'data-zp-internal', 'data-zp-blocked-ping', 'data-zp-blocked-rel'];
    var ZPN = ZPNAMES[0];
    var els = document.querySelectorAll('*');
    var probeEls = [];
    for (var pi = 0; pi < els.length && pi < 300; pi++) probeEls.push(els[pi]);
    probeEls.push(document.documentElement);
    var host = probeEls[0] || document.documentElement;
    var zpDatasetKey = function () { return ZPN.replace(/^data-/, '').replace(/-([a-z])/g, function (_, c2) { return c2.toUpperCase(); }); };
    var reads = [
      ['getAttribute', function () { return host.getAttribute(ZPN); }],
      ['hasAttribute', function () { return host.hasAttribute(ZPN) || null; }],
      ['getAttributeNS', function () { return host.getAttributeNS(null, ZPN); }],
      ['hasAttributeNS', function () { return host.hasAttributeNS(null, ZPN) || null; }],
      ['getAttributeNode', function () { return host.getAttributeNode(ZPN); }],
      ['getAttributeNodeNS', function () { return host.getAttributeNodeNS(null, ZPN); }],
      ['attributes[name]', function () { return host.attributes[ZPN]; }],
      ['attributes in', function () { return (ZPN in host.attributes) || null; }],
      ['attributes.getNamedItem', function () { return host.attributes.getNamedItem(ZPN); }],
      ['dataset', function () { var k = zpDatasetKey(); return (host.dataset && host.dataset[k]) || null; }],
      ['dataset in', function () { var k = zpDatasetKey(); return (host.dataset && (k in host.dataset)) || null; }],
      ['dataset keys', function () { var k = Object.keys(host.dataset || {}).filter(function (x) { return /^zp[A-Z]/.test(x); }); return k.length ? k.join(',') : null; }]
    ];
    for (var ri = 0; ri < reads.length; ri++) {
      var got = null;
      for (var hi = 0; hi < probeEls.length && !got; hi++) {
        host = probeEls[hi];
        for (var ni = 0; ni < ZPNAMES.length && !got; ni++) {
          ZPN = ZPNAMES[ni];
          try { got = reads[ri][1](); } catch (e) { got = null; }
        }
      }
      if (got) add('zp-namespace read', reads[ri][0] + ' -> ' + (got && got.value !== undefined ? got.value : got));
    }
    host = probeEls[0] || document.documentElement;
    // Setting `data-zp-internal` from page script must not hide the page's own node from querySelectorAll.
    var probe = document.createElement('div');
    probe.className = '__zpns';
    (document.body || document.documentElement).appendChild(probe);
    var writes = [
      ['setAttribute', function () { probe.setAttribute('data-zp-internal', '1'); }],
      ['setAttributeNS', function () { probe.setAttributeNS(null, 'data-zp-internal', '1'); }],
      ['toggleAttribute', function () { probe.toggleAttribute('data-zp-internal', true); }],
      ['dataset', function () { probe.dataset.zpInternal = '1'; }],
      ['setAttributeNode', function () { var a = document.createAttribute('data-zp-internal'); a.value = '1'; probe.setAttributeNode(a); }],
      ['setNamedItem', function () { var a = document.createAttribute('data-zp-internal'); a.value = '1'; probe.attributes.setNamedItem(a); }]
    ];
    for (var wi = 0; wi < writes.length; wi++) {
      try { writes[wi][1](); } catch (e) {}
      if (document.querySelectorAll('.__zpns').length === 0) add('zp-namespace write', writes[wi][0] + " hid the page's own node");
    }
    try { probe.remove(); } catch (e) {}
    if (host.attributes !== host.attributes) add('zp-namespace', 'el.attributes identity unstable');
    if (host.dataset !== host.dataset) add('zp-namespace', 'el.dataset identity unstable');
  } catch (e) { add('zp-namespace', 'err:' + e.name); }

  // Document baseURI and referrer checks.
  try {
    if (/proxy\.localhost|\/zp\/p\//.test(document.baseURI)) add('baseURI', document.baseURI);
    if (/proxy\.localhost|\/zp\/p\//.test(document.referrer)) add('referrer', document.referrer);
  } catch (e) { add('identity', 'err:' + e.name); }

  // CSS readback checks across inline styles, stylesheets, and getComputedStyle.
  try {
    var OURS = /\/zp\/(api|assets|p)\/|proxy\.localhost/;
    var say = function (where, v) { if (v && OURS.test(String(v))) add(where, String(v).match(OURS)[0]); };

    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length && i < 200; i++) {
      var e = styled[i];
      say('style attr', e.getAttribute('style'));
      say('style attrNS', e.getAttributeNS(null, 'style'));
      try { say('style attrNode', e.getAttributeNode('style').value); } catch (er) {}
      try { say('style attributes[]', e.attributes.style.value); } catch (er) {}
      say('style.cssText', e.style.cssText);
      for (var k = 0; k < e.style.length && k < 40; k++) {
        say('style.getPropertyValue', e.style.getPropertyValue(e.style[k]));
        try { say('style[prop]', e.style[e.style[k].replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })]); } catch (er) {}
      }
    }

    var sheets = document.styleSheets;
    for (var si = 0; si < sheets.length && si < 40; si++) {
      var rules = null;
      try { rules = sheets[si].cssRules; } catch (er) { continue; }
      for (var ri = 0; rules && ri < rules.length && ri < 300; ri++) {
        say('CSSRule.cssText', rules[ri].cssText);
        try { say('CSSRule.style.cssText', rules[ri].style.cssText); } catch (er) {}
      }
    }

    var probes = document.querySelectorAll('body, body *');
    for (var ci = 0; ci < probes.length && ci < 120; ci++) {
      var cs = null;
      try { cs = getComputedStyle(probes[ci]); } catch (er) { continue; }
      var props = ['background-image', 'border-image-source', 'list-style-image', 'mask-image', 'content', 'cursor', 'filter'];
      for (var pi = 0; pi < props.length; pi++) say('getComputedStyle', cs.getPropertyValue(props[pi]));
    }

    var rt = document.createElement('div');
    var mark = 'url("https://example.invalid/zp-roundtrip.png")';
    rt.style.backgroundImage = mark;
    if (rt.style.backgroundImage.indexOf('example.invalid') < 0) {
      add('css roundtrip', 'backgroundImage came back as ' + rt.style.backgroundImage);
    }
    say('css roundtrip', rt.style.backgroundImage);
    say('css roundtrip attr', rt.getAttribute('style'));
  } catch (e) { add('css-identity', 'err:' + e.name); }

  // Scan prototype methods and accessors on native constructors for non-native toString output.
  try {
    var NATIVE = /\{\s*\[native code\]\s*\}/;
    var seenFn = 0;
    var look = function (where, kind, fn) {
      if (typeof fn !== 'function') return;
      seenFn++;
      var src;
      try { src = Function.prototype.toString.call(fn); } catch (e) { return; }
      if (NATIVE.test(src)) return;
      // Ignore taskweaver's own injected listener bridge.
      if (where.indexOf('__internal_unstable_') >= 0) return;
      add('hook source', where + ' [' + kind + '] ' + src.replace(/\s+/g, ' ').slice(0, 80));
    };
    var names = Object.getOwnPropertyNames(window);
    for (var i = 0; i < names.length; i++) {
      var c0 = names[i].charCodeAt(0);
      if (c0 < 65 || c0 > 90) continue;
      var proto;
      try {
        var iface = window[names[i]];
        if (typeof iface !== 'function') continue;
        // Skip page-defined uppercase constructors whose methods are naturally non-native.
        if (!NATIVE.test(Function.prototype.toString.call(iface))) continue;
        proto = iface.prototype;
      } catch (e) { continue; }
      if (!proto || typeof proto !== 'object') continue;
      var keys;
      try { keys = Object.getOwnPropertyNames(proto); } catch (e) { continue; }
      for (var k = 0; k < keys.length; k++) {
        var d;
        try { d = Object.getOwnPropertyDescriptor(proto, keys[k]); } catch (e) { continue; }
        if (!d) continue;
        look(names[i] + '.' + keys[k], 'method', d.value);
        look(names[i] + '.' + keys[k], 'getter', d.get);
        look(names[i] + '.' + keys[k], 'setter', d.set);
      }
    }
    try {
      var probe = document.createElement('div');
      look('el.style.setProperty', 'bound', probe.style.setProperty);
      look('el.style.getPropertyValue', 'bound', probe.style.getPropertyValue);
      look('el.attributes.getNamedItem', 'bound', probe.attributes.getNamedItem);
    } catch (e) {}
    var ownStyle = 0;
    var seenProto = [];
    for (var j = 0; j < names.length; j++) {
      var c = names[j].charCodeAt(0);
      if (c < 65 || c > 90) continue;
      var pr;
      try {
        var f2 = window[names[j]];
        if (typeof f2 !== 'function') continue;
        if (!NATIVE.test(Function.prototype.toString.call(f2))) continue;
        pr = f2.prototype;
      } catch (e) { continue; }
      if (!pr || typeof pr !== 'object' || seenProto.indexOf(pr) >= 0) continue;
      seenProto.push(pr);
      if (Object.getOwnPropertyDescriptor(pr, 'style')) ownStyle++;
    }
    if (ownStyle > 40) add('prototype shape', 'own style accessors: ' + ownStyle + ' (browser has ~13)');
  } catch (e) { add('hook source', 'err:' + e.name); }
  return JSON.stringify(hits);
})()

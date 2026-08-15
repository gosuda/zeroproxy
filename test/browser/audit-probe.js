return (() => {
  const docURL = d => { try { return String(d.URL || ''); } catch (e) { return '?'; } };
  const topU = docURL(document).split('#')[0];
  const PROXY = 'proxy.localhost';
  const inert = s => !s || s.startsWith('blob:') || s.startsWith('data:') || s.startsWith('about:')
    || s.startsWith('#') || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:');
  const isProxied = s => s.indexOf(PROXY) >= 0 || s.startsWith('/zp/');

  const unproxied = [];
  let imgs = 0, broken = 0, sheets = 0, deadSheets = 0, swlessFrames = 0, swlessUnhandled = 0;

  const scanDoc = (doc, label) => {
    let els = [];
    try { els = [...doc.querySelectorAll('img[src],img[srcset],source[src],source[srcset],script[src],link[href],iframe[src],video[poster],embed[src],object[data],a[href]')]; } catch (e) { return; }
    for (const el of els) {
      const tag = el.localName;
      const keys = tag === 'video' ? ['poster'] : tag === 'link' || tag === 'a' ? ['href']
        : tag === 'object' ? ['data'] : (tag === 'img' || tag === 'source') ? ['src', 'srcset'] : ['src'];
      for (const k of keys) {
        let v = null;
        try { v = el.getAttribute(k); } catch (e) {}
        if (!v) continue;
        const parts = k === 'srcset' ? String(v).split(',').map(p => (p.trim().split(/\s+/)[0] || '')) : [String(v)];
        for (const p of parts) {
          const s = p.trim();
          if (inert(s) || isProxied(s)) continue;
          if (/^https?:/i.test(s) || s.startsWith('//')) unproxied.push({ f: label, tag, k, v: s.slice(0, 70) });
        }
      }
    }
    try { [...doc.images].forEach(i => { imgs++; if (i.complete && i.naturalWidth === 0) broken++; }); } catch (e) {}
    try {
      [...doc.querySelectorAll('link[rel~="stylesheet"][href]')].forEach(l => {
        sheets++;
        let ok = false;
        try { ok = !!(l.sheet && l.sheet.cssRules); } catch (e) { ok = !!l.sheet; }
        if (!ok) deadSheets++;
      });
    } catch (e) {}
  };

  scanDoc(document, 'top');
  let frames = 0;
  try {
    [...document.querySelectorAll('iframe')].forEach((f, i) => {
      frames++;
      let d = null; try { d = f.contentDocument; } catch (e) { return; }
      if (!d) return;
      const u = docURL(d).split('#')[0];
      const swless = u === topU || u === 'about:blank' || !u;
      if (swless) {
        swlessFrames++;
        try {
          [...d.images].forEach(im => {
            const a = String(im.getAttribute('src') || '');
            if (a.indexOf('/zp/api/fetch') >= 0) swlessUnhandled++;
          });
        } catch (e) {}
      }
      scanDoc(d, 'f' + i);
    });
  } catch (e) {}

  const seen = new Set();
  const uniq = unproxied.filter(u => { const k = u.tag + u.k + u.v; if (seen.has(k)) return false; seen.add(k); return true; });
  return JSON.stringify({
    title: String(document.title || '').slice(0, 40),
    ready: document.readyState,
    imgs, broken, sheets, deadSheets, frames, swlessFrames, swlessUnhandled,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    scrollH: document.documentElement.scrollHeight,
    unproxiedN: unproxied.length, unproxied: uniq.slice(0, 10)
  });
})()

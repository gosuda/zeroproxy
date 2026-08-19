// shopad 잔여 건 관측기 — document-start, 격리 월드, 프레임마다 실행.
// 원본(비프록시) URL 을 가진 속성이 DOM 에 나타나는 순간을 붙잡아 __zpRaw 에 쌓는다.
// 격리 월드라 페이지 전역은 안 보이지만 DOM 은 공유하므로 이 목적에는 충분하다.
(() => {
  const PROXY = 'proxy.localhost:18080';
  const ATTRS = ['src', 'href', 'srcset', 'imagesrcset', 'data', 'poster', 'action', 'ping'];
  const hits = (globalThis.__zpRaw = globalThis.__zpRaw || []);
  const t0 = Date.now();

  const isRaw = (v) => {
    if (!v || typeof v !== 'string') return false;
    if (!/^(https?:)?\/\//i.test(v.trim())) return false;
    return v.indexOf(PROXY) === -1;
  };

  const note = (el, attr, val, how) => {
    if (hits.length > 200) return;
    try {
      hits.push({
        t: Date.now() - t0,
        how,
        tag: el.tagName,
        attr,
        val: String(val).slice(0, 200),
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 80)) || null,
        // 파싱 시점인지 스크립트 시점인지 구분하는 유일한 단서
        ready: document.readyState,
        stack: (new Error().stack || '').split('\n').slice(2, 6).join(' | ').slice(0, 400),
      });
    } catch {}
  };

  const scan = (el, how) => {
    if (!el || el.nodeType !== 1) return;
    for (const a of ATTRS) {
      let v;
      try { v = el.getAttribute && el.getAttribute(a); } catch { continue; }
      if (isRaw(v)) note(el, a, v, how);
    }
  };

  const walk = (root, how) => {
    scan(root, how);
    let all;
    try { all = root.querySelectorAll ? root.querySelectorAll('*') : []; } catch { return; }
    for (const el of all) scan(el, how);
  };

  try {
    new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === 'attributes') {
          let v;
          try { v = r.target.getAttribute(r.attributeName); } catch { continue; }
          if (isRaw(v)) note(r.target, r.attributeName, v, 'attr');
        } else {
          for (const n of r.addedNodes) walk(n, 'added');
        }
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    globalThis.__zpRawArmed = true;
  } catch (e) {
    globalThis.__zpRawArmed = 'failed: ' + e;
  }

  // 옵저버가 걸리기 전에 이미 파싱된 것 + 최종 상태 스냅샷
  addEventListener('DOMContentLoaded', () => walk(document.documentElement, 'dcl'), true);
  addEventListener('load', () => walk(document.documentElement, 'load'), true);
})();

export function attrLocalName(key) {
  const s = String(key || '').toLowerCase();
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function tokenListContains(list, token) {
  return String(list || '').toLowerCase().split(/[\s,]+/).includes(token);
}

export function isBlockedLinkRelValue(rel) {
  for (const token of ['modulepreload','preload','prefetch','preconnect','dns-prefetch','prerender','manifest']) {
    if (tokenListContains(rel, token)) return true;
  }
  return false;
}

export function isIconLinkRelValue(rel) {
  for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) {
    if (token === 'icon' || token === 'mask-icon' || token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed' || token === 'apple-touch-startup-image' || token === 'fluid-icon') return true;
  }
  return false;
}

export function isStylesheetLinkRelValue(rel) {
  for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) if (token === 'stylesheet') return true;
  return false;
}

export function usesRawURLAttribute(el, key) {
  const tag = el && el.localName;
  const localKey = attrLocalName(key);
  return localKey === 'href' && (tag === 'a' || tag === 'area') || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button');
}

export function isResourceURLAttribute(el, key) {
  const tag = el && el.localName;
  const localKey = attrLocalName(key);
  return localKey === 'src' && (tag === 'img' || tag === 'source' || tag === 'audio' || tag === 'video' || tag === 'track' || tag === 'input') || localKey === 'poster' && tag === 'video' || localKey === 'href' && el && el.namespaceURI === 'http://www.w3.org/2000/svg' && (tag === 'image' || tag === 'use');
}

export function isSrcsetAttribute(el, key) {
  const tag = el && el.localName;
  return attrLocalName(key) === 'srcset' && (tag === 'img' || tag === 'source');
}

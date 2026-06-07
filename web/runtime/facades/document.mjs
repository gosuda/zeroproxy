export function createDocumentFacades({
  root,
  boot,
  Native,
  defineAccessor,
  defineReplacingAccessor = defineAccessor,
  getVirtualURL,
  getBaseURL,
  postMessageToSW,
}) {
  const {
    Date = globalThis.Date,
    Infinity: NativeInfinity = globalThis.Infinity,
    Math = globalThis.Math,
    Number = globalThis.Number,
    String = globalThis.String,
    URL = globalThis.URL,
    arrayIsArray = globalThis.Array.isArray,
    objectFreeze = globalThis.Object.freeze,
  } = Native;
  const documentCookieRecords = [];
  initDocumentCookieRecords(String(boot.documentCookie || ''));

  function installDocumentAccessors(w) {
    defineReplacingAccessor(w.Document && w.Document.prototype, 'URL', () => getVirtualURL().href);
    defineReplacingAccessor(w.Document && w.Document.prototype, 'documentURI', () => getVirtualURL().href);
    defineReplacingAccessor(w.Document && w.Document.prototype, 'baseURI', () => getBaseURL());
    defineReplacingAccessor(w.Document && w.Document.prototype, 'referrer', () => boot.documentReferrer || '');
    defineReplacingAccessor(w.Document && w.Document.prototype, 'cookie', () => documentCookieString(), value => {
      const cookie = String(value);
      setDocumentCookie(cookie);
      postMessageToSW({
        type: 'ZP_COOKIE_SET',
        tabId: boot.tabId,
        targetUrl: getVirtualURL().href,
        cookie
      }).catch(()=>{});
    });
    defineReplacingAccessor(w, 'origin', () => {
      try {
        return new URL(w.document.URL).origin;
      } catch {
        return getVirtualURL().origin;
      }
    });
  }

  function installCookieSync() {
    const sw = root.navigator && root.navigator.serviceWorker;
    if (!sw || !sw.addEventListener) return;
    sw.addEventListener('message', handleCookieSyncMessage);
  }

  function handleCookieSyncMessage(ev) {
    const msg = acceptedCookieSyncMessage(ev);
    if (!msg) return;
    if (arrayIsArray(msg.cookieRecords)) syncDocumentCookieRecords(msg.cookieRecords, msg.targetUrl);
    else if (typeof msg.cookieString === 'string') initDocumentCookieRecords(msg.cookieString);
  }

  function acceptedCookieSyncMessage(ev) {
    const msg = ev && ev.data || {};
    if (msg.type !== 'ZP_COOKIE_SYNC') return null;
    if (msg.tabId && msg.tabId !== boot.tabId) return null;
    if (msg.targetUrl && !sameVirtualOrigin(msg.targetUrl)) return null;
    return msg;
  }

  function sameVirtualOrigin(raw) {
    try {
      return new URL(raw).origin === getVirtualURL().origin;
    } catch {
      return false;
    }
  }

  function initDocumentCookieRecords(cookieString) {
    documentCookieRecords.splice(0, documentCookieRecords.length);
    const current = getVirtualURL();
    for (const part of String(cookieString || '').split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        documentCookieRecords.push({
          name: part.slice(0, eq),
          value: part.slice(eq + 1),
          domain: current.hostname.toLowerCase(),
          hostOnly: true,
          path: '/',
          secure: current.protocol === 'https:',
          sameSite: 'Unspecified',
          expires: NativeInfinity
        });
      }
    }
  }

  function pruneCookieRecordsForSource(sourceHost, sourceSecure) {
    for (let i = documentCookieRecords.length - 1; i >= 0; i--) {
      const record = documentCookieRecords[i];
      if (cookieDomainMatches(record, sourceHost) && (!record.secure || sourceSecure)) {
        documentCookieRecords.splice(i, 1);
      }
    }
  }

  function buildSyncedCookieRecord(raw, sourceHost) {
    const domain = String(raw.domain || sourceHost).replace(/^\./, '').toLowerCase();
    return {
      name: raw.name,
      value: String(raw.value || ''),
      domain,
      hostOnly: raw.hostOnly !== false,
      path: String(raw.path || '/').startsWith('/') ? String(raw.path || '/') : '/',
      secure: !!raw.secure,
      sameSite: normalizeSameSite(raw.sameSite),
      expires: typeof raw.expiresMs === 'number' ? raw.expiresMs : NativeInfinity
    };
  }

  function syncDocumentCookieRecords(records, sourceUrl) {
    let source;
    try {
      source = new URL(sourceUrl || getVirtualURL().href);
    } catch {
      source = getVirtualURL();
    }
    const sourceHost = source.hostname.toLowerCase();
    pruneCookieRecordsForSource(sourceHost, source.protocol === 'https:');
    const now = Date.now();
    for (const raw of arrayIsArray(records) ? records : []) {
      if (!raw || typeof raw.name !== 'string' || raw.name === '') continue;
      const rec = buildSyncedCookieRecord(raw, sourceHost);
      if (rec.expires > now) documentCookieRecords.push(rec);
    }
  }

  function applyCookieDomain(rec, value) {
    if (!value) return;
    const domain = value.replace(/^\./, '').toLowerCase();
    const host = getVirtualURL().hostname.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) {
      rec.domain = domain;
      rec.hostOnly = false;
    }
  }

  function applyCookieExpiry(rec, key, value) {
    if (key === 'max-age') {
      rec.expires = Date.now() + Math.max(0, Number(value) || 0) * 1000;
      return;
    }
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) rec.expires = ts;
  }

  function applyCookieAttribute(rec, key, value) {
    if (key === 'domain') return applyCookieDomain(rec, value);
    if (key === 'max-age' || key === 'expires') return applyCookieExpiry(rec, key, value);
    if (key === 'path' && value && value[0] === '/') rec.path = value;
    else if (key === 'secure') rec.secure = true;
    else if (key === 'samesite') rec.sameSite = normalizeSameSite(value);
  }

  function parseCookieLine(line) {
    const parts = String(line).split(';').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return null;
    const current = getVirtualURL();
    const rec = {
      name: parts[0].slice(0, eq),
      value: parts[0].slice(eq + 1),
      domain: current.hostname.toLowerCase(),
      hostOnly: true,
      path: defaultCookiePath(),
      secure: false,
      sameSite: 'Unspecified',
      expires: NativeInfinity
    };
    for (let i = 1; i < parts.length; i++) {
      const [rawKey, ...rest] = parts[i].split('=');
      applyCookieAttribute(rec, rawKey.toLowerCase(), rest.join('='));
    }
    if (rec.sameSite === 'None' && !rec.secure) return null;
    return rec;
  }

  function commitCookieRecord(rec) {
    const idx = documentCookieRecords.findIndex(record => record.name === rec.name && record.domain === rec.domain && record.path === rec.path);
    if (rec.expires <= Date.now()) {
      if (idx >= 0) documentCookieRecords.splice(idx, 1);
    } else if (idx >= 0) documentCookieRecords[idx] = rec;
    else documentCookieRecords.push(rec);
  }

  function setDocumentCookie(line) {
    const rec = parseCookieLine(line);
    if (rec) commitCookieRecord(rec);
  }

  function documentCookieString() {
    const now = Date.now();
    const current = getVirtualURL();
    const host = current.hostname.toLowerCase();
    const path = current.pathname || '/';
    return documentCookieRecords
      .filter(record => record.expires > now && (!record.secure || current.protocol === 'https:') && cookieDomainMatches(record, host) && cookiePathMatches(record, path))
      .sort((a, b) => b.path.length - a.path.length)
      .map(record => `${record.name}=${record.value}`)
      .join('; ');
  }

  function cookieDomainMatches(record, host) {
    return record.hostOnly ? record.domain === host : host === record.domain || host.endsWith(`.${record.domain}`);
  }

  function cookiePathMatches(record, path) {
    return path === record.path || path.startsWith(record.path) && (record.path.endsWith('/') || path[record.path.length] === '/');
  }

  function normalizeSameSite(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'lax') return 'Lax';
    if (normalized === 'strict') return 'Strict';
    if (normalized === 'none') return 'None';
    return 'Unspecified';
  }

  function defaultCookiePath() {
    const path = getVirtualURL().pathname || '/';
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  return objectFreeze({
    installDocumentAccessors,
    installCookieSync,
  });
}

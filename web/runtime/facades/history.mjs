export function createHistoryFacade({
  root,
  Native,
  ZP,
  boot,
  proxyOrigin,
  activeServers,
  initialProxyURL,
  normalizedError,
  targetURL,
  navigateToTarget,
  postMessageToSW,
  getActiveProxyPath,
  setActiveProxyPath,
  getActiveProxyFragment,
  setActiveProxyFragment,
  getActiveRouteKey,
  setActiveRouteKey,
  getActiveEntryId,
  setActiveEntryId,
  getVirtualURL,
  setVirtualURL,
  getBaseURL,
  setBaseURL,
  getExplicitBaseURL,
  setExplicitBaseURL,
  getActiveShareVersion,
  setActiveShareVersion,
}) {
  const {
    HashChangeEvent = globalThis.HashChangeEvent,
    Object = globalThis.Object,
    String = globalThis.String,
    URL = globalThis.URL,
    objectFreeze = globalThis.Object.freeze,
  } = Native;

  function shareFragmentForKey(key) {
    return ZP.makeShareFragment(String(key), activeServers);
  }

  function proxyHistoryURL() {
    return getActiveProxyPath() + getActiveProxyFragment();
  }

  function nativeLocationURL() {
    try {
      const href = Native.locationHref && Native.locationHref.get && Native.locationHref.get.call(root.location);
      if (href) return new URL(href);
    } catch {}
    try {
      return new URL(proxyHistoryURL(), proxyOrigin);
    } catch {
      return new URL(initialProxyURL.href);
    }
  }

  function visibleProxyURL() {
    const u = nativeLocationURL();
    return u.pathname + u.search + u.hash;
  }

  function setActiveShareRoute(share) {
    setActiveProxyPath(ZP.makeSharePath(share.encrypted));
    setActiveRouteKey(share.encrypted);
    setActiveProxyFragment(shareFragmentForKey(share.key));
  }

  function replaceVisibleProxyURL() {
    const next = proxyHistoryURL();
    if (visibleProxyURL() !== next) {
      try {
        Native.historyReplace(root.history.state, '', next);
      } catch {}
    }
  }

  function refreshVisibleShareRoute(entryId, target, base) {
    const version = getActiveShareVersion() + 1;
    setActiveShareVersion(version);
    ZP.encryptShareURL(target).then(share => postMessageToSW({
      type: 'ZP_HISTORY_UPDATE',
      tabId: boot.tabId,
      routeKey: share.encrypted,
      entryId,
      targetUrl: target,
      baseUrl: base,
      replace: true
    }).then(() => share)).then(share => {
      if (version !== getActiveShareVersion() || entryId !== getActiveEntryId() || target !== getVirtualURL().href) return;
      setActiveShareRoute(share);
      replaceVisibleProxyURL();
    }).catch(()=>{});
  }

  function sameOriginHistoryURL(url) {
    const next = new URL(targetURL(url));
    if (next.origin !== getVirtualURL().origin) throw normalizedError('SecurityError');
    return next;
  }

  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url) : new URL(getVirtualURL().href);
    setVirtualURL(next);
    if (!getExplicitBaseURL()) setBaseURL(next.href);
    const entryId = replace && getActiveEntryId() ? getActiveEntryId() : `e${ZP.randomId()}`;
    setActiveEntryId(entryId);
    postMessageToSW({
      type: 'ZP_HISTORY_UPDATE',
      tabId: boot.tabId,
      routeKey: getActiveRouteKey(),
      entryId,
      targetUrl: getVirtualURL().href,
      baseUrl: getBaseURL(),
      replace
    }).catch(()=>{});
    const out = (replace ? Native.historyReplace : Native.historyPush)(state, title, proxyHistoryURL());
    refreshVisibleShareRoute(entryId, getVirtualURL().href, getBaseURL());
    return out;
  }

  function updateVirtualHash(raw, replace = false) {
    const oldURL = getVirtualURL().href;
    const next = new URL(getVirtualURL().href);
    let hash = String(raw);
    if (hash && hash[0] !== '#') hash = `#${hash}`;
    next.hash = hash;
    if (next.href === getVirtualURL().href) return;
    const out = commitVirtualHistory(null, '', next.href, replace);
    try {
      root.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: getVirtualURL().href }));
    } catch {
      try {
        root.dispatchEvent(new root.Event('hashchange'));
      } catch {}
    }
    return out;
  }

  function setVirtualLocation(raw, replace = false) {
    const next = new URL(targetURL(raw));
    const current = getVirtualURL();
    if (next.origin === current.origin && next.pathname === current.pathname && next.search === current.search) {
      updateVirtualHash(next.hash, replace);
      return;
    }
    navigateToTarget(next.href, replace);
  }

  function applyResolvedHistoryEntry(reply) {
    setActiveEntryId(reply.entryId || getActiveEntryId());
    const next = new URL(reply.targetUrl);
    setVirtualURL(next);
    const base = reply.baseUrl || next.href;
    setBaseURL(base);
    setExplicitBaseURL(base !== next.href ? base : '');
    if (typeof reply.scrollX === 'number' && typeof reply.scrollY === 'number') root.scrollTo(reply.scrollX, reply.scrollY);
  }

  function installHistoryMethods(define) {
    define(root.history, 'pushState', function(state, title, url) {
      return commitVirtualHistory(state, title, url, false);
    });
    define(root.history, 'replaceState', function(state, title, url) {
      return commitVirtualHistory(state, title, url, true);
    });
  }

  return objectFreeze({
    proxyHistoryURL,
    nativeLocationURL,
    visibleProxyURL,
    setActiveShareRoute,
    replaceVisibleProxyURL,
    refreshVisibleShareRoute,
    sameOriginHistoryURL,
    commitVirtualHistory,
    updateVirtualHash,
    setVirtualLocation,
    applyResolvedHistoryEntry,
    installHistoryMethods,
  });
}

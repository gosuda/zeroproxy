  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url, replace ? 'replaceState' : 'pushState') : new URL(virtualURL.href);
    virtualURL = next;
    if (!explicitBaseURL) baseURL = virtualURL.href;
    const entryId = replace && activeEntryId ? activeEntryId : 'e' + ZP.randomId();
    activeEntryId = entryId;
    ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: activeRouteKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace, ...(opaqueDocument ? { opaque: true } : null) }).catch(()=>{});
    const pushURL = proxyAbsoluteURL(proxyHistoryURL());
    const out = (replace ? Native.historyReplace : Native.historyPush)(state, title, pushURL);
    refreshVisibleShareRoute(entryId, virtualURL.href, baseURL);
    return out;
  }
  function updateVirtualHash(raw, replace = false) {
    const oldURL = virtualURL.href;
    const next = new URL(virtualURL.href);
    let hash = String(raw);
    if (hash && hash[0] !== '#') hash = '#' + hash;
    next.hash = hash;
    if (next.href === virtualURL.href) return;
    const out = commitVirtualHistory(null, '', next.href, replace);
    try { window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: virtualURL.href })); } catch { try { window.dispatchEvent(new Event('hashchange')); } catch {} }
    return out;
  }
  // External handler schemes delegated directly to the browser rather than
  // routed through the proxy. Executable and inline schemes (javascript:,
  // data:, blob:, about:) remain blocked.
  const NAV_EXTERNAL_SCHEMES = newSet(['mailto:', 'tel:', 'sms:', 'callto:', 'skype:', 'intent:', 'market:', 'webcal:', 'geo:', 'tg:', 'whatsapp:', 'zoommtg:', 'ms-teams:', 'slack:', 'discord:']);
  function delegatableExternalScheme(raw) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*:)/.exec(String(raw).trim());
    return !!m && NAV_EXTERNAL_SCHEMES.has(m[1].toLowerCase());
  }
  function setVirtualLocation(raw, replace = false) {
    // Rewrite and execute `location.href = "javascript:..."` in global scope.
    const jsMatch = /^\s*javascript:/i.exec(String(raw));
    if (jsMatch) {
      const code = String(raw).slice(jsMatch[0].length);
      try { execGlobalScript(callPageRewriter(code, 'classic')); } catch {}
      return;
    }
    let next;
    try {
      next = new URL(targetURL(raw));
    } catch (e) {
      const g = unleakedTargetRaw(raw);
      if (g !== null && delegatableExternalScheme(g)) {
        const abs = String(g).trim();
        if (replace && Native.locationReplace) { Native.locationReplace(abs); return; }
        if (!replace && Native.locationAssign) { Native.locationAssign(abs); return; }
      }
      throw e;
    }
    if (next.origin === virtualURL.origin && next.pathname === virtualURL.pathname && next.search === virtualURL.search) {
      updateVirtualHash(next.hash, replace);
      return;
    }
    navigateToTarget(next.href, replace);
  }
  async function activatedNavPath(raw, replace = false, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const path = ZP.makeSharePath(share.encrypted);
    const entryId = replace ? activeEntryId : 'e' + ZP.randomId();
    await ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, replace, ...(opaqueDocument ? { opaque: true } : null) });
    activeProxyPath = path;
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
    return path + activeProxyFragment;
  }
  // Map encrypted frame route keys to target URLs so the parent realm can
  // resolve a child frame's virtual location and postMessage origin even
  // before or without child prelude boot.
  const frameRouteTargets = newMap();
  function frameRouteTarget(path) {
    return ZP.isSharePath(path) ? frameRouteTargets.get(ZP.shareRouteKey(path)) || '' : '';
  }
  function rememberFrameRoute(routeKey, target) {
    if (frameRouteTargets.size >= 4096) frameRouteTargets.delete(frameRouteTargets.keys().next().value);
    frameRouteTargets.set(routeKey, target);
  }
  // `opaque` may be a boolean or a predicate evaluated when the route is sent;
  // defaults to the embedding document's opacity.
  async function activatedFrameURL(raw, base = baseURL, opaque) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    rememberFrameRoute(share.encrypted, target);
    const entryId = 'e' + ZP.randomId();
    const isOpaque = typeof opaque === 'function' ? !!opaque() : opaque === undefined ? opaqueDocument : !!opaque;
    // Pass parentTargetUrl so the service worker sends the embedding page's
    // virtual URL in the iframe document's Referer header.
    await ctx.bridge.send({ type: ZP.MSG.FRAME_ROUTE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, parentTargetUrl: virtualURL.href, ...(isOpaque ? { opaque: true } : null) });
    return proxyOrigin + ZP.makeSharePath(share.encrypted) + shareFragmentForKey(share.key);
  }
  function navigateToTarget(raw, replace = false, base = baseURL) {
    activatedNavPath(raw, replace, base).then(path => {
      const href = proxyAbsoluteURL(path);
      if (replace && Native.locationReplace) Native.locationReplace(href);
      else if (!replace && Native.locationAssign) Native.locationAssign(href);
      else if (replace) location.replace(href);
      else location.href = href;
    }).catch(() => shareNavURL(raw, base).then(u => {
      if (replace && Native.locationReplace) Native.locationReplace(u);
      else if (!replace && Native.locationAssign) Native.locationAssign(u);
      else if (replace) location.replace(u);
      else location.href = u;
    }).catch(()=>{}));
  }
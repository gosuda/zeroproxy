  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url) : new URL(virtualURL.href);
    virtualURL = next;
    if (!explicitBaseURL) baseURL = virtualURL.href;
    const entryId = replace && activeEntryId ? activeEntryId : 'e' + ZP.randomId();
    activeEntryId = entryId;
    ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: activeRouteKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace }).catch(()=>{});
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
  // Schemes that cannot load proxied web content — the browser hands them to
  // an external handler (mail client, dialer, app store). Native
  // `location.assign('mailto:…')` must NOT die on TARGET_PROTOCOL_BLOCKED.
  // Deliberately absent: javascript:/data:/blob:/about: — those execute or
  // inline content and must keep failing closed.
  const NAV_EXTERNAL_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'callto:', 'skype:', 'intent:', 'market:', 'webcal:', 'geo:', 'tg:', 'whatsapp:', 'zoommtg:', 'ms-teams:', 'slack:', 'discord:']);
  function delegatableExternalScheme(raw) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*:)/.exec(String(raw).trim());
    return !!m && NAV_EXTERNAL_SCHEMES.has(m[1].toLowerCase());
  }
  function setVirtualLocation(raw, replace = false) {
    // D4: `location.href='javascript:…'` — 네이티브는 코드를 현재 문서에서
    // 평가한다(반환 문자열이면 문서 교체). 여기서는 재작성 후 페이지 realm 에서
    // 실행하고, 문자열 반환의 문서 교체는 희소 경로라 생략한다.
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
    await ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, replace });
    activeProxyPath = path;
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
    return path + activeProxyFragment;
  }
  async function activatedFrameURL(raw, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const entryId = 'e' + ZP.randomId();
    // parentTargetUrl carries the embedding page's virtual URL so the SW can
    // send the right Referer when fetching the iframe document. Without it
    // the iframe's own URL is used, and origin-aware endpoints (e.g. NAVER's
    // shopsquare.naver.com /newshopping) 404 because they expect the embedder
    // page's host in Referer.
    await ctx.bridge.send({ type: ZP.MSG.FRAME_ROUTE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, parentTargetUrl: virtualURL.href });
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
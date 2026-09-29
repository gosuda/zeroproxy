# Session hygiene for the taskweaver browser axes (sourced, not executed).
#
# The `zp` profile is shared across runs — and with other Claude sessions — so
# it carries service-worker registrations, caches and storage from earlier
# builds. An old SW then serves old assets and a fix measures as "no change"
# (.ai/trap-notebook: 옛 SW 캐시로 검증). A wedged daemon, reused, poisons every
# measurement after it. These two helpers are the PHASE2 follow-up
# "taskweaver profile isolation".

ZP_PROXY_ORIGIN="http://proxy.localhost:18080"

# Ensure the single shared `zp` instance exists and can run JS. Missing → start
# it (CLAUDE.md policy: reuse `zp`, never create other ids). Present but not
# renderer_ok → fail; the caller reports NO_MEASUREMENT instead of fake zeros.
zp_ensure() {
  zp_state=$(taskweaver list 2>/dev/null | node -e "
    let s = '';
    process.stdin.on('data', d => s += d).on('end', () => {
      try {
        const i = (JSON.parse(s).instances || []).find(x => x.id === 'zp');
        console.log(!i ? 'missing' : (i.renderer_ok ? 'ok' : 'wedged'));
      } catch { console.log('unknown'); }
    })")
  case "$zp_state" in
    ok) return 0 ;;
    missing) taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Wipe ONLY the proxy origin's state before a proxied measurement: the browser
# is shared, so target sites (their logins and cookies) are never touched.
zp_reset_proxy_state() {
  taskweaver clear-site-data -i zp --origin "$ZP_PROXY_ORIGIN" --types all >/dev/null 2>&1
}

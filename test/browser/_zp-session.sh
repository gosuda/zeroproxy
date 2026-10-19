# Session hygiene helpers for the shared taskweaver `zp` browser instance (sourced, not executed).
#
# Because the `zp` profile is shared across runs, stale service-worker
# registrations and cached assets from previous builds must be cleared before
# running proxied measurements.

ZP_PROXY_ORIGIN="http://proxy.localhost:18080"

# Ensure the shared `zp` instance exists and has a responsive renderer.
# Starts `zp` if missing; returns 1 if the existing instance is wedged.
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

# Clear only the proxy origin's state so target-site cookies and logins remain intact.
zp_reset_proxy_state() {
  taskweaver clear-site-data -i zp --origin "$ZP_PROXY_ORIGIN" --types all >/dev/null 2>&1
}

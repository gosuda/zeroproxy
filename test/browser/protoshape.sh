#!/bin/sh
# Compare WebIDL interface prototype own-property sets between a direct control load and a proxied load.
# Usage: sh test/browser/protoshape.sh [url...]

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROBE="$SELF_DIR/protoshape-probe.js"
PROXY_HOME="http://proxy.localhost:18080/zp/"
. "$SELF_DIR/_zp-session.sh"
zp_ensure || { echo "NO_MEASUREMENT: taskweaver zp daemon is not usable (renderer not ok)"; exit 1; }
OUT_DIR="${TMPDIR:-/tmp}/zp-protoshape"
mkdir -p "$OUT_DIR"

[ "$#" -eq 0 ] && set -- "https://example.com/"

measure() {
  taskweaver exec-js -i zp --file "$PROBE" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const r=JSON.parse(s).result; if(!r){process.exit(3)} require('fs').writeFileSync(process.argv[1],r)}
        catch(e){process.exit(3)}
      })" "$1"
}

STATUS=0
for U in "$@"; do
  C="$OUT_DIR/control.json"
  P="$OUT_DIR/proxy.json"
  rm -f "$C" "$P"

  taskweaver navigate -i zp --url "$U" --timeout-ms 40000 >/dev/null 2>&1
  taskweaver wait -i zp --ms 6000 >/dev/null 2>&1
  measure "$C"

  zp_reset_proxy_state
  taskweaver navigate -i zp --url "$PROXY_HOME" --timeout-ms 20000 >/dev/null 2>&1
  taskweaver fill-form -i zp --selector "input" --value "$U" >/dev/null 2>&1
  # Start wait-navigation in the background before clicking Open so fast navigations are not missed.
  taskweaver wait-navigation -i zp --timeout-ms 45000 >/dev/null 2>&1 &
  WN=$!
  sleep 1
  taskweaver click -i zp --text "Open" >/dev/null 2>&1
  wait $WN
  taskweaver wait -i zp --ms 12000 >/dev/null 2>&1
  measure "$P"

  # Reject missing probe outputs explicitly so a crashed renderer does not pass with zero diffs.
  if [ ! -s "$C" ] || [ ! -s "$P" ]; then
    echo "$U  => NO_MEASUREMENT (control=$([ -s "$C" ] && echo ok || echo missing) proxy=$([ -s "$P" ] && echo ok || echo missing))"
    STATUS=1
    continue
  fi

  node -e '
    const fs = require("fs");
    const [cp, pp, url] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(cp, "utf8"));
    const p = JSON.parse(fs.readFileSync(pp, "utf8"));
    const diffs = [];
    for (const k of new Set([...Object.keys(c), ...Object.keys(p)])) {
      const cs = new Set(c[k] || []);
      const ps = new Set(p[k] || []);
      if (!c[k]) { diffs.push([k, ["(proxy-only interface)"], []]); continue; }
      if (!p[k]) { diffs.push([k, [], ["(control-only interface)"]]); continue; }
      const extra = [...ps].filter((x) => !cs.has(x));
      const missing = [...cs].filter((x) => !ps.has(x));
      if (extra.length || missing.length) diffs.push([k, extra, missing]);
    }
    const ifaces = Object.keys(c).length;
    if (!diffs.length) { console.log(url + "  => OK  (" + ifaces + " interfaces matched)"); process.exit(0); }
    console.log(url + "  => SHAPE_DIFF(" + diffs.length + ")  (of " + ifaces + " interfaces)");
    for (const [k, extra, missing] of diffs) {
      let line = "    " + k;
      if (extra.length) line += "  proxy-only: " + extra.slice(0, 8).join(", ") + (extra.length > 8 ? " …+" + (extra.length - 8) : "");
      if (missing.length) line += "  control-only: " + missing.slice(0, 8).join(", ") + (missing.length > 8 ? " …+" + (missing.length - 8) : "");
      console.log(line);
    }
    process.exit(2);
  ' "$C" "$P" "$U" || STATUS=1
done

exit $STATUS

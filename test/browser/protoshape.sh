#!/bin/sh
# 프로토타입 모양 회귀 축. 사이트마다 **대조군(직접 로드)과 프록시를 쌍으로**
# 재서 인터페이스 프로토타입의 own 이름 집합을 비교한다.
#
# ★왜 필요한가: 이름을 세기만 해도 멤브레인이 드러난다. 2026-09-10 에
# `style` 접근자를 "가진 인터페이스 전부" 감싸면서 체인을 타는 헬퍼를 쓰는 바람에
# 상속된 style 을 서브클래스마다 own 으로 새로 만들었다 — own style 을 가진
# 프로토타입이 대조군 13개 vs 우리 157개가 됐다. 고치려던 지문보다 큰 지문을
# 만든 셈인데, 기존 축(raw/csp/err/height)은 **전부 통과**했다.
# 자세한 것: .ai/trap-notebook/rewriter.md#훅-소스-노출
#
# 사용: sh test/browser/protoshape.sh "https://a/" …
#       (인자가 없으면 example.com 하나로 돈다 — 모양 비교에 페이지 내용은
#        거의 무관하고, 가벼운 페이지가 빠르다)

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROBE="$SELF_DIR/protoshape-probe.js"
PROXY_HOME="http://proxy.localhost:18080/zp/"
OUT_DIR="${TMPDIR:-/tmp}/zp-protoshape"
mkdir -p "$OUT_DIR"

[ "$#" -eq 0 ] && set -- "https://example.com/"

measure() { # $1 = 저장 경로
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

  # ── 대조군: 직접 로드 ────────────────────────────────────────────────
  taskweaver navigate -i zp --url "$U" --timeout-ms 40000 >/dev/null 2>&1
  taskweaver wait -i zp --ms 6000 >/dev/null 2>&1
  measure "$C"

  # ── 프록시 ──────────────────────────────────────────────────────────
  taskweaver navigate -i zp --url "$PROXY_HOME" --timeout-ms 20000 >/dev/null 2>&1
  taskweaver fill-form -i zp --selector "input" --value "$U" >/dev/null 2>&1
  # wait-navigation 은 **클릭 전에** 띄운다(rendercheck 와 같은 이유).
  taskweaver wait-navigation -i zp --timeout-ms 45000 >/dev/null 2>&1 &
  WN=$!
  sleep 1
  taskweaver click -i zp --text "Open" >/dev/null 2>&1
  wait $WN
  taskweaver wait -i zp --ms 12000 >/dev/null 2>&1
  measure "$P"

  # ── 판정 ────────────────────────────────────────────────────────────
  # ★맨 먼저 "쟀는가" 를 본다. 브라우저가 죽으면 차이가 0 으로 나와 통과처럼
  # 보인다 — 안 잰 것과 통과한 것은 다르다(2026-09-10 실측).
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
      if (!c[k]) { diffs.push([k, ["(프록시에만 있는 인터페이스)"], []]); continue; }
      if (!p[k]) { diffs.push([k, [], ["(대조군에만 있는 인터페이스)"]]); continue; }
      const extra = [...ps].filter((x) => !cs.has(x));
      const missing = [...cs].filter((x) => !ps.has(x));
      if (extra.length || missing.length) diffs.push([k, extra, missing]);
    }
    const ifaces = Object.keys(c).length;
    if (!diffs.length) { console.log(url + "  => OK  (인터페이스 " + ifaces + "개 일치)"); process.exit(0); }
    console.log(url + "  => SHAPE_DIFF(" + diffs.length + ")  (인터페이스 " + ifaces + "개 중)");
    for (const [k, extra, missing] of diffs) {
      let line = "    " + k;
      if (extra.length) line += "  프록시에만: " + extra.slice(0, 8).join(", ") + (extra.length > 8 ? " …+" + (extra.length - 8) : "");
      if (missing.length) line += "  대조군에만: " + missing.slice(0, 8).join(", ") + (missing.length > 8 ? " …+" + (missing.length - 8) : "");
      console.log(line);
    }
    process.exit(2);
  ' "$C" "$P" "$U" || STATUS=1
done

exit $STATUS

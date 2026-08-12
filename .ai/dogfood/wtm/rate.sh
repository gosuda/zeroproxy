#!/bin/bash
# wedge **비율**을 잰다. 판정 하나가 아니라 분포가 필요하다 —
# 같은 바이트로 WEDGE 와 ALIVE 가 번갈아 나오는 게 실측이다.
#
# 사용: bash rate.sh <횟수> <라벨>
# sw.js/runtime-prelude.js 는 호출 전에 원하는 상태로 맞춰 둘 것.
cd /f/git/zeroproxy/.ai/dogfood/wtm
N=${1:-8}
LABEL=${2:-base}
WEDGE=0
ALIVE=0

for a in $(seq 1 "$N"); do
  taskweaver kill --id zp >/dev/null 2>&1 || true
  sleep 3
  (taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
  sleep 40
  # 세션 순서 고정: 직접 로드 선행 → 프록시.
  taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
  sleep 20
  taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
  sleep 8
  taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
  taskweaver reload -i zp --hard >/dev/null 2>&1
  sleep 12
  taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1

  VERDICT="ALIVE"
  for t in 20 35 50 65 80; do
    sleep 15
    # exec-js 내부 타임아웃이 30초이므로 timeout 은 그보다 길게.
    if ! timeout 40 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
      VERDICT="WEDGE@${t}s"; break
    fi
  done
  case "$VERDICT" in
    ALIVE) ALIVE=$((ALIVE+1)) ;;
    *)     WEDGE=$((WEDGE+1)) ;;
  esac
  echo "[$LABEL] run $a/$N: $VERDICT   (running: alive=$ALIVE wedge=$WEDGE)"
done

echo "[$LABEL] TOTAL alive=$ALIVE wedge=$WEDGE of $N"

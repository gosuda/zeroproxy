#!/bin/bash
# A/B 를 **같은 횟수로, 번갈아** 돌린다.
#
# 왜 번갈아인가: wedge 비율이 시간에 따라 흐른다(오전/오후에 결과가 뒤집혔고
# NAVER 가 빌드도 갈았다). 한 팔을 몰아서 돌리면 시간 변수가 팔 사이 차이로
# 둔갑한다. A,B,A,B… 로 교대하면 그 흐름이 양쪽에 고르게 섞인다.
#
# 사용: bash ab.sh <각 팔 횟수> <A라벨> <A설정스크립트> <B라벨> <B설정스크립트>
#   설정 스크립트는 dist 를 원하는 상태로 맞추는 node 스크립트 경로(또는 'none').
set -u
cd /f/git/zeroproxy/.ai/dogfood/wtm
N=${1:-5}; ALAB=${2:-A}; ASET=${3:-none}; BLAB=${4:-B}; BSET=${5:-none}

setup() {
  cp /f/git/zeroproxy/web/sw.js /f/git/zeroproxy/dist/web/sw.js
  cp /f/git/zeroproxy/web/runtime-prelude.js /f/git/zeroproxy/dist/web/runtime-prelude.js
  if [ "$1" != "none" ]; then bash "$1" || { echo "SETUP FAILED: $1"; exit 1; }; fi
}

for i in $(seq 1 "$N"); do
  for arm in A B; do
    if [ "$arm" = "A" ]; then LAB="$ALAB"; SET="$ASET"; else LAB="$BLAB"; SET="$BSET"; fi
    setup "$SET"
    bash rate.sh 1 "$LAB" 2>&1 | grep "run 1/1"
  done
done

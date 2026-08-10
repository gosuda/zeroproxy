#!/bin/bash
# 대조군: **프록시 없이** 같은 페이지를 직접 열고 같은 예외를 잡는다.
#
# bvsd 는 내장 함수를 일부러 잘못 호출해 엔진 동작을 확인하는 프로브 스위트를
# 돌린다(모듈 번호별로 ~60ms 간격, 전부 t.exports 래퍼 경유). 따라서 예외가
# 난다는 사실 자체는 정상이다 — **진짜 브라우저와 다른 예외**만이 단서다.
# 이 스크립트의 출력과 exc-bvsd2.json 을 diff 해서 그 차이를 뽑는다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver debugger-arm -i zp --strategy exceptions --sample-every 1 --max-frames 24 >/dev/null 2>&1
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 45
taskweaver debugger-snapshot -i zp > "$1" 2>&1
echo "wrote $1 ($(wc -c < "$1") bytes)"

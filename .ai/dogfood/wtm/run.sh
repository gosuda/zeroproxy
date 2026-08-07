#!/bin/bash
# wedge 재현 1회. 출력: "WEDGE" 또는 "ALIVE" (+ 재현 게이트로 wtm 로드 확인)
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 28
ST=$(timeout 40 taskweaver exec-js -i zp --script "return JSON.stringify(performance.getEntriesByType('resource').filter(function(r){return /3e66f2/.test(r.name)}).map(function(r){return r.encodedBodySize}))" 2>&1)
if echo "$ST" | grep -q '"status": "completed"'; then
  echo "ALIVE gate=$(echo "$ST" | grep -o '\[[0-9,]*\]' | head -1)"
else
  echo "WEDGE (gate: 렌더러가 굳어 확인 불가 — wedge 자체가 wtm 실행 증거)"
fi

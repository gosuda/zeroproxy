#!/bin/bash
# 늦은 wedge = 스택 오버플로 폭풍(프록시 3,220 vs 직접 2).
# 엔진이 던지는 RangeError 는 JS 생성자를 거치지 않으므로 in-page 계측으로는
# 못 센다 — V8 디버거로 잡는다. debugger-snapshot 은 데몬 메모리를 읽으므로
# 렌더러가 굳어도 답한다.
# 세션 순서는 pair.sh 와 동일하게 직접 로드 선행으로 고정한다.
set -e
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 20
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 8
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver debugger-arm -i zp --strategy exceptions --sample-every 1 --max-frames 40 >/dev/null 2>&1
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 70
taskweaver debugger-snapshot -i zp > "$1" 2>&1
echo "wrote $1 ($(wc -c < "$1") bytes)"

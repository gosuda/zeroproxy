#!/bin/bash
# wedge 순간의 **엔진 예외**를 잡는다.
#
# 왜 이 경로인가: 루프 86개(for 68 + do-while 18 = 정적 루프 전부)에 상한을 걸어도
# wedge 가 그대로였다. 정적 계측이 원리적으로 못 보는 건 (a) new Function 으로
# 만든 코드 (b) **재귀**. 힙에 `Maximum call stack size exceeded` 문자열이
# 3,229개 있었으므로 (b) 가 유력하다. 재귀는 루프 상한으로 안 잡힌다.
#
# debugger-snapshot 은 데몬 메모리를 읽으므로 렌더러가 굳어도 답한다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
# 예외 폭풍이 예상되므로 샘플링. seen_total 로 실제 건수를 따로 본다.
taskweaver debugger-arm -i zp --strategy exceptions --sample-every 1 --max-frames 24 >/dev/null 2>&1
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 45
taskweaver debugger-snapshot -i zp > "$1" 2>&1
echo "wrote $1 ($(wc -c < "$1") bytes)"

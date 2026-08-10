#!/bin/bash
# wedge 를 넘어서 **요청 순서**를 본다. --record 는 데몬 메모리에 버퍼링하므로
# 렌더러가 굳어도 dump-recording 이 답한다(페이지 JS 를 안 거친다).
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 --record >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 40
taskweaver dump-recording -i zp --filter network > "$1" 2>&1
echo "wrote $1 ($(wc -c < "$1") bytes)"

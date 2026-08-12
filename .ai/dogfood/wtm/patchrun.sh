#!/bin/bash
# 헤더 보존 패치 경로의 하네스 검증/사용 러너.
# 세션 순서는 pair.sh 와 동일(직접 선행)로 고정한다.
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
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
for t in 20 35 50 65 80; do
  sleep 15
  if ! timeout 40 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
    echo "WEDGE at ~${t}s"; exit 0
  fi
done
echo "ALIVE(80s)"

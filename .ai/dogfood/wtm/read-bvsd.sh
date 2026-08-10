#!/bin/bash
# bvsd 루프 계측 결과를 **페이지에서 직접** 읽는다.
# 마커 네트워크 전달이 이 빌드에서 실패했으므로(원인 미상), 페이지가 살아있는
# 조건을 이용해 window.__BVSD 를 exec-js 로 회수한다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 32
timeout 45 taskweaver exec-js -i zp --script "
var sz = performance.getEntriesByType('resource').filter(function(r){return /27b3366/.test(r.name)}).map(function(r){return r.encodedBodySize});
var a = document.documentElement.getAttribute('data-bvsd');
if (!sz.some(function(n){return n > 100000;})) return JSON.stringify({gate:'STUBBED', sizes:sz});
return a || JSON.stringify({ bvsd: 'NO-ATTR' });" 2>&1 | tail -4

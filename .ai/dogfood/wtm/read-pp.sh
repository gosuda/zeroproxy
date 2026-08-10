#!/bin/bash
# 메인 번들이 보는 publicPath / WebAssembly 환경을 DOM 속성으로 회수한다.
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
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 28
timeout 45 taskweaver exec-js -i zp --script "
var d=document.documentElement;
var sz=performance.getEntriesByType('resource').filter(function(r){return /3e66f2/.test(r.name)}).map(function(r){return r.encodedBodySize});
return JSON.stringify({sizes:sz, pp:d.getAttribute('data-wtmpp'), wasm:d.getAttribute('data-wtmwasm')});" 2>&1 | tail -6

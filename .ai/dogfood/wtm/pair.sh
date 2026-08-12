#!/bin/bash
# 직접 로드와 프록시 로드를 **한 런 안에서 연속으로** 찍는다.
#
# 왜: 타깃이 세션 도중 바뀌었다(오전엔 직접 로드가 wtm 메인 번들을 받았는데
# 오후엔 안 받는다). 몇 시간 간격으로 잰 두 런을 비교하면 타깃 변화가
# 우리 변경으로 둔갑한다. 베이스라인은 반드시 같은 시점에 찍는다.
#
# 프록시 쪽은 굳을 수 있으므로 --record 로 띄워 dump-recording(데몬 메모리)으로 회수한다.
set -e
cd /f/git/zeroproxy/.ai/dogfood/wtm
OUT=${1:-pair}

taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
(taskweaver start --id zp --width 1200 --height 800 --record >/dev/null 2>&1 &)
sleep 40

# ---------- A. 직접 ----------
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 25
taskweaver exec-js -i zp --script "
var rs=performance.getEntriesByType('resource').map(function(r){return r.name;});
var host=function(u){ try{ return new URL(u).host; }catch(e){ return '?'; } };
var by={}; rs.forEach(function(u){ var h=host(u); by[h]=(by[h]||0)+1; });
return JSON.stringify({ alive:true, total:rs.length, body:document.body?document.body.innerHTML.length:-1,
  hosts:by, wtm:rs.filter(function(u){return u.indexOf('wtm.pstatic')>=0;}).map(function(u){return u.replace(/^.*\//,'').slice(0,28);}) });" > "$OUT-direct.json" 2>&1 || true

# ---------- B. 프록시 (바로 이어서) ----------
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 8
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1

WEDGE=""
for t in 10 20 30 40 50 60; do
  sleep 10
  # exec-js 내부 타임아웃이 30초이므로 timeout 은 그보다 길게 준다.
  if ! timeout 40 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
    WEDGE="$t"; break
  fi
done

if [ -n "$WEDGE" ]; then
  echo "PROXY: WEDGE at ~${WEDGE}s"
else
  echo -n "PROXY: ALIVE "
  taskweaver exec-js -i zp --script "
  var rs=performance.getEntriesByType('resource').map(function(r){return r.name;});
  return JSON.stringify({total:rs.length, body:document.body?document.body.innerHTML.length:-1});" 2>&1 | grep -o '{[^}]*}' | head -1
fi
taskweaver dump-recording -i zp --filter network > "$OUT-proxy-tape.json" 2>&1 || true
echo "wrote $OUT-direct.json / $OUT-proxy-tape.json"

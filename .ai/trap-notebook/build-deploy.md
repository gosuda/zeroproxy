# Build & Deploy Regressions

`scripts/build.mjs`, Cargo workspace, wasm-bindgen, 서버 시작 시 자주 깔리는 함정.

---

## 2026-05-30 — `wasm-opt -Oz` 가 feature flags 없으면 validation 실패

**Symptoms**:
```
[wasm-validator error in function 11] unexpected false:
  memory.copy operations require bulk memory operations [--enable-bulk-memory-opt]
[wasm-validator error in function 16] unexpected false:
  memory.fill operations require bulk memory [--enable-bulk-memory-opt]
Fatal: error validating input
```
`wasm-opt` 가 즉시 abort, 출력 파일 미생성. 빌드는 graceful skip 으로 진행되지만 size 최적화 누락.

**Root cause**:
rustc 1.82+ 가 `wasm32-unknown-unknown` 에 대해 **default 로 bulk-memory / sign-ext / nontrapping-fptoint / multivalue / reference-types / mutable-globals 사용**. wasm-opt (binaryen) 는 conservative — 명시적으로 enable 안 하면 validation 실패.

**Fix** ([scripts/build.mjs](../../scripts/build.mjs) `buildRustBundle`):
```js
const WASM_OPT_FLAGS = [
  '--enable-bulk-memory',
  '--enable-bulk-memory-opt',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
  '--enable-multivalue',
  '--enable-reference-types',
];
tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, src, '-o', dst]);
```
이제 zp_bundle_bg.wasm 과 zp_page_rt.wasm 둘 다 정상 통과.

설치: `npm i -D binaryen` (cross-platform, node_modules/.bin/wasm-opt 자동 link). chocolatey/brew 도 가능하지만 npm 이 일관됨.

**효과 측정** (zp-page-rt 기준):
- 크기: 18,764 B → 15,273 B (**-18.6%**)
- wrapper 경로 hot path: 514.9 → 316.6 ns/op (**-38.5%**)
- Rust LTO 가 이미 최적화한 wasm-internal 경로는 변동 미미

**Regression guard**: build.mjs 가 flags 박혀 있어 영구. wasm-opt 미설치 시 `tryRunOptional` 가 graceful skip → 빌드 자체는 안 깨짐.

**Pattern**: rustc 새 release 가 wasm feature default 변경할 때마다 flags 추가 필요. `wasm-opt --help | grep enable-` 로 후보 확인.

---

## 2026-05-29 — Upstream connection pool 누락

**Symptoms**:
- 사용자가 page 로딩이 느리다고 보고 ("멀티플렉싱이 안 되는 것 같다").
- 서버 log 에 `relay: WS upgrade request from ...` 와 `relay: target=...` 가 페이지당 200+ 개 (s.pstatic.net 같은 image CDN 으로만 100+).
- 각 fetch 가 새 TCP 연결 + (https 일 때) 새 TLS handshake + (Tor SOCKS5 일 때) 새 SOCKS5 CONNECT.

**Root cause**:
[cmd/zeroproxy-server/relay.go](../../cmd/zeroproxy-server/relay.go) 의 `bridgeRelayWS` 가 manual HTTP 1.1 로 요청 전송: `dial()` + (TLS) + `httpReq.Write(conn)` + `bufio.NewReader(conn)` + `http.ReadResponse`. 매 WS 마다 새 connection. Keep-alive 0.

페이지당 cost 추정 (이전 측정):
- TCP handshake ~50-100ms (LAN 외)
- TLS handshake ~100-300ms (CDN edge)
- SOCKS5 핸드셰이크 (Tor 모드): ~수백 ms
- 합계 페이지당 ~30+ 초 (200 requests × 평균 150ms handshake)

**Fix**:
- `relay.go` 의 manual transport 코드를 제거하고 `http.Transport` 로 교체.
- `poolForDial(dial)` 헬퍼가 dial closure 별로 `http.Transport` 를 캐시 (direct dial / Tor SOCKS5 모드 분리).
- 설정: `MaxIdleConnsPerHost=16`, `MaxIdleConns=200`, `IdleConnTimeout=90s`, `ForceAttemptHTTP2=true`, `DisableCompression=true` (SW 가 content-encoding 처리).
- `transport.RoundTrip(httpReq)` 로 호출. 같은 target host 로 가는 후속 요청이 자동으로 keep-alive connection 재사용.

**Regression guard**: TODO
- 단위테스트: relay_test 에 같은 target 으로 2회 RoundTrip 후 같은 conn 재사용 검증 (counter on dial 함수 = 1 회).

**Patterns to watch**:
- `net.Conn` 위에 manual HTTP write/read 는 keep-alive 안 됨. 항상 `http.Transport.RoundTrip` 또는 `http.Client.Do` 사용.
- WebSocket 위에서 HTTP 를 tunneling 할 때도 server 측은 target HTTP 와는 별개 — pool 가능.

**See also**: 차후 yamux 같은 client→server multiplex 까지 추가 가능 (현재는 1 WS = 1 HTTP, 서버측만 pool). 추가 작업은 별개 트랙.

---

## 2026-05-29 — 서버 `-web` 인자 함정

**Symptoms**:
- `./dist/zeroproxy-server.exe -web web -addr 127.0.0.1:18080` 실행 시 SW 가 `/__zp/zp_bundle_sw.js` 등에서 503 응답.
- 페이지가 SW 등록 실패 → controller 없음 → "Transport not ready" 에러.

**Root cause**:
build artifact 는 `dist/web/__zp/` 에 emit 되는데 서버 `-web web` 으로 띄우면 소스 디렉토리 `web/` 을 가리킴 → `__zp/` 하위 wasm-bindgen artifact 가 없음. `serveFile` 의 `os.Open` 실패 → 503.

**Fix / 회피**:
- 서버는 항상 `-web dist/web` (또는 절대 경로) 로 띄운다.
- Korean 경로 마운트 / Windows POSIX 경로 헷갈림 회피: `-web "$(realpath dist/web)"` 권장.

**Regression guard**: TODO — 서버 시작 시 webDir 안에 `__zp/zp_bundle_sw.js` 존재 확인하는 startup assertion 추가.

---

## 2026-05-29 — Windows 좀비 zeroproxy-server.exe

**Symptoms**:
- `pkill -f zeroproxy-server` 실행 후에도 `tasklist` 에 zeroproxy-server.exe 가 남아있음.
- 새 서버 띄우면 "bind: Only one usage of each socket address" 에러.

**Root cause**:
Windows 환경에서 bash `pkill` 이 일부 process 만 보냄 (nohup 으로 띄운 자식). `taskkill //F //IM zeroproxy-server.exe` 가 더 확실. `taskkill //F //PID <pid>` 로 명시적 PID 종료가 가장 안전.

**Regression guard**: N/A — 환경 함정. 작업 자동화에서 항상 `tasklist | grep zeroproxy-server` 로 확인 후 `taskkill //F //IM` 사용.

---

## 2026-05-29 — 두 개의 zeroproxy-server.exe 가 같은 포트 listen

**Symptoms**:
- `netstat -ano | grep 18080.*LISTENING` 결과에 2개 LISTENING 라인 (`0.0.0.0:18080` 와 `127.0.0.1:18080`).
- curl 결과가 일관성 없음 (옛 서버 / 새 서버 둘 다 응답).

**Root cause**:
Windows 가 `0.0.0.0:port` 와 `127.0.0.1:port` 동시 바인딩 허용. 옛 서버 (127.0.0.1) + 새 서버 (0.0.0.0) 둘 다 살아서 race.

**Fix / 회피**:
- 새 서버 띄우기 전 `taskkill //F //IM zeroproxy-server.exe` 강제.
- 항상 `127.0.0.1:18080` (구체적 IP) 사용. `0.0.0.0` 은 공유 binding 함정.

---

---

## 2026-08-20 — 닫음: taskweaver `start` 가 파이프 호출자에게 안 끝나던 문제 (0.16.1)

**무엇이었나**: `taskweaver start` 의 JSON 은 나오고 데몬도 뜨는데, **stdout 이 파이프면
명령이 안 끝났다**. 사람이 터미널에서 치면 안 보이고, `$( )` / `execSync` / CI 처럼
**프로그램에서 부를 때만** 걸린다 — "성공했는데 안 끝나는" 최악의 모양이었다.

**원인**: Rust `std::process::Command` 는 Windows 에서 `CreateProcessW(bInheritHandles=TRUE)`
를 쓰고, 이때 `Command` 에 지정한 세 핸들뿐 아니라 **부모의 상속 가능한 핸들 전부**가
자식에 복제된다(rust-lang/rust#38227). CLI 의 stdout(= 호출자의 셸 파이프)이 데몬으로
딸려 들어가 데몬이 사는 동안 EOF 가 안 왔다.

**수정**: taskweaver 0.16.1 (`c99f09e`) — 데몬 spawn 직전에 CLI std 핸들 3개의
`HANDLE_FLAG_INHERIT` 를 내린다.

**우리 쪽 실측 재확인**: `start | cat` → exit=0 / **1,764ms** (전에는 30s 타임아웃),
`OUT=$(start …)` → exit=0 / **1,447ms**. 매트릭스 47칸 전부 `ok`, 테이프 유실 0,
static-policy 108 pass — 0.16.1 에서 하네스가 그대로 돈다.

**우회책 폐기**: `</dev/null >/dev/null 2>&1 &` + 별도 `list` 확인은 더 이상 필요 없다.
그냥 부르면 된다. (`.ai/dogfood/wtm/*.sh` 의 옛 스크래치 스크립트에는 아직 남아 있는데,
스크래치라 손대지 않았다 — 복사해 쓸 때 주의.)

**★교훈 — 도구 버그를 남에게 넘길 때**:
이번 핸드오프가 그대로 수정으로 이어진 이유는 **측정과 가설을 분리해서 적었기**
때문이다. "데몬 프로세스만 죽이면 파이프가 닫힌다" 는 **측정**이고,
"`bInheritHandles` 때문이다" 는 **가설**이라고 명시했다. 그리고 **배제 목록**을 같이
넘겼다(CLI 종료 아님 / stderr 무관 / WebView2 자식 아님 / graceful stop 정상).
받는 쪽이 이미 판명난 곳을 다시 파지 않았다. 다음에도 이 형식을 쓸 것 —
증상 / 최소 재현 3종 / 결정적 증거 / 측정 / 가설(명시) / 배제 목록 / 제안.

---

## 2026-08-21 — "keep in sync" 는 부탁이지 강제가 아니다

`crates/zp-shared/src/errors.rs` 헤더에 이렇게 적혀 있었다:

> Keep this list, the JS list, and the Go list (if added) in sync.

그 주석이 붙은 채로 **세 목록이 전부 갈라져 있었다** — JS 19 / Rust 18 / Go 12.
게다가 같은 파일 안에서 테스트가 자기 배열을 따로 들고 있어 실은 네 벌이었다.

**드러난 것**:
- Rust 에 `SUBMISSION_EXPIRED` 누락 (JS/`sw.js` 는 쓰고 있었다)
- **Go 의 자기모순**: `main.go:233` 이 내는 `RTC_GATEWAY_UNAVAILABLE` 을 같은 파일의
  `sanitizeCode` 가 `POLICY_BLOCKED` 로 강등. SW 통제 여부에 따라 다른 페이지가 뜬다
- **가드를 걸자마자 새 건**: `TARGET_HTTP_FAILED` 가 어느 목록에도 없어
  `safeError` 가 접고 있었다 — 네트워크/TLS 실패가 "정책 차단" 으로 둔갑한다.
  `sw.js` 주석이 정확히 그 위험을 경고하는데 정작 코드가 목록에 없었다

**Fix**: `testdata/error_codes.json` 이 단일 소스, 세 곳이 전부 그 파일과 대조.
Rust 는 **순서까지** 본다 — 순서가 흔들렸다는 건 어느 한쪽이 손으로 편집됐다는
뜻이고, 그게 갈라지기 시작하는 지점이다.

**교훈**: 소스에서 "keep in sync" / "must match" / "parity with …" 같은 **부탁 문구**를
보면 그 자리에서 **픽스처로 바꿀 것.** 이 저장소에서 그 문구가 붙은 목록은
지금까지 예외 없이 갈라져 있었다(errors, shareurl, worker UA). 반대로 픽스처가
붙은 것(challenge, CSP)은 갈라지지 않았다.

## <a id="execjs-문맥"></a>`taskweaver wait` 는 `--id` 없이 부르면 **0초 잔다** (2026-08-26)

측정 러너가 CNN 프레임 수를 3회 연속 `3` 으로 보고했다. 같은 시점에 손으로
재면 `26` 이었다. 하마터면 "최근 커밋이 광고를 깼다" 로 멀쩡한 수정 세 개를
되돌릴 뻔했다.

원인은 제품이 아니라 **러너의 한 줄**이다:

```sh
taskweaver wait --ms 150000 >/dev/null 2>&1   # ← --id 가 없다
```

`wait` 는 `--id` 가 **필수**다. 없으면 인자 오류로 즉시 죽는데, stderr 를
`/dev/null` 로 버리고 있으니 아무 표시도 없이 **0초** 자고 다음 줄로 간다.
그래서 "클릭 후 150초 대기" 가 실제로는 "클릭 직후"였다. 실측: `--ms 45000`
이 `elapsed=1s`.

**규칙**:

- 러너에서 `taskweaver`  호출은 `-i zp` 를 빠뜨리지 않는다. 한 번 스크립트를
  쓰면 `elapsed` 를 한 번 재서 **대기가 진짜 도는지 확인**한다.
- `2>/dev/null` 로 stderr 를 버리는 순간, 오타 난 호출은 "조용한 no-op" 이
  된다. 측정 러너에서는 stderr 를 남기거나 최소한 종료 코드를 본다.

같은 러너에서 밟은 두 번째 함정: `clear-site-data` 로 SW 등록을 지운 직후
곧바로 폼을 제출하면 아직 SW 가 페이지를 제어하지 않아 클릭이 아무 데도 가지
않는다(랜딩에 그대로 남는다 — 요소 81개). `navigate → clear-site-data →
navigate → 대기` 순서로 SW 가 붙을 시간을 준다.

덧붙임: "클릭 직후 exec-js 를 던지면 랜딩(81 els), 안 던지면 부팅 문서(5 els)"
라는 A/B 도 **이 0초 대기 상태에서 얻은 것**이라, 그 자체로는 exec-js 의 문맥
규칙을 말해 주지 않는다. 대기를 고친 뒤 다시 볼 것.

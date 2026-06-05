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

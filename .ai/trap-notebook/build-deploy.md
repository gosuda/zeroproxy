# Build & Deploy Regressions

역사적 범주별 요약이며 현재 승인 사양이 아니다. 측정·통과 기록은 당시 결과이며 새 실행은 없었다. 과거 제안 테스트·구현 공백은 미검증 이력이지 현재 TODO가 아니다.

<a id="2026-05-30--wasm-opt--oz-가-feature-flags-없으면-validation-실패"></a>
## 2026-05-30 — `wasm-opt` feature flags 누락

- 원인: rustc 1.82+의 wasm 기본 기능을 보수적인 binaryen이 거부해 `-Oz` validation 실패, 출력 없이 최적화만 skip.
- 수정: [scripts/build.mjs](../../scripts/build.mjs) `buildRustBundle`에 `--enable-bulk-memory`, `--enable-bulk-memory-opt`, `--enable-nontrapping-float-to-int`, `--enable-sign-ext`, `--enable-mutable-globals`, `--enable-multivalue`, `--enable-reference-types` 명시. rustc 기본값 변경 시 flags 재검토.
- 당시 두 wasm 모두 통과; 크기·wrapper hot path 개선, Rust LTO 내부 경로 변화는 미미. `npm i -D binaryen` 설치 권장; 미설치는 `tryRunOptional`로 빌드 유지.

<a id="2026-05-29--upstream-connection-pool-누락"></a>
## 2026-05-29 — Upstream pool 누락

- 원인: [cmd/zeroproxy-server/relay.go](../../cmd/zeroproxy-server/relay.go) `bridgeRelayWS`의 수동 HTTP write/read가 WS마다 TCP/TLS/SOCKS5 연결을 새로 생성.
- 수정: `poolForDial(dial)`로 direct/Tor별 `http.Transport` 캐시, `RoundTrip` 사용. 설정은 `MaxIdleConnsPerHost=16`, `MaxIdleConns=200`, `IdleConnTimeout=90s`, `ForceAttemptHTTP2=true`, `DisableCompression=true`(SW가 encoding 처리).
- 당시 서버측만 pool, client→server는 1 WS=1 HTTP. dial counter 재사용 테스트는 당시 제안·미검증; client multiplex는 별개였다.

<a id="2026-05-29--서버--web-인자-함정"></a>
## 2026-05-29 — 서버 `-web` 오지정

- 원인: `-web web`은 소스를 가리켜 `dist/web/__zp/`의 wasm-bindgen 산출물을 못 찾음. `os.Open` 실패→503→SW controller 부재.
- 규칙: `-web dist/web` 또는 절대 경로 사용; Windows/한글 경로 혼동에는 `-web "$(realpath dist/web)"`.
- 시작 시 `__zp/zp_bundle_sw.js` 확인 assertion은 당시 제안·미검증.

<a id="2026-05-29--windows-좀비-zeroproxy-serverexe"></a>
## 2026-05-29 — Windows 좀비 서버

- 원인: bash `pkill`이 nohup 자식 등을 남겨 새 서버 bind 실패.
- 회피: `tasklist | grep zeroproxy-server` 확인 후 `taskkill //F //IM zeroproxy-server.exe`; 명시적 `//PID <pid>` 종료가 가장 안전.
- 상태: 환경 함정으로 기록, 자동 회귀 가드 없음.

<a id="2026-05-29--두-개의-zeroproxy-serverexe-가-같은-포트-listen"></a>
## 2026-05-29 — 같은 포트 이중 listen

- 원인: Windows에서 옛 `127.0.0.1:18080` 서버와 새 `0.0.0.0:18080` 서버가 함께 bind되어 응답 혼재.
- 회피: 재시작 전 `taskkill //F //IM zeroproxy-server.exe`, 구체적 IP `127.0.0.1:18080` 사용.
- 증거: 당시 `netstat`에 두 LISTENING 항목, curl 응답 불일치.

<a id="2026-08-20--닫음-taskweaver-start-가-파이프-호출자에게-안-끝나던-문제-0161"></a>
## 2026-08-20 — taskweaver `start` 파이프 종료 수정

- 원인: Windows `CreateProcessW(bInheritHandles=TRUE)`가 부모의 상속 가능 핸들을 데몬에 복제해 stdout 파이프 EOF를 막음(rust-lang/rust#38227).
- 수정: 0.16.1 (`c99f09e`)에서 spawn 직전 CLI std 핸들 3개의 `HANDLE_FLAG_INHERIT` 해제. CLI 종료·stderr·WebView2 자식 원인은 배제, graceful stop은 정상이었다.
- 당시 `start | cat`, `OUT=$(start …)` 정상 종료, 매트릭스 전체·static-policy 통과, 테이프 유실 없음. 리다이렉션 백그라운드+`list` 우회는 폐기; `.ai/dogfood/wtm/*.sh`에는 잔존. 핸드오프에서는 관측과 가설을 구분했다.

<a id="2026-08-21--keep-in-sync-는-부탁이지-강제가-아니다"></a>
## 2026-08-21 — 오류 코드 목록 불일치

- 원인: `crates/zp-shared/src/errors.rs`의 “keep in sync” 주석과 달리 JS/Rust/Go 및 별도 테스트 배열이 분기. Rust `SUBMISSION_EXPIRED` 누락, `main.go:233`의 `RTC_GATEWAY_UNAVAILABLE`을 `sanitizeCode`가 `POLICY_BLOCKED`로 강등해 SW 통제 여부별 페이지 차이 발생.
- 수정: `testdata/error_codes.json`을 단일 소스로 세 언어 대조, Rust는 순서도 검사. 동기화 부탁 대신 fixture로 강제.
- 가드 도입 때 `TARGET_HTTP_FAILED`도 전 목록에서 빠져 `safeError`가 네트워크/TLS 실패를 정책 차단으로 바꾸던 문제 발견; `sw.js` 주석만으로는 방지되지 않았다.

## <a id="execjs-문맥"></a>`taskweaver wait` 인자 누락 (2026-08-26)

- 원인: 필수 `--id` 없는 `wait`가 즉시 오류 종료하고 stderr 폐기로 숨겨짐. CNN 프레임 차이는 실제 대기 없는 러너 관측이므로 광고 회귀나 exec-js 문맥 규칙의 증거가 아니다; CNN 자체 해결을 뜻하지 않는다.
- 규칙: 호출에 `-i zp`, elapsed·종료 코드 확인, stderr 보존. SW 삭제 직후 제출도 controller 부재로 무효였으므로 `navigate → clear-site-data → navigate → 대기`.
- 후속 정정: 0.17 `wait-navigation`은 같은 URL 재탐색도 센티널 소멸로 감지. **클릭 전에** 실행해 센티널 설치를 기다려야 하며, 클릭 후에는 `SENTINEL_PLANT_FAILED`. 0.17.0의 `--to`는 URL이 맞아도 실패해 사용 금지로 기록.
- 당시 문서 교체 실측은 3~5초. 종전 20~30초 추정은 잘못된 러너 결과로 폐기; exec-js A/B 역시 독립 검증되지 않았다.

## <a id="빌드-clean-이-유일본을-지운다"></a>build clean이 유일 산출물 삭제 (2026-09-04)

- 원인: 프로필 `PIPE_TAIL_USER`→`hsng9` 변경으로 툴체인 소실. `npm run build`가 `dist/`를 먼저 지운 뒤 Go 단계에서 실패해 `dist/zeroproxy-server.exe`와 브라우저 검증 수단까지 잃음.
- 규칙: clean 전에 `go`, `wasm-bindgen`, `cargo`, `node` 확인. 당시 taskweaver는 `~/.cargo/bin`에 복사, Go는 사용자 설치; `wasm-bindgen-cli --version 0.2.122 --locked`는 Cargo.lock 버전과 반드시 일치.
- 별도 함정: 설치 후에도 셸 PATH는 낡을 수 있음. 파일시스템·`[Environment]::GetEnvironmentVariable("Path","Machine")` 확인 또는 `/c/Program Files/Go/bin` 추가. 백그라운드 빌드는 기존 파일 존재로 완료 판단하면 이후 clean에 지워지므로 **작업 완료 알림**을 기다린다.
- 변종 (2026-09-10): 툴체인이 다 있어도 **실행 중인 서버가 exe 를 잠그면** 같은 사고가 난다. clean 이 `dist/web/*` 를 먼저 지우고 `dist/zeroproxy-server.exe` unlink 에서 `EPERM` 으로 죽어, dist 가 반만 남는다. 빌드 전에 `Get-Process zeroproxy-server | Stop-Process`.
- 별도 함정: `npm run build 2>&1 | tail` 은 **tail 의 종료 코드**를 돌려주므로 실패한 빌드가 `exit 0` 으로 보인다. `set -o pipefail` 을 쓰거나 파이프 없이 실행한다. 이번에 실제로 실패를 성공으로 한 번 보고했다.
## <a id="죽은-브라우저가-전항목-통과"></a>브라우저가 죽은 채로 13분을 돌렸고 rendercheck 는 4/4 OK 라고 했다 (2026-09-10)

taskweaver 데몬이 사라진 줄 모르고(`taskweaver list` → `count: 0`) 빌드 →
측정 → rendercheck 배치를 13분 돌렸다. 결과:

```
https://www.naver.com/ | title=? | raw=? csp=? err=?
    height ? / ? = ?%   els ? / ?   aboveFold ? / ?   styleEntities ?  => OK
```

**네 사이트 전부 `=> OK`.** 판정 로직이 `?` 값을 전부 건너뛰게 되어 있어서
어떤 플래그도 발화하지 않았고, 마지막에 `[ -z "$FLAG" ] && FLAG=" OK"` 가
붙었다. 즉 **아무것도 못 잰 것이 전부 통과로 읽혔다.**

이 저장소에서 같은 부류를 이미 두 번 적어 뒀는데(빈 탐지기 결과를 성공으로 읽음,
`dump-recording` 이 안 armed 인데 빈 테이프를 조용한 페이지로 읽음) 오라클
쪽에는 안 걸려 있었다.

### 고침

판정 맨 앞에 "쟀는가" 를 둔다. 측정값 중 하나라도 비었으면 `NO_MEASUREMENT`.

```sh
for V in "$PH" "$CH" "$PE" "$CE" "$PA" "$CA"; do
  case "$V" in ''|'?') FLAG="$FLAG NO_MEASUREMENT"; break;; esac
done
```

양성 대조로 확인했다: 데몬을 내리고 돌리면 `=> NO_MEASUREMENT`, 올리고 돌리면
`=> OK`.

### 규칙

- 긴 배치를 걸기 전에 `taskweaver list` 로 `id: "zp"` 와 `renderer_ok` 를
  **먼저** 확인한다. 데몬은 조용히 사라진다.
- 측정 기반 판정기에는 반드시 **"안 쟀음" 상태**를 둔다. `OK` 와 `모름` 을
  같은 값으로 접으면 그 도구는 고장난 순간부터 영원히 통과를 보고한다.


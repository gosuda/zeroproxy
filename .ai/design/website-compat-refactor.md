# 웹사이트 호환성 리팩터링

2026-09-06 · `refactor/website-compat-ci`. 남아 있던 CI 호환성 회귀를 수정했고 `a484e7b`에서 전체 CI가 통과했다. **아래 전체 로드맵이나 모든 실사이트의 호환성 완료를 뜻하지 않는다.**
기존 함정노트의 실측은 역사다. 아래 CI 링크는 해당 run의 증거이며 후속 수정의 통과를 보장하지 않는다.

## 첫 변경과 현재 acceptance
- `web/sw.js`의 `transportFetch`에서 문서/entry/referrer와 body view를 snapshot하고 `transportFetchHop`으로 hop을 분리했다. redirect method/body/header 및 쿠키 송수신 자격을 보존한다.
- page/worker Fetch가 entry·문서 URL·credentials·mode·redirect·referrerPolicy를 전달한다. manual/error redirect와 final URL/clone/opaque 정보는 native Response identity를 유지한다.
- 실제 SW의 수정 전 회귀에서 PUT body view 범위 손실과 302의 PUT→GET 전환을 관찰했고 수정했다. 당시 경량 Node 회귀는 통과했다. 로컬 Rust/브라우저 검증으로 기록하지 않는다.
- **현재 증거:** [CI 34025734224 / a484e7b](https://github.com/gosuda/zeroproxy/actions/runs/34025734224) — Rust·Go·경량 JS·build 모두 통과, 실제 WASM 12/12 및 Chromium E2E 109/109 통과, skipped 0.
- **관측:** 같은 지연 본문 fixture에서 H1 첫 chunk는 이전 603ms에서 3.3ms로 개선됐다. WS 정상 종료 1000, 명시 종료 3001/finished, idle cancel, 부모 srcdoc 탐색과 폼 3종을 검증했다. 이전 실패·반증은 해당 함정노트에 남긴다.
- 검증된 변경: H1/H2 pull streaming·framing/decoder 검증·취소·SW body lifetime, WS handshake identity와 close 수명, Attr-node URL ingress, 가상 Window descriptor·origin 격리, 자식 realm의 guarded eval/Function, srcdoc 탐색 및 폼 직렬화. 실패를 skip/기대값 완화로 숨기지 않았다.
- 첫 변경에 문서 registry 전체·SW 복구·PSL/SameSite/partition·완전한 타깃 CORS·AST semantic 교체·realm 재설계 전체가 포함된 것은 아니다.

## 유지할 책임 경계
- Rust/WASM: `zp-shared` 정책, `zp-rewriter` OXC, `zp-htmltx`/`zp-css` 변환, `zp-kernel-bundle` SOCKS5/TLS/HTTP, `zp-transport-codec` 코덱.
- 페이지 정책은 `zp-page-rt`/`web/zp-rt.js` raw ABI, 동적 변환은 `zp-page-bundle`; SW 변환은 `zp-bundle`. 페이지 bundle에 TLS/HTTP 의존성을 넣지 않는다.
- JS는 `web/sw.js`의 브라우저 요청·상태 조정, `runtime-prelude.js`/`worker-prelude.js`/`zp-core.js`의 native 객체·실행 경계 어댑터를 맡는다.
- Go 호스트는 자산·byte-pipe·sync XHR 작업 중계·WT/RTC gateway다. 타깃 HTTP/TLS/쿠키/HTML 처리 주인으로 바꾸지 않는다. sync relay도 SW 전송을 사용한다.
- 기존 `url_surfaces.json`·응답 정책 투영(`scripts/build.mjs`), lazy kernel, `HtmlTxn` streaming/lifetime을 재사용한다. 같은 정책의 두 번째 손목록이나 새 엔진을 만들지 않는다.

## 로드맵 — 완료 선언이 아닌 변경 순서
| 단계 | 변경과 acceptance |
|---|---|
| R0 | 실제 소유 계층·지원/차단/미지원 계약 정리. 낡은 문서가 현재 코드의 권위가 되지 않게 한다. |
| R1 | 문서 identity/generation·history URL·effective base·요청 snapshot 분리. 동일 자산의 두 탭, frame, SW 재시작 후에도 올바른 문서에 귀속. URL-only Map으로 권한을 대신하지 않는다. |
| R1-S | OXC semantic scope/reference와 typed lowering. 선언/hoisting/TDZ·receiver·평가 횟수·short-circuit·Reflect·classic/module/eval 의미 보존. 네트워크 트랙과 독립 진행. |
| R2 | 요청 정책/redirect와 cookie 정책을 기존 Rust 공유 계층으로 통합. method/body view/replay·credentials·manual/error·target CORS·PSL/SameSite/partition·cookie revision을 보존. |
| R3 | canonical native realm의 설치 상태와 Document generation 분리. 첫 실행 전 격리, 중복 설치/누락 없음, native identity/brand/message source 보존. classic/module worker와 SharedWorker identity 분리. |
| R4 | URL 해석과 proxy 인코딩, first-base, module/importmap identity, 정적/동적 변환 정책 통합. raw text·entity·SVG/srcset·charset 계약은 각각 유지. |
| R5 | H1/H2 headers→body→complete/cancel/error 수명 통일. SSE/미디어 첫 바이트·bounded backpressure·즉시 취소·디코더/handle/SW lifetime 정리. |

- 한 실제 호출 경로를 끝까지 옮긴 뒤 obsolete 분기를 제거한다. 파일 이동과 동작 변경을 분리하며 신규 crate부터 늘리지 않는다.
- 모듈화 시 `scripts/build.mjs`의 문자열 조립 경계를 함께 전환하되 page/SW/worker의 classic 실행 형태와 동기 부트를 유지한다.
- R1: SW 재시작을 heartbeat가 방지한다고 가정하지 않는다. 복구 실패 시 다른 탭을 고르거나 target/server로 key·capability를 노출하지 않는다.
- R2: proxy-origin 배달용 CORS와 target-origin 허용 판정은 별개다. Domain 거절·세션 수명 변경에는 기존 IDB migration을 고려하고, 7일 TTL만 지워 로그인 상태를 잃게 하지 않는다.
- R3: descriptor 잠김과 올바른 훅 설치는 다르다. 설치 멱등성 없이 TDZ만 옮기거나 MutationObserver로 실행 전 변환을 대신하지 않는다. raw ABI memory.grow view 갱신을 보존한다.
- R4: 모듈 정규형은 referrer와 분리한다. [모듈 URL 중복 수정](../trap-notebook/rewriter.md#모듈-url-두-벌)은 GitHub React #321/에러 페이지 해결 증거가 아니다. 독자적인 세 번째 URL resolver를 만들지 않는다.
- R5: HEAD/204/304, Content-Length/chunked/EOF, gzip trailer·잘린 입력·오류 HTML 및 각 압축 형식을 구별한다. Accept-Encoding과 실제 디코더 지원을 맞춘다. HTML 종료 태그는 EOF가 아니다.
- H1 풀 연결은 정상 framing 완료에만 반환하고 cancel/error에는 폐기한다. 비HTML 원본 스트림에 HTML transformer 선택용 `X-ZP-Stream=1`을 붙이지 않는다. transport/body와 SW waitUntil 종료·취소 계약을 연결한다.
- deadline은 header/body 단계와 구분한다. [WASM timer/cancel crash 역사](../trap-notebook/LOG.md#2026-06-16-2)를 무시하고 timer future를 추가하지 않는다.
- 후순위: 응답 cache(URL·credentials·Vary·partition·변환 버전 계약 선행), TLS persona 자동 동기화, target Service Worker 완전 가상화, WT/RTC 확장. TLS/UA 정렬은 anti-bot 통과 보장이 아니다.

## 검증·메모리·CI 정책
- 로컬 8 GiB RAM/메모리 부족: Rust/Go 컴파일·build·브라우저·자동 LSP cargo check 금지. 알려진 CI 실패를 확인하려 같은 로컬 재현을 실행하지 않는다.
- 기능 agents는 검사·formatter·linter도 실행하지 않는다. Main이 변경 통합 후 필요한 경량 Node 검증만 256 MiB heap 제한·직렬로 한 번 수행하고 commit/push한다. 무거운 검증은 원격 CI에서 한다.
- `.github/workflows/ci.yml`: Rust/Go/경량 JS/build 병렬 job, artifact 기반 직렬 Chromium E2E, 로그·스크린샷 보존. 해당 commit/run 결과만 완료 근거로 삼는다.
- 기존 E1/E2 및 `test/browser/{hole-matrix,nav-matrix,storage-matrix}`, `rendercheck.sh`/`layout-probe.js`를 재사용한다. 미측정은 inconclusive이며 title/console만으로 통과시키지 않는다.
- 본문·에러 경계·첫 화면·검색/클릭/로그인·미디어 진행을 확인한다. 높이 비율은 경보이지 보편적인 절대 합격선이 아니다. 원래 사이트 오류와 proxy 오류, CSP-only 차단과 direct egress를 구별한다.
- 실사이트 직접/프록시는 같은 조건으로 순차 비교하며 taskweaver `zp` 인스턴스를 공유한다. raw DevTools 값과 리라이트된 타깃이 보는 값은 다르다. GitHub/CF/CNN 미해결은 별도 유지한다.
- source-presence 핀은 동작 근거가 아니다. 정책 fixture와 실제 prebuilt WASM, browser/wire 관찰로 판단한다. source-only 검사는 재고정하지 않는다.
- 외부 Phase 2 마스터 플랜은 이 환경에 없었다. 과거 게이트 매핑(A/B→A2·B5/B6·D7, D/E→A3/A4·B1-B3·C2·D1/D2, F→B4/B7·C1·E3)은 역사이며 최신 acceptance/통과 선언이 아니다.

## 보안 금지와 기록 정리
- strict CSP 완화, direct egress, 리라이트 실패의 원본 실행, 사이트별 빈 JSON/이미지/모듈 스텁, 성공 no-op 금지.
- 모든 window를 넓게 Proxy로 감싸기, 요청마다 문서 entry 이동, 동기 DOM getter의 SW RPC 대기 금지. 루프 예산도 조용한 정상 종료로 위장하지 않는다.
- 현재 구조는 README·실제 코드·이 변경 순서를 따른다. 제거한 옛 architecture/phase/구현 전 문서를 복구해 현재 계약으로 만들지 않는다.
- `.ai/trap-notebook/LOG.md`는 immutable raw archive, category는 원인/해결/정정 요약, INDEX는 선택 탐색이다. 과거 측정은 최신 증거가 아니며 실제 경로 확인 뒤 문서와 obsolete 코드만 정리한다.

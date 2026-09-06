# 웹사이트 호환성 중심 리팩터링 계획

작성: 2026-09-06. 상태: 첫 요청 계약 리팩터링 및 원격 CI/E2E 구성 구현. 전체 로드맵 완료 선언 아님.

## 1. 결론과 조사 범위

**파일 분할 자체보다, 브라우저 의미론을 여러 계층이 각각 재구성하는 구조를 줄이는 것이 우선이다.**

권장 순서는 `계약 정리 → 문서/요청 문맥과 AST 의미 분석 → Fetch·쿠키 → realm 수명주기·변환 경로 통합 → 스트리밍 확대`다. AST 의미 분석은 네트워크 개편과 독립적으로 시작할 수 있다. Rust/WASM 중심 구조와 strict 격리는 유지한다. DOM 객체를 다루는 JS까지 일괄 Rust로 옮기거나 새 프록시 엔진을 만드는 계획이 아니다.

- 최초 조사는 정적 열람만 수행했다. 구현 착수 시 8 GiB RAM, 약 1.2 GiB swap 사용과 약 3.5 GiB compressor 점유를 확인하여 로컬 Rust/Go 컴파일·브라우저 실행은 생략했다. Node 검증만 256 MiB heap 제한·직렬로 실행한다. 컴파일과 E2E는 브랜치 push로 CI에서 수행한다.
- 아래 코드 경로의 존재와 분기는 정적으로 확인했다. 실제 사이트 영향·성능 개선 예상은 `[INFERENCE]`로 구분한다.
- 함정노트의 실측은 **과거 기록**이지 이번 세션의 재현 결과가 아니다.
- 옛 Go WASM 구조를 기술한 `ARCHITECTURE.md`, 낡은 완료 근거의 `PHASE2_STATUS.md`, superseded `PHASE3_PLAN.md`, 구현 전 page-rt/streaming 설계 문서는 제거했다. 현재 구조는 README와 실제 코드, 구현 순서는 이 문서를 기준으로 한다. 과거 함정노트는 보존했다.
- 외부 Phase 2 마스터 플랜은 이 환경에서 찾을 수 없었다. 아래 Phase 2 gate 명칭은 이전 저장소 문서의 역사적 매핑이며, 외부 원문의 최신 acceptance나 현재 통과 상태를 의미하지 않는다.
- `.npm-cache/`, `.puppeteer-cache/`는 변경하지 않는다.

### 구현 진행 — 첫 변경 단위

- 브랜치: `refactor/website-compat-ci`.
- `transportFetch` 진입에서 문서/entry/referrer snapshot과 body view를 고정하고, hop 전송을 `transportFetchHop`으로 분리했다. redirect의 method/body/header 정책과 cookie 송수신 자격을 보존한다.
- page/worker Fetch에서 entry·문서 URL·credentials·mode·redirect·referrerPolicy를 넘긴다. error/manual redirect, final response URL/clone/opaque 정보는 native Response identity를 유지하며 전달한다.
- 이것은 R1/R2의 첫 요청 경계 변경이다. 문서 registry 전체, SW 재시작 복구, PSL/SameSite/partition, 완전한 타깃 CORS, AST semantic 교체, realm 재설계, streaming 취소는 아직 이 변경에 포함하지 않았다. R1~R5 전체가 완료됐다고 표시하지 않는다.
- 수정 전 HEAD의 실제 SW를 사용한 회귀 실행에서 PUT body view가 `!payload?` 전체로 전송되고 302 다음 hop이 GET/빈 본문으로 바뀌는 것을 확인했다. 수정 후 경량 Node suite는 46 passed / 0 failed / 0 skipped(약 0.94초). Rust나 브라우저를 로컬에서 띄우지 않았다.
- `.github/workflows/ci.yml`: Rust/Go/경량 JS/build 병렬 job, build artifact를 받은 직렬 Chromium E2E, 로그·스크린샷 업로드. E2E는 실제 upstream HTML 버튼 클릭으로 요청 계약을 검사하고 기존 E1도 실행한다. 원격 결과는 해당 커밋의 Actions run을 기준으로 한다.
- 이후 §3의 파일:행과 현재 근거는 최초 정적 조사 snapshot이다. 구현된 부분은 이 진행 기록과 현재 코드를 우선한다.

## 2. 현재 프로젝트 구조

워크스페이스는 9개 crate다(`Cargo.toml:3-13`). 온보딩의 옛 `zp-kernel` 경로와 달리 현재 커널은 `zp-kernel-bundle` 아래에 있다.

| 계층 | 현재 위치 | 책임 / 유지할 경계 |
|---|---|---|
| 공유 정책 | `crates/zp-shared` | 공유 URL, CSP, 오류, URL 정책 및 공통 데이터 |
| JS 변환 | `crates/zp-rewriter` | OXC 기반 스크립트 변환, 소스맵 |
| HTML / CSS 변환 | `crates/zp-htmltx`, `crates/zp-css` | lol_html 기반 HTML 변환과 SWC CSS 변환 |
| SW 변환 WASM | `crates/zp-bundle` | SW에 필요한 변환 바인딩 |
| 페이지 변환 WASM | `crates/zp-page-bundle` | 페이지에서 동적 실행 전에 사용하는 변환 바인딩 |
| 페이지 정책 WASM | `crates/zp-page-rt`, `web/zp-rt.js` | raw ABI 기반 페이지 정책·문자열 처리. wasm-bindgen 번들과 분리 유지 |
| 네트워크 WASM | `crates/zp-kernel-bundle` | SOCKS5 / rustls / HTTP/1.1 / HTTP/2 / yamux 및 응답 디코딩 |
| 전송 코덱 | `crates/zp-transport-codec` | 브라우저 API와 분리된 HTTP/1·SOCKS5 코덱 |
| SW 조정 계층 | `web/sw.js` | 분류, 문서·탭 상태, 요청 정책, 쿠키, redirect, 변환, 스트림 수명 |
| 페이지 / worker 어댑터 | `web/runtime-prelude.js`, `web/worker-prelude.js`, `web/zp-core.js` | 가상 브라우저 표면, DOM 훅, 네이티브 객체와 정책 사이의 연결 |
| Go 호스트 | `cmd/zeroproxy-server`, `internal/*` | 자산·런처, byte-pipe, 동기 XHR 작업 중계, WT/RTC gateway |
| 배포 조립 | `scripts/build.mjs` | WASM 분리 빌드, JS 조립, 공유 정책 투영, 콘텐츠 기반 build ID |

주요 흐름:

```text
런처 / 페이지 / worker
  → SW: client·문서 문맥 귀속, 요청 정책
  → Rust 커널: SOCKS5 + TLS + HTTP
  → Go byte-pipe → 상류
  ← 응답 메타데이터 + 본문
  → SW: redirect·쿠키·응답 정책
  → Rust HTML / JS / CSS 변환
  → 페이지 prelude: 가상 URL·DOM·실행·저장소
```

동기 XHR과 SW-less 문서는 별도 입구를 사용하지만, Go가 대신 타깃 HTTP를 처리하는 구조는 아니다. Go가 작업을 대기시키고 SW의 전송 경로를 사용한다(`cmd/zeroproxy-server/syncfetch.go:18-36`). 이 경계를 유지한다. WT/RTC는 별도 gateway 책임이다.

이미 있는 공통화를 재개발하지 않는다:

- `crates/zp-shared/testdata/url_surfaces.json`과 `scripts/build.mjs:299-324`: URL 표면 목록 및 런타임 투영.
- `scripts/build.mjs:330-342`: 응답 헤더 정책 데이터 투영.
- `crates/zp-kernel-bundle/Cargo.toml:10-16`: 무거운 전송 WASM lazy 초기화.
- `web/sw.js:2222-2301`: 기존 `HtmlTxn` 스트리밍 변환과 SW lifetime 연결.
- 최근 모듈 URL 정규형 수정: `.ai/trap-notebook/rewriter.md:2833-2903`. 중복 모듈은 고쳐졌지만, 기록상 GitHub 에러 페이지는 남았다. 같은 수정을 다시 제안하거나 GitHub의 원인이 해결됐다고 간주하지 않는다.

## 3. 우선순위와 코드 근거

### A. 문서·요청 문맥을 URL 문자열과 가변 탭 상태에서 분리 — 최우선

**현재 근거**

- `web/sw.js:21-26`: `tabs`, `clientContext`, `shareRoutes`, `resourceContext`, 제출·스트림 상태가 별도 Map이다.
- `web/sw.js:2792-2804`: client에는 문맥 복사본을 저장하고 resource 문맥은 URL을 키로 저장한다. 같은 URL 키의 다음 등록은 이전 값을 덮는다.
- `web/sw.js:2574-2583`: history 갱신은 entry를 새 객체로 교체한다. base 갱신은 다른 경로에서 entry 및 client 문맥을 갱신한다(`2610-2618`).
- `web/sw.js:2419-2427`: 탭·라우트 상태 유지에 keepalive 메시지를 사용한다. 쿠키에는 IDB 복구가 있으나 동일한 문서 상태 복구 계약은 보이지 않는다.
- `web/sw.js:1882-1900`: 서브리소스 redirect가 문서 URL을 바꾸던 문제는 이미 수정됐다. 이는 요청 상태와 문서 상태를 분리해야 하는 기존 사례다.

**변경**

1. 기존 SW 내부 모듈로 `DocumentContextStore` 책임을 추출한다. `tab`, `document/entry`, `client`, `resource`를 동일 객체로 뭉치지 않는다.
2. 문서에는 `documentId`, `generation`, `documentUrl`, `baseUrl`, `virtualOrigin`, 상위 문서, referrer policy를 분리한다. history의 URL 변경과 `<base>`의 해석 기준 변경을 다른 전이로 모델링한다.
3. 각 요청 시작 시 권한 확인된 문맥의 snapshot을 만든다. 비동기 전송 도중 `activeEntryId`를 다시 읽어 의미가 바뀌지 않게 한다.
4. 모듈 identity, 네트워크 요청 주소, referrer, 보안 capability를 구분한다. 가변 referrer를 모듈 주소에 붙이지 않는다. 반대로 모듈 URL 정규화를 이유로 탭·문서 귀속 검사를 없애지도 않는다.
5. 네이티브 태그 요청은 clientId/브라우저 referrer 경로로, runtime 요청은 검증된 문서 식별자로 귀속한다. URL-only 전역 resource Map을 권한 판정의 대체재로 사용하지 않는다.
6. SW 재시작은 heartbeat가 막아 준다고 가정하지 않는다. 브라우저 로컬 문맥 복구와 client 재결합을 설계하고, 복구 중 요청은 해당 문서만 대기하거나 명시적으로 실패한다. 다른 탭을 대신 선택하지 않는다. 암호화 링크 키·capability를 타깃 URL이나 서버에 추가 노출하지 않는다.

**완료 기준(향후)**: 같은 모듈을 정적·동적 import해도 같은 realm에서는 동일 모듈, 두 탭의 같은 자산 요청은 각각 올바른 문맥, history 직후 요청과 SW 재시작 후 요청도 올바른 문서에 귀속. `[INFERENCE]` SPA 전환·iframe·재방문 불안정을 함께 줄일 수 있다.

### B. Fetch 정책과 redirect를 전송에서 분리 — 최우선

**현재 근거**

- `web/sw.js:1011-1019`: runtime fetch POST 경계에서 method/headers/body/referrerPolicy를 전달하지만 `credentials`, `redirect`, `mode`는 전송 옵션에 보존하지 않는다.
- `web/sw.js:1592-1600`: Cookie는 URL 매칭 결과로 붙인다.
- `web/sw.js:1901-1910`: redirect 시 307/308만 method를 보존하고 나머지는 GET으로 바꾼다. 이 분기는 PUT/PATCH/HEAD 등의 의미도 바꿀 수 있다. 새 옵션 객체에 referrer override/policy 등도 전달하지 않는다.
- `web/sw.js:1377-1389`: deadline은 Promise 경합이며 커널 취소 계약은 아니다.
- `web/sw.js:1771-1775`, `crates/zp-kernel-bundle/src/kernel/mod.rs:188-202,384-395`: WASM 경계는 URL/method/headerEntries/body 중심이다. 커널 body 추출 오류는 빈 본문으로 바뀐다.
- `web/sw.js:3152-3171`: proxy 응답의 CORS 헤더 투영이 있다. 이것을 타깃 origin 사이의 Fetch 허용 판정과 같은 것으로 취급하면 안 된다.

**변경**

1. 현재 전송 입구들을 `RequestContext + RequestPolicy + Body` 계약으로 통일한다. 외부 스크립트/정적 자산/runtime fetch/XHR/sync relay는 어댑터만 다르게 둔다.
2. 순수 요청 정책은 기존 `zp-shared` 모듈에 둔다. SW는 browser Request·Headers와의 변환, 비동기 오케스트레이션만 담당한다. `JsValue`를 공유 정책 내부로 끌고 가지 않는다.
3. redirect는 별도 상태 기계로 만든다. 301/302 POST 전환, 303의 GET/HEAD 예외, 307/308 재전송, 횟수 상한, hop별 쿠키·referrer·credential 제거를 명시한다. `manual/error`도 가상 Fetch 응답 계약으로 처리하고 원본 Location을 브라우저가 따라가게 넘기지 않는다.
4. 응답에 `finalUrl`, redirect 결과, body 상태를 내부 메타데이터로 보존한다. 최종 문서 URL과 subresource 응답 URL을 분리한다. 기존 CSS-only host 치환(`sw.js:2154-2174`)은 최종 URL 해석이 통일된 뒤 제거한다. 현재 경로에서 항상 발동한다고 가정하지 않는다.
5. 타깃 기준 same-origin/CORS/opaque/credentials 처리와 proxy-origin 배달용 헤더를 분리한다. CORS 헤더 삭제나 전면 허용을 호환성 해결책으로 쓰지 않는다.
6. body를 처음에 한 번 정규화해 필요한 replay 동안만 소유한다. typed-array view의 offset/length를 보존하고, 빈 body와 body 추출 실패를 구분한다. 취소는 runtime → SW → WASM stream까지 이어지는 명시적 수명 계약으로 만든다.

**완료 기준(향후)**: 로그인 POST, PUT/PATCH redirect, HEAD, 307/308 본문 재전송, `credentials: omit`, `redirect: manual/error`, 즉시 취소가 브라우저 의미를 보존. `[INFERENCE]` API 호출·로그인·업로드 실패를 사이트별 예외 없이 줄일 수 있다.

### C. 쿠키의 사이트 경계와 저장 수명 정리 — B와 같은 우선순위

**현재 근거**

- `web/sw.js:2923-2956`: PSL 대신 짧은 접미사 휴리스틱을 사용한다.
- `web/sw.js:3015,3041,3081-3101`: SameSite를 저장하지만 전송 필터는 domain/path/secure/HttpOnly 중심이며 initiating site·method·navigation 입력이 없다.
- `web/sw.js:3023-3029`: 유효하지 않은 Domain은 cookie 전체 거절이 아니라 해당 속성만 무시하고 계속 파싱한다.
- `web/sw.js:3059-3067`: 세션 쿠키에 특정 사이트 경험을 근거로 7일 합성 TTL을 부여한다.
- 페이지 `document.cookie`와 SW jar는 메시지로 연결되어 있다(`web/runtime-prelude.js:3332`, `web/sw.js:2654` 이후).

**변경**

1. `registrable site`, origin, cookie scope, storage partition을 다른 개념으로 둔다. PSL의 ICANN/private/wildcard/exception 경계를 처리하는 검증된 데이터·구현을 선택한다. 런타임마다 원격 PSL을 받지 않는다.
2. Cookie 정책은 `zp-shared`의 공통 Rust 코드로 두고 페이지/SW에 필요한 바인딩을 투영한다. DOM 동기 게터마다 전체 jar를 직렬화해 WASM 왕복하지 않는다.
3. `CookieRequestContext`에 schemeful site, initiating/top-level site, method, navigation, credentials를 담아 전송 자격을 계산한다.
4. domain 거절, Secure/HttpOnly, SameSite, prefix 및 partitioned-cookie 정책을 명시한다. 기존 격리 정책이 표준보다 엄격한 부분은 명시적 제품 제한으로 남기고 조용한 성공으로 위장하지 않는다.
5. SW 재시작과 브라우징 세션 종료를 분리한다. 기존 IDB 데이터에 정책 버전과 migration을 두고, 7일 TTL 삭제만으로 로그인 상태를 갑자기 잃게 만들지 않는다.
6. 페이지 cookie 쓰기 직후 fetch가 같은 cookie 상태를 보도록 변경 순서·revision을 요청 계약과 연결한다.

**완료 기준(향후)**: 서브도메인 로그인 공유는 유지하고 서로 다른 사이트·partition은 섞이지 않음. cookie 쓰기 직후 요청, redirect Set-Cookie, SW 재시작을 포함한다. `[INFERENCE]` 로그인 지속성과 광고·결제 iframe의 세션 일관성에 직접 관련된다.

### D. realm 설치와 native 의미 보존을 독립 책임으로 추출 — 고위험 핵심

**현재 근거**

- `web/runtime-prelude.js:315-327`: 같은 prototype도 wrapper 신원이 달라 WeakSet 가드가 실패하는 경우를 descriptor 기반 `propertyLocked`로 방어한다. 이미 있는 방어를 단순 Set 하나로 대체하면 안 된다.
- `web/runtime-prelude.js:6479-6502`: 최초 문서의 observer 설치가 TDZ에서 조용히 반환되며, 주석에는 선언을 올리면 이중 계측 회귀가 생긴다고 명시되어 있다. **설치 멱등성이 초기화 순서보다 먼저** 해결되어야 한다.
- `web/runtime-prelude.js:6899-6928`: 부모가 about:blank 자식을 계측하는 경로와 자식 prelude가 자기 문맥으로 설치되는 경로를 구분하며, 전환 중에는 early postMessage만 설치한다. 단순한 window별 installed boolean으로 표현하기 어려운 상태 전이다.
- `web/runtime-prelude.js:6667-6677`: Worker와 SharedWorker는 같은 bootstrap URL을 쓰지만 opts는 그대로 native 생성자에 전달한다. worker 종류·module/classic·공유 identity를 별도 계약으로 다루어야 한다. blob/MediaSource를 생성 시점이 아니라 실행 sink에서 다루도록 고친 부분(`6679-6703`)은 유지한다.

**방향**

- `runtime-prelude.js`를 파일 크기 기준으로 자르지 않는다. 네이티브 참조 캡처, realm 등록, 문서 관측, DOM 변환, 동적 실행, 네트워크·저장소 표면을 책임별로 분리한다.
- 초기화 순서는 `네이티브 캡처 → 상태 생성 → 필수 훅 설치 → 검증 → 타깃 실행 허용`으로 명시한다. 실패한 realm에서 원본 코드를 실행하지 않는다.
- realm과 Document 수명은 다르다. `document.open/write`, 새 Document, about:blank/srcdoc, iframe 재탐색을 별도 전이로 다룬다.
- 같은 realm의 객체 정체성·래퍼 캐시, descriptor, receiver/brand check, `parent/top`, `postMessage source/origin`, live collection 의미를 보존한다.
- MutationObserver는 보조 안전망이다. URL 요청·스크립트 실행을 시작시키는 setter/parser 경계 이전의 변환을 대체할 수 없다.
- 모든 window/document를 더 넓은 Proxy로 감싸는 방식은 피한다. 과거 함정노트에 과도한 wrapping·예외 비용·창 사슬·O(N²) 컬렉션 문제가 기록되어 있다.
- 설치 상태를 canonical native realm별 `uninitialized/installing/ready/failed`와 문서 generation으로 나눈다. descriptor가 잠겼다는 사실과 **우리 훅이 올바르게 설치됐음**을 구별한다. observer/재탐색 등록·해제는 registry 한 곳에서 소유한다. 이 멱등성 계약을 만든 뒤 TDZ 의존을 제거한다.
- worker bootstrap은 classic/module을 분리한다. 현재 페이지는 opts를 그대로 넘기지만 bootstrap과 `worker-prelude.js:5`는 importScripts에 의존한다(`sw.js:3484`). `[INFERENCE]` module Worker는 같은 입구로는 호환되지 않는다. worker별 native 캡처와 문서 없는 URL 문맥을 명시하고, rewriter가 내보내는 helper ABI를 window/worker 양쪽에서 지원한다. SharedWorker 이름·URL·가상 origin의 공유 범위를 유지한다. target Service Worker 완전 가상화는 이 작업에 섞지 않는다.
- `web/zp-rt.js:65-99`의 raw WASM handle API와 memory.grow 시 view 갱신을 유지한다. 정책 모듈 분리가 매 DOM 접근의 문자열 복사·전체 객체 직렬화·동기 RPC 증가로 이어지지 않도록 경계를 고정한다.

**완료 기준(향후)**: 같은 문서 중복 설치 없음, 새 문서는 누락 없음, 첫 스크립트 전 격리 확보, 프레임 메시지와 조상 탐색이 정상, 정리 후 observer·wrapper가 누적되지 않음.

### E. AST 의미 분석과 URL 해석을 바로잡고 변환 경로 통합 — AST는 최우선, 통합은 D와 진행

**현재 근거**

- `crates/zp-rewriter/src/lib.rs:748-750,1012-1066`: 수동 HashSet scope stack을 사용한다. program 선수집은 function 선언만이고, 변수는 방문한 scope에 등록한다. `[INFERENCE]` 선언 전 참조·block 안 var hoisting·TDZ·import/catch binding의 의미가 달라질 수 있다.
- `crates/zp-rewriter/src/lib.rs:1165-1197`: Reflect.get/set을 일반 member get/set marker로 바꾸며 명시 receiver 인자를 marker에 보존하지 않는다. `[INFERENCE]` getter receiver·추가 인자 부작용·반환 의미의 불일치 위험이 있다.
- `crates/zp-rewriter/src/lib.rs:1530-1589`: 특정 루프 문형에 1천만 회 상한을 주입한다. 이것은 순수 격리 리라이트와 별개의 실행 의미 변경이다.
- `crates/zp-rewriter/src/lib.rs:873-930`: 자체 module resolver는 `//host`도 현재 authority 아래 경로로 처리하며 상대 경로의 빈 segment를 제거한다. 반면 HTML은 `//`에 HTTPS를 붙이고(`zp-htmltx/src/lib.rs:1240-1248`), CSS는 `url::Url::join`을 쓴다(`zp-css/src/lib.rs:44-45`). 공유 fetch URL 빌더가 있어도 **상대 URL 해석까지 공통화된 것은 아니다**.
- `crates/zp-rewriter/src/lib.rs:990-995`와 `web/runtime-prelude.js:5635`: Rust module encoder는 apostrophe를 인코딩하지만 JS는 encodeURIComponent를 사용한다. 최근 query 순서/ref 수정만으로 모든 입력의 byte identity가 보장되지는 않는다.
- `crates/zp-htmltx/src/lib.rs:83-105,620-649`: attribute용 base는 각 base 태그에서 갱신하지만 style 변환은 최초 target을 캡처한다. `[INFERENCE]` first-base 및 style/import/attribute 해석이 갈라질 수 있다.
- `web/runtime-prelude.js:6215-6249`: import map 변환은 이미 있다. 다만 주소와 scope를 query 기반 script URL로 바꾼다. `[INFERENCE]` package-prefix의 trailing slash·scope-prefix matching을 보존하는지 별도 검토가 필요하다. 미구현으로 단정하고 새 구현을 병렬로 만들지 않는다.

**방향**

1. JS 문법 변환, helper ABI, URL 결정, 실행 전달을 분리한다. 스크립트 kind별 scope·this·receiver·평가 횟수를 보존한다. 단순 parser 성공을 의미 보존으로 간주하지 않는다.
   - 수동 binding stack을 해당 OXC 버전의 semantic scope/reference 분석으로 교체한다. 먼저 식별자의 실제 binding을 결정하고, 그 결과로 필요한 표현식만 변환한다. 로컬 binding이라는 사실이 native 객체 별칭까지 안전하다는 뜻은 아니다.
   - 문자열 sentinel에 연산 의미와 절대 offset을 숨기지 말고 내부 `RewriteOp` enum으로 get/set/call/optional/assignment를 표현한다. 내부 lowering을 마친 뒤에만 외부 `Patch`를 반환한다. 중첩 patch 충돌, short-circuit, getter/argument 순서, this, Reflect receiver를 보존한다. 가능한 곳은 patch-mode와 arena 재사용을 유지하고 전체 codegen·재파싱을 기본값으로 만들지 않는다.
   - classic/module/eval/function/event-handler의 파싱·실행 환경을 구분한다. direct eval과 with는 단순 전역 helper 치환으로 동등하다고 보지 않는다.
   - 1천만 회 루프 상한은 일반 변환기에서 실행 예산 정책으로 분리한다. 상한에서 조용히 정상 종료하는 대신 명시적 실패·중단 의미를 결정하고, 기존 멈춤 방어를 대책 없이 삭제하지 않는다.
2. 정적 HTML과 동적 DOM은 같은 **정책**을 사용하되 파서는 억지로 하나로 만들지 않는다. streaming tokenizer와 브라우저 fragment parser의 삽입 문맥은 다르다.
3. 기존 `url_surfaces.json`을 확장해 속성·namespace·URL 용도와 정적/동적 경로의 coverage를 설명한다. 별도의 손목록을 만들지 않는다.
4. 모듈 specifier/import map/`import.meta.url`/modulepreload는 동일 URL identity 정책을 사용한다. 최근 수정된 정규형을 유지한다. 문서 referrer 갱신과 모듈 캐시 identity는 분리한다.
   - URL의 **해석**과 proxy 경로의 **인코딩**을 별도 API로 통일한다. 브라우저 realm은 native URL, Rust는 기존 표준 resolver 활용을 우선하고 같은 fixture 계약으로 묶는다. page bundle에 URL/ICU를 무조건 추가하지 말고 필요한 표준 처리를 adapter 경계에 배치한다. 독자적인 세 번째 축약 resolver는 만들지 않는다.
   - HTML의 effective base 상태를 attribute/style/inline module에 공유하고 first-base 및 DOM 변경 시 재계산 규칙을 명시한다. external CSS의 기준은 문서가 아니라 해당 stylesheet의 최종 URL이다.
5. raw text(`<style>`, `<script>`), attribute entity, SVG fragment, srcset, `<base>`, CSSOM, template/srcdoc은 서로 다른 입출력 계약으로 다룬다. 문자열 전체에 일괄 HTML escape/unescape하지 않는다.
6. 문자 디코딩과 압축 해제를 분리한다. `sw.js:2124-2125`의 buffered `.text()` 및 `2284`의 UTF-8 응답 고정을 고려해 BOM/charset/meta와 비 UTF-8 문서의 변환 경계를 명시한다. `[INFERENCE]` 구형·지역별 사이트의 글자·스크립트 손상 위험이 있다.

**완료 기준(향후)**: React/Vue류 hydration, webpack publicPath, 정적·동적 모듈 identity, classic 전역 선언, 동적 HTML/CSS 입력에서 의미가 유지된다. GitHub 잔여 React #321의 원인은 이 계획에서 확정하지 않는다.

### F. 스트리밍을 본문 종류와 무관한 수명 계약으로 확대 — 앞선 정책 안정화 후

**현재 근거**

- `crates/zp-kernel-bundle/src/kernel/transport/http2.rs:292-303`: 스트리밍은 2xx HTML + gzip/identity 조건이다. 나머지는 buffered arm이다.
- `crates/zp-kernel-bundle/src/kernel/transport/http1.rs:138-139`: HTTP/1은 body를 읽은 뒤 반환한다.
- `http2.rs:484-499,526-550`: underlying source에는 start pump가 있고 pull/cancel 연결은 없다. pump는 downstream 수요를 기다리지 않고 credit을 반환한 뒤 enqueue한다. 취소는 다음 enqueue 실패에서 감지한다.
- `web/sw.js:2227-2300`: HTML에는 body 완료 promise와 waitUntil 연결이 이미 있다. 이 해결을 삭제하거나 스트리밍을 새로 도입한다고 표현하지 않는다.

**변경**

1. 헤더 도착, 본문 소비, 완료, 취소, 오류를 명시한 응답 계약을 만든다. body 없는 status/HEAD는 별도 처리한다.
2. HTTP/1과 HTTP/2가 같은 소비 계약을 구현하도록 한다. SSE·미디어·다운로드 등 원본 바이트 소비 경로는 전체 buffering을 피한다. JS/CSS처럼 전체 입력이 필요한 변환기는 그 경계에서만 buffer한다.
3. bounded queue와 pull 기반 backpressure, 즉시 upstream 취소를 연결한다. 조용한 상류에서 다음 chunk가 올 때까지 취소를 기다리지 않는다.
4. br/deflate/zstd 및 오류 HTML의 streaming 확장은 디코더별 증분 지원을 확인하며 추가한다. `Accept-Encoding` 광고와 실제 지원이 다르게 되지 않게 한다.
5. phase별 deadline과 body cap을 분리한다. 작은 고정 timeout으로 느린 정상 응답을 자르거나 HTML 종료 태그를 EOF로 취급하지 않는다. 과거 WASM timer/cancel 함정을 검토하고 무조건 timer future를 추가하지 않는다.
6. decoder·transform·consumer 오류와 정상 종료 모두에서 WASM handle, observer가 아닌 stream resource, SW waitUntil 수명을 정리한다. gzip trailer/잘린 데이터의 검증 정책도 명시한다.

**완료 기준(향후)**: SSE 첫 이벤트가 연결 종료 전에 도착, 큰 미디어가 전체 다운로드 전 소비, HTTP/1 문서도 점진 표시, 소비자 속도에 따른 메모리 상한, 취소 후 상류 작업 해제. `[INFERENCE]` 저메모리 환경에서 호환성과 안정성을 동시에 개선한다.

## 4. 구현 순서와 변경 단위

| 순서 | 변경 단위 | 선행 조건 | 완료 판단 |
|---|---|---|---|
| R0 | 현재 구조·정책 계약 정리, 낡은 경로·측정 기준 식별 | 없음 | 실제 소유 모듈과 지원/차단/미지원 구분이 문서·코드와 일치 |
| R1 | A: 문서 상태와 요청 snapshot 분리 | R0 | history/base/frame/동일 자산 문맥의 일관성 |
| R1-S | E의 OXC semantic binding·typed lowering | R0 | 선언·receiver·평가 순서 보존. R1/R2와 독립 진행 가능 |
| R2 | B: Fetch·redirect 정책 + C: Cookie 정책 | R1의 문맥 계약 | method/body/credentials/site 의미 보존 |
| R3 | D: realm registry·설치 수명주기 | R0, R1의 문서 identity | 중복 설치·누락·native identity 회귀 없음 |
| R4 | E의 URL/base/importmap·변환 경로 통합 | R1, R1-S, R3 | 정적/동적 경로의 관찰 가능한 의미 일치 |
| R5 | F: streaming/backpressure/cancel | R2의 request/response 계약 | 장수 응답·큰 본문·취소·메모리 상한 |

각 변경은 한 번에 하나의 실제 호출 경로를 끝까지 옮긴다. 동작을 바꾸는 수정과 파일 이동은 분리한다. 신규 crate를 먼저 늘리지 않고 기존 crate 안에서 모듈로 경계를 세운다. JS 모듈화를 도입할 때는 `scripts/build.mjs:384-386`의 현재 문자열 조립 + `esbuild.transform`을 실제 bundling에 맞게 전환하되, 페이지/SW/worker의 classic 실행 형태와 동기 부트 순서는 유지한다.

**첫 실행 단위 추천:** runtime fetch → SW → 커널 경계에서 RequestContext를 보존하고 redirect 정책을 분리한다. 이어서 문서 navigation/정적 자산/sync relay 호출자를 같은 계약으로 옮긴다. 범위가 명확하고 method·body·credential 손실이라는 관찰 가능한 계약을 직접 개선한다. 동시에 prelude 전체를 다시 쓰지 않는다.
AST 트랙의 첫 단위는 `RewriteVisitor` binding 분석 교체다. 이후 Reflect/optional/nested lowering을 각각 별도 변경으로 옮긴다. 네트워크 경계 변경과 동일 커밋에 섞지 않는다.

후순위: HTTP 응답 캐시 재활성화, TLS persona 자동 동기화, target Service Worker 완전 가상화, WT/RTC 확장. 캐시는 URL·credentials·Vary·partition·변환 버전 계약이 정리되기 전에는 켜지 않는다. 현 response cache 비활성 분기는 `sw.js:1474-1482`에 남아 있다. TLS/UA 통합을 하더라도 원격 anti-bot 통과를 보장할 수 없다.

## 5. 호환성 판정과 이후 검증 계획

**아래는 전체 로드맵의 검증 기준이다. 첫 변경의 로컬 증거는 위 진행 기록, 컴파일·E2E 증거는 커밋별 CI run으로 구분한다.**

- 기존 E1/E2 및 `test/browser/{hole-matrix,nav-matrix,storage-matrix}`를 재사용한다. 모든 수정을 workspace 전체 빌드·전수 실사이트 실행으로 확인하지 않는다.
- Phase 2 매핑: A/B는 A2·B5/B6·D7, D/E는 A3/A4·B1-B3·C2·D1/D2, F는 B4/B7·C1·E3에 관련된다. 공통 게이트는 E1(non-escape), E2(사용자 동작), E3(비용)다.
- 작은 결정적 fixture는 요청 method/body, module identity, cookie 경계, frame message, 취소처럼 실제 결과를 비교한다. 소스 문자열이나 내부 helper 이름 존재는 호환성 증거로 사용하지 않는다.
- source-presence만 검사하던 `compat-pipeline.test.js`와 정적 문자열 핀을 제거했다. 실행 가능한 정책 회귀는 유지하고, rewriter 검사는 실제 prebuilt WASM을 실행하도록 옮겼다. 삭제된 파일명이나 Chrome 버전을 새 값으로 재고정하지 않았다.
- `.ai/dogfood/wtm/rendercheck.sh`의 기존 layout probe를 정식 audit 경로에 통합한다. 미측정값 `?`가 있어도 `OK`가 될 수 있는 현재 분기(`66-73`)를 `inconclusive`로 구분한다. 원본에도 있을 수 있는 문자열·CSS 에러를 단독으로 프록시 결함이라고 판정하지 않는다.
- 단순 title/console 성공은 불충분하다. **본문·에러 경계·첫 화면 레이아웃·검색/클릭/로그인 흐름·미디어 진행**을 본다. 높이 비율은 경보이지 모든 사이트에 적용할 절대 통과 규칙이 아니다.
- 격리 실패(직접 egress), CSP가 막은 변환 누락, 사이트 원래 오류, 프록시 유발 오류를 서로 다른 결과로 기록한다. raw DevTools 값과 리라이트된 타깃 코드가 보는 값을 구별한다.
- 실사이트는 자원이 있는 환경에서 직접/프록시를 같은 조건으로 순차 비교한다. NAVER(폼·세션·iframe), GitHub(React·모듈·에러 경계), Wikipedia(동적 자산), CNN(프레임·CSS·미디어)을 대표로 삼고 필요한 사이트만 선택한다. 알려진 변동 사례는 반복 확인하되 같은 taskweaver `zp` 인스턴스에서 동시 프로브를 돌리지 않는다.
- 무거운 build/E2E는 준비된 별도 환경에서 배치 단위로 한 번 수행한다. 로컬 정적 조사 중 실행하지 않는다.

## 6. 금지할 단순화와 최종 정리

- strict CSP 완화, 리라이트 실패 시 원본 실행, 사이트별 빈 JSON/이미지/모듈 스텁으로 성공률 올리기 금지.
- native API 지원 여부를 성공 no-op으로 위장하지 않는다. 제한을 바꾸는 작업은 호환성 계약과 보안 허용 범위를 함께 결정한다.
- TDZ 위치만 옮기기, 모든 window를 Proxy로 감싸기, MutationObserver에만 기대기, 문서 entry를 요청마다 갱신하기 금지.
- 페이지 bundle에 커널/TLS/HTTP 의존성을 넣지 않는다. 동기 DOM getter를 위해 SW RPC를 기다리지 않는다.
- Go를 타깃 HTTP/TLS/HTML 처리의 새 주인으로 만들지 않는다.
- 향후 구현을 해당 경로에서 확인한 뒤 obsolete 분기·legacy helper·임시 계측을 걷고 README·이 진행 계획·함정노트를 실제 구현에 맞게 갱신한다. 제거한 옛 스펙을 다시 현재 계약으로 되살리거나 과거 측정을 최신 증거로 덮어쓰지 않는다.

정적 분석만으로 특정 사이트의 현재 고장 원인이나 개선율을 확정할 수는 없다. 이 계획의 산출물은 **호환성 결함이 반복되는 책임 경계를 줄이는 변경 순서와 의미 보존 계약**이다.

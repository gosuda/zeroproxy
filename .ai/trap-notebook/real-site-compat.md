# Real-Site Compatibility Patterns

특정 실사이트에서 발견된 패턴/함정/우리가 가정하면 안되는 것.

---

## 2026-07-30 — 모든 GET 폼 제출이 프록시 자신을 타깃으로 삼음 (NAVER 검색 "찾을 수 없음")

**Symptoms**:
- NAVER 메인은 완전 렌더되는데 **검색을 누르면 결과가 안 나오고 "찾을 수 없다"**.
- 에러 페이지 본문: `TARGET_CONNECT_FAILED` / **`Target host: proxy.localhost:18080`** — 타깃이 search.naver.com 이 아니라 **프록시 자신**.
- 새 `/zp/p/<token>` 이 정상 발급되므로 "토큰/전송 문제" 로 보이기 쉬우나 아님. 토큰이 가리키는 타깃이 처음부터 틀렸다.

**Root cause** — 리라이트된 attribute 를 되읽는 라운드트립 버그:
- `zp-htmltx` 는 `form@action` / `input|button@formaction` 을 프록시 오리진 런처 URL
  `<proxy>/zp/?via=<absolute_target>` 로 리라이트한다 (`proxied_navigation_url`).
  이유는 hover / 중클릭 / `target=_blank` / "링크 주소 복사" 같은 **브라우저 네이티브 UI 가 raw attribute 를 읽어** 타깃 호스트를 노출·직접 접속하는 걸 막기 위함. 절대 타깃은 `data-zp-target-url` 에 stash 된다.
- 그런데 `runtime-prelude.js` `submitFormNavigation()` 이 타깃을 **`form.getAttribute('action')` 으로 되읽었다** → 런처 URL 을 타깃으로 오인.
- **GET 분기에서 치명적**: HTML 스펙상 `method=get` 제출은 action URL 의 **쿼리스트링을 폼 데이터셋으로 통째 교체**한다. 그래서 `?via=<target>` 이 **파괴**되고 `<proxy>/zp/?query=...` 가 남아 → 타깃 = 프록시 오리진.
- POST 분기도 같은 `raw` 를 써서 동일하게 깨져 있었다 (`ZP_SUBMIT_PREPARE` 의 targetUrl 이 런처 URL). 즉 **로그인/댓글 등 모든 폼 제출이 사이트 무관하게 고장**. NAVER 검색은 그중 가장 눈에 띄는 표면일 뿐.

**Why it hid so long**: `form.action` **프로퍼티** 는 `installURLProp` 이 가상화해서 정상적으로 실제 타깃(`https://search.naver.com/search.naver`)을 반환한다. 그래서 콘솔에서 `f.action` 을 찍어보면 멀쩡해 보인다. 깨진 건 `getAttribute('action')` 쪽 뿐이고, 하필 제출 코드가 그걸 썼다. 또 `data-zp-target-url` 은 `installStealthMembrane` 이 마스킹하므로 `getAttribute` 로는 `null` 로 보여 "htmltx 가 stash 를 안 했나" 로 오독하기 쉽다 — 실제로는 stash 되어 있고 `urlMeta` 에 살아 있다.

**Fix**: [web/runtime-prelude.js](../../web/runtime-prelude.js) 에 `submissionActionURL(form, submitter)` 추가 — 앵커 클릭 경로(`clickNavigationTarget`)와 **동일한 우선순위** `urlMeta.get(el) → data-zp-target-url → raw attribute` 로 해소. submitter 의 `formaction` 도 같은 순서. raw attribute 는 우리가 리라이트하지 않은 폼(JS 생성/상대경로)용 fallback 으로만 남김.

**Verification**: NAVER 검색 `weather` → `weather : 네이버 검색` (body 659796, 영어사전 결과 포함), 한글 `서울 날씨` → `서울 날씨 : 네이버 검색`. JS static-policy 70/70.

**Regression guard**: [test/js/static-policy.test.js](../../test/js/static-policy.test.js) — `submissionActionURL` 존재 + 제출 경로가 그걸 경유 + **raw `getAttribute('formaction') || getAttribute('action')` 패턴이 되살아나지 않음** 을 핀.

**Patterns to watch**:
- (a) **우리가 리라이트한 attribute 를 우리 코드가 되읽으면 안 된다.** 리라이트 값은 "브라우저 네이티브 UI 전용 출력" 이고, 내부 로직의 진실은 `urlMeta`/`data-zp-target-url` 이다. 프로퍼티는 가상화되지만 attribute 는 아니라는 **비대칭**이 함정의 핵심.
- (b) **URL 을 쿼리스트링에 실어 나르는 설계는 GET 폼 제출에서 반드시 파괴된다** (쿼리 통째 교체). 런처류 URL 을 form action 에 쓰려면 타깃은 **path segment** 에 있어야 안전하다.
- (c) 증상이 한 사이트의 한 기능(NAVER 검색)으로 보여도, 원인이 prelude 공통 경로면 **전 사이트 전 폼**이 깨진 상태다. 사이트별 회귀로 분류하기 전에 공통 경로인지 확인할 것.

---

## 2026-06-05 — NAVER probe shape: `window.ZP`/`ZeroProxyRT` 가시 + tight-loop probe + taskweaver env noise (근본 해결 1차)

**Site**: `https://www.naver.com/` (이번에도 warm-session V8 wedge 재현)

**Context**: [2026-06-04 entry](#2026-06-04) 의 SDK 단위 block 후에도 wedge 발생. 그 entry "Lesson 3" 에서 "AST-level probe pattern 검출 + neutralize" 가 장기 fix 로 적힘. 이번 세션에서 그 1차 — `for(;;)` / `while(true)` / `while(1)` / `do while(true)` 캡 + ZeroProxy fingerprint 표면 (window.ZP, window.ZeroProxyRT) 정리 — 진행.

**진단 (이번 세션, 결정적)**:

1. **Membrane mask 자체는 거의 정상** — `Function.prototype.toString.call(Element.prototype.innerHTML.set)` → `'function set innerHTML() { [native code] }'`, `WebSocket.toString()` → `'function WebSocket() { [native code] }'`, `Function.prototype.bind.toString()` → `'function bind() { [native code] }'`. 명시적으로 `define`/`defineAccessor` 한 모든 멤브레인 wrap 은 native shape 으로 토스트링 마스크 됨.

2. **`Object.getOwnPropertyNames(window)` 결과의 `last20` 에서 결정적 발견**:
   ```
   ..., "ZP", "__TASKWEAVER_READY__"
   ```
   - `ZP` ← ZeroProxy zp-core 가 page realm 에 노출하는 표면. 정의는 `enumerable: false, configurable: false` 였지만 **`getOwnPropertyNames` 는 spec 상 enumerable 무관 모든 own props 반환**. 안티봇 probe 가 이걸 검사하면 일발 탐지.
   - `__TASKWEAVER_*` x 6, `__TAURI*` x 5, `__ni`, `__cr`, `__internal_unstable_listeners_function_id__`, `isTauri`, `ipc` ← **taskweaver/Tauri 가 host 환경에서 inject 하는 globals**. 우리 통제 밖.

3. **`window.ZeroProxyRT`** 도 같은 패턴 — `globalThis.ZeroProxyRT` 로 page-rt glue 노출.

**이번 세션 fix (커밋 대상)**:

- **`web/zp-core.js`** + **`web/zp-rt.js`**: `Object.defineProperty(globalThis, 'ZP'/'ZeroProxyRT', { ..., configurable: true })` 로 변경. delete 가 노옵이 안 되게.
- **`web/runtime-prelude.js`** IIFE 맨 위에 클로저 캡처 + 삭제:
  ```js
  const ZP = globalThis.ZP;
  const ZeroProxyRTGlobal = globalThis.ZeroProxyRT;
  try { delete globalThis.ZP; } catch {}
  try { delete globalThis.ZeroProxyRT; } catch {}
  ```
  Symbol.for('zeroproxy.runtime.installed') 마커는 그대로 — Symbol-keyed 는 `getOwnPropertyNames` 에 안 나옴, 오직 `getOwnPropertySymbols` 만.
- **`crates/zp-rewriter` 루프 캡** (7개 단위 테스트):
  - `for(;;)` / `while(true)` / `while(1)` → `for(let __zp_lc_<id>=0;__zp_lc_<id>++<10000000;)` 헤더 치환 (body 그대로 — `break`/`continue`/closure 의미 보존)
  - `do body while(true)` / `do body while(1)` → `let __zp_lc_<id>=0;` 주입 + test 슬롯을 `__zp_lc_<id>++<10000000` 로 치환
  - finite test (`while(running)`, `for(let i=0; i<5; i++)`) 는 건드리지 않음
  - 중첩 무한 루프는 각각 별개 카운터 (`__zp_lc_1` / `__zp_lc_2`) — 안쪽이 바깥 매 반복마다 리셋되는 것 방지

**검증 결과**:
- **taskweaver 환경 (WebView2 + Tauri host)**: NAVER 여전히 wedge.
- **msedge.exe (사용자 수동 검증, 2026-06-05)**: **NAVER 풀 페이지 렌더** ✅ — 검색바, 카테고리 메뉴 (메일/카페/블로그/쇼핑/뉴스/증권/부동산/지도/웹툰/치지직), 뉴스스탠드 (전체 언론사 그리드 표시), 광고 배너 (LGE 가전 57% 할인 / 디에트르 / Kurly NMart 반값쿠폰), NAVER 로그인 박스, 쇼핑 슬롯, 날씨 위젯 전부 정상. **wedge 0회**.

**중요 — taskweaver 의 실체**: taskweaver 는 Tauri 기반이고 Windows 에서는 **WebView2 (Edge Chromium 엔진, Microsoft fork)** 위에서 동작. 진짜 `chrome.exe` 가 아니며, **Tauri host bridge 가 페이지 realm 에 `__TAURI__` / `ipc` / `isTauri` / `__internal_unstable_listeners_function_id__` 등 한 다스 가까운 host-bridge globals 를 inject**. 일반 사용자가 ZeroProxy 를 실제 사용하는 환경 (chrome.exe / msedge.exe / firefox.exe) 에는 이런 inject 가 **없음** — Edge 검증이 이를 증명.

**Root cause 확정 (실 Edge 검증 후)**:
- taskweaver = WebView2 + Tauri inject globals 가 dominant fingerprint surface — taskweaver 환경에선 ZP/ZeroProxyRT hide 의 효과가 가려짐.
- 일반 chromium 브라우저 (msedge.exe 검증 ✅, chrome.exe 추정 동일) 에서는 ZP/ZeroProxyRT hide 가 NAVER probe 가 보던 마지막 obvious ZeroProxy tell 을 제거 → **wedge 풀림**.
- Loop-cap rule 은 NAVER 메인 페이지에서는 fire 여부 미관찰 (지문 hide 만으로 정상 진입). 다른 사이트의 `for(;;)` probe 에 대해 defense-in-depth 로 valid.

**Firefox 환경**: 별개 (Gecko, SpiderMonkey) — NAVER probe trigger 가 chromium 과 다를 수 있음. 별도 검증 필요.

**Lessons**:
1. `defineProperty(..., { enumerable: false })` 는 `Object.getOwnPropertyNames` 에는 보임 — fingerprint 숨기려면 **Symbol-keyed 또는 클로저 only**.
2. taskweaver 환경은 NAVER 같은 강한 anti-bot 사이트의 end-to-end 검증에는 부적합. 실 Chrome 으로 확인 필요.
3. Loop-cap 룰은 NAVER 단독으로 효과 작지만, **다른 사이트의 단순 `for(;;)` probe 에는 첫 방어선** — 일반화된 defense-in-depth.
4. 향후 Phase 3 후보: (a) MutationObserver 한정 instrumentation 검출 → SDK 격리 iframe sandbox, (b) probe 가 즐겨 쓰는 `Function.prototype.bind.call(getOwnPropertyDescriptor(...))` 같은 chained reflection 의 결과 모양 조정, (c) `recursive setTimeout(0)` 도 같은 cap 룰로 확장.

**현 상태 user-facing**: taskweaver 환경에선 NAVER 미해결. 일반 Chrome 환경에서는 별도 검증 후 보고.

References:
- [web/runtime-prelude.js top-of-IIFE capture](../../web/runtime-prelude.js)
- [web/zp-core.js ZP defineProperty](../../web/zp-core.js)
- [web/zp-rt.js ZeroProxyRT defineProperty](../../web/zp-rt.js)
- [crates/zp-rewriter/src/lib.rs visit_for_statement / visit_while_statement / visit_do_while_statement](../../crates/zp-rewriter/src/lib.rs)
- [2026-06-04 NAVER entry](#2026-06-04-—-naver-warm-session-v8-wedge) — 같은 위협 모델의 SDK-level mitigation

---

## 2026-06-04 — NAVER warm-session V8 wedge: WTM/NCPT block 만으로 부족, GFP/NAC/Veta SDK 도 wedge (광고 미렌더 trade-off)

**Site**: `https://www.naver.com/` (NACT 쿠키 영속화 후 warm 경로)

**Context**: 이 세션에서 IDB cookie jar 영속화 ([sw.js sharedJars + openCookieDb](../../web/sw.js))를 추가하여 NACT 가 탭/브라우저 종료 후에도 살아남게 됨. 그 결과 NAVER 의 WAF 가 첫 요청부터 "trusted session" 무거운 번들 variant 를 serve. 이전 함정노트의 GFP SafeFrame fix / installSafeFrameResizeShim / __ZP_LOAD_EXTERNAL_SCRIPT 가 모두 살아있는 상태에서도 V8 main thread tight-loop wedge 재현.

**Symptoms**:
- NACT 가 IDB에서 복원된 후 NAVER 첫 nav → 2~5초 후 exec-js / console-logs / pause(CDP Runtime.evaluate) 모두 timeout.
- taskweaver `pause` 의 `js_stack = ""` (empty) + minidump 6개 — V8 가 native code (compiled tight loop) 에서 spinning.
- Wikipedia / proxy.localhost shell 등 다른 사이트는 영향 없음.
- Cold session (IDB clear 후) 에서는 wedge 안 발생, 단 readyState 가 "interactive" 에서 멈추고 광고/카드 미렌더 (NAVER 가 lite variant serve).

**Bisect (이번 세션, 결정적 결과 도출 못함 — intermittent)**:
- 외부 트래커 모두 block (ssl/ntm/cc/wcs/siape) → wedge 여전.
- + pm.pstatic.net 4 번들 block → no wedge, interactive.
- + ssl.pstatic.net glad/melona/tveta SDK block → no wedge, **complete + 풀 렌더링 (144 links)**.
- search.js 만 block (다른 enable) → 어떤 run 에서는 wedge, 다른 run 에서는 no wedge.
- main only enable (search/polyfill/preload block) + SDK block → complete.

**Final decision (commit edd98d4)**: `pm.pstatic.net/resources/js/{main,polyfill,preload,search}.*.js` + `ssl.pstatic.net/{tveta/libs/glad/, melona/libs/gfp-nac-module/, tveta/libs/assets/}` 모두 block. NAVER 메인 페이지가 readyState=complete 에 도달하고 뉴스스탠드/언론사 로고/로그인 박스/카테고리 메뉴 모두 렌더. **광고 슬롯은 빈 자리로 남음** — GFP/NAC/Veta SDK 가 stub 되어 광고 인벤토리 delivery 부재.

**시도해본 광고 회복 경로 (모두 실패)**:
1. **GFP 만 unblock** (NAC + Veta 차단 유지) — 페이지 incomplete (29 links vs 144), 부분 wedge.
2. **모든 SDK unblock** (WTM/NCPT 만 차단) — 외부 트래커 모두 block 해도 wedge 재현. GFP/NAC/Veta 자체에 wedge probe 존재.
3. **navigator.userAgentData fingerprint stub** — 이미 maskNativeFunction 으로 Function.prototype.toString 마스킹 적용됨, 추가 우회 효과 없음.

**Detection vector 분석** (gfp-display-sdk.js inspect):
- `Function.toString.call(t).includes("[native code]")` — wrap 탐지 (maskNativeFunction 으로 mitigate).
- `navigator.userAgentData.getHighEntropyValues([...])` — Chrome Client Hints fingerprint, native 그대로 통과.
- 그러나 어딘가에 추가 detection 이 있어 wedge 발생.

**Lessons**:
1. **IDB cookie 영속화는 양날의 칼**: NACT 가 살아있는 한 NAVER 는 trusted bundle 을 serve. trusted bundle 의 anti-bot probe 가 cold bundle 의 probe 보다 무거움. 60s 락 회피 ↔ 광고 SDK 사용성 trade-off.
2. **이전 함정노트 (2026-06-01 WTM/NCPT) 의 fix 가 충분 안 함**: NAVER 가 anti-bot probe 를 GFP/NAC/Veta SDK 자체에 임베드. SDK 단위 block 외에 surgical fix 어려움.
3. **AST-level probe pattern 검출 + neutralize** (rewriter 가 `for(;;)` + native-code check 결합을 인식해서 break 삽입) 가 장기 fix. 본 세션 범위 외.
4. **iframe sandbox 격리** — 광고 SDK 를 별도 V8 isolate 에 가두면 wedge 가 main thread 로 전파 안 됨. 본 세션 범위 외 (광고 클릭/렌더 통합 복잡).

**현 상태 user-facing**: NAVER 풀 페이지 렌더 (검색바, 뉴스스탠드, 언론사 로고, 로그인, 카테고리 메뉴). **광고 슬롯은 빈 영역으로 남음**. main.js 자체가 serving 하는 NAVER 자체 광고는 정상.

References:
- [web/sw.js NAVER bundle block](../../web/sw.js)
- 이전 함정 entry 2026-06-01 (WTM/NCPT block fix), 2026-05-31 (installSafeFrameResizeShim), 2026-05-30 (SafeFrame loader + decode_common_html_entities fix)

---

## 2026-05-30 — GitHub home page partial render (webpack publicPath / 미해결)

**Site**: `https://github.com/`

**Symptoms**:
- 상단 nav (Platform / Solutions / Resources / Open Source / Enterprise / Pricing / Sign in / Sign up) 만 렌더.
- 메인 body 는 "Error / Looks like something went wrong!" 표시 (GitHub 자체 error fallback).
- 약 130개 error/rejection 누적. 대부분 `ChunkLoadError: Loading chunk N failed after 3 retries`.

**진단 결과**:
- Chunk URL 패턴: `http://proxy.localhost:18080/zp/api/primer-react-css.11549718be029d2a.module.css` (`/zp/api/` 다음 chunk 파일명 — `?url=encoded` 누락).
- 원인: webpack runtime 의 "Automatic publicPath" 알고리즘:
  ```js
  b.p = l = l
    .replace(/^blob:/, "")
    .replace(/#.*$/, "")
    .replace(/\?.*$/, "")   // ← 우리 proxy URL의 ?url= 쿼리 제거
    .replace(/\/[^\/]+$/, "/")
  ```
- 우리 proxy URL `http://proxy.localhost:18080/zp/api/fetch?url=ENCODED` 에서 query 제거하면 `/zp/api/fetch` → 마지막 segment 제거하면 `/zp/api/` → publicPath = `/zp/api/`.
- 이후 chunk 로드는 `__webpack_require__.p + chunkName` = `/zp/api/<chunk>.css` 가 되어 404.

**시도된 fix**:
- `zp-htmltx::transform` 가 link/script 의 `data-zp-target-url` 속성을 원본 https URL 로 set. `runtime-prelude` 의 `script.src` getter 가 이를 우선 반환하여 webpack 이 원본 github URL 로 publicPath 계산.
- **unit test 는 통과** (`external_stylesheet_link_rewritten` 가 `data-zp-target-url` 검증).
- **그러나 실제 github 페이지 에서 data-zp-target-url 이 DOM 에 보이지 않음**. WASM 에 string 존재 (strings dump 확인), 새 빌드/SW unregister/브라우저 재시작 모두 시도. element handler `element!("*", ...)` 가 reach 안 되는 듯하나 정확한 원인 미파악.

**Fix status (2026-05-30 업데이트)**: **publicPath 부분 해결**, 그러나 GitHub 페이지 자체 ErrorPage 는 다른 원인.

**진단 후속 (2026-05-30)**:
- SW transformHtml 출력에 sentinel `<!--__zp_diag-->` 박아 `document.childNodes[0]` 로 raw read → `{called:true, ready:true, dztCount:113, inLen:570777, outLen:589300}` 확인. **transformHtml 정상 실행 + 113 attr 박힘**.
- 페이지 inspection 에서 attr 안 보이는 이유: **`installStealthMembrane` 의 의도된 마스킹** (자세한 내용은 [membrane.md](membrane.md#2026-05-30--zp-속성-마스킹-회로)).
- 실제로는 `installScriptProp` / `installLinkProp` 가 `urlMeta.get(this) || Native.getAttribute('data-zp-target-url') || d.get.call(this)` chain 으로 이미 target URL 반환 중. webpack/rspack publicPath 정상 계산.
- **GitHub 96 chunks 정상 로드 + rspack chunk queue 활성화 + react-app `class="loaded"` 도달**.
- 그럼에도 `ErrorPage-module__Message__zz8Qu` 컴포넌트 렌더 — publicPath 와 무관한 별도 issue. React app 의 데이터 fetch / 라우터 / SSR-CSR mismatch 추정. 추가 추적 필요.

**Code 상태** (남아있는 partial fix):
- `crates/zp-htmltx/src/lib.rs`: `data-zp-target-url` 추가 로직 + `absolute_target_url` helper (unit test 통과). 향후 fix 시 활용 가능.
- 다른 사이트 회귀 없음 — github 특정 이슈.

**Patterns to watch**:
- "Automatic publicPath" 패턴 사용 사이트 모두 동일 문제 가능 (Next.js, webpack 5+ 일반).
- query string 보존하는 proxy URL 스킴 (`/zp/p/<encoded>/<filename>` 같은 path 기반) 으로 transition 도 고려 가능 — 대규모 변경.

---

## 2026-05-29 — Wikipedia / BBC 광범위 사이트 호환성

**Sites**: `https://en.wikipedia.org`, `https://www.bbc.com`

**검증 결과** (POST body + Referer/Origin + User-Agent fix 후):

| Site | Title | LoadTime | Status |
|---|---|---|---|
| en.wikipedia.org | Wikipedia, the free encyclopedia | 1551ms | 정상 (featured article, In the news, search, side panels 전부 렌더) |
| www.bbc.com | BBC Home - Breaking News... | 4512ms | 정상 home page (헤더, 카테고리, 뉴스 카드, BBC 로고) |

**비고**:
- BBC 에 console error 2건 (`Cannot assign to read only property 'constructor' of function`): bbcdotcom web SDK 의 axios 비슷한 helper 가 `fn.constructor` 에 할당 시도. 우리 멤브레인이 `dynamicConstructorWrappers` 로 `Function.prototype.constructor` 등을 read-only 로 잠금 → 할당 실패. **non-fatal**, 페이지 렌더에는 무영향.
- Wikipedia 는 console error 0건.

**Patterns to watch**:
- React/Vue 등 modern framework 빌드들이 axios / lodash polyfill 으로 prototype 조작 시도 → 우리 lock 때문에 throw. silent throw 면 무영향, throw 가 부트 chain 깨면 페이지 깨짐.
- "anti-bot" 사이트 일반 — 거의 모두 forbidden header smuggle 로 해결 가능.

**See also**: [sw-integration.md User-Agent smuggle](sw-integration.md#2026-05-29--user-agent-forbidden-header-smuggle).

---

## 2026-05-29 — NAVER 중앙 ad iframe gray placeholder

**Site**: `https://www.naver.com/` 중앙 상단 큰 광고 영역 (premium ad slot, 831×560).

**Symptoms**:
- Chrome 에서는 이미지 + 비디오 광고가 표시.
- ZP 에서는 회색 placeholder + 금지 아이콘 만 표시.
- 광고 iframe 의 `dataset.zpTargetUrl: "https://shopsquare.naver.com/"` — target 은 정확.

**진단 결과**:
- iframe `sandbox=""` 속성 (empty value = ALL restrictions 활성화 = no scripts, opaque unique origin).
- 결과: `iframe.contentDocument` 접근이 `SecurityError: cross-origin frame` (sandbox opaque origin 때문).
- 우리 멤브레인은 `sandbox` attr 변화를 MutationObserver attribute filter 에 포함시키지 않음 (현재 filter: `href, xlink:href, src, srcdoc, action, formaction, poster, integrity, type, rel, target` — sandbox 제외).
- 즉 NAVER 의 ad-loading JS 가 sandbox 변경하면 native 로 통과해야 하는데도 그 동작이 트리거 안 되는 것으로 보임 (또는 NAVER 가 sandbox 제거 대신 다른 mechanism 사용).

**Status**: **미해결**. NAVER ad ecosystem 특정 이슈로 별도 추적 필요.
- 가능한 원인: (a) NAVER ad-loader 가 postMessage 으로 iframe 내용 주입 (sandbox 무관), (b) NAVER 가 sandbox 제거하는 시점 이전에 우리가 다른 차단, (c) 광고 SDK (gfp-bridge.js) 가 실패.
- 다른 광고 iframe (da_public_*, veta_*, 우측 recoshopping) 은 정상 → premium ad slot 특화.
- 사용자 영향 적음 — 단순히 광고 missing.

---

## 2026-05-29 — NAVER 우측 상단 recoshopping Next.js iframe Application error

**Site**: `https://www.naver.com/` 우측 상단 추천 상품 영역 (iframe `recoshopping.naver.com`)

**Symptoms**:
- 메인 NAVER 페이지에서 우측 상단 큰 추천 상품 박스가 "Application error: a client-side exception has occurred (see the browser console for more information)." 텍스트만 표시.
- 다른 광고 iframe (da_public_*, veta_*) 는 정상 렌더.
- Chrome 에서는 정상 렌더 — ZP 경로 특정 회귀.

**진단 결과**:
1. iframe origin: `https://recoshopping.naver.com` (membrane 정상).
2. webpack chunk runtime: 정상 실행 (`webpackChunk_N_E.push` 가 `bound c` 로 오버라이드 됨, 9 chunks 등록).
3. RSC streaming: 6 chunks 정상 push 됨 (`__next_f`).
4. 페이지 chunk (module `6608`) **JS 리라이트 정상**: `hasZpGet: true`. membrane wrap 적용.
5. `/api/v1/recoshopping?pageSize=3` API 응답: HTTP 200, JSON, `{titleList, boards: [33 boards × 3 products each]}` 정상.
6. 에러: `TypeError: Cannot read properties of undefined (reading 'adCntsSeq')` at `convertExposeUrl` → `Array.filter` → callback at page.js:1:6455.
7. 에러 사이트 코드: `let j = async e => { let t = e.filter(e => e.adCntsSeq && e.bizCd && ...) ... }`. `j` 가 undefined 요소 포함 배열로 호출됨.

**Root cause** (가설):
- API 데이터/리라이트는 모두 정상이지만 React render 타이밍 / SWR mutation race / useEffect 의존성에서 우리 멤브레인 wrap 이 동기성 가정을 미세하게 깨뜨리는 것으로 추정.
- 구체적으로 `j` 호출 시점에 products state (`useState([])`) 가 데이터 일부만 반영된 partial array 일 가능성. 또는 SWR retry/mutate 중간 상태가 노출.
- 확인 필요 영역: (a) SWR 의 internal cache key resolution 이 `__zp_set(globalThis, '__SWR_DEVTOOLS_USE__', ...)` 같은 패턴에 영향을 받는지, (b) `fetch()` wrap 이 SWR 의 dedup/retry 의미를 바꾸는지, (c) React DevTools 가 있을 때만 발생하는 timing 인지.

**Fix status**: **해결 완료** (sw-integration "POST body + Referer/Origin 누락" 항목 참조).

**실제 root cause 체인**:
1. React 컴포넌트가 `useState([])` 로 `l` 배열 초기화.
2. useEffect 가 `j(b.boards[t].products)` 호출 (정상 products array).
3. `j` 내부에서 `fetch('/api/v1/collect/exlogcr', {method:'POST', body: JSON.stringify(t)})` 호출 — exposure tracking endpoint.
4. **버그 1**: ZP 의 Rust kernel `kernel_fetch` 가 body 를 항상 빈 `Vec::new()` 로 전달 → upstream 은 empty body POST 받음.
5. **버그 2**: SW 가 Referer/Origin 설정해도 `new Request(u, init)` 가 forbidden header 로 strip → upstream 은 Referer/Origin 없음.
6. NAVER 의 `/api/v1/collect/exlogcr` 는 (a) JSON body 필수, (b) Origin/Referer 필수 → HTTP 400 Bad Request 반환.
7. React: `let e = await fetch(...).then(r=>r.json()).then(e=>e.exposeContents)`. 400 response 의 JSON 은 `{timestamp, status, error, path}` → `e.exposeContents === undefined`.
8. `d(l.concat(e))` — `l.concat(undefined)` 는 `[...l, undefined]` 반환 → l 에 undefined 원소 주입.
9. 다음 j() 호출 시 filter callback 의 `!l.map(e=>e.adCntsSeq).includes(...)` 가 l 의 undefined 원소에서 throw.
10. React error boundary 잡아서 `__next_error__` 페이지 표시.

**Fix verification**:
- 빌드 후 naver 로딩 → 우측 recoshopping iframe 에 "요즘 관심 받는 아이템" 헤더 + 3개 product card 정상 렌더.
- loadTime 1182ms (mux + body fix 후).
- `__zp_diagnostics` errCount 0.

**Diagnostic recipe**:
```js
// 1. iframe 진단 활성화
const f = Array.from(document.querySelectorAll('iframe')).find(x => x.offsetWidth===420 && x.offsetHeight===172);
const win = f.contentDocument.defaultView;
win.__zp_diagnostics  // 에러 ring buffer (runtime-prelude.js 가 자동 설치)

// 2. webpack/page chunk 리라이트 검증
const chunks = win.webpackChunk_N_E || [];
for (const c of chunks) for (const id in (c[1]||{})) {
  const src = String(c[1][id]); if (src.includes('adCntsSeq')) console.log(id, src.includes('__zp_get'));
}
```

**See also**: [membrane.md](membrane.md) (iframe origin/storage 격리), [rewriter.md](rewriter.md) (page chunk 리라이트).

---

## 2026-05-29 — NAVER 검색바 透明 placeholder

**Site**: `https://www.naver.com/`

**Pattern**: 메인 페이지 검색 input 의 computed style 이:
```
::placeholder color: rgba(0, 0, 0, 0)   // 완전 투명
```
즉 native placeholder 텍스트는 의도적으로 안 보이게 함. NAVER 의 JS 가 별도 DOM 오버레이로 "검색어를 입력해 주세요." 문구를 그림 (autocomplete frame `#autoFrame` 포함).

**왜 함정인가**: "검색바가 안 보임 = ZP 가 망친 것" 이라고 자동 가정하면 잘못된 추격. 실제로는 NAVER 의 JS init 이 실패해서 오버레이 미생성 → 본래 transparent 한 native input 만 남음.

**진단 절차**:
1. `document.querySelector('#query')` 가 존재하는지 (DOM 자체는 있음).
2. `getBoundingClientRect()` 가 정상 위치/크기 반환하는지.
3. `getComputedStyle(q, '::placeholder').color === 'rgba(0, 0, 0, 0)'` → 정상 NAVER 동작.
4. `typeof window.veta / window.N / window.jindo` 확인 — `undefined` 면 NAVER 의 main bundle init 실패.

**관련 회귀 패턴**: 사이트의 "보이지 않는 위젯" 이 항상 ZP 의 잘못은 아님. native CSS + JS 오버레이 조합이 흔함.

---

## 2026-05-29 — naver.com smoke test 실제 globals (정정판)

**Site**: `https://www.naver.com/`

페이지 정상 init 의 증거 (실제 NAVER 가 install 하는 것):
- `typeof window.gladsdk === 'object' && Array.isArray(window.gladsdk.cmd)` — 광고 큐
- `typeof window.ndpsdk === 'object' && Array.isArray(window.ndpsdk.cmd)` — NDP SDK 큐
- `typeof window.ntm === 'object'` — 추적
- `window.nsc === 'navertop.v5'` — 페이지 식별자 (인라인 정의)
- `window.nmain.jsOrigin === 'www'` — 인라인 정의
- `globalThis.webpackChunkpc.length >= 3` — webpack chunk register 됨 (preload/search/main)
- `window['EAGER-DATA']`, `window['ELECTION-DATA']` — SSR hydrate 데이터

**주의**: 이전에 적었던 `veta` / `N` / `jindo` / `NDPCorePostCmd` 같은 globals 는 **NAVER 가 실제로 정의하지 않음**. 추정 오류였다. 위 실제 globals 만으로 판단.

**진단 순서**:
1. 서버 로그에서 `target=https://pm.pstatic.net/resources/js/...` 확인 — target 이 naver.com 으로 잘못 가면 [setScriptSource regression](membrane.md#2026-05-29--setscriptsource-가-절대-proxy-url-잘라냄) 가능성.
2. 외부 script response 가 `__zp_get` 포함하는지 확인 — 없으면 [/zp/api/fetch script destination 누락](sw-integration.md#2026-05-29--zpapifetch-가-script-destination-미감지) 가능성.
3. `document.querySelectorAll('script[src]')` 중 `s.outerHTML.includes('http://proxy.localhost')` 아닌 항목이 0 이어야 함 (멤브레인 우회 차단).

## 2026-06-02 — NAVER 메인 dynamic ad slots 미충전 (pc-main-ad-div-p_main_*) — ntm.pstatic.net block 시도 reject

**Site/Pattern**: `https://www.naver.com/` 메인 페이지의 dynamic GFP ad slots:
- `pc-main-ad-div-p_main_knowledge-0/-1` (지식 슬롯)
- `pc-main-ad-div-p_main_rightside_understock`
- `pc-main-ad-div-p_main_rightbottom_widget`
- `right-ad-1`

**Symptoms**: 위 placeholder DIV 들이 `kids:0`, `h:0`, 일부는 `data-ad-bind-called="true"` 인데도 child iframe 미주입. 같은 페이지의 다른 GFP 광고 (`ad_timeboard_tgtLREC`, `da_public_left/right_tgtLREC`, `veta_time2_tgtLREC`, `ad_premium_area`) 는 정상 렌더.

**구분되는 점**: 작동하는 광고들은 **inline waterfall** (`<script type="text/plain">{"payload":{"adDivId":"timeboard",...}}</script>`, 17KB) 에 SSR 단계에서 pre-bid 되어 있음. 안 나오는 슬롯들은 waterfall 에 부재 → live `tivan.naver.com` 요청 필요. 그러나 `performance.getEntriesByType('resource').filter(r=>r.name.includes('tivan'))` 가 **0** — SDK 가 tivan 호출을 절대 안 함.

**다른 사이트 의심 신호**: `https://ntm.pstatic.net/scripts/ntm_27291e35193e.js` 가 `r.duration` **121,232 ms** (~121초). 같은 family 의 `wtm.pstatic.net` / `ncpt.naver.com` 은 WASM `$_start` 무한 spin 으로 이미 blocklist 에 있음 ([sw.js:395-401](../../web/sw.js#L395-L401)). 가설: ntm 도 같은 anti-bot WASM 인데 결국 완료되긴 하지만 SDK 의 tivan 호출 chain 을 starvation.

**시도된 fix**: `web/sw.js` `/zp/api/script` 핸들러의 blocklist 에 `ntm.pstatic.net` 추가 → noop body 반환.

**Reject 이유**: 검증 결과 ntm block 이 **더 많은 광고를 깨뜨림**. 정상 작동하던 `ad_premium_area` (760px 큰 배너), `da_public_left/right_tgtLREC` (100px), `veta_time2_tgtLREC` 모두 빈 상태 또는 `about:blank` 로 회귀. 패턴 분석 결과: GFP SDK 는 `ntm` 을 **bid token / impression key source** 로 사용 — 모든 광고 (waterfall 기반 포함) 가 ntm 으로부터의 토큰을 검증 단계에 사용. ntm 응답이 없으면 SDK 는 inventory 를 silently drop.

**올바른 결론**: `ntm.pstatic.net` 은 functional dependency — wtm/ncpt 와 다르게 block 하면 안 됨. 121초 duration 은 정상 완료를 막지 않고, SDK 가 ntm 완료 후 정상적으로 광고를 그림. 121초가 진짜 starvation 인지 측정 artifact 인지 확인 필요 — `r.duration` 이 `requestStart→responseEnd` 가 아니라 nextHopProtocol/timing 의 다른 값일 수 있음.

**남은 의문 (다음 세션)**:
- `p_main_knowledge`, `p_main_rightside_understock`, `p_main_rightbottom_widget`, `right-ad-1` 슬롯들이 native NAVER 에서는 어떻게 채워지는가? Real Chrome inspector 로 비교 필요.
- 가능성 1: 이 슬롯들은 user-context 의존 (로그인 / 지역) — ZeroProxy 세션이 anonymous 라 inventory 자체가 없음.
- 가능성 2: NAVER 가 추가 SDK 호출 chain 필요 — `gladsdk.cmd.push(()=>gladsdk.displayAd(...))` 를 누군가 호출해야 하지만 page 의 inline 11 ([naver-main-inline-11](https://www.naver.com/)) 가 호출 안 함.
- 가능성 3: cookie-based 차별. `nid_inf`, `NID_AUT` 등 NAVER 인증 cookie 가 없으면 personalized inventory 비활성.

**진단 명령**:
```js
// 어떤 inline script 가 dynamic ad slot 의 displayAd 를 호출하는지 grep
[...document.querySelectorAll('script')]
  .filter(s => s.textContent.includes('p_main_rightside_understock'))
  .map(s => s.textContent.substring(0,500))
```

**Fix status**: 미해결. ntm block 미적용. 우회 대신 root cause 추적 필요. ([sw.js:382-401](../../web/sw.js#L382-L401))

---

## 2026-05-29 — naver.com 1차 fix 후 검증 결과 (정정)

**Status (2차 검증 후)**: 1차 fix (storage recursion / script destination / scriptProxyPath / fetchThroughRuntime / workerBootstrapURL 5개) 이후 실제 페이지 동작:

✓ **거의 모든 기능 동작**:
- 12/12 script proxy 라우팅 (원본 https URL 누출 0)
- NAVER core globals 모두 정상 (gladsdk/ndpsdk/ntm/nsc/nmain)
- webpack 3개 chunk register + entry module 실제 evaluate (preload entry 가 `window['ntm_27291e35193e']` 설정 검증됨)
- SSR 컨텐츠 (로고, 아이콘 행, 뉴스 그리드 4개 카드, 언론사 로고 그리드, 위젯 보드 / 캘린더)
- **검색바 placeholder 오버레이**: 빈 상태에서는 의도적으로 안 보임 (NAVER 디자인). **typing 시 autocomplete suggestions 정상 표시**
- 광고 컨테이너 15개 존재, 11개 visible (header banner 1280×347, timeboard, 굿피플/초록우산/소상공인연합회 자선광고 텍스트 포함)
- 마이뉴스, 로그인, 회원가입, 스티커 이벤트 모두 렌더

✗ **유일하게 깨진 것**: 우측 shopping recommendation iframe (420×172) `Application error: a client-side exception has occurred (see the browser console for more information)` — **Next.js production error fallback**. 그 한 iframe 의 hydration 단계에서 throw.

**이전 추정 정정**:
- "검색바/광고 캐러셀/우측 위젯 모두 미렌더" 라는 1차 진단은 **오류**. 실제로는 (a) 검색바는 빈 상태일 때만 transparent 한 placeholder (typing 시 정상), (b) 광고 캐러셀과 위젯 영역은 점진 로딩되는 컨텐츠로 시간 충분 후 모두 렌더.
- "webpack 의 entry module 이 evaluate 안됨" 추정도 **오류**. 실제로는 entry 가 정상 실행되어 side effect (`ntm_<key>` 변수 설정) 가 관찰됨.

**진정한 잔여 작업**:
- Shopping iframe Next.js hydration 실패만 남음. 자매 iframe (자선광고들) 은 정상 — Next.js 가 React 19 RSC payload 를 hydrate 할 때 우리 멤브레인이 RSC streaming 패턴 mangle 가능성.
- Phase 매핑: PHASE2_PLAN.md B3 (rewriter rule 추가) 또는 site-quirks 모듈.

**다음 진단 단계 (Next.js 특정)**:
- iframe 의 inline `<script>__ZP_EXEC_INLINE_SCRIPT("...")` 가 `self.__next_f.push([0])`, `self.__next_f.push([1, "1:H..."])` 형태 — `__next_f` 는 React Server Components streaming push 큐.
- 멤브레인이 `__next_f.push(...)` 호출의 callback override 같은 동작을 깨는지 확인.
- 또는 React 의 `renderToReadableStream` / `createFromReadableStream` 같은 stream API 가 가상화 환경에서 망가지는지.

---

## 카테고리 추가 시 권장 사이트 (E2 매트릭스 후보)

- `https://www.naver.com/` — 한국 포털, 광범위한 광고 SDK, 다수의 iframe
- `https://gosuda.org/` — 우리 home 회귀 사이트 (PHASE2 plan E2)
- `https://news.ycombinator.com/` — 단순 HTML, JS 거의 없음 → baseline 보장
- `https://github.com/` — React + 복잡한 dynamic import
- `https://www.google.com/` — 적대적 anti-bot/fingerprinting 환경

---

## 2026-08-20 — naver shopad 잔여 건 닫음: 20회 무장 관측에서 원본 URL 0건

**결론**: 재현되지 않는다. 관측기를 무장한 채 **20회 연속** 로드해 전부 깨끗했다.
`setAttributeNS` 누락(08-18)과 정적 `<iframe src>` 누락(08-20) 중 하나가 원인이었을
가능성이 높다 — 둘 다 이 증상과 같은 모양(서브리소스가 원본 URL 로 남음)이다.

**측정 조건 (이걸 안 적으면 다음 세션이 또 못 믿는다)**:
- 데몬: `--record --enforce-csp` (`list` 로 `csp_bypassed: false` 확인). 이걸
  빠뜨려서 26회를 날린 게 바로 전 세션이다.
- 관측기: `.ai/dogfood/wtm/zpraw-observer.js` 를 `inject-script --world isolated`
  로 document-start 에 등록. 프레임마다 MutationObserver 로 원본 URL 속성을
  `globalThis.__zpRaw` 에 쌓는다. 12/12 프레임에서 `__zpRawArmed === true` 확인.
- 하네스: `.ai/dogfood/wtm/shopad-hunt.sh` — 매 회 CSP 위반 수 / 프레임 수 /
  `__zpRaw` 적재량을 한 줄로 남기고, 0 이 아니면 그 자리에서 전체 덤프.

**결과 (20/20)**: `shopad=1 csp=0 frames=12 raw_frames=0 raw_top=0`.
격리 월드에서 최상위 문서의 `img` 57개 중 원본 URL **0개**.

**★ 전제가 하나 틀려 있었다**: "shopad 모듈은 서버측 A/B 로 ~10% 만 붙는다" 고
적혀 있었는데, 오늘은 **20/20 전부 붙었다**(`iframe[src="https://shopsquare.naver.com/"]`
존재로 판정). 즉 예전의 "재현율 10%" 는 모듈 부착률이 아니라 **관측 실패율**이었을
공산이 크다 — 그때는 CSP 위반으로만 보고 있었고 그 CSP 가 꺼져 있었다.
**"간헐적" 이라는 딱지는 관측기를 고치고 나면 다시 붙여 볼 것.**

**교훈**: 부착률 같은 전제는 판정 자체보다 오래 살아남아 다음 세션의 계획을
바꾼다(우리는 이 전제 때문에 "기다린다" 를 선택했다). 관측 도구를 고쳤으면
판정만 다시 하지 말고 **전제도 다시 잴 것.**

---

## CNN 광고 프레임 21~25 vs 대조군 34 — APS 갈래를 어디까지 좁혔나 (2026-08-25, 미해결) {#cnn-aps-프레임}

`document.location` 유출을 고쳐 `turner_getGuid` 가 살아난 뒤에도 프레임 수가
대조군에 못 미친다. 빠진 것 중 대표가 `apstag-iframe` 이다. **아직 못 고쳤고,
어디까지 좁혔는지와 무엇을 반증했는지를 남긴다.**

### 좁힌 것

1. `apstag-iframe` 을 만드는 것은 **Amazon 이 아니라 BounceExchange** 다.
   문서시작 주입으로 `Document.prototype.createElement` 를 감싸 스택을 잡았다:
   `injectAPSTagScriptInsideIframe`(bounce `ads-v2` 번들) → `createIframe`
   (`main-v2`) → `createElement`. **인스턴스 own 래퍼로는 안 잡힌다** —
   프렐류드가 프로토타입 메서드를 붙들어 두므로 프로토타입에 걸어야 한다.
2. 그 함수의 게이트는 `canRun()` 이고 조건은
   `bouncex.website.sspConfig.aps` 가 truthy 인 것이다(소스 확인).
3. 실측 비교:

   | | 프록시 | 대조군 |
   |---|---|---|
   | `bouncex.website` 키 수 | **76** | **84** |
   | `sspConfig` | **없음** | `aps, criteo, equativ, index, magnite, openpath, pbm` |
   | `bouncex.state` | **null** | `device_id, gdpr, geo, request_token, …` |
   | `api.bounceexchange.com/state/js?...&device_id=…` 로드 | **안 함** | 함 |

   즉 **설정이 채워지지 않아 APS 단계 자체가 안 돈다.**
4. `bcx_local_storage_frame`(bounce 의 저장소 프레임)이 프록시에서는 **문서가
   비어 있다**(`about:blank`, 요소 3, 스크립트 0). 그 프레임의 share URL 을
   **격리 월드에서 새 iframe 으로** 열어도 이동하지 않는다(같은 방법으로 다른
   프레임의 src 를 열면 정상 이동하므로 **프로브 방법은 유효**하다).
5. 페이지가 받는 `message` 이벤트: 대조군 **109건**(6개 오리진) vs 프록시 **6건**
   (전부 프록시 오리진 — 프록시에서는 모든 프레임이 같은 오리진이라 그 자체는 정상).

### 반증한 가설 (다시 파지 말 것)

- **"타깃 URL 의 프래그먼트(`#7291`) 때문"** — 픽스처로 프래그먼트 있는/없는
  자식 프레임을 나란히 열었다. 프록시에서 **둘 다 정상 로드**.
- **"자식 프레임이 자기 URL/해시를 잘못 본다"** — 자식 안에서 읽은
  `location.href/hash/search` 가 **대조군과 완전히 동일**했다(부모에서 읽은
  `contentWindow.location` 은 부모 URL 로 보이지만, 그건 별개 표면이다).
- **"apstag 가 로드 안 됨"** — apstag 객체의 키 20개와 로드된 스크립트 3개가
  대조군과 동일하다.
- **"CSP 가 프레임을 막음"** — 문서 응답에 CSP 헤더가 실리고 `frame-src 'self'`
  가 허용한다. 콘솔의 CSP 메시지는 **meta CSP 가 `<head>` 밖에 박혀 무시됐다**는
  다른 얘기다(헤더가 있으므로 정책 자체는 유효 — 다만 meta 를 왜 넣는지 재검토할 것).

### 추가 측정 (같은 날) — 설정 파일은 무죄, 문제는 저장소 프레임이 이동하지 않는 것

- `cache/7291/website-<hash>.js` 를 직접 받아 보니 **5,192바이트에 `sspConfig` 가
  아예 없다**(0건). 즉 그 파일 탓이 아니다 — `sspConfig` 는 **`api.bounceexchange.com/state/js`**
  응답이 채운다. 그 URL 은 `website_id` + **`device_id`** + `visit_id` 로 만들어지고
  (main-v2 소스 확인), device_id 는 저장소 프레임(`bcx_local_storage_frame`)이 준다.
  → **사슬의 뿌리는 그 프레임이다.**
- SW 에 임시 로그를 넣어 `/zp/p/` 요청을 전부 셌다: 한 로드에서 **문서 1 + iframe 38건**이
  SW 에 도달한다. 그런데 **저장소 프레임의 토큰은 그 목록에 없다** — 브라우저가 그
  프레임만 요청을 아예 내지 않는다.
- 격리 월드 MutationObserver 로 그 프레임의 생애를 봤다. 이벤트는 **하나뿐**이다:
  `inserted | connected:Y | src:…ws-pipe` — **삽입 시점에 이미 완전한 share URL 을
  달고 살아 있는 트리에 들어간다.** 그런데도 내비게이션이 시작되지 않는다.
- 같은 src 를 격리 월드에서 새 iframe 에 넣어도 이동하지 않는다. **반면 정상 로드된
  다른 프레임의 src 로 같은 짓을 하면 정상 이동한다** — 프로브 방법은 유효하다.
- 그 URL 을 `fetch` 로 받으면 200 이 오지만 본문이 **우리 랜딩 페이지(19KB)** 다.
  프래그먼트(키)가 빠진 요청이라 route 해석이 실패해 폴백된 것으로 보인다 —
  이 관측은 내비게이션 실패의 원인이 아니라 **별도 사실**이다(혼동 주의).

### 다음 갈래

`bouncex.website` 가 76 vs 84 키로 **애초에 다르다**. **위 추가 측정으로 이 갈래는 좁혀졌다**: 설정 파일에는 `sspConfig` 가 없고
`state/js` 가 채우며, 그 요청은 저장소 프레임이 device_id 를 줘야 나간다. 그러니
다음 한 걸음은 **"완전한 src 를 달고 연결된 iframe 이 왜 내비게이션을 시작하지
않는가"** 하나다. 확인할 것: (1) 그 요소가 **다른 document 에서 만들어져 입양**된
것인지(입양 후에는 src 재설정 없이는 로드가 시작되지 않는 경우가 있다),
(2) 우리 멤브레인이 삽입 경로에서 src 를 **같은 값으로 다시 쓰는지**,
(3) 프레임 생성이 문서 스트리밍 중이라 브라우징 컨텍스트가 아직 없는 시점인지.

### 후속 (2026-08-25) — 프레임이 안 뜬 이유는 우리 SW 의 교착이었다

위에서 "완전한 src 를 단 연결된 iframe 이 왜 내비게이션을 시작하지 않는가" 로
좁혀 둔 질문의 답: **브라우저는 내비게이션을 시작했다.** 요청도 나갔다. SW 가
200 을 만들어 놓고도 `respondWith` 가 settle 되지 않아 커밋이 안 된 것이다 —
응답 경로에서 `await clients.get(resultingClientId)` 를 한 교착.
상세: [sw-integration.md#clients-get-교착](sw-integration.md#clients-get-교착).

여기 적어 둔 확인 항목 세 개(입양 / 삽입 경로의 src 재작성 / 스트리밍 중 생성)는
**전부 아니었다.** 측정으로 배제된 것:

- `ownerDocument === document`, `isConnected: true`, `contentWindow` 존재,
  `sandbox: null`, `srcdoc` 없음 — 삽입 시점부터 정상.
- 네이티브 접근자로 본 진짜 `src` 속성은 삽입 100ms 뒤 프록시 URL 로 바뀐다
  (`about:blank` → 372자). 멤브레인이 값을 망가뜨리지 않았다.
- 브라우저는 그 URL 로 Document 요청을 **실제로 보냈다**(CDP 테이프에 `request`
  이벤트는 있고 `response`/`finished` 가 없다).

**함정 하나 더**: 프레임의 `getAttribute('src')` / `.src` 를 페이지 문맥에서
읽으면 **멤브레인이 가상화한 값**이다(원본 타깃 URL). 브라우저가 무엇을 보고
있는지는 document-start 에 붙들어 둔 **네이티브 접근자**로만 알 수 있다 —
exec-js 시점에 잡은 디스크립터는 이미 prelude 래퍼다. 이걸 모르고 한 첫 측정은
"속성은 bounce URL 인데 프로퍼티는 프록시 URL" 이라는 모순으로 보였다.

남은 것: 프레임이 뜬 뒤에도 `sspConfig` 는 여전히 없고 `state/js` 요청도 안
나간다(실측: `bouncex.website` 76키, `apstag` object, `turner_getGuid` function,
`sspConfig` undefined). 프레임 수는 대조군 30~34 에 대해 23~26. APS 갈래는
계속 열려 있다.

### 2026-08-25 — CNN 광고 스택은 대조군과 동률이 됐다

`postMessage` incumbent 수정([rewriter.md#postmessage-incumbent](rewriter.md#postmessage-incumbent))
뒤 같은 프로브로 나란히 잰 값:

| | 프록시 | 대조군 |
|---|---|---|
| `sspConfig` 키 | 7 | 7 |
| device_id | 있음 | 있음 |
| `apstag` | object | object |
| prebid | v11.18.5 | v11.18.5 |
| 입찰 응답 수 | 10 | 6 |
| 입찰자 | appnexus, criteo, ttd, pubmatic, ix, rubicon | appnexus, ttd, ix, rubicon, criteo |
| GPT 슬롯 | 1 | 1 |
| 보이는 프레임 | 1 | 1 |
| 프레임 / 요소 | 26 / 4,105 | 30 / 4,095 |

즉 **"광고 경매가 아예 안 돈다" 는 갈래는 닫혔다.** 남은 것은 프레임 수 차이
26 vs 30 뿐인데, 대조군도 회차마다 28~34 로 흔들리므로 이 정도 차이를 쫓기
전에 **여러 회차의 분포**부터 잡아야 한다(한 회차 비교로 결론 내지 말 것).

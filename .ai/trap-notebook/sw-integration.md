# Service Worker Integration Regressions

`web/sw.js` 의 classify / handleFetch / runtimeAPI / transportFetch / 메시지 라우팅.

---

## 2026-08-21 — Go 의 응답 헤더 정책 전체가 죽은 코드였다: 호출자 0. "Go 가 막고 있다" 는 믿음이 실제 탈출을 낳았다

**계획 9번(CORS)을 재려다 전제가 무너졌다.**

계획은 이렇게 적고 있었다: *"Go 는 `ACAO:*` 를 credentials 없이 내고, SW 는 Origin 을
되비추며 `Allow-Credentials: true` 를 켠다 — 명세상 호환 불가. 정책을 정하고 통일한다."*

**Go 쪽은 통일할 구현이 아니었다.** `ConstructorPolicy` / `HiddenHeader` /
`ApplyChallengeCompat` / `ChallengeSubresourceSkip` 전부 **테스트 말고 호출자가 하나도
없다**. `main.go` 가 `internal/headers` 에서 쓰는 것은 `BuildCSP` 뿐이다.
지워 보고 확인했다 — 372줄이 `go build` / `go test` 를 하나도 안 건드리고 사라진다.

curl 로도 같은 결과였다: `/zp/`, `/zp/api/sync-fetch`, `/__zp/*.wasm` 어디에서도
`Access-Control-*` 가 안 나온다.

**이게 왜 위험한가 — 이미 한 번 피를 봤다.** 2026-08-20 의 `Refresh` 탈출이 정확히
이 착각이었다. Go 의 `hidden` 에 `refresh` 가 있으니 막혀 있다고 믿었고, 실제로는
아무도 그 함수를 부르지 않았다. 그때는 "문서 응답만 Go 를 안 지난다" 고 정리했는데
**사실은 어떤 응답도 안 지났다.** 유닛 테스트가 통과하니 방어가 하나 더 있는 것처럼
보였을 뿐이다. `challenge.go` 옆에는 아예 이렇게 적혀 있었다:

> Defense-in-depth Go helper still exists and is unit-tested for parity.

**호출되지 않는 코드는 defense 가 아니다. 착각을 만드는 비용일 뿐이다.**

**Fix**
- Go 사본 삭제(`policy.go`, `challenge.go` + 테스트, 372줄). `csp.go`(BuildCSP)는 살아 있어 유지.
- 목록은 `crates/zp-shared/testdata/response_header_policy.json` 하나로:
  `reporting`(4) / `directive`(9) / `hop_by_hop`(9). 빌드가 `__ZP_*_HEADERS__` 자리에 박아 넣는다.
- SW 의 리포팅 헤더 개별 `h.delete` 4줄도 그 목록을 도는 루프로.
- **CORS 실제 결함 하나**: `*` + `Allow-Credentials: true` 는 명세상 무효 조합이라
  브라우저가 응답 전체를 거부한다. Origin 헤더가 없는 요청에서 그 조합이 나왔다.
  피해는 관측되지 않았지만(Origin 이 없으면 CORS 요청이 아니라 브라우저가 헤더를
  안 본다) 구체 오리진을 되비출 때만 켜도록 고쳤다.

**측정**: 헤더 프로브(`/hdrprobe`)에 리포팅 계열 4종을 추가해 재측정 —
`Report-To`/`Reporting-Endpoints`/`NEL`/`CSP-Report-Only`/`Link`/`Location`/`Clear-Site-Data`
모두 프록시 문서에 **한 건도 안 남는다**. 구멍 63칸 무회귀, static 123, cargo 전체,
`go test ./...`.

**★가드 셋을 다시 겨눴다.** "Go 목록 ⟷ SW 목록" 비교는 죽은 파일을 기준으로 삼고
있었으므로 통과해도 아무 의미가 없었다. 이제는 **"빌드가 픽스처를 실제로 박아
넣었는가"** 와 **"Go 사본이 되살아나지 않았는가"** 를 본다.

> 규칙: **가드가 읽는 파일이 실행되는지부터 확인한다.** 이 저장소에서 죽은 사본을
> 기준으로 삼은 가드가 이번 통합 작업에서만 둘이었다(여기, 그리고 0단에서 지운
> `internal/htmltx`).

## 2026-05-30 — iframe document Referer = parentTargetUrl (광고 iframe 차단 해소)

**Site/Pattern**: NAVER 중앙 광고 iframe (`shopsquare.naver.com/...`) — upstream 가 `Referer` 헤더로 embedder host (`https://www.naver.com/`) 기대.

**Symptoms**:
- iframe document fetch 가 자기 자신을 Referer 로 보내 → `POLICY_BLOCKED` 또는 404.
- 광고 자리에 회색 placeholder.

**Root cause**:
- `transportFetch` 가 `X-ZP-Referer = entry.baseUrl` 사용. iframe entry 의 baseUrl 은 iframe 자체 URL → 자기 자신을 Referer 로 송신.
- iframe 의 embedder 정보 (parent navigation target) 가 SW entry 에 없음.

**Fix** (`web/runtime-prelude.js` + `web/sw.js`):
- `activatedFrameURL` 가 `parentTargetUrl: virtualURL.href` 를 `ZP_FRAME_ROUTE` 메시지에 포함.
- SW `ZP_FRAME_ROUTE` 핸들러가 `parentTargetUrl` 를 canonicalize 후 entry 에 저장.
- `transportFetch` 가 `opt.document && entry.parentTargetUrl` 면 그 URL 을 `X-ZP-Referer` 로 사용.

**Lessons**:
- iframe 의 Referer 는 자기 자신이 아니라 embedder 의 navigation URL 이어야 함 (브라우저 기본 동작).
- 광고 / analytics endpoint 는 Referer 검증으로 fraud 방지 → 정확한 Referer 없이는 차단됨.

---

## 2026-05-30 — 3xx redirect server-side following (rt.RoundTrip → followRedirects)

**Site/Pattern**: NAVER shopsquare.naver.com 광고 iframe — `303 See Other → /newshopping` 의 relative Location 헤더.

**Symptoms**:
- 브라우저가 받은 303 의 Location 을 브라우저 origin (proxy.localhost:18080) 에 resolve → `/newshopping` fetch 시 SW 가 UNKNOWN → POLICY_BLOCKED.
- 광고 placeholder.

**Root cause**:
- 서버가 `rt.RoundTrip` 만 사용 → 3xx 응답을 그대로 클라이언트로 forward.
- Location 헤더는 target host 기준 relative path → 브라우저는 그게 어디로 가야 하는지 모름 → proxy origin 에 resolve.

**Fix** (`cmd/zeroproxy-server/relay.go`):
- `followRedirects(ctx, rt, req, jar)` helper 추가 — 최대 10 hop.
- 301/302/303 → method=GET 변환 (RFC 7231 § 6.4.2/3/4 동작).
- 307/308 with body → relay (메서드/본문 보존). non-body 면 재시도, body 있고 재시도 불가하면 그대로 반환.
- 매 hop 마다 cookies 캡처 (jar.SetCookies).
- cross-host 시 Authorization/Cookie strip.
- 최종 응답에서 Location 헤더 제거 (브라우저에 누출 방지).
- 양 relay path (`bridgeRelayWS` + `bridgeMuxRelayWS`) 가 사용.

**Lessons**:
- 프록시는 3xx 를 클라이언트로 누출하지 말고 서버 측에서 follow 해야 함. 그렇지 않으면 Location 의 host context 가 깨짐.
- redirect-following 은 cookies 와 forbidden-header (Authorization/Cookie) 를 정확히 handle 해야 SSO/auth flow 가 깨지지 않음.

---

## 2026-05-29 — User-Agent forbidden header smuggle

**Symptoms**:
- Wikipedia `https://en.wikipedia.org` 등 anti-bot 사이트가 응답으로 `"Please set a user-agent and respect our robot policy"` 텍스트 반환 + 정상 페이지 미렌더.
- 다른 anti-scraping endpoint 들이 generic 4xx 또는 challenge 페이지 반환.

**Root cause**:
- `User-Agent` 는 `Referer`/`Origin` 과 함께 **fetch forbidden header**. JS 가 `headers.set('User-Agent', X)` 해도 Request 생성자가 strip.
- SW 의 transportFetch 가 받는 Request 의 headers 에 UA 가 없음 → kernelFetch 도 UA 없는 envelope → relay 서버가 net/http 의 기본값 (`Go-http-client/1.1`) 보내거나 빈 UA.
- 일부 사이트 (Wikipedia, Cloudflare 보호 사이트 등) 가 비 브라우저 UA 차단.

**Fix**:
- [web/zp-core.js](../web/zp-core.js) 에 `TARGET_USER_AGENT` 상수 추가 (`Mozilla/5.0 ... Chrome/134.0.0.0 ...`), `ZP.TARGET_USER_AGENT` 로 SW/prelude 양쪽 노출.
- [web/sw.js](../web/sw.js) transportFetch: `headers.set('X-ZP-User-Agent', ZP.TARGET_USER_AGENT)` 무조건 설정.
- [cmd/zeroproxy-server/relay.go](../cmd/zeroproxy-server/relay.go) bridgeRelayWS + bridgeMuxRelayWS 양쪽: X-ZP-User-Agent 추출 → `User-Agent` 헤더로 promote. smuggle 없으면 hardcoded default (zp-core 와 동일 string).
- [web/runtime-prelude.js](../web/runtime-prelude.js): `TARGET_USER_AGENT = ZP.TARGET_USER_AGENT` 로 중복 제거. navigator.userAgent (JS visible) 와 HTTP User-Agent (server visible) 가 단일 상수 source 에서.

**Verification**:
- Wikipedia loadTime 1551ms, full main page 렌더 (search bar, 추천 article, In the news panel).
- NAVER 회귀 없음 (recoshopping 여전히 정상).

**Regression guard**:
- Wikipedia 응답에 `"Please set a user-agent"` 검출되면 UA smuggle 회귀.
- 서버 로그 에 `User-Agent: Go-http-client` 보이면 promotion 안 됨.

**Patterns to watch**:
- 다른 forbidden header: `Cookie` (브라우저 자동), `Sec-Fetch-*` (브라우저 자동), `Accept-Encoding`/`Accept-Language` (일반 헤더지만 일부 사이트 검사). 필요시 동일 X-ZP-* smuggle 패턴 적용.
- Sec-CH-UA-* 클라이언트 힌트 — 향후 일부 사이트가 이것도 검사할 수 있음.

**See also**: 같은 forbidden header 가족 [POST body + Referer/Origin](#2026-05-29--post-body--refererorigin-누락).

---

## 2026-05-29 — POST body + Referer/Origin 누락

**Symptoms**:
- 사이트의 `fetch(url, {method:'POST', body: JSON.stringify(...)})` 호출이 server 측에서 400 Bad Request.
- 특히 anti-CSRF 가 강한 endpoint (NAVER `/api/v1/collect/exlogcr`, login form, etc.) 가 일관되게 실패.
- 서버 로그: `referer="" origin="" body-set=false` — POST 인데 body / Referer / Origin 모두 비어있음.

**두 개 별도 버그**:

### 버그 1 — Rust kernel 이 body 누락

[crates/zp-kernel/src/lib.rs](../crates/zp-kernel/src/lib.rs) `kernel_fetch`:
```rust
// BEFORE (broken):
sess.fetch(url, method, headers_owned, Vec::new()).await
//                                     ^^^^^^^^^^ 항상 빈 body
```
- POST/PUT/PATCH 요청도 body 가 절대 forward 안됨.
- 모든 API 호출 (JSON POST, form POST, file upload, etc.) 에 영향.

**Fix**:
```rust
let method_upper = method.to_ascii_uppercase();
let body_bytes: Vec<u8> = if method_upper != "GET" && method_upper != "HEAD" {
    extract_body_bytes(&request_js).await.unwrap_or_default()
} else { Vec::new() };
sess.fetch(url, method, headers_owned, body_bytes).await
```

### 버그 2 — Referer/Origin 이 forbidden header

[web/sw.js](../web/sw.js) transportFetch:
- 브라우저는 fetch API 통해 JS 가 Referer / Origin 헤더를 설정하는 것을 **금지** (Forbidden header names).
- `new Request(u, {headers: {Referer: '...'}})` → Request 생성자가 silently strip.
- 결과: SW 가 `headers.set('Referer', virtualBase)` 해도 kernelFetch 받는 Request 의 headers 에는 Referer 없음.
- 서버는 Referer/Origin 없는 요청 받음 → anti-CSRF endpoint 400.

**Fix**: side-channel header 로 smuggle, 서버에서 promote.
```js
// SW transportFetch
if (virtualBase) {
  headers.set('X-ZP-Referer', virtualBase);
  if (m !== 'GET' && m !== 'HEAD') headers.set('X-ZP-Origin', virtualOrigin);
}
```
```go
// relay.go bridgeMuxRelayWS
var smuggledReferer, smuggledOrigin string
for _, kv := range req.Headers {
  if strings.EqualFold(kv[0], "X-ZP-Referer") { smuggledReferer = kv[1] }
  if strings.EqualFold(kv[0], "X-ZP-Origin") { smuggledOrigin = kv[1] }
  if strings.HasPrefix(strings.ToLower(kv[0]), "x-zp-") { continue }  // strip
  httpReq.Header.Add(kv[0], kv[1])
}
if smuggledReferer != "" { httpReq.Header.Set("Referer", smuggledReferer) }
if smuggledOrigin != "" { httpReq.Header.Set("Origin", smuggledOrigin) }
```

**Verification**:
- NAVER recoshopping iframe 의 `/api/v1/collect/exlogcr` 호출이 200 OK + `{exposeContents:[...]}` 반환.
- React 가 정상 `l.concat([...items])` → 다음 filter callback 정상 동작.
- 우측 상단 추천 상품 위젯 정상 렌더.

**Regression guard**:
- POST 요청이 일관되게 400 / 403 으로 실패하면 본 항목 우선 의심.
- 서버 로그 `mux DEBUG POST` (필요시 임시 추가) 로 body-set=false 면 버그 1, referer="" 면 버그 2.

**Patterns to watch**:
- 다른 forbidden header (Cookie, Sec-Fetch-*, User-Agent in some browsers) 도 동일 패턴으로 smuggle 필요할 수 있음.
- HEAD 메소드도 body 가 없어야 하니 body 추출 skip 정확히.

**See also**: [build-deploy.md](build-deploy.md), [real-site-compat.md](real-site-compat.md#2026-05-29--naver-우측-상단-recoshopping-nextjs-iframe-application-error).

---

## 2026-05-29 — target script 에러 diagnostics

**Symptoms**:
- target 사이트의 React/Vue/etc. 런타임이 silent throw → 화면이 fallback UI ("Application error") 표시.
- Stack trace 가 어디에 있는지 모름. devtools 콘솔 열어도 iframe context 전환 필요. taskweaver 의 `exec-js` 는 reload 시 hook 손실.

**Fix**:
- [web/runtime-prelude.js](../web/runtime-prelude.js) 부팅 시 `window.__zp_diagnostics` ring buffer (max 200 entries) 자동 설치. capturing phase 으로 등록 → target 의 자체 error suppression 보다 먼저 잡음.
- 캡처 항목: `error` event (`{t:'error', msg, src, line, col, stack}`), `unhandledrejection` (`{t:'rejection', reason, stack}`), `console.error` (`{t:'console.error', args}`).
- prelude marker (`Symbol.for('zeroproxy.runtime.installed')`) 로 중복 설치 방지. 페이지 내부 iframe 각각의 prelude 인스턴스가 자기 window 에 자기 ring buffer 보유.

**Usage**:
```js
// taskweaver exec-js -i <id> --code "..."
const f = document.querySelector('iframe');
const diag = f.contentDocument.defaultView.__zp_diagnostics || [];
diag.filter(e => e.t === 'console.error');
```

**Regression guard**:
- `__zp_diagnostics` 가 boot 시 array 로 존재해야 함. 페이지 코드가 덮어쓰면 fail.
- target 의 `Symbol.for('zeroproxy.runtime.installed')` 가 set 됐는데 `__zp_diagnostics` 가 undefined 면 hook 설치 회귀.

---

## 2026-05-29 — WS mux: 1 WS ↔ N stream

**Symptoms**:
- 서버측 transport pool 추가 후에도 naver loadTime 2.3s 으로 정체.
- 서버 로그에 페이지당 `relay: WS upgrade request` 200+ 라인 → SW 가 매 kernel_fetch 마다 새 WebSocket 을 `/zp/relay` 에 연다.
- localhost 라 TLS overhead 없어도 WS upgrade 자체 + onopen 콜백 RTT × 200 = 1+초 손실.

**Root cause**:
- 기존 `kernel_fetch` (crates/zp-kernel/src/lib.rs) → `relay_round_trip` → `WebSocket::new("/zp/relay")` 매 호출마다 새 WS.
- 서버측 `bridgeRelayWS` 도 "envelope 1개 받고 응답 후 close" 모델 → reuse 불가.

**Fix**:
- **새 endpoint** `/zp/relay-mux` 추가. 단일 WS 가 다중 concurrent stream 운반.
- **Wire protocol** (binary frame only): `[4-byte BE stream ID][1-byte type][payload]`. Types: 0x01 ENVELOPE, 0x02 BODY_UP, 0x10 HEAD, 0x11 BODY_DOWN, 0x20 ERROR, 0x30 CANCEL.
- **Server**: `bridgeMuxRelayWS` (cmd/zeroproxy-server/relay.go) — 단일 read loop, 프레임마다 stream ID 추출. ENVELOPE 가 새 stream 시작 → goroutine 시작 + `chanBodyReader` 로 body chunk 흘려보내기. 모든 WS write 는 `sendMu` 로 직렬화 (gorilla concurrent write 금지 invariant 준수).
- **Client (Rust)**: `crates/zp-kernel/src/mux.rs` — singleton `MuxSession` (thread_local), u32 stream ID 할당, `StreamSlot` 마다 head_resolve/head_reject/controller. WS 연결 전 frame 은 `pending` queue → onopen 시 flush.

**Result**:
- naver loadTime 2283ms → **720ms** (3.2x speedup).
- WS upgrade count: 200+ → **1** (mux WS) + 1 (legacy, 첫 navigation 시 race — 무시 가능).
- 서버 로그 `relay-mux: WS upgrade request from ...` 1 라인, 이후 모든 stream 이 이 1 WS 안에서.

**Regression guard**:
- `mux::get_session()` 실패 시 fallback path 가 `relay_fetch_owned` 로 → 기존 `/zp/relay` 사용. 신뢰성 유지.
- 새 페이지 load 후 서버 로그 `wc -l /tmp/zp-server.log` 가 6 라인 미만이면 mux 가 동작 중. 100+ 라인이면 회귀.

**Patterns to watch**:
- 동시 in-flight stream 4 billion 이상이면 u32 stream ID wrap → collision 가능. 현실에선 불가능.
- `bodyChunks` buffer size 16 chunks. 큰 upload 시 read loop pause (다른 stream 영향). 측정 후 조정.
- WS close 시 모든 pending stream reject — `MuxSession::mark_dead`. 새 fetch 는 새 session lazy spawn.

**See also**: [build-deploy.md](build-deploy.md#2026-05-29--upstream-connection-pool-누락) (서버측 pool fix — 둘 다 적용해야 최대 속도).

---

## 2026-05-29 — /zp/api/fetch 가 script destination 미감지

**Symptoms**:
- 외부 `<script src="https://pm.pstatic.net/.../preload.js">` 가 zp-htmltx 에 의해 `/zp/api/fetch?url=ABS` 로 라우팅됨.
- SW 가 가로채서 `transportFetch(target, …)` 호출 후 응답을 **rewrite 없이** 그대로 반환.
- 결과: target 의 raw JS 가 페이지에서 실행 → `__zp_get` 멤브레인을 통하지 않고 native `window`/`location` 직접 접근 → 멤브레인 우회.
- 디버깅 어렵: 페이지가 부분적으로 동작 (인라인 스크립트 OK, 외부 스크립트의 일부 sideeffect 만 OK), `__zp_diagnostics` 비어있음.

**Root cause**:
[web/sw.js#L228](../../web/sw.js) `runtimeAPI` 의 `/zp/api/fetch` GET 분기:
```js
const resp = await transportFetch(target, { method: 'GET', headers: [['Accept', '*/*']], tab, entryId });
return shouldRewriteCSS(req, resp) ? rewriteCSSResponse(resp, { targetUrl: target }) : resp;
```
script destination 케이스 누락. 기존에는 외부 script 가 `/zp/api/script?u=...` 로만 라우팅되었기에 `/zp/api/fetch` 는 단순 CSS/image 만 처리. zp-htmltx 가 모든 absolute URL 을 `/zp/api/fetch` 로 통합 라우팅하면서 script 도 이쪽으로 옴 → 미감지.

**Fix**:
[web/sw.js#L266](../../web/sw.js) `/zp/api/fetch` GET 분기에 script destination 감지 추가:
- `req.destination === 'script' | 'worker' | 'sharedworker'` 또는 `Sec-Fetch-Dest` 헤더 동일.
- script destination → `rewriteScriptResponse(resp, { targetUrl: target, kind: scriptKindFromRequest(req) })`.
- 그 외 → 기존 CSS/raw 분기.

**Regression guard**: TODO
- puppeteer E2E: target 사이트 로딩 후 `Array.from(document.querySelectorAll('script[src]'))` 중 응답에 `__zp_get` 토큰 포함하는지 확인 (rewriter 적용 증거).
- 단위테스트: SW 테스트 (현재 없음). `test/js/sw-runtime.test.js` 신설 필요.

**Patterns to watch**: 모든 `/zp/api/*` GET 분기에서 destination 별 분기를 잊는 것. classify → handler → rewriteResponse 가 3단계로 흩어져 있어서 통합 미흡.

---

## 2026-05-29 — iframe boot.targetUrl 가 parent 의 URL 로 잘못 등록되어 멤브레인 cascade 실패 (P1)

**Site**: naver.com (재현 위치: 햄버거 메뉴 iframe + 우측 shopping recommendation iframe + Next.js 광고 iframe 모두 동일 증상)

**Symptoms**:
- iframe 내부 페이지가 빈 채로 렌더 (햄버거 메뉴 panel 비어있음) 또는 Next.js 가 "Application error: a client-side exception has occurred" 표시.
- iframe 내부 `eval('location.href')` 결과가 **parent 의 virtual URL** 반환 (예: `https://www.naver.com/`) — iframe 자신의 target URL 이 아님.
- iframe 자신의 expected target URL 은 e.g. `https://m.naver.com/aside/?type=PC&from=...` 또는 `https://spastatic.naver.com/v1/shopad/...`.
- iframe 의 외부 script 들은 proxy 라우팅 ✓, inline script 일부는 실행 ✓ (`lcs_SerName`, `nsc`, `svt` 등 set), 그러나 webpack chunk push 0 회 또는 entry module 중간에 throw.

**Root cause (가설)**:
parent runtime-prelude 의 `activatedFrameURL(raw, baseURL)` 가 iframe 의 target URL 을 결정할 때 `baseURL = parent's virtualURL` 사용. NAVER 가 iframe.src 를 상대 경로 (예: `/aside/?type=PC...`) 로 설정 시 resolve 결과는 parent virtual base + 상대 경로 = 정상. 그러나:
- 실제 SW 의 entry.targetUrl 은 `https://www.naver.com/` (parent root) 로 등록됨 → 어딘가 잘못된 fallback 가능성
- 또는 iframe `proxyDocument` 에서 잘못된 entry 를 lookup 하여 transformDocumentResponse 가 parent entry 로 boot config 생성

**증거**:
- iframe `documentBaseURI` 가 parent root URL 반환 (정상이라면 iframe 자신의 URL)
- 모든 iframe 동일 동작 → 일반화된 bug

**Fix path (next session)**:
1. SW 에 임시 debug 메시지 추가하여 tab.entries / shareRoutes 의 실제 internal state dump.
2. iframe 생성 시점에 ZP_FRAME_ROUTE 의 targetUrl 인자가 무엇인지 확인. parent 의 runtime-prelude 에서 console.log 추가하여 추적.
3. `proxyDocument` 의 entry lookup 이 parent entry 를 쓰는지, iframe 의 own entry 를 쓰는지 검증 — `tab.activeEntryId` 가 모든 iframe load 마다 parent entry 로 reset 되는지 확인.
4. 가능성 높은 fix: `proxyDocument` 가 `tab.activeEntryId = entry.entryId` 호출 시 iframe 의 entry 가 parent 의 activeEntryId 를 덮어쓰지 않도록 — 또는 iframe 의 clientContext 가 자신의 entry 에 바인딩되도록.

**Scope**: 이 fix 가 끝나면 naver 의 햄버거 메뉴 + shopping ad iframe + 그 외 모든 iframe-based widget 동시 해결될 가능성 높음.

**Regression guard**: TODO
- E2E: naver.com 로드 후 모든 iframe 의 `cw.eval('location.href')` 가 parent URL 이 아닌 자신의 URL 반환하는지 확인.

---

## 2026-05-29 — iframe /zp/api/fetch navigation entry 미생성

**Symptoms**:
- `<iframe src=ABS_URL>` 이 `/zp/api/fetch?url=ABS_URL` 로 리라이트됨.
- iframe navigation 시 SW handler 는 부모 page 의 entry 만 사용 → iframe 의 가상 baseURI = 부모의 target URL (잘못됨).
- iframe 내부 subresource 의 referer-derived ctx lookup 시 SW_NOT_READY 503 race (clientContext 가 iframe clientId 에 바인딩되기 전에 iframe 자체 subresource 가 도착).
- 사용자 가시: iframe 안 "SW not ready" 에러 페이지 / 또는 잘못된 host 로 resource 가 해소되어 404.

**Root cause**:
[web/sw.js#L228](../../web/sw.js) `runtimeAPI` GET 분기는 모든 GET 을 subresource 로 가정. iframe navigation 의 경우 (a) iframe 자체의 entry 가 부모 tab 내에 새로 생성되어야 가상 baseURI 가 iframe 의 target 으로 설정됨, (b) iframe clientId 가 새 entry 에 바인딩되어야 후속 subresource 가 ctx 해소 가능, (c) 응답을 `transformDocumentResponse` 로 통과시켜 prelude/CSP 주입.

**Fix**:
[web/sw.js#L237](../../web/sw.js) GET 분기에 `isDocumentRequest` 감지 (`req.mode === 'navigate'`, `req.destination === 'iframe'/'document'/'frame'`, Sec-Fetch-Dest 동일):
- isDocumentRequest 시: 새 entryId 생성 → `tab.entries.set(newEntryId, { entryId, targetUrl: canonical, baseUrl: canonical, ... })` → `bindClientContext(clientId, tab, entry)` → `transformDocumentResponse(resp, { tab, entry })`.
- accept 헤더도 document 용 `text/html,...` 로 분기.

**Regression guard**: TODO
- E2E: 페이지에 외부 host iframe (e.g. cross-origin embed) 추가하고 iframe 의 `contentWindow.location.href` 가 가상 target URL 반환하는지, iframe 내부 subresource 가 SW_NOT_READY 없이 로딩되는지 확인.

**Patterns to watch**: SW handler 가 destination = navigate / iframe / document 케이스를 별도 처리하지 않으면 부모 page 만 정상이고 iframe 은 항상 깨지는 종류의 회귀.

---

---

## 2026-08-20 — 축을 세우자마자 두 번째 진짜 탈출: `Refresh` **응답 헤더**

**어제의 교훈("축을 먼저 나열할 것")을 실행한 첫 라운드에서 바로 나왔다.**
내비게이션 축 매트릭스를 세우고 12칸을 돌리니 `n11-refresh-header` 하나가
빨간불이었다.

**무엇이었나**: `Refresh: 0;url=<target>` 은 비표준이지만 크롬이 지원하는
**헤더판 meta refresh** 다. 마크업이 아니라 응답 헤더라 htmltx 가 원리적으로
볼 수 없다. 어제 `<meta http-equiv=refresh>` 만 막아 둔 상태였다 — **같은 기능의
다른 전달 경로**를 놓친 것이다.

실측: 문서가 프록시 밖으로 나가고 브라우저가 착지 오리진으로 직접 요청 2건.

**★진짜 원인은 목록이 두 벌이었다는 것**:
Go 의 `internal/headers/policy.go` `hidden` 에는 `"refresh"` 가 **이미 있었다**.
그런데 **문서 응답은 커널→SW 경로로 와서 Go 의 `ConstructorPolicy` 를 안 지난다.**
정책이 존재하는데 그 정책을 지나지 않는 경로가 있었던 것이고, 두 목록이 조용히
갈라져 있었다. 이 부류는 "정책을 안 만들어서" 가 아니라 **"정책을 우회하는 경로가
생겨서"** 나는 구멍이라, 코드를 읽어도 안 보인다 — 경로별로 재 봐야 나온다.

**Fix 두 단계**:
1. SW 에도 같은 목록을 넣었다(`ZP_TARGET_POLICY_HEADERS`: Refresh / Link /
   Clear-Site-Data / Alt-Svc / Service-Worker-Allowed / SourceMap / Set-Cookie…).
   `Link: <…>; rel=preload` 는 브라우저가 헤더만 보고 타깃을 직접 가지러 가고,
   `Clear-Site-Data` 는 타깃이 **프록시 오리진의 저장소**를 지우게 하며,
   `Alt-Svc` 는 다음 연결을 타깃이 지정한 프로토콜/포트로 돌린다.
2. **지우기만 하면 안 됐다.** 탈출은 막히는데 타깃이 의도한 리다이렉트가 통째로
   사라진다(실측: 착지 실패). meta refresh 와 같은 처리로 바꿨다 — `url=` 부분만
   런처의 `?via=` 경로로 옮긴다. 결과: 탈출 0 **+** 착지 O.

**가드**: Go 의 `hidden` 맵을 파싱해 SW 가 그 이름들을 전부 처리하는지 대조한다.
목록이 두 벌인 구조 자체는 남으므로, 갈라지는 순간 실패하게 묶어 두는 것이
현실적인 답이다.

**교훈**:
1. **같은 기능의 다른 전달 경로를 함께 세울 것.** meta 로 되는 것은 헤더로도
   되는 경우가 많다(refresh, CSP, ...). 하나를 막았으면 나머지 전달 경로를
   그 자리에서 물어볼 것.
2. **"정책이 있다" 와 "이 응답이 그 정책을 지난다" 는 다른 문장이다.**
   `hidden` 에 이름이 있는 것을 보고 안심했다면 못 찾았다.
3. 막을 때는 **기능이 죽는지도 같이 잴 것**. 이번에는 매트릭스에 재현성 축
   (착지했는가)이 있어서 "탈출은 막았는데 기능이 죽었다" 를 그 자리에서 봤다.
   격리 축만 있었으면 죽은 채로 통과했을 것이다.

---

## 2026-08-21 — 해결: 릴레이로 받은 CSS 안의 `url()` 이 SW-less 문서에서 403

**어제 고친 것과 같은 부류인데 운반체가 달랐다.** SW 클라이언트가 아닌 문서는
스타일시트를 릴레이(`/zp/api/sync-fetch`)로 받는다. 그런데 SW 가 그 시트를
리라이트한 결과가 `/zp/api/fetch` 다 — **SW 안에만 있는 가상 경로**라 그 문서에서는
Go 까지 내려가 403 이 된다.

요소 속성이었다면 프렐류드의 blob 업그레이드가 잡았을 텐데, 운반체가 **CSS 텍스트**라
아무도 손대지 않았다. 릴레이 응답을 만드는 자리가 그 문서로 나가는 마지막 지점이다.

**Fix**: 릴레이 `kind=style` 응답에서 CSS 안의 `/zp/api/fetch?url=` 을 릴레이 URL 로
한 번 더 옮긴다. **상한 12개 + 초과분 로그** — 릴레이 요청은 Go 가 붙잡고 있어
HTTP/1.1 커넥션(호스트당 ~6)을 점유하고, 예전에 페이지 이미지를 전부 릴레이로
보냈다가 스타일시트가 큐에서 밀려 `deadSheets` 가 났던 전례가 있다. 조용히 자르면
"전부 처리됨" 으로 읽히므로 몇 개를 남겼는지 남긴다.

### ★이 항목의 진짜 교훈은 "무엇을 재고 있었나" 다

매트릭스에 `e6-adframe-css-link` 가 **이미 있었고 통과하고 있었다.** 그런데 e6 이
재는 것은 **스타일시트 자체의 도착**이지 그 안의 `url()` 이 아니다. 시트는 잘
도착하고 그 안의 이미지는 전부 403 인 상태가 초록불로 보였다.

→ **케이스가 있다고 그 표면이 덮인 게 아니다.** "무엇이 도착하면 통과인가" 를
한 칸씩 물어볼 것. `e7-adframe-css-image` 는 시트가 아니라 **시트 안의 이미지**가
도착하는지를 본다.

### 실사이트로는 증명할 수 없었다

naver 로 3회 재서 `err=0` 이 나왔지만, 그 광고(timeboard premium)가 간헐적이라
**"고쳐졌다" 와 "광고가 안 떴다" 가 구분되지 않았다.** 테이프를 열어 보니
sync-fetch 요청 10건 중 Image 는 0건 — 즉 그 경로 자체가 안 돌았다.

그래서 **빌드된 SW 에서 그 한 줄만 끄고 다시 쟀다**: `e7` 이 프록시 X + 재현성
결함으로 떨어지고, 켜면 O. 이게 인과의 증거다. **간헐적 실사이트 증상은 고정
픽스처로 옮겨 놓고 변이로 인과를 증명할 것** — "고친 뒤 증상이 안 보인다" 는
증거가 아니다.

---

## 2026-08-21 — 버그가 다른 버그의 증상을 가리고 있었다 (리다이렉트 상한)

**재려다가 나온 탈출**. 계획 5번(헤더 비대칭)을 확인하려고 타깃이 보낼 법한
헤더를 한꺼번에 싣는 프로브를 만들었다. 브라우저까지 살아서 간 것:
`connection` / `keep-alive` / `trailer` / `proxy-authenticate` / **`location`**.

Go 의 `ConstructorPolicy` 는 이 목록을 이미 걷어낸다. 그런데 **문서 응답은
커널→SW 경로라 Go 를 안 지난다** — `Refresh` 헤더 탈출과 **같은 구조**다.
같은 구조의 사고가 이틀 새 두 번 났다는 뜻이고, 그래서 이번엔 가드를 양방향으로
만들었다.

### 탈출

리다이렉트 상한을 넘으면 마지막 3xx 를 **그대로 페이지로 넘기고** 있었다.
그 `Location` 이 절대 URL 이면 브라우저가 따라간다. 6홉 체인으로 실측:

```
/redirloop/0 → … → (상한 초과) → 302 Location: http://127.0.0.1:18098/…
→ get-url: http://127.0.0.1:18098/img/redirloop-escape__cross.png
```

**타깃이 홉 수만 늘리면 되는 탈출이다.** 상대 Location 이어도 프록시 오리진의
비-프록시 경로로 나가 share 컨텍스트를 잃는다. 어느 쪽이든 넘기면 안 된다.

### ★상한 5 가 탈출에 가려져 있었다

크롬의 리다이렉트 상한은 20 인데 우리는 5 였다. **그런데 그 차이가 여태 아무
증상도 안 냈다** — 우리가 5에서 손을 떼면 그 3xx 를 받은 브라우저가 **이어서
따라갔기 때문**이다. 즉 탈출 버그가 "상한이 너무 낮다" 는 버그의 증상을 정확히
가려 주고 있었다. 탈출을 막자마자 `n13` 이 재현성 결함으로 빨간불이 됐다.

**교훈**: 어떤 버그를 고친 직후에 **새로 드러나는 결함**을 회귀로 오해하지 말 것.
가려져 있던 것이 나오는 경우가 있고, 이번이 그랬다. 반대로 "고쳤는데 아무 변화가
없다" 면 다른 버그가 증상을 대신 처리하고 있는지 의심할 것.

### 곁가지 실측

대조군 덕분에 하나 더 알았다 — **크롬은 25홉 체인도 끝까지 따라간다.** 흔히
알려진 상한 20 보다 관대하다. 우리는 20 에서 멈추므로 21~26홉 구간은 크롬이
되고 프록시가 안 된다. 실사이트에 그런 체인은 없다고 보고 받아들인 차이다
(다음 세션이 다시 재지 않도록 여기 적는다).

---

## 리다이렉트가 문서 entry 를 옮기는데, 서브리소스에도 걸렸다 — CNN 광고가 통째로 죽었다 (2026-08-25) {#리다이렉트-entry}

CNN 은 400 을 다 잡은 뒤에도 프레임이 **대조군 29~31 vs 프록시 11** 이었다.
요소 수는 이미 대조군을 넘었으니 "본문은 뜨는데 광고 iframe 만 안 뜬다" 였다.

### 좁힌 길

`document-start` 주입 MutationObserver 로 **iframe 이 만들어지는 순간**을
대조군/프록시 양쪽에서 셌다(31 vs 16). 없어진 쪽을 보니 전부 prebid 의
**user-sync 프레임**(`eus.rubiconproject.com/usync.html`,
`ads.pubmatic.com/…/user_sync.html` …) 이었다. 그것들은 **경매가 끝나야** 생긴다.

그래서 경매를 직접 봤다:

| | pbjs 버전 | `getEvents()` | 응답 |
|---|---|---|---|
| 대조군 | v11.18.5 | 66~73 | 4~5 |
| 프록시 | **v4.43.0** | **0** | 0 |

**같은 URL 인데 다른 파일**을 받고 있었다. `micro.rubiconproject.com` 은
**Referer 로 빌드를 고른다**(측정: `Referer: https://edition.cnn.com/` → 184,186B
v11.18.5, 없거나 `https://www.cnn.com/` → 47,219B v4.43.0. HTTP/1.1 에서도 같다).
CNN 의 adfuel 은 v11 API 를 기대하므로 v4 를 받으면 **경매가 아예 안 돈다.**

### 원인

SW 에 임시 로그를 넣어 나가는 Referer 를 봤다:

```
ZPREF url=https://micro.rubiconproject.com/prebid/dynamic/11016.js
      ref=https://sb.scorecardresearch.com/b2?c1=2&c2=6035748&…   ← 나가는 Referer
      over=https://edition.cnn.com/                               ← 페이지가 준 ref (정확)
```

페이지는 정확한 `ref` 를 실어 보냈는데 **버려졌다.** `transportFetch` 는
`opt.refOverride` 를 **entry 와 same-origin 일 때만** 받아들이는데, 그 entry 가
scorecardresearch 였기 때문이다.

entry 가 왜 트래커가 됐나 — 리다이렉트 처리에 있었다:

```js
if (entry) { entry.targetUrl = resolvedUrl; entry.baseUrl = resolvedUrl; }
```

**리다이렉트를 따라가며 entry 를 옮기는 건 내비게이션 얘기다.** 그런데 이 자리는
`transportFetch` 공통 경로라 **서브리소스 리다이렉트에도 똑같이 걸렸고**, entry 는
`opt.entryId || tab.activeEntryId` 로 잡힌다. 즉 **302 를 뱉는 추적 픽셀 하나가
문서 entry 의 URL 을 자기 주소로 바꿔 놓는다.** 광고/쿠키 동기화 픽셀은 302 로
도미노를 치는 게 정상 동작이라 CNN 에서는 로드마다 수십 번 일어난다.

고침: `if (entry && opt.document)`. 한 줄이다.

같이 고친 것 — `/zp/api/script`, `/zp/api/worker-script` 는 entry 를
`tab.activeEntryId`(= 탭에서 **가장 최근에 만들어진 문서**)로 잡고 있었다. iframe
이 하나라도 뜨면 최상위 문서의 스크립트 요청이 남의 프레임 entry 를 문다.
`/zp/api/fetch` 는 이미 요청 클라이언트의 ctx 를 먼저 봤는데 이 둘만 빠져 있었다.
**단, 정직하게: CNN 을 되살린 건 리다이렉트 한 줄이다** — entry 선택만 고쳤을
때는 v4.43.0 그대로였다(측정).

### 실측

| | pbjs | 이벤트 | 입찰응답 | 프레임 | 요소 |
|---|---|---|---|---|---|
| 고치기 전 | v4.43.0 | 0 | 0 | 11 | 4,033 |
| 고친 뒤 | **v11.18.5** | **86** | **7** | **20** | 4,041 |
| 대조군(같은 시각) | v11.18.5 | 72 | 4 | 31 | 4,055 |

### 이건 유출이기도 하다

엉뚱한 Referer 가 나간다는 건 **그 페이지에 박힌 다른 임베드의 URL 이 제3자에게
간다**는 뜻이다. 위 예에서 rubicon 은 이 사용자가 scorecardresearch 비컨을 어떤
파라미터로 쐈는지 알게 된다. 기능 버그로 보이지만 격리 위반이다.

### 교훈

- **공통 경로에 "내비게이션 전용" 상태 갱신을 놓지 말 것.** 이 자리는 문서
  리다이렉트만 생각하고 쓰였고, 주석도 문서 얘기만 했다. 조건 한 줄이 빠지면
  같은 코드가 서브리소스 수백 건에 대해 돈다.
- **가드가 정확한 정보를 버리고 있으면 가드를 의심하기 전에 가드가 기대는 상태를
  의심할 것.** 여기서 same-origin 가드는 제 일을 했다 — 기대는 entry 가 오염됐다.
- 재현 픽스처(`scratchpad/redir2.mjs`, 포트 18201/18202/18203)로 **문서 리다이렉트
  뒤 서브리소스 Referer** 를 대조군과 나란히 볼 수 있다. 그 김에 하나 더 보였다:
  교차 출처 서브리소스에 대해 브라우저는 **오리진만**(`http://host:port/`) 보내는데
  우리는 **전체 URL**(`…/page`)을 보낸다 — 기본 referrer policy
  (`strict-origin-when-cross-origin`)와 다르다. **아직 안 고쳤다.**

---

## Referrer-Policy 를 아예 안 보고 있었다 — 타깃이 금지한 것을 우리가 대신 흘렸다 (2026-08-25) {#referrer-policy}

앞 항목(리다이렉트 entry)을 고치며 만든 픽스처가 곁가지로 보여 준 것이다:
교차 출처 서브리소스에 브라우저는 **오리진만** 보내는데 우리는 **전체 URL** 을
보내고 있었다. 재 보니 더 나빴다 — **정책을 전혀 안 보고 있었다.**

### 대조군 vs 프록시 (고치기 전)

문서 `http://127.0.0.1:18202/page?tag=…` 가 선언한 정책별로, 교차 출처
서브리소스가 받은 Referer:

| 문서 정책 | 대조군 | 프록시(전) |
|---|---|---|
| (없음 = 기본) | `http://…18202/` (오리진만) | **전체 URL** |
| `no-referrer` | 없음 | **전체 URL** |
| `origin` | 오리진만 | **전체 URL** |
| `same-origin` | 없음 | **전체 URL** |
| `unsafe-url` | 전체 URL | 전체 URL |
| 요소 `referrerpolicy="no-referrer"` | 없음 | **전체 URL** |

**타깃이 명시적으로 금지한 것을 우리가 대신 흘렸다.** 기본값과도 달라서 그
자체가 지문이기도 하다(쿼리스트링이 통째로 제3자에게 간다).

### 정책은 지어낼 필요가 없었다

브라우저가 요청마다 계산해서 `Request.referrerPolicy` 로 넘겨준다 — **문서
정책과 요소의 `referrerpolicy` 속성이 이미 반영된 값**이다. 측정으로 확인:
같은 문서 안에서 `pol=no-referrer` 와 `pol=unsafe-url` 이 요청별로 따로 나오고,
정책이 "보내지 말라" 로 계산되면 `req.referrer` 가 빈 문자열이다.

우리 프록시 문서에 붙는 Go 쪽 `Referrer-Policy: no-referrer` 가 이 값을 오염시킬까
걱정했는데, 타깃이 `unsafe-url` 을 선언하면 그대로 `unsafe-url` 이 나온다 —
**타깃 정책이 흐른다.** (안 재고 넘어갔으면 모든 Referer 를 지울 뻔했다.)

고침:

- `refererForPolicy(base, target, policy)` — 8개 정책 전부. 강등(https→http)은
  빈 값, 전체 URL 이라도 자격증명·프래그먼트는 제거(명세).
- 정책 출처 우선순위: 페이지가 명시한 값 → **브라우저가 계산한 값** → 문서 응답의
  `Referrer-Policy` 헤더(entry 에 기억) → 브라우저 기본.
- 페이지의 `fetch()` 는 `/zp/api/fetch` 로 오므로 브라우저 계산값이 없다(그
  요청의 정책은 *프록시 문서* 의 것이다) — 프렐류드가 `init.referrerPolicy` 를
  실어 보낸다.

### 실측 (고친 뒤, 정책마다 7개 서브리소스 종류)

기본 / `no-referrer` / `origin` / `same-origin` / `unsafe-url` **전부 대조군과
같은 값**. 요소 단위 `referrerpolicy` 예외도 양방향으로 일치한다
(`no-referrer` 문서 안의 `unsafe-url` 요소만 전체 URL, `unsafe-url` 문서 안의
`no-referrer` 요소만 없음).

CNN 회귀: prebid v11.18.5 / 이벤트 79 / 입찰 6 / 프레임 21 — 그대로다(오리진만
보내도 rubicon 이 v11 을 준다).

### 남은 것

- `<meta name="referrer">` 로만 정책을 선언한 페이지는 **페이지가 부른 fetch()**
  경로에서 기본값으로 떨어진다. 브라우저가 내는 요청은 전부 정확하다(브라우저가
  meta 를 이미 반영해서 준다).
- 최상위 문서 요청의 Referer 가 **자기 자신의 URL** 이다. 대조군은 주소창에
  입력한 내비게이션에 Referer 를 안 보낸다. 앞 세션에서 링크 클릭 내비게이션의
  진짜 referrer(직전 페이지)를 SW 가 모른다는 구조 문제라 함께 봐야 한다.

### 곁가지 — nav-matrix 대조군 열이 비면 재현성 축은 무의미하다 (2026-08-25)

이번 실행에서 24칸 중 대조군이 착지한 것은 4칸뿐이었고, 나머지는 "대조군에서도
안 됨" 으로 분류됐다. 러너 주석이 2026-08-21 에 이미 경고한 모양 그대로다 —
앞 케이스의 내비게이션이 `/reset` 직후에 착지해 히트 로그에 **앞 케이스 id** 가
찍히면, 지금 케이스를 찾는 검사는 항상 빗나간다.

**그 상태에서 "재현성 결함 0" 은 증거가 아니다** — 대조군이 비면 "대조군은
되는데 프록시는 안 되는 것" 이 **구조적으로 빌 수밖에 없다.** 격리(탈출) 축은
대조군과 무관하므로 그쪽 판정만 유효하다.

다음에 이 스위트로 회귀를 주장하기 전에 대조군 열부터 볼 것. 그리고 러너는
`nohup … &` 로 띄우면 부모와 함께 죽는다(이번에 두 번 밟았다 — 빈 로그가
"통과" 처럼 보인다). 출력이 끝에 한 번에 나오므로 4~5분은 기다려야 한다.

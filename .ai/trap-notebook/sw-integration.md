# Service Worker Integration Regressions — 역사적 범주별 요약

`web/sw.js`의 classify / handleFetch / runtimeAPI / transportFetch / 메시지 라우팅에 관한 **과거 사건 요약이며 현행 승인 명세가 아니다**. 측정·검증은 당시 기록이고, 이번 문서 편집에서는 런타임 실행이나 신규 측정을 하지 않았다. 옛 테스트 제안·구현 공백은 역사적/미검증 기록이지 현재 TODO가 아니다. 후속 정정이 앞선 가설을 대체하며, 개별 수정이 GitHub·CF/Cloudflare·CNN 전체 호환성 해결을 뜻하지 않는다.

<a id="2026-08-21--go-의-응답-헤더-정책-전체가-죽은-코드였다-호출자-0-go-가-막고-있다-는-믿음이-실제-탈출을-낳았다"></a>
## 2026-08-21 — Go 응답 헤더 정책은 미호출 코드

- **원인·정정:** `ConstructorPolicy` / `HiddenHeader` / `ApplyChallengeCompat` / `ChallengeSubresourceSkip`은 테스트 외 호출자가 없었다. `main.go`가 사용하는 `internal/headers` 기능은 `BuildCSP`뿐이었다. 8/20의 “문서만 Go 정책을 우회한다”는 설명은 틀렸으며 **어떤 응답도 그 정책을 거치지 않았다**.
- **수정·규칙:** `policy.go`, `challenge.go`와 테스트를 삭제하고 `csp.go` 유지. `crates/zp-shared/testdata/response_header_policy.json`의 reporting/directive/hop_by_hop 목록을 빌드가 `__ZP_*_HEADERS__`에 주입하고 SW 삭제 루프도 공유한다. CORS의 무효 조합 `*` + credentials 허용은 구체 Origin을 반영할 때만 credentials를 켜도록 수정했다. Origin 없는 요청에서 발생했으나 피해는 관측되지 않았다.
- **당시 검증:** 삭제 후 Go 빌드·테스트 영향 없음. `/zp/`, `/zp/api/sync-fetch`, `/__zp/*.wasm`에 `Access-Control-*` 없음. `/hdrprobe`에서 리포팅 헤더, `Link`, `Location`, `Clear-Site-Data` 잔존 없음; hole/static/cargo/Go 테스트 통과. 가드는 죽은 Go 목록 비교 대신 **픽스처의 실제 빌드 주입·Go 사본 부활 금지**를 검사하도록 변경했다. 가드 대상이 실행되는지 먼저 확인한다(`internal/htmltx` 죽은 사본도 같은 전례).

<a id="2026-05-30--iframe-document-referer--parenttargeturl-광고-iframe-차단-해소"></a>
## 2026-05-30 — iframe Referer에 부모 URL 사용

- **원인:** NAVER `shopsquare.naver.com` 광고 문서가 embedder Referer를 요구했으나 `transportFetch`는 iframe 자신의 `entry.baseUrl`을 보내 `POLICY_BLOCKED`/404가 발생했다.
- **수정:** `web/runtime-prelude.js`의 `activatedFrameURL`이 `ZP_FRAME_ROUTE`에 `parentTargetUrl: virtualURL.href`를 포함하고, `web/sw.js`가 canonicalize하여 저장. `opt.document && entry.parentTargetUrl`이면 이를 `X-ZP-Referer`로 사용했다.
- **상태:** 광고 iframe 차단 해소로 기록됐다. 이는 당시 부모 참조 선택 수정이며, 이후 Referrer-Policy 처리까지 대체하는 일반 규칙은 아니다.

<a id="2026-05-30--3xx-redirect-server-side-following-rtroundtrip--followredirects"></a>
## 2026-05-30 — 서버 측 3xx 추적

- **원인:** `rt.RoundTrip`이 광고 iframe의 상대 `303 Location`을 그대로 반환해 브라우저가 프록시 오리진에 해소했고, SW UNKNOWN/차단으로 이어졌다.
- **당시 수정:** `cmd/zeroproxy-server/relay.go`의 `followRedirects(ctx, rt, req, jar)`를 `bridgeRelayWS`와 `bridgeMuxRelayWS`에 적용. 당시 최대 10홉, 301/302/303 GET 변환, 307/308 본문 보존·재시도 불가 시 반환, 홉별 쿠키 수집, cross-host Authorization/Cookie 제거, 최종 Location 제거를 기록했다.
- **정정·상태:** 브라우저로 원시 Location을 누출하지 않는 것이 핵심이다. 당시 메서드 설명을 현행 계약으로 삼지 않는다. 후속 상한 탈출 및 9/6 요청 계약 수정이 이 단순화된 설명을 보완·정정한다.

<a id="2026-05-29--user-agent-forbidden-header-smuggle"></a>
## 2026-05-29 — User-Agent 전달 누락

- **원인:** 당시 Request 경로에서 UA가 사라져 relay가 빈 값 또는 `Go-http-client/1.1`을 보냈고 Wikipedia 등의 봇 방어에 걸렸다. UA의 forbidden-header 동작은 브라우저별 차이가 있는 역사적 설명이다.
- **수정:** [web/zp-core.js](../web/zp-core.js)의 `TARGET_USER_AGENT`를 공유. [web/sw.js](../web/sw.js)가 `X-ZP-User-Agent`를 설정하고 [cmd/zeroproxy-server/relay.go](../cmd/zeroproxy-server/relay.go)의 양 relay가 UA로 promote하며 동일 기본값 사용. [web/runtime-prelude.js](../web/runtime-prelude.js)의 JS-visible UA도 같은 상수로 통합했다.
- **당시 검증:** Wikipedia 본문 렌더·NAVER 무회귀. `"Please set a user-agent"` 또는 서버의 Go UA는 회귀 신호였다. Cookie/Sec-Fetch 계열·클라이언트 힌트 등의 추가 전달은 당시 검토사항이며 Cloudflare 해결 증거는 아니다. [POST body + Referer/Origin](#2026-05-29--post-body--refererorigin-누락) 참조.

<a id="2026-05-29--post-body--refererorigin-누락"></a>
## 2026-05-29 — POST body + Referer/Origin 누락

- **별도 원인 1·수정:** [crates/zp-kernel/src/lib.rs](../crates/zp-kernel/src/lib.rs)의 `kernel_fetch`가 항상 빈 body를 전달했다. GET/HEAD를 제외하고 `extract_body_bytes` 결과를 `sess.fetch`에 전달하도록 수정했다.
- **별도 원인 2·수정:** [web/sw.js](../web/sw.js)에서 직접 설정한 Referer/Origin이 Request 생성 시 제거됐다. `X-ZP-Referer`, 비-GET/HEAD의 `X-ZP-Origin`으로 전달하고 relay에서 promote하되 **모든 `x-zp-*` 내부 헤더는 upstream 전달 전에 제거**했다.
- **당시 검증:** NAVER recoshopping API 200 및 추천 위젯 렌더. `body-set=false`와 빈 referer가 두 결함을 구분하는 로그 신호였다. [build-deploy.md](build-deploy.md), [real-site-compat.md](real-site-compat.md#2026-05-29--naver-우측-상단-recoshopping-nextjs-iframe-application-error) 참조.

<a id="2026-05-29--target-script-에러-diagnostics"></a>
## 2026-05-29 — target 오류 diagnostics

- **원인:** iframe 런타임의 silent throw/fallback은 콘솔 문맥 전환이 필요하고 reload 시 외부 hook이 사라져 추적이 어려웠다.
- **수정:** [web/runtime-prelude.js](../web/runtime-prelude.js)가 window별 `__zp_diagnostics` ring buffer(최대 200개)에 capture-phase `error`, `unhandledrejection`, `console.error`를 기록. `Symbol.for('zeroproxy.runtime.installed')`로 중복 설치를 막는다.
- **상태:** 설치 marker와 buffer 존재 여부를 회귀 신호로 제안했다. 페이지 덮어쓰기 또는 marker만 있고 buffer가 없는 경우를 감지 대상으로 기록했으며 별도 실행 검증은 제시되지 않았다.

<a id="2026-05-29--ws-mux-1-ws--n-stream"></a>
## 2026-05-29 — WS mux

- **원인:** `crates/zp-kernel/src/lib.rs`의 요청마다 `/zp/relay` WS를 새로 열고 서버도 응답 후 닫아, 서버 transport pool만으로는 upgrade 비용을 없애지 못했다.
- **수정·불변식:** `/zp/relay-mux`의 binary frame은 BE u32 stream ID + type + payload(ENVELOPE/BODY_UP/HEAD/BODY_DOWN/ERROR/CANCEL). `cmd/zeroproxy-server/relay.go`의 단일 read loop가 stream별 goroutine/`chanBodyReader`로 분배하며 **모든 write는 `sendMu`로 직렬화**한다. `crates/zp-kernel/src/mux.rs`의 singleton `MuxSession`은 stream별 slot과 연결 전 pending queue를 관리한다.
- **당시 검증·한계:** NAVER 로딩 개선과 WS 재사용 확인; 첫 navigation race의 legacy 연결은 남았다. 세션 획득 실패 시 `relay_fetch_owned` fallback, close 시 `mark_dead`로 pending reject 후 lazy 재연결. u32 wrap 충돌과 bounded upload buffer의 다른 stream 정체는 당시 잠재 한계였다. [서버 pool 수정](build-deploy.md#2026-05-29--upstream-connection-pool-누락) 참조.

<a id="2026-05-29--zpapifetch-가-script-destination-미감지"></a>
## 2026-05-29 — `/zp/api/fetch` script destination 누락

- **원인:** zp-htmltx가 absolute script URL도 `/zp/api/fetch`로 통합했으나 handler는 CSS/raw만 처리했다. raw JS가 native window/location에 접근해 `__zp_get` 멤브레인을 우회했다.
- **수정:** [web/sw.js#L228](../../web/sw.js), [web/sw.js#L266](../../web/sw.js)의 GET 분기에 `req.destination` 또는 `Sec-Fetch-Dest`의 script/worker/sharedworker를 감지하고 `rewriteScriptResponse`와 `scriptKindFromRequest`를 적용했다.
- **상태:** 응답의 `__zp_get` 확인 E2E와 `test/js/sw-runtime.test.js` 신설은 **당시 미검증 제안**이었다. classify→handler→rewrite가 분산된 다른 API 분기의 destination 누락도 당시 주의사항이다.

<a id="2026-05-29--iframe-boottargeturl-가-parent-의-url-로-잘못-등록되어-멤브레인-cascade-실패-p1"></a>
## 2026-05-29 — iframe boot.targetUrl 부모 오등록 가설

- **증상:** NAVER 메뉴·쇼핑·광고 iframe이 비거나 Application error를 보였고, iframe의 `eval('location.href')`와 `documentBaseURI`가 부모 root를 반환했다.
- **당시 가설:** `activatedFrameURL` fallback, `proxyDocument`의 부모 entry lookup, 가변 `tab.activeEntryId` 오염을 의심했다. 상대 URL을 부모 base로 해소하는 것 자체는 정상이며 원인으로 확정되지 않았다.
- **후속 관계·상태:** 아래 `/zp/api/fetch` navigation entry 미생성이 구체 수정으로 기록됐다. 내부 상태 dump·전체 iframe URL E2E는 당시 제안일 뿐이고, “모든 iframe widget 동시 해결”은 검증되지 않은 기대였다.

<a id="2026-05-29--iframe-zpapifetch-navigation-entry-미생성"></a>
## 2026-05-29 — iframe navigation entry 미생성

- **원인:** [web/sw.js#L228](../../web/sw.js)의 runtime GET이 navigation까지 subresource로 처리해 부모 entry를 사용했다. 잘못된 baseURI 및 iframe clientContext 바인딩 전 subresource의 `SW_NOT_READY` race가 발생했다.
- **수정:** [web/sw.js#L237](../../web/sw.js)에서 navigate/iframe/document/frame을 감지해 iframe 자체 entry 생성, clientContext 바인딩, document Accept 선택 및 `transformDocumentResponse`의 prelude/CSP 주입을 적용했다.
- **상태:** cross-host iframe의 가상 URL·subresource 정상 로딩 E2E는 당시 미검증 제안이다. 부모 문서 정상만으로 iframe 경로를 검증할 수 없다.

<a id="2026-08-20--축을-세우자마자-두-번째-진짜-탈출-refresh-응답-헤더"></a>
## 2026-08-20 — `Refresh` 응답 헤더 탈출

- **원인·후속 정정:** meta refresh만 처리해 헤더판 Refresh가 프록시 밖 navigation을 일으켰다. `internal/headers/policy.go`의 hidden 목록을 믿었으나, 8/21 확인 결과 문서만 우회한 것이 아니라 Go 정책 전체가 미호출이었다.
- **수정·금지:** SW의 `ZP_TARGET_POLICY_HEADERS`에 Refresh/Link/Clear-Site-Data/Alt-Svc/Service-Worker-Allowed/SourceMap/Set-Cookie 등을 처리했다. 직접 preload, 프록시 저장소 삭제, 연결 목적지 변경을 허용하면 안 된다. Refresh 단순 삭제는 착지를 깨므로 `url=`을 런처 `?via=`로 옮겼다.
- **당시 검증·정정:** 직접 탈출과 착지 실패를 각각 재현한 뒤 탈출 없음+착지 성공 확인. Go hidden↔SW 비교 가드는 이후 폐기·대체됐다. 같은 기능의 meta/헤더 전달 경로와 격리/기능 보존을 함께 검증해야 한다.

<a id="2026-08-21--해결-릴레이로-받은-css-안의-url-이-sw-less-문서에서-403"></a>
## 2026-08-21 — SW-less CSS `url()` 403

- **원인:** SW client가 아닌 문서가 `/zp/api/sync-fetch`로 받은 CSS 내부 URL은 SW 전용 `/zp/api/fetch`로 남아 Go에서 403이 났다. 요소 속성용 blob 업그레이드는 CSS 텍스트를 처리하지 못했다.
- **수정:** relay `kind=style` 응답에서 내부 fetch URL을 relay URL로 재변환. HTTP/1.1 연결 점유로 stylesheet가 밀려 `deadSheets`가 났던 전례 때문에 12개 상한과 초과 로그를 두었다. 초과분까지 처리됐다고 간주하면 안 된다.
- **당시 검증:** `e6-adframe-css-link`는 시트 도착만 확인했다. NAVER 무오류 실행은 광고 이미지 경로 자체가 없어 증거가 아니었다. `e7-adframe-css-image` 고정 픽스처에서 빌드 SW 수정 줄을 끄면 실패, 켜면 성공해 인과를 확인했다.

<a id="2026-08-21--버그가-다른-버그의-증상을-가리고-있었다-리다이렉트-상한"></a>
## 2026-08-21 — 리다이렉트 상한 탈출과 가려진 호환성 결함

- **원인:** 상한 초과의 마지막 3xx/Location을 브라우저에 넘겼다. 절대 URL은 직접 탈출하고 상대 URL도 프록시 비라우트로 나가 share 문맥을 잃는다. connection/keep-alive/trailer/proxy-authenticate도 헤더 프로브에서 살아남았다. Go가 방어한다는 설명은 위 8/21 정정으로 폐기됐다.
- **수정·규칙:** 상한 초과 응답을 그대로 넘기면 안 된다. 차단하자 기존 5홉 제한의 기능 결함이 드러나 20으로 늘렸다. 이전에는 브라우저가 이어 따라가 낮은 상한을 가렸으므로, 수정 직후 드러난 결함을 곧바로 회귀로 해석하면 안 된다.
- **당시 검증·차이:** 탈출 및 `n13` 착지 실패를 관측했다. 대조군 Chrome은 알려진 “20홉 상한”과 달리 25홉도 완료했다. 프록시가 20에서 멈추는 긴 체인 차이는 당시 수용했으며 브라우저와 동등하다는 증거가 아니다.

## 서브리소스 redirect가 문서 entry를 오염 (2026-08-25) {#리다이렉트-entry}

- **원인:** `transportFetch`의 무조건적인 entry URL 갱신으로 추적 픽셀 redirect가 문서 entry를 덮었다. 올바른 `opt.refOverride`도 오염된 entry와 same-origin이 아니어서 버려졌다. `micro.rubiconproject.com`은 Referer로 prebid 빌드를 골랐고 CNN adfuel이 기대하는 v11 대신 v4를 받아 경매가 멈췄다. 다른 embed의 쿼리 URL을 제3자에게 보내는 **정보 유출**이기도 했다.
- **수정:** URL 갱신을 `if (entry && opt.document)`로 제한. `/zp/api/script`, `/zp/api/worker-script`도 최근 `tab.activeEntryId` 대신 요청 client ctx를 우선 사용하도록 수정했다. same-origin 가드 자체가 아니라 기반 상태가 잘못됐다.
- **당시 검증·미해결:** entry 선택만 수정하면 v4 그대로였고 문서 조건 추가 후 v11·경매·입찰이 회복됐다. **CNN 프레임은 여전히 대조군보다 적었다.** `scratchpad/redir2.mjs`에서 발견한 cross-origin 전체 Referer 유출은 당시 미수정이었으나 다음 정책 수정으로 이어졌다.

## Referrer-Policy 무시 (2026-08-25) {#referrer-policy}

- **원인:** 기본 정책뿐 아니라 `no-referrer`, `origin`, `same-origin`, 요소 정책도 무시하고 전체 URL을 보냈다. 금지된 쿼리 정보 유출이며 브라우저와 다른 신호였다. Go의 프록시 `no-referrer`가 타깃 정책을 항상 덮는다는 우려는 실측으로 기각됐다.
- **수정:** `refererForPolicy`에 8개 정책과 강등 처리를 구현하고 전체 URL에서도 자격증명·fragment를 제거. 정책 우선순위는 페이지 명시값→브라우저 계산값→entry의 응답 헤더→기본값. 페이지 fetch의 프록시 요청 정책은 타깃 계산값이 아니므로 prelude가 `init.referrerPolicy`를 전달한다.
- **당시 검증·후속:** 여러 subresource 종류에서 기본/네 정책 및 요소 예외가 대조군과 일치했고 CNN prebid 무회귀. meta-only 페이지 fetch와 최상위 자기 Referer는 당시 남았으나 8/26 별도 항목에서 수정·검증됐다. CNN 전체 해결은 아니다.

### nav-matrix 대조군 오염 정정 {#nav-matrix-대조군}

- **기각된 진단:** 대조군 착지 누락을 옛 러너 계측 결함으로 설명했으나 틀렸다. 수동 재현 및 코드 변경 없는 재실행에서 정상 착지와 재현성 결함 없음이 확인됐다. 남은 미착지는 팝업 차단 등 실제 브라우저 제한이었다.
- **실제 원인·규칙:** 공유 `--id zp` 데몬에서 CNN 프로브를 동시에 실행해 측정을 오염시켰다. nav-matrix/hole-matrix/rendercheck는 단독 실행하며 다른 인스턴스의 브라우저 조작도 금지한다.
- **측정 주의:** 옛 주석과 증상 모양만으로 원인을 재사용하지 않는다. `nohup … &`가 부모와 함께 종료돼 생긴 빈 로그도 통과 증거가 아니다.

## <a id="clients-get-교착"></a>`clients.get` 응답 교착 (2026-08-25, CNN)

- **원인:** `reportEncodedSize`가 응답 경로에서 resulting client의 `clients.get`을 await했다. client 생성은 응답 커밋을 기다려 순환 대기가 생겼다. SW는 200을 만들었지만 버퍼 문서 iframe만 about:blank에 머물고 load/error도 없었다. await를 타지 않는 스트리밍 경로는 정상이었다.
- **수정·검증:** **응답 경로에서 `clients.get()`을 await하지 않는다.** 진단 메시지는 비동기 발송하고 `recordEncoded` pull 경로를 사용한다. `static-policy.test.js` 금지 검사 및 영원히 resolve하지 않는 mock으로 응답 완료를 검증했다. 클린 빌드 CNN에서 미응답 문서가 두 번 연속 사라졌으나 전체 CNN 해결을 뜻하지 않는다.
- **계측 정정:** dist 래퍼는 원본보다 정체를 늘렸고 전역 `self.__ZPNAV_REC`는 동시 요청 기록을 덮었다. “tf-pre-kernelFetch 정지” 진단은 오답이었다. 원본 지표와 비교하고 요청별 레코드를 전달해야 한다.
- **별도 수정:** 같은 커밋의 transport 데드라인은 기존 Rust 주석에만 있던 caller timeout을 구현했다. 이 교착에서는 발화하지 않아 커널 밖 원인임을 뒷받침했다. 당시 20초 예산은 다음 항목에서 정정된다.

## <a id="자기-referer"></a>최상위 문서의 자기 Referer (2026-08-26)

- **원인:** 부모가 없을 때 `entry.targetUrl`을 참조 base로 삼아 주소창 첫 로드도 자기 URL을 보냈다. 헤더만 읽는 중간 수정은 반대로 링크 클릭 Referer까지 없앴다.
- **수정·규칙:** navigation의 참조는 `request.headers.get('Referer')`가 아니라 **`request.referrer`**에서 읽고 프록시 라우트를 타깃 URL로 복원한다. 참조가 없으면 보내지 않으며 `about:client`를 URL로 사용하지 않는다.
- **당시 검증:** 로컬 에코 서버 18211에서 주소창은 Referer 없음, 링크 클릭은 직전 페이지 URL로 대조군과 일치했다. 8/25의 해당 미해결 기록을 대체한다.

## <a id="meta-referrer"></a>meta 정책이 페이지 fetch에 누락 (2026-08-26)

- **원인:** 직접 이미지/스크립트 요청에는 브라우저의 meta 정책 계산값이 왔으나, 페이지 fetch의 `Request.referrerPolicy`에는 문서 정책이 반영되지 않았다. `ZP_REFERRER_POLICY`를 DOMContentLoaded/load/타이머에 보내는 초기 수정도 파싱 중 첫 fetch보다 늦었다.
- **수정:** 요청 생성 시 `req.referrerPolicy || documentReferrerPolicy()`로 문서를 즉시 읽는다. 메시지는 XHR 등 정책을 전달하지 못하는 경로의 보조로 유지하고 SW는 알려진 정책 토큰만 수락한다.
- **당시 검증:** meta-only 로컬 fetch에서 `no-referrer`/`origin`/`unsafe-url` 모두 대조군과 일치했다. 8/25의 해당 공백을 대체하며, 임의 문자열의 default fallback을 정책 준수로 오인하면 안 된다.

## <a id="csp-스트리밍-정정"></a>정정: 스트리밍도 CSP 헤더 강제 (2026-08-26)

- **기각된 가설:** “SW 스트리밍 응답은 CSP 헤더가 무시된다”는 `sw.js` 설명은 틀렸다. 당시 taskweaver 기본 `Page.setBypassCSP` 때문에 CSP 전체가 꺼져 있었다.
- **당시 검증·정정:** meta를 제거한 dist에서 `--enforce-csp` 사용 시 스트리밍 외부 fetch/이미지 및 버퍼 외부 fetch가 차단됐다. 기본 bypass 데몬에서는 허용됐다. 헤더가 정본이고 meta는 헤더 무효의 대안이 아니라 추가 방어라는 정정이다.
- **측정 규칙:** `taskweaver list`의 `csp_bypassed`를 먼저 확인한다. 강제 시험은 stop 후 `start --enforce-csp`로 새 데몬에서 수행해야 한다. 격리 월드도 페이지 CSP를 받으므로 리라이터를 거치지 않는 fetch/img로 정책만 시험할 수 있다.

## <a id="transport-데드라인-실측"></a>데드라인은 H1 응답 전체를 제한 (2026-08-26)

- **원인·정정:** `1bcae09`의 `kernelFetch` 데드라인은 단순 TTFB 제한이 아니다. 헤더 즉시 resolve하는 스트리밍은 HTTP/2의 `finish_h2_response` 경로뿐이며 HTTP/1.1은 본문 완료까지 기다려 느린 정상 전송도 예산에 걸렸다.
- **수정·당시 검증:** 로컬 지연 헤더/느린 본문/침묵 상류로 확인했다. 20초가 정상 본문을 504로 잘라 90초로 늘렸고 느린 본문 완료와 침묵 상류의 유한 종료를 확인했다. 목적은 느린 다운로드 금지가 아니라 무한 대기 방지였다.
- **당시 미해결:** H1 헤더 수신 통지 없이는 TTFB 기준으로 짧게 제한할 수 없다. JS timeout은 Rust future를 취소하지 않아 요청이 커널에 남는다. 사용자 코드는 `TARGET_CONNECT_FAILED`여서 연결 거절과 같고 refusalLog의 `TRANSPORT_DEADLINE`만 구분한다.

## <a id="request-context-redirect"></a>redirect 경계의 요청 문맥·body view 소실 (2026-09-06)

- **원인:** `bodyU8.buffer`가 subarray 범위를 무시했다. redirect 재귀는 307/308 외 메서드를 모두 GET으로 바꾸고 수동 options 재조립으로 header/referrer 정책을 잃었다. runtime POST는 전달받은 credentials/redirect/mode를 소비하지 않았고 문서 문맥은 비동기 초기화 뒤 가변 active entry에서 읽었다.
- **수정·규칙:** `transportFetch`가 entry/referrer snapshot·body를 먼저 정규화하고 `transportFetchHop`이 같은 문맥을 유지한다. 301/302의 POST 변환과 303의 GET/HEAD 예외, entity header 제거, cross-origin Authorization 제거, credentials별 Cookie/Set-Cookie, manual/error redirect를 명시했다. page/worker 응답은 native Response를 유지하며 내부 metadata로 URL/type/redirected/clone을 복원한다. decoder 상태는 top-level 설치 호출 전에 선언해 prelude TDZ를 피한다.
- **실제 검증:** `test/js/request-policy.test.js`의 수정 전 PUT 회귀 실패 및 수정 후 경량 JS 전체 통과. [CI run 34020783071](https://github.com/gosuda/zeroproxy/actions/runs/34020783071)의 Chromium에서 `test/e2e/request-contract.js` 요청 계약 4그룹(method/body, credentials, error/manual, history/referrer)과 직접 egress 검사가 통과했다. **같은 run의 다른 WASM/E1 실패로 전체 CI는 실패**였다.
- **경계:** 초기 재현은 커널 대체 경량 회귀이지 실사이트 재현이 아니다. 로컬 Rust/Go 컴파일·Chromium은 메모리 부족 정책으로 실행하지 않았다. SW 재시작 복구, PSL/SameSite/partition, 완전한 CORS는 당시 별도 로드맵이며 이 기록으로 해결을 주장하지 않는다. **타깃 direct egress 또는 CSP 완화로 우회하지 않는다.**

## <a id="pull-stream-lifetime"></a>첫 바이트와 취소를 보존하는 응답 수명 (2026-09-06)
- **원인:** H1 전체 buffering으로 첫 chunk가 늦었다. H2 codec 종료를 HTTP 종료로 취급하는 우회는 무결성 검증을 생략했고, SW 응답 재생성은 HTML의 완료 promise를 잃었다.
- **수정:** H1/H2 pull stream·backpressure·Abortable 취소를 공유한다. framing과 압축 검증 완료 후에만 H1 연결을 풀에 반환한다. gzip/deflate는 증분 검증, br/zstd·실행 코드는 bounded buffering. SW 최종 응답 경계에서 EOF/error/cancel까지 waitUntil을 유지한다.
- **계약:** `X-ZP-Body-Stream`은 본문 수명, `X-ZP-Stream`은 HTML 변환 선택에만 사용하고 모두 페이지 전달 전에 지운다. HEAD/204/304·trailer·잘린 본문·idle cancel 회귀를 CI에서 확인한다.
- **Response 재생성:** 브라우저가 빈 stream을 노출하더라도 204/205/304를 새 Response로 만들 때는 body를 null로 전달해야 한다.

## <a id="websocket-request-identity"></a>WebSocket handshake의 문서 신원 (2026-09-06)
- **원인:** WS handshake에 User-Agent/Cookie가 없고 Origin은 요청 문서 대신 WS 서버 기준이었다.
- **수정:** SW가 검증된 entry의 Origin·고정 browser persona·목적지 jar 쿠키를 초기화 전에 캡처해 커널로 전달한다. 커널은 지정된 헤더만 허용하고 CR/LF/NUL을 거절한다.
- **검증:** 실제 E2E handshake의 UA·Origin·쿠키와 subprotocol echo/명시 close 결과를 확인한다. 헤더 신원 수정은 원격 anti-bot 통과 보장이 아니다.
- **Close 경계:** Close frame 직후 yamux FIN을 보내면 Go relay의 양방향 종료가 peer echo를 잘라 1006이 된다. frame을 flush한 뒤 실제 peer Close를 받고 종료한다. peer code/reason만 보고하며 실패·조기 취소는 1006/unclean이다.

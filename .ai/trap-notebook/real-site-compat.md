# Real-Site Compatibility Patterns — 역사적 범주 요약

실사이트에서 관찰한 과거 원인·수정·반증 기록이며 **현재 승인 사양이 아니다**. 측정·검증은 모두 당시 결과이고, 이번 문서 편집에서 런타임 실행이나 새 측정은 없었다. 과거 제안 테스트·구현 공백은 미검증 이력이지 현재 TODO가 아니다. 제거된 ARCHITECTURE/PHASE 상태 문서는 역사적 참고이며 현재 권위가 아니다. 후속 정정이 앞선 가설보다 우선한다.

현재 상태: GitHub 에러 페이지와 CF 전체 콜드 호환성은 미해결로 유지한다. CNN 두 번째 정지는 원인 미확정·미재현이며, 뒤의 대기시간/광고 구성 정정과 개별 회복 관찰도 전체 완료가 아니다. CF의 과거 [eval 수정](LOG.md#2026-08-18-15)과 [clearance 착시](LOG.md#2026-08-18-18)는 구별한다.

<a id="2026-07-30--모든-get-폼-제출이-프록시-자신을-타깃으로-삼음-naver-검색-찾을-수-없음"></a>
## 2026-07-30 — GET/POST 폼이 프록시 자신을 타깃으로 삼음

- **원인**: htmltx가 `action`/`formaction`을 `<proxy>/zp/?via=<target>`으로 바꾼 뒤 `submitFormNavigation()`이 raw attribute를 되읽었다. GET은 쿼리를 폼 데이터로 통째 교체하여 `via`를 파괴했고, POST도 잘못된 런처를 `ZP_SUBMIT_PREPARE.targetUrl`로 전달했다. NAVER 검색의 `TARGET_CONNECT_FAILED`는 토큰·전송 문제가 아니라 전 사이트 공통 폼 버그였다.
- **수정·불변식**: [web/runtime-prelude.js](../../web/runtime-prelude.js)의 `submissionActionURL(form, submitter)`가 클릭 경로처럼 `urlMeta → data-zp-target-url → raw attribute`로 해소한다. raw는 미리라이트 JS 생성/상대경로 폼의 fallback뿐이다. 리라이트 attribute는 네이티브 UI용 출력이며 내부 진실로 되읽지 않는다. hover·중클릭·새 탭·주소 복사에서 원본 호스트 노출/직접 접속을 허용하지 않는다. GET action용 런처 타깃은 쿼리 대신 path에 있어야 안전하다.
- **증거·검증**: `form.action`은 가상화되어 정상처럼 보였고 stash는 stealth membrane 때문에 `getAttribute`에서 숨겨졌다. NAVER 영어·한글 검색 성공, static-policy 70/70 통과. [test/js/static-policy.test.js](../../test/js/static-policy.test.js)가 helper 경유 및 raw `formaction || action` 패턴 재등장 금지를 고정했다.

<a id="2026-06-05--naver-probe-shape-windowzpzeroproxyrt-가시--tight-loop-probe--taskweaver-env-noise-근본-해결-1차"></a>
## 2026-06-05 — NAVER 지문 노출·루프 캡·taskweaver 환경

- **원인**: [6월 4일 기록](#2026-06-04) 이후에도 warm-session wedge 지속. 멤브레인 함수의 native `toString` 마스크는 대체로 정상이었지만, non-enumerable `window.ZP`/`ZeroProxyRT`는 `getOwnPropertyNames(window)`에 노출됐다. taskweaver는 Chrome이 아니라 WebView2+Tauri이며 `__TASKWEAVER_*`, `__TAURI*`, `ipc` 등 통제 밖 host globals도 주입한다.
- **수정·규칙**: [web/zp-core.js](../../web/zp-core.js), [web/zp-rt.js](../../web/zp-rt.js)를 configurable로 바꾸고 [prelude IIFE](../../web/runtime-prelude.js)에서 클로저 캡처 후 삭제했다. Symbol 설치 마커는 유지하되 `getOwnPropertySymbols`에는 보인다. [rewriter](../../crates/zp-rewriter/src/lib.rs)는 상수 무한 `for/while/do`에 캡을 추가하고 유한 조건은 유지했다. body의 break/continue/closure 의미를 보존하며 중첩 카운터를 분리했다.
- **검증·한계**: 루프 단위 테스트 7개 통과. 사용자 수동 msedge 검증에서는 광고·뉴스·쇼핑·날씨 포함 풀 렌더, wedge 미관찰; taskweaver에서는 여전히 wedge. 당시에는 host 지문이 효과를 가리는 주원인으로 판단했다. Chrome 동일성은 추정, Firefox는 미검증이며 NAVER에서 루프 캡 발동도 미관찰이다. SDK sandbox·chained reflection 조정·recursive timeout 캡은 당시 제안뿐이다. [전날 SDK mitigation](#2026-06-04-—-naver-warm-session-v8-wedge) 참조.

<a id="2026-06-04--naver-warm-session-v8-wedge-wtmncpt-block-만으로-부족-gfpnacveta-sdk-도-wedge-광고-미렌더-trade-off"></a>
## 2026-06-04 — NAVER warm-session wedge와 SDK 차단 대가

- **원인**: [web/sw.js sharedJars/openCookieDb](../../web/sw.js)의 IDB 쿠키 영속화로 NACT가 복원되자 trusted 무거운 번들이 제공되고 V8 tight-loop wedge가 재현됐다. cold session은 wedge 없이 interactive에 머물며 일부 미렌더. 외부 트래커·WTM/NCPT 차단만으로 부족했고 GFP/NAC/Veta도 관여했지만 bisect는 간헐적이라 단일 원인을 확정하지 못했다.
- **당시 완화**: `edd98d4`에서 `pm.pstatic.net/resources/js/{main,polyfill,preload,search}.*.js`와 `ssl.pstatic.net/{tveta/libs/glad/,melona/libs/gfp-nac-module/,tveta/libs/assets/}`를 차단했다. 뉴스·로그인·메뉴는 complete에 도달했지만 SDK 광고 슬롯은 비었다. GFP 단독/전체 SDK 재허용은 incomplete·wedge를 되살렸고 userAgentData stub은 추가 효과가 없었다.
- **증거·후속**: [web/sw.js NAVER block](../../web/sw.js). native-code 검사·Client Hints가 관찰됐으나 추가 지문은 미확정. 6월 1일 WTM/NCPT, 5월 31일 `installSafeFrameResizeShim`, 5월 30일 SafeFrame loader/`decode_common_html_entities` 수정만으로는 부족했다. AST probe 무력화·iframe/isolate 격리는 당시 미검증 제안이며, 후속 일반 Edge 성공은 6월 5일 기록을 따른다.

<a id="2026-05-30--github-home-page-partial-render-webpack-publicpath--미해결"></a>
## 2026-05-30 — GitHub publicPath 부분 수정, ErrorPage 미해결

- **원인**: webpack Automatic publicPath가 `/zp/api/fetch?url=...`의 쿼리와 마지막 segment를 제거하여 `/zp/api/<chunk>`로 요청, ChunkLoadError를 냈다. `crates/zp-htmltx/src/lib.rs`의 `absolute_target_url`/`data-zp-target-url` 추가와 script/link getter의 원본 URL 반환으로 대응했다.
- **최종 정정**: “transform/element handler가 실행되지 않아 stash가 없다”는 가설은 틀렸다. SW `transformHtml` sentinel로 속성 주입을 확인했고, DOM에서 안 보인 것은 [의도된 마스킹](membrane.md#2026-05-30--zp-속성-마스킹-회로)이었다. getter의 `urlMeta → Native.getAttribute → native getter` 경로로 publicPath가 정상 계산됐다.
- **검증·미해결**: `external_stylesheet_link_rewritten` 단위 테스트 통과, 실제 다수 chunk 로드·rspack queue 활성화·React `loaded` 도달. 그러나 GitHub ErrorPage는 남았다. 데이터 fetch/라우터/SSR-CSR mismatch는 추정일 뿐이며 타 사이트 회귀는 당시 미관찰. path 기반 URL 전환은 과거 제안이다.

<a id="2026-05-29--wikipedia--bbc-광범위-사이트-호환성"></a>
## 2026-05-29 — Wikipedia/BBC 호환성 확인

- **조건·결과**: POST body·Referer/Origin·User-Agent 수정 후 Wikipedia 주요 영역과 BBC 홈이 당시 정상 렌더됐다. Wikipedia 콘솔 오류는 없었다.
- **별도 함정**: BBC SDK가 `fn.constructor`에 할당하다 `dynamicConstructorWrappers`의 read-only 잠금에 throw했으나 non-fatal이었다. axios/lodash류 prototype 조작은 부트 체인을 끊을 수도 있으므로 렌더 성공과 오류 부재를 혼동하지 않는다.
- **근거·범위**: [User-Agent smuggle](sw-integration.md#2026-05-29--user-agent-forbidden-header-smuggle). 당시 “anti-bot 대부분은 header smuggle로 해결”이라는 일반화는 이 두 사이트 검증을 넘는 주장으로, GitHub·CF/Cloudflare 등 미해결 사례의 해결 증거가 아니다.

<a id="2026-05-29--naver-중앙-ad-iframe-gray-placeholder"></a>
## 2026-05-29 — NAVER premium ad iframe 회색 placeholder

- **관찰·가설**: `https://shopsquare.naver.com/` 타깃은 정확했지만 `sandbox=""`로 scripts 금지·opaque origin이 되어 `contentDocument` 접근이 SecurityError였다. 당시 MutationObserver filter에 sandbox가 없었으나, 이것이 ad-loader 실패 원인인지는 확정하지 못했다.
- **미확정 갈래**: postMessage 주입, sandbox 제거 전 다른 차단, `gfp-bridge.js` 실패 가능성이 남았다. 다른 광고와 recoshopping은 이 관찰에서 정상이라 premium slot 특화로 분류했다. sandbox 제한 해제를 검증된 수정으로 제시하지 않는다.
- **상태**: 당시 미해결 광고 누락. 후대 shopad 원본 URL 관측 종료와 동일 원인·해결로 간주하지 않는다.

<a id="2026-05-29--naver-우측-상단-recoshopping-nextjs-iframe-application-error"></a>
## 2026-05-29 — recoshopping Next.js Application error

- **최종 원인**: chunk·리라이트·RSC·상품 API는 정상이었다. Rust `kernel_fetch`가 POST body를 빈 `Vec::new()`로 보내고 `new Request`가 Referer/Origin을 strip하여 `/api/v1/collect/exlogcr`가 400을 반환했다. 없는 `exposeContents`를 `concat(undefined)`하여 state에 undefined가 들어갔고, 다음 `adCntsSeq` 접근이 React error boundary를 발동했다.
- **정정·수정**: 초기 React timing/SWR race·fetch 동기성·RSC mangling 가설은 위 전송 원인으로 대체됐다. body 전달과 forbidden header 운반을 수정했다. `sw-integration`의 “POST body + Referer/Origin 누락” 항목 참조.
- **검증·증거**: 빌드 후 추천 헤더·상품 카드 정상, diagnostics 오류 0. 당시 `runtime-prelude.js`의 `__zp_diagnostics` 및 `webpackChunk_N_E`의 `__zp_get` 확인으로 범위를 좁혔다. [membrane.md](membrane.md), [rewriter.md](rewriter.md).

<a id="2026-05-29--naver-검색바-透明-placeholder"></a>
## 2026-05-29 — NAVER 투명 검색 placeholder

- **패턴**: native `::placeholder`는 의도적으로 투명하며 JS 오버레이·`#autoFrame`과 조합된다. input 존재·geometry·computed style을 분리해서 봐야 한다.
- **정정**: “투명하므로 JS init 실패”는 확정 진단이 아니었다. 후속 관찰에서 빈 상태 미표시는 디자인이고 typing 시 autocomplete는 정상이었다.
- **진단 한계**: 당시 제시한 `veta/N/jindo` 부재를 init 실패 증거로 쓰는 방법도 아래 globals 정정으로 폐기됐다. 보이지 않는 위젯을 자동으로 프록시 회귀로 판정하지 않는다.

<a id="2026-05-29--navercom-smoke-test-실제-globals-정정판"></a>
## 2026-05-29 — NAVER smoke globals 정정

- **실제 표면**: 당시 확인한 init 증거는 `gladsdk.cmd`, `ndpsdk.cmd`, `ntm`, `nsc === 'navertop.v5'`, `nmain.jsOrigin === 'www'`, `webpackChunkpc`, `EAGER-DATA`/`ELECTION-DATA`였다.
- **폐기된 가정**: `veta`, `N`, `jindo`, `NDPCorePostCmd`를 NAVER가 정의한다는 추정은 오류였다. 존재하지 않는 globals를 실패 판정 기준으로 삼지 않는다.
- **근거·보안**: 잘못된 script target은 [setScriptSource 회귀](membrane.md#2026-05-29--setscriptsource-가-절대-proxy-url-잘라냄), `__zp_get` 부재는 [script destination 누락](sw-integration.md#2026-05-29--zpapifetch-가-script-destination-미감지)과 구분했다. 당시 smoke는 모든 외부 script의 프록시 라우팅을 확인했으며 원본 URL 우회·누출은 허용하지 않는다.

<a id="2026-06-02--naver-메인-dynamic-ad-slots-미충전-pc-main-ad-div-p_main_--ntmpstaticnet-block-시도-reject"></a>
## 2026-06-02 — dynamic ad slots 미충전, ntm 차단 reject

- **관찰**: `pc-main-ad-div-p_main_knowledge-*`, `p_main_rightside_understock`, `p_main_rightbottom_widget`, `right-ad-1`은 비었지만 SSR inline waterfall에 pre-bid된 광고는 렌더됐다. 빈 슬롯은 live `tivan.naver.com` 호출이 필요했으나 호출 자체가 없었다.
- **반증·규칙**: 긴 ntm resource duration을 WTM/NCPT와 같은 starvation으로 의심해 차단했지만 기존 premium·좌우·veta 광고까지 깨졌다. 당시 분석상 ntm은 bid token/impression key의 기능적 의존성이므로 **WTM/NCPT처럼 차단하면 안 된다**. 느린 duration의 의미는 실제 starvation인지 측정 artifact인지 미확정이다.
- **상태·증거**: ntm 차단은 미적용, dynamic 슬롯은 미해결. 익명/지역/인증 쿠키별 inventory 또는 displayAd 호출 누락은 가설로 남았다. [sw.js:395-401](../../web/sw.js#L395-L401), [sw.js:382-401](../../web/sw.js#L382-L401), [naver-main-inline-11](https://www.naver.com/).

<a id="2026-05-29--navercom-1차-fix-후-검증-결과-정정"></a>
## 2026-05-29 — NAVER 1차 수정 후 검증 정정

- **당시 검증**: storage recursion·script destination·scriptProxyPath·fetchThroughRuntime·workerBootstrapURL 수정 후 script 프록시 라우팅, 실제 core globals, webpack entry 실행, SSR 뉴스·위젯·광고·로그인 영역을 확인했다. 원본 script URL 누출은 없었다.
- **정정**: “검색바/광고/위젯 모두 미렌더” 및 “entry 미실행”은 오류였다. 검색은 typing 시 정상이고 광고·위젯은 점진 로딩되며 entry side effect도 관찰됐다.
- **후속 우선**: 당시 잔여 recoshopping 실패를 React 19 RSC hydration/stream mangling으로 추정했으나, 위 POST body·Origin/Referer 원인으로 정정·해결됐다. `PHASE2_PLAN.md` B3/site-quirks 매핑과 stream 진단 제안은 과거 참고이지 현재 TODO가 아니다.

<a id="카테고리-추가-시-권장-사이트-e2-매트릭스-후보"></a>
## 과거 E2 매트릭스 후보

- **당시 후보**: `https://www.naver.com/`(광고/iframe), `https://gosuda.org/`(home 회귀), `https://news.ycombinator.com/`(단순 HTML baseline).
- **복잡·적대적 후보**: `https://github.com/`(React/dynamic import), `https://www.google.com/`(anti-bot/fingerprinting).
- **상태**: `PHASE2` E2의 역사적 제안 목록일 뿐, 현재 승인 매트릭스나 해당 사이트 통과 증거가 아니다.

<a id="2026-08-20--naver-shopad-잔여-건-닫음-20회-무장-관측에서-원본-url-0건"></a>
## 2026-08-20 — shopad 원본 URL 잔여 관측 종료

- **검증**: `--record --enforce-csp`와 `csp_bypassed:false`를 확인하고 `.ai/dogfood/wtm/zpraw-observer.js`를 `inject-script --world isolated`로 document-start에 무장했다. `.ai/dogfood/wtm/shopad-hunt.sh`의 연속 20회에서 모든 프레임 무장·shopad 존재, CSP 위반·원본 URL 관측은 0이었다.
- **범위**: 해당 누출은 재현되지 않아 당시 닫았다. 08-18 `setAttributeNS` 누락 또는 08-20 정적 `<iframe src>` 누락 수정이 원인 후보지만 어느 쪽인지는 확정하지 않았다.
- **정정**: “서버 A/B로 모듈이 드물게 부착”은 전 회차 부착 관찰과 맞지 않았다. 과거 낮은 재현율은 CSP가 꺼진 관측 실패였을 가능성이 크다. 관측기 수정 후에는 증상뿐 아니라 부착률 전제도 재검증해야 한다.

## CNN APS 프레임 부족 (2026-08-25, 부분 정정·잔여 미해결) {#cnn-aps-프레임}

- **좁힌 원인 사슬**: `document.location` 유출 수정으로 `turner_getGuid`가 살아난 뒤에도 광고 프레임이 부족했다. `apstag-iframe` 생성자는 Amazon이 아니라 BounceExchange `ads-v2 → main-v2`이며, gate는 `bouncex.website.sspConfig.aps`였다. prelude가 메서드를 캡처하므로 생성 추적은 인스턴스 own wrapper가 아닌 document-start의 `Document.prototype.createElement`에 걸어야 했다.
- **설정·저장소 관찰**: 프록시에 `sspConfig`, `bouncex.state`, `state/js` 요청이 없었다. `cache/7291/website-<hash>.js`에도 원래 `sspConfig`는 없으며, 저장소 프레임이 제공하는 device_id로 `api.bounceexchange.com/state/js`를 요청해 채우는 구조였다. `bcx_local_storage_frame`은 연결된 완전한 src를 가졌으나 빈 문서로 보였다.
- **반증**: 타깃 `#7291`, 자식 자신의 `location.href/hash/search`, apstag 미로드, CSP frame 차단은 배제됐다. 헤더 CSP는 유효했고 콘솔 경고는 head 밖 meta CSP 무시라는 별개 문제였다. 부모에서 읽는 `contentWindow.location`의 부모 URL 표시는 별도 표면이다. fragment 없는 fetch가 200 랜딩 페이지를 받은 사실도 내비게이션 실패 원인으로 단정하지 않았다.
- **후속 정정—SW 교착**: “브라우저가 요청하지 않는다”는 초기 결론은 틀렸다. CDP에는 Document request가 있었고 SW가 200을 만든 뒤 `await clients.get(resultingClientId)`에서 `respondWith`가 settle되지 않았다. [clients.get 교착](sw-integration.md#clients-get-교착) 참조. 입양·삽입 시 src 재작성·스트리밍 중 browsing context 부재는 모두 배제됐다. 실제 src 판독에는 document-start에 캡처한 native accessor가 필요하며 페이지 getter/늦게 잡은 descriptor는 이미 가상화돼 있다.
- **최종 검증·잔여**: 교착 해소만으로는 state 요청이 복구되지 않았지만, [postMessage incumbent 수정](rewriter.md#postmessage-incumbent) 뒤 device_id·sspConfig·prebid·입찰·GPT 슬롯이 대조군과 동등한 수준으로 관찰됐다. **“경매 자체가 안 돈다”는 갈래만 닫혔다.** 프레임 수 차이는 남고 대조군도 변동하므로 CNN 전체 해결이나 한 회차 동률을 주장하지 않는다. 여러 회차 분포 비교는 당시 제안으로 남았다.

## <a id="cnn-2차정지-재현불가"></a>CNN 두 번째 정지 재현 불가 (2026-08-26)

- **당시 상태**: 기록된 증상은 렌더러가 큰 힙으로 생존하면서 CDP만 무응답인 정지였다. 첫 화면·기사·cold start·장시간 스크롤의 9회 재현에서는 모두 complete·응답 정상, GC 정상, `--record --watch-hang` 자동 덤프 0건이었다. **원인 미확정이며 비재현은 해결 증거가 아니다.**
- **반증·가설**: `1bcae09`의 `await self.clients.get(resultingClientId)`를 일부러 복원해도 interactive에서 로드만 멈추고 렌더러는 응답했다. 따라서 두 번째 정지 원인 후보에서 제외했고 변이는 원복했다—**절대 커밋하지 않는다**. `5004b5e`에서 메모이제이션한 `filteredCollection` O(N²)의 할당 폭풍이 부분 수정 상태로 남았다는 설명은 미확인 가설이다.
- **증거 수집 이력·잔여**: `--record --watch-hang --auto-dump-dir <dir>`는 버퍼와 `hang.json`을 남긴다. 당시 제안은 `pause --symbolize --samples 6`, 필요시 `--download-symbols`와 exe 옆 `dbghelp.dll`/`symsrv.dll`, 힙 원인용 `--full-memory --only-pid`, 엔진 예외용 `debugger-arm --strategy exceptions --sample-every N`이었다. 페이지 `Error` wrapper로 엔진 TypeError를 잡을 수 없다. 요소 수는 대조군에 근접했지만 광고 iframe 부족은 남았다.

## <a id="레이아웃-축-없음"></a>레이아웃 회귀 축 누락과 GitHub 오판 (2026-09-04)

- **누락 원인**: 08-26 `<style>` 이스케이프 버그는 요소 수·raw URL·CSP·콘솔 축을 통과하면서 페이지 높이를 망가뜨렸다. 당시 `rendercheck.sh`에 직접/프록시 쌍 비교로 `styleEntities`, 높이 비율, 첫 화면 가시 요소를 추가했다. `<style>`은 raw text라 엔티티가 풀리지 않는다. CSS 규칙 수는 same-origin 프록시가 cross-origin 시트까지 읽어 더 커질 수 있으므로 오라클로 쓰지 않았다.
- **실제 검증**: 수정 빌드와 버그 한 줄을 되살린 양성 대조를 비교하여 새 style/height 축만 회귀를 잡음을 확인했다. 기존 요소·raw·CSP 축은 버그 빌드도 통과했다. 높이 경계 등 당시 판정값은 역사적 테스트 설정이지 현재 승인 사양이 아니다.
- **GitHub 미해결·정정**: 첫 사이트 비교에서 GitHub는 레이아웃보다 본문이 ErrorPage로 대체된 상태였다. title·raw·CSP·console이 정상이어서 반복한 “GitHub 정상” 보고는 모두 오판이었다. title만으로 성공을 판정하지 말고 본문·높이·가시 영역을 대조해야 한다. 이 세션에서는 원인을 추적하지 않았으며, 5월 publicPath 부분 수정과 별개로 GitHub ErrorPage는 미해결이다.
후속 정정: [비HTTP 스킴 조사](rewriter.md#비-http-스킴-세-겹)에서는 대기시간을 맞춘 반복 비교의 총 프레임 갭이 없었다. 앞선 프레임 부족 수치를 현재 고정 결함으로 재사용하지 않는다. 이것은 CNN 두 번째 정지의 원인·해결을 확정하지 않는다.

# Rewriter Regressions

과거 원인·수정·검증 요약이며 현재 전체 accepted spec이 아니다. 검증은 당시 범위에 한정되고 이번 정리에서 새 실행은 없었다. 후속 정정이 앞 가설보다 우선하며 현재 E1은 [계획](../design/website-compat-refactor.md)을 본다.

<a id="worker-url-래퍼-내부흡수"></a>
## 워커 `self.URL` 래퍼가 prelude 내부 `new URL` 도 가로챔 (2026-09-24)

- **원인:** `self.URL` 을 가상 베이스 래퍼(ZPWorkerURL)로 교체했더니 prelude 내부의 `new URL(value, realLocation.href)` 전부가 래퍼를 탔다. 래퍼의 unleashed() 가 `/zp/*` 입력을 unwrap 해서 `importScripts('/zp/assets/zp-page-bundle.js')` 가 타깃 URL 로 변질 — 번들 로드 실패로 모든 동적 코드가 fail-closed 로 죽을 뻔했다.
- **수정:** 파일 상단에서 `const NativeURLCtor = self.URL` 을 캡처하고, prelude 내부의 **모든** `new URL(` 을 `new NativeURLCtor(` 로 바꿨다. 페이지의 `const URL = Native.URL` 섀도잉(#네이티브-url-섀도잉)과 같은 함정의 워커 변형 — 단, 워커는 IIFE 스코프라 bare `URL` 가 그대로 글로벌을 탄다는 점이 다르다.
- **규칙:** realm 전역 생성자를 래핑할 때는 **먼저 캡처 → 내부 호출 전환 → 래핑 설치** 순서. `perl` 일괄 치환 후엔 캡처 선언이 사용처보다 위에 있는지(TDZ) 확인 — `const` 선언 순서가 뒤바뀌면 부팅 사망.

<a id="sharedworker-이름-마스킹"></a>
## SharedWorker `self.name` 에 격리 접두어가 보였다 (2026-09-24)

- **원인:** `zp:w:<hash>:` 접두어를 붙여 실제 SharedWorker 를 타깃별로 격리하는데, 워커 내부 `self.name` 이 접두어 포함 이름을 그대로 노출했다 — 네이티브는 페이지가 요청한 이름만 돌려준다.
- **수정:** worker-prelude 가 부팅 시 `self.name` 에서 `^zp:w:[0-9a-f]{8}:` 접두어를 벗겨 재정의한다. e2e 핀도 `zp:w:*` 노출에서 `swprobe` 마스킹으로 갱신 — 접두어 격리 자체는 유지.
- **규칙:** 격리 접두어는 전송 계층(실제 API 인자)에만 두고, 페이지/워커가 되읽는 표면은 항상 요청값으로 되돌린다 — BroadcastChannel.name, SharedWorker name, OPFS handle.name 모두 같은 규칙.

<a id="opfs-name-마커누출"></a>
## OPFS `handle.name` 에 네임스페이스 마커+오리진 원문 노출 (2026-09-24)

- **원인:** `navigator.storage.getDirectory()` 를 `ZP|<origin>` 서브디렉터리로 네임스페이스했더니 반환 핸들의 `.name` 이 `ZP|http://target` 을 그대로 보였다 — 프록시 내부 스킴과 타깃 오리진 원문이 같이 샌다.
- **수정:** 서브디렉터리 이름을 `zp:o:<fnv1a-8>` 해시로 바꿨다(페이지·워커 동일). `.name` 에서는 해시만 보이고 오리진 문자열은 안 샌다. 잔여: 네이티브 루트 `.name` 은 `''` — 우리는 해시 이름이 보이는 근사치.
- **규칙:** 페이지가 되읽는 모든 표면(핸들 이름, 채널 이름, DB 이름 목록)은 네임스페이스 원문이 아니라 해시 또는 요청값을 노출한다.

<a id="localhost-secure-context-parity"></a>
## `http://localhost` 타깃의 `isSecureContext` 는 네이티브도 `true` (2026-09-24)

- **원인:** `isSecureContext` 가상화를 검증하려고 http 타깃에 `false` 를 단언했더니 실패 — localhost/127.0.0.1/.localhost 는 "potentially trustworthy origin" 이라 http 여도 네이티브 `true` 다.
- **수정:** e2e 단언을 `v:true` 로 고치고, 가상화 게터 자체는 scheme+호스트 규칙을 따르므로 비-localhost http 에서 `false` 를 돌린다는 점만 주석으로 핀.
- **규칙:** secure-context 단언은 타깃 호스트의 potentially-trustworthy 판정을 먼저 확인한다 — `http://` 라고 무조건 `false` 가 아니다.

<a id="meta-csp-동기무장"></a>
## 동적 meta CSP 무장 레이스 — MutationObserver 는 너무 느리다 (2026-09-23)

- **원인:** `setAttribute('http-equiv','Content-Security-Policy')` 는 stash 만 하고 네이티브 속성을 안 쓰고, 뒤이은 `setAttribute('content',…)` 는 http-equiv 부재라 일반 경로로 raw 기록됐다. http-equiv 복원은 MutationObserver(마이크로태스크)에서 일어나므로 `appendChild` 직후 `img.src=` 로 시작된 로드는 정책 없이 나갔다 — `img-src 'none'` 인데도 img-loaded.
- **수정:** content set 경로에서 live/stash 양쪽 http-equiv 를 검사해 CSP 계열이면 content 기록 → 필터 → http-equiv 복원을 **동기적**으로 수행한다(append 전 무장). observer 경로는 innerHTML 등 나머지 도달 경로만 보조.
- **검증:** e2e `metaStricter` (createElement+setAttribute+append 후 즉시 Image 로드) 가 img-blocked 로 그린.

<a id="lit-stash-서브스트링-오탐"></a>
## `data-zp-lit-*` 가 "raw URL 부재" 단언을 오탐 (2026-09-23)

- **원인:** R6 리터럴 스태시 `data-zp-lit-href="https://example.com/x"` 는 문자열로 `href="https://example.com/x"` 를 **포함**한다(`lit-` 접두 뒤 substring). zp-htmltx 의 13개 네거티브 단언이 전부 걸렸다.
- **수정:** 테스트 헬퍼 `strip_lit` 가 `data-zp-lit-*="…"` 스팬을 제거한 뒤 단언한다. 속성값 `"` 는 `&quot;` 이스케이프라 첫 닫는 따옴표까지가 스팬.
- **규칙:** "원본 URL 이 출력에 없어야 한다" 류 단언은 항상 lit 스태시를 제외하고 검사한다.

<a id="worker-내부경로-타깃해석"></a>
## 워커 `importScripts` 가 내부 `/zp/*` 자산을 타깃 URL 로 해석 (2026-09-23)

- **원인:** W1 에서 `zp-page-bundle.js` 를 부트스트랩이 `importScripts('/zp/assets/…')` 로 싣는데, prelude 의 importScripts 오버라이드가 **모든** 인자를 가상 base 로 해석해 `/zp/assets/zp-page-bundle.js` → `https://target/zp/assets/…` 로 upstream fetch → 404 → ZPBundle 부재 → `__zp_runSrcu` 가 영영 안 떴다.
- **수정:** 오버라이드가 `/zp/` 프리픽스는 타깃 해석 **전에** 통과시킨다.
- **규칙:** 워커 realm 의 어떤 URL 재작성 지점도 내부 `/zp/*` 를 타깃으로 보면 안 된다 — 같은 실수가 `importScripts`/`fetch`/XHR 어디든 재발 가능.

<a id="worker-동기xhr-라우트"></a>
## 워커 sync XHR 릴레이가 SW 에서 타깃 요청으로 오분류 (2026-09-23)

- **원인:** 워커의 네이티브 sync XHR 을 `/zp/api/sync-fetch` POST 로 릴레이하게 했는데, SW fetch 핸들러가 그 경로를 **타깃 요청으로 분류**해 upstream 에 `POST /zp/api/sync-fetch` 를 날려 404.
- **수정:** SW classify 에서 `/zp/api/sync-fetch` 를 전용 릴레이로 먼저 처리. 워커 쪽은 `async=false` 면 `Native.XHR` 로 동기 POST, `xhr.getResponseHeader`/`responseText` 를 릴레이 응답으로 채운다.
- **규칙:** `/zp/api/*` 신규 라우트는 SW 분류표에 **반드시** 명시 등록 — 디폴트 분류가 타깃 전달이라 누락은 조용한 upstream 누출이 된다.

<a id="worker-ws-베이스-매핑"></a>
## 워커 WebSocket 상대 URL — http: 베이스를 그대로 넘기면 안 된다 (2026-09-23)

- **원인:** `new WebSocket('/ws?w=worker')` 를 `base.href`(http:) 로 resolve 한 뒤 `canonicalWebSocketURL` 에 넘겼더니 http: 스킴 거부로 Error. 페이지 측은 `base.href.replace(/^http/,'ws')` 로 ws: 베이스로 먼저 바꾼다.
- **수정:** 워커도 같은 순서 — http/https 베이스를 ws/wss 로 매핑 후 resolve·검증.
- **규칙:** ws/wss 정규화 함수는 **스킴 매핑된 베이스**를 요구한다 — 호출부가 책임.

<a id="srcset-쉼표와-숫자-엔티티--이미지-400-이-56건이었다-2026-08-24-cnn"></a>
## srcset 쉼표·숫자 엔티티로 이미지 요청 손상 (2026-08-24, CNN)

- **원인:** Rust `split_srcset_candidates`와 JS `splitSrcsetCandidates`가 첫 쉼표에서 URL을 잘라 CNN의 `?c=16x9&q=h_1080,w_1920,c_fill`을 손상시켰다. 별도로 `decode_url_html_entities`의 수동 표가 `&#x3D;`를 못 풀어 `&`는 인코딩되고 나머지 `#x3D;original`은 프래그먼트로 흘렀다.
- **수정:** 후보 URL은 공백까지의 비공백 런이며 후행 쉼표만 구분한다. 양쪽 구현에서 `data:` 예외를 제거하고 규칙을 적용했다. `numeric_entity_char`로 십진·16진 숫자 엔티티(`&#61;`, `&#x3D;`, `&#X3D;`)를 해석하며 잘못된 `&#zz;` 등은 보존한다. **8월 21일의 data 전용 처방은 이 정정으로 대체된다.**
- **당시 검증·잔여:** 실측 srcset 파리티 사례 추가, JS·Rust 변이 통과. media.cnn 이미지 400은 사라졌으나 전체 400은 남았다. 광고 프레임 부족과 sandbox 스크립트 차단, `__zp_get(...).turner_getGuid is not a function`, `NotSupportedError: Blocked by ZeroProxy rewrite policy`는 미조사였다.

<a id="cnn-이-렌더러를-세운-진짜-원인--교차창-프록시의-parent-가-자기-자신이었다-2026-08-24"></a>
## CNN 정지의 최종 원인: 교차창 parent가 자기 자신 (2026-08-24)

- **원인·정정:** `safeCrossWindow` 프록시의 `top`/`parent`가 자신을 반환했다. 깊이 2 이상에서 부모 프록시와 `window.top`이 달라 CMP 조상 탐색이 무한 반복됐다. 얕은 픽스처의 수렴을 근거로 한 **“프레임 사슬 가설 반증”은 잘못된 결론**이었다.
- **수정:** `climbCrossWindow(targetWindow, prop, fallback)`가 실제 창 사슬을 한 단계 오른다. 실제 창을 키로 하는 캐시가 최종 `window.top` 객체 동일성을 보장한다. 읽기가 실패하거나 자기 자신이면 사슬 끝으로 처리한다.
- **증거·상태:** DOM 계수기가 조용한 상태에서 CDP Tracing의 끝나지 않는 `v8.run`, `__ZP_EXEC_INLINE_SCRIPT` 임시 로그로 PubMatic 인라인 스크립트를 특정했다. 별도 스레드 CPU 샘플러의 `runtime-prelude.js`·`get top`과 복원한 CMP 상승 루프들이 원인을 뒷받침했다. 수정 후 CNN 생존 확인, 3단 창 CMP 가드 변이 3/4 검출(나머지는 캐시로 무해). **프레임 부족은 미해결**이며 중첩 픽스처도 요청 깊이와 달리 한 단만 생성됐다.

<a id="설치-검증이-값-비교라-객체-게터에서-영원히-실패했다--navigatoruseragentdata-2026-08-24"></a>
## 객체 게터의 값 비교가 설치 검증을 실패시킴 — UAData (2026-08-24)

- **원인:** `defineOnProto`가 `instance[key] === get.call(instance)`로 설치를 검사해 `let cachedUADataBrands` 초기화 전 게터를 호출했다. 선언 이동으로 TDZ는 고쳤지만, `virtualUserAgentData`가 매번 새 객체를 반환하므로 비교는 계속 실패했고 navigator 인스턴스에 own 속성 폴백을 만들었다.
- **수정·기각:** 게터 실행 없이 서술자로 프로토타입 접근자 설치와 own 가림 부재를 확인한다. 가상 UAData는 실제 `NavigatorUAData.prototype`을 상속하고 값 접근자는 중간 프로토타입에 둔다. 인스턴스 직접 대입은 읽기전용 접근자와 충돌하며 own 표면도 달라진다. **UAData 객체 동일성을 고정하려던 제안은 직접 브라우저도 연속 접근이 false라 기각했다.**
- **증거·상태:** `debugger-arm --strategy exceptions`가 `runtime-prelude.js`의 엔진 TDZ를 포착했다(페이지 `Error` 래핑으로는 관측 불가). 수정 후 own 속성·브랜드·프로토타입 등 비교 항목이 대조군과 일치했다. CNN 정지 원인은 아니며, 당시 미완료였던 PubMatic 조사와 사슬 가설의 반증 주장은 위 후속 항목에서 정정됐다. 임시 인라인 계측은 제거했다.

<a id="잉여니까-지우자-가-진짜-결함-하나를-꺼냈다--컬렉션-표면-2026-08-24"></a>
## 컬렉션의 가짜 표면과 메서드 동일성 (2026-08-24)

- **원인:** 여섯 필터 컬렉션 호출처에 같은 가짜 메서드 표면을 씌워 `'forEach' in c`와 실제 접근이 모순됐다. 직접 측정상 NodeList만 `forEach`/`values`/`keys`/`entries`를 가지며, HTMLCollection·NamedNodeMap은 없다. 세 종류의 iterator는 `Array.prototype.values`; NodeList 메서드도 Array 메서드 자체이고 브랜드 체크 없이 동작했다.
- **수정:** `prop in raw`로 실제 표면만 노출하고 순회에는 Array 메서드 자체를 반환해 필터 트랩·live 변화·동일성을 유지한다. 스냅샷 루프를 제거하고 `item`/`getNamedItem`·폴백 bind는 인스턴스별 캐시, 빈 결과는 분리 요소의 네이티브 qSA로 얻은 진짜 NodeList를 쓴다. 모두 iterator가 있어 발화하지 않는 `inRaw` 게이트는 삭제했다.
- **증거·잔여:** 당시 7개 사이트에서 관련 탐지 0, 변이 8/8. 폴백 bind 동일성의 실제 가드 공백은 보강했다. named getter의 숨긴 노드 우회는 **재현되지 않아 미수정**: `runtime-prelude.js`의 `clearBootConfig()`가 `__zp-boot`를 제거하고 나머지 숨긴 노드에 id/name이 없었다. 향후 숨긴 노드에 id/name이 생기면 우회 가능한 잠재 조건은 남는다.

<a id="우리-필터-컬렉션이-on²-이라-cnn-이-렌더러를-세웠다-2026-08-24"></a>
## 필터 컬렉션의 O(N²) — CNN 첫 번째 결함 (2026-08-24)

- **원인:** `filteredCollection`의 `nth`/`length`가 매번 전체를 훑고 순회가 둘을 반복 호출했다. GPT `pubads_impl.js` → Proxy → qSA 필터 → `isZPAssetNode` → script `getAttribute`가 폭주했다. 다중 프레임 부팅 비용 가설은 합성 픽스처에서 반증됐다.
- **수정·검증 조건:** 필터 결과를 메모이제이션하고 원본 길이 변화에 무효화했다. 변이로 성능의 핵심은 메모이제이션임을 확인했으며 루프 재작성은 잉여였다(후속 컬렉션 수정에서 제거). 멎은 데몬 재사용은 초기 정지 시간을 왜곡하므로 당시 프로브는 `taskweaver kill/start`가 필요했다. 새 데몬만으로는 옛 SW 캐시가 남아 `clear-site-data`와 **실행 빌드 ID 확인**도 필요했다.
- **증거·정정:** 문서 시작 메인 월드 계수기와 CDP 콘솔 스택으로 호출 폭주를 확인했고 수정 후 크게 감소했다. 그러나 CNN은 계속 정지했으므로 **이 수정만으로 해결됐다는 해석은 틀리다**. DOM을 거의 쓰지 않는 두 번째 원인은 위 교차창 사슬 항목에서 확인됐다.
- **별도 미확인:** reddit `document.scripts`에 `/zp/error/POLICY_BLOCKED…`가 노출됐다. `blockExecutableURL`이 `urlMeta`를 지우고 `data-zp-target-url`을 비워 `.src` 복원 근거가 없으며 `deproxyURL`도 오류 경로를 매핑하지 못했다. 이전부터 있었을 가능성만 기록했으며 옛 빌드 대조는 하지 않았다.

<a id="레이스처럼-보였는데-원인은-용량이었다--문서가-자기-기록을-밀어냈다-2026-08-24"></a>
<a id="레이스처럼"></a>
## 문서 압축 기록 축출: 레이스가 아니라 공유 FIFO 용량 (2026-08-24)

- **원인·기각:** MDN cold 로드의 압축 크기 표시 실패는 문서와 서브리소스가 공유하는 제한 FIFO를 비컨이 채워 문서 기록을 축출한 탓이었다. warm 부팅은 질의가 축출보다 빨랐다. SW 미제어·인스턴스 교체 가설은 관측으로 기각됐고, 키 앞부분만 본 초기 프로브도 전체 관측이 아니었다.
- **수정·금지:** 문서 기록을 별도 `docEncodedByUrl`에 저장하고 우선 조회한다. 버퍼·스트리밍 모두 `isNavigationRequest(event.request)`를 전달한다. 진단 `__zpTraceDump`에 넣었던 `encodedKeys: [...streamEncodedByUrl.keys()]`는 **다른 탭 타깃 URL 노출(A2 multi-tab leak)** 때문에 제거하고 재등장 가드를 추가했다. 이미 아는 자기 URL 질의와 전체 키 공개는 보안상 다르다.
- **당시 검증:** cold 표시가 수정 후 정상화됐다. 격리 월드 값은 그대로여서 페이지 realm 표시만 가리고 브라우저의 실제 측정은 변경하지 않았음을 확인했다.

<a id="세정기가-못-걷는-곳을-직렬화기는-걷는다---2026-08-24-reddit"></a>
<a id="template"></a>
## 직렬화 세정이 `<template>` 내용을 놓침 (2026-08-24, reddit)

- **원인:** `scrubbedClone`의 qSA 병렬 순회는 별도 `DocumentFragment`인 `template.content`에 도달하지 못하지만 직렬화기는 그 내용을 출력했다. 앞선 “멤브레인 qSA가 우리 자산을 숨겨 세정도 못 봄”과 같은 관측 불일치다.
- **수정·불변식:** `Native.fragmentQuerySelectorAll`과 `Native.templateContent`를 캡처하고 nodeType 11을 분기했다. Element/Document 메서드 오용은 예외와 catch를 거쳐 세정 누락을 만들며, 페이지가 바꿀 수 있는 `el.content`에 의존해서도 안 된다. 중첩 template 재귀(당시 깊이 상한 8)와 template 자체가 직렬화 루트인 경우를 처리한다. **세정 대상은 직렬화기가 보는 노드 집합과 맞아야 하며 원본 DOM은 변경하지 않는다.**
- **증거·잔여:** 격리 월드의 실제 내부 속성·URL은 남고 메인 월드 직렬화에서만 사라지며 구조가 보존됐다. reddit 및 비교 사이트 탐지 0, static-policy와 새 가드 변이 통과. 선언적 shadow root는 reddit에서 관측되지 않아 **미확인**으로 남았다.

<a id="2026-08-22--지문-축-전역-스크러버가-적이-서지-않는-자리에-걸려-있었다-리라이트-경유로-보면-24개가-그대로-보인다"></a>
## 전역 스크러버가 가상 window를 인식하지 못함 (2026-08-22)

- **원인:** `test/browser/fingerprint/detect.js`의 실제 탐지 동작으로는 전역이 노출됐지만 직접 `exec-js`는 깨끗했다. 리라이트된 `eval`의 window는 스코프 프록시인데 `isGlobalObj`가 실제 `globalThis`/`root`/`self` 동일성만 검사했다. “Measured … correctly clean” 주석은 타깃이 보지 않는 시점의 측정이었다.
- **수정:** 이후 생성되는 스코프 프록시도 식별하도록 멤브레인과 같은 `o.window === o` 검사를 사용했다. 직접·리라이트 경유 모두 전역 노출 0을 확인하고 낡은 clean 주석을 정정했다. navigator·`Location.prototype`·window 심볼은 두 시점이 일치해 이 결함의 범위가 아니었다.
- **당시 상태:** static-policy·구멍 매트릭스·실사이트 제한 축은 통과했다. 별도로 `outerHTML` 내부 속성·주입 자산, 리소스 타이밍 자산 이름이 남았다. `http://127.0.0.1:18099/null/zp/api/fetch?url=…` 형태의 `null` 경로도 별도 의심 버그였으며 이 기록에는 해결 증거가 없다.

### 후속 — 직렬화가 `<html>` 껍데기를 제거함

- **원인·수정:** 문자열을 `div.innerHTML`로 왕복하면서 파서가 `<html>/<head>/<body>`를 벗겼다. `cloneNode(true)` 복제본에서 내부 속성을 제거한 뒤 네이티브 게터로 직렬화하도록 바꿔 구조를 보존했다.
- **증거·당시 공백:** `documentElement.outerHTML`의 `<html` 시작이 대조군과 일치했다. 남은 `data-zp-target-url`은 살아 있는 요소 속성이 아니라 이스케이프된 `<iframe srcdoc="…">` 내부 마크업이었다. `XMLSerializer().serializeToString(document.documentElement)` 훅 부재도 별도 노출 표면으로 기록됐다. 이는 **당시 공백**이며 여기서 현재 미구현 여부를 단정하지 않는다.

<a id="2026-08-22--스토리지쿠키-격리-축을-처음-세웠다-결함-둘--내-측정이-만든-가짜-누출-하나"></a>
## 스토리지·쿠키 격리: 두 결함과 잘못된 누출 판정 (2026-08-22)

- **계측 정정:** `test/browser/storage-matrix/`의 A→B→A 검증에서 서로 다른 포트의 `127.0.0.1` 쿠키 공유는 브라우저 원래 의미였다. `localhost`와 `127.0.0.1`로 분리해도 이전 픽스처 쿠키가 SW 저장소에 남아 가짜 누출을 만들었다. 대조군과 `clear-site-data`·하드 리로드 후 판정해야 한다.
- **결함·수정:** sessionStorage 접두의 `boot.tabId`는 Open마다 바뀌어 같은 탭 복귀 시 지속성을 잃었다. 네이티브 sessionStorage에 한 번 저장한 세션 ID를 사용하고 타깃 격리는 `originHash`로 유지했다. 진단 키 `__zp_hb`/`__zp_trace_log`는 자식 realm 캡처 순서 때문에 네이티브·타깃 접두 사본 모두 생겼다. 파사드의 `length`/`key()`/`getItem`/열거에서 `__zp_` 이름을 숨겼다.
- **당시 검증:** localStorage·이름 접근·sessionStorage·cookie·CacheStorage·IndexedDB의 격리·지속성·내부 키 위생이 모두 통과했다. 이것만으로 채널 격리를 증명한 것은 아니며 아래 동시 생존 시험을 별도로 수행했다.

### 후속 — BroadcastChannel·SharedWorker와 프레임 오인

- **원인·규칙:** 순차 `run.mjs`는 비지속 채널을 못 재므로 `crossdoc.mjs`에서 같은 타깃·다른 타깃 프레임을 동시에 띄웠다. `/page`의 기존 iframe 때문에 `--frame 1`을 B로 가정한 판정은 무효였다.
- **수정·증거:** 최소 `/hdrprobe`를 쓰고 수신기 설치 전 `document.baseURI`로 신원을 확인하며, 못 찾으면 판정 불가로 멈춘다. 같은 타깃 수신이라는 양성 대조 없이 다른 타깃의 0을 격리 증거로 읽지 않는다. 당시 BroadcastChannel은 같은 타깃만 수신했고 SharedWorker는 같은 타깃에서 인스턴스를 공유, 다른 타깃에서는 분리됐다.

<a id="2026-08-21--재현성-축에는-의도적이라는-개념이-없었다-7칸이-늘-앉아-있는-목록에-새-회귀가-끼면-안-보인다"></a>
## 재현성 축에 의도적 차단의 기대 집합 추가 (2026-08-21)

- **원인:** 러너는 늘 실패하는 7칸을 출력만 해 새 회귀와 구분하지 못했다. `url_surfaces.json`의 격리 축과 달리 재현성에는 의도·이유 선언이 없었다. 워커 둘은 JS Blob을 `URL.createObjectURL` 훅에서 차단 스텁으로 바꾸는 의도된 제한이었다. **리라이트되지 않은 코드를 워커에서 실행해 멤브레인 밖으로 보내면 안 된다.**
- **수정:** `server.mjs`의 `EXPECT_BLOCKED`에 ID→이유를 선언해 `/cases`로 전달한다. 미선언 실패는 회귀, 선언된 성공은 낡은 선언으로 양방향 검출한다. static-policy는 충분한 이유 설명을 강제했다. 당시 선언은 현재 승인 차단 목록으로 간주하지 않는다.
- **검증·기각:** `c7-worker` 선언 제거, 정상 `a10-static-iframe` 거짓 선언, 짧은 이유 변이를 모두 검출했다. 존재하지 않는 `a1-static-img`로 했던 첫 변이는 무효였다. srcset `split(',')`, 정규화 전 기대값, `usesRaw` 삼항, `encodeURIComponent` 정규식처럼 구현을 박제한 가드의 전례 때문에 기대 집합 자체의 노후화도 검사했다.

<a id="2026-08-21--preconnect-계측을-안정화했다-원인은-브라우저가-아니라-내가-만든-계측-쪽-버그-둘이었다"></a>
## preconnect 계측: 소켓 재사용·조기 종료 누락 (2026-08-21)

- **원인:** prefetch/preload와 같은 오리진을 써 preconnect 소켓이 재사용됐고, 미사용 소켓의 빠른 `close`가 계수 타이머를 취소했다. 브라우저 환경 문제로만 본 초기 해석은 잘못됐다.
- **수정:** preconnect 전용 오리진을 사용하고 타임아웃·조기 종료 중 먼저 발생한 곳에서 중복 없이 센다. 미사용/전체를 함께 출력하며 대조군 전체가 0이면 힌트 미실행으로 **판정 불가**, 전체>0인데 미사용 0이면 계측을 의심한다.
- **당시 검증·정정:** 연속 실행에서 양성 대조와 프록시 타깃 소켓 0을 확인해 아래 초기 불안정 기록을 보완했다. **`dns-prefetch`는 여전히 측정하지 못했다**: 소켓을 열지 않고 숫자 IP에는 DNS 조회 자체가 없다.

<a id="2026-08-21--sri-를-안-벗겨서-스크립트가-통째로-차단되고-있었다--meta-csp-는-페이지-realm-에서-그대로-먹혔다-상호-결손"></a>
## 서버 SRI 누락·페이지 realm meta CSP 누락 (2026-08-21)

- **SRI 원인·수정:** 리라이트된 본문은 원본 integrity와 달라 브라우저가 실행을 차단했다. 정적 파서 요청은 프렐류드 스윕보다 빠르므로 htmltx에서 `script`/`link`의 integrity를 제거하고 공통 `data-zp-integrity`에 백업해야 했다. `/sripage`에서 실행 복구와 attr/prop/`hasAttribute`의 원본 되읽기를 확인했다.
- **meta CSP 원인·수정:** 동적 삽입도 실제 적용돼 런타임 스크립트·릴레이를 막을 수 있었다. 정책은 교집합이라 완화 탈출은 아니며 meta의 `report-uri`는 크롬이 무시해 타깃 히트도 없었다. 프렐류드에서 `data-zp-blocked-http-equiv`로 무력화하되 `setAttribute`, `HTMLMetaElement.httpEquiv`, `transformHTML` 세 경로를 모두 처리했다. **프로퍼티 대입은 setAttribute 훅을 통과하지 않으며 우리 정책 meta는 보존해야 한다.**
- **당시 검증:** 타깃 CSP 주입은 무력화되고 우리 정책만 살아 있으며 이미지 로드가 복구됐다. 구멍 매트릭스·static-policy 새 가드 변이·cargo 전체(`zp-htmltx` 포함)·`go test ./...`·제한된 실사이트 축이 통과했다. 양 구현의 상호 누락이므로 단방향 검사만으로는 부족했다.

<a id="2026-08-21---를-리라이터가-무시하고-있었다-그리고-link-rel-서버측-부재-는-재-보니-결함이-아니었다"></a>
## `<base href>` 누락과 서버 link rel 비결함 판정 (2026-08-21)

- **base 결함·수정:** htmltx가 상대 URL을 항상 문서 URL에 풀어 오리진·경로를 잘못 선택했다(프록시 경유이므로 유출은 아님). 스트리밍 순서에 맞춰 `Rc<RefCell<String>>` 기준을 `<base href>`에서 갱신하고 이후 파싱 항목에 적용했다. base 속성 자체는 `updateVirtualBase`가 원본을 읽도록 리라이트하지 않았다. 당시 대조군과 요청 일치·단위 시험을 확인했다.
- **link rel 정정:** 서버에 페이지 realm 같은 rel 제거 분기가 없다는 사실은 **유출 결함이 아니었다**. htmltx의 `("link","href")` 리라이트로 정적 prefetch/preload/modulepreload는 프록시로 갔다. 정적 링크는 동작하고 런타임 생성 링크는 삼켜지는 비대칭은 당시 미변경으로 남겼다.
- **계측·후속:** preconnect/dns-prefetch는 HTTP 바이트 축으로 판정할 수 없고 단순 연결 수에는 프록시 서버 다이얼도 섞였다. 미사용 소켓 계측의 초기 불안정은 위 후속에서 원인·수정 확인, DNS는 미측정이다. worker bootstrap의 `importScripts('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__')` 치환은 산출물에서 이미 정상임을 확인했다. 당시 미측정이던 SRI/meta CSP는 위 별도 항목에서 조사됐다.
- **당시 검증:** 구멍 매트릭스·static-policy·cargo 전체·`go test ./...`·naver/wikipedia/github의 제한 축 통과.

<a id="2026-08-21--url-빌더가-넷이었다-프래그먼트를-삼키면--가-빈-채로-렌더된다"></a>
## 프록시 URL 빌더 불일치가 SVG 프래그먼트를 삼킴 (2026-08-21)

- **원인:** 네 빌더 중 htmltx만 프래그먼트를 `?url=` 밖에 보존했다. CSS·프렐류드가 `#i`를 `%23i`로 삼키면 브라우저가 SVG 심볼을 고르지 못해 `<use>`가 비었다. 공백·문장부호 인코딩 차이는 SW `URLSearchParams`에서 풀려 실제 실패는 관측되지 않았지만 캐시 키와 후속 디코더 불일치 위험이 있었다.
- **수정·증거:** `crates/zp-shared/src/proxyurl.rs` 단일 빌더를 htmltx·zp-css가 사용하고 JS도 `encodeURLParam`·프래그먼트 분리 규칙으로 맞췄다. `proxy_url_cases.json`의 바이트 파리티와 양쪽 변이, 실제 SVG bbox로 검증했다.
- **별도 계측 결함:** `a20-static-use`/`g7-realm-use`는 cross-origin 외부 use 거부와 서버의 잘못된 PNG 응답 때문에 대조군도 미동작이었다. same-origin 진짜 SVG로 교체했다. 내비게이션 러너도 이전 프록시 이동과 `/reset`·다음 대조군이 경합해 이전 ID를 읽었다. `about:blank` 후 열도록 수정해 양성 대조를 복구했다.
- **당시 상태:** 구멍·내비게이션 매트릭스의 해당 측정 축에서 유출·재현성 회귀 없음, static-policy·cargo 전체·`go test ./...`·제한 실사이트 축 통과. 비어 있는 대조군에서 나온 0은 이 검증에 포함하지 않는다.

<a id="2026-08-21--resolve_against_base-가--를-안-접었다--그런데-감사-보고의-심각도는-과장돼-있었다"></a>
## dot-segment 미정규화: 실제 영향은 일관성 (2026-08-21)

- **원인·심각도 정정:** htmltx `resolve_against_base`만 문자열 결합으로 `.`/`..`를 남겼다. 그러나 SW `canonicalTargetURL`이 전송 전에 정규화해 감사의 404 가설은 관측되지 않았다. 실제 차이는 서버와 페이지 realm의 `?url=` 문자열·캐시 키·`alreadyMapped` 및 컨텍스트 키 일관성이었다.
- **수정:** RFC 3986 §5.2.4의 `normalize_dot_segments`를 경로 생성 두 곳에 적용하고 쿼리·프래그먼트는 보존했다. `relative_subresource_resolved_against_target`이 잘못된 `%2F.%2F` 출력을 정답으로 고정하던 기대값도 수정했다.
- **당시 검증·잔여:** 단위 시험·cargo 전체·static-policy·매트릭스 무회귀, 브라우저에서 realm 값과 바이트 일치 확인. wikipedia 오류가 한 번 발생한 뒤 재현되지 않았으며, 기존 l10n 404와 같은 문제인지는 **미확인**이다.

<a id="2026-08-21--srcset-후보-분해기가-넷이었고-셋이-split-이었다--요소-훅-두-경로에-srcset-분기가-아예-없었다"></a>
## srcset 분해 사본·속성 훅 누락 (2026-08-21)

- **원인:** `setAttribute('srcset', …)`는 목록 전체를 URL 하나로 삼켰고, `img.srcset` 대입은 리라이트를 건너뛰어 원본 URL을 남겼다(csp-only). HTML 주입·스윕도 `split(',')` 때문에 data URL을 분할했다. “프록시 URL에는 쉼표가 없으므로 안전”이라는 복제 주석은 **리라이트 전 입력**을 무시했다.
- **수정:** Rust `split_srcset_candidates`·JS `splitSrcsetCandidates`로 분해를 모으고 `lead + url + tail`의 원문 복원으로 디스크립터를 보존했다. `enforceSrcsetAttribute`/`upgradeSWLessSrcset`/`applySWLessRelay`를 통합하고 setAttribute 및 `img.srcset`/`source.srcset`/`link.imageSrcset` 프로퍼티 훅을 추가했다. 게터 저장소는 `src`와 덮어쓰지 않도록 **(요소, 속성)** 단위로 분리했다.
- **증거·최종 정정:** 격리 월드에서 실제 속성을 측정했다. `crates/zp-shared/testdata/srcset_cases.json`을 Rust와 `static-policy.test.js`가 공유하고 변이·구멍 매트릭스 g9~g12·전체 시험을 통과했다. `String(raw).split(',')` 및 `indexOf(ZP.apiPath('fetch')) >= 0) return part`를 요구하던 소스 박제 가드는 의도 검사로 바꿨다. **당시 data 예외 기반 분해는 일반 URL의 쿼리 쉼표를 놓쳤으며, 8월 24일 공백 런·후행 쉼표 규칙으로 다시 고쳤다.**

<a id="2026-07-30--shorthand-객체-프로퍼티가-keyless-로-붕괴--파일-전체-syntaxerror"></a>
## 2026-07-30 — shorthand 프로퍼티 붕괴로 파일 전체 SyntaxError

- **원인:** `{ window, document, navigator }`의 shorthand 식별자는 key/value span을 공유한다. 일반 참조 visitor가 이를 `__zp_get(...)`으로 치환해 key 없는 프로퍼티를 만들었고, NAVER `ntm_*.js` 전체가 파싱 실패하여 무관한 심볼까지 소실됐다.
- **수정·불변식:** [zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs)의 `visit_object_property`가 dangerous-global shorthand에 `SHORTHAND_GLOBAL_GET`을 emit하고 value 방문을 중단한다. `apply_patches`는 `window:__zp_get(globalThis,"window")`로 확장한다. 공유 span의 문법적 역할을 확인하고 출력은 반드시 재파싱해야 한다.
- **당시 검증:** `ntm_ec8638b0efc1.js`, `ntm_d2d2463c73f0.js` V8 파싱 통과, NAVER 검색 SyntaxError 제거, Wikipedia 무회귀 및 Rust/JS 테스트 통과. shadowed shorthand·method/getter key는 유지하고 computed key·explicit property·spread·class field·arrow 반환 객체도 유효 JS임을 확인했다.
- **별개 미해결·보안 금지:** 당시 assignment target `({ location } = obj)`는 다른 AST 노드(`AssignmentTargetPropertyIdentifier`)라 깨진 출력을 냈다. 후속 [9/6 쓰기 참조 수정](#ci-write-reference)이 이를 다루므로 당시 공백을 현재 미구현으로 읽지 않는다. 미변환으로 실제 전역 `location` write를 허용하는 것은 탈출 경로이므로 불가하며, LegacyUnforgeable이라 재정의로 막을 수도 없다. scope Proxy 노출은 새 공격면/E1 교차검증, assignment 전체의 `__zp_set`+temp 재작성은 평가순서·다중 프로퍼티 설계가 필요했던 별도 사안이다.
- **빌드 함정:** `npm run build:web`은 WASM을 재빌드하지 않는다. Rust 변경 검증에는 `npm run build`가 필요했고 서버 exe 잠금 때문에 서버 중지가 필요했다.

<a id="2026-06-07--split-bundle-c1-step-21-shadow-compare-가-발견한-modern-rewriter-의-두-가지-회귀--patch-mode-marker-resolution-누락--function-global-미보호"></a>
## 2026-06-07 — split-bundle shadow-compare: marker·Function 회귀

- **patch-mode 원인·당시 제안:** `ndp-loader.js`에서 [Rust `rewrite_script_patches`](../../crates/zp-rewriter/src/lib.rs)가 raw `GLOBAL_GET`/`MEMBER_GET`/`MEMBER_SET`/`METHOD_CALL` marker를 반환하지만 [SW `applyScriptPatches`](../../web/sw.js)는 단순 splice만 하여 SyntaxError를 만들었다. legacy primary 때문에 잠복했던 fallback 결함이다. final replacement를 Rust에서 resolve하거나 JS resolver를 이식하거나 full re-emit만 사용하는 방안이 제안됐으며, 이 기록에는 수정 완료·재비교 성공이 없다.
- **Function 원인·보안 규칙:** `cross-domain-storage-remote-3.0.0.js` 비교에서 modern은 `Function.prototype`을 그대로 남겼다. [modern `DANGEROUS_GLOBALS`](../../crates/zp-rewriter/src/lib.rs#L86)에 `Function`이 없고 [legacy](../../rewriter-rs/src/lib.rs)에는 있었다. `Function.prototype.constructor`를 통한 eval-equivalent 전역 접근은 membrane 우회이므로 허용 불가. `Function` 추가·회귀 테스트·`eval` 형제 경로 점검은 당시 제안이며 완료 증거는 없다.
- **비교 증거·상태:** [web/sw.js](../../web/sw.js)의 `shadowCompareRewriters`/`recordShadowDivergence`, circular buffer, `/zp/api/__shadow_log`로 NAVER 두 divergence를 관측했고 Wikipedia 비교는 divergence가 없었다. microtask에서 변경된 `code`를 읽어 pragma 차이를 오탐하던 closure bug는 `const legacyForShadow = code` snapshot으로 수정했다.
- **별개 빌드 버그:** `npm run build -- --skip-rust`가 `dist/web`을 지우면서 WASM 산출물 `dist/web/__zp/`도 삭제하여 SW 등록 때 fetch 503을 냈다. `scripts/build.mjs`의 `cleanSelectedOutputs`/`rmWebPreserveZp`가 Rust skip 시 해당 디렉터리를 보존하도록 수정했다. divergence 제거 후 primary swap이라는 순서는 당시 전략이지 현재 작업 목록이 아니다.

---

<a id="2026-06-07--split-bundle-c1-step-2a-sw-swap-naver-renderer-wedge--zprewriterrewritescript-legacy-primary-경로를-zpbundle-modern-oxc-0133-으로-교체했을-때-naver-메인-hydration-단계에서-webview2-renderer-완전-wedge-revert--step-2-전략-재설계"></a>
## 2026-06-07 — SW modern swap 후 NAVER renderer wedge, revert

- **관측·미규명 원인:** [web/sw.js](../../web/sw.js)의 legacy primary를 modern `ZPBundle`로 바꾸자 NAVER 메인은 검색창만 남고 WebView2 renderer가 wedge됐다. `/zp/api/__debug_ndp`에서 `ndp-loader.js` 대신 upstream 404 HTML을 확보했다. strict parser는 HTML을 거부해야 하지만 raw HTML이 code로 나온 정확한 runtime 경로는 미규명이며 stale SW activation으로 새 trace도 확인하지 못했다.
- **가설·조치:** cold `await initBundle()` 지연→anti-bot/CDN 404→광고/SafeFrame·postMessage·hydration timing 붕괴는 **확정 원인이 아닌 당시 가설**이다. primary swap 변경은 전부 revert했다. 후속 shadow-compare가 marker 누락과 `Function` 공백을 실제 발견했으므로 timing만으로 설명하지 않되, wedge의 인과가 확정된 것도 아니다.
- **보존 증거·검증 한계:** [crates/zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs)에 `html_body_must_parse_error_under_strict_mode`, `naver_ndp_loader_round_trips_as_valid_js`를 추가하고 [ndp-loader-fixture.js](../../crates/zp-rewriter/src/ndp-loader-fixture.js)를 보존했다. cargo의 HTML 거부·출력 동등성/재파싱 검증은 실제 SW lifecycle·renderer 검증을 대신하지 않는다.
- **당시 전략·공백:** SW boot warm-up/ready gate와 legacy fallback, shadow-compare 후 swap이 제안됐다. page realm은 `root.ZPRewriter`에 의존하고 ZPBundle이 로드되지 않아 classic-script glue·동기 WASM boot 기반이 별도로 필요했던 역사적 공백이다. 2026-06-06 iframe rewrite wedge와 증상은 유사하지만 동일 원인 확정은 아니다.

---

<a id="2026-06-06--anchorformformaction-raw-target-url-escape-vector--middle-click--ctrlclick--target_blank--우클릭-open-in-new-tab--copy-link-address-시-ip-leak-zp-htmltx-가-navigation-url-attribute-변환-추가-proxy-origin-via--data-zp-target-url"></a>
## 2026-06-06 — navigation raw URL 탈출 및 hydration 누락

- **원인·보안 금지:** [zp-htmltx](../../crates/zp-htmltx/src/lib.rs)가 subresource만 변환하고 anchor/form은 [click intercept](../../web/runtime-prelude.js#L1699)에 의존했다. 좌클릭은 안전해도 middle/Ctrl-click·`target=_blank`·우클릭 새 탭은 raw target으로 직접 접속해 IP를 노출하고, hover/copy는 주소를 노출했다. **event interception만으로 native attribute surface를 안전하다고 판단하면 안 된다.**
- **SSR 수정·규칙:** `proxied_navigation_url`로 `a/area[href]`, `form[action]`, `input/button[formaction]`의 raw attribute를 proxy-origin `?via=<encoded target>`로 바꾸고 `data-zp-target-url`에 원래 절대 URL을 보존했다. [clickNavigationTarget](../../web/runtime-prelude.js#L1786)은 [metadata fast path](../../web/runtime-prelude.js#L1795)를 사용한다. fragment-only는 유지하고 빈 `proxy_origin`은 host-test 호환상 skip했다. iframe/frame은 child-realm pipeline과 충돌 위험 때문에 제외했다([SafeFrame 관련 기록](#2026-05-30)).
- **오진 배제·당시 검증:** proxy URL bar, [가상화된 `document.URL`](../../web/runtime-prelude.js#L1975), [SW controller facade](../../web/runtime-prelude.js#L3118)는 누출 원인이 아니었다. proxy diag URL의 NAVER 404도 [target-relative routing](../../web/runtime-prelude.js#L1159) 결과였다. navigation별 Rust 테스트·workspace·JS static-policy가 통과했다.
- **후속 정정 — launcher:** 처음에는 `?via=` handler가 없어 새 탭이 launcher 첫 화면에 머물렀으나, **별도 commit에서 완료**됐다(해시 미기재). [web/index.html `handleVia`](../../web/index.html)가 `registerShare` 후 `location.replace(sharePath + fragment)`하며, 당시 taskweaver로 encrypted share URL 도달을 확인했다. 초기 공백을 현재 미구현으로 읽으면 안 된다.
- **후속 정정 — hydration:** SSR만으로는 부족했다. NAVER/GitHub anchor가 `href` setter·`setAttribute`로 raw URL을 덮어썼다. [URL property setter](../../web/runtime-prelude.js#L1985), [setAttribute](../../web/runtime-prelude.js#L2556), [setAttributeNS](../../web/runtime-prelude.js#L2602)를 `proxyViaURL(t)`로 바꾸고 absolute target은 `urlMeta`/metadata에 보존했다. JS helper는 fragment·inert scheme·non-HTTP(S)를 통과시키며 Rust와 percent-encoding byte 차이는 launcher decode에 영향을 주지 않았다.
- **backstop·별개 wedge:** [navigation backstop helpers](../../web/runtime-prelude.js)는 initial/deferred scan과 child-realm 설치로 누락을 보완하고, 페이지가 metadata를 지워도 closure-private `urlMeta`를 복원하도록 했다([NAVER fingerprint hide](real-site-compat.md)). MutationObserver 초안은 NAVER hydration 때 renderer wedge를 일으켜 제거했다. attribute 재설정→mutation→microtask 무한 반복은 당시 가설이며, install/idle 두 scan으로 대체했다.
- **최종 원인 정정:** 두 scan 뒤에도 잔존 raw anchor는 줄지 않았다. clone/늦은 삽입 추정 대신, main document의 숨겨진 자동완성 widget이 `innerHTML`로 mount될 때 [page-side `transformHTML`](../../web/runtime-prelude.js#L3006)의 JS walker에 navigation 분기가 없음을 확인했다. 이 구현은 동명의 server-side WASM transform을 호출하지 않는다. walker의 `enforceLinkPolicy(node)` 뒤 `applyNavigationBackstop(node)`를 추가하여 HTML setter·`insertAdjacentHTML`·`document.write`·Range·DOMParser 경로를 함께 보완했다.
- **최종 당시 검증·한계:** NAVER 관측에서 raw external anchor가 **0**이 됐다. primary setter fix나 backstop만으로 완전 차단됐다는 앞선 표현은 이 walker 정정으로 대체한다. Rust transform·prelude setter/attribute/walker·launcher를 pin하는 static-policy 테스트도 통과했다. 이는 해당 NAVER 관측이며 GitHub의 별도 hydration 실패나 모든 사이트의 보편적 해결 증거는 아니다. [당시 후속 참조](#2026-06-06--anchorformformaction-raw-target-url-escape-vector), PHASE3_PLAN line 129 및 `.ai/PHASE2_STATUS.md`의 escape-matrix 제안은 역사적 참고다.

### 별개 역사적 회귀 — iframe/frame `?via=` 적용 후 revert

- **관측·가설:** iframe/frame도 navigation 분기에 넣자 Rust·static-policy·build는 통과했지만 NAVER 메인 콘텐츠가 사라졌다. 다수 iframe의 launcher→share encrypt→nested SW navigate 비동기가 SDK의 `contentWindow` readiness를 깨뜨렸다는 설명은 당시 가설이다.
- **조치·규칙:** 분기·추가 테스트·정책 변경을 revert하고 [iframe_src_still_left_alone guard](../../crates/zp-htmltx/src/lib.rs)를 유지했다. 사용자 클릭용 launcher 모델을 page-load iframe에 그대로 적용하지 않는다. server-side share encryption(AES-256-CBC+HMAC-SHA256) 또는 `activatedFrameURL`식 `about:blank` 후 직접 share URL 설정은 당시 대안이지 승인된 구현이 아니다.
- **검증 한계:** revert 후 cold load가 느려 해당 세션에서 NAVER 정상 렌더의 최종 시각 확인은 끝내지 못했다.

---

<a id="2026-05-31--lol_html-attrvalue-html-entity-미디코드--wikipedia-stylesheet-url-깨짐"></a>
## 2026-05-31 — lol_html entity 미디코드로 Wikipedia CSS 실패

- **원인:** lol_html v2 `Attribute::value()`는 character reference를 디코드하지 않은 raw body를 반환한다. `&amp;modules=`를 그대로 percent-encode하여 upstream이 잘못된 query key로 해석했고 stylesheet가 비어 Vector skin이 사라졌다. production 경로 신규 진입 또는 v1→v2 차이라는 발현 시점 설명은 당시 추정이다.
- **수정·규칙:** [decode_url_html_entities](../../crates/zp-htmltx/src/lib.rs#L441-L490)를 [URL attribute 처리 전](../../crates/zp-htmltx/src/lib.rs#L106-L114)에 적용해 scheme 검사와 URL wrapping이 decoded 값을 사용하도록 했다. 구현은 명시된 일반 named/numeric entity를 처리하고 나머지는 유지하는 제한 decoder이며 `&` 없는 fast path가 있다. tokenizer getter가 decode한다고 가정하면 안 된다.
- **당시 증거·미해결:** [stylesheet_link_with_html_entity_decoded 테스트](../../crates/zp-htmltx/src/lib.rs#L719-L737)와 cargo 테스트 통과, 실 Wikipedia Vector skin 복구 및 NAVER 광고 무회귀를 확인했다. GitHub homepage의 오류 화면·React payload 노출은 **별개 미해결**로 남았으며 hydration/membrane/module-loading 문제라는 설명도 추정이다.

---

<a id="2026-05-31--gfp-naver-non-safeframe-ad-installsafeframeresizeshim"></a>
## 2026-05-31 — GFP non-SafeFrame 광고 높이 shim

- **최종 원인 정정:** NAVER GFP 광고 콘텐츠는 iframe 안에 있었지만 높이가 0이었다. 앞선 V8 incumbent-realm/`e.source` gate 가설보다 깊은 원인은 **`forceSafeFrame=false` 분기에서 `sf-resized` sender 자체가 로드되지 않음**이었다. `gfp-bridge.js`는 tracking 전용이고 resize sender는 SafeFrame container에만 있었다. host listener와 `sf-init` name만 남아도 protocol은 완성되지 않는다.
- **수정·규칙:** [installSafeFrameResizeShim](../../web/runtime-prelude.js#L2840-L2900)이 `sf-init` frame에만 적용되고 [Symbol marker](../../web/runtime-prelude.js#L72)로 중복 설치를 막는다. polling과 이미지 load 시 body/documentElement의 scroll/offset 높이 최댓값을 직접 반영하고 같은 높이는 dedup한다. cross-realm ResizeObserver만 쓴 초안은 이미지 로드 전 작은 높이에 멈춰 polling으로 보완했다.
- **당시 증거·미해결:** [구현·instrumentIframe 호출](../../web/runtime-prelude.js#L2839-L2900) 적용 후 NAVER 대상 광고 세 개의 높이와 스크린샷 가시성을 확인했고 기존 비대상 광고는 유지됐다. 정상 NAVER와 달리 왜 fluid/non-SafeFrame 조합이 선택됐는지는 **미해결**이다. 지속 polling 비용과 documentElement/margin 때문에 body보다 큰 높이를 쓰는 trade-off가 남았으며 안정화 후 polling 종료는 당시 제안일 뿐 구현 확인은 없다.

---

<a id="2026-05-31--v8-incumbent-realm-leak--postmessage-source-corruption--sender-queue--parent-facade-fix-부분"></a>
## 2026-05-31 — postMessage source 손상: sender queue·parent facade (부분)

- **원인:** NAVER GFP SafeFrame 콘텐츠는 주입됐지만 높이가 0이었다. child의 `parent.postMessage`가 parent-realm wrapper를 지나며 `e.source`가 child 대신 root로 관측됐고, SDK의 `e.source === iframe.contentWindow` 슬롯 식별이 실패했다.
- **수정:** [sender FIFO·facade 저장소](../../web/runtime-prelude.js#L60-L69), [parent/top redirect](../../web/runtime-prelude.js#L2748-L2799)로 sender를 기록하고 native root postMessage를 호출했다. 예외 시 기록을 제거하고 root listener에서만 queue를 소비해 source를 보정했다. Chromium Window 대상 Proxy의 get trap 시도는 실패하여 null-prototype facade와 window 속성 위임으로 교체했다.
- **별도 결함·상태:** [membrane get](../../web/runtime-prelude.js#L773-L797)이 child의 parent/top을 자기 자신으로 돌려 facade를 우회하던 것도 수정했다. 당시 세 resize 메시지의 source 보정·dispatch는 확인했지만 **높이 0과 광고 비가시성은 미해결**이었다. SDK 등록·추가 identity 검증은 미확정 분석 후보였으며, Wikipedia/GitHub 및 NAVER 본문 회귀는 관측되지 않았다.

<a id="2026-05-30--naver-gfp-safeframe-광고-iframe-script-execution--sw-control-reset--child-realm-loader-패턴"></a>
## 2026-05-30 — SafeFrame document reset·child realm loader

- **원인:** about:blank의 `document.write`가 document를 reset한 뒤 iframe fetch가 SW를 우회했다. parent 스크립트와 달리 SafeFrame 요청은 SW trace에 없었고, 직접 도달한 Go 서버에는 `/zp/api/script` 핸들러가 없어 403이었다. 부모 inline wrapper 위임도 코드를 parent global에서 실행해 iframe의 `window.onerror`·`name.adm` 흐름을 깨뜨렸다.
- **수정:** [child 실행기](../../web/runtime-prelude.js#L2834-L2851)는 wrap 전 캡처한 `w.Function`으로 자식 realm에서 실행한다. 외부 loader는 SW-controlled parent의 native fetch로 코드를 받아 child에서 실행하며, [transformHTML의 inIframe 경로](../../web/runtime-prelude.js#L2371-L2390)를 DOM 삽입·write/writeln에 전달했다. constructor WeakMap 정책은 유지했다.
- **상태·한계:** 당시 세 광고 payload·banner 주입, 스크린샷 일부 가시성 및 Wikipedia/GitHub/RT 회귀 없음이 보고됐다. **최종 visibility 판정은 05-31의 높이 0 미해결 기록이 우선**한다. 외부 실행의 async 전환은 동기 의존 race를 만들 수 있고 module을 classic으로 처리해 import/TLA 의미가 손상될 수 있었다. 이 호환성 범위는 미검증이다.

<a id="2026-05-30--transformhtml-내-const-root-가-outer-root--window-를-tdz-shadow-하여-silent-referenceerror--debug-logger-한-호출도-안-됨-으로-오인"></a>
## 2026-05-30 — transformHTML logger의 TDZ 오진

- **원인:** [함수 내부 `const root`](../../web/runtime-prelude.js#L2356)가 outer window alias를 shadow하여 시작부 logger가 TDZ ReferenceError를 냈고 빈 catch가 삼켰다. “transformHTML을 거치지 않는다”는 로그 기반 가설은 기각됐다.
- **수정·규칙:** debug global 접근을 `globalThis` 또는 명시 alias로 바꾸고 함수 내부 `root/self/window/document` 재선언을 확인한다.
- **상태:** 로깅 결함 수정 기록이며, 빈 로그만으로 호출 부재를 증명할 수 없다는 사례다.

<a id="2026-05-30--documentprototypewritewriteln-proto-level-wrap--iframe-mo--transformhtml-external-script-routing"></a>
## 2026-05-30 — Document prototype wrap·iframe observer·script routing

- **원인:** 부모 document 인스턴스만 감싸 child `write/writeln`이 변환을 우회했고, iframe MutationObserver도 없었다. transformHTML은 외부 src까지 inline blocker로 막았다.
- **수정:** [runtime-prelude.js](web/runtime-prelude.js)에서 realm별 Document prototype을 wrap하고, [문서별 observer·WeakSet](web/runtime-prelude.js#L2311), [prepareScriptElement 기반 외부 routing/inline wrap](web/runtime-prelude.js#L2274)을 적용했다. child에 INLINE_SCRIPT/MODULE/EVENT/SET_BASE 위임도 설치했다. [SW](web/sw.js)는 transportFetch에 원래 request를 넘겨 Accept-only 대신 browser-set 헤더를 전달했다.
- **상태·정정:** loader URL routing까지만 진척됐으며 parent 스크립트의 transport 200은 iframe loader 성공 증거가 아니었다. 당시 E1·NAVER 본문 회귀 없음, workspace/rewriter/static-policy 테스트 통과 기록이 있다. 부모 실행기 위임과 loader 미실행 원인은 후속 child-realm·SW reset 수정으로 보완됐다.

<a id="2026-05-30--decode_common_html_entities-가-string-literal-안의-entity-데이터-파괴--parse_failed"></a>
## 2026-05-30 — 무조건 entity decode가 외부 JS 데이터 파괴

- **원인:** [Rust decoder](rewriter-rs/src/lib.rs#L37)는 [05-29 encoded JS 대응](rewriter.md#2026-05-29)으로 추가됐지만 모든 입력에 적용됐다. SafeFrame escape map의 `&quot;` 같은 문자열 데이터가 구문으로 바뀌어 PARSE_FAILED가 났고 `window.onerror`가 오류를 숨겼다.
- **수정:** [rewrite_script](rewriter-rs/src/lib.rs#L84)에서 decode를 제거해 외부 소스는 raw로 파싱한다. [decodeInlineEntities](web/runtime-prelude.js#L781-L802)는 inline 실행 경로로 옮겼다. **이 정정은 “모든 source decode가 안전”이라는 과거 주장을 폐기한다.**
- **증거·상태:** `rewriter-rs/tests/safeframe_parse.rs`, `rewriter-rs/tests/safeframe_rewrite.rs`에 raw parse와 classic rewrite 회귀 검사를 기록했다. 이 항목 자체에는 실행 결과가 명시되지 않았다.

<a id="2026-05-30--iframe-에-__zp_-helper-부재--sw-rewrite-한-외부-스크립트-silent-실패"></a>
## 2026-05-30 — iframe `__zp_*` helper 누락

- **원인:** [installPhase2Membrane](web/runtime-prelude.js#L487)은 root에만 helper를 설치했다. 자체 prelude가 없는 about:blank iframe에서 SW-rewritten 외부 코드가 ReferenceError로 중단됐고 onerror에 가려졌다.
- **수정:** [installNetworkContainment](web/runtime-prelude.js#L2641-L2666)에 부모 closure 기반 `__zp_*` 위임을 설치해 location·dynamic constructor·dangerous-property 의미를 보존하고 일반 접근은 child native로 전달했다.
- **상태:** 당시 E1의 about:blank + SW-rewritten external script 실행 및 membrane 의미 유지가 회귀 결과로 기록됐다.

<a id="2026-05-30--contextual-paren-prefix-method_callmember_getmember_setglobal_get-emission"></a>
## 2026-05-30 — emission의 contextual paren

- **원인:** NAVER 웹툰에서 괄호 없는 emission은 `return__zp_call`로 붙고, 항상 괄호를 붙이면 줄바꿈 ASI가 깨졌다. `new globalThis.Request`도 helper의 Arguments 결합 때문에 일반 호출로 오파싱됐다.
- **수정:** `crates/zp-rewriter/src/lib.rs`, `rewriter-rs/src/lib.rs`의 `apply_patches`에서 앞 byte가 identifier-continue이거나 앞 non-whitespace token이 `new`일 때만 prefix 괄호를 넣었다. METHOD_CALL/GET/SET/GLOBAL_GET·render_expression에 적용하고 GLOBAL_GET은 marker로 문맥 결정을 미뤘다. always/never-paren 가설 모두 기각됐다.
- **증거·상태:** `new_global_member_constructor_preserved`, `return_followed_by_parenthesized_method_call`, `return_followed_by_parenthesized_replace_call` 추가 기록. 다른 keyword 확장은 당시 검토 후보였고 실행 결과는 별도 명시되지 않았다.

<a id="2026-05-30--super-keyword-rewrite-skip"></a>
## 2026-05-30 — `super` rewrite 제외

- **원인:** NAVER 웹툰 React bundle의 `super.X`·call·assignment를 helper 인자로 옮겨 SyntaxError와 빈 렌더를 만들었다. `super`는 일반 식별자 표현식이 아니다.
- **수정:** `crates/zp-rewriter/src/lib.rs`의 member/assignment/dangerous-call visitor에서 `Expression::Super` 받침을 제외해 native lexical binding을 유지했다.
- **증거·상태:** `super_member_access_not_rewritten`, `super_call_not_rewritten`, `super_method_call_not_rewritten`, `super_constructor_with_extends_globalthis_member` 추가 기록이며 개별 실행 결과는 명시되지 않았다.

<a id="2026-05-30--상대-url-subresource-resolution-proxied_subresource_url-가-target_url-base-사용"></a>
## 2026-05-30 — 상대 subresource URL의 target base

- **원인:** 상대 URL을 그대로 두면 proxy origin으로 resolve되지만 SW classifier는 `/zp/` 경로만 routing하여 이미지·CSS·스크립트가 실패했다. “VIRTUAL_SUBRESOURCE가 잡는다”는 가정은 기각됐다.
- **수정:** `crates/zp-htmltx/src/lib.rs`의 `proxied_subresource_url`·`absolute_target_url`에 target base를 적용하고 host/path/query/fragment-relative 값을 absolute proxy URL로 변환했다.
- **증거·상태:** `host_relative_img_resolved_against_target` 추가와 기존 relative URL 검사 갱신 기록이다.

<a id="2026-05-29--inline-script-더블-리라이트-zp-htmltx-가-미리-rewrite--prelude-가-wrap-후-다시-rewrite"></a>
## 2026-05-29 — inline 이중 rewrite

- **원인:** htmltx가 먼저 rewrite한 inline 코드를 runtime이 다시 rewrite해 helper 접근까지 변형했다. NAVER aside의 `window.nmain.gv` 초기화 실패가 hydration 오류로 이어졌다.
- **수정·금지:** [htmltx](../../crates/zp-htmltx/src/lib.rs#L199)는 raw source를 JSON payload로 wrap하고 runtime에서 한 번 rewrite하도록 변경했다. 서버 strict parse 실패는 BLOCKED_SCRIPT로 fail-closed, `</` escape로 script 조기 종료를 차단하고 prepared wrapper는 재포장하지 않았다. **동일 payload의 이중 rewrite는 금지한다.**
- **상태·후속:** wrap/raw 보존 테스트 갱신과 메뉴 hydration 정상화가 기록됐다. Puppeteer 메뉴 검사와 event attribute 중복 처리 검토는 당시 제안/미검증이며, 쇼핑 RSC 오류는 별개였다. **08-22에는 크기별 서버 단일 rewrite 예외가 기록돼 “항상 runtime만”이라는 옛 구현 설명을 대체한다.**

<a id="2026-05-29--rewriter-parse_failed-on-html-entity-encoded-js-react-dangerouslysetinnerhtml"></a>
## 2026-05-29 — HTML-entity encoded inline JS

- **원인:** NAVER shopping darkmode inline의 `=&gt;`·`&amp;&amp;`가 OXC PARSE_FAILED를 일으켰다. React/Next.js serializer 경유 설명은 당시 추정이며 정확한 encoding 경로는 확정되지 않았다.
- **당시 수정·정정:** [rewriter-rs/src/lib.rs](../../rewriter-rs/src/lib.rs)에 named/numeric entity decode를 넣고 실패 시 fail-closed를 유지했다. **05-30 외부 문자열 파괴 발견으로 Rust 전역 decode는 제거되고 inline 경로로 제한됐다. 모든 inline 데이터에 안전하다는 일반화도 검증된 보장이 아니다.**
- **상태:** 단위·shopping E2E는 당시 제안 테스트였다. [inline 이중 rewrite 수정](#2026-05-29--inline-script-더블-리라이트-zp-htmltx-가-미리-rewrite--prelude-가-wrap-후-다시-rewrite)과 함께 해결됐다는 옛 서술은 후속 정정·광고 미해결 상태와 구분한다.

<a id="기록할-종류"></a>
## 기록할 종류

- 역사 분류: AST 노드 누락, URL attribute/element·proxy_origin 발행 누락, module/classic 분류, sourcemap composition 회귀. 현재 작업 목록은 아니다.

<a id="2026-08-22--지문-축-2회차-직렬화는-표면이-하나가-아니다-그리고-세정기가-자기-은폐에-눈멀었다"></a>
## 2026-08-22 — 직렬화 표면 누락·세정기의 자기 은폐

- **srcdoc:** 중첩 마크업의 주입 흔적이 노출됐다. `srcdocMeta` WeakMap과 `setInjectedSrcdoc`로 쓰기를 모으고 getAttribute/property/직렬화에서 원본을 반환했다. literal `'srcdoc'` 호출만 찾던 가드는 변수 `k`를 놓쳐 `injectSrcdoc` 허용 위치 제한으로 교체했으며 변이 검사 통과가 기록됐다.
- **XMLSerializer·세정 순회:** serializeToString 훅 누락은 `scrubbedClone` 재사용으로 수정하되 Document와 Element 순회를 분리했다. membrane querySelectorAll이 내부 asset을 숨겨 세정기가 삭제할 노드를 못 보던 별도 결함은 native 순회로 수정했다. src 없는 `zp_chain` prewarm/CSP meta에는 `data-zp-internal`을 달았다.
- **URL·상태:** getAttribute와 달리 직렬화에 남던 proxy URL은 clone에서 target 값으로 복원하고 srcset은 recalledSrcset을 사용했다. 이 원본 기억값 자체가 이미 proxy 값일 수 있다는 문제는 아래 후속 수정이 보완한다.

<a id="2026-08-22--통합-2차-되돌리기가-세-벌-자산-목록이-세-벌-그리고-죽은-세정기"></a>
## 2026-08-22 — 중복 deproxy·asset 목록·죽은 세정기

- **원인·통합:** navigation/performance/serialization의 세 deproxy 구현은 `?url=`, `&u=`, `?via=`, `/zp/p/`, 다중 값 처리 범위가 달랐고 navigation은 모르는 URL을 현재 문서로 숨겼다. `deproxyURL(raw, {scan, fallback})`로 통합하고 경우별 실행 가드를 뒀다.
- **자산·정리:** SW/prelude의 다른 내부 asset 목록은 zp-core `INTERNAL_ASSET_SCRIPTS`/`isInternalPath`로 통합했다. Go 서빙 목록은 역할상 별도 유지하되 script 자산 서빙 가드를 추가했다. 호출자 없는 `sanitizeSerializedHTML`은 제거했다. 기존 Rust URL builder의 JS parity 실행·base 정규화 테스트도 당시 확인됐다.
- **가드 결함:** SW 주입 검사가 실제 `assetURL` 대신 목록의 `assetPath`에 매치하던 오검사를 발견했다. 소스 slice 실행 가드는 죽은 함수를 경계로 삼지 않고, 끝의 `//`가 붙인 return을 삼키지 않도록 개행이 필요했다.

<a id="2026-08-22--마지막-직렬화-표면-인라인--텍스트-그리고-또-하나의-낡은-측정-주석"></a>
## 2026-08-22 — style/script 원본 읽기·낡은 성능 근거

- **원인·수정:** style.textContent는 rewritten CSS, script.textContent는 실행 wrapper를 노출했다. style setter는 WeakMap 원본을 보관하고 서버 변환분은 deproxy했다. srcset의 “원본”도 서버 proxy 값일 수 있어 반환 직전 다시 deproxy하도록 수정했다.
- **최종 inline 정책 기록:** `zp-htmltx`의 서버 사전 rewrite는 원본을 잃었다. 당시 NAVER 실물 재측정이 “두 번 rewrite하면 수십 초 정지”라는 낡은 주석을 반박하여, 256KB 이하에는 raw `__ZP_EXEC_INLINE_SCRIPT`, 초과에는 서버 단일 rewrite를 사용하도록 바꿨다. 이는 당시 구현 선택이지 현재 승인 성능 명세가 아니다.
- **상태:** 당시 NAVER 원본 읽기·wrapper 비노출과 직접 로드에 가까운 로드 시간이 보고됐고, fixture 지문/outerHTML/XMLSerializer 검출은 0이었다. 새 실행은 없으며 실사이트 style의 잔여 누출은 다음 항목에서 발견됐다.

<a id="2026-08-22--지문-탐지기를-실사이트에-대다-새-표면-하나-그리고-탐지기-자신의-오탐"></a>
## 2026-08-22 — 실사이트 지문 검사·GitHub 오탐

- **실제 누출:** Wikipedia style은 서버가 고친 CSS를 다시 “원본”으로 기억해 샜다. 보관값/현재값 모두 **반환 직전 deproxy**하는 규칙을 srcset/style/script에 적용했다.
- **기각된 가설:** GitHub fetch wrapper는 직접 로드 대조군과 바이트 단위로 같아 페이지 자체 코드로 판정됐다. “비-native이면 proxy 흔적” 검사를 폐기하고 `__zp`/`ZeroProxy`/proxy host/`/zp/` 식별자 노출로 좁혔다. 식별자 없는 proxy hook은 놓칠 수 있다는 탐지 한계가 남는다.
- **검증 범위:** 당시 NAVER/Wikipedia/GitHub와 fixture에서 해당 탐지기 검출 0. toString 양성 대조군은 검출됐지만 global/attribute 양성 주입은 scrubber가 숨겼다. 후자 둘은 scrubber 실패 시에만 울리는 축이며, 사이트 전체 호환성 해결 증거는 아니다.

<a id="2026-08-22--타이밍-축-신설-우리가-하는-말과-타이밍이-서로-모순이었다"></a>
## 2026-08-22 — timing 표면의 자기모순

- **원인:** controller를 null로 보이면서 workerStart는 양수였고 protocol/TLS/cache·transfer 필드도 다른 표면과 모순됐다. 프로브 역시 connect 지속시간과 TLS timestamp를 비교해 재사용 연결을 이상으로 오인했다.
- **당시 수정:** workerStart 0, scheme별 protocol, deliveryType 빈 값, transferSize=`encodedBodySize + 300`, HTTPS에만 secureConnectionStart=connectStart로 맞췄다. 당시 대조군과 형태 일치를 보고했으나 **scheme 기반 protocol·고정 헤더 크기는 실측 원본값이 아니라 정합성용 추정**으로 읽어야 한다.
- **잔여·정정:** 합성 응답은 encoded=decoded라 전부 비압축처럼 보였다. 실제 압축 크기를 지어내서는 안 된다는 제한 아래 transport 계측 배관 부재로 남겼다. subresource는 08-23에 보완됐지만 streaming navigation 문제는 남았다.

<a id="2026-08-23--압축-배관-커널--sw--페이지-0200--198200"></a>
## 2026-08-23 — 실제 압축 크기 배관·streaming 문서 미해결

- **원인·수정:** 08-16 이후 상류 압축은 이미 받고 커널이 풀고 있었지만 크기를 전달하지 않았다. http1/http2 `unwrap_response_body`는 decode 직전 길이를 `X-ZP-Encoded-Size`에 싣고, SW는 읽은 뒤 헤더를 제거해 요청 client에 `ZP_ENCODED_SIZE`를 보낸다. prelude Map은 아는 encodedBodySize만 대체하고 미지 값은 유지한다.
- **보안·검증:** **target URL이 든 크기 메시지를 다른 탭으로 broadcast하면 안 된다**(A2와 같은 탭 간 유출). 당시 GitHub subresource 대부분에 압축 크기가 반영됐지만, 이는 사이트 미해결 문제 전체의 해결을 뜻하지 않는다.
- **미해결:** streaming 문서는 gunzip 중 Content-Encoding/Length를 제거하며 GitHub 상류 문서는 Content-Length도 없었다. 진짜 encoded 크기는 stream 종료 후에야 확정돼 초기 헤더만으로 해결할 수 없다. 종료 시 커널 계수→SW 추가 통지 방식은 당시 제안일 뿐, navigation encoded=decoded는 known open item으로 남았다.

<a id="2026-08-23--문서-압축까지-닫았다-그리고-구조적으로-안-된다-는-내-진단이-틀렸다"></a>
## 2026-08-23 — 문서 압축: 불가능 진단 정정

- **원인·정정:** 인코딩 크기는 스트림 종료 후 확정되어 초기 헤더에는 못 싣지만, “구조적으로 불가능”은 오진이었다. `http2.rs`의 `pump_body`는 이미 gunzip 전 `total_in`을 세고 있었다.
- **수정:** 응답의 `X-ZP-Stream-Id` → 종료 시 SW 전역 `__zpStreamEncoded[id]` → transform `flush()` → 페이지 `encodedBodySize`로 전달. 내비게이션은 `resultingClientId`이며 종료 시 `clients.get`이 undefined여서 push 대신 URL 맵 pull로 바꿨다. 페이지는 자기 `virtualURL.href`로만 질의해 탭 간 새 정보 노출을 피했다.
- **당시 검증:** register/flush 실행과 클라이언트 부재를 계측했다. GitHub 인코딩 크기는 직접 접속과 근접했고, 리라이트로 디코딩 크기는 증가했다. naver/wikipedia/github 탐지 0건은 해당 측정 범위의 결과다.

<a id="2026-08-23--사이트를-넓히니-또-나왔다-script-src-스태시-누락--문서-압축의-두-번째-경로"></a>
## 2026-08-23 — script src 스태시와 버퍼 압축 경로

- **script 원인·수정:** Stack Overflow의 `setScriptSource` `CONTROL_PREFIX` 분기가 이미 프록시인 URL을 스태시 없이 통과시켰다. 타깃을 복구해 `urlMeta`·`data-zp-target-url`에 저장하고, `url_surfaces.json`에 없는 전용 `script:src`의 `getAttribute` 분기도 추가했다. 프로퍼티만 가리고 속성을 놓친 NAVER 폼과 같은 부류다.
- **압축 원인·수정:** 앞 수정은 스트리밍뿐이었다. MDN/HN의 `br` 등 버퍼 경로는 `X-ZP-Encoded-Size`가 있어도 내비게이션 push가 실패해 URL 맵 pull을 추가했다. push 성공 후에도 리스너 등록 전 메시지 유실에 대비해 맵을 지우지 않는다.
- **당시 상태:** naver/wikipedia/github/MDN/HN 탐지 0건. SO는 일시적 `Oops! Something Bad`로 처음에는 실제 페이지 재검증이 불가능했고 합성 프로브만 확인했다. 자동 로드 차단이라는 설명은 추정이었다.

### Stack Overflow 재확인·원인 정정 {#stackoverflow-재확인}

- **후속 검증:** 이후 정상 로드된 실제 SO에서 `.src` 누출 0건을 확인했다. 프록시 src 중 스태시 없는 항목은 내부 자산이었다.
- **정정:** “`!masked` 되돌리기가 있는데 작동 이유 미상”이라는 기록은 틀렸다. `6b4612e`에서 해당 게터의 `deproxyURL(..., { scan: true })`가 처음 들어갔다. img/style의 구현을 script에도 있다고 일반화한 오진이다. 수정 존재 여부는 해당 경로 diff로 확인한다.
- **독립 방어:** 쓰기 스태시는 멤브레인을 탄 대입만 덮는다. 격리 월드에서 네이티브로 심은 무스태시 프록시 src도 `.src`·`getAttribute`·`outerHTML`에서 타깃으로 읽혀야 하므로 읽기 복구는 중복이 아니다. `static-policy.test.js`와 변이 검사로 세 경로를 고정했다.

## `<base href>`로 프록시 탈출 (2026-08-25) {#base-href-탈출}

- **원인:** `n3-base-href`는 초기 HTML 리라이트 공백이라는 추정과 달리 실행 단계의 실제 탈출이었다. 링크 변환은 정상이지만 `location.assign/replace`·`history.pushState`에 넘긴 루트 상대 `/zp/p/...`가 타깃 `<base>` 오리진에 붙었다. 히스토리의 cross-origin `SecurityError`는 catch에 삼켜졌다.
- **수정·불변식:** 기존 `activatedFrameURL`처럼 프록시 이동은 절대 URL이어야 한다. `proxyAbsoluteURL()`을 `navigateToTarget`, `commitVirtualHistory`, `replaceVisibleProxyURL`, 폼 `?zp_submit=`, `REQUEST_BODY_TOO_LARGE` 이동에 적용했다.
- **당시 검증:** 합성 링크 픽스처와 nav-matrix에서 탈출 해소·다른 칸 유지. 정적/변이·홀 매트릭스·3사이트 렌더 회귀 통과, 탐지기는 기존 known-open 1건만 남았다. 같은 파일의 올바른 프레임 경로가 다른 이동 경로에는 전파되지 않았던 사례다.

## `document.location` 별칭 누출·과잉 래핑 정지 (2026-08-25) {#document-location-유출}

- **원인:** 모든 지역 수신자를 shadowed로 skip해 `n.location?.protocol` 같은 별칭이 멤브레인을 우회했다. 프록시 `http:`가 CNN 벤더 URL에 들어가 `www.ugdturner.com/xd.sjs` 502 → `turner_getGuid` 부재 → 광고 체인 중단으로 이어졌다. document/Location의 own non-configurable 속성은 프로토타입 마스킹으로 덮을 수 없다.
- **초기 수정:** `document.location` get/set/has/getOwnPropertyDescriptor를 모두 처리하고 실제 Location 성분을 가상화했다. descriptor getter 직접 호출도 우회가 되어서는 안 된다. 브랜드 확인은 페이지가 조작할 수 있는 `instanceof`/`Symbol.hasInstance` 대신 네이티브 게터로 확증한다.
- **후속 정정:** 지역 별칭을 넓게 감싸자 CNN이 간헐 정지했다. 일반 객체마다 브랜드 예외를 던지는 비용은 `[[Class]]` 1차 판정·네이티브 확증·WeakSet 캐시로 줄였지만, 진짜 정지는 `top/parent/frames/opener/contentWindow` 광고·CMP 상승 루프 래핑이었다. 최종적으로 **URL 성분만** 지역 별칭에서 감싼다. `window` 별칭은 이미 스코프 프록시이고 `document`는 실제 객체라는 차이를 반영했다.
- **당시 검증·잔여:** `turner_getGuid` 복구, 최종 축소 후 연속 두 번 정지 없음, static/cargo/nav/홀/렌더 회귀 통과. APS `apstag-iframe`은 당시 여전히 없었다. 총 프레임 갭 해석은 뒤 항목에서 정정되며 CNN 전체 해결을 뜻하지 않는다.
- **계측 주의:** 짧은 광고 초기화 창은 회귀처럼 보였다. 같은 시점끼리 비교하고 같은 taskweaver 데몬의 스위트를 겹치지 않는다. rendercheck은 `zp` 데몬을 직접 시작하지 않아 데몬 종료 뒤 결과 `?`는 제품 판정이 아니었다.

## <a id="postmessage-incumbent"></a>postMessage 래퍼가 발신 realm을 뒤집음 (2026-08-25, CNN)

- **원인:** 창 own `postMessage`를 그 창 realm 래퍼로 교체하면 자식→부모 호출의 incumbent가 부모가 되어 `e.source`와 `e.origin`이 뒤집혔다. bounce 저장소 핸드셰이크·device_id→`state/js`→`sspConfig`→APS, SafeFrame 식별이 막혔다.
- **수정·금지:** 창 자신의 `postMessage`는 네이티브로 두고 멤브레인 get 래퍼에서 targetOrigin 매핑을 유지한다. 최소 재현으로 부모 realm 래퍼와 자식 realm `Reflect.apply`의 차이를 확인했다. 호출되지 않던 `installParentSenderRedirect`·`parentPostMessageSenderQueue`, 쓰기만 하던 `parentRedirectFacades`는 보정한 적이 없었으며 `331c67e`에서 삭제했다.
- **당시 검증:** 자식 발신 메시지·올바른 오리진과 `sspConfig` 구성이 복구됐다. 주입 코드는 리라이트되지 않아 `window.location.origin`이 날 값이고, document-start에 잡은 네이티브 리스너는 가상화 전 이벤트를 본다. 부팅 신호는 보관한 함수와 현재 `window.addEventListener`의 차이로 판별했다.
- **후속 조기 래퍼:** `installEarlyPostMessage`가 자식에 남아 self-post·손자 메시지를 뒤집었다. `earlyNativeKey`로 원본을 보존하고 자식 부팅 때 `restoreNativePostMessage(w)`로 복원, 이미 `__zp_get`이 있는 창에는 설치하지 않는다. own 속성이므로 삭제하면 네이티브도 사라져 삭제 복원은 금지한다. 당시 프록시 문서 자식은 모두 네이티브였다.
- **남긴 절충:** prelude 없는 `about:blank`/`srcdoc` 자식은 targetOrigin 메시지 유실을 막으려고 래퍼를 유지했다. 그 창의 self-post·손자→자식 source 왜곡은 남아 있으며, 해당 광고 패턴의 실제 실패는 당시 관측되지 않았다.

## <a id="csp-meta-body"></a>head 없는 문서의 CSP 무효화 (2026-08-26)

- **원인:** 원본 바이트에 head가 없으면 `head→body→첫 script` 앵커가 CSP meta를 body에 넣어 브라우저가 무시했다. 당시 스트리밍 헤더도 무효라는 관측은 이후 [CSP bypass 정정](sw-integration.md#csp-스트리밍-정정)으로 철회됐다. body 안 meta 무시와 CSP 헤더 강제는 별개다.
- **수정·불변식:** 앵커 맨 앞에 `html`을 추가했다. 문서 요소 시작 직후 meta/script는 파서가 암묵적 head에 넣는다. 가드는 “head 첫 자식” 대신 “문서 요소 맨 앞, head/body보다 먼저”로 변경했다.
- **당시 검증:** 로컬 `<html><body>…` 픽스처의 격리 월드 DOM에서 CSP meta의 HEAD 소속을 확인했고 변이 가드도 발화했다.

## <a id="data-zp-이름공간"></a>`data-zp-*` 속성 표면 누락 (2026-08-26)

- **원인:** 손으로 고른 네 훅만 가려 NamedNodeMap named getter/`in`, Attr·NS API, dataset으로 타깃이 샜다. 쓰기·삭제로 스태시를 훼손하거나 `dataset.zpInternal`로 자기 노드를 검색에서 지울 수도 있었다. 2026-06 `setAttributeNS` URL 리라이트 누락과 같은 부분집합 방어였다.
- **수정·규칙:** 공통 `isZPAttrName`: **읽기는 없음, 페이지 쓰기·삭제는 no-op**. `installZPAttrNamespace(w)`에서 NS/Attr/toggle/NamedNodeMap까지 닫고 dataset 필터 Proxy, `filteredCollection` named fallback·has에도 같은 술어를 적용했다. attributes/dataset 반복 접근 동일성을 유지하고 dataset 비접두사 경로는 빠르게 통과시켰다.
- **당시 검증:** 읽기·쓰기·삭제 및 자기 은폐 프로브 정상, static/cargo/3사이트 렌더·탐지 회귀 통과. `test/browser/fingerprint/detect.js`의 `zp-namespace`는 문서를 훑어 읽기 표면과 쓰기 후 자기 은폐를 검사하며, 격리 월드 양성 대조와 정적 변이 검사를 통과했다.
- **계측 오류 정정:** `return` 뒤 줄바꿈의 ASI로 탐지기 전체가 죽어도 hits=0이었다. `return (…)`로 감싸고 양성 대조를 먼저 확인한다. 첫 후보 하나만 고르면 표식 없는 내부 script가 선택되어 축 전체가 침묵하므로 문서 순회로 바꿨다.

## <a id="비-http-스킴-세-겹"></a>비-HTTP URL의 세 파손 경로 (2026-08-26, CNN)

- **게터:** `installURLProp`가 모든 값을 HTTP 전용 `targetURL()`에 넣어 blob/data/about/mailto/tel을 읽기만 해도 예외가 났다. `nonHTTPAbsoluteURL`로 비-HTTP 절대 URL은 그대로 반환하고 상대 URL·조각은 기존 타깃 기준으로 해석한다.
- **생성·보안 경계:** `createObjectURL`의 빈 MIME 차단이 `.type` 없는 MediaSource와 일반 Blob을 차단 HTML로 바꿔 DEMUXER 오류를 냈다. 생성은 보존하고 **외부 blob을 Worker로 사용하는 시점**에 `workerBootstrapURL`에서 차단한다. 리라이터 우회 Worker 허용은 금지하며 생성자에서 던지지 않던 외형도 유지한다.
- **fetch:** blob/data를 프록시에 보내 자체 HTML을 반환했다. 타깃 계산 전에 인라인 스킴을 `Native.fetch`로 넘긴다. 당시 세그먼트 수신·비디오 오류·plain Blob fetch가 개선됐고 static/cargo/렌더/탐지·각 변이 검사가 통과했다.
- **원인 검증:** 같은 문서의 월드 교차, 생성/부착 분리로 생성 훅을 좁혔다. 원래 fetch 불가능한 MSE URL이 fetch되는 현상은 Blob 치환의 증거였다. 당시 라이브/VOD CDN 차이는 미추적이었으며 뒤 CSS 조사로 해석이 이어진다.
- **프레임 정정:** 앞선 총 프레임 부족은 대기 시간을 맞추지 않은 비교였다. 짝지은 반복 측정에서는 총수 차이가 없었다. OMID 부재는 프레임 차단이 아니라 DV360 대 2mdn 등 광고 구성 차이로 설명됐고, 기록은 3자 쿠키/식별자 부재에 따른 경매 차이로 판단했다. CNN 모든 경로가 해결됐다는 뜻은 아니다.

## <a id="style-raw-text-이스케이프"></a>style HTML 이스케이프로 레이아웃·재생 파손 (2026-08-26, CNN)

- **원인·가설 정정:** “라이브 중단/세그먼트 절반”은 부팅 지연과 관측 창 때문에 성급했던 판단이다. 실제로는 `<style>`의 `ContentType::Text`가 `>`를 `&gt;`로 바꿨고 raw text에서는 엔티티가 풀리지 않아 그리드 CSS가 폐기됐다. 플레이어가 화면 밖으로 밀려 정상 가시성 로직에 의해 paused였다.
- **수정·안전 근거:** `chunk.after`를 인접 script 경로처럼 `ContentType::Html` raw passthrough로 변경했다. 원본 `</style`은 파서가 요소를 끝내 버퍼에 들어올 수 없고, `rewrite_css`의 퍼센트 인코딩 URL은 `<`를 만들지 않는다.
- **최소 재현·추적:** `<style>.parent>div{width:10px}</style>`을 변환해 생 `>`와 파싱된 `cssRules`를 비교한다. 당시 CNN 직접/프록시를 같은 뷰포트·충분한 관측 창으로 열어 스타일 텍스트와 CSSOM, 조상/플레이어 rect, 페이지 높이, `paused`와 `currentTime`/실시간을 함께 쟀다. 폭 규칙은 텍스트에 50번 있지만 CSSOM에는 0번인 것이 원인 추적의 단서였다.

| 2026-08-26 측정 | 직접 대조군 | 프록시 수정 전 | 프록시 수정 후 |
|---|---|---|---|
| 생 `>` / `&gt;` | 671 / 0 | 0 / 671 | 671 / 0 |
| CSSOM 규칙 수 | 4,644 | 4,546 (98개 탈락) | 4,644 |
| 페이지 높이 | 7,760px | 22,590px | 7,795px |
| 라이브 플레이어 rect | (836, 403) 289×163 | (16, 5073) 1127×634 | (836, 403) 289×163 |
| `paused` / 재생 진행÷실시간 | false / 1.00 | true / — | false / 1.00 |

- **당시 검증·공백:** CSSOM 규칙·플레이어 위치·재생 진행이 대조군과 맞아졌고 zp-htmltx/cargo/static/렌더/탐지·변이 회귀 통과. 텍스트에는 있는데 CSSOM에는 없는 규칙이 파싱 실패의 단서였다. 기존 요소 수/raw/CSP/콘솔 검사는 레이아웃 붕괴를 놓쳤으며 `rendercheck.sh` 높이/뷰포트 축은 당시 제안이었다.
- **원문:** [압축 전 측정·추적 기록 (`7f49a9d0f23990e46690a183fdebb04962727b19`)](https://github.com/gosuda/zeroproxy/blob/7f49a9d0f23990e46690a183fdebb04962727b19/.ai/trap-notebook/rewriter.md#style-raw-text-이스케이프). 위 수치는 당시 관측이며 현재 빌드의 재측정이 아니다.

## <a id="모듈-url-두-벌"></a>모듈 URL 분열: GitHub 원인 가설 철회와 후속 수정 (2026-09-04)

- **원인:** 이후 레이아웃 검사가 GitHub의 클라이언트 React 에러 페이지를 발견했다. Rust 정적 import는 `?u=…&kind=module`, JS 동적 경로는 순서와 `ref`가 달랐고 `withCurrentRef`는 시간에 따라 ref도 갱신했다. URL 정체성 때문에 같은 모듈이 두 벌 로드됐다. 당시 React #321·컨텍스트 부재를 조사 신호로 삼았지만, 모든 `Illegal invocation`을 브랜드 체크 노이즈로 취급한 판단은 아래 후속 receiver 조사로 정정됐다.
- **수정·경계:** module URL을 Rust와 바이트 단위로 동일하게 정규화하고 ref를 제거했다. classic은 CF 챌린지 타이밍 때문에 ref를 유지한다. 당시 중복 모듈 소멸은 확인됐지만 CF 해결을 입증한 것은 아니다.
- **당시 정정:** 한 번 정상 렌더 후 같은 절차 3회 반복에서 3/3 모두 에러 페이지였다. **모듈 분열은 수정된 실제 결함이지만 GitHub 에러 페이지 원인이라는 결론은 철회됐다.** 한 번 성공으로 닫지 않고 반복 결과를 보고한다.
- **최소 추적:** 200/마케팅 title과 실제 본문·`react-app.loaded` 안의 ErrorPage를 대조한다. `debugger-arm --strategy exceptions`로 콘솔에 나타나지 않는 caught 예외까지 수집하고, 의도적인 `isNativeLocation` 브랜드 체크와 앱 스택의 실패를 구별한다. 네트워크 테이프에서 같은 upstream 모듈의 실제 proxy URL을 묶어 쿼리 순서·`ref`로 갈라지는지 비교한다. 첫 React #321 직전 예외를 원본 자산 위치로 추적하는 단계가 이후 receiver 원인을 밝혔다.

| 당시 관측 | 결과 | 해석 |
|---|---|---|
| 같은 자산의 중복 모듈 URL | 15건 → 0건; 수정 후 module URL의 `ref` 0건 | 모듈 identity 결함 수정 |
| 수정 직후 정상 렌더 1회 | 본문 5,675자 / 높이 10,778; 직접 6,045자 / 10,996 | 단발 성공, 사이트 회복 판정 불가 |
| 같은 절차 후속 3회 | 3/3 ErrorPage; 본문 1,085자 / 높이 1,718 | 모듈 수정만으로 GitHub 미해결 |

- **후속·현재 구분:** 이후 [`5f951c6`](https://github.com/gosuda/zeroproxy/commit/5f951c6)의 [window receiver 수정 기록](#window-메서드-바인딩-목록)은 `globalThis.structuredClone` 실패를 특정하고 GitHub 3회 회복을 보고한다. 따라서 위 “미해결”은 모듈 수정 직후의 역사다. 이를 포함한 rebase의 [cef5e7d CI](https://github.com/gosuda/zeroproxy/actions/runs/34201550912)에서 모듈 singleton과 native receiver의 실제 Chromium 회귀가 통과했다. GitHub 실사이트를 다시 측정한 결과는 아니다.
- **원문:** [압축 전 측정·가설 철회 기록 (`7f49a9d0f23990e46690a183fdebb04962727b19`)](https://github.com/gosuda/zeroproxy/blob/7f49a9d0f23990e46690a183fdebb04962727b19/.ai/trap-notebook/rewriter.md#모듈-url-두-벌). 이후 receiver 결론과 혼합해 모듈 정규화를 GitHub 회복 원인으로 기록하지 않는다.

## <a id="ci-write-reference"></a>WASM이 대입 참조를 읽기 호출로 변환 (2026-09-06)

- **원인·증거:** [CI run 34020783071](https://github.com/gosuda/zeroproxy/actions/runs/34020783071)의 실제 page WASM에서 복합 대입·구조분해 target이 `__zp_get(...)` 호출로 바뀌어 문법 오류가 났다. OXC assignment target walker가 static member를 일반 read visitor로 넘겼다. Rust unit 통과만으로 출력 JS 의미를 보장할 수 없었다.
- **수정·불변식:** private `visit_simple_assignment_target`에서 receiver만 read 방문한다. 민감 target은 receiver를 한 번 저장하는 accessor reference로 만들고 원래 연산자가 평가 순서·단락·await/yield·prefix/postfix·ToNumeric/BigInt를 수행하게 한다. RHS를 먼저 받는 `__zp_assign` 방식은 순서를 바꾸므로 배제했다. 단순 대입의 allocation-free setter는 유지하고 중첩 marker offset·ASI도 처리했다.
- **검증 상태:** `test/js/rewriter.test.js`의 실제 prebuilt WASM 검사에 기존 실패와 의미 회귀를 추가했다. 로컬 컴파일은 생략했다. 후속 [CI 34021763068](https://github.com/gosuda/zeroproxy/actions/runs/34021763068)에서 WASM 12/12 통과했으나 전체 E1/CI는 실패했다.

## <a id="absent-url-attribute"></a>없는 URL 속성을 빈 문자열로 마스킹 (2026-09-06)

- **원인:** 같은 CI E1에서 template link의 absent href가 null 대신 빈 문자열이었다. native null을 문자열 전용 `deproxyURL`에 넘겼고, 스태시 우선 처리로 삭제 후 과거 URL도 재노출될 수 있었다. 첫 assertion은 뒤 관측까지 가렸다.
- **수정·규칙:** native raw attribute를 한 번 읽고 null/빈 문자열을 metadata보다 먼저 반환한다. 기대값을 빈 문자열로 낮추지 않는다. E1을 독립 subtest로 나눠 absent/empty/removed/설정 후 삭제 전이를 검사한다.
- **증거·상태:** `test/e2e/proxy.test.js`에 template 및 link href/img srcset/script src 전이와 `getAttributeNS(null, ...)`·`hasAttribute` 관측을 포함했다. 후속 [CI 34021421554](https://github.com/gosuda/zeroproxy/actions/runs/34021421554)에서 DOM absence 회귀는 통과했지만 전체 E1 완료는 아니다.

## <a id="runtime-entrypoints"></a>동작 구현을 덮는 스텁과 Attr 진입 누락 (2026-09-06)
- **원인:** `installBlockers`가 실제 WebSocketStream 생성자를 스텁으로 덮었다. NamedNodeMap/Attr 노드 쓰기는 `setAttribute` URL 정책을 우회했다.
- **수정:** 실제 stream 생성자·opened/closed/close 수명을 유지하고 자식 realm에도 전달한다. Attr는 기존 setter 정책을 먼저 적용한 뒤 원래 노드 identity와 교체 반환값을 보존해 붙인다.
- **검증:** `test/e2e/proxy.test.js`의 stream echo/close 및 Attr iframe 탐색·노드 교체 회귀. 로컬 브라우저 실행 없이 CI로 검증한다.
- **후속 경계:** Window location descriptor는 non-configurable shadow accessor로 보존한다. 부모 Location은 소유 realm으로 전달하되 다른 가상 origin의 읽기는 거절한다. iframe/Attr getter는 타깃 URL, opener는 원래 null/값 의미를 유지한다.

## <a id="destructive-navigation-probes"></a>탐색 검사가 후속 폼 검사를 오염 (2026-09-06)
- **원인:** srcdoc 코드가 실제로 허용된 프록시 내부 top 탐색을 시작했는데, 검사는 원문서 불변을 기대했다. 이후 폼 실패도 같은 페이지에서 연쇄 발생했다.
- **수정:** 파괴적 탐색은 별도 context의 타깃 스크립트로 실행하고 가상 목적지·프록시 경유를 검증한다. 폼 종류마다 정상 문서에서 시작하며 native requestSubmit 검증·submitter와 CRLF 직렬화 의미를 보존한다.
- **금지:** 탐색 자체를 차단하거나 오염된 검사 기대값을 낮추어 통과시키지 않는다. 실행 결과는 커밋별 CI로 확인한다.
- **문법 구별:** Range의 contextual fragment는 삽입 시 스크립트 실행이 가능하다. blanket 차단 대신 타깃 스크립트가 가상 URL을 보고 프록시로만 통신하는지 검사한다. DOMParser/innerHTML의 inert 의미와 혼동하지 않는다.
- **컴파일 realm:** 부모가 about:blank를 보호할 때 eval/Function도 자식의 native 실행기를 감싸야 한다. 부모 실행기를 복사하면 이후 srcdoc 프렐류드가 그것을 캡처해 자식의 전역·리스너까지 부모에 설치한다. postMessage 메서드 새로고침 가설은 수신을 회복하지 못해 되돌렸다.
- **검증:** [a484e7b CI](https://github.com/gosuda/zeroproxy/actions/runs/34025734224)에서 전체 E2E 109/109 통과. srcdoc 수신·부모 탐색·목적지 렌더, 다른 가상 origin의 Location 읽기 거절, 폼 3종도 포함한다.

## <a id="window-메서드-바인딩-목록"></a>`globalThis.structuredClone(x)` 한 줄이 GitHub 홈을 통째로 죽였다 (2026-09-04)

**기록 범위:** 아래 측정·통과 보고는 [`5f951c6`](https://github.com/gosuda/zeroproxy/commit/5f951c6)에 포함된 후속 receiver 수정의 역사적 근거다. 2026-09-08 rebase에서 receiver 규칙과 shadow `scopeTarget`을 함께 보존했으며, [cef5e7d CI](https://github.com/gosuda/zeroproxy/actions/runs/34201550912)의 native receiver·WS 수명·모듈 singleton 회귀가 통과했다. 아래 실사이트 측정을 rebase 이후 재측정으로 읽지 않는다.

스코프 프록시가 **손수 고른 목록**(`WINDOW_BOUND_METHODS`)에 든 window 메서드만
`root` 에 바인딩했다. 목록에 없는 것은 그대로 나가므로, 페이지가

```js
globalThis.structuredClone(e)
```

처럼 부르면 수신자가 **프록시**가 되어 네이티브 브랜드 체크가 실패한다 —
`TypeError: Illegal invocation`.

실측으로 뚫려 있던 것: `structuredClone` / 마이크로태스크 큐 API / `reportError`
/ `getSelection`. 목록에 든 `matchMedia`·`getComputedStyle`·`atob`·`setTimeout`·
`requestAnimationFrame`·`scrollTo` 등은 정상이었다 — **통과/실패가 목록과 정확히
일치**했다.

### 어디까지 갔나

GitHub 홈이 자기 `ErrorPage` 를 그리고 있었다. 문서는 **200**, HTML 에 마케팅
내용이 다 있고, `<title>` 도 그대로다. `raw=0 / csp=0 / err=0` 이라 기존 회귀
축이 전부 통과했다(그래서 이 세션에서 "github 정상" 을 세 번 잘못 보고했다).

콘솔에는 예외가 없다 — React 에러 경계가 삼킨다. `debugger-arm --strategy
exceptions` 로만 보인다:

```
501건 중  138  Minified React error #321      ← 훅 규칙 위반(연쇄)
          112  TypeError: Illegal invocation
           24  컨텍스트가 undefined 계열
```

`#321` 첫 발생 **바로 직전**(index 82)이 진짜 원인이었다:

```
TypeError: Illegal invocation
  s  @ sg-2a07a18513145f3b.js:2:10964     ← GitHub 코드, 우리 프렐류드를 안 지난다
  r  @ sg-…
  aj @ landing-pages-…                     ← 컴포넌트
  l5 @ react-lib-…                         ← 렌더 중
```

원본 자산을 직접 받아(`curl`) 그 함수를 보니 한 줄이었다:

```js
let t = "function" == typeof globalThis.structuredClone
      ? globalThis.structuredClone(e) : JSON.parse(JSON.stringify(e));
```

### 함정: `Illegal invocation` 112건 중 대부분은 **정상**이다

`isNativeLocation` 이 브랜드 체크로 네이티브 게터를 일부러 불러 보고 `catch`
한다. `debugger-arm` 은 **잡힌 예외까지** 보여 주므로 이게 노이즈로 쌓인다
(`href`/`origin`/`host` 는 평범한 객체에도 흔한 이름이라 자주 발화한다).
한동안 이걸 범인으로 쫓았다 — **잡힌 예외와 안 잡힌 예외를 먼저 갈라야 한다.**

### 고침 — 목록이 아니라 규칙

**`prototype` 이 없는 네이티브 함수만** 바인딩한다.

- 네이티브 메서드(`structuredClone`, `matchMedia`, `getSelection` …)는 `prototype` 이 없다
- 생성자/클래스(`URL`, `Promise`, `Worker` …)는 `prototype` 이 있다 — 바인딩하면 `new` 가 깨진다
- 페이지가 window 에 얹은 자기 함수는 `[native code]` 가 아니므로 건드리지 않는다
  (바인딩하면 `obj.f = window.f; obj.f()` 의 `this` 가 바뀐다)

### 실측 (3회 반복)

| | 고치기 전 | 고친 뒤 | 대조군 |
|---|---|---|---|
| `h1` | ErrorLooks like something went wrong! | The future of building happens together | 동일 |
| 본문 | 1,085자 | **6,045자** | 6,045자 |
| 높이 | 1,718 | **10,996** | 10,996 |
| 스코프 프록시 호출 실패 | 4/13 | **0/13** | — |

`rendercheck` 4개 사이트 전부 OK(github height 100%, els 1788/1791).
static 160, cargo workspace 전부 통과. 변이 3/3.

### 교훈 — 이 저장소에서 **네 번째** 같은 사고다

srcset 후보 분리, HTML 엔티티 표, `data-zp-*` 속성 표면, 그리고 이번 window
메서드 바인딩. 전부 "손으로 고른 목록" 이 시간이 지나며 뚫렸다. **명세가 열려
있는 표면(전역 메서드, 속성 이름, 엔티티)은 목록으로 따라갈 수 없다.**

그리고 `<title>` 은 페이지가 살아 있다는 증거가 못 된다 — SPA 는 타이틀을
유지한 채 본문만 에러 화면으로 갈아치운다.
## <a id="css-정체-되읽기"></a>CSS 는 바꿔 쓰고 되돌리지 않아 프록시 정체가 16곳으로 샜다 (2026-09-10)

`CSS_URL_PROPS`(손으로 고른 19개 프로퍼티)를 규칙으로 바꾸려고 들어갔다가 **같은
함수 안의 더 큰 결함**을 만났다. 두 개가 얽혀 있어서 따로 고칠 수 없다.

### ① 읽기 누출 — 이게 본체다

우리는 CSS 안의 `url()` 을 프록시 URL 로 **바꿔 쓴다**. 그런데 되돌려 주는 곳이
직렬화 경로(`outerHTML` / `cloneNode` / `XMLSerializer` / `<style>.textContent`)
뿐이었다. **직접 프로퍼티·속성 읽기는 통째로 빠져 있었다** — 2026-08-22 에
`<style>` 텍스트만 고치고 나머지를 안 본 자리다.

실측(프록시 위 example.com, 전수 훑기): **16개 표면이 샜다.**

```
style.backgroundImage   style.cssText        style.getPropertyValue
style.item+getPV        style[0]             getAttribute
getAttributeNS          getAttributeNode     attributes.style
attributes[i]           getNamedItem         getComputedStyle × 2
CSSRule.cssText         CSSRule.style.*      (인라인 IDL 세터 전부)
```

새어 나온 값:

```js
el.style.backgroundImage = 'url("https://cdn.example.org/pic.png")';
el.style.backgroundImage
// → url("http://proxy.localhost:18080/zp/api/fetch?url=https%3A%2F%2F…&tab=…")
```

페이지가 **자기가 쓴 값을 다시 읽는 것만으로** 프록시 오리진 · 내부 API 경로 ·
탭 토큰을 전부 얻는다. `img.src` 는 가상 URL 로 되돌려 주는데 CSS 만 안 했다.

고침: `deproxyURL(v, {scan:true})` 를 읽기 경계마다 태운다. `Attr.prototype.value`
와 `getAttributeNS` 는 이미 `getAttribute` 로 위임하므로 **거기 한 줄이
getAttributeNode / attributes[i] / getNamedItem 까지 함께 덮는다.**

### ② 쓰기 우회 — `style` 접근자는 HTMLElement 에만 있는 게 아니다

컨테인먼트 프록시를 `HTMLElement.prototype.style` 에만 걸어 뒀다. 실측으로 네
경로가 url() 을 **원본 그대로** 실었다: `SVGElement` / `MathMLElement` /
`CSSStyleRule.style` / `CSSKeyframeRule.style`.

고침: 인터페이스를 **훑어서** `style` 접근자를 가진 프로토타입을 전부 감싼다
(`containEveryStyleAccessor`). 대문자로 시작하는 전역만 본다 — 소문자까지 읽으면
게터 부작용을 건드린다. 이건 목록이 아니라 명명 규칙이다.

★①이 없는 채로 ②만 고치면 **누출이 늘어난다** — 새로 감싼 경로가 이제 프록시
URL 을 저장하는데 되돌리는 곳이 없기 때문이다. 둘은 한 커밋이어야 한다.

### `CSS_URL_PROPS` 는 애초에 죽은 코드였다

19개 목록을 `CSSStyleDeclaration.prototype` 에 걸고 있었는데, 이 엔진은 CSS
프로퍼티를 **인스턴스의 own data property** 로 노출한다(실측: prototype 의 own
이름은 10개뿐, 전부 메서드). 즉 그 루프는 **조용한 no-op** 였고, 실제로 잡아 준
것은 언제나 컨테인먼트 프록시였다. 목록을 지우는 것이 곧 고침이었다.

### 판정 기준을 세 번 틀렸다 — 이게 이 항목의 진짜 교훈

1. **메인 월드에서 되읽어 판정했다.** `img.src` 까지 "새는" 것으로 나왔다.
   멤브레인은 메인 월드에 **가상 URL 을 보여 주는 게 정상**이다. 저장값은
   `exec-js --world isolated` 로 봐야 한다.
2. **마커 호스트가 남아 있는지로 판정했다.** 프록시 경로가 대상 URL 을
   percent-encoding 으로 담으므로 `evil.example` 은 **그대로 남는다**
   (`.` 과 영문자는 인코딩되지 않는다). 전부 LEAK 로 보였다. 올바른 기준은
   "프록시 오리진이 붙었나" 다.
3. **상대 URL 로 판별하려 했다.** `cssProxyURL` 은 `^https?://` 만 다루므로
   상대 URL 은 설계상 재작성 대상이 아니다 — 판별에 못 쓴다.

### 탈옥은 아니다 (측정으로 확인)

공개 DNS 에 없는 호스트로 재 보니 새는 경로도 **502**(프록시 응답)였다.
`ERR_NAME_NOT_RESOLVED` 가 아니다 — SW 가 원시 절대 URL 도 잡는다. 즉 ②는
네트워크 탈출이 아니라 정확성·일관성 결함이고, ①이 보안 결함이다.

### 남긴 것 — `attributeStyleMap` (CSS Typed OM)

`el.attributeStyleMap.set('background-image', 'url(…)')` 는 여전히 재작성을
지나지 않는다(실측). 일부러 남겼다: 쓰기만 훅하면 `StylePropertyMap.get()` 이
돌려주는 `CSSStyleValue` 에서 프록시 URL 이 그대로 보여 **①을 새로 만든다.**
지금은 쓰기·읽기가 모두 원본이라 페이지가 쓴 값과 읽는 값이 일치하고, 요청은
SW 가 잡는다. 고치려면 `StylePropertyMap` 의 읽기·쓰기를 같이 해야 한다.

### 실측

| | 고치기 전 | 고친 뒤 |
|---|---|---|
| 누출 읽기 표면 | 16 | **0** |
| 컨테인먼트 우회 쓰기 경로 | 5 | **1** (Typed OM, 의도적) |
| 탐지기 `css-identity` (naver/wikipedia/github) | — | 0 / 0 / 0 |

탐지기 양성 대조: `/zp/assets/` 형태(=`deproxyURL` 이 되돌릴 수 없는 모양)를
격리 월드에서 심으면 8개 표면이 즉시 잡힌다. 변이 11/11.

### 곁가지 — 훅이 자기 소스를 노출한다

`define()` 으로 건 함수는 `toString` 이 가려지는데, `Object.defineProperty` 로
직접 건 **접근자**는 안 가려진다. 실측:

```js
String(Object.getOwnPropertyDescriptor(HTMLElement.prototype,'style').get)
// → "get(){return Bi(c.get.call(this))}"   ← 우리 코드가 그대로 보인다
```

`style` / `cssText` / `<style>.textContent` 세터가 전부 이 상태다. 이번 변경이
만든 것이 아니라 전부터 그랬고, 별도 항목으로 다뤄야 한다.
## <a id="훅-소스-노출"></a>훅이 자기 소스를 보여 줬고, 그걸 고치러 가다 내가 만든 회귀를 먼저 찾았다 (2026-09-10)

`Function.prototype.toString` 은 이미 가려져 있다. 다만 그 마스킹은
`define` / `defineAccessor` 를 **지날 때만** 등록된다. 날 `Object.defineProperty`
로 접근자를 심으면 등록이 안 되고, 그러면

```js
String(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style').get)
// → "get(){return eo(s.get.call(this))}"          ← 우리 코드가 그대로
String(Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src').get)
// → "...i.getAttribute.call(this,\"data-zp-target-url\")..."  ← 내부 속성 이름까지
```

한 줄이면 잡히는 지문이고, 두 번째 것은 우리 내부 속성 이름을 **알려 준다**.

### ★먼저 나온 것: 내가 만든 회귀 (같은 날 앞 커밋)

전수 스윕을 돌리자 `SVGViewElement.style` / `Option.style` / `Image.style` … 이
**own 프로퍼티**로 잡혔다. 진짜 브라우저에는 없다. 원인은 앞 커밋(`9a02be9`)의

```js
const sd = propertyDescriptor(proto, 'style');   // ← 이 헬퍼는 체인을 탄다
```

`propertyDescriptor` 는 프로토타입 체인을 올라가며 찾는다. 그래서 `SVGElement`
에서 상속받은 `style` 을 서브클래스마다 발견하고, `defineProperty` 로 **거기에
새로 own 을 만들었다.**

| own `style` 을 가진 프로토타입 | |
|---|---|
| 대조군(직접 로드) | **13** |
| 프록시 (회귀 상태) | **157** |

고치려던 지문(soure 노출)보다 훨씬 큰 지문을 만든 셈이다. `Object.
getOwnPropertyDescriptor`(own 전용)로 바꾸니 13 으로 돌아왔다. 네이티브가 선언한
13개만 감싸도 서브클래스는 상속으로 전부 덮인다.

**규칙**: "X 를 가진 인터페이스를 전부 감싼다" 를 구현할 때는 **own 디스크립터**를
봐야 한다. 체인을 타는 헬퍼를 쓰면 감싸는 게 아니라 **새로 만든다.**

### 노출 범위 (실측)

| | 소스가 보이는 함수 |
|---|---|
| 처음 (회귀 포함) | 368 |
| own 회귀를 고친 뒤 | 74 |
| 마스킹을 고친 뒤 | **1** (taskweaver 자신, 대조군에도 있음) |

74건의 출처는 날 `Object.defineProperty` 31곳, 날 `Object.defineProperties`
3곳, 대체 클래스의 `Object.assign` 3곳, 프록시 트랩이 만드는 바인딩 메서드였다.

### 왜 부팅 스윕이 아니라 설치 지점인가

"설치 후 한 번 훑어서 비네이티브를 전부 가린다" 를 재 봤다. 창마다 **5~7ms**
(인터페이스 955개, 함수 9,431개). 프레임이 25개면 100ms 를 넘는다. 그래서
설치 지점에서 가린다: `defineMasked` / `definePropertiesMasked` / `assignMasked`.

`defineAccessor` 로 통째로 바꾸지 않은 이유는 그것이 `configurable:false` 를
강제하기 때문이다 — `window.origin` 처럼 일부러 `true` 로 둔 자리가 있다.
새 헬퍼는 디스크립터를 **그대로** 넘기고 마스킹만 더한다.

### 가드 세 겹, 그리고 각각이 놓친 것

1. 정적 스캐너 — 날 `defineProperty`/`defineProperties` 접근자를 금지한다.
   **처음 판은 주석 뒤의 접근자를 놓쳤다.**
   ```js
   Object.defineProperty(ZPWebSocket.prototype, 'bufferedAmount', {
     enumerable: true, // Web IDL attributes are enumerable; …
     get() { … },      // ← 앞 토큰이 `,` 가 아니라 주석 텍스트가 된다
   ```
   줄을 이어 붙이기 전에 `//` 를 지워야 한다. 또 창을 **다음 define 호출 앞에서**
   끊어야 한다 — 안 끊으면 앞 자리가 뒤 자리의 `get` 을 빌려 거짓 양성이 난다.
2. 헬퍼 동작 테스트 — 스캐너는 "헬퍼를 **부르는가**" 만 본다. 헬퍼가 마스킹을
   그만두는 변이는 안 물었다(실측). 그래서 헬퍼 셋을 뜯어 실행하고 실제로
   toStringMap 에 등록되는지 본다.
3. 브라우저 탐지기 축 — 프로토타입을 통째로 훑는다.

변이 6/6.

### 탐지기가 페이지 코드를 우리 것으로 오인했다

첫 실행에서 naver 27건. 전부 **naver 자신의 대문자 전역**(`Agent`, `Flash` …)
이었다. 대문자로 시작하는 전역이라고 다 WebIDL 인터페이스가 아니다.

관문: **생성자 자신이 네이티브인 것만 본다**(`Function.prototype.toString.call
(iface)` 가 `[native code]`). 우리 대체 클래스는 `define` 이 이미 가리므로
관문을 통과한다. 고친 뒤 naver 0 / wikipedia 0 / github 2.

github 2건은 **GitHub 자신이** `Node.insertBefore` / `removeChild` 를 덮어쓴
것이다(소스에 `BROWSER_EXTENSION`). 우리 것이 아니고, 축이 그걸 보고하는 것은
정상이다 — 이제 0 이 아닌 건수는 "페이지가 네이티브를 갈아끼웠다" 는 뜻이다.

### 남은 한계 — 리라이트된 페이지 코드는 자기 소스에 `__zp_get` 이 보인다

naver 의 `Agent.dump` 를 읽으면 `__zp_get(globalThis,"document").write(…)` 가
그대로 나온다. AST 리라이트의 본질적 결과이고 이 커밋의 범위가 아니다.
`new Function` 본문은 `dynamicSource` 로 이미 원본을 돌려주지만, 정적으로
리라이트된 함수는 복구할 원본이 없다. 별도 항목으로 다뤄야 한다.
## <a id="리라이트-소스-노출"></a>페이지가 자기 함수를 문자열로 만들면 우리 리라이트가 보였다 (2026-09-10)

전역 **이름** 노출은 예전에 스크러버로 막았다([LOG.md](LOG.md) 2026-08-xx).
그런데 함수 **소스**는 아무도 안 보고 있었다:

```js
String(window.openURL)
// → function openURL(a){__zp_call(__zp_get(globalThis,"window"),"open",[a,"_blank"])}
```

한 줄이면 잡힌다. 실측(페이지가 실제로 도달하는 자리만 훑어서):

| | 검사한 함수 | 노출 |
|---|---|---|
| naver | 8,490 | **17** |
| github | 8,655 | **89** |

### 고침 — 되돌려서 돌려준다

`Function.prototype.toString` 은 이미 훅이 있다(네이티브 마스킹용). 우리가 가린
훅이 아니면 그건 페이지 자신의 코드이므로, 리라이트 흔적을 되돌려서 돌려준다.

**목적은 완벽한 원본 복구가 아니라 `__zp_` 라는 표식을 없애는 것이다.**
되돌릴 수 없는 모양은 손대지 않는다 — 망친 소스가 더 큰 티다.

| 리라이트된 모양 | 되돌린 모양 |
|---|---|
| `__zp_get(globalThis,"document")` | `document` |
| `__zp_get(o,"k")` / `__zp_get(o,"a-b")` | `o.k` / `o["a-b"]` |
| `__zp_set(o,"k",v)` | `o.k=v` |
| `__zp_call(o,"f",[a,b])` | `o.f(a,b)` |
| `__zp_assign(o,"k","+=",v)` | `o.k+=v` |
| `__zp_update(o,"k","++",true/false)` | `++o.k` / `o.k++` |
| `for(let __zp_lc_N=0;__zp_lc_N++<10000000;)` | `for(;;)` |
| `let __zp_lc_N=0;do…while(__zp_lc_N++<10000000)` | `do…while(true)` |
| `return __ZP_EXEC_EVENT(this,event,"<본문>")` | `<본문>` |

### 감옥은 유지된다

되돌린 소스를 페이지가 다시 컴파일해도(`new Function(String(fn))`) 그 경로는
`compileNested` 의 `with(scope)` 를 지나므로 자유 식별자가 스코프 프록시로
해석된다. **컨테인먼트를 지고 있는 것은 리라이트가 아니라 스코프다.**

### 세 번 틀렸다

1. **괄호.** `__zp_get(a||b,"k")` 를 `a||b.k` 로 되돌리면 **뜻이 바뀐다.**
   단순 식별자·멤버 체인이 아니면 괄호를 씌운다.
2. **`window` 를 생략 대상에 넣었다.** 리라이터가 합성해 넣는 기본형은
   `globalThis` 하나뿐인데(리라이터 소스 확인) `window`/`self` 까지 넣었더니
   페이지가 직접 쓴 `window.open(x)` 이 `open(x)` 으로 줄었다 — 원본과 다른
   텍스트가 된다.
3. **템플릿 리터럴을 통째로 건너뛰었다.** 안쪽 `${…}` 는 **코드**다. github
   에서 되돌리기를 넣은 뒤 남은 8건이 전부 여기였다
   (`` `${__zp_get(globalThis,"window").innerWidth}px` `` ). 리터럴 텍스트는
   그대로 두고 치환식만 재귀로 처리한다.

### 실측

| | 고치기 전 | 고친 뒤 |
|---|---|---|
| naver | 17 | **0** |
| github | 89 | **0** |

의미 보존 13/13(리라이터 헬퍼를 실제로 정의해 두고 되돌리기 전후의 **값**을
비교), 파싱 깨짐 0, 변이 7/7.

### 변이가 안 물어서 알게 된 것 — 테스트 케이스에 변별력이 없었다

"문자열 리터럴 안은 건드리지 않는다" 가드를 `'"__zp_get(x)"'` 로 썼다. 문자열
처리를 **꺼도** 통과했다 — 인자가 하나뿐이라 어차피 되돌리기 대상이 아니었기
때문이다. `'__zp_get(o,"k")'` 처럼 **되돌릴 수 있는 모양**을 넣어야 변별력이
생긴다. 이스케이프(`\"`)를 쓴 판도 마찬가지로 무력했다(스캐너가 포기한다).

### 남은 것

`__zp_module` / `__zp_import` 는 되돌리지 않는다. 정적 import 를 대신하는
호출이라 원본 문법(`import … from …`)으로 되돌리면 **문법이 안 맞는 자리**가
생긴다(식 위치에 문장을 넣게 된다). 실사이트 측정에서는 이 둘이 페이지가
도달하는 함수 소스에 나타나지 않았다.
## <a id="typed-om"></a>CSS Typed OM 은 style 훅이 전혀 안 닿는 별도 인터페이스였다 (2026-09-10)

`attributeStyleMap` 은 앞선 CSS 작업에서 **유일하게 남긴 컨테인먼트 우회**였다.
당시 판단은 "쓰기만 훅하면 읽기에서 새므로 같이 가야 한다" 였고, 그건 맞았다.
그런데 다시 재 보니 **읽기 누출은 그때 이미 살아 있었다.**

### 실측 — 읽기 누출 두 개가 이미 있었다

훅이 걸린 경로(`style.cssText`)로 쓰고 Typed OM 으로 읽으면:

```
attributeStyleMap.get('background-image')   → PROXY-URL
computedStyleMap().get('background-image')  → PROXY-URL
```

앞서 고친 16개 읽기 표면과 **같은 부류인데 다른 인터페이스**라 안 걸렸다.
`getComputedStyle` 은 고쳤는데 `computedStyleMap()` 은 그 옆에 그대로 있었다.

### 인터페이스 모양 (실측)

| | own 멤버 |
|---|---|
| `StylePropertyMapReadOnly.prototype` | `size, get, getAll, has, entries, forEach, keys, values` |
| `StylePropertyMap.prototype` | `append, clear, delete, set` |

`StylePropertyMap` 이 RO 를 **상속**하고 `computedStyleMap()` 도 RO 인스턴스다.
그래서 **RO 한 곳만 훅하면 인라인 스타일맵과 계산 스타일맵이 함께 덮인다.**

### 되돌리기가 가능한 이유 (전부 실측)

- `CSSStyleValue.parse(prop, String(v))` 왕복이 **정확하다**.
- 네이티브도 호출마다 **새 객체**를 준다(`get(x) !== get(x)`). 우리가 새로 만든
  값을 돌려줘도 동일성 지문이 안 생긴다. 다만 **바뀐 게 없으면 원래 객체를
  그대로** 돌려준다 — 쓸데없이 새 객체를 만들 이유가 없다.
- maplike 는 `@@iterator === entries` 다. 훅 뒤에도 같은 함수를 줘야 한다.
- `values()` 는 키를 안 주므로 되돌릴 때 프로퍼티 이름을 알 수 없다 — 명세대로
  `entries()` 에서 값만 떼어 낸다.

### 실측 결과

| | 전 | 후 |
|---|---|---|
| Typed OM 읽기 누출 | 2 | **0** |
| CSS 컨테인먼트 우회(전체 15경로) | 1 | **0** |

쓰기는 문자열·`CSSStyleValue`·`append` 전부 컨테인된다.

### 프로브가 자기 발을 밟았다

`append('mask-image', …)` 가 네이티브에서 거절된다 — "Property does not support
multiple value". try/catch 없이 한 스크립트에 이어 붙였더니 **그 예외가 뒤따르는
두 검사를 통째로 건너뛰게 했고**, 결과가 `MISSING` 으로 나와 "쓰기가 안 걸린다"
로 잘못 읽었다. 여러 경로를 한 번에 재는 프로브는 **경로마다 try/catch** 를
둔다. (`append` 는 `background-image` 처럼 다중값 프로퍼티에서만 쓴다.)

### 가드

가짜 Typed OM(RO/SM/CSSStyleValue)을 만들어 규칙을 그대로 실행한다. 변이 9/9.
그중 하나는 **`installTypedOM(w);` 호출 지점을 지우는 것**이었는데 처음엔 안
물었다 — 테스트가 함수만 뜯어 실행하고 설치 시퀀스를 안 봤기 때문이다.
이 저장소에서 같은 부류를 세 번째로 밟았다: **함수를 실행하는 테스트는 그
함수가 실제로 불리는지도 같이 단언해야 한다.**
## <a id="프로토타입-모양-축"></a>프로토타입 모양 축을 만들자마자 6개가 걸렸다 (2026-09-10)

같은 날 내가 만든 회귀(own `style` 13 → 157)를 **기존 축이 전부 통과**시켰다.
raw/csp/err/height 어느 것도 프로토타입 모양을 안 본다. 그래서 상설 축으로
만들었다: `test/browser/protoshape.sh`.

### 만들면서 같은 실수를 또 했다

회귀를 확인할 때 나는 **손으로 고른 24개 인터페이스**로 쟀고 차이가 1개
(`Document`)라고 보고했다. 전수로 훑는 축을 만들자 **6개**가 나왔다. 내가 고른
목록에 `RTCPeerConnection`·`RTCDataChannel`·`WebTransport`·`SharedWorker`·
`HTMLStyleElement` 가 없었을 뿐이다.

**측정 도구에도 같은 규칙이 적용된다 — 열린 표면은 목록으로 따라갈 수 없다.**

### 걸린 것 (example.com, 인터페이스 955개 중)

두 부류다.

**(a) 섀도잉 — 조상에 있는 멤버를 서브클래스에 새로 만든다**

| 인터페이스 | 프록시에만 |
|---|---|
| `Document` | `baseURI`, `origin` |
| `HTMLStyleElement` | `innerHTML`, `innerText`, `textContent` |

브라우저는 `baseURI` 를 `Node.prototype` 에, `innerHTML`/`textContent` 를
`Element`/`Node` 에 둔다. `origin` 은 `Document.prototype` 에 아예 없다.
우리가 `<style>` 텍스트를 훅하려고 `HTMLStyleElement.prototype` 에 심은 것이
그대로 모양 차이가 됐다.

**(b) 대체 클래스의 얇은 프로토타입 — 지문이자 호환성 버그**

| 인터페이스 | 대조군에만 (개수) |
|---|---|
| `RTCPeerConnection` | 45 |
| `RTCDataChannel` | 20 |
| `WebTransport` | 9 |
| `SharedWorker` | `onerror`, `port` |

`XMLHttpRequest.prototype` 16 vs 27 과 **정확히 같은 부류**다(그건 2026-08 에
프로토타입 접근자로 옮겨 닫혔고, 이번 측정에서 대조군과 일치 확인). 라이브러리가
`'port' in SharedWorker.prototype` 이나 `RTCPeerConnection.prototype.addTrack`
패치를 하면 조용히 깨진다.

### 축 자체의 설계

- 검사 대상을 손으로 고르지 않는다. 대문자로 시작하고 **생성자 자신이 네이티브**
  인 전역을 전수로 훑는다(`Function.prototype.toString` 이 `[native code]`).
  페이지가 만든 대문자 생성자(naver 의 `Agent`/`Flash`)가 그 관문에서 걸러진다.
  우리 대체 클래스는 `define` 이 toString 을 가려 두므로 관문을 통과한다 —
  **의도한 대로 검사 대상이 된다.**
- 대조군과 쌍으로 잰다. 프록시 단독 수치는 의미가 없다.
- 판정 맨 앞에 "쟀는가" 를 둔다(`NO_MEASUREMENT`). 브라우저가 죽으면 차이가
  0 으로 나와 통과처럼 보인다 — 같은 날 rendercheck 에서 실제로 당했다.

### 만들면서 밟은 것 둘

- `exec-js --file` 은 파일을 **함수 본문**으로 감싼다. IIFE 로 쓰면 값이 안
  나오고 프로브가 조용히 빈 결과를 준다. 반드시 `return` 으로 끝낸다.
- 또 `cmd | tail` 로 종료 코드를 가렸다(같은 날 두 번째다).

### 고친 것 (2026-09-14) — (a)는 5분, (b)는 목록을 규칙으로

**(a) 섀도잉.** `baseURI` 를 `Document.prototype` → `Node.prototype` 으로
옮겼다(값 로직은 그대로, this 를 안 봐도 되는 것도 그대로 — 문서당 값 하나).
덤으로 **컨테인먼트 구멍 하나가 같이 닫혔다**: 예전엔 `document.baseURI` 만
가상화되고 `아무엘리먼트.baseURI` 는 네이티브 `Node.prototype` 접근자를 그대로
타서 실제 origin 이 샜다 — Document.prototype 에 심은 게 Element 인스턴스엔
안 걸렸으니까. innerHTML/innerText/textContent 는 `HTMLStyleElement.prototype`
own 훅을 지우고 각각 진짜 자리(Element/HTMLElement/Node prototype)에 심되,
`this.localName === 'style'` 로 갈라 나머지 전 요소는 그대로 흘려보낸다.
innerHTML 은 이미 `Element.prototype` 에 세정 훅(`patchHTMLSetter`)이 있어서
그 함수 안에 `<style>` 분기 하나를 더 넣는 식으로 합쳤다(따로 심으면 나중
설치가 이긴다).

**`origin` 은 삭제했다 — 코드 안에 서로 모순되는 두 개의 "실측"이 있었다.**
D7 훅 옆 주석은 "origin/domain/createElement/createElementNS 는 전부
Document.prototype 에 산다" 고 적혀 있었다. 그런데 이번 축은 그 반대를 잡았다.
**둘 다 실제로 재서** 풀었다: WebView2(Edge 153, taskweaver)와 puppeteer 로 띄운
설치된 Chrome 152 헤드리스 — **둘 다** `document.origin` 이 own 도 아니고 값도
`undefined`. 옛 주석이 스펙 문서/기억에서 나온 확인 안 된 가정이었던 것으로
보인다(`self.origin`/`location.origin` 과 헷갈렸을 가능성). 가상화할 실체가
없으므로 지웠다 — 실측 없이 "예전 주석이 맞겠지" 하고 넘어갔으면 못 잡았다.

**`test/e2e/proxy.test.js` 의 escape-matrix 가 이 옛 가정 위에 서 있었다.**
`documentOrigin` 테스트가 `document.origin` 이 가상 타깃 오리진으로
읽혀야 한다고 단언했는데, 이제 그 속성 자체가 없으니 항상 실패할 판이었다.
회귀 가드를 지우지 않고 **전제가 바뀐 것으로 갱신**했다 — `undefined` 를
`'absent-natively:ok'` 로 받아들이되, 속성이 살아있는 엔진에서는 여전히
"프록시 오리진이면 안 된다" 불변식을 검사한다. **회귀 테스트도 브라우저
스펙 드리프트로 썩는다** — 통과한다고 전제가 아직 참이라는 뜻은 아니다.

**(b) 대체 클래스의 얇은 프로토타입.** `makeVirtualGateway` (RTCPeerConnection
게이트웨이 미설정 시 폴백 + RTCDataChannel + WebTransport 폴백)가 인스턴스
리터럴에 손으로 고른 메서드 몇 개만 심고 있었다 — 오늘 CSS URL 프로퍼티
손목록과 완전히 같은 병. 진짜 네이티브 프로토타입의 **own 이름을 실행 시점에
그대로 베껴** 프로토타입에 심게 고쳤다: 메서드는 (동기/비동기, 몇 개 안 되는
분류표로) reject 하거나 던지거나 no-op, 접근자는 `on*` 이면 로컬 핸들러
백업, 아니면 스펙 초기값. 표에 없는 이름이 나와도 이름 자체는 여전히
심긴다 — 값만 `null`/reject 로 떨어진다. 코드: `web/runtime-prelude.js` 의
`makeVirtualGateway`.

**SharedWorker: 프로토타입 문제인 줄 알고 갔다가 죽어 있던 격리 기능을
찾았다.** `Worker` 는 이미 `ZPWorker.prototype = Native.Worker.prototype` 로
고쳐져 있었는데(2026-08 대), 바로 3줄 아래 `SharedWorker` 형제 훅
(`installWorkerHooks` 안, 부트 순서상 `installStorageFacades` **다음**에
실행)은 이 fix 를 못 받은 채 매번 새 함수 리터럴로 정의되고 있었다. 그 결과
둘이 같이 걸렸다:
1. 모양 — `SharedWorker.prototype` 이 `constructor` 하나뿐이라 `onerror`/
   `port` 등이 대조군에만 있었다(이번 축이 잡은 것).
2. **격리** — `installStorageFacades` 가 타깃 오리진마다 다른 이름 접두어
   (`zp:w:<hash>:`)를 심어 뒀는데, 부트 순서상 나중에 도는 이 훅이 접두어 없는
   버전으로 **조용히 덮어썼다**. 접두어가 없으면 같은 프록시 오리진을 공유하는
   서로 다른 두 타깃이 이름+URL 이 겹칠 때 **같은 SharedWorker 인스턴스**를
   붙잡을 수 있다 — 프로토타입 모양을 쫓다가 찾은, 완전히 별개의 컨테인먼트
   버그. 접두어 계산을 `sharedWorkerNamePrefix()` 로 뽑아 양쪽이 항상 같은
   문자열을 내도록 하고, 늦게 도는 훅 쪽에 다시 심었다.

**installEventMethods 를 잘못 쓸 뻔했다.** 공유 `eventTargetProto()` (XHR/
WebSocket 이 own `addEventListener`/`removeEventListener`/`dispatchEvent` 3개
초과 문제를 푼 방법, 2026-08-03)를 `ZPWebTransport`/`ZPRTCPeerConnection` 에도
쓰면 모양이 좋아질 것 같아서 처음엔 그렇게 했는데, **이 둘은 XHR 과 다르다**
— 진짜 native 인스턴스(`this._native`)를 감싸고 그 인스턴스가 스스로 이벤트를
낸다. 가짜 리스너-맵으로 바꾸면 등록은 `this` 에 되고 발생은 `_native` 에서
나서 이벤트가 영영 안 닿는다. 커밋 전에 되짚어 되돌렸다 — `makeVirtualGateway`
스텁(감쌀 네이티브가 없음)에는 그대로 안전하게 썼다. **공유 헬퍼를 쓸지는
"우리가 상태를 전부 재구현하는가, 진짜 객체를 감싸기만 하는가"로 갈린다.**

**검증**: `protoshape.sh` 6개 diff → `OK (인터페이스 955개 일치)`(양성 대조
확인 완료). 실제 프록시 페이지에서 `<style>` 세 경로(textContent/innerHTML/
appendChild+텍스트노드) 재작성, 일반 엘리먼트 innerHTML/innerText/textContent
무변화, document/element 양쪽 baseURI 동일 가상값, SharedWorker 생성 무크래시,
RTCPeerConnection/WebTransport 스텁의 동기/비동기·동일성(`wt.ready === wt.ready`)
확인. `static-policy.test.js` 46→51(신규 5개, mutation 확인), 실사이트
rendercheck naver/wikipedia/github 3/3 OK, `npm run test:e2e` 117/117
(documentOrigin/webTransport/rtcPeerConnection 포함).


## <a id="withscope-get-숨김"></a>withScope 의 get 이 `__zp_*` 를 숨겨 모든 리라이트 스크립트 사망 (2026-09-22)

- **원인:** `withScope` 프록시는 `has` 가 모든 이름에 `true` 를 돌려 `with(withScope)` 안의 리라이트 코드가 실제 전역으로 새지 않게 한다 — 그런데 `get` 에 `ZP_HIDDEN_RE` 필터가 들어가면 `__zp_get`/`__zp_set` 도 undefined 를 돌려준다. 결과적으로 **모든** 리라이트 스크립트가 `Proxy.__zp_dyn__` 스택과 함께 즉사하고, e2e 는 원인 불명의 전면 타임아웃으로 보인다. `has`/`get` 불일치는 항상 이중 점검한다.
- **수정:** `scopeGet(prop, hide)` 로 분리 — 페이지 대면 `scope` 는 `hide=true`(ZP_HIDDEN_RE 필터), 내부 실행 `withScope` 는 `hide=false`. 페이지 코드에서 `window.__zp_diagnostics` 가 `-1`/undefined 로 보이는 것은 버그가 아니라 의도된 숨김이다 — 진짜 window 의 own 프로퍼티에는 있고 CDP 에서만 읽힌다.
- **검증:** `test/e2e/proxy.test.js` 의 `diagnostics surface exists but stays hidden from page scope` 가 양쪽을 고정. e2e 129/129 (2026-09-22).

## <a id="네이티브-url-섀도잉"></a>`root.URL` 래퍼가 prelude 내부의 bare `new URL` 까지 가로챔 (2026-09-22)

- **원인:** H-a(virtual URL 표면)가 `root.URL` 을 ZPURL 래퍼로 덮었다. prelude IIFE 내부의 `new URL(...)` 도 전역 조회라 래퍼를 타고, `unleakedTargetRaw('/zp/p/…')` 가 **share 경로를 타깃 URL 로 풀어** `proxyAbsoluteURL`/`proxyHistoryURL` 이 타깃 URL 을 반환 → 네이티브 `history.pushState` 에 타깃 URL 이 도달해 `SecurityError`/`History entry` 단언 실패.
- **수정:** IIFE 상단에 `const URL = Native.URL || root.URL` 로 섀도잉해 내부 경로를 네이티브 생성자로 고정한다. `const` 는 TDZ 라 선언 지점보다 위의 `new URL` 사용을 반드시 먼저 확인한다. worker-prelude 도 동일 패턴.
- **연계 함정:** 래퍼는 `arguments.length > 1` 대신 `base !== undefined` 로 판정해야 한다 — `zp-core.canonicalTargetURL` 이 항상 `new URL(input, base || undefined)` 로 2인자를 넘기는데, `undefined` 를 네이티브에 넘기면 `'undefined'` 문자열 base 로 파싱돼 `Invalid base URL`. WebIDL 에서 명시적 `undefined` 는 "없음"과 동일하다.
- **검증:** history entry 단언 + 폼/프레임 share URL 경로가 e2e 129/129 에서 회복.

## <a id="네이티브-own-접근자-오인"></a>Chrome 의 네이티브 own 접근자를 page-installed 로 오인 — `this=scope` 로 호출돼 Illegal invocation (2026-09-22)

- **원인:** scope `get` 트랩의 page-installed-accessor 분기가 `own.configurable && own.get` 만으로 판정했다. Chrome 은 `performance`/`navigator` 등을 window 의 own configurable getter 로 노출하므로, 이 getter 를 `this=scope` 로 호출 → `Illegal invocation`/`TypeError: 'Ge' before initialization` 계열. `window.performance.timeOrigin` 읽기만으로 죽었다.
- **수정:** 부팅 시점에 window own 프로퍼티 디스크립터를 스냅샷해 두고, getter/setter identity 가 스냅샷과 같으면 네이티브로 간주해 진짜 receiver(root)로 호출한다. 페이지가 나중에 덮어쓴(identity 변경) 접근자만 `this=scope` 로 실행 — `Object.defineProperty(window,'x',{get(){return this.location}})` 후 `window.x` 에서 가상 location 이 나오는 계약 유지.
- **검증:** escape matrix `performanceTimeOrigin` 통과 + `GOPD and __lookupGetter__ return membrane getters` (A5b 계약) 동시 만족. e2e 129/129.

## <a id="설치-순서-tdz"></a>멤브레인 설치 시퀀스보다 뒤의 `let` 선언이 TDZ ReferenceError (2026-09-22)

- **원인:** `window.name` 백킹 accessor(`Ge`)가 `let` 으로 선언됐는데 설치 호출 지점보다 소스상 뒤에 있었다. 부팅 중 설치 단계가 그 accessor 를 발사 → `ReferenceError: 'Ge' before initialization` 로 prelude 전체가 죽고 e2e 전면 타임아웃.
- **수정:** 설치 시퀀스가 참조하는 `let`/`const` 선언은 호출 지점보다 위에 둔다. 번들러가 순서를 보존하므로 소스 순서가 곧 실행 순서다.
- **검증:** e2e 129/129. 같은 성격의 위험은 "install 스텝이 참조하는 후방 선언" 스캔으로 확인 가능.

## <a id="worker-readonly-전역"></a>worker-prelude 의 strict 대입이 getter-only 전역에서 TypeError (2026-09-22)

- **원인:** worker-prelude 상단이 `'use strict'` 인데 `self.indexedDB = …` 같은 대입을 했다. `indexedDB`/`caches`/`cookieStore` 는 WorkerGlobalScope 의 getter-only 접근자라 strict 컨텍스트에서 대입이 TypeError → 워커 부팅 사망 → `importScripts` 도 못 불러 `dynamic scripts and module worker integration` 타임아웃.
- **수정:** 대입 대신 `Object.defineProperty(self, name, { value, configurable: true })`. 페이지 전역과 달리 worker 전역은 멤브레인 없이 직접 속성을 심으므로 이 규칙이 항상 적용된다.
- **검증:** e2e `dynamic scripts and module worker integration` 복구, 129/129.

## <a id="assign-평가순서"></a>`x[k] op= v` 의 eager RHS 평가가 네이티브 평가 순서를 깸 — accessor-adapter 방출로 수정 (2026-09-22)

- **원인:** 대입류를 `__zp_assign(base, prop, () => rhs)` 형태로 방출하면 thunk 안의 RHS 가 호출 인자 평가 시점에 먼저 돌아 순서가 `base→rhs→get→set`. 네이티브는 `base→get→rhs→set` 이다. getter 부작용을 관찰하는 페이지 코드에서 순서 차이가 드러난다. `await`/`?.` 가 끼면 thunk 경로는 더 깨진다.
- **수정:** `x[k]++` 에 이미 쓰이던 accessor-adapter 패턴으로 통일 — 네이티브가 평가 순서·short-circuit·await 를 전부 소유하고 우리는 `{get,set}` 어댑터만 넘긴다. GLOBAL_ASSIGN 은 `__zp_get`/`__zp_set` 인라인 조합(thunk 없음 → await 생존), WITH_ASSIGN 은 값을 항상 thunk 로(한 번만 평가; with+await 는 기존대로 fail-closed). prelude `assign` 은 논리/비논리 모두 `value()` 호출로 통일.
- **연계 수정:** `new Function('return this').call(null)` — 바깥 `anonymous` 래퍼가 sloppy 면 call-site 의 `null` this 가 경계에서 실제 globalThis 로 강제변환돼 inner 가 real window 를 받는 탈출. 바깥 래퍼를 strict 로 하되 **`...callArgs` rest 파라미터가 있으면 `'use strict'` 지시어가 불법**이라 파라미터 없는 래퍼 + `arguments` 를 쓴다. `nestedCall` 은 `thisArg === root` 도 가상 전역으로 매핑.
- **검증:** `crates/zp-rewriter/tests/matrix.rs` 17/17, `test/js/prelude-units.test.js`(신규 유닛 하니스) — 이 테스트가 실제 `this` 탈출을 잡아냈다. e2e 129/129.

## <a id="e2e-리라이트-문서-프로브"></a>탈출 검증은 리라이트된 문서 안에서 해야 한다 — CDP evaluate 는 대상이 아니다 (2026-09-22)

- **규칙:** A-섹션 탈출(var/function shadowing, `this['location']`, Function receiver, eval, GOPD/`__lookupGetter__`, `contentDocument.location`, `navigation.navigate`, `open`, `frames[i]`, 동적 meta refresh)을 검증하려면 프로브 코드 자체가 OXC 리라이터와 멤브레인을 통과해야 한다. `page.evaluate` 로 주입한 코드는 리라이트를 안 거치므로 다른 시스템을 측정하게 된다.
- **방법:** 타깃 fixture 라우트(`/escape-probes`)에 `<script>` 로 프로브를 넣고 `window.__escapeProbes` 에 결과를 기록 → e2e 가 그 객체를 읽어 카테고리별 단언. 네비게이션 탈출은 `page.url()` 오리진이 proxy 인 것까지 확인한다.
- **미묘한 지점:** `navigation.navigate('javascript:…')` 는 `NotSupportedError` 가 아니라 `TARGET_PROTOCOL_BLOCKED`(plain Error, name=`Error`)로 먼저 막힌다 — URL 분류기가 isHTTPURL 게이트보다 앞서 던진다. 둘 다 fail-closed 라 `blocked:` 접두만 단언한다.
- **검증:** `test/e2e/proxy.test.js` `A-section escapes stay virtual or fail closed` 11개 subtest. e2e 129/129 (2026-09-22).

## <a id="getattribute-usesraw-누출"></a>`usesRaw` getAttribute 가 share URL 을 페이지에 돌려줬다 (2026-09-22)

- **원인:** `getAttribute` 훅의 `isURLBearing` 분기가 `usesRawURLAttribute`(a/area href, form action, formaction)면 **raw 속성을 그대로** 반환했다. raw 는 의도적으로 `/zp/?via=<enc>` 프록시 URL 라서, 페이지가 `a.getAttribute('href')` 만 읽어도 프록시 오리진과 공유 경로가 샜다 — 정적·동적 앵커 전부. O5 direct-vs-proxy 차분 픽스처가 잡았다.
- **수정:** usesRaw 분기도 `urlMeta → data-zp-target-url → deproxyURL(raw)` 순으로 되돌린다. 페이지는 절대 타깃 URL 을 본다.
- **잔여 갭:** 리터럴 복원은 안 된다 — `a.setAttribute('href','/r?x=1')` → getAttribute 는 네이티브면 `'/r?x=1'` 이지만 우리는 절대 타깃 `http://t/r?x=1` 을 돌려준다. 완전한 리터럴 왕복은 htmltx 가 `data-zp-literal-*` 스태시를 심고 런타임이 읽는 별도 작업. 차분 테스트의 `anchorAttr` 기대값이 이 경계를 고정한다(리터럴 스태시가 들어오면 "expected divergence but matched" 로 알려 준다).
- **검증:** e2e `direct-vs-proxy compatibility differential` 133/133.

## <a id="차분-측정-브라우저-격리"></a>direct-vs-proxy 차분은 별도 브라우저 인스턴스에서 — 컨텍스트 격리로는 안 된다 (2026-09-22)

- **원인:** e2e 의 `browser.on('targetcreated')` 가 브라우저 내 **모든** 타깃의 wire request 를 `wireRequests` 에 적재한다. 차분 픽스처의 direct 실행을 같은 브라우저의 새 컨텍스트에서 돌리면 direct-target 요청이 전역 "모든 네트워크는 프록시 오리진" 단언에 걸린다.
- **수정:** direct 실행은 `puppeteer.launch` 별도 인스턴스에서. 컨텍스트/페이지 수준의 선택적 관측으로는 못 막는다 — 핸들러가 세션을 만들기 전에 타깃을 이미 잡는다.
- **교훈:** 측정 대상과 대조군을 같은 계측기에 붙일 때 "어느 쪽에서 온 이벤트인가"를 먼저 묻는다 — 이 노트의 nav-matrix 대조군 오염과 같은 부류.

## <a id="foreign-document-location"></a>`contentDocument.location` 이 부모 가상 URL 을 돌려줬다 — foreign Location 은 프레임 타깃 역조회 (2026-09-22)

- **원인:** `wrappedLocationFor` 의 get 트랩이 `LOC_VIRT_PROPS` 를 무조건 realm 의 `virtualURL` 에서 읽었다 — `local` 구분은 메서드(assign/replace/reload)에만 적용돼 있고 읽기는 빠져 있었다. `iframe.contentDocument.location.href` 가 자식이 아니라 **부모** 주소를 보였다. O6 차분 픽스처의 `srcVirtual` 이 잡았다.
- **수정:** 비로컬 Location 은 `foreignVirtualURL()` 로 자기 가상 URL 을 만든다 — (1) 프레임 엘리먼트의 `urlMeta`/`data-zp-target-url` 을 `el.contentWindow.location === nativeLoc` 로 역조회(`/zp/p/<token>` 은 클라이언트가 못 푸므로 이 경로가 실효), (2) `?via=` 류 평문은 `deproxyURL`, (3) `about:*`/불명은 기존 계약대로 부모 `virtualURL` 폴백. set/GOPD 도 같은 경로.
- **연계 계약:** sandbox `allow-scripts`(opaque) 프레임의 `contentDocument` 는 네이티브처럼 **null** — `null.body` 의 TypeError 가 정답이지 SecurityError 가 아니다. `crossWindow` 파사드(safeCrossWindow)는 임의 프로퍼티 set 을 조용히 삼킨다 — 손자→최상위 마킹 같은 cross-window 통신은 postMessage 가 정규 채널.
- **검증:** e2e `iframe suite` — srcVirtual/srcdocLocation/nested/sandboxOpaque 포함 143/143.

## <a id="fixture-script-종료태그"></a>인라인 픽스처 안의 `</script>` 리터럴은 주석·문자열 가리지 않고 스크립트를 절단한다 (2026-09-22)

- **원인:** `/iframe-probes` 픽스처 인라인 스크립트의 **주석**에 `</script>` 라고 적었다 — HTML 파서는 스크립트 raw-text 안에서 주석/문자열 구분 없이 `</script` 를 만나는 즉시 요소를 닫는다. 절단된 스크립트는 `EOF` 파스 오류 → 리라이트 실패 → fail-closed 스텁이 `NotSupportedError: Blocked by ZeroProxy policy` 를 던지고 픽스처 전체가 무음 사망(waitForFunction 타임아웃 + `__probeStage` 미설정으로 관측). 에러 문서가 아니라 **스텁 throw** 라 페이지는 살아 있고 스크립트만 죽어 원인 파악이 어려웠다.
- **규칙:** 픽스처 인라인 스크립트 안에 `</script>` 리터럴이 필요하면 `'</scr' + 'ipt>'` 로 쪼갠다 — 주석도 예외 없다. 중첩 srcdoc 처럼 값에 진짜 `</script>` 가 필요하면 textarea(내용은 raw text)에 담아 `.value` 로 꺼낸다 — JSON.stringify 도 `/` 를 이스케이프 안 해서 안 못 넣는다.
- **연계 함정:** 동적 `f.src = '/x'` 는 about:blank 로 먼저 붙고 share URL 로 비동기 교체되므로 첫 `load` 이벤트는 about:blank 다 — 내용 기준 폴링으로 기다려야 한다. `body.textContent` 는 script 요소의 **리라이트된** 소스를 포함한다 — 픽스처 단언은 마커 존재 여부만 본다.
- **검증:** 픽스처 추출본을 `ZPBundle.rewriteScript` 에 직접 통과시켜 파스 실패를 재현·수정 확인. e2e 143/143.

## <a id="module-worker-importscripts-스텁"></a>module worker 에도 `importScripts` 가 "던지는 스텁"으로 존재한다 — `typeof` 가드는 무효 (2026-09-22)

- **원인:** Chrome 은 module worker 전역에 `importScripts` 를 **함수**로 노출하되 호출 시 `TypeError: Module scripts don't support importScripts()` 를 던진다. worker-prelude 의 `typeof importScripts === 'function'` 가드는 통과하고 호출에서 사망 — `zp-core.js` 가 안 실려 멤브레인 전체 부재. 워커는 postMessage 없이 조용히 죽어 `__timeout` 만 관측됐다.
- **수정:** 명시 신호로 판정한다 — `workerBootstrapURL(url, {type:'module'})` 이 부트스트랩 해시에 `mod=1` 을 싣고, prelude 는 `new URLSearchParams(self.location.hash.slice(1)).get('mod')` 로 본다. classic 만 `importScripts('/zp/assets/zp-core.js')` 한다.
- **연계 설계:** module 부트스트랩은 `import()` 체인으로 zp-core → worker-prelude → `/zp/api/worker-script?…&kind=module` 순서 로드. catch 는 `setTimeout(throw)` 로 네이티브 error 이벤트에 parity. `self.importScripts` 자체도 `typeof` 가드 후 래핑한다.
- **검증:** e2e `worker suite` — module worker imports + meta (152/152).

## <a id="worker-client-탭-바인딩"></a>워커 클라이언트는 referrer ctx 가 없다 — `?tab=` 요청에서 `bindClientContext` 안 하면 후속 요청이 503 (2026-09-22)

- **원인:** module worker 본문의 정적 dep specifier 는 Rust 가 `/zp/api/script?u=…&kind=module`(**`tab=` 없음**)로 방출한다. 페이지 요청은 clientId→clientContext 또는 referer 로 탭을 찾지만 **워커 클라이언트는 바인딩된 적이 없어** ctx 해석 실패 → A2 게이트가 503. 게다가 브라우저는 중첩 dep 실패를 **최상위 `import()` URL 에 귀속**시켜 "Failed to fetch dynamically imported module: <top URL>" 로 보고 — SW 트레이스엔 top 요청이 200 인데 import() 만 실패하는 기만적 형국이 됐다.
- **수정:** `/zp/api/worker-script` 는 언제나 `?tab=` 를 들고 온다 — 그 요청에서 `bindClientContext(clientId, tab, entry)` 로 워커 클라이언트를 탭에 묶는다. 심층 방어로 worker-prelude 의 `__zp_module_url` 도 `&tab=` 를 붙인다. classic 워커 바인딩도 동일 — 워커별 clientId 유일이라 다탭 누출 없음.
- **연계 함정(CORS):** 모듈 로더의 `mode:'cors'` + `credentials:'same-origin'` 요청에 `ACAO:*` 는 명세상 무효 — 응답 전체 거부. `applyCORS` 는 Origin 헤더 없으면 요청 URL 오리진을 되비춘다(이 핸들러 응답은 어차피 같은 오리진 전용).
- **검증:** 디버깅 경로 — bootstrap catch 로 `import()` 에러 문자열 확보 → SW `__zpRustTrace` 에 `sw:worker-script`(dest/mode/cred/origin/tab/결과) 기록 → CDP `worker` 타깃 + `Network.loadingFailed` 관측 추가(테스트에 잔류, 영구 진단 자산). e2e 152/152.

## <a id="csp-두-정책-구별"></a>같은 `/zp/` 경로에 두 CSP 정책이 공존한다 — 문서 정책은 `report-uri` 유무로 식별 (2026-09-22)

- **원인:** 프록시드 문서는 SW 가 `build_proxied_csp`/`ZP.fixedCSP`(script-src 에 `blob:` + `report-uri /zp/api/csp-report`)를 싣지만, Go 서버의 공유·컨트롤 엔드포인트 응답은 `build_csp`(blob: 없음, `frame-ancestors 'none'`, report-uri 없음)를 싣는다. CDP `Network.responseReceived` 로 CSP 를 읽을 때 URL 경로만으로 걸러면 Go 응답을 문서로 오인한다.
- **규칙:** 문서 CSP 단언은 `pathname === '/zp/' || '/zp/p/'` + **`report-uri` 포함** 두 조건으로 식별한다. control CSP 에는 report-uri 가 없으므로 정확히 갈린다.
- **연계 관측:** headless Chrome 은 `<link rel=manifest>` 와 `<link rel=prefetch>` 를 삽입 시점에 fetch 하지 않는다 — 요청이 없으니 `securitypolicyviolation` 도 없다(`no-spv` 가 정상). 디렉티브 존재/부재는 헤더 단언으로 검증한다. `<object>`/`<base>` 는 즉시 SPV 를 발사해 차단 검증에 쓸 수 있다.
- **검증:** e2e `csp suite` — allowed×blocked×directive 매트릭스 9 subtests, 서버 로그 `[CSP] blocked=` end-to-end 리포트 확인. 162/162.

## <a id="stack-프레임-이중누출"></a>스택 프레임은 URL·함수명 두 채널로 샌다 — CallSite 래핑만으론 V8 기본 포맷이 raw 텍스트를 남긴다 (2026-09-22)

- **원인:** 페이지 스택 새니타이저가 `Error.prepareStackTrace` 안에서 CallSite 의 `getFileName`/`getEvalOrigin`/`toString` 만 래핑했지만, V8 기본 포맷터는 eval 프레임을 `eval at f (http://proxy.localhost/zp/assets/runtime-prelude.js)` 처럼 **평가-기술 텍스트 자체**에 raw URL 을 박아 넣는다 — 래핑한 접근자를 안 거치는 경로. 두 번째 채널은 함수명: `at Proxy.__zp_dyn__ (...)` 처럼 리라이터가 주입한 내부 식별자(`__zp_*`)가 그대로 노출.
- **수정:** `deproxyURL` 의 `fallback:'share'` 계약을 `/zp/p/`·`?via=` 에서 **모든 `/zp/` 내부 경로**로 확장 — `/zp/assets/*`·`/zp/control/*` 도 페이지 가상 URL 로 흡수(스택·속성 직렬화에서 내부 경로가 새는 것보다 가상 URL 매핑이 항상 안전). `sanitizeFrameText` 가 URL 정리 후 `\b__zp_[A-Za-z0-9_$]*` 도 `<anonymous>` 로 지운다. worker-prelude `sanitize` 에도 동일 적용.
- **연계 함정:** `Error.prepareStackTrace` 를 페이지가 덮으면(userPrepare) 그 결과 문자열에도 같은 새니타이즈를 적용해야 한다 — 커스텀 포맷터가 raw CallSite 문자열을 그대로 쓸 수 있다. 프레임 래핑은 CallSite API 반환값까지만 책임지고 **최종 문자열은 별도로 한 번 더** 지나가야 닫힌다.
- **실측 divergence 2건:** 파스 불가 eval 소스는 네이티브 SyntaxError 대신 `NotSupportedError`(리라이트 실패 → fail-closed, 설계 발화). `import('data:…')` 는 게이트 전에 네이티브 모듈 로더가 `TypeError` 로 거부 — 이름만 다르고 차단은 동일. `new eval()` 은 오버라이드가 일반 함수라 TypeError 대신 빈 객체 반환(탈출 아님).
- **검증:** e2e `dynamic code suite` — leakDynStack/leakFnStack `v:clean` 포함 171/171.

## <a id="loop-cap-경계-의미"></a>루프캡 경계는 루프 형태별로 ±1 다르다 — `for(init;;update)` 도 캡된다 (§L 예측 반증) (2026-09-22)

- **실측:** ERRATA §L 은 `for(let i=0;;i++)` 를 "uncapped — loop-cap bypass" 로 예측했지만 실제로는 `FOR_CAP` 패치가 빈 test 슬롯에 `__zp_lc_N++<10000000` 을 스플라이스해 캡된다 — e2e 에서 정확히 10M 에서 종료 확인.
- **경계 의미:** 카운터 검사 위치가 루프 형태를 따라간다 — `while(true)`/`for(;;)`(pre-test)는 바디가 정확히 10M 회, `do{}while(true)`(post-test)는 바디가 테스트보다 한 번 먼저 도니 **10M+1**. 경계 단언을 10M 고정으로 쓰면 do-while 에서 off-by-one 으로 걸린다.
- **연계:** 캡 prefix `{let __zp_lc=0;…}` 가 붙은 async `while(true){await;break}` 도 break 시맨틱 유지. 일반 `for(i<n)`·`while(!flag)` 같은 non-truthy 조건엔 카운터가 안 끼운다(negative control).
- **검증:** e2e `perf suite` — underCap/cappedWhile/cappedFor/cappedDo/normalLoop/nestedLoops + async-poll 수명 + bulk DOM 5k/19ms + iframe 5×211ms. 176/176.

## <a id="crosswindow-더미-흡수"></a>cross-window 파사드가 날것의 멤버 쓰기를 흡수한다 — `parent.x = v` 는 `__zp_set` 를 안 거친다 (2026-09-22)

- **원인:** 리라이터는 멤버 **대입** 을 `__zp_get(base)` 결과에 대한 **raw 프로퍼티 쓰기**로 방출한다(`__zp_get(globalThis,"parent").__childSW = v` — `__zp_set` 호출 없음). `safeCrossWindow` 가 돌려주는 파사드는 **plain 객체**라서 자식의 `parent.foo = v` 가 더미 객체에만 쌓이고 진짜 부모 창에는 영영 닿지 않았다. 네이티브는 같은 오리진 프레임끼리 expando 가 그대로 보인다.
- **실측 경로:** srcdoc 자식의 `new SharedWorker` 는 정상 송신(`/zp/api/worker-script?u=sw-shared.js`)됐는데 회신이 `silent` — 워커가 메시지를내도 `w.port.onmessage` 안의 `parent.__childSW = …` 쓰기가 더미에 소실. 즉시 쓰기 마커로 쓰기 경로 자체를 분리해 확정했다(메시지 채널이 아니라 파사드 문제).
- **수정:** 파사드를 **진짜 Proxy** 로 바꾸고 `get/set/has/deleteProperty` 트랩에서 안전한 이름만 진짜 창으로 포워딩한다(`crossExpandoProp`). 읽기는 **own 프로퍼티 한정** — 프로토타입 멤버(`eval`/`Function`/`fetch` 같은 진짜 네이티브)를 넘기면 자식에 미리라이트 실행 경로가 열린다. 절대 넘기지 않는 이름: (1) `__zp_*`/`ZP*` — 부모 `scopeGet` 이 `root[prop]` 로 떨어지므로 `parent.__zp_set = evil` 이 헬퍼 탈취 통로, (2) `MEMBER_DANGER` — 가상화 표면 덮어쓰기, (3) 문자열 `on*` — 브라우저가 미리라이트 코드로 컴파일. `__zp_set` 경유 쓰기에도 같은 포워딩(`set()` fallthrough)을 둬 두 경로가 일치한다.
- **연계 함정:** `getOwnPropertyNames` 헬퍼가 **`Reflect.getOwnPropertyNames`** 를 호출했다 — 없는 API(존재하는 건 `Object.getOwnPropertyNames`/`Reflect.ownKeys`)라 리라이트된 `Object.getOwnPropertyNames(window)` 전부 TypeError. `frames.item` 이 없는 건 네이티브 parity(대조군 Chrome 도 `frames.item is not a function`) — 구현하지 말고 핀한다.
- **검증:** e2e `surface suite` — childSharedWorker `v:clean:sw:…` 포함 178/178.

## <a id="자식-realm-부트-부작용"></a>자식 realm 부트가 자기 브라우징 컨텍스트를 파괴한다 — `w.name=''` 과 컨테인먼트 이중 래핑 (2026-09-22)

- **원인 A(이름 삭제):** `installStorageFacades` 가 `w.name = ''` 로 실명을 지우는데 `w === root` 판정이 realm 로컬이라 **자식 iframe 의 prelude 도 자기 이름을 지웠다**. 프레임의 `window.name` 은 곧 **브라우징 컨텍스트 이름**이라 부모의 `window['nf']`/`frames['nf']`/`<a target=nf>` 명명 조회가 전부 undefined 로 깨졌다(네이티브는 동작). 수정: 최상위만 지우고, 자식은 초기 가상값을 실명으로 시드 + 쓰기를 실명에 반영해 타깃이 `window.name` 을 바꾸면 명명 조회가 따라가게 한다.
- **원인 B(이중 래핑):** 부모 `containFrameWindow` → `installNetworkContainment(childWin)` → `installStorageFacades(childWin)` 가 자식에 `SharedWorker`/`BroadcastChannel` 래퍼를 **먼저** 심고, 자식 prelude 가 그 래퍼를 "네이티브" 로 잡아 한 번 더 감쌌다 — `workerBootstrapURL` 이 부트스트랩 URL 을 재래핑해 `u=<bootstrap URL>` 자기재귀 → NetworkError. 수정: 진짜 네이티브를 `__zp_realSW`/`__zp_realBC` 에 스태시하고 재설치는 스태시를 우선 사용 → 멱등.
- **교훈:** 자식 realm 은 부모 컨테인먼트가 먼저 심은 것 위에서 부팅한다 — 자식에 심는 모든 래퍼는 **멱등**이어야 한다(설치 전 진짜 네이티브 스태시). `w === root` 체크는 "이 realm 의 최상위" 가 아니라 realm 로컬이라, realm 간 상태를 다루는 코드는 `w.top === w` 같은 **실제 트리 위치**로 판정해야 한다.
- **검증:** e2e `surface suite` — framesByName/windowByName/targetFramename/childSharedWorker 포함 178/178.

## <a id="stylesheet-href-디프록시"></a>`stylesheet.href` 가 프록시 URL 을 그대로 돌려줬다 — StyleSheet 인터페이스는 별도 후킹 (2026-09-22)

- **원인:** `link.href`/`styleSheets[i].href` 의 인터페이스가 다르다 — `HTMLLinkElement.href` 는 훅으로 잡혀 있었지만 `StyleSheet.prototype.href` 는 미후킹이라 `link.sheet.href` 가 `/zp/api/…` 프록시 URL 을 그대로 노출했다. "속성 훅을 걸었다" 와 "읽기 표면이 전부 디프록시된다" 는 다른 명제 — DOM 요소 접근자와 CSSOM 인터페이스를 각각 확인해야 한다.
- **수정:** `installCSSHooks` 안에서 `StyleSheet.prototype.href` 에도 deproxy getter 를 심는다. `insertRule`/`style` 속성 쓰기 경로는 기존 rewrite 후 read-back 디프록시로 정상.
- **검증:** e2e `surface suite` — sheetHref/insertRuleUrl/styleAttrUrl 전부 타깃 URL read-back + wire 에 css-leak.example 직접 요청 없음.

## <a id="loop-cap-비상수-정책"></a>비상수 test 루프는 의도적으로 uncapped — `while(true){await}` 의 silent death 만 잔여 divergence (2026-09-22)

- **정책:** `for(i=0;x();i++)`·`while(running)` 같은 비상수 test 는 캡하지 않는다 — 네이티브도 test 가 거짓일 때까지 도는 게 맞고 캡을 끼우면 합법적인 장루프(poller·scanner)가 10M 에서 조용히 죽는다. 캡은 상수-진 infinite form(`while(true)`·`for(;;)`·`do{}while(true)`)에만. 유닛 핀: `does_not_cap_for_with_nonconst_test`.
- **잔여 divergence (T5-2):** `while(true){ await poll(); }` 처럼 **break 없는** async 무한루프는 10M 에서 조용히 종료한다 — 카운터가 끼우는 건 test 슬롯이라 await·break 시맨틱은 온전하다. 다만 async 라 iteration 당 실시간이 걸려 10M 도달에 사실상 수 시간 — 실무 영향 없음으로 판정하고 핀만 둔다(조용한 사망 자체가 의도된 안티봇 완화).
- **검증:** e2e `perf suite` — asyncPollBreak(break 발화)·asyncPollFlag(좀비 폴러 없음)·cappedWhile/For/Do 정확한 경계. 179/179.

## <a id="zero-width-패치-삼킴"></a>apply_patches 의 same-start zero-width 삽입 패치가 문 패치에 삼켜진다 (2026-09-23)

- **원인:** R3(eval var 호이스트)의 zero-width 삽입 패치(`start==end==삽입위치`)는 삽입 위치가 첫 문 시작과 같을 때, 정렬이 outer-first(같은 start면 end 큰 쪽 우선)라 문 패치 뒤로 밀리고 `p.start < last_end` 에 걸려 조용히 드롭된다. desc 접근자(스코프 삽입)는 나오는데 `var z;` 선언만 빠져 원인 추적이 어렵다.
- **수정:** 정렬 기준을 `start asc → zero-width 우선 → end desc(outer-first)` 로 — 삽입이 먼저 방출되고 cursor 가 같은 위치라 문 패치가 이어서 적용된다.
- **교훈:** 패치 기반 리라이터에서 삽입·치환이 같은 위치에서 충돌할 수 있다 — 최종 출력만 보지 말고 patches 벡터 자체를 단언하는 디버그 경로가 빠르다.
- **검증:** `eval_var_decl_hoists_to_caller_varenv` — var/function 호이스트·strict·중첩·중복·directive 전부 커버.

## <a id="픽스처-주석-백틱"></a>템플릿 리터럴 픽스처 안 주석의 백틱이 리터럴을 닫는다 (2026-09-23)

- **원인:** e2e fixture 가 거대한 backtick 템플릿(`res.end(\`…\`)`)인데, 그 안의 JS 주석에 `` `var` `` 같은 백틱을 쓰면 템플릿이 거기서 닫혀 `missing ) after argument list` 파스 에러 — node --check 는 템플릿 시작 줄(1305)만 가리켜 실제 위치가 안 보인다.
- **교훈:** res.end 픽스처 내부(주석 포함)에는 백틱·`${` 를 쓰지 않는다. 파스 에러가 템플릿 시작 줄을 가리키면 안쪽의 백틱/`${` 를 grep 한다.

## <a id="에러-filename-누출"></a>prelude 안에서 throw 하면 에러 이벤트 filename 이 prelude URL 을 샌다 — throw 는 eval 코드가 하고 sourceURL 로 태깅한다 (2026-09-23)

- **원인:** `__zp_lex_decl` 같은 prelude 헬퍼가 `throw new SyntaxError(...)` 하면, uncaught 에러의 `ErrorEvent.filename` 은 throw 사이트 스크립트(=`/zp/assets/runtime-prelude.js`)가 된다 — 재작성된 스크립트의 SyntaxError 조차 프록시 자산 URL 을 페이지에 노출한다. e2e `error arg leaked` 단언이 잡았다.
- **수정 2단:**
  1. `eval(...)` 로 실행하는 모든 재작성 소스에 `\n//# sourceURL=<가상 문서 URL>` 를 붙여 eval'd 코드의 에러 filename 을 가상 타깃으로 매핑한다 (execGlobalScript·zpDirectEval·workerExecGlobal·workerDirectEval).
  2. 레지스트리 충돌 같은 "선언 시점 에러"는 헬퍼가 throw 하지 않고 **충돌 이름을 반환** — 방출 코드가 `{const __zp_bad=__zp_lex_decl(...);if(__zp_bad!==undefined)throw new SyntaxError(...)}` 형태로 eval 안에서 던져 filename 이 sourceURL 을 탄다. const 쓰기도 setter 를 `v=>{throw new TypeError(...)}` 클로저로 방출해 같은 효과.
- **잔여:** TDZ `ReferenceError`(bind 미등록 entry 읽기)는 `zpLexRead` prelude 헬퍼가 던진다 — filename=prelude 잔여 누출. 실측 드묾으로 인지형 갭.
- **교훈:** 페이지에 노출될 수 있는 에러는 "어디서 throw 됐나"가 filename 을 결정한다 — prelude 의 편의 throw 는 전부 잠재적 URL 누출이다.

## <a id="lex-bind-asi"></a>세미콜론 없는 top-level 선언 뒤에 `__zp_lex_bind` 가 붙어 스크립트 전체가 SyntaxError — 그리고 main CI 가 빨간 채였던 이유 (2026-09-29)

- **원인:** R1 의 `emit_lex_registry` 가 bind 호출을 선언문의 `span.end` 에 그대로 삽입했다. 세미콜론이 있으면 span 이 `;` 뒤에서 끝나 무해하지만, ASI 에 기대는 선언(`const a = { x: 1 }` + 개행)은 초기화식 끝에서 끝나 `{ x: 1 }__zp_lex_bind(…)` 가 된다 → 스크립트 전체 파스 실패(fail-closed 사망). 세미콜론 없는 스타일(standard, prettier `semi: false`)로 빌드된 실사이트 번들이 통째로 죽는 경로다.
- **왜 늦게 잡혔나:** `matrix.rs` 의 lex 테스트는 세미콜론 있는 입력만 썼다. CI 의 `rewriter.test.js` 는 이 버그를 실제로 잡았지만(ASI 전용 테스트가 있다), 같은 파일의 나머지 6건이 테스트 샌드박스에 `__zp_lex_decl` 이 없어 난 `ReferenceError` 였고 7번째만 진짜 `SyntaxError` 였다. 하네스 실패 더미에 진짜 버그가 묻혀, main CI 는 `7326d64` 부터 빨간 채로 Chromium E2E 단계에 아예 도달하지 못했다.
- **수정:** bind 삽입 앞에 `;` 를 붙인다(이미 `;` 가 있으면 빈 문이라 무해). 나머지 span-end 삽입은 전부 블록을 닫는 `}` 라 ASI 가 `}` 앞에서 끊어 주므로 해당 없음 — 확인함. 하네스는 prelude 원문의 `__zp_lex_decl`/`__zp_lex_bind` 를 떼어 실행한다(흉내 낸 스텁 아님).
- **교훈:** 문 뒤에 문을 **삽입**하는 패치는 앞 문이 `;` 로 끝난다고 가정하면 안 된다. 그리고 "N건 실패" 를 한 원인으로 뭉치지 말 것 — 메시지가 다른 한 건이 진짜일 수 있다.
- **검증:** `lex_registry_for_classic_toplevel` 에 ASI 4케이스(수정 전 실패 확인), `npm run test:wasm:ci` 12/12, `npm run test:e2e:ci` 181/181.

## <a id="프록시-단독-핀"></a>프록시 단독으로 적은 기대값은 divergence 를 "설계" 로 인증한다 — dyn 스위트에 네이티브 차분을 붙이자 6개가 나왔다 (2026-09-29)

- **원인:** dyn/surface 스위트의 기대값은 프록시에서 나온 값을 그대로 적은 것이었다. 주석까지 "설계된 발화다", "실행된다(마커 확인)" 라고 달려 있었지만 크롬과 대조한 적이 없었다. `/dyn-probes` 를 compat 과 같은 방식(별도 브라우저로 직접 로드)으로 네이티브와 비교하자 즉시 6건이 나왔다.
- **잡힌 것:**
  1. `el.onclick = 'code'` / `window.onX = 'code'` 를 **컴파일해서 실행**했다 — 크롬은 문자열을 `null` 로 버린다([LegacyTreatNonObjectAsNull]). 크롬이 안 돌리는 코드를 프록시만 돌렸다. 훅을 지웠다(content attribute 만 컴파일된다).
  2. indirect `eval` 이 비문자열을 `String()` 으로 강제해 **평가했다** — `eval\`x\`` 가 식별자 x 를, `(0,eval)(obj)` 가 `obj.toString()` 결과를 실행. 네이티브는 비문자열을 그대로 돌려준다.
  3. indirect `eval` 의 문(statement) 경로가 `catch {}` 뒤에 Function 본문 폴백을 두어, 재작성 코드가 **런타임에** 던지면 같은 코드를 **한 번 더 실행**했다(throw 전 부작용 2회). `eval('return 1')` 이 SyntaxError 대신 1 을 돌려준 것도 이 폴백.
  4. 파스 불가 `eval`/`Function` 이 `NotSupportedError` — 네이티브는 `SyntaxError`. 이제 가상 URL 로 태깅한 eval 팩토리에서 만든 `SyntaxError` 를 던진다(메시지는 인자로 넘김 — 코드에 이어 붙이면 페이지가 바꾼 `JSON.stringify` 로 주입 통로가 된다).
  5. `setTimeout('bad')` 가 등록 시점에 동기로 던졌다 — 네이티브는 id 를 돌려주고 발화 시점에 비동기 SyntaxError.
  6. 리터럴 `import('data:…')` 를 리라이터가 그대로 두었다(computed 만 `__zp_module_url` 로 감쌈) — CSP 만 막았고 크롬에서 되는 import 가 깨졌다. 픽스처가 헬퍼를 손으로 불러 이걸 가리고 있었다.
- **같이 고친 것:** `Reflect.setPrototypeOf(window, x)` 가 파사드에서 true(네이티브는 immutable prototype → false / `Object.setPrototypeOf` TypeError). `eval('')` 이 직접 경로에서 NotSupportedError 였다(빈 입력의 빈 출력을 실패로 봄).
- **교훈:** 기대값은 **네이티브에서** 얻는다. 프록시에서 나온 값을 핀으로 적으면 그 순간 divergence 가 테스트로 보호된다. 픽스처가 프록시 내부 헬퍼(`__zp_*`)를 직접 부르면 그 프로브는 차분에서 빠진다 — 픽스처는 평범한 페이지 코드여야 한다.
- **검증:** `dyn probes match native Chrome (direct-vs-proxy)` 49개 0 divergence, compat 차분 50개(A5 신규 7) 0 divergence, e2e 182/182, prelude-units 25(변이 3건 확인), matrix `dynamic_import_data_blob_literals_take_runtime_path`.

## <a id="surface-차분"></a>surface 스위트에도 네이티브 차분을 붙이자 — innerHTML 을 읽기만 해도 요청이 나갔다 (2026-09-29)

- **원인 1 — 직렬화 사본이 살아 있는 문서에 있었다:** `scrubbedClone` 이 `node.cloneNode(true)` 로 사본을 만들고 거기에 되돌린(절대 타깃) URL 을 써 넣었다. 떨어져 있어도 `<img>`/`<video>`/`<input type=image>` 는 src 를 **가져온다** — `innerHTML`/`outerHTML`/`getHTML`/`XMLSerializer` 를 읽기만 해도 타깃 오리진으로 요청이 나갔다(CSP 가 막아 유출은 없었지만 시도·위반 보고가 남았다). 같은 사본이 커스텀 엘리먼트 생성자를 돌려 **페이지 코드가 직렬화 때문에 실행**됐다. 비활성 문서(`createHTMLDocument`)에 `importNode` 로 만든다 — 브라우징 컨텍스트가 없으면 아무것도 로드·업그레이드되지 않는다.
- **원인 2 — 목록 대 규칙, 또:** URL 속성 표는 `url_surfaces.json` 한 곳인데 IDL 프로퍼티 훅은 손목록이었다. 표의 쌍마다 크롬에서 "반영 세터가 속성을 쓰는가" 를 재자 `input.src`, `body.background`(평범한 문자열 반영 — URL 아님), SVG `href.baseVal` 셋이 비어 있었다. SVG 는 `SVGAnimatedString` 이 원소를 모르므로 원소별 Proxy 를 돌려준다(`el.href === el.href`, `instanceof` 유지).
- **원인 3 — 런타임 transformHTML 은 리터럴을 안 남겼다:** 서버 htmltx 는 바꾼 URL 속성마다 `data-zp-lit-*` 를 남기는데 페이지 realm 워커는 안 남겨서, `innerHTML='<a href="/x">'` 가 `href="http://t/x"` 로 읽혔다(서버/런타임 비대칭의 또 한 사례). 걷기 전에 스냅샷, 걷은 뒤 바뀐 것만 stash.
- **그 외:** SharedWorker 기본 이름 `default`(네이티브 `''`), OPFS 루트 `.name` 의 `zp:o:<hash>`, 내비게이션 엔트리가 이후 해시를 따라감, importmap 텍스트 되읽기의 프록시 URL, `<a ping>` 되읽기 null.
- **측정 함정 둘:** ① 리소스 타이밍 엔트리는 **CSP 로 막힌 fetch 에도 생긴다** — 로드 여부 오라클로 못 쓴다. 타깃 서버 요청 로그(UA 로 네이티브/프록시 구분)가 오라클이다. ② 네이티브 참조 페이지에서 puppeteer `waitForFunction` 기본 `raf` 폴링이 백그라운드 헤드리스에서 굶어 140초가 걸렸다 — `polling: 100`. `alert()` 는 네이티브에서 페이지를 막으니 dialog 를 dismiss 한다(스텁 값과 같다).
- **교훈:** 차분의 기준은 **네이티브**다. 네이티브 참조가 흔들리면 참조만 재시도하고(피시험 쪽은 절대), 의도된 divergence 는 이유와 함께 목록에 두되 "더 이상 갈리지 않으면 실패" 로 목록이 썩지 않게 한다.
- **검증:** surface 차분 98개 중 13개만 이유 있는 목록, compat J 로드 12/12 parity, 프록시 페이지의 직접 요청 0.

## <a id="module-kind-url"></a>import/export 없는 모듈이 classic 으로 리라이트됐다 — SW 는 요청만으로 kind 를 모른다 (2026-09-29)

- **증상:** GitHub 콜드 로드에서 `global-banner-disable` 이 "Identifier 'e' has already been declared" 로 죽었다. `high-contrast-cookie` 와 둘 다 `<script type=module>` 인데 import/export 없이 top-level `let e` 만 가진다. 네이버의 높이 8% 도 같은 원인이었다(그쪽은 import 가 있어 `parse_for_kind` 로 먼저 막았다).
- **원인:** htmltx 가 모든 `script[src]` 를 `/zp/api/fetch?url=` 로 보냈고, SW `scriptKindFromRequest` 는 destination `script` 를 전부 classic 으로 본다. `crossorigin` 이 붙은 classic 과 module 은 mode·credentials·헤더가 같아서 **요청만으로는 가를 수 없다.** classic 리라이트는 R1 렉시컬 레지스트리 프롤로그를 붙이고, 그것이 원래 스코프가 따로인 모듈끼리 이름을 부딪치게 했다.
- **수정:** kind 는 URL 로 싣는다. `<script type=module src>` 와 `<link rel=modulepreload>` 는 정적 import·importmap 과 **바이트 단위로 같은** `/zp/api/script?u=…&kind=module` 로 간다(한 모듈이 두 URL 이 되면 모듈 맵에 두 벌 — React #321). 동적 스크립트는 `Object.assign(s,{src,type})` 처럼 `src` 가 `type` 보다 먼저 오는 순서가 있어서, 삽입 시점에 kind 를 다시 맞춘다(`withCurrentKind`). `parse_for_kind` 는 import/export 가 있는 경우의 안전망으로 남는다.
- **잔여:** `<link rel=preload as=script>` 는 classic 경로 URL 이라 모듈이 그것을 소비하지 못하고 한 번 더 받는다(네이티브는 공유).
- **검증:** htmltx `module_script_src_carries_module_kind`(로직을 되돌리면 실패 확인). dyn 차분 `staticModuleLex`/`dynModuleTypeAfterSrc` — 구 빌드는 `v:a|undefined`/`v:undefined|undefined`, 수정 후 네이티브와 같다.

## <a id="ce-접두어-제거"></a>customElements 타깃별 접두어는 격리가 아니었다 — GitHub react-partial 전멸 (2026-09-29)

- **증상:** GitHub react-partial 6개가 전부 "No embedded data provided for react element …".
- **원인:** 09-24 감사가 "레지스트리가 진짜 프록시 오리진에 묶인다" 고 보고 `zp<hash>-x` 접두어와 교체 기반 업그레이드를 깔았다. catalyst `findTarget` 이 `el.closest(tag) === this` 인데 `closest`/`matches` 는 번역되지 않아 타깃을 못 찾았다. 교체라서 define 전에 잡아 둔 참조가 떨어져 나갔고, CSS 타입 선택자(`tool-tip{…}`)도 접두 이름에 맞지 않았다.
- **전제가 틀렸다:** 레지스트리는 오리진이 아니라 **Window 마다** 있다. 크롬 152 실측 — 최초 about:blank 의 same-origin 내비게이션(프록시에서는 모든 타깃이 same-origin 이라 이것이 유일한 공유 후보)에서도 심어 둔 정의·전역이 사라지고 그 생성자는 새 문서의 요소에서 돌지 않는다. 격리 이득은 0 이고, 비용은 커스텀 엘리먼트를 쓰는 모든 사이트였다.
- **수정:** 접두어·선택자 번역·교체 업그레이드를 전부 걷고 네이티브 레지스트리를 그대로 쓴다.
- **교훈:** "공유된다" 는 전제를 측정한 뒤에 격리 장치를 깐다. 저장소처럼 보인다고 다 오리진 키가 아니다.
- **검증:** surface `customElUpgrade` — 정체성·`closest` 타깃·`matches`·CSS 폭 네 축(구 빌드 `same:false|up:false|target:none|matches:false|w:auto`, 수정 후 네이티브와 같다).

## <a id="prepare-stack-재귀"></a>`Error.prepareStackTrace` 저장/복원이 우리 훅을 자기 자신에 물렸다 — 이후 모든 `.stack` 이 스택 오버플로 (2026-09-29)

- **증상:** 커스텀 엘리먼트를 고치자 GitHub react-partial 이 이번엔 "Maximum call stack size exceeded" 로 죽었다.
- **원인:** 게터는 늘 `zpPrepare` 를 돌려준다. React `describeNativeComponentFrame` 은 `p = Error.prepareStackTrace; … = undefined; … = p` 로 저장/복원하는데, 복원이 `userPrepare = zpPrepare` 가 되어 자기 자신을 불렀다. 한 번 복원되면 그 뒤 **모든** `.stack` 이 터진다. 이전 값을 부르는 체이닝 훅도 같은 고리이고, 워커 사본도 같았다.
- **수정:** 세터는 우리 값을 "훅 없음" 으로 받고, 페이지 훅이 되부른 호출(`inUserPrepare`)은 기본 포맷으로 답한다.
- **진단 팁:** V8 은 스택 오버플로 자리에서 디버거를 세우지 못한다 — pause 에는 React 의 재throw 만 잡혔다. 원 위치는 `Runtime.exceptionThrown` 의 `exceptionDetails.stackTrace`(생성 시점, 최대 200프레임)에 있다. `.stack` 문자열은 우리 sanitizer 를 거치고, 미니파이된 prelude 함수명은 `node scripts/build.mjs --web-only --no-minify` 로 얻는다.
- **검증:** prelude-units 페이지·워커 각 1 — React 관용구·체이닝 훅·일반 훅(수정 전 RangeError 확인).

## <a id="워커-헬퍼-누락"></a>리라이터가 낸 헬퍼가 워커에는 없었다 — `Object.keys(o)` 가 ReferenceError (2026-09-29)

- **증상:** 프록시된 워커에서 `Object.keys`·`Object.getOwnPropertyNames`·`Reflect.get`·`delete o[k]`·`o?.[k]` 가 전부 `__zp_* is not defined` 로 죽었다. 실측 11개 중 10개.
- **원인:** b602610(09-22)이 `__zp_okeys`/`__zp_delete`/`__zp_oget`/`__zp_rget`/`__zp_with_*` 등을 페이지 멤브레인에만 정의했다. 리라이터는 워커에도 같은 헬퍼를 낸다.
- **수정:** 워커에 15개를 포팅했다(대상 해석은 워커 규칙 `workerTarget`/`isWorkerGlobal`).
- **가드:** static-policy 가 리라이터 소스의 문자열 리터럴에서 방출 헬퍼(호출형 `__zp_x(` 와 통째 이름)를 모아 페이지(`define(root`)·워커(`expose`)·자식 창(`define(w`) 셋 모두에 있는지 강제한다. 포팅을 되돌리면 정확히 그 15개를 지목하고, 자식 창 축은 곧바로 [자식-렉시컬](#자식-렉시컬) 을 찾아냈다.
- **교훈:** 헬퍼를 새로 내게 하면 realm 셋을 같이 본다. 목록이 여럿이면 반드시 갈라진다 — 가드가 그 목록들을 대조한다.

## <a id="옵셔널-체인-연속"></a>옵셔널 체인을 고리별 헬퍼 호출로 바꾸면 단락이 사라진다 — GitHub 랜딩이 에러 페이지를 그렸다 (2026-09-29)

- **증상:** GitHub `landing-pages` 앱이 "Looks like something went wrong!". 원 에러는 `e.poster?.[!e.poster.mobile||er?"desktop":"mobile"]` 에서 났다 — 이미지 항목에는 poster 가 없다.
- **원인:** `a?.[k]` → `__zp_oget(a,k)`. 함수 호출은 인자를 **먼저** 평가하므로 a 가 nullish 여도 k 가 돈다. `a?.[k].b` → `__zp_oget(a,k).b` 는 체인 전체 단락이 깨져 `undefined.b` 로 던진다. `x?.[k](args)`·`x.m?.(args)` 도 인자를 미리 평가했다.
- **수정 (OCHAIN):** 체인 단위로, 다시 쓴 고리가 `?.` 를 가로지를 때만 `__zp_ochain(base, __zp_oc => <나머지>)` 로 감싼다. 나머지는 base 접두를 `__zp_oc` 로 덮어 기존 고리 패치를 그대로 렌더한다 — 연속 안에서 base 는 nullish 가 아니므로 고리 패치는 손대지 않아도 맞다. 멤버 피호출자의 옵셔널 호출은 `__zp_ocallv(obj,key)` 로 receiver 를 묶어 네이티브 `__zp_oc?.(args)` 로 부른다. `x?.location` 처럼 리터럴 키 한 고리는 연속 없이 그대로 둔다.
- **포기하는 경우(잔여):** `Reflect.get?.(o,'location')` 같은 특수형이 분할점에 걸리면 — 그 패치를 떼면 진짜 `Reflect.get` 이 나간다 — 고리별 방출을 유지한다. 연속 화살표가 담을 수 없는 `await`/`yield` 가 첫 `?.` 뒤에 있어도 그렇다.
- **함정 둘:** ① 마지막 고리 패치와 OCHAIN 이 **같은 span** 이다 — OCHAIN 을 고리 패치들보다 앞에 insert 해야 안정 정렬에서 바깥으로 남는다. ② 덮어쓰기(`__zp_oc`)는 합성 패치를 inner 목록 맨 앞에 넣어 같은 span 패치를 이기게 하고, 중첩 마커의 `rewrite_range` 가 그것을 물려받는다.
- **검증:** rewriter.test.js 25케이스를 네이티브와 결과·평가 로그·에러 클래스까지 대조(구 빌드는 첫 케이스부터 실패). matrix 핀 갱신과 음성 대조 3(키 안쪽 패치·특수형·yield). 워커 `ogetLazy`/`ogetChain`. GitHub rendercheck 높이 15% → 100%, 요소 1811/1811.

## <a id="자식-렉시컬"></a>about:blank 자식 창에 R1 렉시컬 헬퍼가 없었다 — top-level let 을 가진 스크립트가 첫 줄에서 죽었다 (2026-09-29)

- **증상:** 부모가 about:blank iframe 에 써 넣은 스크립트(SafeFrame 모양)가 `__zp_lex_decl is not defined`. 다음 스크립트는 앞 스크립트의 `let` 을 보지 못했다.
- **원인:** 자식 창은 자체 prelude 없이 containment 의 명시 목록으로 헬퍼를 받는데, R1 이 들어올 때 이 목록에 추가되지 않았다. 부모 것을 그대로 넘기면 안 된다 — 자식의 `let x` 가 부모 것과 충돌하고 부모 전역 조회에 샌다.
- **수정:** 자식 전용 Map 과 `__zp_lex_scope` 를 깔고, 페이지 `execGlobalScript` 와 같은 `with(__zp_lex_scope)` 래핑을 쓴다(strict 소스는 그대로).
- **검증:** 브라우저 차분 — 구 containment 로 빌드해 실패를 재현(`undefined | e:ReferenceError`)한 뒤, 수정 후 네이티브와 같다(`6 | number:3:function | 10 | no-throw`). static-policy 헬퍼 가드의 `child:` 축.

## <a id="arrow-본문-stmt"></a>화살표 표현식 본문을 문 위치로 봤다 — ASI 가드 `0,` 가 화살표를 끊었다 (2026-09-29)

- **증상 (CNN):** Permutive SDK 가 "Unexpected token '('" 로 통째로 죽었고, Rubicon prebid 는 "d is not defined" 를 던졌다. 둘 다 같은 원인이다.
- **원인:** OXC 는 `x => expr` 의 본문을 **합성 ExpressionStatement** 로 감싼다. `visit_expression_statement` 는 문 시작에 걸친 패치를 `_STMT` 형(앞에 ASI 가드 `0,`)으로 바꾸는데, 화살표 본문에도 그랬다. `(e,t)=>t[e]??=[]` → `(e,t)=>0,({b:…}).v??=[]` — 화살표는 `0` 을 돌려주고 나머지는 **선언의 둘째 declarator** 가 되어 SyntaxError. `return(d="")=>e[d]||=…` 는 더 나빴다 — `return ((d="")=>0), (…)` 로 **문법은 맞게** 파싱돼, 화살표 매개변수 `d` 를 바깥에서 읽다가 ReferenceError. 조용히 의미가 바뀌는 쪽이 더 위험하다.
- **수정:** 표현식 본문 화살표의 합성 문 시작 위치를 기록해 두고(`arrow_expr_bodies`), 그 문에서는 `_STMT` 승격을 하지 않는다. 화살표 본문은 `(` 로 시작해도 ASI 위험이 없다.
- **검증:** matrix `arrow_expression_body_is_not_a_statement_position`(5형 + 진짜 문 시작은 가드 유지; 수정을 끄면 Permutive 형 그대로 실패). 실사이트 원본(Permutive·Rubicon)을 빌드 리라이터로 다시 써 파싱·형태 확인.

## <a id="blob-워커-해제"></a>`new Worker(u); URL.revokeObjectURL(u)` — 워커 소스를 생성 시점에 확정하지 않았다 (2026-09-29)

- **증상 (CNN):** Permutive 의 blob 워커가 "Blocked by ZeroProxy rewrite policy" 로 죽었다. 페이지 쪽에서는 스택이 없는 에러(`error: null`)만 보인다 — 처리되지 않은 워커 에러는 스펙상 소유자 전역에 **에러 객체 없이** 다시 보고된다. 원 위치는 워커 CDP 세션의 `Runtime.exceptionThrown` 에서 봤다.
- **원인:** 네이티브는 blob URL 을 Worker **생성 시점**에 해석하므로 곧바로 해제해도 안전하다. 우리 워커는 부트스트랩(prelude + 번들) 뒤에 sync XHR 로 소스를 읽는데, 그 사이 페이지가 URL 을 해제하면 읽을 게 없어 fail-closed 했다.
- **수정:** 페이지 realm 의 `URL.createObjectURL` 이 Blob 을 **기록만** 하고(`pageBlobURLs`, 해제 시 삭제 — 네이티브 수명보다 길게 잡지 않는다) Worker 생성 때 **우리 소유 복사본 URL** 을 `srcu` 로 넘긴다. 워커 정체성(`u` = `self.location`)은 페이지 URL 그대로다. createObjectURL 은 MediaSource 를 HTML 로 바꾼 전과(CNN 비디오)가 있어 **차단이 아닌 기록만**, Blob 브랜드 검사로 MSE 핸들은 제외.
- **검증:** dyn 차분 `blobWorkerRevoked`(네이티브 `v:blob:a`), 브라우저 차분(구 빌드 `error:… rewrite policy`).

## <a id="워커-self-수신자"></a>워커에서 `self.addEventListener(…)` 가 Illegal invocation — 스코프 프록시가 네이티브 메서드를 날것으로 돌려줬다 (2026-09-29)

- **증상 (CNN, 이후 일반화):** blob 워커 수정 뒤 Permutive 워커가 `t.addEventListener("message", …)` 에서 Illegal invocation. 최소 재현에서 `self.addEventListener`·`globalThis.addEventListener`·`self.dispatchEvent`·`self.setTimeout`·`self.atob` **전부** 실패 — 가장 흔한 워커 관용구가 2026-05 부터 깨져 있었다.
- **원인:** 워커 리라이트는 `self` 를 `__zp_get(globalThis,"self")` → 스코프 프록시로 돌린다. 프록시가 네이티브 메서드를 그대로 돌려주면 수신자가 프록시라 브랜드 체크에 걸린다. 페이지 멤브레인은 같은 문제를 규칙(`needsWindowReceiver`)으로 풀었는데 워커에는 없었다.
- **수정:** 같은 규칙 — prototype 없는 네이티브 함수만 진짜 전역에 묶고, 함수별 캐시로 `self.f === self.f`, `name`/`length` 유지.
- **숨은 함정:** 그 규칙의 "네이티브인가" 판별이 런타임 `Function.prototype.toString` 을 부르는데, 워커 prelude 는 전역 `Function` 을 래퍼로 바꿔 둔다 — 래퍼의 `prototype` 이 **빈 객체**라 `Function.prototype.toString.call(f)` 가 "[object Function]" 을 돌려줬다. 그래서 첫 수정이 아무것도 묶지 못했다. 캡처해 둔 네이티브 toString 을 쓰고, 래퍼들의 `prototype` 을 진짜 intrinsic 으로 맞췄다 — 페이지 코드의 네이티브 판별(`/\[native code\]/`)도 같이 고쳐졌다.
- **검증:** dyn 차분 `workerSelfMethods`(네이티브 `v:a,number,true,true`), 워커 브라우저 차분 13항목 전부 네이티브와 같다.

## <a id="명명-타깃-프레임"></a>`<a target=프레임이름>` 이 프레임에 **런처**를 실었다 — 표면 프로브는 런처 URL 을 읽고 통과했다 (2026-10-01)

- **증상:** CI(ubuntu)에서만 `targetFramename` 이 `not-navigated:…/surface-probes`. 로컬은 통과.
- **측정(CDP 프레임 이벤트):** 프레임 대상 링크는 멤브레인이 손대지 않아(`target !== '_self'` → null) 브라우저가 원시 href, 즉 `?via=` 런처를 프레임에 실었다. 부모 문서의 `load` 스윕(`sweepSWLessFrames` → 훅된 `contentDocument`)이 그 런처 창에 containment 를 깔고, 런처의 `proxyOrigin()` 이 `new URL(location.href)` — 이제 **우리 URL 파사드**라 `via=` 를 타깃으로 풀어 `proxy.localhost:<타깃 포트>` 로 리다이렉트했다 → `ERR_BLOCKED_BY_CSP` → chrome-error. **로컬에서도 프레임은 타깃에 한 번도 닿지 않았다**(업스트림 로그에 프록시 쪽 `/frame-dest` 0건). 프로브는 런처 단계의 URL(`?via=` → 타깃으로 디프록시)을 읽고 통과했고, 9-29 에 800ms 1회 확인을 폴링으로 바꾸자 타이밍이 갈려 CI 에서만 드러났다.
- **같은 뿌리:** `setAttribute('target', name)` 은 `setSafeNavigationTarget` 이 원시값을 `_self` 로 바꾸고 이름을 `data-zp-blocked-target` 에 숨긴다 — 옛 클릭 핸들러는 그걸 자기 내비게이션으로 처리해 **페이지 전체가** 이동했다. `<base target>` 은 무시됐고, `window.open(url, name)` 도 프레임에 런처를 실었다.
- **수정:** 이 페이지의 프레임을 이름으로 찾아(Chromium `FindFrameForNavigation` 순서: 자기, 하위, 꼭대기부터 전체) `iframe.src` 와 같은 프레임 라우트(`activatedFrameURL`)로 보내고 프레임의 Location 을 옮긴다(`src` 는 네이티브처럼 그대로). 숨긴 이름(`data-zp-blocked-target`)과 `<base target>` 을 읽는다. `_blank`·조상·없는 이름은 여전히 네이티브(최상위 런처는 동작한다).
- **부모의 읽기:** 프렐루드가 없는 문서(text/plain 404 등)는 자기 위치를 말할 수 없고 `/zp/p/<token>` 은 여기서 복호화가 안 된다 — 이 realm 이 연 라우트를 routeKey→타깃으로 기억한다(`frameRouteTarget`). 위치 읽기와 `postMessage` 오리진이 이걸 먼저 본다(프레임이 **지금 있는** 경로 기준이라 낡지 않는다).
- **검증:** surface `targetFramename`·`targetFramenameAttr`·`baseTargetFrame`·`namedOpen` — 전부 **목적지 문서 본문**(`not found`)까지 기다리고 네이티브와 같다. 옛 코드에 새 프로브를 돌리면 픽스처 페이지째 떠나 스위트가 무너진다.
- **규칙:** 내비게이션 프로브는 URL 이 아니라 **도착한 문서**를 확인한다 — 런처의 `?via=` 는 디프록시하면 목적지 URL 이 된다.

## <a id="자식-멤브레인-덮어쓰기"></a>부모가 `contentWindow` 를 읽을 때마다 자식의 멤브레인을 자기 것으로 **덮었다** (2026-10-01)

- **측정:** `f.contentWindow.location.href = '/x'` 로 보낸 프레임에서 CDP 로 `window.__zp_get === parent.__zp_get` → **true**. 자식 코드의 `location.href` 가 부모 URL 을 읽었고, 부모의 `f.contentWindow.location.href` 도 부모 URL.
- **원인:** `containFrameWindow` 는 부모 마커(realm 마다 다른 `Symbol`)만 본다 — 자기 prelude 로 부팅한 자식은 마커가 없어 보이고, `installNetworkContainment` 의 `define` 은 **쓰기 가능 슬롯을 덮어쓸 수 있다**(non-configurable 이어도 writable 이면 값 교체 허용). `src` 로 보낸 프레임만 `data-zp-target-url` 면제 덕에 무사했다. `contentWindow.location`·자기 내비게이션·명명 타깃으로 바뀐 프레임은 부모의 헬퍼·저장소 파사드로 돌았다 — 격리 위반.
- **수정:** `ownsMembrane(w)` — 다른 realm 의 `__zp_get` 을 가진 창은 이미 자기 prelude 가 담았다. `containFrameWindow` 와 `installNetworkContainment` 둘 다 건너뛴다.
- **검증:** surface `childLocAssign`(자식의 즉시·300ms 뒤 읽기 + 부모 읽기, 로드 중 `contentWindow` 를 계속 두드린다) — 네이티브와 같다.

## <a id="라우팅-프레임-탈출"></a>탈출 — 라우팅된 프레임의 세 창에서 `contentWindow.eval` 이 프록시 오리진의 날 코드였다 (2026-10-01)

- **측정:** 부모 페이지 코드의 `f.contentWindow.eval('typeof __zp_get + location.href')` 가 `undefined|about:blank` 또는 `undefined|http://proxy.localhost:…/zp/p/…` — 리라이트 없이 프록시 오리진에서 돌았다(모든 타깃의 저장소, 진짜 프록시 URL). 세 경우: (a) `src` 라우트가 대기 중인 앞의 blank 페이지, (b) 라우팅 뒤 `src = 'about:blank'` 로 옮긴 프레임(면제가 **끈적했다**), (c) `html`/`head`/`body`/`script` 태그가 하나도 없는 라우팅 HTML 문서 — 스트리밍 변환에 앵커가 없어 **프렐루드가 아예 없었다**(멤브레인도 CSP meta 도 없음; 버퍼 경로는 문서 맨 앞으로 떨어진다).
- **면제의 근거가 사라졌다:** 2026-05-29 의 `data-zp-target-url` 면제는 "about:blank 의 Window 가 라우팅 문서에 재사용돼 부모 게터가 남는다" 였다. 실측: Chrome 은 재사용하지 않는다(문서 시작 시점 `__zp_get` 없음 — 포함된 초기 blank 를 `contentWindow.location` 으로 보내도). 그 증상의 실체는 위 [자식-멤브레인-덮어쓰기](#자식-멤브레인-덮어쓰기) 였다.
- **수정:** containment 를 **지금 문서**로 정한다 — 자기 멤브레인(`ownsMembrane`) 이거나 로드 중인 프록시 HTML 문서(`bootingProxiedDocument`: 공유 경로 + `text/html` + `readyState !== 'complete'`, 자기 prelude 가 곧 담는다)만 건너뛰고 나머지는 전부 담는다. 끈적한 면제와 `instrumentIframe` 의 `willNavigate` 는 걷었다. `src` 를 타깃 아닌 값으로 바꾸면 스태시를 지운다. htmltx 는 앵커가 없으면 첫 요소 앞 → 첫 비공백 텍스트 앞 → 문서 끝.
- **남은 틈(잔여):** 라우팅 HTML 문서(프레임·팝업)가 커밋된 뒤 prelude 첫 스크립트까지 — 거기서 담으면 자식이 부모의 fetch/XHR 가 박힌 사전 계측 realm 이 된다. 첫 바이트가 파싱되기 전에 열리는 틈이라 문서 안에서는 못 닫는다 — 외부 창 핸들을 전부 감싸는 재설계 몫(ERRATA 잔여). 로드가 끝나도 부팅 못 한 문서는 담긴다. 팝업 런처 단계는 [내비게이션-타깃](#내비게이션-타깃) 에서 걷었다.
- **검증:** surface `pendingRouteEval`·`staleBlankEval`(가상 URL — 네이티브 `about:blank` 과 다른 것이 의도, 같아지면 탈출 재발) · `routedPlainEval`(네이티브와 같음) · htmltx `prelude_is_injected_into_tagless_documents`.

## <a id="내비게이션-타깃"></a>`target` 을 전부 `_self` 로 바꿔 쓰고 있었다 — `_blank` 는 제자리, `_top` 은 프레임만, 폼은 타깃 무시, 팝업은 런처부터 (2026-10-01)

- **원인:** 2026-05-27 의 `setSafeNavigationTarget` 가 링크·폼의 `target` 을 **모두** `_self` 로 고쳐 쓰고 이름을 `data-zp-blocked-target` 에 숨겼다(`setAttribute` 훅과 MutationObserver 양쪽). href 가 타깃 원본이던 시절의 장치다 — 2026-06-06 이후 href 는 `?via=` 런처라 네이티브로 새 창·조상을 움직여도 프록시를 지난다. 런처 주석은 오히려 "`target=_blank` 는 새 탭으로 여기 떨어진다" 고 적고 있었다.
- **증상:** `target=_blank` 가 제자리에서 열림, 프레임 안 `target=_top`/`_parent` 링크가 **그 프레임만** 이동, `getAttribute('target')` 가 `_self`. 폼은 `target`/`formtarget` 을 아예 안 봐서 iframe 으로 POST 하는 폼(3-D Secure, 임베디드 결제)이 페이지 전체를 갈아치웠다. 팝업은 런처를 먼저 돌렸고(그동안 opener 핸들로 날 창), `noopener` 팝업은 about:blank 를 열고 `null` 을 받아 **영영 이동하지 않았다**.
- **수정:** 재작성을 걷고 링크·폼 모두 "choosing a navigable" 로 푼다(`chooseNavigable`): 자기 → 멤브레인 자기 내비게이션, 프레임 → 프레임 라우트, 조상 → **그 창의 멤브레인**(`win.__zp_get(win, 'location').href =`, 페이지의 `top.location =` 과 같은 길), 새 창 → 네이티브(`_blank` 는 noopener). POST 는 같은 `SUBMIT_PREPARE` 의 본문을 싣고 불러올 창만 다르다. 팝업은 opener 가 `OPEN_SHARE` 를 직접 보내 문서 경로로 바로 보낸다 — 런처가 하던 일 그대로.
- **검증:** surface `targetFramenameAttr`·`targetAttrReadback`·`parentTargetLink`(중첩 프레임의 `_parent`)·`formTargetGet`·`formTargetPost`·`popupRouted` — 전부 네이티브와 같다. 팝업을 5ms 로 샘플링하면 about:blank → 문서 바로, 런처 상태 없음. noopener 팝업은 목적지까지 간다.
- **규칙:** 브라우저 의미를 "안전하게" 하려고 속성을 고쳐 쓰지 말 것 — 읽기 표면이 갈라지고, 고쳐 쓴 이유가 사라진 뒤에도 남는다. 내비게이션은 실행 지점(클릭·제출·open)에서 가로챈다.

## <a id="교차-사이트-프레임"></a>서로 다른 사이트의 프레임을 브라우저가 격리하지 않았다 — 가상 오리진별 창 핸들 정책 (2026-10-02)

- **측정:** localhost 부모 + 127.0.0.1 자식을 네이티브/프록시에서 같은 코드로(타입·에러 이름만 기록, 내용은 읽지 않는다) — 101개 중 28개가 달랐다. 네이티브는 교차 오리진 창에서 13개 이름 외 전부 `SecurityError`, `contentDocument` 는 `null`, `frameElement` 는 `null`. 프록시는 부모→자식(문서·저장소·`eval`·이름)과 자식→부모(저장소·`eval`·이름, `frameElement` 로 임베더 DOM)가 전부 열려 있었다. 같은 사이트 대조군에서는 `parent.document` 가 `undefined`(네이티브 `object`)였다.
- **원인:** 프록시를 지나는 모든 프레임은 물리적으로 같은 오리진이라 브라우저 SOP 가 못 가른다. 멤브레인은 `Location` 만 가상 오리진별로 막았다. 리라이터는 `document`·`localStorage`·`eval` 같은 이름을 감싸지 않는다(원시 읽기) — 그래서 **건네는 객체 자체**가 제한돼야 했다.
- **수정:** `windowHandleFor(win, hint)` 한 곳이 "페이지가 이 창을 어떤 형태로 쥐는가"를 정한다. 가상 오리진이 다르면 HTML 교차 오리진 창 규칙을 따르는 Proxy(`crossOriginWindow`: `window self location closed frames length top opener parent blur close focus postMessage` + 자식 인덱스, 나머지는 읽기·쓰기·`in`·`delete`·`defineProperty`·`setPrototypeOf`·`preventExtensions` 전부 `SecurityError`, `getPrototypeOf` null, `Object.keys` 빈 배열). 같은 오리진 조상은 그 realm 의 페이지-facing 창으로 **전달**하는 스탠드인(`ownerScopeOf`), 나머지 같은 오리진 창은 그대로. 모든 출처에 적용: `iframe.contentWindow`, `contentDocument`(null), `frames[i]`·`window[i]`·이름 조회, `window.open()`(향하는 URL 의 오리진으로 — 빈 창일 때부터), `event.source`, `parent`/`top`/`opener`, `frameElement`(임베더가 다른 사이트면 null). 프레임은 **보내진 곳**(`data-zp-target-url`)을 알아서, 아직 부팅 전인 빈 플레이스홀더도 처음부터 제한한다.
- **네이티브 측정값(Chrome 148):** `delete`·`Reflect.defineProperty`·`setPrototypeOf`·`preventExtensions` 모두 `SecurityError`(false 가 아니다). `'then' in w`·마지막 자식 뒤 인덱스·`w[Symbol.iterator]` 는 던진다. `getOwnPropertyDescriptor`: `postMessage`/`close`/`focus`/`blur` 는 `{value, writable:false, enumerable:false, configurable:true}`, `location` 은 `{get,set}`, 나머지 허용 이름은 `{get}`, `then`·세 심볼은 값 undefined. `String(w)`·`JSON.stringify(w)` 는 던진다. 교차 오리진 `Location` 의 키는 `href replace then`.
- **내부 코드는 진짜 창을 본다:** 훅된 `contentWindow`/`contentDocument` 는 이제 페이지용이라 멤브레인 내부(프레임 계측·origin 기억·SafeFrame 높이 shim·sweep)는 `nativeFrameWindow`/`nativeFrameDocument` 를 쓴다.
- **검증:** e2e `cross-site frame and popup access matches native`(프레임·팝업 양방향, `postMessage` 표, 이름 조회, 답장 — 옛 멤브레인에서 빨갛다). 의도된 차이 2개(아래).
- **남은 틈(ERRATA 잔여):** ① 창이 **같은 오리진일 때** 쥔 핸들은 나중에 다른 사이트로 이동해도 계속 열려 있다(진짜 창은 회수할 수 없다) — `src` 를 정하기 전에 읽은 빈 프레임 창, 빈 팝업을 나중에 이동. ② **맨 식별자**(`fname.document`)는 브라우저의 전역 조회라 훅이 못 본다. ③ 같은 사이트 자식 창의 **지역 별칭**에서 `w.top`/`w.parent` 는 원시 창이다(리라이터가 창 사슬을 별칭에서 안 감싼다 — CNN 렌더러 정지 이력).
- **규칙:** 프레임 접근 코드를 만질 때 "같은 물리 오리진이라 읽힌다" 를 정상으로 취급하지 말 것 — 네이티브 기준은 오리진이 다르면 던진다. 새 창 출처를 만들면 `windowHandleFor` 를 거치게 하고, 교차 사이트 대조군부터 돌린다.

## <a id="postmessage-타깃오리진"></a>`postMessage` 의 타깃 오리진을 한 번도 걸러 내지 않았다 — 옵션 형태는 SyntaxError (2026-10-02)

- **측정:** 교차 사이트 프레임에 `postMessage('ping', 조건)` — 네이티브는 `*`·정확한 오리진만 도착, **틀린 오리진·내 오리진·`/`·인자 하나는 버려진다.** 프록시는 전부 도착했다. 같은 사이트 프레임에 교차 사이트 오리진을 지정해도 도착. `postMessage(msg, { targetOrigin: '*' })` 는 네이티브가 전달하는데 프록시는 `SyntaxError`.
- **원인:** `normalizePostMessageTargetOrigin` 이 http(s) 오리진을 **전부 프록시 오리진으로** 바꿨다. 모든 프레임이 그 오리진을 공유하므로 브라우저의 오리진 필터가 영영 안 걸린다 — 한 사이트에 보낼 메시지가 다른 사이트의 프레임(광고)에 도착했다. 옵션 객체는 `String()` 으로 `"[object Object]"` 가 돼 네이티브가 던졌다.
- **수정:** 래퍼가 두 시그니처를 구분하고, 목적지 창의 **가상 오리진**(`windowHandles.originOf`)과 요청한 오리진을 비교해 어긋나면 조용히 버린다. `/` 는 보내는 쪽의 오리진, 인자 없음은 `/`. 목적지를 모르면(멤브레인·라우트 없음) 브라우저에 맡긴다.
- **검증:** e2e `pm.*` 표(교차·같은 사이트 × 정확/틀림/내 오리진/`/`/`*`/인자 하나/옵션 3종/잘못된 URL) — 네이티브와 같다.
- **`pm-drop` 진단:** 버려진 메시지는 흔적이 없어서(네이티브도) 최상위 `__zp_diagnostics` 에 `{"t":"pm-drop","wanted","dest","from","to","at"}` 를 남긴다(최대 200개). `to` 는 목적지 창의 역할(`self`·`parent`·`top`·`opener`·`childN`·`other`)과 물리 URL, `at` 는 호출 스택 3줄. **NAVER 메인에서 두 건이 찍히는 것은 정상이다:** React `useEffect` 가 막 만든 iframe(shopsquare·recoshopping)에 `updateTheme` 을 마운트 직후 보내는데, 그때 그 창은 아직 `about:blank`(부모의 오리진을 물려받음)라 네이티브도 버린다 — 네이티브 자식의 수신 로그에 `updateTheme` 이 없고 `pid`·`setOuterPageInfo` 만 있다(프록시도 같다). 새 드롭이 보이면 먼저 "목적지가 아직 `about:blank` 인가"를 본다.

## <a id="메시지-이벤트-수신측"></a>부모가 보낸 메시지의 `e.origin` 이 프록시 주소였다 — 맨 `addEventListener` 는 래퍼를 아예 건너뛰었다 (2026-10-02)

- **측정:** 자식 프레임이 부모의 메시지를 받으면 `e.origin === "http://proxy.localhost:18080"`(네이티브: 부모의 오리진), `e.source === parent` 거짓. 같은 사이트·교차 사이트 모두. 리스너를 `window.addEventListener`/`self.`/`onmessage` 로 달면 오리진은 맞았고 **맨 `addEventListener("message", f)` 만** 날 이벤트를 받았다.
- **원인(셋):** ① 오리진 조회가 **realm 별 `Symbol`** 마커(`ev.source[marker]`)라 부모·형제·opener 의 창은 읽지 못했다 → 가상화 없이 통과. ② `EventTarget.prototype.addEventListener` 래퍼가 `this === window` 일 때만 감쌌는데 맨 호출의 수신자는 `undefined`(브라우저는 전역으로 취급). ③ 가상화 이벤트를 `new MessageEvent` 로 **다시 만들어서** `isTrusted` 가 false, `target`/`currentTarget` 이 null, `stopImmediatePropagation` 이 진짜 디스패치에 무효였다.
- **수정:** 창이 자기 가상 오리진을 직접 말한다(`windowHandles.originOf` — 어느 realm 에서든 `__zp_get(win,'location').origin`). 수신자가 nullish 면 그 realm 의 창으로 본다(각 realm 이 자기 프로토타입을 감싸므로 항상 맞다). 이벤트는 **진짜 이벤트**에 비열거 own `origin`/`source` 를 얹는다. `e.source` 는 `windowHandleFor` 가 준 핸들 — `=== iframe.contentWindow`, `=== parent`.
- **같이 나온 지문:** `postMessage.name` 이 minify 된 `n`, `.length` 3(네이티브 1).
- **검증:** e2e `reply.*`(자식이 맨 리스너로 받아 `e.source.postMessage` 로 답장 — 부모는 답장이 자기가 쥔 핸들에서 왔다고 본다), `source.*`.
## <a id="storage-이벤트-교차-사이트"></a>한 사이트의 localStorage 쓰기가 다른 사이트 프레임의 `storage` 이벤트로 새고 있었다 — 물리 키·값·내부 키까지 (2026-10-02)

- **측정:** localhost 부모 + 127.0.0.1 자식(다른 사이트)을 네이티브/프록시에서 같은 코드로. 네이티브는 다른 오리진의 쓰기를 듣지 못한다(`[]`). 프록시는 부모가 자식의 쓰기를 **물리 키(`zp:l:<해시>:키`)와 새 값 그대로** 들었고, 아무도 쓰지 않은 `__zp_hb`(100ms 마다 창마다)·`__zp_trace_log`(6KB 내부 추적)·`zp:n:…`(창 이름 저장) 이벤트가 쉬지 않고 도착했다. 같은 사이트 이벤트도 키에 접두가 붙었고 `e.storageArea === localStorage` 가 거짓(진짜 Storage)이었다.
- **원인:** 모든 프록시 사이트가 한 물리 오리진을 공유해서 브라우저가 `storage` 이벤트를 모든 프레임에 뿌린다. 파사드는 읽기·쓰기만 접두로 갈랐고 이벤트는 손대지 않았다. `dispatchStorageEvents`/`storageWindows` 는 호출하는 곳이 없는 죽은 코드였다 — 이벤트를 합성한다고 믿게 만드는 이름이라 더 오래 숨었다(지웠다).
- **수정:** `installStorageFacades` 가 창마다 **캡처 단계 첫 리스너**를 단다. 신뢰된(native) 이벤트만 다룬다 — 자기 네임스페이스(`zp:l:<해시>:` / `zp:s:<탭>:<해시>:`, `__zp_` 숨김 키 제외)가 아니면 `stopImmediatePropagation` 으로 삼키고, 맞으면 진짜 이벤트에 비열거 own `key`(접두 제거)·`storageArea`(파사드)·`url`(가상 URL)을 얹는다. 페이지 리스너(`addEventListener`·`onstorage`·`<body onstorage>`)는 전부 그 뒤에 돈다. 페이지가 만들어 `dispatchEvent` 한 이벤트(`isTrusted` 거짓)는 건드리지 않는다. 이미 번역된 이벤트는 own `storageArea` 로 알아본다(임베더와 자기 prelude 가 둘 다 깐 창).
- **남은 차이(ERRATA 잔여):** ① 파사드 `clear()` 는 자기 키를 하나씩 지워(진짜 `clear()` 는 다른 사이트 것까지 지운다) 같은 사이트 창이 키마다 이벤트 하나를 듣는다(네이티브: `key: null` 하나). ② `e.url` 은 쓴 문서가 아니라 받는 문서의 가상 URL 이다(오리진은 맞다). ③ `getOwnPropertyNames(e)` 에 `key`·`storageArea`·`url` 이 보인다.
- **규칙:** "물리 오리진 하나를 공유한다" 는 읽기·쓰기만이 아니라 **브라우저가 모든 같은-오리진 창에 뿌리는 이벤트**로도 샌다. 새 격리 면을 만들 때는 그 면의 이벤트 쪽도 네이티브와 같은 코드를 돌려 비교한다(BroadcastChannel·locks 는 접두로 막혀 있다). 이름이 메커니즘을 약속하는 코드는 호출자를 확인한다.
- **검증:** e2e `storage events stay inside the writing site and match native`(교차 사이트 쓰기·같은 사이트 쓰기·같은 값 다시 쓰기·갱신·삭제·`onstorage`·자식 쪽 수신·합성 이벤트). 리스너를 끄면 이 테스트만 빨갛다 — 모든 프로브가 `__zp_hb` 로 넘친다(2026-10-02, 변이 확인).
## <a id="fetch-set-cookie-미러"></a>서버가 fetch/XHR 응답으로 건 쿠키가 `document.cookie` 에 안 보였다 — 페이지의 쿠키 사본은 로드 시점 스냅샷이었다 (2026-10-02)

- **측정:** 같은 코드를 네이티브/프록시에서. `await fetch("/xsetcookie?n=ck")`(응답 `Set-Cookie: ck=tok; Path=/`) 뒤 `document.cookie` — 네이티브는 `ck` 가 있고 프록시는 없다. XHR·`cookieStore.get`·`cookieStore` change 이벤트도 같다. HttpOnly 는 둘 다 안 보인다. 다음 요청의 `Cookie` 헤더에는 실렸다(SW 의 jar 는 맞았다) — 그래서 서버 쪽 시험은 통과해 왔다.
- **원인:** 쿠키의 진실은 SW 의 jar 인데, 페이지의 `documentCookieRecords` 는 부팅 때 받은 스냅샷(`boot.documentCookie`)에 자기 `document.cookie = …` 쓰기만 얹은 사본이다. 응답의 `Set-Cookie` 를 페이지에 알리는 길이 없었다. 흔한 패턴(API 응답이 CSRF 토큰 쿠키를 내리고 스크립트가 읽는다)이 문서를 다시 로드하기 전까지 안 보였다.
- **수정:** SW 가 `transportFetch` 에 `cookieDelta` 를 두어 **홉마다**(리다이렉트 포함, `credentials` 가 허용한 것만) HttpOnly 가 아닌 `Set-Cookie` 줄을 `{line, url}` 로 모으고, 페이지가 이미 읽는 `X-ZP-Fetch-Meta` 에 `cookies` 로 싣는다. `createFetchResponseAdapter` 가 응답을 내주기 **전에** 콜백(`applyResponseCookies`)을 부른다 — Promise 가 풀릴 때 이미 보인다. `setDocumentCookie(line, from)` 은 응답의 URL 로 기본 domain/path 를 잡고, 이 문서가 읽을 수 없는 호스트의 쿠키는 보관하지 않는다. fetch·XHR·`sendBeacon`·EventSource 는 모두 `fetchThroughRuntime` 한 길이라 한 번에 붙는다.
- **남은 틈(ERRATA 잔여):** 다른 문서의 응답(프레임 내비게이션·다른 탭)·`<img>`/`<script>`/동기 XHR 응답의 쿠키는 그 문서가 다시 뜰 때까지 사본에 없다. 같은 사이트 프레임끼리도 런타임에 쓴 쿠키를 서로 못 본다(부모↔자식 양쪽 측정; `localStorage` 는 공유). 공유하려면 SW 가 탭의 모든 클라이언트에 변경을 밀어 주고 경쟁 쓰기의 순서 규칙을 정해야 한다.
- **같이 바로잡은 것:** ERRATA 의 "same-site 프레임 사이 쿠키/스토리지 — parity" 는 자식이 뜨기 **전에** 쓴 쿠키만 읽은 측정이라 쿠키 쪽은 틀렸다(스토리지는 맞다) — 행을 둘로 나눴다.
- **규칙:** "서버가 줬다" 와 "페이지가 읽는다" 는 다른 경로다. 쿠키를 만지는 변경은 응답 → `document.cookie` 방향도 네이티브와 비교한다(요청에 실리는지만 보면 이 구멍이 안 보인다).
- **검증:** e2e `cookies set by fetch and XHR responses are visible to the page and match native`(일반·HttpOnly·XHR·리다이렉트 홉·`credentials: omit`·갱신·`Max-Age=0`·`cookieStore`·change 이벤트·다음 요청에 실리는 것). SW 가 쿠키를 보고하지 않게 하면 이 테스트만 빨갛다(2026-10-02, 변이 확인).
## <a id="쿠키-변경-푸시"></a>다른 문서·`<img>`·`<script>`·동기 XHR·형제 프레임·다른 탭이 건 쿠키가 이 문서의 `document.cookie` 에 안 보였다 — SW 가 변경 레코드를 밀어 준다 (2026-10-02)

- **측정:** 같은 코드를 네이티브/프록시에서. 같은 사이트 iframe 의 문서 응답이 건 쿠키·`<img>`/`<script>` 응답이 건 쿠키·동기 XHR 응답이 건 쿠키(바로 읽기)·형제 프레임이 `document.cookie` 로 쓴 쿠키·다른 탭이 쓴 쿠키 — 네이티브는 즉시 보이고 프록시는 문서를 다시 열 때까지 안 보였다(`fetch.then.sentBack` 처럼 **다음 요청에는 실렸다**). 앞서 "fetch/XHR 응답" 하나만 닫았고(항목 34) 나머지는 잔여로 남겨 뒀다.
- **원인:** 쿠키의 진실은 SW 의 jar(등록가능 도메인 단위로 **탭끼리도 공유**)인데, 페이지의 사본은 부팅 스냅샷 + 자기 쓰기 + 자기 fetch 응답뿐이었다. 다른 곳에서 일어난 변경을 알리는 길이 없었다. 같은 사이트 프레임도 문서(realm)마다 사본이 따로였다.
- **수정:** ① jar 의 `setCookieLine` 이 **변경 레코드**(`name value domain hostOnly path secure expires deleted id`)를 돌려주고 리스너에 알린다 — `Domain` 거부·세션 쿠키·삭제는 jar 의 결정 하나로. ② `queueCookiePush`/`flushCookiePush`: 한 마이크로태스크에 모아 `clients.matchAll` 로 창을 돌며, 그 jar 를 쓰는 탭의 클라이언트 중 **호스트가 그 쿠키를 볼 수 있는 것에만** 보낸다(서드파티 프레임에 다른 사이트의 쿠키 값이 가지 않는다). HttpOnly 는 워커를 안 떠난다. 쓴 문서 자신에게는 보내지 않는다(`COOKIE_SET` 의 `event.source`). ③ 페이지는 이미 쓰던 SW 메시지 채널(`ENCODED_SIZE` 와 같은)에서 `ZP_COOKIE_CHANGE` 를 받아 `applyCookieChanges` — id 로 한 번만, 도메인/경로 규칙은 읽을 때, 삭제는 `expires: 0`. 응답 메타(`record.cookies`)도 같은 함수를 탄다(둘이 겹치면 id 로 걸러진다). ④ 동기 XHR 은 호출자가 돌아오자마자 읽으므로 변경을 **응답 헤더**(`X-ZP-Cookie-Delta`, base64 JSON)로 싣는다 — Go 릴레이의 응답 헤더 허용 목록(`safeSyncHeader`)에 한 줄 추가했다(`Set-Cookie` 는 여전히 통과 못 한다).
- **남은 차이(ERRATA 잔여):** 전달은 **비동기**다 — 한 프레임의 쓰기를 다른 프레임이 **같은 태스크 안에서** 읽으면 옛 값이다(네이티브는 공유 jar 가 즉시 답한다).
- **함정(환경):** 공유 taskweaver 브라우저(`zp`)의 **옛 SW** 가 살아 있으면 같은 Go 서버의 `sync-fetch` 큐를 대신 폴링해 **내 빌드의 작업을 가로챈다** — 응답 헤더에 새 코드의 흔적이 안 나와 코드를 의심하게 된다(디버그로 `out.v` 를 바꿔도 `r4` 그대로였다). 동기 XHR·SW-less 릴레이를 시험하기 전에 `zp_reset_proxy_state` 와 `navigate about:blank` 로 그 SW 를 치운다.
- **규칙:** 상태가 "문서마다 사본" 이면 사본을 갱신하는 길이 **응답·푸시·다른 탭** 셋 다 있는지 확인한다. 다른 호스트의 비밀(쿠키 값)을 나르는 푸시는 **받는 쪽이 아니라 보내는 쪽에서** 걸러야 한다.
- **검증:** e2e `cookies reach every document that can see them, and no other (matches native)`(프레임 내비게이션·이미지·스크립트·동기 XHR·형제 쓰기·다른 사이트 프레임·`cookieStore` 이벤트), `a cookie reaches the other tab of the same site (matches native)`. 푸시를 끄면 앞의 것만, 동기 XHR 헤더를 끄면 `sync.xhr.immediately` 하나만 빨갛다(2026-10-02, 변이 확인 둘). prelude 단위 테스트 4개(id 한 번, 읽을 수 있는 것만, 삭제·세션·경로, 쓰레기 입력), Go `TestSafeSyncHeader`.
## <a id="window-name-locks-오리진-공유"></a>같은 사이트 자식의 `window.name` 이 부모의 것이었고 `navigator.locks.query()` 가 모든 사이트의 잠금을 돌려줬다 (2026-10-02)

- **측정:** 부모(localhost)가 `window.name = "parent_window_name"` 을 정하고 이름 없는 같은 사이트 iframe 의 `window.name` 을 읽게 했다 — 네이티브 `""`, 프록시 `"parent_window_name"`. 이름을 준 iframe(`child_named`)도 자기 이름이 아니라 부모의 이름을 읽었다(저장소에 값이 있으면 시드를 건너뛴다). 교차 사이트 자식은 같은 탭에서 앞서 뜬 그 사이트 문서가 남긴 이름(`xechocross`)을 읽었다 — 이름이 문서가 아니라 (탭, 오리진)에 붙어 있었다. 부모가 `zp_names_lock` 을 쥔 채 교차 사이트 자식이 `navigator.locks.query()` — 네이티브 `held: []`, 프록시 `held: ["zp:lk:<해시>:zp_names_lock"]`(다른 사이트의 이름 + 프록시를 가리키는 접두).
- **원인:** 둘 다 **물리 오리진 하나** 위의 상태다. 창 이름 저장소는 (탭 세션, 오리진 해시) 키 하나라 같은 사이트의 모든 창이 한 슬롯을 공유했다 — 이름은 오리진이 아니라 browsing context 의 것이다. 자식이 스스로 이름을 지으면 같은 슬롯에 썼다(이름 있는 iframe 은 저장소가 비어 있을 때만 시드했다). 잠금은 이름에 접두를 붙여 가르면서 `query()` 결과는 **자기 접두의 접두 제거만** 하고 걸러 내지 않았다.
- **수정:** 프레임은 저장소를 쓰지 않고 **진짜 `name`** 을 그대로 쓴다(iframe 의 `name` 속성값이고, 프레임이 이동해도 남고, `target=` 이 찾는 것이며, 우리는 거기에 아무것도 쓰지 않는다). 최상위 창만 세션 저장소 슬롯을 쓴다(탭 안 내비게이션을 가로질러 남아야 한다). `LockManager.query()` 는 자기 접두의 잠금만 남기고 접두를 뗀다.
- **규칙:** `storage`·쿠키·이름·잠금처럼 "오리진마다 하나" 인 상태를 가상 오리진별로 가를 때 **읽기·쓰기 경로 모두** 갈랐는지, 그리고 **목록 API**(`query()`·`databases()`·`keys()`)가 남의 것을 걸러 내는지 네이티브와 같은 코드로 비교한다. 이름이 "오리진 기준" 인지 "창 기준" 인지부터 정한다.
- **검증:** e2e `window.name stays with its own frame and lock queries stay inside the site`(이름 없는·교차 사이트·이름 있는 자식, 자식이 이름을 지은 뒤 부모, `locks.query()`). 고치기 전 코드에서 이 테스트만 빨갛다(2026-10-02, 변이 확인).
## <a id="sandbox-불투명-프레임-에뮬레이션"></a>`sandbox` 에 `allow-same-origin` 이 없는 iframe — 지우던 것을 불투명 오리진 에뮬레이션으로 바꿨다 (2026-10-02)

- **증상:** `sandbox="allow-scripts"`·`sandbox=""` iframe 이 삽입 즉시 DOM 에서 사라졌다(옛 동작, fail-closed; 이 작업 전 빌드 `5239a4d` 도 같다). 건너뛰게 하면 자식 문서가 프록시에서 403 을 받고 prelude 가 `localStorage` 에서 중단돼 **절반만 설치된 문서**에서 페이지 스크립트가 돌았다 — 그래서 한 번은 되돌렸다.
- **원인:** 불투명 오리진 문서는 임베더가 읽지도 패치하지도 못하고, SW 가 제어하지 못해 프록시가 서빙할 수 없고, 오리진 제한 API 를 못 쓴다. 이 프록시는 모든 프레임이 물리 오리진 하나를 공유하는 설계라 진짜 불투명 오리진을 줄 수 없다.
- **수정:** 페이지가 준 플래그는 그대로 두고 `allow-same-origin` 만 덧붙인다(스크립트·폼·팝업·모달·최상위 내비게이션은 브라우저가 그대로 막는다). 요소에 `data-zp-opaque` 표식과 페이지 값 스태시(`data-zp-lit-sandbox`). 자식 prelude 는 부팅 때 **임베더에게** 묻는다(`__zp_frame_opaque` — 자기 realm 의 natives 는 이미 임베더의 훅일 수 있다). 불투명 문서는 `self.origin`·`location.origin`·`e.origin` 이 `"null"`(밑에서는 문서마다 다른 `null#…` 토큰 — 서로 교차 오리진), 저장소·쿠키·`caches`·`cookieStore`·`serviceWorker`·OPFS·`locks.request` 는 네이티브와 같은 메시지의 SecurityError(또는 그 거부), `storage.estimate()` 는 TypeError 거부, `Notification.permission`·`permissions.query` 는 denied, `document.domain` 은 빈 값. `parent`·`top`·`frameElement`·형제는 교차 오리진 스탠드인, 최상위·임베더 내비게이션은 `allow-top-navigation*` 없이는 SecurityError(user activation 반영), 안에서 만든 프레임도 불투명(네이티브 실측). 런타임 fetch/XHR 은 `Origin: null`, 쿠키는 `credentials: 'include'` 일 때만.
- **함정(순서):** 브라우저는 **내비게이션 시작 시점**에 sandbox 플래그를 고정한다 — `sandbox` 재작성은 `src`/`srcdoc` 보다 먼저여야 한다(`routeFrameSrc`·`restorePending*` 첫 줄, 마크업은 문자열을 넣기 **전에** HTML walker 가). 페이지 값은 직렬화를 건너야 하므로 스태시가 있어야 복제본·`innerHTML` 이 다시 세운다. `allow-scripts allow-same-origin`(탈출 조합)은 기존대로 속성을 지우고 값은 WeakMap 에 둔다.
- **규칙:** 불투명 프레임을 "가둘 수 없다" 며 지우거나 건너뛰지 말 것 — 지우면 광고·위젯이 사라지고, 건너뛰면 절반 설치 문서가 돈다. 격리의 마지막 선은 자식 prelude 의 **네임스페이스 분리(fail-private)** 와 브라우저가 계속 강제하는 플래그다. 거부 목록은 코드이므로 새 오리진 제한 API 가 생기면 거기에 넣는다.
- **검증:** e2e `sandboxed frames are opaque to the page and to each other, as natively`(생성 방식 9가지·프레임마다 약 40개 프로브·형제·최상위 내비게이션·모든 경로의 egress 시도 + 마지막 와이어 단언; 불투명 감지를 끄거나 sandbox 재작성을 빼면 빨갛다), prelude 단위 테스트(opaque 토큰·sandbox 플래그·창 핸들·변이 확인), 탐색 프로브 85/85 동일.
- **잔여:** 불투명 프레임의 `<img>`·`<script>` 는 사이트 쿠키를 싣는다(런타임 fetch 만 `Origin: null`), 거기서 연 팝업은 불투명이 아니다, 복제한 프레임은 삽입 전에 재작성된 값을 보인다 — ERRATA 잔여.

## <a id="마크업으로-만든-프레임-파킹"></a>`innerHTML`·`insertAdjacentHTML`·`<template>`·`document.write` 로 만든 iframe 이 영영 빈 채였다 (2026-10-02)

- **측정:** 네이티브에서 뜨는 `host.innerHTML = '<iframe src="/x">'` 프레임이 프록시에서 `about:blank` 로 남는다(`insertAdjacentHTML`·`<template>` 복제도). `createElement` + `src` + `appendChild` 는 뜬다. 이 작업 전 커밋(`1bd3059`)에서도 같다 — 회귀가 아니다. `document.write`·`setHTMLUnsafe`·`outerHTML`·`DOMParser` 는 같은 경로(walker)를 타므로 같은 원인이다.
- **원인:** 페이지 realm 의 HTML walker(`transformHTML`)는 문자열을 **죽은 파서 문서**의 `<template>` 에 파싱해 속성을 고친다. iframe `src` 도 거기서 `routeFrameSrc` 로 라우트를 열었는데 완료(`activatedFrameURL().then`)는 **그 죽은 요소**에 쓴다. 직렬화된 문자열에는 `src="about:blank"` 만 남고 진짜 프레임은 라우트를 받지 못한다. `<template>` 내용도 같다(라우트가 템플릿 요소에 닿고 복제본은 못 받는다).
- **수정:** 서버 htmltx 처럼 **파킹**한다. inert 문서(`defaultView` 가 null: walker 복사본·템플릿 내용·DOMParser 문서)의 프레임은 라우트를 열지 않고 페이지 원문을 `data-zp-frame-src` 에 두며 `src` 는 `about:blank` 로 **제자리에서** 바꾼다 — 지우고 다시 달면 속성 순서가 뒤로 밀려 `innerHTML` 에 보인다. 활성화 시점(HTML 세터·`insertAdjacentHTML`·`setHTMLUnsafe`·`document.write` 뒤, 노드 삽입 훅 뒤)에 `restoreParkedFrames` 가 후킹된 `setAttribute` 로 되돌린다. 페이지가 직접 `src` 를 쓰면 파킹 값이 낡은 것이라 `routeFrameSrc`·`cancelFrameRoute` 가 지운다. `getAttribute('src')`·직렬화·`.src` 는 파킹 중에도 페이지 원문을 돌려준다. srcdoc 프레임은 walker 의 `data-zp-lit-srcdoc` 스태시로 페이지 텍스트를 되살린다 — 안 하면 `frame.srcdoc` 이 주입된 문서(prelude 태그와 boot JSON)를 읽는다.
- **함정:** (1) inert 문서에서는 라우트를 열지 말 것 — 완료가 죽은 요소에 쓴다. (2) 인라인 `<script>` 는 `__ZP_EXEC_INLINE_SCRIPT` 가 **HTML 엔티티를 디코드**한다(React `dangerouslySetInnerHTML` 용 의도된 절충 — `decodeInlineEntities`). e2e 픽스처의 JS 문자열에 `&quot;` 를 쓰면 따옴표로 풀려 마크업이 깨지고 SyntaxError 가 자식 prelude 안에서 난다. 값을 코드로 조립할 것(`'&' + 'quot;'`).
- **규칙:** 문서에 닿는 HTML 경로를 새로 만들면 **파킹된 프레임 복원**을 같이 건다. `MutationObserver` 백스톱은 최초 문서에 안 걸려 있다(`observedDocuments` TDZ 주석). 프레임을 많이 만드는 e2e 는 공유 페이지에서 돌리지 말 것 — 프레임마다 합동 히스토리가 한 칸씩 늘어 50칸 상한에서 뒤 테스트의 `history.length` 증분이 0 이 된다(2026-10-02, `frame load events and history`).
- **검증:** e2e `frames made from markup load and read back as natively`(innerHTML·insertAdjacentHTML 3방향·setHTMLUnsafe·outerHTML·template import/clone·createContextualFragment·DOMParser adopt·document.write, `src`·`srcdoc` 읽기·직렬화), prelude 단위 테스트(파킹·복원·변이 확인).

## <a id="맨-frameelement-누출"></a>맨 식별자 `frameElement` 가 임베더의 iframe 요소를 내줬다 (2026-10-02)

- **측정:** 교차 사이트·불투명 자식에서 `window.frameElement`·`self.frameElement` 는 `null`(훅)인데 `frameElement` 맨 식별자는 요소를 돌려줬다 — 부모 DOM 으로 가는 길(`frameElement.ownerDocument`, `.parentNode`).
- **원인:** 맨 식별자는 브라우저의 전역 조회로 풀려 어떤 훅도 안 본다. rewriter 의 `DANGEROUS_GLOBALS` 에 없었다(`window`·`self`·`globalThis` 경유 형태만 훅돼 있었다).
- **수정:** `frameElement` 를 `DANGEROUS_GLOBALS` 에 추가(Rust `zp-rewriter`) — 스코프 퍼사드(`scopeGet`)를 거쳐 가상 프레임 요소 규칙을 탄다.
- **규칙:** 창의 접근자를 훅할 때는 **맨 식별자 형태**도 `DANGEROUS_GLOBALS` 에 있는지 본다. 단위 테스트가 접근자별 4가지 형태(`window.x`·`self.x`·`globalThis.x`·맨 `x`)를 비교한다.
- **검증:** Rust `rewrites_bare_frame_element`, e2e `sandboxed frames are opaque…`(`frameElement`·`typeof frameElement`·별칭 `window`).

## <a id="쿠키-쓰기-직후-요청"></a>`document.cookie = x; fetch(…)` 의 요청이 방금 쓴 쿠키를 못 실을 수 있었다 (2026-10-02)

- **측정:** e2e `cookies set by fetch and XHR…` 의 `sent.back` 이 `ck_script=1`(방금 `document.cookie` 로 쓴 것)을 못 받는 실행이 이어졌다. SW 로그를 심으면 통과하는 **하이젠버그**였다 — 로그를 심은 실행에서는 쓰기가 요청보다 2 ms 먼저, 심지 않은 실행에서는 뒤에 닿았다.
- **원인:** jar 는 SW 에 있다. 쓰기(`postMessage`)와 요청(`fetch('/zp/api/v2/fetch')`)은 **다른 경로**로 가서 어느 쪽이 먼저 닿을지 정해져 있지 않다. 네이티브 jar 는 동기라 항상 실린다. 이 경쟁은 이 작업 전부터 있었다 — 이 작업이 확률을 바꿨을 뿐이다(베이스라인 2/2 통과, 이 작업 트리 3/3 실패).
- **수정:** 쓰기의 ack 를 `cookieWritesInFlight` 에 모으고 `postRuntimeEnvelope` 가 진행 중인 쓰기를 기다린 뒤 보낸다. 실패한 쓰기도 settle 되므로 요청을 막지 않는다. 내비게이션·`<img>` 는 기다릴 수 없다 — ERRATA 잔여. 동기 XHR 은 나중에 쓰기를 직접 싣는 것으로 풀었다([쿠키-동기-xhr](#쿠키-동기-xhr)).
- **규칙:** 간헐 실패를 로그로 재현하려는데 로그를 심으면 통과한다면 **타이밍 경쟁**이다. 로그를 더 심지 말고 순서를 보장하는 쪽으로 고친다. 두 메시지가 서로 다른 경로로 같은 목적지(여기서는 SW)에 가면 도착 순서에 기대지 않는다.
- **검증:** prelude 단위 테스트 `cookie writes: a runtime request waits…`, e2e `cookies set by fetch and XHR…` 를 같은 빌드에서 6회 연속 통과.

## <a id="삽입-문-스크립트"></a>`replaceChildren`·`insertAdjacentElement`·`Range.insertNode` 로 넣은 스크립트가 리라이트 없이 돌았다 (2026-10-02)

- **측정:** 같은 코드를 네이티브/프록시에서. 인라인 `window.__ins = location.href` 를 `host.replaceChildren(script)`·`insertAdjacentElement`·`Range.insertNode` 로 넣으면 프록시에서 **프록시 주소**를 읽는다(`appendChild`·네이티브는 페이지 URL). `before`/`after`/`replaceWith` 는 요소에는 훅이 있었고 **텍스트 노드**(`CharacterData`)에는 없었다.
- **원인:** 삽입 훅(`patchInsertion`)은 노드를 넣기 **전에** 스크립트를 준비한다(본문 리라이트·`src` 라우트). 훅 표에 없는 문으로 들어간 스크립트는 페이지가 쓴 그대로 브라우저에 가고, CSP 가 `'unsafe-inline'` 을 허용하므로 **멤브레인 밖에서** 돈다 — 거기서 `location` 은 진짜 Location 이고 대입은 실제 내비게이션이다. 감옥 문제다.
- **수정:** 표를 완성했다 — `append`·`prepend`·`replaceChildren`·`before`·`after`·`replaceWith`(Element·Document·DocumentFragment·CharacterData), `insertAdjacentElement`, `Range.insertNode`. 래퍼는 네이티브의 `length` 를 보고한다(`...args` 라 0 이었다).
- **규칙:** 새 DOM 삽입 API 는 훅 표에 넣을 때까지 구멍이다 — `ParentNode`·`ChildNode` 믹스인과 `Range` 의 목록을 표준과 대조한다. `Range.surroundContents` 는 새 부모로 기존 내용을 옮기는 것이라 스크립트를 실행하지 않는다(네이티브도 실행 안 함, 측정).
- **검증:** e2e `scripts put in by every insertion door run through the membrane (matches native)`(문 19개, 변이 3개 확인 — `replaceChildren`·`insertAdjacentElement`·텍스트 노드), 탐색 프로브 18/18 동일.

## <a id="불투명-쿠키-secure-loopback"></a>불투명 프레임의 요청이 사이트 쿠키를 실었고, `Secure` 쿠키는 `http://localhost` 에서 안 갔다 (2026-10-06)

- **측정:** 같은 픽스처를 네이티브/프록시에서. `sandbox` 에 `allow-same-origin` 이 없는 프레임의 `<img>`·CSS·`fetch` 요청이 네이티브에서는 `SameSite=None` 쿠키만 싣는다(불투명 오리진은 어느 사이트와도 교차 사이트). 프록시는 jar 전체를 실었고, 그 프레임의 응답이 건 `Lax`/기본 쿠키도 jar 에 남겼다. 고치다 보니 **같은 픽스처의 `SameSite=None; Secure` 쿠키가 프록시 jar 에서 아예 안 갔다** — 네이티브 Chrome 은 `Secure` 쿠키를 loopback(`localhost`·`*.localhost`·127/8·`::1`)의 http 로도 보낸다.
- **원인:** SW 는 요청을 만든 문서가 불투명인지 몰랐다 — 경로가 항목(entry)에 그걸 적지 않았다. `cookiesForURL` 은 `r.secure && url.protocol !== 'https:'` 로 loopback 을 `https` 가 아니라고 걸렀고, 페이지 쪽 `cookieRecordVisible` 도 같았다.
- **수정:** 라우트 등록(`FRAME_ROUTE`·`HISTORY_UPDATE`·`OPEN_SHARE`)이 `opaque` 를 싣고 항목이 보관한다. 전송 상태의 `initiatorOpaque` 가 jar 를 양방향으로 거른다(`cookiesForURL(…, crossSite)`·`setCookieLine(…, { crossSite })`). 보안 문맥 판정은 https 와 loopback(SW `secureForCookies`, 페이지 `cookieContextSecure`).
- **규칙:** 네이티브와 다른 값은 **요청 단위로 대조하라** — 최종 jar 만 비교하면 보내는 쪽 차이가 가려진다(픽스처 서버가 요청마다 받은 쿠키 이름을 태그로 남긴다). 쿠키 판정을 새로 만들면 loopback 의 Secure 규칙도 같이 확인한다.
- **검증:** e2e `a sandboxed frame sends and keeps only the cookies a cross-site context may (matches native)`, 변이 3개(요청 필터·응답 필터·loopback 보안 판정 되돌리기) 전부 실패로 잡힘.

## <a id="불투명-팝업"></a>불투명 프레임이 연 팝업이 불투명하지 않았다 (2026-10-06)

- **측정:** `allow-scripts allow-popups` 프레임의 `open()` 팝업이 네이티브에서는 `self.origin === 'null'`·저장소/쿠키/IDB/`caches`/`serviceWorker` 거부·`opener.document` SecurityError 다. 프록시 팝업은 사이트 오리진이었다.
- **원인:** 브라우저는 팝업에 opener 의 sandbox 플래그를 그대로 적용한다 — 에뮬레이트하는 것은 **오리진**인데, 팝업 경로는 opener 의 사이트만 알고 불투명 여부를 몰랐다(`OPEN_SHARE` 에 없음).
- **수정:** `OPEN_SHARE` 가 `opaque` 를 싣고(`allow-popups-to-escape-sandbox` 면 싣지 않는다) SW 항목이 부트 JSON 에 `opaque: true` 를 넣는다. 팝업의 prelude 는 `boot.opaque` 로 `opaqueDocument` 를 켠다. `sandboxFlags()` 는 팝업 경로도 쓰므로 `13-attrs.js` 로 올렸다.
- **규칙:** 에뮬레이트한 속성이 **새 창을 만드는 경로**(팝업·프레임 이동·`target`)를 따라가는지 따로 확인한다 — 속성은 요소가 아니라 문서에 붙는다.
- **검증:** e2e `a popup of a sandboxed frame is as opaque as the frame (matches native)`, 변이 2개 확인. 팝업이 쓰는 `document.cookie` 는 **그 테스트가 심은 쿠키 이름만** 비교한다 — 프록시 세션의 jar 는 앞선 서브테스트의 쿠키를 들고 있고 네이티브 브라우저는 새것이다.

## <a id="쿠키-동기-xhr"></a>`document.cookie = x` 직후의 동기 XHR 이 쿠키를 놓칠 수 있었다 (2026-10-06)

- **측정:** 쓰기를 SW 로 가는 `postMessage` 에 붙들어 두면(`ServiceWorker.prototype.postMessage` 를 감싼다) 동기 XHR 이 쓴 쿠키를 못 싣는다 — 경쟁을 결정적으로 만든 재현.
- **원인:** 비동기 요청은 쓰기의 ack 를 기다린다([쿠키-쓰기-직후-요청](#쿠키-쓰기-직후-요청)). 동기 호출은 기다릴 수 없다.
- **수정:** 동기 릴레이가 아직 ack 안 된 쓰기(최신 32개)를 `dv`(문서 URL) + `ck`(JSON `[id, line]`) 로 싣고, Go 가 모양과 크기를 검증해 잡에 넣고, SW 가 jar 를 읽기 전에 적용한다. 쓰기에 id(`wid`)가 있어 SW 는 어느 길이 먼저 와도 한 번만 적용하고 쓴 문서는 자기 쓰기의 푸시를 무시한다.
- **함정:** 처음에는 e2e 의 "붙들어 둔" 단계가 통과 후 **실패**했다 — 동기 루프 안에서는 ack 가 올 수 없어 대기 목록이 계속 자라는데, Go 가 **앞에서부터** 16개만 받아 가장 새 쓰기가 잘렸다. 페이지는 최신 32개를 보내고 Go 상한도 32 로 맞췄다(단위 테스트 둘).
- **검증:** e2e `a cookie written just before a synchronous XHR goes out with it (matches native)`(변이 확인), prelude 단위 테스트, Go `TestParsePendingCookies`.

## <a id="cors-적용"></a>CORS 를 적용하지 않아 허락 안 한 교차 오리진 읽기가 성공했다 (2026-10-06)

- **측정:** `localhost` 페이지가 `127.0.0.1` 에 `fetch` — 네이티브는 `Access-Control-Allow-Origin` 이 없으면 `TypeError: Failed to fetch`, 프록시는 `basic` 응답이 resolve. 사전 요청(preflight)·노출 헤더·리다이렉트·동기 XHR 도 전부 달랐다.
- **원인:** 요청은 SW 가 대신 보내므로 브라우저의 CORS 규칙이 걸릴 자리가 없었다. 응답의 `Access-Control-*` 는 `applyCORS` 가 프록시 오리진으로 **덮어쓴다** — 확인은 그 전에 업스트림 헤더로 해야 한다.
- **수정:** `transportFetchHop` 이 페이지의 cors 요청(`runtimeFetch && mode === 'cors'`)을 가상 오리진으로 판정한다 — 오리진을 벗어나면 오염(tainted)·"unsafe" 요청은 preflight·홉마다 CORS 확인·두 외부 오리진 사이 리다이렉트 뒤 `Origin: null`·URL 에 자격증명이 든 교차 오리진 리다이렉트 거부·노출 헤더 걸러내기(`__zpFetchMeta.expose`)·`type: 'cors'`. 거부는 `type: 'error'` 메타 응답으로 알려 페이지가 한 번만 reject 한다. 동기 XHR 은 `wc`(withCredentials)를 싣고 `ZP_NETWORK_ERROR` 로 `send()` 가 `NetworkError` 를 던진다.
- **함정:** (1) 거부를 `Response.error()` 로 돌려주면 페이지의 `postRuntimeEnvelope` 가 "엔드포인트가 죽었다" 로 읽고 v1 로 **다시 보낸다** — 거부된 요청이 서버 로그에 두 번 찍혔다. 오류도 **타입이 있는 응답**이어야 한다. (2) 동기 XHR 릴레이는 응답 헤더 다섯 이름만 통과시켜 `getResponseHeader('x-…')` 가 원래 못 읽었다 — 읽을 수 있는 헤더를 `X-ZP-Sync-Visible` 한 값으로 실어 보낸다. (3) 리다이렉트의 자격증명 검사는 `canonicalTargetURL` 이 userinfo 를 지우기 **전** URL 로 해야 한다. (4) 표준은 `Access-Control-Allow-Headers: *` 가 `Authorization` 을 덮지 않게 하지만 기준 Chrome 148 은 덮는다 — 기준(네이티브)을 따른다. (5) `<a ping>` 은 CORS 요청이 아니다(타깃 응답과 무관하게 나간다) — `fetchThroughRuntime` 의 `internal.mode: 'no-cors'`. EventSource 가 붙이는 `Cache-Control: no-cache` 는 브라우저가 붙이는 헤더라 preflight 를 부르면 안 된다 — `implicitHeaders`. (6) 실사이트(GitHub·CNN·NAVER·Guardian·BBC·Wikipedia)에서 SW 거절 목록(`__zp_refusals()`)을 보면 거절은 전부 `sendBeacon` 텔레메트리(credentials + `ACAO: *` 또는 헤더 없음)였고 업스트림에 `curl -H Origin` 으로 확인했다 — 네이티브도 막는다.
- **규칙:** 요청을 대신 보내는 계층은 브라우저가 해 주던 검사를 **전부 물려받는다** — 표준 알고리즘을 단계별로 옮기고 네이티브와 요청 로그까지 대조한다. 한 묶음(약 70건)의 차이 목록을 `direct vs proxied` 경로별로 출력하는 스크립트가 어설션 출력보다 훨씬 빨랐다.
- **검증:** e2e `cross-origin fetch and XHR obey CORS…`(네이티브와 동일, 변이 5개: 확인·preflight·노출 걸러내기·오염·동기 릴레이 모드 전부 잡힘). 남은 것: 요소 로드의 CORS(`crossorigin`·모듈·폰트) — ERRATA 잔여.

## <a id="h2-content-length"></a>HTTP/2 POST 에 `Content-Length` 가 없어 Optimizely 가 400 을 줬다 (2026-10-06)

- **측정:** CNN 한 번 로드에 `logx.optimizely.com/v1/events` 가 400 열한 번(네이티브는 204). SW 가 보내는 본문(JSON 988바이트)은 온전했고, 같은 바이트를 curl 로 보내면 204.
- **원인(실험으로 좁힘):** curl 변형 — chunked(길이 없음)·빈 본문·잘린 본문은 400, 온전한 본문+길이는 204. Node `http2` 로 같은 요청을 **길이 헤더 유무만** 바꿔 보내면 없을 때만 400. 커널은 페이지의 `content-length` 를 일부러 지우고(전송 계층이 정한다) HTTP/2 경로는 그걸 다시 채우지 않았다. Chrome 은 본문이 있으면 늘 길이를 말하고, 본문 없는 POST/PUT 은 `Content-Length: 0` 이다.
- **수정:** `wants_content_length(method, body_len)` 한 규칙을 코덱에 두고 HTTP/1.1(`build_request_head`)과 HTTP/2(`send_request`, pseudo-header 바로 뒤)가 같이 쓴다.
- **함정:** e2e 타깃은 평문 HTTP 라 Go 가 길이를 알아서 붙인다 — 이 버그는 e2e 로는 **재현되지 않는다**. 실사이트(HTTPS/h2)에서만 보였다. 그래서 규칙을 순수 함수로 빼 코덱 단위 테스트로 못 박았다. 이전 ERRATA 의 "본문이 네이티브와 바이트 단위로 같다" 는 에코 서버로 쟀기 때문에 이걸 못 봤다.
- **규칙:** 에코 서버는 **프레이밍을 따지지 않는다** — 업스트림이 따지는 것(길이·청크·헤더 순서)은 실제 서버로 재현한다. 의심이 가면 같은 바이트를 헤더만 바꿔 직접 보내 본다(curl/Node h2).
- **검증:** CNN 로드의 Optimizely 응답 `[200,200,204,204,204,204]`(400 없음), 코덱 테스트 2개, e2e `request bodies are framed as natively`.

## <a id="swless-동적-스크립트"></a>worker 가 직접 답하지 않는 프레임에서 스크립트가 만든 스크립트가 로드되지 않았다 (2026-10-06)

- **측정:** CNN 콘솔 오류 26~59건(네이티브 4) — 이 중 `apstag.js` 503(`SW_NOT_READY`), PubMatic `/AdServer/layer` 스크립트 403, 뒤따르는 `Refused to execute script … 'text/html'`. 광고 칸이 검게 비어 있었다. `taskweaver start --record` + `dump-recording` 의 `initiator` 스택으로 어느 realm 이 요청했는지 가렸다.
- **원인 둘:** (1) srcdoc realm 이 **동적으로** 만든 스크립트 URL 에는 tab 이 없다 — 마크업을 걸을 때만 싣던 것([srcdoc-스크립트-바인딩](#srcdoc-스크립트-바인딩))을 realm 이 srcdoc 임을 아는 곳(`boot.proxyOrigin` 은 srcdoc 부팅 설정에만 있다)으로 넓혔다. (2) `document.write` 로 쓴 빈 프레임은 SW 클라이언트가 아니라서 그 안에서 만든 `<script src=/zp/api/script…>` 는 Go 로 직행해 403 이다. 마크업 스크립트는 부모가 대신 받는 로더로 바꿔 왔지만 동적 요소는 아니었다.
- **수정:** (2) 는 동기 릴레이(`kind=script`, 스타일시트가 이미 쓰는 길)로 보낸다 — 진짜 로드라 `onload`/`onerror` 가 그대로 난다(로더로 바꾸면 안 난다). 모듈·일반 문서의 스크립트·**죽은 파서 복사본**은 제외한다(복사본은 마크업을 걷는 중이라 URL 이 굳으면 안 된다).
- **함정:** 변이가 안 잡혔다 — 같은 프레임의 앞선 외부 스크립트가 이미 클라이언트를 묶어 둬서 동적 스크립트는 tab 없이도 돌았다. **첫 요청이 동적 스크립트인 프레임**을 따로 둬서 잡았다.
- **검증:** e2e `scripts in a srcdoc frame run in order…`(동적 스크립트 포함, 변이 1개), `a script a written frame creates is loaded, with its load event`(고치기 전 `errors:1`, 후 `ran:1, loads:1`). CNN 오류 26~59 → 18, `apstag.js` 200.

## <a id="srcdoc-스크립트-바인딩"></a>srcdoc 프레임의 외부 스크립트가 영영 안 돌았다 — 그 프레임은 자기를 탭에 묶을 수 없다 (2026-10-06)

- **측정:** srcdoc 프레임 안 `<script>…</script><script src=/lib.js></script><script>…lib 사용…</script>` — 네이티브는 셋 다 순서대로 돌고, 프록시는 첫 인라인만 돌았다. SW 거절 목록에 `SW_NOT_READY` 503(url 비어 있음 = `/zp/api/script` 경로).
- **원인:** 프렐류드는 자기 clientId 를 `BIND_CLIENT` 메시지로 탭에 묶는데, srcdoc 프레임은 **fetch 는 SW 에 통제되지만 `navigator.serviceWorker.controller` 가 null** 이라 메시지를 보낼 곳이 없다(프레임 안에서 직접 확인). 이미지 URL 은 `&tab=` 을 달고 있어 괜찮았고 스크립트 URL 은 없었다. SW 에 바인딩 로그를 심어 보니 `BIND_CLIENT` 는 최상위 두 번뿐이었다.
- **버린 길:** SW 가 바인딩을 800ms 기다리게 해 봤다 — 바인딩이 아예 안 오므로 소용없었다. 추측을 코드로 옮기기 전에 로그 두 줄로 가려냈다.
- **수정:** srcdoc 마크업을 걷는 동안(`forSrcdocMarkup`) 스크립트 URL 에 `&tab=&entry=` 를 싣고, `/zp/api/script` 가 묶이지 않은 클라이언트의 첫 요청에서 그 entry 로 클라이언트를 바인딩한다(워커 첫 요청과 같은 방식). 모듈의 후속 import 는 아무것도 달고 있지 않아 이 바인딩에 기댄다.
- **규칙:** "통제된다" 는 두 가지다 — fetch 가 SW 를 지나는 것과 `controller` 가 보이는 것. 바인딩을 메시지에 기대는 경로는 후자를 요구한다. 새 종류의 문서(srcdoc·blank·blob)가 생기면 **스크립트 하나와 모듈 import 하나**를 그 안에서 돌려 본다.
- **검증:** e2e `scripts in a srcdoc frame run in order…`(변이 2개: URL 에 tab/entry 를 싣는 것, 바인딩).

## <a id="swless-요소-cors"></a>worker 가 직접 답하지 않는 프레임의 요소는 CORS 판정을 못 받았다 (2026-10-06)

- **측정:** `document.write` 로 쓴 빈 프레임의 `<img|link|script crossorigin>` — 네이티브는 허락 없으면 실패, 프록시는 로드(`Origin` 없음, 쿠키 있음). srcdoc 프레임의 이미지·스타일시트는 이미 맞았다(자기 요청이 SW 를 지난다).
- **원인:** 그 프레임의 요소는 부모가 대신 가져온다 — 이미지는 `Native.fetch`(자리끼우개→blob), 스타일시트는 동기 릴레이(`kind=style`), 스크립트는 `__ZP_LOAD_EXTERNAL_SCRIPT` 의 fetch. 셋 다 요소의 요청이 아니라(destination 없음) [요소 CORS](#element-cors)가 안 걸렸다.
- **수정:** 부모가 요소가 `crossorigin` 으로 무엇을 물었는지 전한다 — fetch 는 `X-ZP-Element-CORS: anonymous|use-credentials`, 릴레이는 `&cors=`(Go 가 두 값만 통과), 스크립트 로더는 세 번째 인자. SW 는 헤더를 destination 대신 요소 표지로 읽는다. 거절된 이미지는 자리끼우개로 남지 않고 디코드 불가 `data:,` 가 되어 `error` 가 난다(정책 감시자가 이 값을 되돌리지 않게 예외).
- **함정:** 같은 일을 하는 두 경로(`setSubresourceAttribute` 의 즉시 처리, 자리끼우개 heal)가 겹쳐서 한쪽을 지워도 테스트가 통과했다 — 변이로 잡히지 않는 가드는 **중복**이다. 중복을 지우고 한 곳(heal)에서만 오류로 끝낸다.
- **검증:** e2e `crossorigin elements, modules and fonts obey CORS…`(쓴 프레임·srcdoc × 이미지·CSS·스크립트 × 허락/불허, DOM 으로 만든 이미지, 요청 로그까지 네이티브와 동일), Go `TestCorsMode`, 변이 5개.

## <a id="null-수신자-throw"></a>`null`/`undefined` 수신자의 재작성된 멤버 연산이 던지지 않고 `undefined` 를 돌려줬다 (2026-10-06)

- **측정:** `__zp_get(null, 'location')` → `undefined`(던지지 않음). 같은 코드를 네이티브에서는 `TypeError: Cannot read properties of null (reading 'location')`. 차단된 `window.open()` 의 null 에 `w.location.href` 를 읽는 코드가 프록시에서만 조용히 넘어갔다 — `try { … } catch` 로 갈리는 분기가 달랐다.
- **원인:** `get`/`set`/`del`/`ownKeys`/`okeys`… 가 `Reflect.xxx(Object(base), …)` 로 끝났다. `Object(null)` 은 `{}` 라서 연산이 **빈 객체 위에서 성공**한다.
- **수정:** 각 헬퍼 맨 앞에서 nullish(Reflect 계열은 비객체 전부)면 `nullishFail` — 진짜 연산(`b[p]`, `b[p]=0`, `delete b[p]`, `Object.keys(b)`, `Reflect.has/get/set/ownKeys(b)`)을 `//# sourceURL=<가상 URL>` 로 태그한 eval 코드에서 **수행**해 엔진이 던지게 한다.
- **함정:** (1) prelude 안에서 `throw new TypeError(…)` 하면 처리 안 된 에러의 `ErrorEvent.filename` 이 프록시 자산 URL 이 된다([에러-filename-누출](#에러-filename-누출)) — 던지는 자리를 eval 코드로 옮겼다. 메시지도 직접 쓰지 않고 V8 이 만들게 했다("reading 'x'" 의 키까지 동일). (2) 한 헬퍼가 `Object.*` 와 `Reflect.*` 를 같이 받으면(`getOwnPropertyDescriptor`) 메시지가 갈린다 — 둘 다 TypeError, 문구만 다르다(ERRATA 잔여). (3) `Reflect.get/set` 은 리터럴 위험 키면 `__zp_get/__zp_set` 로, **계산된 키**일 때만 `__zp_rget/__zp_rset` 로 간다 — 테스트에 계산된 키 케이스가 없으면 그 가드는 변이로 안 잡힌다(처음에 안 잡혀서 알았다).
- **규칙:** "비어 있는 객체로 바꿔 삼키는" 편의 코드(`Object(x)`)는 네이티브가 던지는 자리를 지운다. 그리고 **교란 요인 하나를 바꾸기 전에 실사이트에서 의존이 있는지 계측**한다 — 여기서는 진단 항목(`nullish`)을 던지는 자리에 남겨 7개 사이트의 모든 프레임에서 0건임을 확인했다.
- **검증:** e2e `member operations on null and undefined throw as natively`(88건 네이티브와 동일, 변이 9개), Naver 등 7개 사이트 정상·nullish 0건.

## <a id="element-cors"></a>`crossorigin` 요소·모듈·폰트에 CORS 를 적용하지 않아 허락 안 한 로드가 성공했다 (2026-10-06)

- **측정:** 네이티브/프록시 차분(`/xcorsel`): `<img|script|link crossorigin>`, 모듈 스크립트, `FontFace`, `@font-face` 를 다른 오리진에서 — 네이티브는 ACAO 가 없으면 `error`, 프록시는 로드됐다. 쿠키도 달랐다(네이티브 anonymous 는 교차 오리진에 쿠키 없음).
- **원인:** 브라우저는 SW 의 응답만 본다(`applyCORS` 가 자기 오리진을 허락). 타깃의 답을 규칙에 대 보는 곳이 없었다. 스크립트 요소는 `/zp/api/fetch` 가 아니라 **`/zp/api/script`** 경로로 온다 — 한 경로만 고치면 스크립트·모듈이 빠진다.
- **수정:** `elementCorsOptions(req, entry)` — `req.mode === 'cors'` 이고 **destination 이 있는** 요청만 요소다. 두 경로(`/zp/api/fetch` GET, `/zp/api/script`)가 `transportFetch` 에 같은 옵션을 준다. 프리플라이트는 하지 않는다(헤더가 브라우저 것). 요소는 같은 사이트에도 `Origin` 을 싣는다(Chrome 실측).
- **함정 셋:** (1) 부모가 worker 없는 프레임의 이미지를 대신 받는 `Native.fetch` 는 `mode: 'cors'` 지만 destination 이 **빈 문자열**이다 — 그걸 요소로 보면 `crossorigin` 없는 광고 이미지까지 거절된다. destination 을 요구한다. (2) `new FontFace(…, 'url(…)')` 는 어떤 훅에도 안 걸려 브라우저가 타깃으로 직접 나갔고 CSP(`font-src 'self'`)에 막혀 **모든 URL 폰트가 실패**하고 있었다 — `@font-face` 와 같은 `rewriteCSSText` 로 보낸다. (3) 폰트 로드 성공/거절은 `FontFace.load()` 의 `NetworkError` 로 구별이 안 된다(깨진 데이터도 같은 오류) — 테스트용 최소 유효 TrueType 을 바이트로 만들어 썼다(첫 시도에 Chrome 이 받아들임).
- **규칙:** 같은 종류의 요청이 **서로 다른 SW 경로**로 온다 — 규칙을 넣을 때 경로 목록을 먼저 센다(`/zp/api/fetch` GET·`/zp/api/script`·POST 봉투·동기 릴레이). 그리고 규칙이 잘못 걸리는 **내부 요청**(destination 없는 fetch)을 구별하는 필드를 먼저 정한다.
- **검증:** e2e `crossorigin elements, modules and fonts obey CORS as natively`(네이티브와 동일, 변이 6개), request-policy 단위 테스트 2개, 실사이트 7곳에서 요소 거절 0.

## <a id="swless-자리끼우개-빨강"></a>Naver 광고 이미지가 붉은 블록으로 보였다 — SW-less 자리끼우개가 살아 있는 요소에 남았고 그 픽셀은 투명이 아니라 반투명 빨강이었다 (2026-10-06)

- **측정:** 사용자 보고(Naver 에서 일부가 붉게 보이고 이미지가 안 뜬다). 같은 페이지에서 `naturalWidth === naturalHeight === 1` 인데 렌더 크기가 20px 넘는 이미지를 모든 프레임에서 센다 — 푸시된 `8a9ee8e` 에서 6~8장(광고 배너·우측 광고), `99f3bf4`(이 세션 이전)에서도 5~8장. 프레임 안 진짜 요소의 `src` 는 자리끼우개 data URL 이고 `data-zp-lit-src`/`data-zp-target-url` 은 진짜 CDN URL 이었다(격리 월드 `exec-js --world isolated --frame N` 으로 읽음).
- **원인 둘:** (1) 마크업은 먼저 죽은 파서 복사본에서 리라이트되고, 복사본이 SW-less 로 분류돼 `setSubresourceAttribute` 가 자리끼우개를 **마크업에 박은 채** 직렬화한다. blob 으로 바꾸는 콜백은 복사본의 요소에 붙어 있었고, 진짜 요소는 `upgradeSWLessURL` 이 "프록시 URL 이 아니면 return" 이라 다시 보지 않는다. (2) 자리끼우개 PNG 는 "투명" 이라 적혀 있었으나 디코드하면 `[filter 1, 255, 0, 0, 127]` — 반투명 빨강이다. 광고 칸 크기로 늘어나면 붉은 블록.
- **첫 판단의 오류:** 처음에 본 "정상" 스크린샷은 **8월 14일의 낡은 파일**이었다(`taskweaver screenshot --output` 의 상대 경로는 taskweaver 의 작업 디렉터리에 쓰이고, 저장소의 같은 이름 파일이 남아 있었다). 화면 속 날짜 표시("기림의 날")로 알았다.
- **수정:** 살아 있는 요소가 자리끼우개를 들고 있으면 `data-zp-target-url` 에서 다시 시작한다(worker 없는 문서면 blob, 아니면 프록시 경로). srcdoc 마크업을 걷는 동안은 자리끼우개를 박지 않는다(srcdoc 프레임은 자기 프렐류드로 이미지를 직접 받는다). 자리끼우개를 진짜 투명 PNG 로 바꿨다 — 바꿔치기가 실패해도 붉은 블록이 아니라 빈 칸이다.
- **규칙:** (1) 사용자가 "눈에 보이는 문제"를 말하면 스크린샷을 **새로 찍고 파일 시각을 확인**한 뒤 읽는다. (2) 화면 증상은 측정 가능한 지표로 바꿔서 이등분한다 — 여기서는 "1×1 소스가 늘어난 이미지 수". (3) 주석에 적힌 값("투명")을 믿지 말고 디코드한다.
- **검증:** e2e `images in frames and in markup end up as the real image, not the placeholder (matches native)`(변이 2개 확인). Naver 메인: 늘어난 자리끼우개 0장, 배너·광고 이미지 정상.

## <a id="csp-meta-스크립트-프리로드"></a>스크립트를 못 돌리는 sandbox 프레임의 `<script src>` 를 프록시 문서는 요청하지 않았다 — 프렐류드가 박은 CSP meta 때문이다 (2026-10-06)

- **측정:** 네이티브 Chrome 148 에서 같은 프레임을 `sandbox=""`·`allow-same-origin`·`allow-forms`·`allow-scripts…`·없음으로 열면 전부 `<script src>` 를 요청한다(프리로드 스캐너). 프록시 문서는 스크립트를 못 돌리는 프레임(`""`·`allow-same-origin`·`allow-forms`)에서만 그 스크립트를 요청하지 않았다 — 같은 프레임의 `<img>`·CSS 는 요청했다. 렌더된 문서의 `<script src>` 는 정상으로 리라이트돼 있었고 브라우저가 요청 자체를 안 했다(`PREQ` 에도 없음).
- **원인(실측으로 좁힘):** 네이티브 단독 실험 — 문서에 `<meta http-equiv="Content-Security-Policy">` 가 **하나라도** 있으면(허용 정책이든 `default-src 'none'` 이든, 인라인 스크립트 유무와 무관) 스크립트를 못 돌리는 프레임에서 `<script src>` 를 안 받는다. **헤더** CSP 는 받는다. 프렐류드는 헤더 옆에 같은 정책의 meta 를 맨 앞에 박고 있었다.
- **가설 중 틀린 것:** "`allow-same-origin` 을 덧붙이는 에뮬레이션 때문" — 네이티브에서 `allow-same-origin` 단독도 받아 온다. 가설을 코드로 파기 전에 네이티브 실험 하나로 가려냈다.
- **수정:** meta 를 뺐다. 헤더가 정본이고 응답 커밋부터 문서 전체에 걸린다(meta 는 그 뒤만). 2026-08-26 에 meta 의 근거("스트리밍에서 헤더가 안 먹는다")가 측정 도구 오류였음이 이미 밝혀져 있었다. 타깃이 스스로 건 meta CSP 는 그대로(`filter_meta_csp` 교집합).
- **규칙:** "방어 겹을 하나 더" 는 공짜가 아니다 — 브라우저의 **다른 동작을 바꾸는 부작용**이 있는지 네이티브로 단독 측정한다. 프록시가 문서에 심는 모든 노드(meta·스크립트)는 네이티브 문서에는 없던 것이다.
- **검증:** e2e `a script in a frame that may not run scripts is requested as natively`(네이티브와 20건 동일), meta 를 되돌린 변이는 6건 누락으로 실패. 전체 e2e·CSP 스위트 통과(헤더만으로 같은 차단).

## <a id="프레임-load-두-번"></a>`src` 로 라우팅한 프레임은 `load` 가 두 번(파싱된 프레임은 세 번), 히스토리가 두 칸이었다 (2026-10-01)

- **측정:** 같은 코드를 네이티브/프록시에서. `src` 를 붙인 뒤 append: `load` 리스너+`onload` 가 네이티브 1회(`Lo`), 프록시 2회(`LoLo`); append 뒤 `src` 대입·교체도 +1회씩; 교체 시 히스토리 증가분 네이티브 1, 프록시 2. **파싱된 `<iframe src onload=…>` 는 인라인 onload 가 3번**(파서의 빈 페이지 + 플레이스홀더 + 라우트된 문서).
- **원인:** `src` 훅이 먼저 `about:blank` 플레이스홀더를 싣고, 프레임 라우트가 준비되면 진짜 문서로 다시 `src` 를 쓴다. 플레이스홀더 이동마다 `load` 한 번 + (이미 문서가 있는 프레임이면) 히스토리 한 칸. htmltx 가 파싱된 프레임의 `src` 를 `data-zp-frame-src` 로 옮기므로 파서의 초기 빈 페이지 `load` 도 하나 더 얹혔다.
- **수정:** (1) 이미 라우팅된 문서를 보여 주는 연결된 프레임은 새 라우트가 준비될 때까지 문서를 그대로 둔다 — 네이티브도 새 문서가 커밋되기 전까지는 옛 문서가 남는다. 플레이스홀더도 이동도 없으니 `load` 도 히스토리 칸도 늘지 않는다. (2) 나머지(분리된 프레임·초기 빈 프레임·파싱된 프레임)는 플레이스홀더를 유지한다: 분리된 프레임이 라우트보다 먼저 삽입돼도 원시 URL 을 싣지 않아야 하고, `src` 속성이 **동기적으로 존재**해야 한다(`setAttributeNode`/`attributes.setNamedItem` 이 훅 세터를 돌린 뒤 속성을 되읽는다 — 처음엔 이 단축을 빈 프레임에도 적용했다가 `Attr` 정체성 단언이 깨졌다). 대신 플레이스홀더 페이지의 `load` 는 문서 수준 캡처 리스너가 삼킨다(`swallowPlaceholderLoad`): 라우트를 기다리는 프레임(`pendingFrameRoutes` 또는 `data-zp-frame-src`)이 **about:blank 를 보고 있을 때만**, 라우트된 문서의 `load` 는 통과하며 대기를 끝낸다. (3) 라우트가 실패하면 합성 `load` 를 쏜다(영영 안 오는 `load` 를 기다리지 않도록). (4) 요소별 시퀀스 번호로 느린 이전 라우트가 새 이동을 덮지 못하게 하고, `src` 를 라우트 아닌 값으로 바꾸면 진행 중인 라우트도 취소한다.
- **함정 둘:** ① **`load` 이벤트는 Window 로 전파되지 않는다**(DOM: Document 의 부모는 `load` 에서 null) — 처음 window 에 캡처 리스너를 달았더니 아무것도 안 걸렸다. 요소 `load` 는 `document` 에서 잡는다(00-head 의 스크립트 추적과 같은 자리). ② 상태 `const` 는 `00-head.js` 에 둔다 — `06-install.js` 가 설치 단계를 돌릴 때 뒤 파일의 상수는 아직 초기화 전이다(TDZ).
- **검증:** e2e `frame load events and history match native`(`/frame-loads`: 파싱된 프레임 인라인·리스너, `src` 먼저/나중, 빠른 교체, 교체 시 히스토리) — 네이티브와 같고, 옛 멤브레인에서는 `staticOnload: '3'`·`srcBeforeAppend: 'LoLo'` 로 빨개진다. 네이티브 기준값(`Lo`/`LoLo`/히스토리 1)도 고정.
- **규칙:** 프레임 라우트 코드를 바꾸면 `load` 횟수와 히스토리 증가분을 네이티브와 세어 볼 것.

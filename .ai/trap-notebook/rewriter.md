# Rewriter Regressions

과거 원인·수정·검증 요약이며 현재 전체 accepted spec이 아니다. 검증은 당시 범위에 한정되고 이번 정리에서 새 실행은 없었다. 후속 정정이 앞 가설보다 우선하며 현재 E1은 [계획](../design/website-compat-refactor.md)을 본다.

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
- **당시 검증·공백:** CSSOM 규칙·플레이어 위치·재생 진행이 대조군과 맞아졌고 zp-htmltx/cargo/static/렌더/탐지·변이 회귀 통과. 텍스트에는 있는데 CSSOM에는 없는 규칙이 파싱 실패의 단서였다. 기존 요소 수/raw/CSP/콘솔 검사는 레이아웃 붕괴를 놓쳤으며 `rendercheck.sh` 높이/뷰포트 축은 당시 제안이었다.

## <a id="모듈-url-두-벌"></a>모듈 URL 분열과 미해결 GitHub (2026-09-04)

- **원인:** 이후 레이아웃 검사가 GitHub의 클라이언트 React 에러 페이지를 발견했다. Rust 정적 import는 `?u=…&kind=module`, JS 동적 경로는 순서와 `ref`가 달랐고 `withCurrentRef`는 시간에 따라 ref도 갱신했다. URL 정체성 때문에 같은 모듈이 두 벌 로드됐다. `debugger-arm --strategy exceptions`의 잡힌 `Illegal invocation`은 브랜드 체크 노이즈였고 React #321·컨텍스트 부재가 조사 신호였다.
- **수정·경계:** module URL을 Rust와 바이트 단위로 동일하게 정규화하고 ref를 제거했다. classic은 CF 챌린지 타이밍 때문에 ref를 유지한다. 당시 중복 모듈 소멸은 확인됐지만 CF 해결을 입증한 것은 아니다.
- **최종 정정:** 한 번 정상 렌더 후 같은 절차 반복에서 모두 에러 페이지였다. **모듈 분열은 수정된 실제 결함이지만 GitHub 에러 페이지 원인이라는 결론은 철회됐다.** 다른 React #321 경로는 미해결이다. 한 번 성공으로 닫지 않고 반복 결과를 보고한다는 교훈이 남았다.

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

# 함정노트 인덱스

최신·미해결·재발방지 핵심만 선택한다. 상태는 해당 기록 시점 기준이며 현재 전체 통과를 뜻하지 않는다.
[LOG.md](LOG.md)는 2026-08-25 INDEX 본문 아카이브다. 이후 원문은 상세의 고정 커밋 링크, 보존 규칙은 [README](README.md), 진행 중 E1은 [계획](../design/website-compat-refactor.md)을 본다.
요약은 한 줄·160자 이하, 상세는 실재 앵커. 새 항목은 표 맨 위에 추가한다.

| Date | Category | Summary | Detail |
|---|---|---|---|
| 2026-10-06 | membrane / 수정 | 빈 프레임·srcdoc 안에서 스크립트가 만든 스크립트가 로드 안 됐다(403·503). srcdoc 은 URL 에 tab, 빈 프레임은 릴레이로. 광고 칸이 비던 원인. | rewriter.md#swless-동적-스크립트 |
| 2026-10-06 | transport / 수정 | HTTP/2 POST 에 Content-Length 가 없어 Optimizely 가 400. 커널이 지우고 안 채웠다. 한 규칙으로 H1·H2 모두. e2e 로는 재현 안 됨. | rewriter.md#h2-content-length |
| 2026-10-06 | membrane / 수정 | worker 가 직접 답 못 하는 프레임(document.write)의 crossorigin 요소가 CORS 판정을 못 받았다. 부모가 요소 모드를 헤더·릴레이 인자로 전한다. | rewriter.md#swless-요소-cors |
| 2026-10-06 | membrane / 수정 | srcdoc 프레임의 외부 스크립트가 영영 안 돌았다 — controller 가 null 이라 탭에 못 묶인다. 스크립트 URL 에 tab·entry 를 싣고 첫 요청에서 바인딩. | rewriter.md#srcdoc-스크립트-바인딩 |
| 2026-10-06 | membrane / 수정 | null·undefined 수신자의 재작성된 멤버 연산이 던지지 않고 undefined 였다(Object(null)={}). 태그한 eval 에서 진짜 연산을 해 엔진이 던지게 함. | rewriter.md#null-수신자-throw |
| 2026-10-06 | membrane / 보안 | crossorigin 요소·모듈·폰트에 CORS 미적용. 두 SW 경로(fetch GET·script)에 같은 옵션, destination 없는 내부 fetch 는 제외. FontFace URL 은 프록시를 안 탔다. | rewriter.md#element-cors |
| 2026-10-06 | membrane / 수정 | Naver 광고 이미지가 붉은 블록이었다 — SW-less 자리끼우개(실제로는 반투명 빨강)가 살아 있는 요소에 남음. 목표 URL 로 다시 시작, 픽셀은 투명으로. | rewriter.md#swless-자리끼우개-빨강 |
| 2026-10-06 | membrane / 수정 | 스크립트 못 돌리는 sandbox 프레임의 script src 를 프록시 문서는 요청 안 했다. 원인은 프렐류드가 박은 CSP meta(네이티브도 meta 가 있으면 안 받음) — 헤더만 남김. | rewriter.md#csp-meta-스크립트-프리로드 |
| 2026-10-06 | membrane / 보안 | CORS 미적용으로 허락 안 한 교차 오리진 읽기가 성공. SW 가 가상 오리진으로 판정·preflight. 거부를 Response.error 로 주면 페이지가 v1 로 재전송. | rewriter.md#cors-적용 |
| 2026-10-06 | membrane / 수정 | document.cookie 쓰기 직후 동기 XHR 이 쿠키를 놓쳤다. 릴레이가 ack 안 된 쓰기를 싣는다(최신 32개) — Go 가 앞 16개만 받아 새 쓰기가 잘렸다. | rewriter.md#쿠키-동기-xhr |
| 2026-10-06 | membrane / 수정 | 불투명 프레임이 연 팝업이 불투명하지 않았다. OPEN_SHARE 가 opaque 를 싣고 SW 부트 JSON 이 팝업 prelude 에 전한다. | rewriter.md#불투명-팝업 |
| 2026-10-06 | membrane / 보안 | 불투명 프레임의 요청이 사이트 쿠키 전부를 실었고 Secure 쿠키는 http://localhost 로 안 갔다. SW 항목에 opaque, loopback 은 보안 문맥. | rewriter.md#불투명-쿠키-secure-loopback |
| 2026-10-02 | e2e / 플레이크 | 새 페이지를 여는 e2e 헬퍼의 page.goto 가 간헐적으로 안 끝났다(페이지는 이미 complete+SW 제어). 런처 헬퍼가 goto 를 안 기다리고 버튼을 기다린다. | build-deploy.md#e2e-goto-대기 |
| 2026-10-02 | membrane / 보안 | replaceChildren·insertAdjacentElement·Range.insertNode·텍스트노드 before/after 로 넣은 스크립트가 리라이트 없이 돌았다(감옥 밖). 삽입 훅 표를 완성. | rewriter.md#삽입-문-스크립트 |
| 2026-10-02 | membrane / 수정 | 쓴 직후의 쿠키가 다음 fetch 에 안 실릴 수 있었다(쓰기와 요청이 SW 로 가는 길이 다름). 요청이 진행 중인 쓰기의 ack 를 기다린다. | rewriter.md#쿠키-쓰기-직후-요청 |
| 2026-10-02 | membrane / 보안 | 맨 식별자 frameElement 가 임베더의 iframe 요소를 내줬다(교차 사이트·불투명 자식 포함). DANGEROUS_GLOBALS 에 넣어 스코프 퍼사드로. | rewriter.md#맨-frameelement-누출 |
| 2026-10-02 | membrane / 수정 | innerHTML·insertAdjacentHTML·template·document.write 로 만든 iframe 이 영영 빈 채였다(inert 복사본에 라우트). src 를 파킹, 활성화 때 복원. | rewriter.md#마크업으로-만든-프레임-파킹 |
| 2026-10-02 | membrane / 수정 | sandbox 에 allow-same-origin 이 없는 iframe 을 지우지 않고 불투명 오리진으로 에뮬레이트(null 오리진·저장소 거부·교차 오리진 창). 플래그 유지+같은 오리진 서빙. | rewriter.md#sandbox-불투명-프레임-에뮬레이션 |
| 2026-10-02 | membrane / 수정 | 다른 문서·img·script·동기 XHR·형제 프레임·다른 탭이 건 쿠키가 document.cookie 에 안 보였다. SW jar 가 변경 레코드를 볼 수 있는 창에만 밀어 준다(비동기). | rewriter.md#쿠키-변경-푸시 |
| 2026-10-02 | membrane / 보안 | 같은 사이트 자식의 window.name 이 부모 것이었고 navigator.locks.query() 가 모든 사이트의 잠금을 돌려줬다. 프레임은 진짜 name, query 는 자기 접두만. | rewriter.md#window-name-locks-오리진-공유 |
| 2026-10-02 | build / 환경 | 옛 커밋 빌드용 git worktree 의 node_modules junction 을 worktree remove --force 하면 저장소의 node_modules 가 비워진다(복구: npm ci). 링크 해제를 확인할 것. | build-deploy.md#worktree-junction-node-modules |
| 2026-10-02 | membrane / 수정 | 서버가 fetch/XHR 응답으로 건 쿠키가 document.cookie 에 안 보였다(페이지 사본은 로드 시점 스냅샷). SW 가 홉별 델타를 메타로 보내 응답 전에 적용. | rewriter.md#fetch-set-cookie-미러 |
| 2026-10-02 | membrane / 보안 | 한 사이트의 localStorage 쓰기가 다른 사이트 프레임의 storage 이벤트로 새고 있었다(물리 키·값·내부 키). 창마다 캡처 첫 리스너로 번역·삼킨다. | rewriter.md#storage-이벤트-교차-사이트 |
| 2026-10-02 | membrane / 보안 | 서로 다른 사이트의 프레임이 격리되지 않았다 — 가상 오리진별 창 핸들 정책(교차 사이트는 SecurityError 스탠드인). 이미 같은 오리진일 때 쥔 핸들은 잔여. | rewriter.md#교차-사이트-프레임 |
| 2026-10-02 | membrane / 수정 | 부모가 보낸 메시지의 e.origin 이 프록시 주소였다 — 맨 addEventListener 는 래퍼를 건너뛰었다. 창이 자기 오리진을 말하고 진짜 이벤트를 꾸민다. | rewriter.md#메시지-이벤트-수신측 |
| 2026-10-02 | membrane / 보안 | postMessage 타깃 오리진을 걸러 내지 않았다(틀린 사이트 프레임에 도착) + 옵션 형태 SyntaxError. 가상 오리진 비교로. | rewriter.md#postmessage-타깃오리진 |
| 2026-10-01 | e2e / 플레이크 | WT 워커 e2e 가 CI 에서 한 번 105초 후 실패(같은 커밋 재실행은 통과) — 런처 Open 대기 누락 가설, 대기+진단 메시지 추가. 회귀 의심은 재실행부터. | build-deploy.md#e2e-런처-대기 |
| 2026-10-01 | membrane / 수정 | src 라우팅 프레임은 load 가 두 번·히스토리 두 칸(파싱된 onload 는 세 번) — 라우팅 문서는 유지하고 플레이스홀더 load 는 삼킨다. load 는 window 로 안 간다. | rewriter.md#프레임-load-두-번 |
| 2026-10-01 | membrane / 수정 | target 을 전부 _self 로 고쳐 쓰고 있었다 — _blank 제자리·_top 은 프레임만·폼은 타깃 무시·팝업은 런처부터. 재작성 제거, 링크·폼·open 을 navigable 규칙으로. | rewriter.md#내비게이션-타깃 |
| 2026-10-01 | membrane / 보안 | 라우팅 프레임의 세 창(대기 중 blank·about:blank 로 옮긴 프레임·앵커 없는 문서)에서 contentWindow.eval 이 프록시 오리진 날 코드였다 — 지금 문서 기준 containment. | rewriter.md#라우팅-프레임-탈출 |
| 2026-10-01 | membrane / 보안 | 부모가 contentWindow 를 읽을 때마다 자식의 멤브레인을 자기 것으로 덮었다(define 은 writable 슬롯을 덮는다) — src 로 보낸 프레임만 무사했다. | rewriter.md#자식-멤브레인-덮어쓰기 |
| 2026-10-01 | membrane / 수정 | `<a target=프레임>` 은 프레임에 ?via= 런처를 실었고 런처는 CSP 에 막혔다 — 표면 프로브는 런처 URL 을 읽고 통과. 프레임 라우트로. | rewriter.md#명명-타깃-프레임 |
| 2026-09-30 | transport / 수정 | D5 를 켜면 원격 피어가 사용자에게 직접 붙었다(host↔host 실측), TURN 은 제 자격을 거절 — relay 전용 TURN 으로 교체, pion 브리지 제거. | transport-regression.md#rtc-relay-only |
| 2026-09-30 | transport / 수정 | WT 브라우저 구간 다섯 겹(CSP·Origin 기본 검사·30일 CA 인증서·해시 전달·타깃 핀) — Go 테스트엔 Origin·CSP 가 없다. 브라우저 e2e 로 고정. | transport-regression.md#wt-브라우저-구간 |
| 2026-09-29 | transport / 수정 | WT 게이트웨이는 타깃에 한 번도 닿지 못했다(DATAGRAM 미설정) + bidi 응답 유실(half-close). 데이터 경로 테스트가 없었다. | transport-regression.md#wt-게이트웨이-데이터경로 |
| 2026-09-29 | worker / 수정 | 워커에서 `self.addEventListener` 등 네이티브 메서드가 Illegal invocation(스코프 프록시 수신자). 래퍼 `Function.prototype` 도 빈 객체였다. | rewriter.md#워커-self-수신자 |
| 2026-09-29 | worker / 수정 | `new Worker(u); URL.revokeObjectURL(u)` 에서 워커가 나중에 소스를 읽다 fail-closed — 생성 시점에 우리 소유 복사본 URL 로. | rewriter.md#blob-워커-해제 |
| 2026-09-29 | rewriter / 수정 | 화살표 표현식 본문에 `_STMT` ASI 가드 `0,` 가 붙어 화살표가 끊겼다 — SyntaxError(Permutive), 또는 조용히 ReferenceError(Rubicon). | rewriter.md#arrow-본문-stmt |
| 2026-09-29 | rewriter / 수정 | `a?.[k]`→`__zp_oget(a,k)` 가 키를 먼저 평가하고 체인 단락을 깼다(GitHub 랜딩 에러 페이지). 체인 단위 연속 `__zp_ochain` 으로. | rewriter.md#옵셔널-체인-연속 |
| 2026-09-29 | membrane / 수정 | about:blank 자식 창에 R1 `__zp_lex_*` 가 없어 top-level let 을 가진 스크립트가 첫 줄에서 죽었다 — 자식 전용 레지스트리. | rewriter.md#자식-렉시컬 |
| 2026-09-29 | worker / 수정 | 워커에 `__zp_okeys`·`__zp_delete`·`__zp_oget` 등 15개가 없어 `Object.keys(o)` 가 ReferenceError. 방출 헬퍼 × realm 가드. | rewriter.md#워커-헬퍼-누락 |
| 2026-09-29 | membrane / 수정 | React 의 `Error.prepareStackTrace` 저장/복원이 우리 훅을 자기 자신에 물려 이후 모든 `.stack` 이 스택 오버플로. | rewriter.md#prepare-stack-재귀 |
| 2026-09-29 | membrane / 제거 | customElements 타깃 접두어는 격리가 아니었다(레지스트리는 Window 마다) — closest·CSS·정체성이 깨져 GitHub partial 전멸. | rewriter.md#ce-접두어-제거 |
| 2026-09-29 | htmltx / 수정 | import/export 없는 `type=module` 이 classic 리라이트(R1 프롤로그)로 모듈끼리 이름 충돌 — kind 는 URL 로(`&kind=module`). | rewriter.md#module-kind-url |
| 2026-09-29 | membrane / 수정 | innerHTML 을 읽기만 해도 요청이 나갔다(살아 있는 cloneNode 사본). IDL 우회 3개(input.src 등)는 url_surfaces 전수 측정으로 찾았다. | rewriter.md#surface-차분 |
| 2026-09-29 | 검증 / 규칙 | 프록시 단독 기대값이 divergence 6건을 설계로 인증하고 있었다(on* 문자열 실행·eval 이중실행 등). 기대값은 네이티브 차분에서 얻는다. | rewriter.md#프록시-단독-핀 |
| 2026-09-29 | rewriter / 수정 | ASI 선언 뒤 `__zp_lex_bind` 가 붙어 스크립트 전체가 SyntaxError. 하네스 실패 6건에 진짜 버그 1건이 묻혀 CI 가 빨간 채였다. | rewriter.md#lex-bind-asi |
| 2026-09-26 | build / 수정 | build.mjs top-level `await` 앞의 `const` 는 TDZ — 빌드용 경로 상수는 파일 상단 `webSrc` 옆에. | build-deploy.md#2026-09-26--build-mjs-top-level-await-tdz |
| 2026-09-24 | worker / 수정 | `self.URL` 래퍼가 내부 `new URL` 을 삼켜 `/zp/*` 부트스트랩이 타깃으로 변질 — 캡처→내부전환→래핑 순서. | rewriter.md#worker-url-래퍼-내부흡수 |
| 2026-09-24 | worker / 수정 | SharedWorker `self.name` 에 `zp:w:` 접두어 노출 — 요청 이름으로 마스킹이 네이티브 parity. | rewriter.md#sharedworker-이름-마스킹 |
| 2026-09-24 | membrane / 수정 | OPFS `handle.name` 에 네임스페이스 오리진 원문 누출 — 서브디렉터리명은 해시로. | rewriter.md#opfs-name-마커누출 |
| 2026-09-24 | e2e / 규칙 | `http://localhost` 는 potentially-trustworthy — `isSecureContext:false` 단언 금지, 네이티브도 true. | rewriter.md#localhost-secure-context-parity |
| 2026-09-23 | membrane / 수정 | prelude 헬퍼의 throw 는 에러 filename 으로 prelude URL 을 샌다 — throw 는 방출 코드 + `//# sourceURL` 태깅. | rewriter.md#에러-filename-누출 |
| 2026-09-23 | rewriter / 수정 | apply_patches 가 same-start zero-width 삽입을 문 패치에 삼킨다 — 정렬에 insert-first 우선순위 필요. | rewriter.md#zero-width-패치-삼킴 |
| 2026-09-23 | e2e / 규칙 | res.end 템플릿 픽스처 안 주석의 백틱/`${` 가 리터럴을 닫는다 — 파스 에러는 시작 줄만 가리킨다. | rewriter.md#픽스처-주석-백틱 |
| 2026-09-23 | membrane / 수정 | 동적 meta CSP 는 MutationObserver 복원이 느려 그 사이 로드가 빠진다 — content set 경로에서 동기 필터+http-equiv 재장전. | rewriter.md#meta-csp-동기무장 |
| 2026-09-23 | e2e / 규칙 | `data-zp-lit-href="X"` 는 `href="X"` 를 substring 으로 포함 — raw-URL 부재 단언은 strip_lit 후에. | rewriter.md#lit-stash-서브스트링-오탐 |
| 2026-09-23 | worker / 수정 | 워커 importScripts 가 `/zp/*` 내부 자산을 타깃으로 해석해 번들 로드 실패 — 내부 프리픽스는 해석 전 통과. | rewriter.md#worker-내부경로-타깃해석 |
| 2026-09-23 | worker / 수정 | `/zp/api/sync-fetch` 가 SW 디폴트 분류로 upstream 전달돼 404 — 신규 /zp/api 라우트는 분류표 명시 등록. | rewriter.md#worker-동기xhr-라우트 |
| 2026-09-23 | worker / 수정 | 워커 WebSocket 상대 URL 은 http: 베이스 resolve 로 거부됨 — `^http→ws` 매핑 베이스가 선행. | rewriter.md#worker-ws-베이스-매핑 |
| 2026-09-22 | 실사이트 / 실측 | Turnstile arming 게이트는 정상(armed 문서만 CF CSP + 마커 비노출) — "browser not supported" 는 CF 측 환경 거부. | real-site-compat.md#turnstile-arming-검증 |
| 2026-09-22 | membrane / 수정 | `stylesheet.href` 가 프록시 URL 을 돌려줬다 — CSSOM StyleSheet 접근자는 DOM 요소 훅과 별도로 디프록시. | rewriter.md#stylesheet-href-디프록시 |
| 2026-09-22 | rewriter / 정책 | 비상수 test 루프는 의도적으로 uncapped — break 없는 async `while(true)` 만 10M silent death 잔여 divergence. | rewriter.md#loop-cap-비상수-정책 |
| 2026-09-22 | membrane / 수정 | cross-window 파사드가 날것의 멤버 쓰기(`__zp_get(parent).x=v`)를 흡수 — Proxy 트랩으로 own-expando 만 포워딩. | rewriter.md#crosswindow-더미-흡수 |
| 2026-09-22 | membrane / 수정 | 자식 realm 부트 부작용 — `w.name=''` 이 브라우징컨텍스트명 삭제 + 컨테인먼트 이중래핑. realm 판정은 `w.top===w`. | rewriter.md#자식-realm-부트-부작용 |
| 2026-09-22 | rewriter / 실측 | 루프캡 경계는 형태별로 ±1 — `for(init;;update)` 도 캡됨(§L 반증), do-while 은 post-test 라 10M+1. | rewriter.md#loop-cap-경계-의미 |
| 2026-09-22 | membrane / 수정 | 스택 프레임은 URL·함수명 두 채널로 샌다 — V8 기본 포맷이 eval 기술 텍스트에 raw URL 을 박고 `__zp_*` 식별자가 함수명으로 샌다. 최종 문자열 재정리 필수. | rewriter.md#stack-프레임-이중누출 |
| 2026-09-22 | e2e / 규칙 | `/zp/` 경로에 두 CSP 정책이 공존 — 문서 정책은 report-uri 유무로 식별. headless 는 manifest/prefetch 를 lazy-fetch 해 SPV 가 없다. | rewriter.md#csp-두-정책-구별 |
| 2026-09-22 | worker / 수정 | module worker 의 `importScripts` 는 호출 시 던지는 스텁 — `typeof` 가드 무효, 부트스트랩 해시 mod=1 로 명시 판정. | rewriter.md#module-worker-importscripts-스텁 |
| 2026-09-22 | worker / 수정 | 워커 클라이언트엔 referrer ctx 가 없다 — `?tab=` worker-script 요청에서 bindClientContext. dep 실패는 top import() URL 로 기만 보고된다. | rewriter.md#worker-client-탭-바인딩 |
| 2026-09-22 | e2e / 규칙 | 픽스처 스크립트 안의 `</script>` 리터럴은 주석도 절단한다 — 쪼개거나 textarea 에 담는다. | rewriter.md#fixture-script-종료태그 |
| 2026-09-22 | membrane / 수정 | `contentDocument.location` 이 부모 URL 을 돌려줬다 — foreign Location 은 프레임의 data-zp-target-url 로 역조회. | rewriter.md#foreign-document-location |
| 2026-09-22 | e2e / 규칙 | direct-vs-proxy 차분의 대조군은 별도 브라우저 인스턴스에서 — targetcreated 는 모든 컨텍스트를 잡는다. | rewriter.md#차분-측정-브라우저-격리 |
| 2026-09-22 | membrane / 수정 | usesRaw 앵커의 getAttribute 가 raw share URL 을 페이지에 돌려줬다 — stash→deproxy 로 타깃 URL 을 돌려준다. | rewriter.md#getattribute-usesraw-누출 |
| 2026-09-22 | e2e / 규칙 | 탈출 검증은 리라이트된 문서 안 프로브로 — page.evaluate 는 리라이터를 안 거쳐 다른 시스템을 잰다. | rewriter.md#e2e-리라이트-문서-프로브 |
| 2026-09-22 | rewriter / 수정 | `x[k] op= v` 의 eager RHS 가 평가 순서를 깼다 — accessor-adapter 방출로 네이티브가 순서를 소유. sloppy 래퍼의 `call(null)` 도 this 탈출이었다. | rewriter.md#assign-평가순서 |
| 2026-09-22 | worker / 수정 | worker 전역의 getter-only 접근자(indexedDB 등)에 strict 대입하면 부팅 사망 — defineProperty 로 심는다. | rewriter.md#worker-readonly-전역 |
| 2026-09-22 | membrane / 수정 | 설치 시퀀스 뒤의 `let` 선언은 TDZ 로 prelude 전체를 죽인다 — 참조 선언은 호출 지점 위에. | rewriter.md#설치-순서-tdz |
| 2026-09-22 | membrane / 수정 | Chrome 네이티브 own 접근자(performance 등)를 page-installed 로 오인해 `this=scope` 호출 → 부팅 스냅샷으로 구분. | rewriter.md#네이티브-own-접근자-오인 |
| 2026-09-22 | membrane / 수정 | `root.URL` 래퍼가 prelude 내부 `new URL` 도 가로채 share→target 오해석 — IIFE 에 `const URL = Native.URL` 섀도잉. `undefined` base 도 누수. | rewriter.md#네이티브-url-섀도잉 |
| 2026-09-22 | membrane / 수정 | `withScope.get` 이 `__zp_*` 를 숨기면 모든 리라이트 스크립트 즉사 — 페이지 대면 scope 만 숨긴다. | rewriter.md#withscope-get-숨김 |
| 2026-09-14 | SharedWorker / 격리 | 부트 순서상 나중 훅이 타깃별 이름 접두어를 덮어써 SharedWorker 격리가 죽어 있었다 — 모양 축을 쫓다 발견. | rewriter.md#프로토타입-모양-축 |
| 2026-09-14 | 회귀가드 / 드리프트 | document.origin 자체가 최신 Chrome/Edge에서 사라졌다. escape-matrix 테스트가 죽은 전제 위에 있었다 — 실측 후 전제를 갱신. | rewriter.md#프로토타입-모양-축 |
| 2026-09-14 | 지문 / 컨테인먼트 | 모양 축 6개 전부 닫음. baseURI 를 Node.prototype 으로 옮기며 element.baseURI 실유출도 막힘. 대체 클래스는 네이티브 own 이름을 규칙으로 베낀다. | rewriter.md#프로토타입-모양-축 |
| 2026-09-10 | 지문 / 계측 | 프로토타입 모양 축 신설. 만들자마자 6개가 걸렸고 그중 4개는 대체 클래스의 얇은 프로토타입이다. | rewriter.md#프로토타입-모양-축 |
| 2026-09-10 | CSS / 보안 | Typed OM 은 style 훅이 안 닿는다. RO 프로토타입 한 곳에서 읽기 되돌리기와 쓰기 재작성을 같이 건다. | rewriter.md#typed-om |
| 2026-09-10 | 지문 / 규칙 | 페이지가 자기 함수를 문자열로 만들면 리라이트가 보였다(naver 17, github 89). toString 에서 되돌려 돌려준다. | rewriter.md#리라이트-소스-노출 |
| 2026-09-10 | 계측 / 금지 | 브라우저가 죽어도 rendercheck 가 4/4 OK 를 찍었다. 측정 판정기에는 반드시 "안 쟀음" 상태를 둔다. | build-deploy.md#죽은-브라우저가-전항목-통과 |
| 2026-09-10 | 지문 / 규칙 | 훅 소스가 368곳 노출. 접근자는 설치 지점에서 가린다. `propertyDescriptor` 로 훑으면 상속에 own 을 새로 만든다(13→157). | rewriter.md#훅-소스-노출 |
| 2026-09-10 | CSS / 보안 | CSS url() 을 바꿔 쓰고 되돌리지 않아 읽기 표면 16곳으로 프록시 정체가 샜다. style 접근자는 훑어서 전부 감싼다. | rewriter.md#css-정체-되읽기 |
| 2026-09-08 | E2E / 수정 | Node upgrade socket의 EOF와 close는 다르다. 상대 EOF를 기록한 뒤 fixture의 쓰기 half를 종료한다. | sw-integration.md#upgraded-socket-eof |
| 2026-09-08 | WebSocket / 수정 | Close 상한은 페이지 이벤트만 끝내지 않고 커널 abort·SW 등록 해제까지 연결한다. 열린 소켓은 제한하지 않는다. | sw-integration.md#websocket-close-deadline |
| 2026-09-08 | stream / 수정 | 상류의 내부 표식을 거절하고 실제 응답 방식에 맞춰 설정해야 본문 완료 추적·표식 은폐를 보존한다. | sw-integration.md#stream-marker-ownership |
| 2026-09-06 | stream / 구현 | HTTP framing·압축 검증·취소와 최종 SW waitUntil 수명을 함께 보존한다. | sw-integration.md#pull-stream-lifetime |
| 2026-09-06 | WebSocket / 구현 | handshake UA·Origin·Cookie는 WS 서버가 아닌 검증된 요청 문서와 jar에서 결정한다. | sw-integration.md#websocket-request-identity |
| 2026-09-06 | runtime / 구현 | 동작하는 WebSocketStream을 스텁으로 덮지 않고 Attr 쓰기도 공통 URL 정책에 연결한다. | rewriter.md#runtime-entrypoints |
| 2026-09-06 | E2E / 규칙 | 파괴적 탐색을 별도 문맥에 격리하고 폼별 정상 출발점을 보장한다. | rewriter.md#destructive-navigation-probes |
| 2026-09-06 | rewriter / 수정 | WASM 대입을 읽기 호출로 바꾸지 말고 쓰기 참조·연산자·평가 순서를 보존한다. | rewriter.md#ci-write-reference |
| 2026-09-06 | membrane / 수정 | URL stash보다 native 속성의 absent/null·empty·removed 상태가 우선한다. | rewriter.md#absent-url-attribute |
| 2026-09-06 | Fetch / 수정 | 요청 snapshot·body view·credentials와 hop별 redirect 정책을 보존한다. 전체 E1 완료와 별개다. | sw-integration.md#request-context-redirect |
| 2026-09-04 | membrane | **스코프 프록시가 목록에 든 window 메서드만 바인딩 — `globalThis.structuredClone(x)` 이 Illegal invocation 으로 GitHub 홈을 ErrorPage 로 만들었다. 규칙으로 교체.** | rewriter.md#window-메서드-바인딩-목록 |
| 2026-09-04 | GitHub / 역사·후속 | 모듈 중복 15→0은 사이트 회복 증거가 아니었다. 후속 receiver 수정의 회복 보고와 현재 검증을 구별한다. | rewriter.md#모듈-url-두-벌 |
| 2026-09-04 | 검증 / 규칙 | title 성공만으로 레이아웃·에러 경계를 판정하지 않는다. 직접/프록시를 짝지어 비교한다. | real-site-compat.md#레이아웃-축-없음 |
| 2026-09-04 | build / 금지 | build clean은 dist를 먼저 지운다. 툴체인 확인 없이 유일한 배포 산출물에 빌드를 걸지 않는다. | build-deploy.md#빌드-clean-이-유일본을-지운다 |
| 2026-08-26 | htmltx / 수정 | style raw text를 HTML escape하면 CSS가 깨진다. attribute와 raw-text 출력 계약을 구별한다. | rewriter.md#style-raw-text-이스케이프 |
| 2026-08-26 | URL / 수정 | blob/data 게터·fetch는 지원 의미를 보존하고 MediaSource는 생성 시점에 HTML로 바꾸지 않는다. | rewriter.md#비-http-스킴-세-겹 |
| 2026-08-26 | CNN / 미해결 | 두 번째 정지는 재현되지 않았고 clients.get 단독 원인은 반증됐다. 잔여 현상을 완료로 세지 않는다. | real-site-compat.md#cnn-2차정지-재현불가 |
| 2026-08-26 | membrane / 규칙 | data-zp 이름공간은 NS·Attr·dataset·named getter의 읽기/쓰기/삭제까지 같은 규칙으로 숨긴다. | rewriter.md#data-zp-이름공간 |
| 2026-08-26 | transport / 역사 | 과거 H1 deadline은 헤더가 아니라 본문까지 덮었다. 느린 정상 본문과 침묵 상류를 구별한다. | sw-integration.md#transport-데드라인-실측 |
| 2026-08-26 | CSP / 정정 | 스트리밍에서도 CSP 헤더는 강제된다. 과거 미강제 관찰은 계측 브라우저의 CSP bypass였다. | sw-integration.md#csp-스트리밍-정정 |
| 2026-08-26 | htmltx / 수정 | head 없는 문서에서도 prelude/CSP가 body 뒤로 밀리지 않도록 삽입 경계를 보장한다. | rewriter.md#csp-meta-body |
| 2026-08-26 | 계측 / 규칙 | taskweaver wait의 필수 id와 실행 결과를 확인한다. 잘못된 호출은 대기한 증거가 아니다. | build-deploy.md#execjs-문맥 |
| 2026-08-26 | Referer / 수정 | meta referrer policy는 첫 fetch보다 늦는 비동기 통지만으로 전달하지 않는다. | sw-integration.md#meta-referrer |
| 2026-08-26 | Referer / 수정 | 최상위 요청에 자기 URL을 Referer로 만들지 않는다. navigation은 Request.referrer를 읽는다. | sw-integration.md#자기-referer |
| 2026-08-25 | frame / 수정 | postMessage를 다른 창의 own wrapper로 바꾸면 incumbent realm과 message source가 뒤집힌다. | rewriter.md#postmessage-incumbent |
| 2026-08-25 | SW / 금지 | 응답 커밋 경로에서 clients.get(resultingClientId)를 await하지 않는다. navigation 교착을 만든다. | sw-integration.md#clients-get-교착 |
| 2026-08-25 | CNN / 후속 정정 | APS 조사에는 반증과 이후 회복 관찰이 있다. 광고 변동·후속 미재현 현상과 분리한다. | real-site-compat.md#cnn-aps-프레임 |
| 2026-08-25 | membrane / 규칙 | document.location 별칭은 보호하되 모든 창 사슬을 넓게 감싸지 않는다. brand 예외 비용도 관찰한다. | rewriter.md#document-location-유출 |
| 2026-08-25 | navigation / 수정 | base href가 재조준하지 못하도록 proxy navigation 주소는 proxy-origin 절대 URL로 만든다. | rewriter.md#base-href-탈출 |
| 2026-08-25 | 계측 / 정정 | 같은 브라우저에서 동시 프로브를 돌리면 대조군을 오염시킨다. 공유 zp 인스턴스는 순차 사용한다. | sw-integration.md#nav-matrix-대조군 |
| 2026-08-25 | Referer / 규칙 | target Referrer-Policy를 적용하고 origin·downgrade·요소 override를 구별한다. | sw-integration.md#referrer-policy |
| 2026-08-25 | SW / 수정 | subresource redirect가 문서 entry URL을 바꾸면 후속 프레임·Referer 문맥이 오염된다. | sw-integration.md#리다이렉트-entry |
| 2026-08-24 | frame / 역사 | 교차창 proxy의 parent가 자기 자신이면 조상 탐색이 무한 루프가 된다. | LOG.md#2026-08-24-1 |
| 2026-08-24 | membrane / 역사 | 객체를 반환하는 게터 설치 여부는 값 identity의 반복 비교로 판정하지 않는다. | LOG.md#2026-08-24-2 |
| 2026-08-24 | collection / 역사 | collection의 descriptor·keys·직접 인덱스 표면을 맞추고 O(N²) 재필터링을 피한다. | LOG.md#2026-08-24-4 |
| 2026-08-23 | 계측 / 정정 | Stack Overflow 재확인과 script stash·압축 경로 정정을 보존한다. 이전 미측정 가설은 대체됐다. | rewriter.md#stackoverflow-재확인 |
| 2026-08-22 | storage / 역사 | sessionStorage는 탭 세션을 따르고 내부 진단 키·채널 이름은 가상 사이트 경계를 지킨다. | LOG.md#2026-08-22-7 |
| 2026-08-21 | redirect / 금지 | redirect 상한 초과의 raw 3xx를 브라우저에 넘기지 않는다. 최종 Location으로 탈출할 수 있다. | LOG.md#2026-08-21-9 |
| 2026-08-21 | 정책 / 규칙 | URL 표면은 공유 목록으로 투영하되 정적 HTML과 동적 DOM의 실행 coverage는 각각 확인한다. | LOG.md#2026-08-21-10 |
| 2026-08-20 | navigation / 역사 | Refresh 응답 헤더와 meta refresh도 navigation 경계다. CSP가 대신 막을 것이라 가정하지 않는다. | LOG.md#2026-08-20-2 |
| 2026-08-20 | 계측 / 규칙 | csp-only와 direct egress는 다르다. 판정 열·관측기 무장·csp_bypassed 상태를 확인한다. | LOG.md#2026-08-20-7 |
| 2026-08-19 | TLS / 정정 | ECH GREASE를 포함한 확장 순서의 연결별 셔플을 wire에서 확인한다. 낡은 고정 순서는 기준이 아니다. | LOG.md#2026-08-19-1 |
| 2026-08-18 | membrane / 보안 결정 | configurable 잠금을 푸는 지문 회피는 기각됐다. 격리 약화를 사이트 호환성 해결로 쓰지 않는다. | LOG.md#2026-08-18-5 |
| 2026-08-18 | TLS / 규칙 | ALPS 등 광고한 확장은 실제 handshake 의미까지 구현해야 한다. 광고만으로 identity가 맞지 않는다. | LOG.md#2026-08-18-6 |
| 2026-08-18 | eval / 수정 역사 | indirect eval의 전역 선언과 완료값을 보존한다. 이 수정만으로 현재 CF 전체 통과를 선언하지 않는다. | LOG.md#2026-08-18-15 |
| 2026-08-18 | CF / 미해결 범위 | 웜 clearance 성공은 콜드 challenge 검증이 아니다. 당시 scope 수정과 현재 anti-bot 호환성을 구별한다. | LOG.md#2026-08-18-18 |
| 2026-08-16 | SW / 규칙 | 오류 상태의 HTML도 격리·변환 대상이다. 4xx/5xx를 원본 실행 경로로 빼지 않는다. | LOG.md#2026-08-16-7 |
| 2026-08-16 | realm / 금지 | observedDocuments TDZ만 옮기면 이중 계측이 드러난다. realm 설치 멱등성을 먼저 고친다. | LOG.md#2026-08-16-8 |
| 2026-08-16 | SW-less / 역사 | SW 전용 API 주소를 미제어 문서에 넣으면 서버 403이다. 실제 전송·실행 경계를 구별한다. | LOG.md#2026-08-16-12 |
| 2026-08-15 | realm / 규칙 | WeakSet wrapper identity만으로 잠긴 prototype의 설치 여부를 판정하지 않는다. descriptor도 확인한다. | LOG.md#2026-08-15-9 |
| 2026-08-14 | DOM / 규칙 | document.write로 새 Document가 생기면 Document 노드를 관측한다. 옛 documentElement에 매달리지 않는다. | LOG.md#2026-08-14-1 |
| 2026-08-13 | cookie / 역사 | Cookie 전달 누락과 origin-only jar는 별개의 로그인 결함이다. scope와 실제 wire 전달을 함께 본다. | LOG.md#2026-08-13-10 |
| 2026-08-13 | build / 계측 | site-data 삭제만으로 낡은 SW가 교체됐다고 가정하지 않는다. 실제 활성 build를 확인한다. | LOG.md#2026-08-13-13 |
| 2026-08-10 | 검증 / 철회 | 원본 대신 스텁이 실행된 실험의 wedge 소멸은 해결 근거가 아니다. 트리거 실행을 확인한다. | LOG.md#2026-08-10-3 |
| 2026-08-03 | 검증 / 금지 | source-text 핀은 실행·의미 검증이 아니다. 삭제 코드의 주석을 찾아 통과하는 검사는 폐기한다. | LOG.md#2026-08-03-7 |
| 2026-07-30 | Response / 역사 | HEAD·204·304 같은 body 없는 응답에 body를 붙이면 Response 생성 자체가 실패한다. | LOG.md#2026-07-30-10 |
| 2026-07-30 | script / 역사 | classic script의 전역 선언을 Function wrapper의 지역 선언으로 바꾸지 않는다. | LOG.md#2026-07-30-12 |
| 2026-07-28 | transport / 정정 | END_STREAM 지연을 상류 anti-bot으로 단정한 서사는 철회됐다. 실제 원인은 yamux lost wakeup이었다. | LOG.md#2026-07-28-2 |
| 2026-06-19 | WASM / cancel | h2 reset 정리의 native Instant 호출은 WASM trap을 만들었다. 취소·오류 경로도 타깃 런타임에서 검증한다. | LOG.md#2026-06-19-1 |
| 2026-06-16 | WASM / 금지 역사 | SW setTimeout 기반 kernel timer의 future-cancel race가 trap을 냈다. 무조건 timer를 추가하지 않는다. | LOG.md#2026-06-16-2 |
| 2026-06-02 | TLS / 규칙 | captured spec 설치와 실제 cipher/header wire 적용은 다르다. 고정 Chrome 버전 수치를 현재 기준으로 삼지 않는다. | LOG.md#2026-06-02-2 |
| 2026-06-01 | transport / 보안 | HTTPS는 client WASM에서 TLS를 소유한다. Go relay의 target HTTP/TLS 처리는 보안 모델 회귀다. | transport-regression.md#client-tls-cutover |
| 2026-05-30 | WASM / 메모리 | memory.grow 뒤 typed-array view를 다시 얻고 scratch를 다른 호출이 덮기 전에 결과를 소비한다. | LOG.md#2026-05-30-22 |
| 2026-05-30 | WASM / 성능 | Node benchmark를 브라우저 성능으로 일반화하지 않는다. raw 문자열 왕복은 JS보다 느릴 수 있다. | LOG.md#2026-05-30-16 |

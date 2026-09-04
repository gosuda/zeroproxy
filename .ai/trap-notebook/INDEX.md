# 함정노트 인덱스

**한 항목 = 한 줄.** 상세는 카테고리 `.md` 에 쓰고 여기서 링크한다.
본문을 이 파일에 넣지 말 것 — 이 파일은 세션 시작에 통째로 읽는 1분 스캔용이다.
(2026-08-25 정리 전에는 357행 769KB 였다. 그때의 본문은 `LOG.md` 에 그대로 있다.)

형식: `| YYYY-MM-DD | 분류 | 한 문장(≤160자) | <파일>.md#<앵커> |`
급하면 `head -40 INDEX.md` — 위쪽이 최신이다.

| Date | Category | Summary | Detail |
|---|---|---|---|
| 2026-09-04 | real-site-compat | **회귀 축에 레이아웃이 없어 GitHub 이 내내 에러 페이지였다 — title 은 그대로라 통과. height/aboveFold/styleEntities 축 신설(양성 대조 303%/837).** | real-site-compat.md#레이아웃-축-없음 |
| 2026-09-04 | build-deploy | **`npm run build` 의 clean 이 dist 를 먼저 비운다 — 툴체인이 없으면 멀쩡하던 서버 바이너리까지 잃는다. 빌드 전 `command -v` 로 확인할 것.** | build-deploy.md#빌드-clean-이-유일본을-지운다 |
| 2026-08-26 | htmltx / CSS | **`<style>` 을 ContentType::Text 로 내보내 `>` 671건이 `&gt;` 가 됐다 — 규칙 98개 파싱 실패, 페이지 높이 3배, 라이브 플레이어가 화면 밖으로 밀려 정지.** | rewriter.md#style-raw-text-이스케이프 |
| 2026-08-26 | membrane | **비-HTTP 스킴이 세 군데서 죽었다: URL 게터가 읽자마자 throw / createObjectURL 이 MediaSource 를 HTML 로 교체 / fetch 가 blob 을 프록시로. CNN 비디오 세그먼트 1→48.** | rewriter.md#비-http-스킴-세-겹 |
| 2026-08-26 | real-site-compat | **CNN 2차 정지는 9회/4변종 재현 실패. 유력 후보(clients.get 교착)는 변이로 반증 — 서명이 "로드 미완" 이지 "먹통" 이 아니다. 남은 차이는 프레임 25~29 vs 33.** | real-site-compat.md#cnn-2차정지-재현불가 |
| 2026-08-26 | membrane | **`data-zp-*` 은폐가 훅 4개에만 걸려 있었다 — NS 변종·Attr 노드·dataset·named getter 로 읽기/쓰기/삭제가 전부 뚫렸다. 규칙 하나로 닫음.** | rewriter.md#data-zp-이름공간 |
| 2026-08-26 | SW / transport | **데드라인 실측: 침묵하는 상류는 504 로 잘리지만, h1 은 본문까지 한 예산이라 20초는 느린 전송을 죽였다 → 90초.** | sw-integration.md#transport-데드라인-실측 |
| 2026-08-26 | SW / CSP | **정정: "스트리밍 응답은 CSP 헤더가 강제되지 않는다" 는 틀렸다 — 데몬이 CSP 를 꺼 둔 것이었다(csp_bypassed). meta 없이도 막힌다.** | sw-integration.md#csp-스트리밍-정정 |
| 2026-08-26 | htmltx / CSP | **머리 없는 문서에서 프렐류드가 body 안으로 들어가 그 안의 CSP meta 가 무시됐다 — 앵커를 html 로 앞당겼다.** | rewriter.md#csp-meta-body |
| 2026-08-26 | 측정 도구 | **`taskweaver wait` 는 `--id` 없이 부르면 인자 오류로 0초 잔다(stderr 를 버려서 조용하다). 러너의 150초 대기가 전부 no-op 이었다.** | build-deploy.md#execjs-문맥 |
| 2026-08-26 | SW / Referer | **meta 로만 선언한 참조 정책이 페이지 fetch 에만 안 먹었다(문서 정책은 Request 객체에 없다). 메시지로 알려 주는 건 첫 fetch 보다 느리다.** | sw-integration.md#meta-referrer |
| 2026-08-26 | SW / Referer | **최상위 문서가 자기 자신을 Referer 로 보냈다. 고칠 때 함정: 내비게이션의 Referer 는 헤더에 없고 request.referrer 에 있다.** | sw-integration.md#자기-referer |
| 2026-08-25 | membrane / 프레임 | **창의 postMessage 를 소유 속성으로 갈아끼워 자식→부모 e.source 가 전부 부모로 뒤집혀 있었다(대조군 59건 vs 0건). bounce/SafeFrame 핸드셰이크가 이걸로 죽었다.** | rewriter.md#postmessage-incumbent |
| 2026-08-25 | SW / 내비게이션 | **응답 경로에서 `clients.get(resultingClientId)` 를 await 해 내비게이션이 교착했다 — SW 는 200 을 만드는데 브라우저가 영영 커밋 못 한다. CNN 문서 6→0.** | sw-integration.md#clients-get-교착 |
| 2026-08-25 | real-site / 광고 | CNN 프레임 21~25 vs 34 — apstag-iframe 은 bounce 가 만들고 sspConfig 가 비어 게이트에서 막힌다(미해결, 반증 가설 4개 기록). | real-site-compat.md#cnn-aps-프레임 |
| 2026-08-25 | membrane / 성능 | 멤브레인을 넓게 감쌌더니 CNN 렌더러가 굳었다 — 브랜드 체크의 예외 비용 + 창 사슬(CMP 상승 루프)까지 감싼 탓. URL 성분만 감싸도록 좁혔다. | rewriter.md#document-location-유출 |
| 2026-08-25 | membrane / 리라이터 | `document.location` 이 프록시 주소를 흘렸다 — 별칭 한 번이면(`var u=n.location`) 리라이터의 지역-수신자 skip 규칙으로 멤브레인이 꺼졌다. | rewriter.md#document-location-유출 |
| 2026-08-25 | membrane / 내비게이션 | `<base href>` 한 줄이면 문서째 프록시 밖으로 나갔다 — 프록시 경로를 상대로 넘겨 타깃 base 가 재조준했다. | rewriter.md#base-href-탈출 |
| 2026-08-25 | 방법론 / 계측 | 정정 — nav-matrix 대조군 열이 빈 건 러너 결함이 아니라 내가 같은 taskweaver 데몬으로 동시에 프로브를 돌린 탓이었다. | sw-integration.md#nav-matrix-대조군 |
| 2026-08-25 | sw / 격리·지문 | Referrer-Policy 를 아예 안 보고 있었다 — 타깃이 금지한 것을 우리가 대신 흘렸다. | sw-integration.md#referrer-policy |
| 2026-08-25 | sw / 프레임·격리 | 리다이렉트가 문서 entry 를 옮기는 코드가 서브리소스에도 걸려, CNN 광고가 통째로 죽었다. | sw-integration.md#리다이렉트-entry |
| 2026-08-24 | membrane / 프레임 | CNN 이 렌더러를 세운 진짜 원인 — 교차창 프록시의 `parent` 가 자기 자신이었다. | LOG.md#2026-08-24-1 |
| 2026-08-24 | membrane / 지문 | 설치 검증이 "값 비교" 라 객체를 돌려주는 게터에서 영원히 실패했다 — `navigator.userAgentData`. | LOG.md#2026-08-24-2 |
| 2026-08-24 | membrane / 지문 | "잉여니까 지우자" 가 진짜 결함을 꺼냈다 — 컬렉션 표면이 감싼 대상과 달랐다. | LOG.md#2026-08-24-3 |
| 2026-08-24 | membrane / 성능 | 우리 필터 컬렉션이 O(N²) 이라 CNN 이 렌더러를 세웠다. | LOG.md#2026-08-24-4 |
| 2026-08-24 | sw / timing | "레이스처럼 보였는데 원인은 용량이었다" — 문서가 자기 인코딩 기록을 스스로 밀어냈다. | rewriter.md#레이스처럼 |
| 2026-08-24 | membrane / 직렬화 | 세정기가 못 걷는 곳을 직렬화기는 걷는다 — `<template>`. | rewriter.md#template |
| 2026-08-23 | 방법론 / membrane | 정정: "미해명" 이라고 적어 둔 것은 조사 실패가 아니라 틀린 전제였다 + SO 실페이지 재확인 0건. | rewriter.md#stackoverflow-재확인 |
| 2026-08-23 | membrane | 사이트를 넓히니 또 나왔다 — "3개 사이트 0건" 은 0건이 아니다. | LOG.md#2026-08-23-2 |
| 2026-08-23 | membrane | ★ 문서 압축까지 닫아 지문 탐지 0건. 그리고 "구조적으로 안 된다" 던 내 진단이 틀렸음을 확인. | LOG.md#2026-08-23-3 |
| 2026-08-23 | membrane | 압축 배관(커널→SW→페이지) — "모든 응답이 비압축으로 보인다" 를 0/200 → 198/200 으로 닫았다. 문서 하나는 헤더로는 원리적으로 불가능함을 실측으로 확인. | LOG.md#2026-08-23-4 |
| 2026-08-22 | membrane | ★ 타이밍 축 신설 — 이름은 디프록시했는데 타이밍 필드를 안 고쳐 "우리가 하는 말과 타이밍이 서로 모순" 이었다. | LOG.md#2026-08-22-1 |
| 2026-08-22 | membrane | ★ 지문 탐지기를 실사이트에 댔다 — 새 표면 하나 + | LOG.md#2026-08-22-2 |
| 2026-08-22 | rewriter | ★ 마지막 직렬화 표면을 닫았다 — 지문 흔적 0. 그 과정에서 "수십 초" 라는 주석이 오늘은 사실이 아님을 실측으로 확인(이 세션 세 번째 낡은 측정). | LOG.md#2026-08-22-3 |
| 2026-08-22 | membrane | 통합 2차 — 되돌리기가 세 벌, 자산 목록이 세 벌, 죽은 세정기 하나. 그리고 목록을 지우자 가드 하나가 엉뚱한 걸 재고 있었음이 드러났다. | LOG.md#2026-08-22-4 |
| 2026-08-22 | membrane | ★ 직렬화는 표면이 하나가 아니고, 세정기가 자기 은폐에 눈멀었다. + rt wasm 이 타깃 서버로 나가고 있었다(로드 1회에 9번). | LOG.md#2026-08-22-5 |
| 2026-08-22 | membrane | ★ 지문 축 신설 — 전역 스크러버가 "적이 서지 않는 자리"에 걸려 있었다. 리라이트 경유로 보면 `__zp_*` 24개가 그대로 보인다. | LOG.md#2026-08-22-6 |
| 2026-08-22 | membrane | ★ 스토리지/쿠키 격리 축을 처음 세웠다 — 진짜 결함 둘 + 내 측정이 만든 가짜 누출 둘. | LOG.md#2026-08-22-7 |
| 2026-08-21 | rewriter | ★ 재현성 축에는 '의도적'이라는 개념이 없었다 — 늘 앉아 있는 7칸 목록에 새 회귀가 끼면 안 보인다. | LOG.md#2026-08-21-1 |
| 2026-08-21 | rewriter | ★ preconnect 계측 안정화 — 원인은 브라우저가 아니라 내가 만든 계측 쪽 버그 둘이었다. | LOG.md#2026-08-21-2 |
| 2026-08-21 | rewriter | ★ SRI 를 안 벗겨서 스크립트가 통째로 차단되고 있었다 + meta CSP 는 페이지 realm 에서 그대로 먹혔다 (상호 결손). | LOG.md#2026-08-21-3 |
| 2026-08-21 | rewriter | ★ `<base href>` 를 리라이터가 무시하고 있었다(고침). 그리고 `link rel` "서버측 부재" 는 재 보니 결함이 아니었다. | LOG.md#2026-08-21-4 |
| 2026-08-21 | sw-integration | ★ Go 의 응답 헤더 정책 전체가 죽은 코드였다 — 호출자 0. 계획 9번(CORS)의 전제가 무너졌다. | LOG.md#2026-08-21-5 |
| 2026-08-21 | rewriter | ★ `?url=` 빌더 4벌 통일 — 프래그먼트를 삼키면 `<use href="sprite.svg#i">` 가 빈 채로 렌더된다. + 계측 결함 2건 발견. | LOG.md#2026-08-21-6 |
| 2026-08-21 | rewriter | ★ srcset 분해기 4벌 중 3벌이 `split(',')` 이었고, 요소 훅 두 경로에는 srcset 분기가 아예 없었다. | LOG.md#2026-08-21-7 |
| 2026-08-21 | rewriter | `resolve_against_base` 가 dot-segment 를 안 접었다 — 그런데 감사가 적어 둔 심각도(404/캐시 깨짐)는 과장이었다. | LOG.md#2026-08-21-8 |
| 2026-08-21 | sw-integration | ★ 해결: 리다이렉트 상한을 넘으면 마지막 3xx 를 브라우저에 넘기고 있었다 — 세 번째 진짜 탈출. + 상한 5 가 탈출에 가려져 있었다. | LOG.md#2026-08-21-9 |
| 2026-08-21 | wasm-page-rt | ★ 해결: URL 표면 목록을 한 곳으로 — 프렐류드 손목록 제거, 그리고 어제 만든 표가 오늘 내 회귀를 잡았다. | LOG.md#2026-08-21-10 |
| 2026-08-21 | build-deploy | ★ 해결: 에러 코드 목록이 네 벌이었고 Go 는 자기가 내는 코드를 강등하고 있었다. | LOG.md#2026-08-21-11 |
| 2026-08-21 | sw-integration | ★ 해결: 릴레이로 받은 CSS 안의 `url()` 이 SW-less 문서에서 403 — 그리고 매트릭스 칸이 있는데도 안 보이던 이유. | LOG.md#2026-08-21-12 |
| 2026-08-21 | wasm-page-rt | ★ 해결: `object[data]` — 가드 둘이 서로 반대를 주장했는데 모순이 아니라 질문이 둘이었다. | LOG.md#2026-08-21-13 |
| 2026-08-21 | wasm-page-rt | ★ 측정 사고 2연발 + 미해결 국소화: SW-less 프레임이 릴레이로 받은 CSS 안의 `url()` 이 403. | LOG.md#2026-08-21-14 |
| 2026-08-21 | wasm-page-rt | ★ 해결: 구현이 두 벌이면 표도 두 벌이어야 한다 — 페이지 realm 리라이트가 htmltx 와 세 자리에서 갈라져 있었다. | LOG.md#2026-08-21-15 |
| 2026-08-20 | wasm-page-rt | ★ 해결: 프레임 내비게이션 축을 세우니 같은 규칙의 | LOG.md#2026-08-20-1 |
| 2026-08-20 | sw-integration | ★ 해결: `Refresh` 응답 헤더로 또 문서째 탈출 — 축을 세우자마자 나온 두 번째 진짜 탈출. | LOG.md#2026-08-20-2 |
| 2026-08-20 | wasm-page-rt | ★ 해결: `<meta http-equiv=refresh>` 로 문서째 타깃으로 나갈 수 있었다 — 이번 세션 유일한 진짜 탈출. | LOG.md#2026-08-20-3 |
| 2026-08-20 | wasm-page-rt | ★ 정정 + 해결: "SW-less 프레임 광고 이미지가 안 뜬다" 는 틀렸다 — 뜬다. 진짜 문제는 로드마다 쌓이는 403 왕복이었다. | LOG.md#2026-08-20-4 |
| 2026-08-20 | build-deploy | 닫음: taskweaver `start` 가 파이프 호출자에게 안 끝나던 문제 — 0.16.1 에서 수정, 우회책 폐기. | LOG.md#2026-08-20-5 |
| 2026-08-20 | wasm-page-rt | ★ 후속: 판정 버그를 고치자 위험의 방향이 뒤집혔다 — 과대보고에서 과소보고로. | LOG.md#2026-08-20-6 |
| 2026-08-20 | wasm-page-rt | ★ 해결: 추론을 실측으로 확인하러 갔더니 틀린 건 추론이 아니라 측정 도구였다 — 매트릭스가 `csp-only` 를 LEAK 으로 올려 부르고 있었다. | LOG.md#2026-08-20-7 |
| 2026-08-20 | wasm-page-rt | 도구: URL 표면 인벤토리 대조를 테스트로 고정했다 — "사람이 기억해서 하는 일" 을 없앴다. | LOG.md#2026-08-20-8 |
| 2026-08-20 | sw-integration | ★ 해결: 프록시 페이지를 열 때마다 CSP 콘솔 경고가 하나씩 나오고 있었다 + ★측정 사고: 압축된 출력을 근거로 "헤더가 없다" 고 결론낼 뻔했다. | LOG.md#2026-08-20-9 |
| 2026-08-20 | wasm-page-rt | ★ 해결: 매트릭스의 "정적 칸"을 채우자 파싱 시점 서브리소스 구멍 여섯 개가 한꺼번에 나왔다(전부 csp-only). | LOG.md#2026-08-20-10 |
| 2026-08-20 | real-site-compat | 닫음(측정): naver shopad 잔여 건 — 관측기 무장 상태로 20회 연속 로드, 원본 URL 0건. | LOG.md#2026-08-20-11 |
| 2026-08-20 | wasm-page-rt | ★ 해결: 마크업에 박혀 온 `<iframe src>` 가 리라이트를 통째로 건너뛰고 있었다(csp-only). + ★측정 사고: `csp_bypassed` 를 확인 안 해서 그 앞 26회 관측이 전부 무의미했다. | LOG.md#2026-08-20-12 |
| 2026-08-19 | tls-fingerprint | ★ 해결: 순서 셔플에서 `fe0d`(ECH GREASE) 하나만 빠져 있었다 — 우리만 항상 마지막이었고, 그렇게 둔 근거가 낡은 주석이었다. | LOG.md#2026-08-19-1 |
| 2026-08-19 | real-site-compat | ★ 닫음(측정): NAVER 의 `Service Worker control timeout after 5000ms` 는 실재하지만 | LOG.md#2026-08-19-2 |
| 2026-08-19 | build-deploy | ★ 해결: 내부 에셋 재검증 왕복이 남아 있던 이유는 `immutable` 이 안 먹혀서가 아니라 | LOG.md#2026-08-19-3 |
| 2026-08-19 | tls-fingerprint | ★ 해결: 지문 차이는 내용이 아니라 "안정성" 이었다 — 확장 순서를 연결마다 섞게 고쳤다. 그리고 그 고정 순서를 만든 게 지문을 맞추려고 넣은 우리 코드였다. | LOG.md#2026-08-19-4 |
| 2026-08-19 | real-site-compat | 도구: taskweaver 0.15.0 의 `inject-script`(document-start) 로 shopad 관측기를 상시 무장해 뒀다 — 다음 재현 때 바로 답이 나온다. | LOG.md#2026-08-19-5 |
| 2026-08-19 | real-site-compat | 미해결(범위 대폭 축소): naver shopad 의 서브리소스가 간헐적으로 원본 URL 로 나간다 — 이제 "어떤 API 가 빠졌나" 가 아니라 "언제 훅이 없었나" 문제다. | LOG.md#2026-08-19-6 |
| 2026-08-18 | wasm-page-rt | ★ 도구: 프록시 문서 CSP 에 `report-uri` 를 달았다 — "리라이트를 놓친 자리" 를 이름으로 알려 주는 유일한 통로. | LOG.md#2026-08-18-1 |
| 2026-08-18 | wasm-page-rt | ★ 해결: `setAttributeNS(null,'src',…)` 가 서브리소스에 타깃 절대 URL 을 그대로 써서 원본 요청이 나갔다(CSP 만 막고 있었다). | LOG.md#2026-08-18-2 |
| 2026-08-18 | real-site-compat | 미해결(범위는 크게 좁힘): naver 의 `s.pstatic.net/shopping.phinf/*` 이미지 5건이 간헐적으로 원본 URL 로 나간다 — CSP 가 막고 있어 유출은 아니다. | LOG.md#2026-08-18-3 |
| 2026-08-18 | real-site-compat | ★ 해결: NAVER "로그인 제출 차단" 과 "제출 후 60초 wedge" 는 둘 다 실재하지 않았다 — Accept-Language 하드코딩이 만든 측정 사고였다. | LOG.md#2026-08-18-4 |
| 2026-08-18 | wasm-page-rt | ★ 결정 닫힘: `configurable:false` 116곳은 유지한다 — 세 번째 선택지(디스크립터 위장)는 우리 코드가 먼저 깨져서 불가능하다. | LOG.md#2026-08-18-5 |
| 2026-08-18 | tls-fingerprint | ★ 해결: ALPS(17613)를 실제로 구현했다 — "광고만 하고 못 지키던" 확장을 빼는 대신 지킬 수 있게 만들었다. | LOG.md#2026-08-18-6 |
| 2026-08-18 | wasm-page-rt | ★ 해결: `ping` 을 CSP 가 아니라 | LOG.md#2026-08-18-7 |
| 2026-08-18 | sw-integration | ★ 해결: 파싱 시점 `srcdoc` 은 멤브레인 없는 문서를 만든다 — 서버측 htmltx 가 `srcdoc` 을 통째로 무시하고 있었다(처리 0곳). | LOG.md#2026-08-18-8 |
| 2026-08-18 | real-site-compat | wikipedia 포털 l10n 404 8건 — 재현되지 않는다(콜드 3/3 깨끗). 다만 원인은 끝내 귀속하지 못했다. | LOG.md#2026-08-18-9 |
| 2026-08-18 | real-site-compat | ★ NAVER 로그인 "제출 후 60초 wedge" 를 재현하러 갔다가, 그 앞단에서 막혀 있음을 확인했다 — 제출 자체가 안 일어난다. | LOG.md#2026-08-18-10 |
| 2026-08-18 | real-site-compat | ★ 해결: 광고만 하고 못 지키는 TLS 확장 하나(ALPS/17613)가 Google 계열 호스트를 전부 죽이고 있었다. | LOG.md#2026-08-18-11 |
| 2026-08-18 | real-site-compat | ★ 해결됨(같은 날 ALPS 항목에서 종결): Google 계열 호스트 전부가 TLS 로 죽는다 — `received fatal alert: UnexpectedMessage`. 크기/스크립트 문제가 아니라 호스트 문제다. | LOG.md#2026-08-18-12 |
| 2026-08-18 | build-deploy | ★ 진단용 임시 플래그가 커밋되어 progressive streaming 이 통째로 꺼진 채 3개월 가까이 굴러갔다. | LOG.md#2026-08-18-13 |
| 2026-08-18 | membrane | ★ 설계: 리라이터가 못 보는 자리는 원천 차단이 불가능하다 — "타깃 URL 이 되는 입구" 셋에 단일 정규화 게이트를 둔다. | LOG.md#2026-08-18-14 |
| 2026-08-18 | membrane | ★ 해결: Cloudflare 챌린지가 죽던 진짜 원인은 지문이 아니라 `eval` 의 스코프 시맨틱이었다 — indirect eval 의 최상위 선언은 전역이어야 한다. | LOG.md#2026-08-18-15 |
| 2026-08-18 | membrane | ★ 해결: `location` 은 [LegacyUnforgeable] 이라 훅을 못 건다 — 난독화 코드가 진짜 window 를 잡으면 우리 프록시 경로가 페이지로 새어 나간다. | LOG.md#2026-08-18-16 |
| 2026-08-18 | real-site-compat | ★ 측정 함정: naver 감사에서 `outside 10 / csp 10`(spastatic.naver.com) 이 한 번 떴는데 회귀가 아니라 로드 변동이었다. | LOG.md#2026-08-18-17 |
| 2026-08-18 | real-site-compat | ★ Cloudflare 챌린지 크래시의 정확한 모양을 특정했다 — VM 의 "메서드 호출" 옵코드에서 `obj[method]` 가 undefined 다. 그리고 웜 통과는 착시였다. | LOG.md#2026-08-18-18 |
| 2026-08-18 | sw-integration | ★ 같은 틱에 `history.replaceState` 하고 서브리소스를 붙이면 Referer 가 갱신 전 URL 로 나간다 — 우리 SW 통지가 postMessage(비동기)라서다. Cloudflare 챌린지가 정확히 그 패턴이다. | LOG.md#2026-08-18-19 |
| 2026-08-16 | real-site-compat | ★ 기각(측정): `configurable:false` 를 `true` 로 풀어도 Cloudflare 챌린지는 그대로다 — 격리를 약화시키는 값을 치를 이유가 없다. | LOG.md#2026-08-16-1 |
| 2026-08-16 | wasm-page-rt | ★ 미해결/설계 결정 필요: 우리가 후킹한 DOM 멤버는 전부 `configurable:false` 다 — 실제 브라우저는 전부 `configurable:true`. 프로토타입을 훑어 세기만 해도 멤브레인이 드러난다(측정 121곳). | LOG.md#2026-08-16-2 |
| 2026-08-16 | wasm-page-rt | ★ `window` 에 own 프로퍼티로 심은 훅은 그 자체가 지문이다 — 프록시 realm 의 `Object.getOwnPropertyNames(window)` 가 직접 로드와 딱 두 개 달랐다. | LOG.md#2026-08-16-3 |
| 2026-08-16 | wasm-page-rt | ★ UA 는 가려 놓고 `navigator.userAgentData` 와 `window.chrome` 은 호스트 셸(Edge WebView2)을 그대로 불고 있었다 — 가면은 층마다 따로 씌워야 한다. | LOG.md#2026-08-16-4 |
| 2026-08-16 | real-site-compat | ★ Cloudflare 챌린지 JS 가 우리 안에서 던지는 TypeError 는 리라이터 탓이 아니다 — 원본 그대로 줘도 똑같이 터진다(결정적 실험). | LOG.md#2026-08-16-5 |
| 2026-08-16 | tls-fingerprint | ★ 동결된 지문은 시간이 지나면 저절로 틀려진다 — 우리 wire 는 2026-07-03 "Chrome 완전 일치" 그대로인데 Chrome 이 움직였다. 다섯 축을 다시 맞췄다. | LOG.md#2026-08-16-6 |
| 2026-08-16 | sw-integration | ★ 4xx/5xx 인 HTML 문서가 리라이트를 통째로 건너뛰고 있었다 — Cloudflare 챌린지가 "영원히 Just a moment..." 였던 진짜 이유이자, 잠재적 격리 탈출. | LOG.md#2026-08-16-7 |
| 2026-08-16 | wasm-page-rt | ★ "명백한 TDZ 버그" 를 고쳤더니 더 크게 깨졌다 — `observedDocuments` 의 TDZ 는 이중 계측 버그를 가려 주는 중이다. 올리지 말 것. | LOG.md#2026-08-16-8 |
| 2026-08-16 | real-site-compat | 결정: SW-less 프레임 이미지의 403(naver 8건)은 고치지 않고 둔다 — 최종 화면은 동일하고 비용은 "첫 표시가 한 박자 늦음" 뿐이다. | LOG.md#2026-08-16-9 |
| 2026-08-16 | wasm-page-rt | ★ 릴레이로 서브리소스를 대량 보낼 수 없는 이유는 base64 도 폴링 왕복도 아니라 HTTP/1.1 커넥션 한계다 — 병목을 두 번 잘못 짚고 세 번째에 찾았다. | LOG.md#2026-08-16-10 |
| 2026-08-16 | wasm-page-rt | 남은 이미지 403 을 "문자열 단계 파킹" 으로 없애 봤다가 기각 — 소음은 0 이 됐지만 이미지가 영구히 안 나온다(broken 5~9). | LOG.md#2026-08-16-11 |
| 2026-08-16 | wasm-page-rt | ★ SW-less 문서에 `/zp/api/fetch` 를 박는 것 자체가 틀린 리라이트였다 — 그 경로는 SW 안에만 있고 Go 에는 핸들러가 없다(default → 403). | LOG.md#2026-08-16-12 |
| 2026-08-15 | real-site-compat | naver 403 8건 + "Refused to apply style" 3건 — 두 가지 수정을 시도해 둘 다 실측으로 기각했다. 요소 훅 위치에서는 원리상 못 고친다. | LOG.md#2026-08-15-1 |
| 2026-08-15 | wasm-page-rt | ★ `filteredCollection` 의 `has` 트랩 정규식이 이중 이스케이프(`[1-9]\\d*`)라 인덱스 1 이상이 통째로 사라졌다 — `Array.prototype.map.call(nodeList, …)` 가 0번만 돈다. | LOG.md#2026-08-15-2 |
| 2026-08-15 | wasm-page-rt | ★ storage 파사드가 `localStorage.token = "x"` 를 조용히 삼키고 있었다 — frozen 평범한 객체라 비엄격 모드에서 throw 도 없다. | LOG.md#2026-08-15-3 |
| 2026-08-15 | real-site-compat | wikipedia.org 포털 l10n 404 8건 — 경계까지 좁혔고 사용자 영향은 0. 여기서 멈춘 이유까지 남긴다. | LOG.md#2026-08-15-4 |
| 2026-08-15 | wasm-page-rt | ★ 프록시에서 `postMessage(msg, "https://<타깃>")` 는 브라우저가 조용히 버린다 — 수신 창의 실제 오리진은 늘 프록시 오리진이다. 컨테인먼트를 건너뛰는 프레임에 구멍이 있었다. | LOG.md#2026-08-15-5 |
| 2026-08-15 | real-site-compat | ★ 네이버 밖 교차 사이트 감사 — 사이트별 예외가 아니라 "프레임워크 관용구" 단위로 깨진다. 두 개 고치고 하나 남겼다. | LOG.md#2026-08-15-6 |
| 2026-08-15 | build-deploy | ★ 프록시 페이지에서 raw `exec-js` 로 잰 값은 사이트가 보는 값이 아니다 — `location.href` 가 프록시 URL 로 보여서 "세션 키 유출" 로 오진할 뻔했다. | LOG.md#2026-08-15-7 |
| 2026-08-15 | wasm-page-rt | ★ `observedDocuments` 의 TDZ 는 진짜 버그지만 고치면 안 된다 — 고쳤더니 렌더러 working set 이 6.3GB 로 폭주했다. 조사 끝, 되돌림. | LOG.md#2026-08-15-8 |
| 2026-08-15 | wasm-page-rt | ★ `configurable: false` 로 심는 자리는 WeakSet 신원 가드가 안 먹는다 — 멤브레인이 매번 다른 래퍼를 주기 때문. 디스크립터로 판정할 것. | LOG.md#2026-08-15-9 |
| 2026-08-15 | build-deploy | ★ 구멍 매트릭스는 실행 전에 반드시 site-data 를 비울 것 — 연속 실행이 서로 오염돼 "전 항목 회귀" 처럼 보인다. | LOG.md#2026-08-15-10 |
| 2026-08-15 | wasm-page-rt | ★ SW-less 프레임의 `<link rel=stylesheet>` 가 403 을 받고 있었다 — "광고 낙찰 차이" 로 넘겼던 것의 정체. | LOG.md#2026-08-15-11 |
| 2026-08-15 | real-site-compat | ★ 프록시 vs 직접 비교에서 프레임 내용을 세면 반드시 오진한다 — 직접 사이트의 광고 프레임은 교차 오리진이라 안이 안 보인다. | LOG.md#2026-08-15-12 |
| 2026-08-14 | wasm-page-rt | ★ `document.write` 프레임에 MutationObserver 를 달 때는 반드시 Document 노드에 달 것 — documentElement 에 달면 콜백이 한 번도 안 돈다. | LOG.md#2026-08-14-1 |
| 2026-08-14 | build-deploy | ★ 이 머신에서 `python` 은 스텁이라 heredoc 스크립트가 조용히 안 돈다 — 그리고 prelude 는 파일 안에서 LF/CRLF 가 섞여 있다. | LOG.md#2026-08-14-2 |
| 2026-08-14 | wasm-page-rt | ★ `with(__zp_scope)` 의 has 트랩이 컴파일된 함수의 파라미터와 `arguments` 까지 가렸다 — `new Function("x","return typeof x")(1)` 이 "undefined" 였다. | LOG.md#2026-08-14-3 |
| 2026-08-14 | wasm-page-rt | ★ e1/e4 해결 — `document.write` 프레임의 서브리소스를 부모가 대신 받아 blob 으로 물려준다. 판정 열쇠는 "문서 URL 이 최상위와 같다"였다. | LOG.md#2026-08-14-4 |
| 2026-08-14 | build-deploy | ★ 측정 도구 자체의 함정 3종 — 이것 때문에 "고쳤는데 안 고쳐졌다" 를 세 번 봤다. | LOG.md#2026-08-14-5 |
| 2026-08-14 | real-site-compat | ★ 남은 구멍 — GNB/pay 레이어 iframe 의 프레임 내비게이션이 원본 URL 로 나간다(차단되지만 리라이트는 놓친다). 다음 세션의 1순위. | LOG.md#2026-08-14-6 |
| 2026-08-14 | real-site-compat | ★ 장바구니(order.pay.naver.com) 로그인 상태 E2E — GNB 스프라이트가 안 뜨던 원인은 `<style>` 텍스트가 자식 텍스트 노드로 들어오는 경로였다. | LOG.md#2026-08-14-7 |
| 2026-08-14 | wasm-page-rt | ★ `el.style.backgroundImage = url(…)` 는 프로토타입 훅으로 못 잡는다 — 인스턴스 own property 라 containment proxy 로 갔다. 그리고 TDZ 함정을 같은 파일에서 한 시간 안에 두 번 밟았다. | LOG.md#2026-08-14-8 |
| 2026-08-14 | wasm-page-rt | ★ 차단 스텁이 상대 URL 을 쓰는 바람에 "차단 이유" 가 엉뚱한 에러로 보고됐다 + `document.write` iframe 서브리소스의 정확한 실패 지점(403) 확정. | LOG.md#2026-08-14-9 |
| 2026-08-14 | wasm-page-rt | ★ 런타임 CSS 의 cross-origin `url()` 을 페이지 realm 에서 리라이트 — 마지막 비-의도 격리 취약점을 닫았다. 그리고 그 과정에서 TDZ 로 멤브레인 설치를 통째로 날려먹었다. | LOG.md#2026-08-14-10 |
| 2026-08-14 | rewriter | ★ 동적 `import()` 래퍼가 인자 안쪽으로 빨려 들어가 specifier 매핑이 통째로 사라졌다 — zero-width 패치를 마커로 바꿔 수정. | LOG.md#2026-08-14-11 |
| 2026-08-14 | wasm-page-rt | ★ `<object data>` / `<embed src>` 런타임 구멍 — 닫았다. 그리고 같은 날 이 표의 두 항목(`ddb3b50`, `25034a6`)은 | LOG.md#2026-08-14-12 |
| 2026-08-14 | wasm-page-rt | ★ `<object data>` / `<embed src>` 런타임 구멍 추적 — 원인 두 겹까지 좁혔고 아직 안 닫혔다. 다음 세션이 바로 이어갈 수 있게 확정 사실만 남긴다. | LOG.md#2026-08-14-13 |
| 2026-08-14 | real-site-compat | ★ 구멍 매트릭스 — 페이지가 URL 을 내보내는 32 경로를 전수 측정. 격리는 전 항목 유지(진짜 유출 0), 재현성은 10건 실패. | LOG.md#2026-08-14-14 |
| 2026-08-14 | sw-integration | ★ "광고 iframe 에서 fetch 가 외부로 샌다" 는 내 판정이 틀렸다 — 픽스처 서버의 히트 로그로는 "브라우저가 직접 갔다" 와 "프록시가 대신 가져왔다" 를 구분할 수 없다. | LOG.md#2026-08-14-15 |
| 2026-08-14 | sw-integration | ★ "런타임 주입 CSS 는 페이지 realm 에 CSS 리라이터가 없어서 깨진다" 는 진단이 틀렸다 — 실제로는 SW `classify` 가 거절하고 있었다. 0KB 로 7개 중 6개가 닫혔다. | LOG.md#2026-08-14-16 |
| 2026-08-14 | build-deploy | ★ `assetPath()` 는 URL 생성과 경로 비교 | LOG.md#2026-08-14-17 |
| 2026-08-14 | build-deploy | ★ 우리 에셋이 페이지 로드마다 1MB 씩 다시 내려가고 있었다 — 캐시를 막은 곳이 두 겹이었다. | LOG.md#2026-08-14-18 |
| 2026-08-14 | real-site-compat | 광고 iframe 의 서브리소스만 SW 를 우회해 Go 로 가서 403 을 받는다 — 배너 3장이 안 뜬다. 나머지는 정상. | LOG.md#2026-08-14-19 |
| 2026-08-14 | membrane | ★ CSS 가 사는 곳이 네 갈래인데 세 갈래만 처리하고 있었다. `--enforce-csp` 회귀 스윕으로 하나씩 드러났다. | LOG.md#2026-08-14-20 |
| 2026-08-14 | zp-htmltx | ★ 인라인 `<style>` 의 CSS 가 아무에게도 리라이트되지 않고 있었다 — CSS 리라이터를 `zp-css` 로 분리해 해결. | LOG.md#2026-08-14-21 |
| 2026-08-14 | zp-htmltx | ★ `srcset` 이 리라이트 목록에 없었다 — 그리고 같은 목록이 두 곳에 복제돼 있어 한쪽만 고치면 조용히 누락된다. | LOG.md#2026-08-14-22 |
| 2026-08-14 | policy | ★ 타깃의 `Content-Security-Policy-Report-Only` 를 그대로 통과시키고 있었다 — 브라우저가 타깃에게 직접 POST 하는 유출 경로. | LOG.md#2026-08-14-23 |
| 2026-08-14 | tooling | ★ 정정: "프록시 문서에서 CSP 가 강제되지 않는다" 는 전부 계측 오염이었다. taskweaver 가 CSP 를 꺼 놓고 있었다. | LOG.md#2026-08-14-24 |
| 2026-08-14 | zp-htmltx | 타깃이 `<meta http-equiv="Content-Security-Policy">` 로 보내는 자기 CSP 를 무력화한다. | LOG.md#2026-08-14-25 |
| 2026-08-13 | policy | △CSP 가 무시되는 조건을 스트리밍 문서로 좁혔다. 헤더도 meta 도 안 먹는다 — 기전 미규명. | LOG.md#2026-08-13-1 |
| 2026-08-13 | membrane | ★ `img.src = url` 프로퍼티 쓰기가 리라이트를 통째로 건너뛰고 있었다 — 느슨한 CSP 가 그걸 덮어 주고 있었다. | LOG.md#2026-08-13-2 |
| 2026-08-13 | policy | △프록시 문서에서 CSP 가 강제되지 않는다 — 헤더는 실려 있는데 외부 이미지가 그대로 로드된다. 미해결. | LOG.md#2026-08-13-3 |
| 2026-08-13 | membrane | ★ 서버(htmltx)와 런타임(prelude)이 같은 속성을 다르게 리라이트하고 있었다 — srcdoc 거절의 진짜 원인. | LOG.md#2026-08-13-4 |
| 2026-08-13 | policy | ★ CSP 가 세 곳에 있었고, 실제로 프록시 문서를 지배하는 하나만 아무 데도 안 묶여 있어 조용히 흘렀다. | LOG.md#2026-08-13-5 |
| 2026-08-13 | sw | ★ 거절당한 요청을 로그로 남기게 했다 — "화면이 이상하다" 를 URL 목록으로 바꾸는 장치. | LOG.md#2026-08-13-6 |
| 2026-08-13 | membrane | ★ window 프록시의 `has` 트랩이 모든 이름에 true 였다 — `A in obj // (obj[A]=…)` 관용구를 쓰는 사이트가 통째로 죽는다. | LOG.md#2026-08-13-7 |
| 2026-08-13 | membrane | ★ `<a href="#">` 를 탭/토글로 쓰는 페이지가 통째로 죽어 있었다 — 우리가 클릭을 삼켰다. | LOG.md#2026-08-13-8 |
| 2026-08-13 | transport | ★ 쿠키 jar 를 origin 으로 키잉해서, 서브도메인이 다르면 로그인이 통째로 안 보였다. | LOG.md#2026-08-13-9 |
| 2026-08-13 | transport | ★ Rust 커널이 모든 요청에서 `Cookie` 헤더를 통째로 버리고 있었다 — 프록시 전체가 쿠키 없이 나가고 있었다. | LOG.md#2026-08-13-10 |
| 2026-08-13 | zp-htmltx | ★ `<head>` 없는 문서에는 프렐류드가 통째로 안 들어갔다 — 로그인 후 흰 화면의 원인. | LOG.md#2026-08-13-11 |
| 2026-08-13 | real-site-compat | ★ 캡차가 프록시에서 정상 동작한다 — 동기 XHR 중계가 실제로 통했다. | LOG.md#2026-08-13-12 |
| 2026-08-13 | build-deploy | ★ sw.js 를 고쳐도 브라우저가 낡은 Service Worker 를 계속 문다. `clear-site-data` 로는 안 걷힌다 — 세 번 연속 오진했다. | LOG.md#2026-08-13-13 |
| 2026-08-13 | membrane | ★ 동기 XHR 을 감옥 안에서 지원한다 — Go 가 park 하고 SW 가 전송하는 중계 구조. | LOG.md#2026-08-13-14 |
| 2026-08-13 | real-site-compat | ★ NAVER 캡차가 "틀렸다" 고 나오는 이유 = 우리가 동기 XHR 을 막아서다. 캡차의 핵심 3요청이 전부 그걸로 나간다. | LOG.md#2026-08-13-15 |
| 2026-08-12 | diagnostic / real-site-compat | ★ NAVER WTM wedge 조사 (2026-08-02 ~ 08-12, 인덱스 38행을 여기로 접음) — 원인은 우리 `Notification.permission` 게터의 무한 재귀였다 | LOG.md#2026-08-12-wtm |
| 2026-08-12 | real-site-compat | ★ NAVER anti-bot 차단을 전부 걷었다. 세 문제 모두 원인이 우리 코드였고, 차단은 증상만 덮고 있었다. | LOG.md#2026-08-12-1 |
| 2026-08-12 | real-site-compat | ★ 캡차 전제 조건이 전부 충족됐다 — 프록시에서 `nhomz` 정의되고 ncaptcha SDK 가 완전히 로드된다. | LOG.md#2026-08-12-2 |
| 2026-08-12 | real-site-compat | ★ "wedge" 판정 기준이 틀렸다. 한 번 타임아웃했다고 굳은 게 아니다 — 메인 스레드가 30초 넘게 막혔다가 되살아나는 구간이 있다. | LOG.md#2026-08-12-3 |
| 2026-08-12 | real-site-compat | ★ wedge 빈도가 급락했다 — 표준 하네스로 16회 연속 ALIVE. 수정 여부와 무관하다. wedge 연구는 재현이 돌아올 때까지 막혔다. | LOG.md#2026-08-12-4 |
| 2026-08-12 | 방법론 | ★ 간헐성이 실험 설계를 압도한다. 같은 바이트로 WEDGE(20s) → ALIVE(80s) → WEDGE ×3 이 나온다. 이 타깃에서 단일 런 A/B 는 무의미하다. | LOG.md#2026-08-12-5 |
| 2026-08-12 | real-site-compat | ★ 쓸 수 있는 계측 하네스를 얻었다(헤더 보존 SW 본문 패치). 그리고 체인 순회·getter 자기재귀·prepareStackTrace 축은 전부 정리됐다. | LOG.md#2026-08-12-6 |
| 2026-08-12 | real-site-compat | 늦은 wedge = 스택 오버플로 폭풍이며 publicPath 수정과 무관하다(수정 후에도 3,220회 vs 직접 2회). 그리고 dev 페이로드 경로는 메인 번들 계측에 쓸 수 없다. | LOG.md#2026-08-12-7 |
| 2026-08-12 | real-site-compat | ★ 근본원인 수정 반영: `.src` 마스킹 예외 제거 → publicPath 정상화. 죽은 해시 차단은 삭제. | LOG.md#2026-08-12-8 |
| 2026-08-12 | real-site-compat | ★ NAVER 가 WTM 빌드를 갈았다(`fce46da` → `1baa7f7`). 우리 `sw.js` 차단은 없는 해시를 막고 있어 지금 무효다. | LOG.md#2026-08-12-9 |
| 2026-08-12 | real-site-compat | ★ 타깃이 세션 도중 바뀌었다. 오늘 낸 시간차 A/B 는 전부 의심해야 한다. 그리고 지금은 출하 구성도 wedge 한다. | LOG.md#2026-08-12-10 |
| 2026-08-12 | real-site-compat | 정정+확정: 멤브레인 재귀는 `get()` 이 아니라 `call()` 로 재야 했다. 다시 재도 결과는 같다 — 재귀는 우리 멤브레인이 아니다. | LOG.md#2026-08-12-11 |
| 2026-08-12 | real-site-compat | ★ wedge = 스택 오버플로 3,228회(직접 로드는 2회). 프록시가 유발한다는 게 대조로 확정. 다만 멤브레인 재귀도, 리라이트 깊이 배수도 아니다(둘 다 기각). | LOG.md#2026-08-12-12 |
| 2026-08-10 | real-site-compat | ★ 수정 경로의 wedge 정체 = V8 스택워킹 + 힙 할당 폭주(심볼 확정). 트리거는 아직 미특정. | LOG.md#2026-08-10-1 |
| 2026-08-10 | real-site-compat | ★ wedge 근본원인 확정: 우리가 `script.src` 로 프록시 URL 을 흘려서 NAVER SDK 의 webpack publicPath 가 깨진다. | LOG.md#2026-08-10-2 |
| 2026-08-10 | 방법론 | 철회: "루프 상한을 걸었더니 wedge 소멸" 은 또 게이트 실패였다. 그 런에서 `27b3366` 은 40바이트 스텁이었다. | LOG.md#2026-08-10-3 |
| 2026-08-10 | real-site-compat | ★ wedge 는 bvsd 안의 폭주 루프다 — 루프 86개에 상한(30만)을 걸었더니 wedge 가 사라졌다(재현 2/2, 게이트 통과). | LOG.md#2026-08-10-4 |
| 2026-08-10 | real-site-compat | 트리거 파일 정체 확인 + 첫 내부 단서: `27b3366….js` 는 `bvsd.min.js`(UMD 이름 `nhom…`) — 바로 `nhomz` 를 정의하는 파일이다. | LOG.md#2026-08-10-5 |
| 2026-08-10 | real-site-compat / 방법론 | `__zpStep` 이분 탐색은 이 wedge 에 원리적으로 못 쓴다 — 후크를 끄면 SDK 가 더 일찍 죽어서 트리거 파일에 도달조차 못 한다. | LOG.md#2026-08-10-6 |
| 2026-08-10 | 방법론 / real-site-compat | ★ 모순 해소: "로컬 싱크=ALIVE, CDN=WEDGE" 는 처음부터 없었다. 싱크가 엉뚱한 파일을 주고 있었을 뿐이다. 전달 계층 가설 전체를 폐기한다. | LOG.md#2026-08-10-7 |
| 2026-08-10 | 방법론 / 계측 | 철회: "transport 가 64바이트를 잘라먹는다" 는 단위 착오였다. 바이트(Content-Length) 와 JS 문자열 길이(UTF-16 코드유닛)를 비교했다. | LOG.md#2026-08-10-8 |
| 2026-08-10 | transport / real-site-compat | ★ 근본원인 확정: 우리 transport 가 응답 끝 64바이트를 잘라 먹는다. `27b3366….js` 가 606,978 → 606,914 로 도착하고, 잘린 자리가 하필 블록 주석 안이라 파일 전체가 SyntaxError 가 된다. | LOG.md#2026-08-10-9 |
| 2026-08-10 | real-site-compat | 핵심 관측: 같은 바이트라도 "로컬 싱크에서 주면 ALIVE, 실제 CDN 에서 받으면 WEDGE" 가 두 파일에서 반복된다 — 범인은 스크립트 내용이 아니라 우리 transport 일 수 있다. | LOG.md#2026-08-10-10 |
| 2026-08-10 | real-site-compat | 중대 정정: wedge 는 389KB 메인 번들이 아니라 "다른 wtm `.js`" 가 일으킨다. 세 세션을 엉뚱한 파일에 썼다. | LOG.md#2026-08-10-11 |
| 2026-08-10 | real-site-compat / 방법론 | 정정: `script.src` 수정만으로는 스텁을 걷을 수 없다. 내 ALIVE 근거는 전부 "로컬 싱크 전달 경로" 에서 나온 것이었다. | LOG.md#2026-08-10-12 |
| 2026-08-06 | diagnostic / real-site-compat | 정정: 직전의 "문서/리소스 재로드 폭주(SetReadyState 320회)" 는 전부 내 계측이 만든 것이었다. 계측을 뺀 클린 트레이스는 rAF 구동 레이아웃 루프를 가리킨다. | LOG.md#2026-08-06-1 |
| 2026-08-03 | membrane / fingerprint + 보안 | `document` 인스턴스 own 프로퍼티 4개 제거 — 지문이자 '두 번째 document' 계측 구멍이었다. | LOG.md#2026-08-03-1 |
| 2026-08-03 | testing | 소스텍스트 핀이 리팩터링을 3번째로 막았다 — 이번엔 한 커밋에서 3개 동시 실패. | LOG.md#2026-08-03-2 |
| 2026-08-03 | 실사이트 / 노이즈 | `escapeExpression`(Handlebars) 콘솔 에러는 news.naver.com 의 간헐 레이스지 우리 회귀가 아니다. | LOG.md#2026-08-03-3 |
| 2026-08-03 | membrane / fingerprint | descriptor 플래그 정합 — 멤브레인이 건드린 모든 프로퍼티가 `enumerable:false` 라 `for-in`/`Object.keys` 에서 사라져 있었다. | LOG.md#2026-08-03-4 |
| 2026-08-03 | membrane / fingerprint | `for (k in window)` 는 세 번째 열거 표면이고, 기존 스크럽이 절대 닿지 못하는 곳이었다 — 멤브레인 전역 4개가 그대로 노출. | LOG.md#2026-08-03-5 |
| 2026-08-03 | membrane / compat | 해결: 동적 앵커 `href` 이중 프록시 — 멤브레인 setter 가 자기 자신의 후크를 재진입 호출하고 있었다. | LOG.md#2026-08-03-6 |
| 2026-08-03 | testing | 소스텍스트 핀이 "내가 방금 지운 코드" 를 내 주석에서 찾아 통과했다 — 두 번째 재발. | LOG.md#2026-08-03-7 |
| 2026-08-03 | membrane / fingerprint | Resource Timing 에 우리 자산 4개가 실명으로 남아 있었다 — `zp-core.js`, `zp-page-bundle.js`, `runtime-prelude.js`, `zp_page_rt.wasm`. | LOG.md#2026-08-03-8 |
| 2026-08-03 | membrane / 미해결 | 재현됨: 동적 생성 `<a>` 의 `href` 왕복이 깨지고 raw attribute 가 이중 프록시된다 (페이지 realm 실측, exec-js 아티팩트 아님). | LOG.md#2026-08-03-9 |
| 2026-08-03 | membrane / fingerprint | `performance.timeOrigin` 을 가상화하던 D7 코드가 실제로는 아무것도 가상화하지 않으면서 지문 3개를 만들고 있었다 — 삭제. | LOG.md#2026-08-03-10 |
| 2026-08-03 | membrane / fingerprint | 네이티브 싱글턴에 own 프로퍼티를 심지 말 것 — `navigator` own=6, `history` own=2 (네이티브는 둘 다 | LOG.md#2026-08-03-11 |
| 2026-08-03 | membrane / fingerprint | `define()` 로 심는 모든 함수가 `.name` 을 잃고 있었다 — 한 줄로 전역 수정. 남은 것: localStorage 파사드. | LOG.md#2026-08-03-12 |
| 2026-08-03 | membrane / compat | 교체 클래스의 "브랜드" 3종 수정 — `XMLHttpRequest.name === "c"`(미니파이 이름 유출), `[object Object]` toStringTag, `instanceof EventTarget === false`. | LOG.md#2026-08-03-13 |
| 2026-08-03 | membrane / compat | EventTarget 메서드를 공유 상위 프로토타입으로 이전 → 교체 클래스 4종의 prototype 개수가 네이티브와 정확히 일치(XHR 27, WebSocket 17, EventSource 11, Worker 5). | LOG.md#2026-08-03-14 |
| 2026-08-03 | membrane / compat | 교체 클래스 prototype 스윕: WebSocket / EventSource / Worker 도 XHR 과 같은 병 — 특히 `new Worker(u) instanceof Worker` 가 false 였다. | LOG.md#2026-08-03-15 |
| 2026-08-03 | membrane / compat | `XMLHttpRequest.prototype` 가 16개(네이티브 27개)뿐이었다 — 지문이자 실제 호환성 버그. 프로토타입 접근자로 이전. | LOG.md#2026-08-03-16 |
| 2026-08-02 | membrane / fingerprint | 프로토타입 표면 지문 2건 발견 — `Location.prototype` 14 vs 1 (수정), `XMLHttpRequest.prototype` 16 vs 27 (미수정, 호환성 버그이기도 함). | LOG.md#2026-08-02-1 |
| 2026-07-31 | sw / real-site-compat | NAVER 캡차가 절대 통과할 수 없는 이유 = 우리가 WTM 을 스텁하고 있었다. 스텁을 빼면 렌더러가 멈춘다 — 트레이드오프를 양방향 실측했다. | LOG.md#2026-07-31-1 |
| 2026-07-31 | htmltx / real-site-compat | 프록시 URL 이 `.` `-` `_` `~` 까지 percent-encode 해서 SDK 의 자기 태그 탐색(CSS 속성 선택자)이 깨졌다 — 그리고 NAVER 캡차 실패의 진짜 원인 메시지를 확보했다. | LOG.md#2026-07-31-2 |
| 2026-07-31 | rewriter | 모든 문자열의 `.search()` 가 프록시 안에서 깨져 있었다 — DANGEROUS_PROPS 가 callee 위치에서 receiver 를 버린다. | LOG.md#2026-07-31-3 |
| 2026-07-31 | real-site-compat | NAVER 캡차: 정답을 넣어도 계속 "incorrect" — 답이 아니라 같이 가는 anti-bot 토큰이 에러 문자열이다. (원인 경계 확정, 근본원인 미해결) | LOG.md#2026-07-31-4 |
| 2026-07-30 | membrane | NAVER 로그인 불가 = `TARGET_CONNECT_FAILED` (Target host: proxy.localhost:18080) — 폼 action 의 프록시 URL 을 타깃으로 넘겼다. | LOG.md#2026-07-30-1 |
| 2026-07-30 | sw-integration | 브라우저 탭 아이콘 요청(`/favicon.ico`)이 프록시 페이지마다 SW network error | LOG.md#2026-07-30-2 |
| 2026-07-30 | membrane | ★ 2건 정정★ 정렬 큐 후속에서 내가 만든 버그 2개 — (A) 큐 상한이 누적 마감, (B) 재삽입 script 이중 래핑. | LOG.md#2026-07-30-3 |
| 2026-07-30 | membrane | ★ 해결★ 광고 iframe script 실행 순서 = 정렬 큐(fetch 는 병렬, 실행은 직렬) + 닫힌 문서 `document.write` 가드. | LOG.md#2026-07-30-4 |
| 2026-07-30 | membrane | ★ DEAD END 정정★ 위 항목(07a2a5e)의 "동기 XHR 로 parser-blocking 복원" 은 무효다. 다시 시도하지 말 것. | LOG.md#2026-07-30-5 |
| 2026-07-30 | membrane | [정정됨 — 위 DEAD END 항목 참조] | LOG.md#2026-07-30-6 |
| 2026-07-30 | membrane | ★ bare 전역 write 전 계열이 "유효하지 않은 대입 타깃"으로 깨져 있었음★ `location = url` 네비게이션이 조용히 죽던 원인. | LOG.md#2026-07-30-7 |
| 2026-07-30 | membrane | child realm 스크립트 실행기가 다른 함수 스코프의 지역 함수를 참조 → 실행되는 순간 무조건 `ReferenceError: rewriteWithPageRewriter is not defined`. | LOG.md#2026-07-30-8 |
| 2026-07-30 | rewriter | ★ 수 세션 미해결 `/zp/api/gfp-display-sdk.js` 404 해결★ 진짜 원인 = 리라이터가 정적 module 구문을 아예 안 건드림. | LOG.md#2026-07-30-9 |
| 2026-07-30 | transport-regression | null-body status(204/304 등)에 body 를 붙여 Response 생성자가 throw → 모든 analytics beacon 과 조건부 304 가 502. | LOG.md#2026-07-30-10 |
| 2026-07-30 | rewriter | shorthand 객체 프로퍼티가 keyless 로 붕괴 → 190KB 파일 전체 SyntaxError. | LOG.md#2026-07-30-11 |
| 2026-07-30 | membrane | 인라인 classic script 가 `new Function(body)` 로 실행되어 전역 선언이 소실 → ReferenceError 폭풍. | LOG.md#2026-07-30-12 |
| 2026-07-30 | real-site-compat | NAVER 검색 "찾을 수 없음" = 모든 GET 폼 제출이 프록시 자신을 타깃으로 삼는 공통 버그. | LOG.md#2026-07-30-13 |
| 2026-07-28 | transport-regression | ★ NAVER 완전 해결★★ 12/12 완전 렌더(load 309~386ms, body 84~152KB, imgs 44~82). 마지막 두 근본 원인: TLS `read_tls` lost wakeup + UTF-8 char-boundary panic. | LOG.md#2026-07-28-1 |
| 2026-07-28 | transport-regression | ★ 서사 정정★★ 여러 세션에 걸쳐 "NAVER 가 END_STREAM/최종 deflate 블록을 60s withhold 한다(anti-bot)"로 기록된 결론은 전부 오진. 진짜 원인은 우리 yamux 드라이버의 lost wakeup. | LOG.md#2026-07-28-2 |
| 2026-07-03 | tls-fingerprint | ★ ROOT CAUSE 확정★ NAVER tarpit(body 33~70KB 에서 2~4분 정지)의 진짜 원인 = `is_grease_value` 비트버그로 extension GREASE 가 wire 에 안 나감. IP 아님(같은 IP real Chrome 직접은 즉시 — 사용자… | LOG.md#2026-07-03-1 |
| 2026-06-26 | transport-perf | NAVER "삼선 메뉴/광고가 한참 뒤에 뜸"의 root = document END_STREAM 60s withhold (간헐적 anti-bot) → DCL/load 60s 지연 → load-gated init 지연. 안전한 클라이언트 수정 없음 (DEAD-END 2개 기록 … | LOG.md#2026-06-26-1 |
| 2026-06-19 | transport-wasm | `RuntimeError: unreachable` (wasm trap) 가 스트리밍 문서 mid-stream cancel(RST) 시 발생 — h2 fork 의 reset-stream 정리 로직이 `std::time::Instant::now()` 호출 →… | LOG.md#2026-06-19-1 |
| 2026-06-18 | sw-integration | NAVER "검색창만 뜨고 나머지 흰화면"의 진짜 root cause = SW in-memory 탭 상태 비영속성 (idle-restart 시 `tabs`/`shareRoutes`/`clientContext` Map 소실) → 프록시 페이지의 모든 transport fetch 가… | LOG.md#2026-06-18-1 |
| 2026-06-17 | sw-integration | SW 가 `chrome-extension://` (및 모든 non-http) FetchEvent 를 가로채 `Response.error()` 반환 → 브라우저 확장의 injected-script 채널 파괴 (NAVER 콘솔의 `content.js`/`Failed to… | LOG.md#2026-06-17-1 |
| 2026-06-16 | streaming-render | ★ 해결★ NAVER 메인 문서/메뉴 60s → ~2s: 버퍼링-후-리라이트 모델을 streaming/progressive render 로 교체 (타이머 0). 위 wasm-crash·transport 항목들이 "streaming render 필요" 로 끝난 그 작업의 완결 | LOG.md#2026-06-16-1 |
| 2026-06-16 | wasm-crash | ★ HARD RULE★ kernel wasm 에서 SW `setTimeout` 기반 timer(future-cancel race)는 real Chrome 에서 `RuntimeError: unreachable` 크래시 — 2번 확인 후 영구 금지 | LOG.md#2026-06-16-2 |
| 2026-06-14 | transport-regression | ★ FINAL ROOT CAUSE★★ NAVER 전체 느림/메뉴-죽음 = h2 응답을 END_STREAM 까지 버퍼링하는데 naver 가 gzip footer(CRC)를 60~240s withhold + Content-Length 없음(chunked). 해결: gzip 의… | LOG.md#2026-06-14-1 |
| 2026-06-13 | transport-regression | ★ ROOT CAUSE 확정★ NAVER "정확히 60s" first-request stall = h2 클라이언트가 Content-Length 본문 완성 후에도 END_STREAM 을 기다리며 block. naver 가 stream 종료 프레임을 60s withhold 하기 때문.… | LOG.md#2026-06-13-1 |
| 2026-06-13 | transport-regression | NAVER 첫 화면 진입의 정확히-60s stall = 세션 최초 요청 (www.naver.com 문서) 의 cold-bootstrap race. SW setTimeout 기반 deadline + fresh 재시도로 해결 (이전 yamux 항목 (5)번 미해결 종결) | LOG.md#2026-06-13-2 |
| 2026-06-13 | transport-regression | NAVER 메인 "3분 로딩" 의 주원인 = yamux 단일 세션 throughput 붕괴 (28+ 동시 다운로드). split_send_size + MaxStreamWindowSize 확대로 해결. + h2-deny 오진 revert + 남은 간헐적 60s 는 별도 트랙 | LOG.md#2026-06-13-3 |
| 2026-06-12 | transport-regression | NAVER 1분 로딩의 진짜 원인 = www.naver.com document 의 H2 anti-bot slow-lane (IP gate 아님). h2-deny 로 60158ms → 77ms (780×) | LOG.md#2026-06-12-1 |
| 2026-06-12 | sw-integration | NAVER 광고 SDK ES module stub 회귀 3종 + launcher ready boundary fix — "ready 인데 접속 안 됨" / "또 느려짐" / "메뉴 내용 안 보임" 연쇄 진단 | LOG.md#2026-06-12-2 |
| 2026-06-11 | sw-integration | SW response cache (Cache API zp-resp-v1) 가 NAVER 의 dynamic ES module import 와 호환 안 됨 — disable 결정 | LOG.md#2026-06-11-1 |
| 2026-06-11 | sw-integration | NAVER 광고 stub 응답 shape 회귀 — 204 No Content 가 SDK JSON.parse fail 트리거 → fallback content 가 페이지에 binary garbage 로 inject 가설 | LOG.md#2026-06-11-2 |
| 2026-06-10 | sw-integration | NAVER dynamic thumbnail proxy (`s.pstatic.net/dthumb.phinf/`) 도 추가 slow-lane endpoint + SW response cache 부재로 824 req cold path | LOG.md#2026-06-10-1 |
| 2026-06-10 | sw-integration | NAVER 광고 bid endpoint instant-stub — `nam.veta/siape.veta` 의 60s slow-lane 으로 광고 SDK 의 `await gfpBid()` 가 hang 하면서 같은 init chain 의 메뉴 binding 함수가 attach 안 됨… | LOG.md#2026-06-10-2 |
| 2026-06-10 | sw-integration | `body.arrayBuffer is not a function` — transportFetch body 분기가 Uint8Array 케이스 빠뜨려 NAVER preload.js 첫 POST 에서 hydration 전체 중단 | LOG.md#2026-06-10-3 |
| 2026-06-09 | sw-integration | Cross-host 3xx redirect 가 share URL escape 의 진짜 root cause — 그동안 `location.href escape` 라고 가정된 회귀의 정체 | LOG.md#2026-06-09-1 |
| 2026-06-09 | perf | Transport-stage telemetry 추가 — NAVER cold-load 1분 중 rewriter 가 차지하는 비율은 1.1% 만임을 사용자 telemetry 로 확정 (`rewriteStats.rewriteLatencyMs=679ms, invocations=60… | LOG.md#2026-06-09-2 |
| 2026-06-09 | sw-integration | NAVER 403 회귀 — 우리 SW 가 puppeteer/WebView2 의 `HeadlessChrome` user-agent 를 그대로 forward 해서 NAVER WAF 가 모든 광고 SDK fetch 를 즉시 봇 거부 | LOG.md#2026-06-09-3 |
| 2026-06-09 | rewriter | NAVER hydration regression — dynamic `import()` URL was unrewritten, light-and-day cause + fix | LOG.md#2026-06-09-4 |
| 2026-06-09 | sw-integration | Perf telemetry landed — SW rewrite cache hit ratio + rewriter latency + cache-key SHA-256 share via `__zpKernelProbe` | LOG.md#2026-06-09-5 |
| 2026-06-09 | real-site-compat | MDN diagnosis CORRECTED — Cloudflare 403 anti-bot, NOT transport hang | LOG.md#2026-06-09-6 |
| 2026-06-09 | sw-integration | D5 embedded TURN landed — `pion/turn/v4` in-process + short-term TURN-REST creds + page-realm `iceServers` wiring | LOG.md#2026-06-09-7 |
| 2026-06-08 | sw-integration | example.com transport regression RESOLVED via rustls fork patch — TLS 1.3 CertificateEntry extensions tolerance | LOG.md#2026-06-08-1 |
| 2026-06-08 | sw-integration | `rewriteScriptResponse` 가 모든 external script 를 block stub 으로 응답한 dead-helper 함정 — split-bundle (c.1) Step 3 에서 `initRewriter()` helper 를 지웠는데… | LOG.md#2026-06-08-2 |
| 2026-06-07 | rewriter | **split-bundle (c.1) Step 2a SW swap NAVER renderer wedge — `ZPRewriter.rewriteScript` legacy primary 경로를 `ZPBundle` (modern OXC 0.133) 으로 교체했을 때 NAVER 메인… | LOG.md#2026-06-07-1 |
| 2026-06-06 | rewriter | Anchor/form/formaction raw target URL escape vector — middle-click / Ctrl+click / `target=_blank` / 우클릭 "open in new tab" / "copy link address" 시 사용자 IP 가… | LOG.md#2026-06-06-1 |
| 2026-06-06 | sw-integration | Chunked decoder full state machine extracted to `zp-transport-codec::ChunkedDecoder` | LOG.md#2026-06-06-2 |
| 2026-06-06 | sw-integration | D2 sourcemap chaining: `rewriter_map ∘ original_map` + SW `composeSourceMap` bug fix | LOG.md#2026-06-06-3 |
| 2026-06-06 | real-site-compat | Fingerprint hardening: `navigator.webdriver` + `window.chrome` 페이크 + Symbol description 비표시화 | LOG.md#2026-06-06-4 |
| 2026-06-06 | sw-integration | Phase 2 마감 큐 (fastest-to-close 순서, 세션 끊겨도 이 큐 따라가면 됨) | LOG.md#2026-06-06-5 |
| 2026-06-06 | sw-integration | Transport codec extracted to `crates/zp-transport-codec/` | LOG.md#2026-06-06-6 |
| 2026-06-05 | sw-integration | C1 close-handshake drain (RFC 6455 §7.1.6) | LOG.md#2026-06-05-1 |
| 2026-06-05 | sw-integration | Phase 3 carry-over: transport-codec host-side tests (socks5/http1/tls) | LOG.md#2026-06-05-2 |
| 2026-06-05 | real-site-compat | NAVER 1차 근본 해결 — `window.ZP`/`window.ZeroProxyRT` fingerprint 가시 표면 정리 + OXC rewriter `for(;;)` / `while(true)` / `while(1)` / `do while(true)` 캡 룰 | LOG.md#2026-06-05-3 |
| 2026-06-02 | tls-fingerprint | Phase 5.8 부록 3 — h2 HEADERS frame PRIORITY (0x20) flag + `{exclusive=1, dep_id=0, weight=256}` payload Chrome 148 byte-equivalent emit + 부록 2 — h2 body… | LOG.md#2026-06-02-1 |
| 2026-06-02 | tls-fingerprint | Phase 5.8 — "captured spec 설치 ≠ wire 적용" silent dead code 발견 + fix. cipher list 가 8 개월간 captured spec 무시하고 9-entry Go-shape 으로 emit. 사용자 challenge "정확한 모킹… | LOG.md#2026-06-02-2 |
| 2026-06-02 | real-site-compat | NAVER 60s slow lane 완전 분석 — 1) localStorage scrubbing 발견, 2) URL-fragment chain 으로 pivot, 3) chain warmup 으로도 60s lane 우회 불가 확정 → IP/JA3 reputation gate 결론.… | LOG.md#2026-06-02-3 |
| 2026-06-02 | sw-integration | Launcher pre-nav 구현 — NAVER deep subdomain 자동 warmup → NAC cookie 정상 capture, 그러나 nid 60s slow-lane 여전. NAC 만으로는 NAVER WAF fast-lane 조건 불충분 확인 | LOG.md#2026-06-02-4 |
| 2026-06-02 | transport-regression | 연결 timing 측정 — `__zpRustTrace` 의 tx:* 로그 + per-pattern aggregate 통해 cold www.naver.com 의 dominant cost 확인 → upstream NAVER WAF 가 유일한 병목, local… | LOG.md#2026-06-02-5 |
| 2026-06-02 | sw-integration | Cookie jar 100% silent dead — `opt.url` undefined 으로 인한 `cookieHeader(undefined)` / `setCookieLine(undefined,...)` no-op + web_sys::Response 가 Set-Cookie… | LOG.md#2026-06-02-6 |
| 2026-06-02 | real-site-compat | NAVER 메인 dynamic ad slots (`pc-main-ad-div-p_main_knowledge-*`, `_rightside_understock`, `_rightbottom_widget`, `right-ad-1`) 미충전 — ntm.pstatic.net block 시도… | LOG.md#2026-06-02-7 |
| 2026-06-02 | membrane | `location.href = X` cross-origin escape — Location.prototype.href setter 가 Chrome 에서 non-configurable native 라 prelude override 가 silent fail. 모든… | LOG.md#2026-06-02-8 |
| 2026-06-02 | sw-integration | URL-scoped (RFC 6265) cookie jar 를 SW 에 구현 — `internal/cookiejar/jar.go` 를 JS 로 port (commit 9fa4959) | LOG.md#2026-06-02-9 |
| 2026-06-02 | tls-fingerprint | Phase 5.7 ECH GREASE 가 mail.naver.com TLS handshake 깨뜨림 (regression). 비활성화 fix | LOG.md#2026-06-02-10 |
| 2026-06-02 | tls-fingerprint | NAVER nid 60s slow-lane 진짜 원인은 IP 도 아니라 cookie/session continuity 신호 — wire-level / IP reputation 가설 모두 superseded | LOG.md#2026-06-02-11 |
| 2026-06-02 | tls-fingerprint | JA3 Phase 5.7 — Padding (RFC 7685, id 21) + ECH GREASE (id 0xfe0d) outer 까지 추가 후 NAVER nid.naver.com 60s slow-lane 의 진짜 원인을 IP/endpoint 정책으로 확정 (wire-level… | LOG.md#2026-06-02-12 |
| 2026-06-01 | transport-regression | JA3 Phase 5.1 + Phase 4 end-to-end pipeline 완성 — 사용자 브라우저 ClientHello 캡처 + replay 동작 확인 (JA3 hash byte-equivalent Chrome 134), 하지만 NAVER nid WAF 여전히 60s… | LOG.md#2026-06-01-1 |
| 2026-06-01 | transport-regression | JA3 Phase 1 — cipher_suites Chrome 순서 재정렬은 hash 만 바꿔도 NAVER nid WAF 60s 우회 안 됨. JA3 hash `0503f3e3...` → `c06cf64f...` 로 flip 확인 (`tls.peet.ws/api/all`), 그러나… | LOG.md#2026-06-01-2 |
| 2026-06-01 | build-deploy | SW 부팅 시간 함정 — fresh browser profile 에서 ZP_BUNDLE WASM 첫 instantiate + initBundle 완료까지 ~15s 소요, 그 전까지 모든 `__zpKernelProbe` / `ZP_OPEN_SHARE` / `controlled… | LOG.md#2026-06-01-3 |
| 2026-06-01 | real-site-compat | NAVER 로그인 hang ROOT CAUSE 확정 + fix — wtm.pstatic.net/ncpt.naver.com 의 anti-bot WASM `$_start` 가 membrane 내에서 무한 spin | LOG.md#2026-06-01-4 |
| 2026-06-01 | diagnostic | NAVER 로그인 hang — modal dialog/synchronizer.js/NAC fetch 가설 모두 falsify + 새 taskweaver 도구 모두 wedged 렌더러에 timeout | LOG.md#2026-06-01-5 |
| 2026-06-01 | sw-integration | pay.naver.com → nid.naver.com 리다이렉트 후 CSS host mismatch — stylesheet-only host swap 으로 hang 회피하며 fix | LOG.md#2026-06-01-6 |
| 2026-05-31 | sw-integration | X-ZP-Final-URL 헤더 인프라 추가 (mux.rs) + pay.naver.com→nid.naver.com redirect 후 CSS host mismatch 발견, fix 시 hang 노출되어 미활성화 | LOG.md#2026-05-31-1 |
| 2026-05-31 | diagnostic | NAVER 로그인 hang 심화 추적 — 모든 parser-blocking script + WTM WASM 정상 load/execute, post-execute silent freeze 확인 (다음 세션 도구 필요) | LOG.md#2026-05-31-2 |
| 2026-05-31 | diagnostic | NAVER 로그인 hang post-mortem trace 인프라 추가 + hang 위치 narrowing (가설: gladsdk.displayAd 응답 처리) | LOG.md#2026-05-31-3 |
| 2026-05-31 | real-site-compat | NAVER 로그인 (nid.naver.com/nidlogin.login) 일부 텍스트 미렌더 — baseline 유지가 best 인 trade-off | LOG.md#2026-05-31-4 |
| 2026-05-31 | rewriter | NAVER 웹툰 댓글 위젯 "알 수 없는 오류가 발생했습니다" — rewriter 가 `obj.parent(args)` 를 `__zp_call(obj,"parent",[args])` 로 wrap 했는데 wcc-kw-owner 의 Comment 객체 `{name, parent}` 의… | LOG.md#2026-05-31-5 |
| 2026-05-31 | wasm-page-rt | X 라운드 (남은 micro-opts) — scheme-relative URL push_str chain + Location method outer hoist → criterion noise but functional + intent 명확화; 최적화 sweep 종료 선언 | LOG.md#2026-05-31-6 |
| 2026-05-31 | wasm-page-rt | W 라운드 (호환성 작업 후속 audit) — Cow fast path + per-msg fast-exit + adaptive backoff polling → 전체 누적 typical -20%, large -17%, sub -19% vs U baseline | LOG.md#2026-05-31-7 |
| 2026-05-31 | membrane | GitHub 가운데 섹션 빈 화면 (landing-pages react-app 미마운트) 추가 디버깅 | LOG.md#2026-05-31-8 |
| 2026-05-31 | membrane | NAVER 웹툰 빈 페이지 + 정밀 fix 로 GitHub 회귀 없이 둘 다 working | LOG.md#2026-05-31-9 |
| 2026-05-31 | rewriter | zp-htmltx URL attribute `&amp;` 미디코드 → Wikipedia stylesheet 빈 응답 → CSS 없는 raw HTML 렌더링 | LOG.md#2026-05-31-10 |
| 2026-05-31 | rewriter | NAVER GFP non-SafeFrame ad iframe (forceSafeFrame=false) 가 sf-resized sender 없는데 host 는 sf-resized 대기 → iframe.style.height=0 으로 collapse … | LOG.md#2026-05-31-11 |
| 2026-05-31 | rewriter | V8 incumbent realm leak + child realm parent.postMessage → e.source = parent (corrupt) — NAVER GFP SafeFrame `sf-resized` SDK 검증 우회 위한 sender queue + parent… | LOG.md#2026-05-31-12 |
| 2026-05-30 | rewriter | NAVER GFP SafeFrame 광고 미렌더 root cause 발견 + fix — iframe document.write reset 후 SW control 잃음 → 외부 script fetch 가 SW 우회 → Go 서버 403 → loader 미실행 | LOG.md#2026-05-30-1 |
| 2026-05-30 | rewriter | transformHTML 의 `const root = container.content // container` 가 outer `root = window` 변수를 TDZ 로 shadow → 함수 시작부 logger 가 `root.X` 접근 시 silent ReferenceError… | LOG.md#2026-05-30-2 |
| 2026-05-30 | wasm-page-rt | V 라운드 — server-side criterion bench harness 추가 + 3 추가 win (lazy attr filter, streaming percent-encode, resolve_against_base CI+builder) → typical -8% / large… | LOG.md#2026-05-30-3 |
| 2026-05-30 | wasm-page-rt | server-side criterion bench 가 "inline script OXC parse 가 hot path" 가설을 거부 | LOG.md#2026-05-30-4 |
| 2026-05-30 | wasm-page-rt | U 라운드 — zp-htmltx 의 helper chain 중복 + per-attribute alloc 제거 (`to_ascii_lowercase()` per URL → 0, per-attribute `tag` alloc → element 1회) | LOG.md#2026-05-30-5 |
| 2026-05-30 | wasm-page-rt | WASM handle pipeline (zp-htmltx → zp-page-rt) 평가 — 기술적 불가능 + Recipe 5 도 ROI 없음 결론 | LOG.md#2026-05-30-6 |
| 2026-05-30 | wasm-page-rt | T2 라운드 — MO record path (enforceObservedAttribute) + isSVGURLBearing 시그니처 확장 → real DOM 25→15 µs (-40% 누적), unique URL 2000→900 ns (-55% 누적) | LOG.md#2026-05-30-7 |
| 2026-05-30 | wasm-page-rt | T 라운드 — setAttribute hook chain 의 attrLocalName / localName 중복 호출 제거 → real DOM -32%, cache HIT -50% | LOG.md#2026-05-30-8 |
| 2026-05-30 | wasm-page-rt | Production 실사이트 perf 측정 (NAVER): WASM 추가 작업 ROI 낮음 — element-specific 로직이 hot path 의 99% | LOG.md#2026-05-30-9 |
| 2026-05-30 | wasm-page-rt | P+Q+R+S 회귀 매트릭스 검증 결과 + throw-safety 보강 | LOG.md#2026-05-30-10 |
| 2026-05-30 | wasm-page-rt | `classifySchemeOnly` 같은 internal sub-API 는 sanity script 외부 접근 불가 | LOG.md#2026-05-30-11 |
| 2026-05-30 | wasm-page-rt | classifyBatch single-pass + ASCII fast-path + result no-copy + 운영 관찰: production batch 가 schemeOnly N회 보다 느림 | LOG.md#2026-05-30-12 |
| 2026-05-30 | wasm-page-rt | 🎯 `TextEncoder.encodeInto` 가 Chrome 에서 charCodeAt 루프 대비 2.37× 느림 — ASCII fast-path 적용 후 schemeOnly 가 두 환경 모두 JS regex 압도 첫 사례 | LOG.md#2026-05-30-13 |
| 2026-05-30 | wasm-page-rt | runtime-prelude 통합 (Recipe 2/1/3) — 운영 함정 catalog | LOG.md#2026-05-30-14 |
| 2026-05-30 | wasm-page-rt | Scheme-only fast path 가 long URL catastrophe 완전 회복 (Node -80%, Chrome -66%) + 길이 평탄성 검증 | LOG.md#2026-05-30-15 |
| 2026-05-30 | wasm-page-rt | JS regex 가 raw-string WASM 보다 일반적으로 빠름 — handle pipeline / batch 만 우위 | LOG.md#2026-05-30-16 |
| 2026-05-30 | wasm-page-rt | Headless Chrome 의 `TextEncoder.encodeInto` 가 Node V8 대비 3.55× 느림 | LOG.md#2026-05-30-17 |
| 2026-05-30 | wasm-page-rt | `wasm-bindgen` cdylib 와 raw `extern "C"` cdylib 분리 필수 | LOG.md#2026-05-30-18 |
| 2026-05-30 | wasm-page-rt | `no_std` + `extern crate alloc` 만으로 wasm32 빌드 불가 — allocator 미정의 | LOG.md#2026-05-30-19 |
| 2026-05-30 | wasm-page-rt | `thread_local! { const { ... } }` 가 non-const constructor 와 충돌 | LOG.md#2026-05-30-20 |
| 2026-05-30 | wasm-page-rt | `static mut SCRATCH` 직접 참조 → Rust 2024 edition deny lint | LOG.md#2026-05-30-21 |
| 2026-05-30 | wasm-page-rt | `memory.grow` 가 모든 `Uint8Array` 뷰 detach → silent corruption | LOG.md#2026-05-30-22 |
| 2026-05-30 | wasm-page-rt | Scratchpad silent 덮어쓰기 → wasm `memory access out of bounds` trap | LOG.md#2026-05-30-23 |
| 2026-05-30 | build-deploy | `wasm-opt -Oz` 가 rustc 1.82+ default features 없이는 validation 실패 | LOG.md#2026-05-30-24 |
| 2026-05-30 | rewriter | Document.prototype.write proto-level wrap + iframe MutationObserver + transformHTML external-script routing | LOG.md#2026-05-30-25 |
| 2026-05-30 | rewriter | `decode_common_html_entities` 가 외부 스크립트 string-literal 안 entity 데이터 파괴 → PARSE_FAILED → SafeFrame 광고 silent 미렌더 | LOG.md#2026-05-30-26 |
| 2026-05-30 | rewriter | iframe 에 `__zp_*` helper 부재 → SW-rewrite 한 외부 스크립트 즉시 ReferenceError silent 실패 | LOG.md#2026-05-30-27 |
| 2026-05-30 | membrane | `href="#"` no-op anchor → navigation trap 이 가로채 React onClick 불가 → 메뉴 확장 안 됨 | LOG.md#2026-05-30-28 |
| 2026-05-30 | membrane | `Function.prototype.constructor` writable lock → NAVER vendor-common (axios polyfill) `Object.extend` 가 strict throw → React mount 실패 → 빈 페이지 | LOG.md#2026-05-30-29 |
| 2026-05-30 | rewriter | emission paren prefix contextual — `return(X).method(args)` 와 `var x=1\n(call)` 양립 불가 픽스 | LOG.md#2026-05-30-30 |
| 2026-05-30 | rewriter | `new globalThis.Request(args)` 가 `new __zp_get(globalThis,"globalThis").Request(args)` 로 rewrite 되어 `new` 가 `__zp_get` 의 args 와 결합 → `Failed to construct… | LOG.md#2026-05-30-31 |
| 2026-05-30 | rewriter | METHOD_CALL emission 이 `return(X).method(args)` 패턴에서 leading `(` 까지 span 에 포함 → `return__zp_call(...)` glue → `ReferenceError: return__zp_call is not defined` | LOG.md#2026-05-30-32 |
| 2026-05-30 | rewriter | `super.X` / `super.method()` 가 `__zp_get/call(super, ...)` 로 wrap → `'super' keyword unexpected here` SyntaxError | LOG.md#2026-05-30-33 |
| 2026-05-30 | sw-integration | iframe document fetch Referer = 자기 자신 → NAVER 광고 iframe 차단 | LOG.md#2026-05-30-34 |
| 2026-05-30 | sw-integration | `rt.RoundTrip` 만 사용 → 3xx Location 헤더 브라우저로 누출 → relative Location 이 proxy origin 에 resolve | LOG.md#2026-05-30-35 |
| 2026-05-30 | rewriter | 상대 URL subresource 가 proxy origin 으로 resolve → 404 | LOG.md#2026-05-30-36 |
| 2026-05-30 | membrane | GitHub publicPath fix 작동 확인 + 멤브레인 마스킹 회로 정리 | LOG.md#2026-05-30-37 |
| 2026-05-30 | real-site-compat | GitHub webpack publicPath partial render — 미해결 | LOG.md#2026-05-30-38 |
| 2026-05-30 | membrane | constructor lock writable=false 유지 | LOG.md#2026-05-30-39 |
| 2026-05-29 | sw-integration | User-Agent forbidden header 누락 → Wikipedia 등 anti-bot 사이트 차단 | LOG.md#2026-05-29-1 |
| 2026-05-29 | real-site-compat | Wikipedia / BBC 정상 렌더 확인 | LOG.md#2026-05-29-2 |
| 2026-05-29 | real-site-compat | NAVER 햄버거 메뉴 + recoshopping 둘 다 정상 동작 확인 | LOG.md#2026-05-29-3 |
| 2026-05-29 | sw-integration | POST body 누락 + Referer/Origin forbidden header 손실 | LOG.md#2026-05-29-4 |
| 2026-05-29 | real-site-compat | NAVER recoshopping iframe Application error (Next.js App Router) | LOG.md#2026-05-29-5 |
| 2026-05-29 | sw-integration | SW ↔ server transport: 1 WS = 1 HTTP req 모델 → page 당 200+ WS upgrade | LOG.md#2026-05-29-6 |
| 2026-05-29 | sw-integration | target script error 캡처 부재 → React hydration 실패 디버깅 불가 | LOG.md#2026-05-29-7 |
| 2026-05-29 | build-deploy | 서버측 upstream connection pool 누락 → 매 fetch 마다 새 TCP+TLS | LOG.md#2026-05-29-8 |
| 2026-05-29 | rewriter | PARSE_FAILED on HTML-entity JS | LOG.md#2026-05-29-9 |
| 2026-05-29 | rewriter | Inline script 더블 리라이트 | LOG.md#2026-05-29-10 |
| 2026-05-29 | membrane | iframe origin/document.origin/window.origin 이 parent URL 로 leak | LOG.md#2026-05-29-11 |
| 2026-05-29 | membrane | root-relative `/zp/...` 발행 = virtual baseURI 와 충돌 | LOG.md#2026-05-29-12 |
| 2026-05-29 | membrane | localStorage/sessionStorage accessor 자기참조 무한재귀 → stack overflow ([membrane.md](membrane.md#2026-05-29--localstoragesessionstorage-accessor-자기참조-무한재귀)) | LOG.md#2026-05-29-13 |
| 2026-05-29 | sw-integration | `/zp/api/fetch` GET 가 script destination 미감지, raw target JS 직발급 → membrane 우회 ([sw-integration.md](sw-integration.md#2026-05-29--zpapifetch-가-script-destinati… | LOG.md#2026-05-29-14 |
| 2026-05-29 | membrane | `setScriptSource` 가 절대 proxy URL 을 root-relative 로 잘라냄 → virtual baseURI 와 충돌하여 cross-origin 404… | LOG.md#2026-05-29-15 |
| 2026-05-29 | sw-integration | iframe `/zp/api/fetch` navigation 시 entry 미생성 + clientContext 미바인딩 → SW_NOT_READY 503 race ([sw-integration.md](sw-integration.md#2026-05-29--iframe-zpapifetc… | LOG.md#2026-05-29-16 |
| 2026-05-29 | real-site-compat | naver 검색바 placeholder color=rgba(0,0,0,0) (의도된 native 동작) — JS 가 오버레이 그려야 보이는 패턴 ([real-site-compat.md](real-site-compat.md#2026-05-29--naver-검색바-透明-placehold… | LOG.md#2026-05-29-17 |

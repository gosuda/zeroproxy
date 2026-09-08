# 함정노트 인덱스

최신·미해결·재발방지 핵심만 선택한다. 상태는 해당 기록 시점 기준이며 현재 전체 통과를 뜻하지 않는다.
[LOG.md](LOG.md)는 2026-08-25 INDEX 본문 아카이브다. 이후 원문은 상세의 고정 커밋 링크, 보존 규칙은 [README](README.md), 진행 중 E1은 [계획](../design/website-compat-refactor.md)을 본다.
요약은 한 줄·160자 이하, 상세는 실재 앵커. 새 항목은 표 맨 위에 추가한다.

| Date | Category | Summary | Detail |
|---|---|---|---|
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

# Transport Regressions

WASM 커널 ↔ relay ↔ target의 보안 회귀 역사. 당시 경로·검증 공백은 현재 구현 목록이 아니다.
보안 invariant: HTTPS의 TLS는 client WASM이 소유하고 Go는 byte-pipe다. 서버에 타깃 HTTP 헤더·쿠키·본문을 평문 envelope로 넘기지 않는다.

## 2026-06-01 — client-TLS를 server-TLS로 바꾼 cutover {#client-tls-cutover}

- 원인: `291db00`의 Rust 이관이 `kernel_fetch`에서 URL/method/headers/body를 `/zp/relay` JSON으로 보냈다. `cmd/zeroproxy-server/relay.go`의 `http.Transport`·cookie jar·`followRedirects`가 TLS를 종료하여 서버가 모든 평문을 보게 됐다. 빌드·렌더 성공으로는 드러나지 않았다.
- 당시 수정(Step 14): `crates/zp-bundle/src/kernel/transport/`에 `ws_stream.rs`, `socks5.rs`, `tls.rs`, `http1.rs`, `fetch.rs`로 WS→SOCKS5→client TLS→HTTP 스택을 복구했다. `kernel_fetch`가 이 경로를 호출하며 JSON-envelope의 `relay_fetch*`, `relay_round_trip`, `RelayRequest/Head`와 옛 mux를 제거했다.
- 서버: target HTTP/TLS를 소유하던 `relay.go`, `/zp/relay`, `/zp/relay-mux`, `/zp/ws-bridge`를 제거하고 `/zp/ws-tcp`의 TCP+SOCKS5 byte-pipe로 전환했다. 이후 아키텍처 변화의 존재와 별개로 TLS 소유권을 서버에 돌리는 회귀는 금지한다.
- 당시 상태: HTTP/HTTPS client-TLS는 복구로 기록. target WebSocket stub, H2·yamux·Tor auth 미연결은 **그 시점의 공백**이며 현재 미구현 선언이 아니다. 현재 커널 위치는 `crates/zp-kernel-bundle`이고 남은 CI acceptance는 [계획](../design/website-compat-refactor.md)을 본다.
- 검증 공백: 당시 서버 라우트 부재 검사·옛 식별자 grep·패킷 캡처 제안은 실행 증거가 없었다. 이름 부재만으로 보안 모델을 증명하지 말고 실제 `kernel_fetch` 전송 경계와 HTTPS wire를 확인해야 한다. 이번 문서 정리에서는 실행하지 않았다.
- 근거: commit `291db00`, 원문 Step 14 복구 기록. 삭제된 `ARCHITECTURE.md`의 core invariant와 외부 PHASE2 E1 언급은 역사적 참조이지 현재 문서의 존재·검증 증거가 아니다.


## 2026-09-29 — WebTransport 게이트웨이는 어떤 타깃에도 닿지 못했다 {#wt-게이트웨이-데이터경로}

- **증상:** D4 는 "LANDED end-to-end" 로 닫혀 있었지만 테스트는 400/501 응답(인자 검증)뿐이었다. 실제 에코 타깃을 두고 클라이언트 → 게이트웨이 → 타깃 데이터 경로 테스트를 붙이자 두 겹이 나왔다.
- **원인 1:** 게이트웨이의 타깃 Dial 이 `EnableDatagrams` 없는 QUIC 설정이었다 — webtransport-go 는 "DATAGRAM support required" 로 **모든** Dial 을 거부한다. 게이트웨이는 세션을 받자마자 닫았다.
- **원인 2:** bidi 브리지가 먼저 끝난 방향을 보고 양쪽 스트림을 닫았다. 요청을 FIN 으로 끝낸 클라이언트는 타깃 응답이 오기 전에 EOF 를 받았다(에코가 빈 문자열). 스트림은 방향별로 따로 닫힌다 — 각 방향은 자기 쓰기 쪽만 닫고(`relayHalf`), 오류면 리셋을 전한다.
- **남은 것 — 브라우저 구간 (2026-09-30 해소 → [브라우저 구간](#wt-브라우저-구간)):** ① 개발용 자체서명 인증서 유효기간이 30일인데 브라우저의 `serverCertificateHashes` 핀은 14일 이하만 받는다 — 개발 모드에서는 브라우저가 게이트웨이에 붙을 수 없다. ② 게이트웨이 인증서 해시를 페이지에 전달하는 경로가 없다. ③ 페이지가 **타깃**용으로 준 `serverCertificateHashes` 가 게이트웨이 연결에 그대로 전달된다 — 타깃 핀은 게이트웨이가 대신 해야 한다.
- **남은 것 — 운영 위험 (2026-09-30: Origin 은 공개 호스트만, 사설 타깃은 `-socks internal` 에서만):** 게이트웨이는 오리진·인증 검사가 없고 사설 IP 로도 Dial 한다. `AllowedTargetOrigins` 가 비어 있으면(기본) UDP 포트에 닿는 누구에게나 오픈 릴레이이자 운영자 LAN 으로의 SSRF 경로다.
- **검증:** `TestGatewayBridgesToRealTarget` — bidi 에코와 datagram 에코(수정 전 두 단계 모두 실패 확인).


## 2026-09-30 — WT 게이트웨이의 브라우저 구간: 다섯 겹이 전부 브라우저에서만 보였다 {#wt-브라우저-구간}

- **증상:** 데이터 경로 Go 테스트가 통과한 뒤에도 페이지·워커의 WebTransport 는 게이트웨이까지 닿지 못했다. 겹마다 다음 겹을 드러냈다.
- **원인 ① CSP:** 프록시 문서의 `connect-src` 에 게이트웨이 오리진(다른 포트)이 없었다 — "Refused to connect", 패킷 한 개도 안 나갔다. 워커는 페이지가 아니라 **자기 부트스트랩 응답의 CSP** 를 쓰므로 따로 고쳐야 했다. 문서 헤더·meta 사본·워커 부트스트랩이 이제 한 함수(`proxiedCSP`)를 쓴다.
- **원인 ② Origin:** webtransport-go 의 기본 `CheckOrigin` 은 Origin 의 호스트가 게이트웨이 Host 와 **같아야** 한다 — 다른 포트의 프록시 페이지는 전부 거절됐다. 코드 주석은 "기본값 = 모두 허용" 이라고 적혀 있었다. 이제 게이트웨이 공개 호스트명(포트 무관, `-wt-page-hosts` 로 조정)만 받는다.
- **원인 ③ 인증서:** 개발용 자체서명 인증서가 30일짜리 CA 였다 — 브라우저 `serverCertificateHashes` 핀은 14일 이하만 받는다. 13일짜리 리프로.
- **원인 ④ 해시 전달:** 게이트웨이 인증서 해시를 페이지에 전할 경로가 없었다 → `/zp/api/config` → SW boot → 래퍼(워커는 부트스트랩 `wtgh`).
- **원인 ⑤ 타깃 핀:** 페이지가 **타깃**용으로 준 `serverCertificateHashes` 가 게이트웨이 연결에 그대로 넘어갔다. 이제 `certhash`/`pinned` 파라미터로 게이트웨이가 타깃을 브라우저 규칙대로 핀한다(해시 일치 + 유효기간 ≤14일, 체인·이름 검증 없음, 빈 목록도 핀). 공통 로직은 `ZP.webTransportGatewayRequest` 하나(페이지·워커).
- **덤 — SW 설정 증발:** SW 는 `/zp/api/config` 를 activate 때만 읽었다. 브라우저가 유휴 SW 를 재시작하면 전역이 기본값으로 돌아가고 activate 는 다시 오지 않아 wtGateway/rtcGateway 가 빈 값이 됐다 → 문서 내비게이션마다(10초 TTL, 시간 상한) 다시 읽는다.
- **운영 경계(설계상 예외):** QUIC 은 SOCKS/Tor 를 탈 수 없고 WebTransport 중계는 세션을 끝단에서 받아야 한다 — 타깃은 서버 주소를 보고 게이트웨이는 스트림 평문을 본다. HTTP 경로의 바이트-파이프 불변식에 대한 예외이므로 `-socks` 가 internal 이 아니면 기동 시 경고한다. 사설·루프백 타깃은 `-socks internal` 일 때만(HTTP 경로보다 멀리 닿지 않게), 검사한 주소로 Dial(DNS 재바인딩). 타깃에 못 닿으면 CONNECT 실패 → 페이지 `ready` reject(네이티브와 같다).
- **교훈:** Go 테스트 클라이언트에는 Origin 도 CSP 도 브라우저 인증서 정책도 없다. 브라우저가 쓰는 기능의 "end-to-end" 는 브라우저로 재야 한다.
- **검증:** `test/e2e/wt-gateway.test.js`(페이지·워커가 네이티브와 동일 — 연결·bidi·datagram·잘못된 핀 거부, 게이트웨이 로그로 핀 Dial 확인), wtproxy Go 테스트 8개, prelude-units 2.

## 후속 전송 정정

- [2026-07-28 lost wakeup](LOG.md#2026-07-28-2): NAVER가 END_STREAM/deflate 종료를 지연시킨다는 과거 anti-bot 서사는 직접 H2 대조와 yamux 드라이버 조사로 철회됐다. 비슷한 시간 지연을 곧바로 같은 원인으로 묶지 않는다.
- [WASM timer/cancel](LOG.md#2026-06-16-2), [h2 reset/Instant trap](LOG.md#2026-06-19-1): 정상 응답뿐 아니라 취소·오류 경로의 타깃 런타임 동작도 필요하다. 새 timer future로 과거 취소 경합을 되살리지 않는다.
- [body 없는 Response](LOG.md#2026-07-30-10), [H1 deadline](sw-integration.md#transport-데드라인-실측): framing·HEAD/204/304·헤더 대기와 본문 수명을 구별한다. 전체 CI green 또는 스트림 취소 완료는 이 역사에서 주장하지 않는다.

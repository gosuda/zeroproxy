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

## 후속 전송 정정

- [2026-07-28 lost wakeup](LOG.md#2026-07-28-2): NAVER가 END_STREAM/deflate 종료를 지연시킨다는 과거 anti-bot 서사는 직접 H2 대조와 yamux 드라이버 조사로 철회됐다. 비슷한 시간 지연을 곧바로 같은 원인으로 묶지 않는다.
- [WASM timer/cancel](LOG.md#2026-06-16-2), [h2 reset/Instant trap](LOG.md#2026-06-19-1): 정상 응답뿐 아니라 취소·오류 경로의 타깃 런타임 동작도 필요하다. 새 timer future로 과거 취소 경합을 되살리지 않는다.
- [body 없는 Response](LOG.md#2026-07-30-10), [H1 deadline](sw-integration.md#transport-데드라인-실측): framing·HEAD/204/304·헤더 대기와 본문 수명을 구별한다. 전체 CI green 또는 스트림 취소 완료는 이 역사에서 주장하지 않는다.

# Transport Regressions

ZeroProxy 의 transport 계층 (WASM 커널 ↔ relay 서버 ↔ target) 에서 발견한 보안/성능 회귀 기록.

특히 "**서버가 평문 트래픽을 보면 안 된다**" 라는 ARCHITECTURE.md 핵심 invariant 가 침해된 경우를 우선 기록.

---

## 2026-06-01 — Step 13 cutover 가 client-TLS → server-TLS 로 보안 모델을 silently downgrade

**Symptoms**:
- 외부에서 관찰 불가능. 빌드 통과, 페이지 정상 렌더링.
- 사용자 보고: "트래픽 처리가 서버로 넘어간 것 같다"

**Root cause**:
- Step 13 (commit `291db00` Rust workspace 통합) 이 Go WASM kernel (`cmd/wasm-kernel/`, SOCKS5+yamux+uTLS+HTTP 풀스택 클라) 을 Rust WASM kernel (`crates/zp-bundle/src/kernel/`) 로 "교체" 라고 라벨링.
- 그러나 Rust 신규 kernel 의 `kernel_fetch` 는 **JSON envelope 을 `/zp/relay` WebSocket 으로 평문 송신**:
  ```rust
  struct RelayRequest<'a> {
      url: &'a str,          // ← 평문 target URL (https://...)
      method: &'a str,
      headers: &'a [(String, String)],  // ← Cookie, Authorization 포함
      has_body: bool,
  }
  ```
- 서버 `cmd/zeroproxy-server/relay.go` 가 `http.Transport` (with `TLSClientConfig`, `ForceAttemptHTTP2: true`) + cookie jar + `followRedirects` 를 직접 운영 → **서버가 TLS 종료, 모든 헤더/쿠키/바디 평문 관측**.
- ARCHITECTURE.md 의 "relay does not parse target HTTP, TLS, redirects, cookies, or HTML" invariant 정면 위반.
- 같은 commit 의 코멘트 (`crates/zp-bundle/src/kernel/mod.rs:9-11`): *"The Go kernel is still in the tree (`cmd/wasm-kernel/`) and can be removed after this kernel reaches feature parity."* — feature parity 가 client-TLS 까지 포함한다는 점이 누락.

**Fix** (Step 14, this PR):
- `crates/zp-bundle/src/kernel/transport/` 신규 모듈로 client-side stack 재구축:
  - `ws_stream.rs` — `web_sys::WebSocket` → `futures::io::AsyncRead+AsyncWrite` 어댑터
  - `socks5.rs` — RFC 1928 + 1929 (DOMAINNAME ATYP, `IsolateSOCKSAuth` 호환)
  - `tls.rs` — rustls 0.23 + `rustls-rustcrypto` provider (WASM 호환). 명시적 sync↔async state-machine pump.
  - `http1.rs` — origin-form 요청, `httparse` 응답, chunked/Content-Length/EOF body framing
  - `fetch.rs` — entry: WS → SOCKS5 → TLS(https) → HTTP/1.1 → JS `Response`
- `kernel_fetch` → `transport::fetch::fetch(url, method, headers, body)`. JSON-envelope 코드 (`relay_fetch*`, `relay_round_trip`, `RelayRequest/Head`, mux 모듈) 완전 삭제.
- 서버: `/zp/relay`, `/zp/relay-mux`, `/zp/ws-bridge` endpoints 삭제. `relay.go` (`http.Transport` + `followRedirects` + cookie jar) 전체 삭제. 신규 `/zp/ws-tcp` endpoint 추가 — 1 WS = 1 TCP+SOCKS5 byte-pipe (`bridgeTargetStream(net.Conn)` 재사용).

**Status**:
- ✅ HTTP/HTTPS fetch — client-TLS
- ❌ Target WebSocket (`wss://`) — `kernel_stream` 은 deferred stub (`TARGET_WS_NOT_REWIRED`). client-side WS framing on SOCKS5+TLS 가 follow-up.
- ❌ HTTP/2 — ALPN 강제 `http/1.1`. `h2` crate + tokio↔futures adapter 가 follow-up perf.
- ❌ yamux multiplex — 1 WS = 1 request. yamux client (WASM) 가 follow-up perf.
- ❌ Tor mode (`-socks` flag) — `Auth::None` hardcoded. `IsolateSOCKSAuth` username 라우팅이 follow-up.

**Regression guard**:
- TODO: 서버 단위 테스트 — `/zp/relay`, `/zp/relay-mux`, `/zp/ws-bridge` 가 라우팅 테이블에 부재하는지 assert (회귀 시 즉시 빨간불).
- TODO: cargo grep guard — `RelayRequest`, `RelayResponseHead`, `pick_relay_url` 같은 식별자가 워크스페이스에 재등장 시 lint 실패.
- TODO: E2E — taskweaver 로 `https://example.com` 페치 + 서버 `Wireshark` 캡처에 평문 HTTP request line 미존재 확인.

**Lessons**:
- "Go → Rust 포팅" 으로 라벨링된 PR 이 실은 **transport architecture 자체를 바꾸는** 경우가 있음. PR 리뷰 시 "kernel_fetch 가 어떤 endpoint 에 접속하는가?" 를 단일 줄 grep 으로 항상 검증.
- ARCHITECTURE.md 의 invariant 가 코드 변경의 acceptance criteria 인지 명시되어야 PR 리뷰어가 잡을 수 있음.
- WASM 에서 TLS 가 까다롭다고 server 로 미루고 싶은 유혹이 항상 있음. 이건 ZeroProxy 의 존재 이유 (client-owned virtual browsing) 자체를 무효화함.

**See also**:
- ARCHITECTURE.md §"Core invariants" (이 invariant 들이 깨졌었음)
- PHASE2 plan E1 escape matrix (관련)
- commit `291db00` (Step 13: regression 도입)
- 이번 PR (Step 14: 복구)

# ZeroProxy

ZeroProxy는 설치 없이 브라우저에서 동작하는 클라이언트 보유형 가상 브라우징 엔진입니다. 목표는 대상 사이트 트래픽을 브라우저의 직접 네트워크가 아니라 `Service Worker -> Go WASM -> WebSocket/yamux -> Tor SOCKS5 -> uTLS -> HTTP/1.1` 경로로만 내보내는 것입니다.

## 현재 진행상황

상태: **Phase 0 프로토타입 / 부분 구현**.

구현된 핵심 기능:

- `/p/<encrypted>#k=<key>` 공유 링크: AES-256-CBC + HMAC-SHA256 envelope, HKDF 키 분리, HMAC 검증 후 복호화.
- `/v/<tab-id>/e/<entry-id>` 및 `/v/<tab-id>/n/<base64url_target_url>` 기반 활성 브라우징 라우트.
- 모든 controlled request를 분류하고 unknown을 차단하는 Service Worker.
- Go WASM 커널의 `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, `__zp_cookie_set` export.
- 단일 WebSocket pipe 위의 yamux, Tor SOCKS5 DOMAINNAME CONNECT, uTLS, 직접 HTTP/1.1 round trip.
- HTML tokenizer transform: runtime prelude/topbar 주입, 문서 navigation URL laundering, 위험 태그/헤더 제거.
- Runtime prelude: fetch/XHR/WebSocket/EventSource/sendBeacon, navigation/form/history/location, storage, worker/iframe, WebRTC/device API 방어 훅.
- 서버의 `/__zp/ws-pipe` relay 및 정적 자산 제공.

아직 완료로 볼 수 없는 부분:

- 동적 iframe clean-realm, worker, 직접 navigation escape를 검증하는 브라우저 E2E 테스트가 없습니다.
- iframe 생성 경로 일부는 `PLAN.md`가 요구하는 완전한 동기식 방어 수준까지 강화되어야 합니다.
- XHR/WebSocket/EventSource/FormData 등 runtime API fidelity는 프로토타입 수준입니다.
- JS `Response` 생성 전 target body를 버퍼링하므로 완전한 streaming 응답 경로는 아닙니다.
- encrypted IndexedDB persistence는 구현되어 있지 않습니다.
- Tor daemon 배포 구성과 실제 Tor egress E2E 검증이 필요합니다.

자세한 구조와 `PLAN.md` 대비 구현 평가는 [`ARCHITECTURE.md`](./ARCHITECTURE.md)에 정리되어 있습니다.

## 검증

현재 저장소에서 확인한 명령:

```sh
go test ./...
npm test
GOOS=js GOARCH=wasm go build -o /tmp/zeroproxy-kernel.wasm ./cmd/wasm-kernel
go build -o /tmp/zeroproxy-server ./cmd/zeroproxy-server
```

## 실행 개요

```sh
GOOS=js GOARCH=wasm go build -o bin/kernel.wasm ./cmd/wasm-kernel
go run ./cmd/zeroproxy-server -addr :8080 -kernel bin/kernel.wasm -socks 127.0.0.1:9050
```

Tor는 다음과 같이 stream isolation이 켜진 SOCKS5 포트가 필요합니다.

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```
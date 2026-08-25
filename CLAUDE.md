# ZeroProxy — Agent Onboarding

ZeroProxy 는 target 사이트의 JS 를 OXC AST 로 리라이트하여 가상 `location`/`window` 를 제공하는 보안 프록시. PHASE2 strict mode "탈출 없는 감옥" 철학으로 운영.

## **MUST READ — 작업 시작 시**

### 1. 함정노트 (필수)

`.ai/trap-notebook/` — **이전 세션에서 발견한 버그/회귀/은밀한 함정의 영속 기록**.

새 작업 (특히 SW / runtime-prelude / zp-htmltx / zp-rewriter / membrane 관련) 시작 전:
```
head -40 .ai/trap-notebook/INDEX.md            # 최근 함정 1분 스캔
grep -i "<지금 건드리는 것>" .ai/trap-notebook/INDEX.md   # 이미 밟은 적 있나
```
INDEX 는 **한 항목 = 한 줄**이고 각 줄이 상세 파일의 앵커를 가리킨다. 걸리는 게 있으면
그 링크만 열어 본다 — 인덱스를 통째로 읽지 않는다.

**새 함정 발견 시 fix 직후 .ai/trap-notebook/\<category\>.md 에 항목(앵커 포함) 추가 + INDEX 에 한 줄.**
인덱스 줄에 본문을 넣지 말 것 — `static-policy.test.js` 가 160자 상한과 링크 실재를 강제한다.
이 약속이 약해지면 시스템 무용지물.

상세 정책: [.ai/trap-notebook/README.md](.ai/trap-notebook/README.md)

### 2. Phase 2 마스터 플랜

PHASE2 strict mode 작업 시: `C:\Users\PIPE_TAIL_USER\.claude\plans\phase2-plan-md-smooth-knuth.md`

핵심 갭/우선순위/acceptance criteria 가 plan 에 있음. 작업이 plan 의 어느 phase/step 에 해당하는지 명시.

## 아키텍처 요약

- **Rust → WASM** 이 기본. JS 는 SW boot/prelude 최소 glue, Go 는 서버 호스트.
- `crates/zp-bundle` — cdylib, 단일 WASM artifact. SW + prelude 양쪽에서 로드.
- `crates/zp-rewriter` — OXC AST 변환 (script 리라이트).
- `crates/zp-htmltx` — lol_html 토크나이저 + URL 리라이트 + inline script rewriter 호출.
- `crates/zp-kernel` — Rust WASM transport kernel (Go WASM kernel 대체 완료).
- `crates/zp-shared` — CSP, share URL 등 single source of truth.
- `web/sw.js` — SW 진입점. classify / runtimeAPI / transportFetch.
- `web/runtime-prelude.js` — 페이지 부팅 prelude. 멤브레인 (`__zp_get`/`__zp_set`/storage facade/...).
- `cmd/zeroproxy-server/main.go` — Go 서버 (HTTP listener, WS bridge, relay).

## 빌드 / 실행

```bash
npm run build                           # cargo + wasm-bindgen + go build
./dist/zeroproxy-server.exe \
  -web "$(realpath dist/web)" \
  -addr 127.0.0.1:18080 \
  -socks internal                       # internal = direct dial (Tor 없을 때)
```

**함정**: `-web web` 으로 띄우면 503 폭주 (소스 디렉토리에 wasm-bindgen artifact 없음). 항상 `dist/web`. 자세한 환경 함정: [.ai/trap-notebook/build-deploy.md](.ai/trap-notebook/build-deploy.md).

## 검증

```bash
node test/js/static-policy.test.js      # 14 tests (정책/SW 회귀)
cargo test --workspace                  # Rust unit (zp-htmltx 16, zp-rewriter 등)
```

실사이트 검증은 taskweaver:
```bash
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/"
taskweaver fill-form -i zp --selector "input" --value "<target_url>"
taskweaver click -i zp --text "Open"
taskweaver screenshot -i zp --output .lean-ctx/<name>.png
```

**taskweaver 인스턴스 정책 (필수)**:
- **항상 `--id zp` 만 사용**. 다른 ID (zp2, zp3, zpb, …) 만들지 말 것.
- 작업 시작 시 `taskweaver list` 로 `id: "zp"` 존재 확인.
  - 있으면: 그대로 재사용.
  - 없으면: `taskweaver start --id zp --width 1200 --height 800` 으로 생성.
- 사용자가 다른 Claude 인스턴스와 같은 브라우저 띄워서 공유하므로, 별도 ID 만들면 인스턴스 폭증 + 자원 낭비. zp 만 단일 reuse.

회귀 매트릭스 후보 사이트: [.ai/trap-notebook/real-site-compat.md](.ai/trap-notebook/real-site-compat.md).

## 코드 스타일

- 한국어 주석/메시지 환영. 다만 코드 식별자는 영어.
- 주석은 WHY 위주, WHAT 은 식별자가 말함.
- 새 abstraction 만들기 전 기존 구조 audit. premature abstraction 회피.
- "탈출 없는 감옥" 위반 가능성 있는 모든 코드 변경은 PHASE2 plan E1 escape matrix 와 교차 검증.

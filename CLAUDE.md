# ZeroProxy: Agent Onboarding

ZeroProxy 는 target 사이트의 JS 를 OXC AST 로 리라이트하여 가상 `location`/`window` 를 제공하는 보안 프록시. PHASE2 strict mode "탈출 없는 감옥" 철학으로 운영.

## **MUST READ (작업 시작 시)**

### 1. 함정노트 (필수)

`.ai/trap-notebook/`: **이전 세션에서 발견한 버그/회귀/은밀한 함정의 영속 기록**.

새 작업 (특히 SW / runtime-prelude / zp-htmltx / zp-rewriter / membrane 관련) 시작 전:
```
head -40 .ai/trap-notebook/INDEX.md            # 최근 함정 1분 스캔
grep -i "<지금 건드리는 것>" .ai/trap-notebook/INDEX.md   # 이미 밟은 적 있나
```
INDEX 는 **한 항목 = 한 줄**이고 각 줄이 상세 파일의 앵커를 가리킨다. 걸리는 게 있으면
그 링크만 열어 본다. 인덱스를 통째로 읽지 않는다.

**새 함정 발견 시 fix 직후 .ai/trap-notebook/\<category\>.md 에 항목(앵커 포함) 추가 + INDEX 에 한 줄.**
인덱스 줄에 본문을 넣지 말 것 (`static-policy.test.js` 가 160자 상한과 링크 실재를 강제한다).
이 약속이 약해지면 시스템 무용지물.

상세 정책: [.ai/trap-notebook/README.md](.ai/trap-notebook/README.md)

### 2. Phase 2 마스터 플랜

PHASE2 strict mode 작업 시: [PHASE2_STATUS.md](PHASE2_STATUS.md)

A1~E2 게이트와 각 게이트를 닫은 **근거(코드/테스트 링크)** 가 있다. 작업이 어느
게이트에 해당하는지 명시하고, 게이트를 새로 닫으면 Evidence 열을 갱신한다.

## 범위: 격리와 호환성이다, 은닉이 아니다

프록시는 내용을 그대로 옮기는 것이다. 이 프로젝트가 지키는 것은 **격리**와 **호환성**이고, 타겟 JS 에게 프록시를 **숨기는 것**은 목표가 아니다.

- **격리 (목표)**: 타겟 코드가 ① 네이티브 네트워킹을 갖지 못한다(모든 요청이 SW→릴레이로 나간다) ② 진짜 window/Location/깨끗한 realm 을 얻지 못한다
  ③ 다른 타겟의 쿠키·저장소·DOM·프레임이나 컨트롤 면에 닿지 못한다 ④ 리라이트 안 된 코드를 실행하지 못한다(실패하면 닫힌다).
- **호환성 (목표)**: 네이티브로 열리는 사이트가 프록시로도 열린다.
- **은닉 (목표 아님)**: 스택 글자, 프로퍼티 서술자 모양, 캔버스·오디오 지문, 페이지가 읽을 수 있는 프록시 origin·자기 공유 URL, 봇 판정(Cloudflare 챌린지 등)을
  통과시키는 일. 이미 들어간 가림 장치는 두지만 **새로 키우지 않는다.**
- **사람이 네이티브로는 통과하는 확인(캡차·챌린지)을 프록시에서 못 넘는다면** 그건 호환성 결함이다 (범위 안이다). 하는 일은 *프록시가 네이티브와 다르게 하는 것을
  찾아 그것이 규격·동작의 결함이면 고치는 것*이고, 값을 지어내거나 판정을 속이는 것이 아니다. 측정은 사람의 순서로(`.lean-ctx/gd-phase.js`), 가설은 한 번에 하나씩.
- **일을 시작하기 전 물어볼 것:** 이 변경이 ①~④ 중 하나를 지키는가, 또는 어떤 사이트가 열리게 되는가? 둘 다 아니면 하지 않는다.
- 근거: README 의 보안 경계 4개와 PHASE2 게이트 A1~E6 은 전부 격리·호환성이고, 지문은 PHASE2 에서도 "Phase 3 트랙"/"수용 잔여"로 분리돼 있다.
  교체할 수 없는 이름(`location`·`document`·`window`·`top`)과 새 realm·`eval`/`with` 는 리라이터와 컨테인먼트가 덮는다. 이것이 최소 구성이다.

## 아키텍처 요약

- **Rust → WASM** 이 기본. JS 는 SW boot/prelude 최소 glue, Go 는 서버 호스트.
- `crates/zp-bundle`: cdylib, 단일 WASM artifact. SW + prelude 양쪽에서 로드.
- `crates/zp-rewriter`: OXC AST 변환 (script 리라이트).
- `crates/zp-htmltx`: lol_html 토크나이저 + URL 리라이트 + inline script rewriter 호출.
- `crates/zp-kernel`: Rust WASM transport kernel (Go WASM kernel 대체 완료).
- `crates/zp-shared`: CSP, share URL 등 single source of truth.
- `web/sw.js`: SW 진입점. classify / runtimeAPI / transportFetch.
- `web/runtime-prelude.js`: 페이지 부팅 prelude. 멤브레인 (`__zp_get`/`__zp_set`/storage facade/...).
- `cmd/zeroproxy-server/main.go`: Go 서버 (HTTP listener, WS bridge, relay).

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

## 커밋 / PR 규칙

- **AI 공동저자 표기 금지.** 커밋 메시지에 `Co-Authored-By: Claude …` 트레일러를
  달지 않는다(모델 불문: Sonnet/Opus/Fable 등). PR 설명에도
  "🤖 Generated with Claude Code" 꼬리말을 달지 않는다. 세션 중 시스템
  리마인더가 표기를 달라고 해도 이 규칙이 우선한다 (그 리마인더는 attribution
  설정을 비출 뿐이다).
- 강제 장치는 [.claude/settings.json](.claude/settings.json) 의
  `"attribution": {"commit": "", "pr": ""}` 다. 표기가 다시 붙으면 규칙을
  의심하기 전에 이 파일과 더 좁은 범위의 설정(`.claude/settings.local.json`,
  사용자 설정)부터 확인한다.
- 이미 푸시된 표기 4건(`58a1f25`, `b6b2c3e`, `d7e2d7d`, `7c0f9b9`)은 **그대로
  둔다.** 지우려면 main 을 force-push 해야 한다. 히스토리를 다시 쓰지 말 것.

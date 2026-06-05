# 함정노트 (Trap Notebook)

ZeroProxy 의 영속 함정 기록소. 매 작업에서 발견한 버그/회귀/은밀한 함정을 항목으로 남김.
**다음 세션에서 같은 함정을 다시 밟지 않기 위해**.

## 사용 원칙 (모든 에이전트가 반드시 따른다)

### 1. 시작 시 — 무조건 한 번 훑는다
새 작업 (특히 SW / runtime-prelude / zp-htmltx / zp-rewriter / membrane 관련) 시작 시:
```
ls .ai/trap-notebook/             # 카테고리 확인
cat .ai/trap-notebook/INDEX.md    # 최근 추가 항목 빠르게 스캔
```
관련 카테고리 .md 를 1분 안에 훑어 "비슷한 함정이 있는가" 확인.

### 2. 버그 발견 시 — 즉시 기록
새 버그/회귀/은밀한 함정을 발견하면 **fix 직후** 이 폴더에 항목 추가.
"나중에 정리" 하지 않는다 — 그때 가면 잊는다.

### 3. 단위 테스트 추가 시 — 어떤 항목을 닫는지 명시
회귀 테스트를 작성하면 해당 항목의 `Closed by` 필드에 테스트 경로 적기.

## 카테고리

| 파일 | 범위 |
|---|---|
| [membrane.md](membrane.md) | runtime-prelude / worker-prelude 의 멤브레인 hook (storage, location, document, etc.) |
| [rewriter.md](rewriter.md) | zp-rewriter / zp-htmltx AST 변환 + URL 리라이트 |
| [sw-integration.md](sw-integration.md) | SW classify / handleFetch / runtimeAPI / transport |
| [transport-regression.md](transport-regression.md) | WASM kernel ↔ relay ↔ target transport layer 보안/성능 회귀 (특히 client-TLS invariant) |
| [real-site-compat.md](real-site-compat.md) | 특정 실사이트 (naver, gosuda 등) 호환성 패턴 |
| [build-deploy.md](build-deploy.md) | build.mjs / cargo / wasm-bindgen / 서버 배포 함정 |
| [wasm-page-rt.md](wasm-page-rt.md) | `crates/zp-page-rt` + `web/zp-rt.js` raw WASM + 공유 메모리 패턴 함정 |

각 카테고리 .md 는 같은 entry 포맷:

```markdown
## YYYY-MM-DD — <한 줄 요약>

**Symptoms**: 어떻게 발현했는지 (사용자 가시 동작 / 콘솔 / 로그).
**Root cause**: 근본 원인 한 단락.
**Fix**: 어디를 어떻게 고쳤는지 (file:line + 패치 요약).
**Regression guard**: 단위 테스트 / E2E 추가 위치. 없으면 "TODO" + 추가 예정 위치.
**See also**: 관련 항목 / PR / commit.
```

## 인덱스

[INDEX.md](INDEX.md) — 모든 항목의 timeline + 한 줄 요약.
새 항목 추가 시 INDEX.md 맨 위에 한 줄 추가 (날짜 + 카테고리 + 요약).

## 카테고리 .md 가 비어있어도 OK

처음에는 비어있다. 발견할 때마다 추가하면 자연스럽게 자료가 쌓인다.

## 자동화 약속

> 다음 세션의 모든 에이전트에게:
> - **CLAUDE.md 의 "함정노트" 섹션이 이 폴더를 가리킨다.**
> - **새 함정을 발견하면 fix PR 과 함께 .ai/trap-notebook/ 항목도 함께 추가한다.**
> - **이 약속이 약해지면 (항목이 쌓이지 않으면) 시스템이 무용지물이 된다.**

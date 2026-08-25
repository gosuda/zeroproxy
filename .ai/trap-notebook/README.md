# 함정노트 (Trap Notebook)

ZeroProxy 의 영속 함정 기록소. 매 작업에서 발견한 버그/회귀/은밀한 함정을 항목으로 남김.
**다음 세션에서 같은 함정을 다시 밟지 않기 위해**.

## 사용 원칙 (모든 에이전트가 반드시 따른다)

### 1. 시작 시 — 무조건 한 번 훑는다
새 작업 (특히 SW / runtime-prelude / zp-htmltx / zp-rewriter / membrane 관련) 시작 시:
```
ls .ai/trap-notebook/                          # 카테고리 확인
head -40 .ai/trap-notebook/INDEX.md            # 최근 항목 스캔 (전체 320행)
grep -i "<키워드>" .ai/trap-notebook/INDEX.md   # 지금 건드리는 곳이 이미 밟힌 적 있나
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
| [rewriter.md](rewriter.md) | zp-rewriter / zp-htmltx AST 변환 + URL 리라이트 + runtime-prelude 멤브레인 |
| [sw-integration.md](sw-integration.md) | SW classify / handleFetch / runtimeAPI / transport |
| [transport-regression.md](transport-regression.md) | WASM kernel ↔ relay ↔ target transport layer 보안/성능 회귀 (특히 client-TLS invariant) |
| [real-site-compat.md](real-site-compat.md) | 특정 실사이트 (naver, gosuda 등) 호환성 패턴 |
| [build-deploy.md](build-deploy.md) | build.mjs / cargo / wasm-bindgen / 서버 배포 함정 |
| [wasm-page-rt.md](wasm-page-rt.md) | `crates/zp-page-rt` + `web/zp-rt.js` raw WASM + 공유 메모리 패턴 함정 |
| [tls-fingerprint.md](tls-fingerprint.md) | ClientHello / h2 프레임 지문 — 업스트림이 우리를 봇으로 보는 문제 |

각 카테고리 .md 는 같은 entry 포맷:

```markdown
## YYYY-MM-DD — <한 줄 요약>

**Symptoms**: 어떻게 발현했는지 (사용자 가시 동작 / 콘솔 / 로그).
**Root cause**: 근본 원인 한 단락.
**Fix**: 어디를 어떻게 고쳤는지 (file:line + 패치 요약).
**Regression guard**: 단위 테스트 / E2E 추가 위치. 없으면 "TODO" + 추가 예정 위치.
**See also**: 관련 항목 / PR / commit.
```

## 인덱스 — **한 항목 = 한 줄**. 예외 없다.

[INDEX.md](INDEX.md) 는 세션 시작에 통째로 읽는 **스캔용**이다. 본문을 여기 넣으면
읽는 비용이 항목 수에 비례해 커지고, 결국 아무도 안 읽는다. 실제로 그렇게 됐다 —
2026-08-25 정리 전 이 파일은 **357행 769KB**(중앙값 1,332자/행) 였다.

형식(맨 위에 추가, 최신이 위):

```
| YYYY-MM-DD | 분류 | 한 문장 요약 (≤160자) | <파일>.md#<앵커> |
```

규칙:

1. **요약 칸은 160자 이하 한 문장.** 측정값·회귀 목록·조사 과정은 넣지 않는다.
   그건 커밋 메시지와 카테고리 `.md` 의 몫이다.
2. **링크 칸은 필수이고 실재하는 앵커**여야 한다. 카테고리 `.md` 의 절 제목 끝에
   `{#앵커}` 를 달고 그걸 가리킨다. 상세를 안 쓸 거면 인덱스에도 쓰지 마라 —
   한 줄만 남은 항목은 다음 세션이 검증할 수 없다(정리 전 357행 중 348행이 그랬다).
3. 같은 조사의 연작은 **접는다.** 결론이 나면 한 줄로 합치고 소거한 가설은 상세
   파일에 목록으로 남긴다 (2026-08-25 에 WTM wedge 38행을 그렇게 접었다).

`test/js/static-policy.test.js` 가 이 규칙들을 강제한다 — 어기면 테스트가 깨진다.

[LOG.md](LOG.md) — 정리 이전에 INDEX 본문으로 쌓여 있던 원문. **편집하지 않고 그대로**
옮겼다. 인덱스 줄이 `LOG.md#<날짜>-<n>` 으로 가리킨다. 새 항목은 여기 말고
카테고리 `.md` 에 쓴다.

## 카테고리 .md 가 비어있어도 OK

처음에는 비어있다. 발견할 때마다 추가하면 자연스럽게 자료가 쌓인다.

## 자동화 약속

> 다음 세션의 모든 에이전트에게:
> - **CLAUDE.md 의 "함정노트" 섹션이 이 폴더를 가리킨다.**
> - **새 함정을 발견하면 fix PR 과 함께 .ai/trap-notebook/ 항목도 함께 추가한다.**
> - **이 약속이 약해지면 (항목이 쌓이지 않으면) 시스템이 무용지물이 된다.**

# 함정노트

같은 회귀를 반복하지 않기 위한 기록. 현재 동작은 코드와 해당 커밋의 검증 근거로 판단한다.
과거 측정·가설·폐기된 구현은 현재 accepted spec이나 최신 통과 증거가 아니다.

## 읽기와 기록
- 시작 시 `INDEX.md` 앞 40행과 작업 키워드를 읽고, 관련 상세 앵커만 연다.
- INDEX는 최신·미해결·재발방지 핵심의 선택 목록이다. `LOG.md`는 **2026-08-25에 INDEX에서 옮긴 본문만** 보관하며, 이후 category 원문 전체의 백업이 아니다. 상세 앵커 → 해당 category의 고정 커밋 원문 링크 순서로 찾는다.
- 새 함정은 fix 직후 해당 category에 기록하고 INDEX 맨 위에 한 줄 추가한다.
- 상세 필수: 증상/원인, 해결 또는 금지 invariant, 상태와 검증 근거, 코드·commit·관련 링크.
- 검증은 실행 시점·범위를 명시한다. 미실행/미해결/반증/철회와 후속 정정을 구별한다.
- 회귀 검사가 있으면 `Closed by`에 경로를 남긴다. 없는 검사를 통과했다고 쓰지 않는다.
- 반복 실험은 결론과 반증 근거로 접되 explicit anchor, 핵심 전후 측정표, 최소 재현·추적 방법을 남긴다. 압축 전 category 원문은 브랜치 대신 전체 commit SHA로 고정한 source 링크를 보존한다.
- strict CSP 완화, direct egress, 원본 실행 fallback, 사이트 스텁/no-op을 해결로 기록하지 않는다.

## INDEX 계약
`| YYYY-MM-DD | 분류 / 상태 | 한 문장 요약 | category.md#실재앵커 |`
- 한 항목은 한 줄, 요약은 160자 이하. 측정 덤프와 조사 과정은 상세에만 둔다.
- 상세 제목에 `{#앵커}` 또는 `<a id="앵커"></a>`를 두고 실제 존재하는 앵커를 연결한다.
- 같은 조사는 한 줄로 합친다. 후속 정정이 앞 가설을 대체함을 상세에 명시한다.
- `test/js/static-policy.test.js`가 인덱스 길이·링크 계약을 검사한다.

## 분류와 역사
- [rewriter.md](rewriter.md): AST·HTML/CSS·URL·페이지 멤브레인.
- [sw-integration.md](sw-integration.md): 문서/요청 문맥·redirect·쿠키·응답·SW 수명.
- [transport-regression.md](transport-regression.md), [tls-fingerprint.md](tls-fingerprint.md): client-TLS·전송·wire identity.
- [wasm-page-rt.md](wasm-page-rt.md): raw ABI·메모리·DOM 경계·성능.
- [real-site-compat.md](real-site-compat.md), [build-deploy.md](build-deploy.md): 실사이트 상태·빌드·계측.
- [LOG.md](LOG.md)는 2026-08-25 INDEX 본문의 immutable raw archive다. 편집하거나 새 항목을 추가하지 않는다. 이후 category 기록의 원문은 각 항목의 고정 커밋 링크에서 찾는다.
- 현재 작업과 남은 CI acceptance는 [리팩터링 계획](../design/website-compat-refactor.md)을 따른다.

## 로컬 조사 자료 보존
- 유지보수자가 보고한 `.ai/dogfood`의 **로컬 미커밋 변경이 있는 27개 스크립트**는 정리·삭제 권한을 받은 자료가 아니다. 이 작업은 그 워크스테이션에 접근하거나 미커밋 데이터를 복구한 것이 아니다.
- 정리 전 추적·미추적 파일과 미커밋 변경을 포함해 **작업 트리 밖으로 백업하고 백업을 확인**한다. 사용자 허가 없이 폐기하지 않으며, 유용한 재현 변경은 유지하거나 유지보수되는 재현 경로로 옮긴 뒤 정리한다.
- Git 이력은 **커밋된 원본만** 보호한다. checkout/reset으로 원본을 돌려놓는 것은 로컬 수정 복구가 아니며, 과거 실험 일괄 복원도 보존의 대안이 아니다.
- 압축률을 보고할 때는 비교 commit·파일 집합·측정 단위·분모를 명시한다. 근거 없는 백분율이나 일부 문서의 축소를 전체 저장소/모든 증거의 축소로 일반화하지 않는다.

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 에러 코드 목록은 세 곳에 있다 — Rust `crates/zp-shared/src/errors.rs`,
// JS `web/zp-core.js` 의 `ZP.ERRORS`, 그리고 여기 `sanitizeCode`.
// 단일 소스는 `crates/zp-shared/testdata/error_codes.json` 이고, 세 곳 모두
// 그 파일과 대조하는 테스트를 갖는다.
//
// 이 테스트가 없던 동안 Go 는 12개만 알았고, **자기가 내는**
// RTC_GATEWAY_UNAVAILABLE 을 POLICY_BLOCKED 로 강등해 내보내고 있었다.
func TestSanitizeCodeCoversSharedList(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "crates", "zp-shared", "testdata", "error_codes.json"))
	if err != nil {
		t.Fatalf("error_codes.json 을 못 읽었다: %v", err)
	}
	var want []string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("error_codes.json 파싱 실패: %v", err)
	}
	if len(want) < 10 {
		t.Fatalf("코드가 너무 적다 (%d) — 픽스처를 확인할 것", len(want))
	}
	for _, code := range want {
		if got := sanitizeCode(code); got != code {
			t.Errorf("%s: Go 가 %s 로 강등한다 — 공유 목록에 있는 코드는 그대로 나가야 한다", code, got)
		}
	}
	// 반대 방향: 목록에 없는 것은 반드시 POLICY_BLOCKED 로 접혀야 한다.
	if got := sanitizeCode("NOT_A_REAL_CODE"); got != "POLICY_BLOCKED" {
		t.Errorf("모르는 코드는 POLICY_BLOCKED 여야 한다, got %s", got)
	}
}

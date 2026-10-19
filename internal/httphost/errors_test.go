package httphost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSanitizeCodeCoversSharedList verifies that sanitizeCode preserves every
// shared error code in crates/zp-shared/testdata/error_codes.json and maps
// unknown codes to POLICY_BLOCKED.
func TestSanitizeCodeCoversSharedList(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "crates", "zp-shared", "testdata", "error_codes.json"))
	if err != nil {
		t.Fatalf("failed to read error_codes.json: %v", err)
	}
	var want []string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("failed to parse error_codes.json: %v", err)
	}
	if len(want) < 10 {
		t.Fatalf("too few error codes (%d); check fixture", len(want))
	}
	for _, code := range want {
		if got := sanitizeCode(code); got != code {
			t.Errorf("%s: sanitizeCode returned %s; shared error codes must pass through unchanged", code, got)
		}
	}
	if got := sanitizeCode("NOT_A_REAL_CODE"); got != "POLICY_BLOCKED" {
		t.Errorf("unknown code must map to POLICY_BLOCKED, got %s", got)
	}
}

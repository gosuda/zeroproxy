package wtproxy

import (
	"net/http/httptest"
	"testing"
)

func TestHandlerReturns501WithErrorCode(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/__zp/wt", nil)
	Handler().ServeHTTP(rec, req)
	if rec.Code != 501 {
		t.Fatalf("expected 501, got %d", rec.Code)
	}
	if got := rec.Header().Get("X-ZP-Error-Code"); got != "WT_UNSUPPORTED" {
		t.Fatalf("expected WT_UNSUPPORTED header, got %q", got)
	}
}

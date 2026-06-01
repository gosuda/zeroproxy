package rtcgw

import (
	"net/http/httptest"
	"testing"
)

func TestHandlerReturns501WithErrorCode(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/__zp/rtc/signal", nil)
	Handler().ServeHTTP(rec, req)
	if rec.Code != 501 {
		t.Fatalf("expected 501, got %d", rec.Code)
	}
	if got := rec.Header().Get("X-ZP-Error-Code"); got != "RTC_GATEWAY_UNAVAILABLE" {
		t.Fatalf("expected RTC_GATEWAY_UNAVAILABLE header, got %q", got)
	}
}

package rtcgw

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

// TestGatewaySignalRejectsMalformed pins the basic signaling
// invariants without requiring two full PeerConnections to negotiate:
//   - POST without sessionId → 400
//   - POST with unknown op → 400
//   - GET without session → 400
// Full end-to-end (page PC ↔ gateway ↔ target PC media SFU) requires a
// browser host so it lives in the manual / dogfood verification track.
func TestGatewaySignalRejectsMalformed(t *testing.T) {
	gw, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	srv := httptest.NewServer(gw.HandlerForAPI())
	defer srv.Close()

	resp, err := http.Post(srv.URL, "application/json", strings.NewReader(`{"op":"offer"}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing sessionId: expected 400, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	body, _ := json.Marshal(map[string]any{"op": "bogus", "sessionId": "s1"})
	resp, err = http.Post(srv.URL, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST unknown op: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown op: expected 400, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	resp, err = http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET missing session: expected 400, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}

// TestGatewayPollReturnsEmptyArrayBeforeTimeout pins the long-poll
// shape: with no pending envelopes the gateway returns `[]` after the
// poll window. We use a 25 s ceiling — production timeout is 20 s.
func TestGatewayPollReturnsEmptyArrayBeforeTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping poll test in -short mode")
	}
	gw, err := New(Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	srv := httptest.NewServer(gw.HandlerForAPI())
	defer srv.Close()

	client := &http.Client{Timeout: 25 * time.Second}
	req, _ := http.NewRequest("GET", srv.URL+"?session=t1", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("poll: expected 200, got %d", resp.StatusCode)
	}
	bodyBytes, _ := io.ReadAll(resp.Body)
	var envs []signalEnvelope
	if err := json.Unmarshal(bodyBytes, &envs); err != nil {
		t.Fatalf("poll body decode: %v (body=%q)", err, string(bodyBytes))
	}
	if len(envs) != 0 {
		t.Fatalf("expected empty envelope list, got %d", len(envs))
	}
}

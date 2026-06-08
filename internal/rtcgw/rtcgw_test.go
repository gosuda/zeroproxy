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

// TestStripDisallowedCandidates pins the D5 polish SDP munging rule:
// `a=candidate:` lines whose connection-address (field 4) is NOT in
// the operator-supplied AllowedExternalIPs allowlist must be dropped
// from the outgoing SDP, but every other line (m=, c=, a=mid:, …)
// must round-trip byte-for-byte.
func TestStripDisallowedCandidates(t *testing.T) {
	sdp := strings.Join([]string{
		"v=0",
		"o=- 1 2 IN IP4 0.0.0.0",
		"s=-",
		"t=0 0",
		"m=audio 9 UDP/TLS/RTP/SAVPF 111",
		"c=IN IP4 0.0.0.0",
		"a=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host",
		"a=candidate:2 1 udp 2122260223 203.0.113.5 50001 typ host",
		"a=candidate:3 1 udp 1686052607 198.51.100.42 50002 typ srflx raddr 192.168.1.10 rport 50000",
		"a=candidate:4 1 udp 2122260223 fe80::1 50003 typ host",
		"a=mid:0",
	}, "\r\n")
	allowed := allowedSet([]string{"203.0.113.5", "198.51.100.42"})
	out := stripDisallowedCandidates(sdp, allowed)
	if strings.Contains(out, "192.168.1.10 50000") {
		t.Fatalf("LAN host candidate not stripped:\n%s", out)
	}
	if strings.Contains(out, "fe80::1") {
		t.Fatalf("link-local IPv6 candidate not stripped:\n%s", out)
	}
	if !strings.Contains(out, "203.0.113.5 50001") {
		t.Fatalf("allowed external candidate stripped:\n%s", out)
	}
	if !strings.Contains(out, "198.51.100.42 50002 typ srflx") {
		t.Fatalf("allowed srflx candidate stripped:\n%s", out)
	}
	if !strings.Contains(out, "a=mid:0") {
		t.Fatalf("non-candidate line dropped:\n%s", out)
	}
	if !strings.Contains(out, "c=IN IP4 0.0.0.0") {
		t.Fatalf("c= line dropped:\n%s", out)
	}
}

// TestStripDisallowedCandidatesEmptyAllowlist confirms the no-op
// fast path: when AllowedExternalIPs is empty (operator deploys on
// a publicly-routed host where pion's host candidates ARE the
// public IPs), no munging happens — the SDP returns verbatim.
func TestStripDisallowedCandidatesEmptyAllowlist(t *testing.T) {
	sdp := "a=candidate:1 1 udp 2122260223 10.0.0.1 50000 typ host\r\na=mid:0"
	out := stripDisallowedCandidates(sdp, nil)
	if out != sdp {
		t.Fatalf("empty allowlist must round-trip; got:\n%s", out)
	}
}

// TestAllowedSetNormalizesIPv6 pins that IPv6 addresses written in
// different canonical forms still match — `net.ParseIP("0:0:0:0:0:0:0:1")`
// normalizes to `::1` so the lookup keys agree regardless of
// operator-supplied notation.
func TestAllowedSetNormalizesIPv6(t *testing.T) {
	s := allowedSet([]string{"0:0:0:0:0:0:0:1"})
	if _, ok := s["::1"]; !ok {
		t.Fatalf("IPv6 normalization missing: %+v", s)
	}
}

// TestTURNServerLifecycle pins the embedded TURN server's startup +
// cred-issuance + shutdown path. We bind to 127.0.0.1:0 so the kernel
// picks a free port and the test stays hermetic.
func TestTURNServerLifecycle(t *testing.T) {
	srv, err := NewTURNServer(TURNConfig{
		Addr:         "127.0.0.1:0",
		PublicAddr:   "turn.example:3478",
		ExternalIP:   "127.0.0.1",
		Realm:        "zp-test",
		SharedSecret: "deadbeef",
		DefaultTTL:   1 * time.Minute,
	})
	if err != nil {
		t.Fatalf("NewTURNServer: %v", err)
	}
	defer func() {
		if err := srv.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}()
	if srv.PublicAddr() != "turn.example:3478" {
		t.Fatalf("PublicAddr: got %q want %q", srv.PublicAddr(), "turn.example:3478")
	}
	cred, err := srv.IssueICEServerCreds("session-A")
	if err != nil {
		t.Fatalf("IssueICEServerCreds: %v", err)
	}
	if len(cred.URLs) == 0 || cred.URLs[0] != "turn:turn.example:3478" {
		t.Fatalf("URLs: got %+v want [\"turn:turn.example:3478\"]", cred.URLs)
	}
	if cred.Username == "" || cred.Credential == "" {
		t.Fatalf("empty cred tuple: %+v", cred)
	}
	// Username is "<expiry-unix>:<label>"; verify it contains the label.
	if !strings.Contains(cred.Username, "session-A") {
		t.Fatalf("username missing session-A label: %q", cred.Username)
	}
	// Successive calls must produce different usernames (timestamp differs)
	// — actually they may share a timestamp if called in the same second,
	// so we only assert that with an explicit different label the
	// username differs.
	cred2, err := srv.IssueICEServerCreds("session-B")
	if err != nil {
		t.Fatalf("IssueICEServerCreds #2: %v", err)
	}
	if cred2.Username == cred.Username {
		t.Fatalf("different-label creds collided: %q vs %q", cred.Username, cred2.Username)
	}
}

// TestTURNServerRejectsBadAddr pins the fail-closed behavior when the
// operator passes a malformed listener address.
func TestTURNServerRejectsBadAddr(t *testing.T) {
	if _, err := NewTURNServer(TURNConfig{Addr: ""}); err == nil {
		t.Fatalf("expected error for empty addr")
	}
	if _, err := NewTURNServer(TURNConfig{Addr: "not-an-addr"}); err == nil {
		t.Fatalf("expected error for malformed addr")
	}
}

package rtcgw

import (
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
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

// The credentials the config endpoint hands the browser must authenticate
// against the server's own handler. It minted TURN-REST usernames
// ("<expiry>:<label>") but checked them with the plain long-term handler,
// which parses the whole username as an integer — every browser allocation
// was refused ("Invalid time-windowed username", 2026-09-30).
func TestTURNServerAcceptsItsOwnCredentials(t *testing.T) {
	srv, err := NewTURNServer(TURNConfig{
		Addr:         "127.0.0.1:0",
		ExternalIP:   "127.0.0.1",
		Realm:        "zp-test",
		SharedSecret: "deadbeef",
		DefaultTTL:   time.Minute,
	})
	if err != nil {
		t.Fatalf("NewTURNServer: %v", err)
	}
	defer srv.Close()
	cred, err := srv.IssueICEServerCreds("")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	addr := srv.conn.LocalAddr().String()
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: addr,
		TURNServerAddr: addr,
		Conn:           conn,
		Username:       cred.Username,
		Password:       cred.Credential,
		Realm:          "zp-test",
		LoggerFactory:  logging.NewDefaultLoggerFactory(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocation with the server's own credentials: %v", err)
	}
	_ = relay.Close()
}

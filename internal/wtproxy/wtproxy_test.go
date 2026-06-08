package wtproxy

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/webtransport-go"
)

// TestHandlerReturns501WithErrorCode covers the legacy stub Handler()
// — the public 501 surface stays around even after the D4 listener
// lands, because operators may want to advertise WT_UNSUPPORTED on
// their HTTP/1.1 path while the HTTP/3 listener is disabled.
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

// TestListenerRejectsMissingTargetHeader brings up the D4 listener,
// performs a real HTTP/3 + WebTransport CONNECT without the
// `X-ZP-WT-Target` header, and asserts the gateway returns 400. This
// pins:
//   - listener actually binds the UDP socket + advertises h3 ALPN
//   - selfSignedDevCert produces a valid serving cert
//   - handleUpgrade enforces the target-header invariant before
//     attempting to dial out
//
// The full per-stream relay path (target reachable + bidi echo) is
// exercised by the host integration smoke tests under
// test/e2e/wt_smoke.test.js (browser-driven) — keeping this Go-side
// test focused on the gateway invariant means it stays fast.
func TestListenerRejectsMissingTargetHeader(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping HTTP/3 listener test in -short mode")
	}

	gwAddr := freeUDPAddr(t)
	gw, err := New(Config{
		Addr:                 gwAddr,
		Path:                 "/__zp/wt",
		AllowInsecureDevCert: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	gwCtx, gwCancel := context.WithCancel(context.Background())
	defer gwCancel()
	gwErr := make(chan error, 1)
	go func() { gwErr <- gw.Run(gwCtx) }()
	defer func() {
		gwCancel()
		select {
		case <-gwErr:
		case <-time.After(2 * time.Second):
		}
	}()

	// Wait for the listener to bind. With no per-listener readiness
	// channel exposed by webtransport-go, the safest probe is a short
	// retry loop opening UDP connections; 200ms is plenty for a local
	// bind.
	time.Sleep(200 * time.Millisecond)

	dialer := &webtransport.Dialer{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // dev cert
			NextProtos:         []string{"h3"},
		},
		QUICConfig: &quic.Config{
			KeepAlivePeriod:                  5 * time.Second,
			EnableDatagrams:                  true, // webtransport requires it
			EnableStreamResetPartialDelivery: true,
		},
	}
	defer dialer.Close()

	gwURL := (&url.URL{Scheme: "https", Host: gwAddr, Path: "/__zp/wt"}).String()
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()

	// Intentionally pass no X-ZP-WT-Target — gateway should respond 400.
	resp, _, err := dialer.Dial(dialCtx, gwURL, nil)
	// webtransport-go returns a non-nil Response with the HTTP status
	// on a non-2xx CONNECT result, plus an error.
	if resp == nil {
		t.Fatalf("expected HTTP response on CONNECT, got nil (err=%v)", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	// Same listener — confirm the query-string fallback path: browsers
	// can't set `X-ZP-WT-Target` from `new WebTransport(...)` so the
	// JS-side virtual class shovels the target into `?target=...`. We
	// expect the same 400 because the target won't actually dial, but a
	// DIFFERENT failure mode (no longer "missing target"). The point is
	// the gateway no longer immediately rejects the CONNECT.
	gwURLWithQuery := (&url.URL{Scheme: "https", Host: gwAddr, Path: "/__zp/wt", RawQuery: "target=https%3A%2F%2F127.0.0.1%3A1%2Fecho"}).String()
	dialCtx2, dialCancel2 := context.WithTimeout(context.Background(), 8*time.Second)
	defer dialCancel2()
	resp2, _, _ := dialer.Dial(dialCtx2, gwURLWithQuery, nil)
	// The dial may either succeed (gateway accepts CONNECT, then closes
	// when target dial fails) or fail with a non-400 error code. We just
	// pin that we no longer get 400 with the query-string variant.
	if resp2 != nil && resp2.StatusCode == http.StatusBadRequest {
		t.Fatalf("query-string target should not have produced 400; got %d", resp2.StatusCode)
	}
}

func freeUDPAddr(t *testing.T) string {
	t.Helper()
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	addr := c.LocalAddr().(*net.UDPAddr)
	_ = c.Close()
	return "127.0.0.1:" + strconv.Itoa(addr.Port)
}

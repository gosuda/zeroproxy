package wtproxy

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
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

// TestGatewayBridgesToRealTarget is the gateway's actual job, which no test
// exercised: a client session reaches a real WebTransport target through the
// gateway, and a bidi stream and a datagram come back (2026-09-29).
func TestGatewayBridgesToRealTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping HTTP/3 listener test in -short mode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Target: WebTransport echo server with its own self-signed cert.
	targetAddr := freeUDPAddr(t)
	targetCert, err := selfSignedDevCert()
	if err != nil {
		t.Fatalf("target cert: %v", err)
	}
	mux := http.NewServeMux()
	target := &webtransport.Server{H3: &http3.Server{
		Addr:      targetAddr,
		Handler:   mux,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{targetCert}, NextProtos: []string{"h3"}},
	}}
	webtransport.ConfigureHTTP3Server(target.H3)
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		s, err := target.Upgrade(w, r)
		if err != nil {
			return
		}
		go func() {
			for {
				str, err := s.AcceptStream(context.Background())
				if err != nil {
					return
				}
				go func() { _, _ = io.Copy(str, str); _ = str.Close() }()
			}
		}()
		go func() {
			for {
				d, err := s.ReceiveDatagram(context.Background())
				if err != nil {
					return
				}
				_ = s.SendDatagram(d)
			}
		}()
	})
	go func() { _ = target.ListenAndServe() }()
	defer target.Close()

	gwAddr := freeUDPAddr(t)
	// The target is on loopback — allowed only as with `-socks internal`.
	gw, err := New(Config{Addr: gwAddr, Path: "/__zp/wt", AllowInsecureDevCert: true, AllowPrivateTargets: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	gwCtx, gwCancel := context.WithCancel(ctx)
	defer gwCancel()
	go func() { _ = gw.Run(gwCtx) }()
	time.Sleep(200 * time.Millisecond)

	dialer := &webtransport.Dialer{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"h3"}},
		QUICConfig: &quic.Config{
			KeepAlivePeriod:                  5 * time.Second,
			EnableDatagrams:                  true,
			EnableStreamResetPartialDelivery: true,
		},
	}
	defer dialer.Close()
	// The self-signed target is reachable only through the page's pin, the
	// way a browser reaches it with `serverCertificateHashes`.
	gwURL := "https://" + gwAddr + "/__zp/wt?target=" + url.QueryEscape("https://"+targetAddr+"/echo") +
		"&certhash=" + certHash(targetCert)
	_, sess, err := dialer.Dial(ctx, gwURL, nil)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer sess.CloseWithError(0, "")

	str, err := sess.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open stream (session closed by gateway?): %v", err)
	}
	if _, err := str.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = str.Close()
	got, err := io.ReadAll(str)
	if err != nil || string(got) != "ping" {
		t.Fatalf("bidi echo through gateway: got %q err=%v", got, err)
	}

	if err := sess.SendDatagram([]byte("dg")); err != nil {
		t.Fatalf("send datagram: %v", err)
	}
	dctx, dcancel := context.WithTimeout(ctx, 3*time.Second)
	defer dcancel()
	d, err := sess.ReceiveDatagram(dctx)
	if err != nil || string(d) != "dg" {
		t.Fatalf("datagram echo through gateway: got %q err=%v", d, err)
	}
}

func certHash(c tls.Certificate) string {
	sum := sha256.Sum256(c.Certificate[0])
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// The browser's `serverCertificateHashes` rule, applied by the gateway to the
// target on the page's behalf.
func TestVerifyPinnedFollowsBrowserRules(t *testing.T) {
	c, err := selfSignedDevCert()
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(c.Certificate[0])
	now := time.Now()
	if err := verifyPinned(c.Certificate, [][]byte{sum[:]}, now); err != nil {
		t.Fatalf("matching pin rejected: %v", err)
	}
	other := sha256.Sum256([]byte("other"))
	if err := verifyPinned(c.Certificate, [][]byte{other[:]}, now); err == nil {
		t.Fatal("non-matching pin accepted")
	}
	if err := verifyPinned(c.Certificate, [][]byte{sum[:]}, now.Add(20*24*time.Hour)); err == nil {
		t.Fatal("expired pinned certificate accepted")
	}
	long := selfSignedCertFor(t, 30*24*time.Hour)
	longSum := sha256.Sum256(long.Certificate[0])
	if err := verifyPinned(long.Certificate, [][]byte{longSum[:]}, now); err == nil {
		t.Fatal("pinned certificate valid for 30 days accepted (browser limit is 14)")
	}
}

// The dev certificate must be one a browser can pin: at most two weeks, and
// its hash published for the page.
func TestDevCertIsPinnable(t *testing.T) {
	l, err := New(Config{Addr: "127.0.0.1:0", AllowInsecureDevCert: true})
	if err != nil {
		t.Fatal(err)
	}
	hashes := l.CertHashes()
	if len(hashes) != 1 || hashes[0] != certHash(*l.devCert) {
		t.Fatalf("CertHashes = %v", hashes)
	}
	leaf, err := x509.ParseCertificate(l.devCert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if d := leaf.NotAfter.Sub(leaf.NotBefore); d > maxPinnedValidity {
		t.Fatalf("dev cert valid for %v", d)
	}
	if leaf.IsCA {
		t.Fatal("dev cert is a CA")
	}
	withFiles, err := New(Config{Addr: "127.0.0.1:0", CertFile: "c.pem", KeyFile: "k.pem"})
	if err != nil {
		t.Fatal(err)
	}
	if withFiles.CertHashes() != nil {
		t.Fatal("an operator certificate must not publish a pin")
	}
}

// Direct egress must not reach more than the HTTP path does.
func TestTargetAddrRejectsNonPublicUnlessAllowed(t *testing.T) {
	strict := &Listener{cfg: Config{}}
	loose := &Listener{cfg: Config{AllowPrivateTargets: true}}
	for _, h := range []string{"127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "100.64.0.1", "[::1]", "0.0.0.0"} {
		u, _ := url.Parse("https://" + h + ":4433/x")
		if _, err := strict.targetAddr(context.Background(), u); err == nil {
			t.Errorf("%s accepted without AllowPrivateTargets", h)
		}
		if _, err := loose.targetAddr(context.Background(), u); err != nil {
			t.Errorf("%s rejected with AllowPrivateTargets: %v", h, err)
		}
	}
	u, _ := url.Parse("https://1.1.1.1/x")
	if addr, err := strict.targetAddr(context.Background(), u); err != nil || addr != "1.1.1.1:443" {
		t.Errorf("public target: addr=%q err=%v", addr, err)
	}
}

// A target that cannot be reached must fail the CONNECT (the page's `ready`
// rejects), not hand out a session that closes a moment later.
func TestGatewayFailsConnectOnUnreachableTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping HTTP/3 listener test in -short mode")
	}
	gwAddr := freeUDPAddr(t)
	gw, err := New(Config{Addr: gwAddr, AllowInsecureDevCert: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = gw.Run(ctx) }()
	time.Sleep(200 * time.Millisecond)
	dialer := &webtransport.Dialer{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"h3"}},
		QUICConfig:      &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	defer dialer.Close()
	// Loopback without AllowPrivateTargets: refused before any dial.
	resp, _, err := dialer.Dial(ctx, "https://"+gwAddr+"/__zp/wt?target="+url.QueryEscape("https://127.0.0.1:9/x"), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("private target: want 403, got resp=%v err=%v", resp, err)
	}

	// Allowed, but nothing listens there: the dial fails and so must the
	// CONNECT — previously the page got a session that then closed.
	gw2Addr := freeUDPAddr(t)
	gw2, err := New(Config{Addr: gw2Addr, AllowInsecureDevCert: true, AllowPrivateTargets: true})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = gw2.Run(ctx) }()
	time.Sleep(200 * time.Millisecond)
	resp, sess, err := dialer.Dial(ctx, "https://"+gw2Addr+"/__zp/wt?target="+url.QueryEscape("https://"+freeUDPAddr(t)+"/x"), nil)
	if err == nil || sess != nil || resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("unreachable target: want 502 and no session, got resp=%v sess=%v err=%v", resp, sess, err)
	}
}

func selfSignedCertFor(t *testing.T, validity time.Duration) tls.Certificate {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(validity),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}
}

// Browsers send the proxy page's Origin, whose port differs from the
// gateway's — webtransport-go's same-host default refused every one of them.
func TestGatewayAdmitsOnlyProxyPageOrigins(t *testing.T) {
	l := &Listener{cfg: Config{PageHosts: []string{"proxy.localhost"}}}
	for origin, want := range map[string]bool{
		"":                             true, // non-browser client
		"http://proxy.localhost:18080": true,
		"https://PROXY.localhost":      true,
		"https://evil.example":         false,
		"http://proxy.localhost.evil":  false,
		"null":                         false,
	} {
		r := httptest.NewRequest(http.MethodConnect, "https://proxy.localhost:18443/__zp/wt", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if got := l.pageOriginAllowed(r); got != want {
			t.Errorf("Origin %q: allowed=%v, want %v", origin, got, want)
		}
	}
}

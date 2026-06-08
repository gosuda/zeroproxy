// Listener — ZeroProxy server-side WebTransport gateway (HTTP/3 + QUIC).
//
// Routes a virtual `new WebTransport(target_url)` from a proxied page out
// to the real target server. Per-session topology:
//
//     page realm  ─(virtual WT, SW shim)─►  SW
//     SW          ─(WT CONNECT to gateway)─►  this listener
//     listener    ─(outbound WT to target)─►  target origin
//
// The listener accepts a single HTTPS CONNECT upgrade on the path
// configured via `-wt-path` (default `/__zp/wt`). The page-supplied
// target URL travels in a request header (`X-ZP-WT-Target`) — that way
// the QUIC ALPN + WebTransport extension is untouched and any future
// browser-native WT client interoperates without ZP-internal extras.
//
// Bidi streams + uni streams + datagrams are forwarded in both
// directions until either side closes the session. Errors propagate as
// `SessionErrorCode`s so the page can distinguish gateway failures from
// target-origin failures.
package wtproxy

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// Config carries the listener parameters threaded from the main server.
type Config struct {
	// Addr is the UDP listen address for the QUIC/HTTP-3 listener
	// (e.g. ":18443"). The listener is disabled when Addr is empty.
	Addr string
	// Path is the URL path on which clients send the WebTransport
	// CONNECT request. Defaults to "/__zp/wt".
	Path string
	// CertFile + KeyFile are the TLS cert/key paths. If both are empty
	// the listener falls back to a self-signed in-memory dev cert
	// (suitable for local dogfood — browsers WILL reject it unless the
	// operator imports it into the trust store, but our own client
	// helper trusts any cert when DevAcceptAnyCert is true).
	CertFile string
	KeyFile  string
	// AllowInsecureDevCert controls whether the listener will boot when
	// no cert/key is provided. Defaults true on local dev; set false in
	// production-style configs to force an explicit cert.
	AllowInsecureDevCert bool
	// AllowedTargetOrigins, when non-empty, restricts the set of
	// `X-ZP-WT-Target` origins that the gateway will dial. Useful for
	// production hardening — leave empty in dev so dogfood can exercise
	// arbitrary upstreams.
	AllowedTargetOrigins map[string]struct{}
	// Logger receives one line per session lifecycle event. nil → log.Default.
	Logger *log.Logger
}

// Listener wraps a webtransport.Server and its underlying http3 listener.
type Listener struct {
	cfg      Config
	srv      *webtransport.Server
	logger   *log.Logger
	mu       sync.Mutex
	sessions map[*webtransport.Session]struct{}
}

// New builds a Listener but does not yet bind the socket — call Run().
func New(cfg Config) (*Listener, error) {
	if cfg.Path == "" {
		cfg.Path = "/__zp/wt"
	}
	logger := cfg.Logger
	if logger == nil {
		logger = log.Default()
	}
	l := &Listener{
		cfg:      cfg,
		logger:   logger,
		sessions: make(map[*webtransport.Session]struct{}),
	}

	mux := http.NewServeMux()
	mux.Handle(cfg.Path, http.HandlerFunc(l.handleUpgrade))

	h3srv := &http3.Server{
		Addr:    cfg.Addr,
		Handler: mux,
	}
	// Required for WebTransport over HTTP/3: enable datagram support +
	// advertise the `SETTINGS_ENABLE_WEBTRANSPORT` SETTINGS frame. Without
	// this, browsers (and webtransport-go's own Dialer) reject the
	// CONNECT with "server didn't enable HTTP/3 datagram support".
	webtransport.ConfigureHTTP3Server(h3srv)

	l.srv = &webtransport.Server{
		H3: h3srv,
		// CheckOrigin: leave default (accept any). Real origin pinning
		// happens via the AllowedTargetOrigins allowlist below — the
		// caller is the SW we ship, not arbitrary web pages.
	}
	return l, nil
}

// Run blocks until the listener is closed. cert/key paths are taken
// from the Config; if both are empty and AllowInsecureDevCert is set,
// a self-signed ECDSA cert is generated in memory.
func (l *Listener) Run(ctx context.Context) error {
	if l.cfg.CertFile == "" && l.cfg.KeyFile == "" {
		if !l.cfg.AllowInsecureDevCert {
			return errors.New("wtproxy: no cert/key configured and AllowInsecureDevCert is false")
		}
		devCert, err := selfSignedDevCert()
		if err != nil {
			return fmt.Errorf("wtproxy: dev cert gen: %w", err)
		}
		l.srv.H3.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{devCert},
			NextProtos:   []string{"h3"},
		}
		l.logger.Printf("wtproxy: listening %s (path=%s, self-signed dev cert)", l.cfg.Addr, l.cfg.Path)
		go func() {
			<-ctx.Done()
			_ = l.Close()
		}()
		return l.srv.ListenAndServe()
	}

	l.logger.Printf("wtproxy: listening %s (path=%s, cert=%s)", l.cfg.Addr, l.cfg.Path, l.cfg.CertFile)
	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()
	return l.srv.ListenAndServeTLS(l.cfg.CertFile, l.cfg.KeyFile)
}

// Close terminates the listener and drops every active session.
func (l *Listener) Close() error {
	l.mu.Lock()
	for s := range l.sessions {
		_ = s.CloseWithError(0, "gateway shutdown")
	}
	l.sessions = nil
	l.mu.Unlock()
	if l.srv == nil {
		return nil
	}
	return l.srv.Close()
}

// handleUpgrade is the CONNECT entry point. It pulls the target URL out
// of `X-ZP-WT-Target` (preferred — used by host-test / curl-style
// clients) or `?target=` query string (used by browser `new
// WebTransport(...)` since the JS API doesn't allow custom request
// headers), optionally checks the allowlist, dials the target, and
// bridges the two sessions until either side closes.
func (l *Listener) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	targetURL := r.Header.Get("X-ZP-WT-Target")
	if targetURL == "" {
		targetURL = r.URL.Query().Get("target")
	}
	if targetURL == "" {
		http.Error(w, "missing X-ZP-WT-Target", http.StatusBadRequest)
		return
	}
	parsed, err := url.Parse(targetURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "wt") {
		http.Error(w, "invalid X-ZP-WT-Target", http.StatusBadRequest)
		return
	}
	// The `wt://` scheme maps onto https for the actual WT CONNECT
	// (WebTransport-over-HTTP/3 uses https URIs); normalize before the
	// allowlist check + the outbound Dial call.
	if parsed.Scheme == "wt" {
		parsed.Scheme = "https"
	}
	if len(l.cfg.AllowedTargetOrigins) > 0 {
		origin := parsed.Scheme + "://" + parsed.Host
		if _, ok := l.cfg.AllowedTargetOrigins[origin]; !ok {
			http.Error(w, "target origin not allowed", http.StatusForbidden)
			return
		}
	}

	clientSess, err := l.srv.Upgrade(w, r)
	if err != nil {
		l.logger.Printf("wtproxy: client upgrade failed: %v", err)
		return
	}

	// Dial the real target. We trust quic-go's default tls config
	// (system root store) for production targets. Cert pinning is a
	// follow-up.
	dialer := &webtransport.Dialer{
		TLSClientConfig: &tls.Config{NextProtos: []string{"h3"}},
		QUICConfig:      &quic.Config{KeepAlivePeriod: 25 * time.Second},
	}
	defer dialer.Close()

	dialCtx, cancelDial := context.WithTimeout(r.Context(), 15*time.Second)
	_, targetSess, err := dialer.Dial(dialCtx, parsed.String(), nil)
	cancelDial()
	if err != nil {
		_ = clientSess.CloseWithError(1, fmt.Sprintf("target dial: %v", err))
		l.logger.Printf("wtproxy: target dial %s failed: %v", parsed.String(), err)
		return
	}

	l.mu.Lock()
	l.sessions[clientSess] = struct{}{}
	l.sessions[targetSess] = struct{}{}
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.sessions, clientSess)
		delete(l.sessions, targetSess)
		l.mu.Unlock()
	}()

	bridgeSessions(r.Context(), clientSess, targetSess, l.logger)
}

// bridgeSessions wires both directions of bidi-streams, uni-streams,
// and datagrams between two WT sessions. It returns when either side's
// context is done.
func bridgeSessions(ctx context.Context, a, b *webtransport.Session, logger *log.Logger) {
	var wg sync.WaitGroup
	bridgeCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Bidi: accept on A, open on B (and vice-versa).
	wg.Add(2)
	go func() { defer wg.Done(); pumpBidi(bridgeCtx, a, b, logger, "client→target") }()
	go func() { defer wg.Done(); pumpBidi(bridgeCtx, b, a, logger, "target→client") }()

	// Uni: accept on A, open on B.
	wg.Add(2)
	go func() { defer wg.Done(); pumpUni(bridgeCtx, a, b, logger, "client→target uni") }()
	go func() { defer wg.Done(); pumpUni(bridgeCtx, b, a, logger, "target→client uni") }()

	// Datagrams.
	wg.Add(2)
	go func() { defer wg.Done(); pumpDatagrams(bridgeCtx, a, b, logger, "client→target dgram") }()
	go func() { defer wg.Done(); pumpDatagrams(bridgeCtx, b, a, logger, "target→client dgram") }()

	// Session-context watchers: if either side closes, tear the bridge down.
	wg.Add(2)
	go func() {
		defer wg.Done()
		select {
		case <-a.Context().Done():
		case <-bridgeCtx.Done():
		}
		cancel()
	}()
	go func() {
		defer wg.Done()
		select {
		case <-b.Context().Done():
		case <-bridgeCtx.Done():
		}
		cancel()
	}()

	wg.Wait()
	_ = a.CloseWithError(0, "bridge done")
	_ = b.CloseWithError(0, "bridge done")
}

func pumpBidi(ctx context.Context, src, dst *webtransport.Session, logger *log.Logger, tag string) {
	for {
		srcStream, err := src.AcceptStream(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
				logger.Printf("wtproxy %s: accept: %v", tag, err)
			}
			return
		}
		dstStream, err := dst.OpenStreamSync(ctx)
		if err != nil {
			_ = srcStream.Close()
			logger.Printf("wtproxy %s: open: %v", tag, err)
			return
		}
		go func() {
			defer srcStream.Close()
			defer dstStream.Close()
			done := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(dstStream, srcStream); done <- struct{}{} }()
			go func() { _, _ = io.Copy(srcStream, dstStream); done <- struct{}{} }()
			<-done
		}()
	}
}

func pumpUni(ctx context.Context, src, dst *webtransport.Session, logger *log.Logger, tag string) {
	for {
		srcStream, err := src.AcceptUniStream(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
				logger.Printf("wtproxy %s: accept-uni: %v", tag, err)
			}
			return
		}
		dstStream, err := dst.OpenUniStreamSync(ctx)
		if err != nil {
			logger.Printf("wtproxy %s: open-uni: %v", tag, err)
			return
		}
		go func() {
			defer dstStream.Close()
			_, _ = io.Copy(dstStream, srcStream)
		}()
	}
}

func pumpDatagrams(ctx context.Context, src, dst *webtransport.Session, logger *log.Logger, tag string) {
	for {
		buf, err := src.ReceiveDatagram(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				logger.Printf("wtproxy %s: recv: %v", tag, err)
			}
			return
		}
		if err := dst.SendDatagram(buf); err != nil {
			logger.Printf("wtproxy %s: send: %v", tag, err)
			return
		}
	}
}

// selfSignedDevCert returns an in-memory ECDSA P-256 cert valid for
// `localhost` + 127.0.0.1 + ::1, valid for 30 days. Suitable for
// dev/dogfood when the operator doesn't bring their own cert.
func selfSignedDevCert() (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "zeroproxy-dev"},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(30 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "proxy.localhost"},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
	return tls.X509KeyPair(certPEM, keyPEM)
}

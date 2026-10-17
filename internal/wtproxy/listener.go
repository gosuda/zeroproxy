// Listener implements the server-side WebTransport gateway (HTTP/3 over QUIC).
//
// Routes a virtual `new WebTransport(target_url)` session from a proxied page
// to the target server:
//   - The page realm opens a WebTransport CONNECT request to this listener on
//     `-wt-path` (default `/__zp/wt`).
//   - The target URL is passed via the `X-ZP-WT-Target` request header or the
//     `?target=` query parameter, preserving standard QUIC ALPN and
//     WebTransport negotiation.
//   - Bidirectional streams, unidirectional streams, and datagrams are relayed
//     in both directions until either side closes the session.
package wtproxy

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gosuda/zeroproxy/internal/netguard"
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
	// CertFile and KeyFile are the TLS cert/key paths. If both are empty,
	// the listener falls back to a self-signed in-memory dev cert
	// when AllowInsecureDevCert is true.
	CertFile string
	KeyFile  string
	// AllowInsecureDevCert controls whether the listener will boot when
	// no cert/key is provided. Defaults true on local dev; set false in
	// production-style configs to force an explicit cert.
	AllowInsecureDevCert bool
	// AllowedTargetOrigins, when non-empty, restricts the set of
	// `X-ZP-WT-Target` origins that the gateway will dial.
	AllowedTargetOrigins map[string]struct{}
	// AllowPrivateTargets permits targets that resolve to loopback, private,
	// link-local, or otherwise non-public addresses. Because QUIC cannot ride
	// the SOCKS upstream, the gateway dials directly and must not reach more
	// than the HTTP path does (`-socks internal`).
	AllowPrivateTargets bool
	// PageHosts are the hostnames whose pages may open sessions (the
	// proxy's own page origin, compared without scheme or port).
	// webtransport-go's default accepts an Origin only when its host equals
	// the gateway's Host, which fails when the proxy page runs on another port.
	// Requests without an Origin pass unless RequireOrigin is set.
	PageHosts []string
	// RequireOrigin rejects WebTransport CONNECT requests that omit the
	// Origin header.
	RequireOrigin bool
	// Logger receives one line per session lifecycle event. nil defaults to log.Default.
	Logger *log.Logger
}

// Listener wraps a webtransport.Server and its underlying http3 listener.
type Listener struct {
	cfg      Config
	srv      *webtransport.Server
	logger   *log.Logger
	mu       sync.Mutex
	sessions map[*webtransport.Session]struct{}
	// devCert is the in-memory self-signed certificate used when no cert
	// files are configured. Browsers accept it only through a
	// `serverCertificateHashes` pin, so its hash is published (CertHashes).
	devCert *tls.Certificate
	devHash [sha256.Size]byte
}

// New builds a Listener without binding the socket; call Run() to start serving.
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
	// Generated here, not in Run, so the server can publish the hash in
	// `/zp/api/config` before the first page asks for it.
	if cfg.CertFile == "" && cfg.KeyFile == "" && cfg.AllowInsecureDevCert {
		devCert, err := selfSignedDevCert()
		if err != nil {
			return nil, fmt.Errorf("wtproxy: dev cert gen: %w", err)
		}
		l.devCert = &devCert
		l.devHash = sha256.Sum256(devCert.Certificate[0])
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
		H3:          h3srv,
		CheckOrigin: l.pageOriginAllowed,
	}
	return l, nil
}

// Run blocks until the listener is closed. cert/key paths are taken
// from the Config; if both are empty and AllowInsecureDevCert is set,
// a self-signed ECDSA cert is generated in memory.
func (l *Listener) Run(ctx context.Context) error {
	if l.cfg.CertFile == "" && l.cfg.KeyFile == "" {
		if l.devCert == nil {
			return errors.New("wtproxy: no cert/key configured and AllowInsecureDevCert is false")
		}
		l.srv.H3.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{*l.devCert},
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

// handleUpgrade handles the WebTransport CONNECT request. It reads the target
// URL from `X-ZP-WT-Target` or the `?target=` query parameter, validates the
// target against the allowlist and private-IP policy, dials the upstream
// target, and bridges both sessions until either side closes.
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

	q := r.URL.Query()
	// `pinned=1` means the page passed `serverCertificateHashes` (even if
	// empty or malformed), disabling fallback to standard CA validation.
	pinned := q.Get("pinned") == "1" || len(q["certhash"]) > 0
	pins := parseCertHashes(q["certhash"])
	dialTo, err := l.targetAddr(r.Context(), parsed)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	// Dial the target before accepting the page session so an unreachable
	// target fails the CONNECT handshake and propagates subprotocol selection.
	tlsCfg := &tls.Config{NextProtos: []string{"h3"}, ServerName: parsed.Hostname()}
	if pinned {
		// When the page pins the target by hash, verify the leaf certificate
		// against those hashes instead of system roots or hostname checks.
		tlsCfg.InsecureSkipVerify = true
		tlsCfg.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			return verifyPinned(raw, pins, time.Now())
		}
	}
	// webtransport-go requires EnableDatagrams and EnableStreamResetPartialDelivery
	// on the outbound QUICConfig.
	dialer := &webtransport.Dialer{
		TLSClientConfig: tlsCfg,
		QUICConfig: &quic.Config{
			KeepAlivePeriod:                  25 * time.Second,
			EnableDatagrams:                  true,
			EnableStreamResetPartialDelivery: true,
		},
		// Dial the pre-vetted address directly to prevent DNS rebinding between
		// targetAddr validation and connection establishment.
		DialAddr: func(ctx context.Context, _ string, tc *tls.Config, qc *quic.Config) (*quic.Conn, error) {
			return quic.DialAddrEarly(ctx, dialTo, tc, qc)
		},
	}
	defer dialer.Close()

	reqHdr := http.Header{}
	if p := r.Header.Get("Wt-Available-Protocols"); p != "" {
		reqHdr.Set("Wt-Available-Protocols", p)
	}
	dialCtx, cancelDial := context.WithTimeout(r.Context(), 15*time.Second)
	resp, targetSess, err := dialer.Dial(dialCtx, parsed.String(), reqHdr)
	cancelDial()
	if err != nil {
		l.logger.Printf("wtproxy: target dial %s failed: %v", parsed.String(), err)
		http.Error(w, "target unreachable", http.StatusBadGateway)
		return
	}
	if resp != nil {
		if p := resp.Header.Get("Wt-Protocol"); p != "" {
			w.Header().Set("Wt-Protocol", p)
		}
	}

	clientSess, err := l.srv.Upgrade(w, r)
	if err != nil {
		_ = targetSess.CloseWithError(0, "client upgrade failed")
		l.logger.Printf("wtproxy: client upgrade failed: %v", err)
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
		// Half-close each direction of the bidirectional stream independently so
		// the client can finish reading the target response after sending a
		// request FIN.
		go func() {
			var cwg sync.WaitGroup
			cwg.Add(2)
			go func() { defer cwg.Done(); relayHalf(dstStream, srcStream) }()
			go func() { defer cwg.Done(); relayHalf(srcStream, dstStream) }()
			cwg.Wait()
		}()
	}
}

// relayHalf copies one direction of a bidi stream: FIN on a clean EOF,
// reset (and stop reading the source) on an error.
func relayHalf(dst, src *webtransport.Stream) {
	if _, err := io.Copy(dst, src); err != nil {
		dst.CancelWrite(0)
		src.CancelRead(0)
		return
	}
	_ = dst.Close()
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

// CertHashes returns the base64url SHA-256 of the in-memory dev certificate
// (the `serverCertificateHashes` pin a browser needs to reach this gateway),
// or nil when an operator certificate is configured.
func (l *Listener) CertHashes() []string {
	if l.devCert == nil {
		return nil
	}
	return []string{base64.RawURLEncoding.EncodeToString(l.devHash[:])}
}

// pageOriginAllowed admits the proxy's own pages (see Config.PageHosts) and,
// unless RequireOrigin is true, clients that send no Origin; other sites'
// pages cannot drive the gateway.
func (l *Listener) pageOriginAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return !l.cfg.RequireOrigin
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	for _, h := range l.cfg.PageHosts {
		if strings.EqualFold(h, u.Hostname()) {
			return true
		}
	}
	return false
}

func (l *Listener) admitsPageOrigin(r *http.Request) bool {
	return l.pageOriginAllowed(r)
}

// maxPinnedValidity is the browser's ceiling for a hash-pinned certificate.
const maxPinnedValidity = 14 * 24 * time.Hour

// parseCertHashes decodes the page's `serverCertificateHashes` (SHA-256,
// base64url) that the page-side wrapper moved off the native connection.
// A malformed entry is skipped, not fatal: in the browser it simply never
// matches, and another entry may still pin the certificate.
func parseCertHashes(vals []string) [][]byte {
	var pins [][]byte
	for _, v := range vals {
		b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(v, "="))
		if err != nil || len(b) != sha256.Size {
			continue
		}
		pins = append(pins, b)
	}
	return pins
}

// verifyPinned is the browser's `serverCertificateHashes` rule: the leaf's
// SHA-256 matches a pin, and its validity window is at most two weeks and
// contains now. The pin replaces chain and name verification entirely.
func verifyPinned(raw [][]byte, pins [][]byte, now time.Time) error {
	if len(raw) == 0 {
		return errors.New("wtproxy: target sent no certificate")
	}
	sum := sha256.Sum256(raw[0])
	matched := false
	for _, p := range pins {
		if bytes.Equal(p, sum[:]) {
			matched = true
			break
		}
	}
	if !matched {
		return errors.New("wtproxy: target certificate matches no serverCertificateHashes")
	}
	cert, err := x509.ParseCertificate(raw[0])
	if err != nil {
		return fmt.Errorf("wtproxy: target certificate: %w", err)
	}
	if cert.NotAfter.Sub(cert.NotBefore) > maxPinnedValidity {
		return errors.New("wtproxy: pinned certificate is valid for more than two weeks")
	}
	if now.Before(cert.NotBefore) || now.After(cert.NotAfter) {
		return errors.New("wtproxy: pinned certificate is not currently valid")
	}
	return nil
}

// targetAddr resolves the target once and vets every address it resolves
// to; the dial then goes to that vetted address.
func (l *Listener) targetAddr(ctx context.Context, u *url.URL) (string, error) {
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("target %q does not resolve", host)
	}
	if !l.cfg.AllowPrivateTargets {
		for _, ip := range ips {
			if netguard.IsNonPublic(ip.IP) {
				return "", fmt.Errorf("target %q resolves to a non-public address", host)
			}
		}
	}
	pick := ips[0].IP
	for _, ip := range ips {
		if ip.IP.To4() != nil {
			pick = ip.IP
			break
		}
	}
	return net.JoinHostPort(pick.String(), port), nil
}

// selfSignedDevCert returns an in-memory ECDSA P-256 leaf for local dev.
// Browsers accept a self-signed WebTransport server only through a
// `serverCertificateHashes` pin, and pin only certificates valid for at
// most two weeks (13 days here, non-CA leaf).
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
		NotAfter:     time.Now().Add(13 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "proxy.localhost"},
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

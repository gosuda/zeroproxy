package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"log"
	"math/big"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/fpcapture"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/internal/wtproxy"
	"github.com/gosuda/zeroproxy/internal/yamuxconn"
)

type server struct {
	webDir    string
	socksAddr string
	jarsMu    sync.Mutex
	jars      map[string]*cookiejar.Jar
	// fpStore caches per-peer TLS ClientHello fingerprints captured at
	// handshake time on the HTTPS listener. /zp/api/fp serves them back
	// to the page so the SW can hand the spec to the WASM kernel for
	// browser-mimicking upstream TLS. Nil when no HTTPS listener is up
	// (server-side fingerprint capture is impossible over plain HTTP).
	fpStore *fpcapture.Store
}

// jarFor returns the cookie jar for the given tabId, creating one on demand.
// Empty tabId returns nil — callers should skip jar logic in that case.
func (s *server) jarFor(tabID string) *cookiejar.Jar {
	if tabID == "" {
		return nil
	}
	s.jarsMu.Lock()
	defer s.jarsMu.Unlock()
	if s.jars == nil {
		s.jars = make(map[string]*cookiejar.Jar)
	}
	j, ok := s.jars[tabID]
	if !ok {
		j = cookiejar.New()
		s.jars[tabID] = j
	}
	return j
}

const internalSOCKSMode = "internal"

const (
	controlPrefix = "/zp/"
	assetPrefix   = controlPrefix + "assets/"
)

func main() {
	var addr, tlsAddr string
	s := &server{}
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address (no fingerprint capture)")
	flag.StringVar(&tlsAddr, "tls-addr", "", "Optional HTTPS listen address (e.g. :18443). When set, an in-memory self-signed cert is generated and used; ClientHello fingerprints are captured and served via /zp/api/fp. Browsers will show a security warning on first connect.")
	flag.StringVar(&s.webDir, "web", "dist/web", "built static web asset directory")
	flag.StringVar(&s.socksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address with IsolateSOCKSAuth, or 'internal' for the built-in test SOCKS5 parser/direct dialer")
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	h := securityHeaders(mux)

	// HTTPS listener runs in parallel with HTTP when both are configured.
	// The TLS path is the only one that can capture browser fingerprints
	// (Go's `crypto/tls` invokes `GetConfigForClient` per ClientHello);
	// HTTP traffic is fingerprint-blind, which is the existing
	// dev-loopback behaviour we preserve so this change is opt-in.
	if tlsAddr != "" {
		s.fpStore = fpcapture.NewStore()
		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{mustSelfSignCert()},
			GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
				if chi.Conn != nil {
					s.fpStore.Set(chi.Conn.RemoteAddr().String(), fpcapture.FromClientHello(chi))
				}
				return nil, nil
			},
			NextProtos: []string{"h2", "http/1.1"},
		}
		go func() {
			ln, err := tls.Listen("tcp", tlsAddr, tlsConfig)
			if err != nil {
				log.Fatalf("tls listen: %v", err)
			}
			log.Printf("zeroproxy TLS (self-signed) listening on %s", tlsAddr)
			tlsSrv := &http.Server{Handler: h}
			if err := tlsSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatal(err)
			}
		}()
	}

	log.Printf("zeroproxy listening on %s", addr)
	if err := http.ListenAndServe(addr, h); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// mustSelfSignCert generates a fresh in-memory P-256 self-signed cert
// valid for localhost / proxy.localhost and 127.0.0.1. Browser shows
// an "unknown CA" warning on first navigation — accept once per profile.
// Cert lifetime is 24h; the server is expected to be a short-lived
// dev process. Re-running the binary regenerates a different cert,
// which the browser's HSTS / cert pinning will not care about because
// neither applies to self-signed certs.
func mustSelfSignCert() tls.Certificate {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatalf("certgen: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "zeroproxy-dev"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "proxy.localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		log.Fatalf("certgen: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		log.Fatalf("keymarshal: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		log.Fatalf("x509keypair: %v", err)
	}
	return cert
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/":
		http.Redirect(w, r, controlPrefix, http.StatusFound)
	case path == "/index.html":
		http.Redirect(w, r, controlPrefix, http.StatusFound)
	case path == controlPrefix || path == controlPrefix+"index.html":
		s.serveWeb(w, r, "index.html")
	case path == controlPrefix+"sw.js":
		s.serveWeb(w, r, "sw.js")
	case path == controlPrefix+"api/fp":
		// Phase 4: serve the caller's captured TLS ClientHello spec
		// back as JSON. Lookup is keyed by `r.RemoteAddr` (Go fills it
		// from the underlying conn) so we hand each peer their own
		// fingerprint, not someone else's. SW fetches this on boot,
		// hands the spec to the WASM kernel, kernel passes it through
		// the rustls fork to mirror the user's browser on upstream
		// handshakes. 404 means no capture — either no HTTPS listener,
		// or this request came over plain HTTP, or TTL expired.
		s.serveCapturedFP(w, r)
	case path == controlPrefix+"ws-pipe":
		// Step 14 + yamux: 1 WS = N yamux streams, each = 1 TCP+SOCKS5
		// byte-pipe to the upstream dialer. The Rust WASM kernel speaks
		// yamux (client) + SOCKS5 + TLS + HTTP/1.1 on top, so the relay
		// only sees yamux framing + ciphertext. `handlePipe` calls
		// `yamuxconn.Server()` on the WS and dispatches each accepted
		// stream through `bridgeTargetStream`.
		s.handlePipe(w, r)
	case strings.HasPrefix(path, controlPrefix+"p/"):
		s.serveWeb(w, r, "index.html")
	case strings.HasPrefix(path, controlPrefix+"error/"):
		s.safeError(w, r, strings.TrimPrefix(path, controlPrefix+"error/"), http.StatusBadRequest)
	case strings.HasPrefix(path, assetPrefix):
		s.serveAsset(w, r, strings.TrimPrefix(path, assetPrefix))
	case path == controlPrefix+"worker-bootstrap.js":
		s.workerBootstrap(w, r)
	case strings.HasPrefix(r.URL.Path, "/__zp/__zp/"):
		// Defensive: in case build pipeline emits a double-prefixed path.
		s.safeError(w, r, "MALFORMED_ROUTE", http.StatusBadRequest)
	case r.URL.Path == "/__zp/zp_bundle.js" || r.URL.Path == "/__zp/zp_bundle_bg.wasm" ||
		r.URL.Path == "/__zp/zp_bundle_sw.js" || r.URL.Path == "/__zp/zp_bundle_sw_bg.wasm" ||
		r.URL.Path == "/__zp/zp_page_rt.wasm":
		// Rust zp-bundle artifacts produced by wasm-bindgen (web/ + no-modules
		// flavors). The build copies them under dist/web/__zp/ but the runtime
		// fetches them from /__zp/<name>; serve from that nested path.
		s.serveFile(w, r, filepath.Join(s.webDir, "__zp", filepath.Base(r.URL.Path)), mime.TypeByExtension(filepath.Ext(r.URL.Path)))
	case strings.HasPrefix(r.URL.Path, "/__zp/wt"):
		// D4: WebTransport gateway endpoint (placeholder until HTTP/3 + quic-go land).
		wtproxy.Handler().ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, "/__zp/rtc/"):
		// D5: WebRTC signaling endpoint (placeholder until pion SFU lands).
		rtcgw.Handler().ServeHTTP(w, r)
	case strings.HasPrefix(path, "/p/"):
		redirectLegacy(w, r, controlPrefix+"p/"+strings.TrimPrefix(path, "/p/"))
	case strings.HasPrefix(path, "/__zp/"):
		s.legacyZP(w, r)
	case path == "/sw.js":
		redirectLegacy(w, r, controlPrefix+"sw.js")
	default:
		s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
	}
}

func redirectLegacy(w http.ResponseWriter, r *http.Request, nextPath string) {
	u := *r.URL
	u.Path = nextPath
	http.Redirect(w, r, u.String(), http.StatusTemporaryRedirect)
}

func (s *server) legacyZP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/__zp/ws-pipe":
		redirectLegacy(w, r, controlPrefix+"ws-pipe")
	case "/__zp/worker-bootstrap.js":
		redirectLegacy(w, r, controlPrefix+"worker-bootstrap.js")
	default:
		if strings.HasPrefix(r.URL.Path, "/__zp/error/") {
			redirectLegacy(w, r, controlPrefix+"error/"+strings.TrimPrefix(r.URL.Path, "/__zp/error/"))
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/__zp/")
		switch name {
		case "zp-core.js", "runtime-prelude.js", "rust-rewriter.js", "worker-prelude.js":
			redirectLegacy(w, r, assetPrefix+name)
		default:
			s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
		}
	}
}

func (s *server) serveWeb(w http.ResponseWriter, r *http.Request, name string) {
	s.serveFile(w, r, filepath.Join(s.webDir, name), mime.TypeByExtension(filepath.Ext(name)))
}

// serveCapturedFP hands back the caller's own TLS fingerprint as JSON.
// The store is keyed on remote address (host:port), which `r.RemoteAddr`
// reflects per-connection. Returns 404 with `{"captured":false}` when:
//   - server was started without `-tls-addr` (no store at all), or
//   - this particular request arrived over plain HTTP (no handshake to
//     capture), or
//   - the entry already aged out of the store (10 min TTL).
//
// The 404+JSON shape (rather than empty 404) keeps the SW's fetch logic
// branch-free: parse the body, check `captured`, fall through to the
// hardcoded Chrome 134 fallback in the rustls fork if missing.
func (s *server) serveCapturedFP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// CORS open: the SW runs on the HTTP origin (proxy.localhost:18080)
	// but calls this endpoint cross-origin against the HTTPS port so
	// the browser actually performs a TLS handshake we can capture.
	// `Origin: *` is safe — the endpoint reveals nothing the caller's
	// own connection didn't already determine, and there's no
	// credential reflection (we don't read cookies or auth headers).
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET")
	w.Header().Set("Access-Control-Max-Age", "600")
	if s.fpStore == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"captured":false,"reason":"no-tls-listener"}`))
		return
	}
	spec, ok := s.fpStore.Get(r.RemoteAddr)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"captured":false,"reason":"no-entry-or-expired"}`))
		return
	}
	// Encode envelope so the SW can tell capture-failure apart from a
	// genuine empty spec (which shouldn't happen, but be defensive).
	body := fmt.Sprintf(`{"captured":true,"spec":%q}`, spec.EncodeBase64())
	_, _ = io.WriteString(w, body)
}

func (s *server) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	switch name {
	case "zp-core.js", "runtime-prelude.js", "rust-rewriter.js", "worker-prelude.js", "favicon.ico", "manifest.webmanifest":
		s.serveWeb(w, r, name)
	default:
		s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
	}
}

func (s *server) serveFile(w http.ResponseWriter, r *http.Request, path, contentType string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		s.safeError(w, r, "SW_NOT_READY", http.StatusServiceUnavailable)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		s.safeError(w, r, "SW_NOT_READY", http.StatusServiceUnavailable)
		return
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (s *server) workerBootstrap(w http.ResponseWriter, r *http.Request) {
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, body)
}

func (s *server) safeError(w http.ResponseWriter, r *http.Request, code string, status int) {
	escapedCode := html.EscapeString(sanitizeCode(code))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", zeroCSP(r))
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>ZeroProxy %s</title><main><h1>ZeroProxy</h1><p>%s</p><button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>`, escapedCode, escapedCode)
}

func sanitizeCode(code string) string {
	code = strings.TrimSpace(code)
	switch code {
	case "BAD_HMAC", "INVALID_SHARE_LINK", "MALFORMED_ROUTE", "SW_NOT_READY", "TARGET_PROTOCOL_BLOCKED", "TLS_CERTIFICATE_INVALID", "TLS_HANDSHAKE_FAILED", "TARGET_CONNECT_FAILED", "MALFORMED_HTML", "REALM_INJECTION_FAILURE", "REQUEST_BODY_TOO_LARGE", "POLICY_BLOCKED":
		return code
	}
	return "POLICY_BLOCKED"
}

func (s *server) handlePipe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	c, err := pipeUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := newWebSocketNetConn(c)
	defer conn.Close()
	sess, err := yamuxconn.Server(conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	s.acceptStreams(r.Context(), sess)
}

var pipeUpgrader = websocket.Upgrader{
	EnableCompression: false,
}

type webSocketNetConn struct {
	ws       *websocket.Conn
	readMu   sync.Mutex
	writeMu  sync.Mutex
	reader   io.Reader
	local    net.Addr
	remote   net.Addr
	closeMux sync.Once
}

func newWebSocketNetConn(ws *websocket.Conn) *webSocketNetConn {
	var local, remote net.Addr = addr("websocket-local"), addr("websocket-remote")
	if c := ws.UnderlyingConn(); c != nil {
		local = c.LocalAddr()
		remote = c.RemoteAddr()
	}
	return &webSocketNetConn{ws: ws, local: local, remote: remote}
}

func (c *webSocketNetConn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for {
		if c.reader != nil {
			n, err := c.reader.Read(p)
			if n > 0 || (err != nil && err != io.EOF) {
				return n, err
			}
			c.reader = nil
		}
		messageType, r, err := c.ws.NextReader()
		if err != nil {
			return 0, err
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		c.reader = r
	}
}

func (c *webSocketNetConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *webSocketNetConn) Close() error {
	var err error
	c.closeMux.Do(func() {
		err = c.ws.Close()
	})
	return err
}

func (c *webSocketNetConn) LocalAddr() net.Addr  { return c.local }
func (c *webSocketNetConn) RemoteAddr() net.Addr { return c.remote }
func (c *webSocketNetConn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}
func (c *webSocketNetConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *webSocketNetConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

type addr string

func (a addr) Network() string { return "websocket" }
func (a addr) String() string  { return string(a) }

func (s *server) acceptStreams(ctx context.Context, sess *yamuxconn.Session) {
	defer sess.Close()
	for {
		stream, err := sess.Accept(ctx)
		if err != nil {
			return
		}
		go s.bridgeTargetStream(ctx, stream)
	}
}

func (s *server) bridgeTargetStream(ctx context.Context, stream net.Conn) {
	if strings.EqualFold(strings.TrimSpace(s.socksAddr), internalSOCKSMode) {
		s.bridgeInternalSOCKS(ctx, stream)
		return
	}
	s.bridgeToTor(ctx, stream)
}

func (s *server) bridgeInternalSOCKS(ctx context.Context, stream net.Conn) {
	defer stream.Close()
	stopDeadline := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = stream.SetDeadline(time.Now())
		case <-stopDeadline:
		}
	}()
	host, port, err := readSOCKS5Connect(ctx, stream)
	close(stopDeadline)
	if err != nil {
		return
	}
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	target, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		_, _ = stream.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	if _, err := stream.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		_ = target.Close()
		return
	}
	bridgeConns(ctx, stream, target)
}

func readSOCKS5Connect(ctx context.Context, rw net.Conn) (string, string, error) {
	var head [2]byte
	if err := readFull(ctx, rw, head[:]); err != nil {
		return "", "", err
	}
	if head[0] != 0x05 || head[1] == 0 {
		return "", "", fmt.Errorf("invalid SOCKS5 greeting")
	}
	methods := make([]byte, int(head[1]))
	if err := readFull(ctx, rw, methods); err != nil {
		return "", "", err
	}
	method := byte(0xff)
	for _, m := range methods {
		if m == 0x02 {
			method = 0x02
			break
		}
		if m == 0x00 {
			method = 0x00
		}
	}
	if _, err := rw.Write([]byte{0x05, method}); err != nil {
		return "", "", err
	}
	if method == 0xff {
		return "", "", fmt.Errorf("no acceptable SOCKS5 auth method")
	}
	if method == 0x02 {
		if err := acceptSOCKS5UserPass(ctx, rw); err != nil {
			return "", "", err
		}
	}
	var req [4]byte
	if err := readFull(ctx, rw, req[:]); err != nil {
		return "", "", err
	}
	if req[0] != 0x05 || req[1] != 0x01 || req[2] != 0x00 {
		return "", "", fmt.Errorf("unsupported SOCKS5 request")
	}
	host, err := readSOCKS5Address(ctx, rw, req[3])
	if err != nil {
		return "", "", err
	}
	var portBuf [2]byte
	if err := readFull(ctx, rw, portBuf[:]); err != nil {
		return "", "", err
	}
	port := binary.BigEndian.Uint16(portBuf[:])
	if port == 0 {
		return "", "", fmt.Errorf("invalid SOCKS5 port")
	}
	return host, fmt.Sprint(port), nil
}

func acceptSOCKS5UserPass(ctx context.Context, rw net.Conn) error {
	var head [2]byte
	if err := readFull(ctx, rw, head[:]); err != nil {
		return err
	}
	if head[0] != 0x01 {
		_, _ = rw.Write([]byte{0x01, 0x01})
		return fmt.Errorf("invalid SOCKS5 auth version")
	}
	user := make([]byte, int(head[1]))
	if err := readFull(ctx, rw, user); err != nil {
		return err
	}
	var passLen [1]byte
	if err := readFull(ctx, rw, passLen[:]); err != nil {
		return err
	}
	pass := make([]byte, int(passLen[0]))
	if err := readFull(ctx, rw, pass); err != nil {
		return err
	}
	_, err := rw.Write([]byte{0x01, 0x00})
	return err
}

func readSOCKS5Address(ctx context.Context, rw net.Conn, atyp byte) (string, error) {
	switch atyp {
	case 0x01:
		var ip [4]byte
		if err := readFull(ctx, rw, ip[:]); err != nil {
			return "", err
		}
		return net.IP(ip[:]).String(), nil
	case 0x03:
		var n [1]byte
		if err := readFull(ctx, rw, n[:]); err != nil {
			return "", err
		}
		if n[0] == 0 {
			return "", fmt.Errorf("empty SOCKS5 domain")
		}
		host := make([]byte, int(n[0]))
		if err := readFull(ctx, rw, host); err != nil {
			return "", err
		}
		return string(host), nil
	case 0x04:
		var ip [16]byte
		if err := readFull(ctx, rw, ip[:]); err != nil {
			return "", err
		}
		return net.IP(ip[:]).String(), nil
	default:
		return "", fmt.Errorf("unsupported SOCKS5 address type")
	}
}

func readFull(ctx context.Context, r io.Reader, p []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := io.ReadFull(r, p)
	if err != nil {
		return err
	}
	return ctx.Err()
}

func (s *server) bridgeToTor(ctx context.Context, stream net.Conn) {
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	tor, err := d.DialContext(ctx, "tcp", s.socksAddr)
	if err != nil {
		_ = stream.Close()
		return
	}
	bridgeConns(ctx, stream, tor)
}

func bridgeConns(ctx context.Context, a, b net.Conn) {
	closeBoth := func() {
		_ = a.Close()
		_ = b.Close()
	}
	defer closeBoth()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(b, a); closeBoth(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(a, b); closeBoth(); done <- struct{}{} }()
	select {
	case <-ctx.Done():
		closeBoth()
		return
	case <-done:
		return
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", zeroCSP(r))
		next.ServeHTTP(w, r)
	})
}

func zeroCSP(r *http.Request) string {
	wsScheme := "ws://"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		wsScheme = "wss://"
	}
	host := r.Host
	if host == "" {
		host = "proxy.example"
	}
	return headers.BuildCSP(wsScheme + host)
}

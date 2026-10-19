// Package httphost implements the ZeroProxy HTTP host: static asset serving,
// /zp/* routing, the WebSocket byte-pipe bridge (ws-pipe over yamux to SOCKS5),
// the synchronous XHR hub, and CSP violation reporting.
// Callers mount NewHandler(Config) on their own HTTP listener or mux and
// manage optional WebTransport and TURN gateway listeners separately.
package httphost

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/netguard"
	"github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/internal/wtproxy"
	"github.com/gosuda/zeroproxy/internal/yamuxconn"
)

// TransportMode selects how the relay bridges outbound streams.
type TransportMode uint8

const (
	// TransportAuto infers the transport mode from Config.SocksAddr: "internal"
	// dials directly (permitting private targets unless DisallowPrivateTargets
	// is set), "direct" dials directly (blocking private targets unless
	// AllowPrivateTargets is set), and a host:port address dials an upstream
	// SOCKS5 proxy.
	TransportAuto TransportMode = iota
	// TransportSOCKS5 bridges yamux streams to an upstream SOCKS5 proxy at
	// Config.SocksAddr (such as a Tor client listener).
	TransportSOCKS5
	// TransportDirect terminates the inner SOCKS5 handshake in-process and
	// dials resolved target addresses directly over TCP. Non-public target IPs
	// are rejected unless Config.AllowPrivateTargets is true.
	TransportDirect
)

// Config holds the parameters for NewServer and NewHandler.
type Config struct {
	WebDir string // built static web asset directory (dist/web)
	// Transport selects the outbound relay mode. When left at TransportAuto,
	// the mode is inferred from SocksAddr.
	Transport    TransportMode
	SocksAddr    string // upstream SOCKS5 host:port, "internal", or "direct"
	WtGatewayURL string // public WT gateway URL the page reads; empty hides it
	// WtGatewayCertHashes pins a self-signed dev gateway certificate
	// (base64url SHA-256). Nil for an operator certificate that the browser
	// validates normally.
	WtGatewayCertHashes []string
	// RtcTURN is the embedded TURN server for relay-only WebRTC.
	RtcTURN *rtcgw.TURNServer
	// AllowPrivateTargets permits loopback and RFC 1918 private target IPs when
	// dialing directly (TransportDirect). Link-local and unspecified addresses
	// remain blocked regardless of this setting.
	AllowPrivateTargets bool
	// DisallowPrivateTargets rejects private, loopback, and non-public target
	// IPs even when SocksAddr is set to the legacy "internal" mode.
	DisallowPrivateTargets bool
	// TrustProxyHeaders trusts X-Forwarded-Proto from non-loopback peers.
	TrustProxyHeaders bool
}

// Server implements the ZeroProxy HTTP host and manages active relay sessions
// and the synchronous XHR hub. Callers should invoke Close on shutdown to
// terminate open yamux sessions and unblock parked sync-fetch requests.
type Server struct {
	webDir                 string
	transport              TransportMode
	socksAddr              string
	wtGatewayURL           string
	wtCertHashes           []string
	rtcTURN                *rtcgw.TURNServer
	allowPrivateTargets    bool
	disallowPrivateTargets bool
	trustProxyHeaders      bool
	syncHub                *syncFetchHub
	handler                http.Handler

	mu        sync.Mutex
	sessions  map[*yamuxconn.Session]struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

type server = Server

// NewServer validates cfg and constructs a Server ready to serve HTTP requests.
func NewServer(cfg Config) (*Server, error) {
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}
	return newUncheckedServer(cfg), nil
}

func validateConfig(cfg Config) error {
	socks := strings.TrimSpace(cfg.SocksAddr)
	switch cfg.Transport {
	case TransportAuto:
		if socks != "" && !strings.EqualFold(socks, internalSOCKSMode) && !strings.EqualFold(socks, directSOCKSMode) {
			if _, _, err := net.SplitHostPort(socks); err != nil {
				return fmt.Errorf("httphost: invalid SocksAddr %q: %w", cfg.SocksAddr, err)
			}
		}
	case TransportSOCKS5:
		if socks == "" || strings.EqualFold(socks, internalSOCKSMode) || strings.EqualFold(socks, directSOCKSMode) {
			return fmt.Errorf("httphost: TransportSOCKS5 requires a host:port SocksAddr, got %q", cfg.SocksAddr)
		}
		if _, _, err := net.SplitHostPort(socks); err != nil {
			return fmt.Errorf("httphost: invalid SocksAddr %q: %w", cfg.SocksAddr, err)
		}
	case TransportDirect:
		if socks != "" && !strings.EqualFold(socks, internalSOCKSMode) && !strings.EqualFold(socks, directSOCKSMode) {
			return fmt.Errorf("httphost: TransportDirect cannot be combined with upstream SocksAddr %q", cfg.SocksAddr)
		}
	default:
		return fmt.Errorf("httphost: unknown TransportMode %d", cfg.Transport)
	}
	return nil
}

func newUncheckedServer(cfg Config) *Server {
	s := &Server{
		webDir:                 cfg.WebDir,
		transport:              cfg.Transport,
		socksAddr:              cfg.SocksAddr,
		wtGatewayURL:           cfg.WtGatewayURL,
		wtCertHashes:           cfg.WtGatewayCertHashes,
		rtcTURN:                cfg.RtcTURN,
		allowPrivateTargets:    cfg.AllowPrivateTargets,
		disallowPrivateTargets: cfg.DisallowPrivateTargets,
		trustProxyHeaders:      cfg.TrustProxyHeaders,
		syncHub:                newSyncFetchHub(),
		sessions:               make(map[*yamuxconn.Session]struct{}),
		closed:                 make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	s.handler = s.securityHeaders(mux)
	return s
}

// NewHandler builds the ZeroProxy HTTP handler: static assets, /zp/*
// routes, ws-pipe bridge, sync-fetch hub, and CSP report wrapped in the
// security-headers middleware. The returned http.Handler is a *Server and
// also implements io.Closer.
func NewHandler(cfg Config) http.Handler {
	return newUncheckedServer(cfg)
}

// ServeHTTP dispatches requests through the security-headers middleware and
// host route mux.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.handler != nil {
		s.handler.ServeHTTP(w, r)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	s.securityHeaders(mux).ServeHTTP(w, r)
}

// Close shuts down the synchronous XHR hub and closes all active yamux relay
// sessions. Safe for concurrent and repeated calls.
func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		if s.closed != nil {
			close(s.closed)
		}
	})
	if s.syncHub != nil {
		s.syncHub.close()
	}
	s.mu.Lock()
	sessions := make([]*yamuxconn.Session, 0, len(s.sessions))
	for sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	s.sessions = nil
	s.mu.Unlock()
	for _, sess := range sessions {
		_ = sess.Close()
	}
	return nil
}

const (
	internalSOCKSMode = "internal"
	directSOCKSMode   = "direct"
)

const (
	controlPrefix = "/zp/"
	assetPrefix   = controlPrefix + "assets/"
)

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
	case path == controlPrefix+"ws-pipe":
		// Multiplexes yamux streams over a single WebSocket, bridging each
		// stream to a TCP+SOCKS5 connection to the upstream dialer. The Rust
		// WASM kernel runs yamux (client), SOCKS5, TLS, and HTTP on top, so
		// the relay observes only yamux framing and TLS ciphertext.
		s.handlePipe(w, r)
	case strings.HasPrefix(path, controlPrefix+"p/"):
		s.serveWeb(w, r, "index.html")
	case strings.HasPrefix(path, controlPrefix+"error/"):
		s.safeError(w, r, strings.TrimPrefix(path, controlPrefix+"error/"), http.StatusBadRequest)
	case strings.HasPrefix(path, assetPrefix):
		s.serveAsset(w, r, strings.TrimPrefix(path, assetPrefix))
	case path == controlPrefix+"worker-bootstrap.js":
		s.workerBootstrap(w, r)
	case path == controlPrefix+"api/sync-fetch":
		// Synchronous XHR relay: because Service Workers cannot intercept
		// synchronous XHR, pages send requests to this same-origin endpoint
		// and Go delegates fulfillment to the Service Worker.
		s.handleSyncFetch(w, r)
	case path == controlPrefix+"api/sync-fetch/poll":
		s.handleSyncFetchPoll(w, r)
	case path == controlPrefix+"api/sync-fetch/result":
		s.handleSyncFetchResult(w, r)
	case path == controlPrefix+"api/csp-report":
		// Receives CSP report-uri payloads for requests blocked before reaching
		// the Service Worker.
		s.handleCSPReport(w, r)
	case path == controlPrefix+"api/config":
		// Client runtime configuration: public WebTransport gateway URL, dev-cert
		// pin, and fresh TURN credentials. The Service Worker reads this per
		// navigation and passes it into the page realm boot JSON.
		s.serveConfig(w, r)
	case path == controlPrefix+"api/rtc/signal":
		// WebRTC runs relay-only through the embedded TURN server without
		// custom signaling; this route returns 501 RTC_GATEWAY_UNAVAILABLE.
		rtcgw.Handler().ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, "/__zp/__zp/"):
		// Defensive: in case build pipeline emits a double-prefixed path.
		s.safeError(w, r, "MALFORMED_ROUTE", http.StatusBadRequest)
	case r.URL.Path == "/__zp/zp_bundle_sw.js" || r.URL.Path == "/__zp/zp_bundle_sw_bg.wasm" ||
		r.URL.Path == "/__zp/zp_kernel_sw.js" || r.URL.Path == "/__zp/zp_kernel_sw_bg.wasm" ||
		r.URL.Path == "/__zp/zp_page_bundle.js" || r.URL.Path == "/__zp/zp_page_bundle_bg.wasm" ||
		r.URL.Path == "/__zp/zp_page_rt.wasm":
		// Rust zp-bundle artifacts produced by wasm-bindgen (web/ + no-modules
		// flavors). The build copies them under dist/web/__zp/ but the runtime
		// fetches them from /__zp/<name>; serve from that nested path.
		s.serveFile(w, r, filepath.Join(s.webDir, "__zp", filepath.Base(r.URL.Path)), mime.TypeByExtension(filepath.Ext(r.URL.Path)))
	case strings.HasPrefix(r.URL.Path, "/__zp/wt"):
		// The WebTransport gateway listens on a separate UDP port (-wt-addr)
		// speaking HTTP/3. Any /__zp/wt request arriving on this TCP listener
		// receives 501 WT_UNSUPPORTED.
		wtproxy.Handler().ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, "/__zp/rtc/"):
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
		case "zp-core.js", "runtime-prelude.js", "worker-prelude.js", "zp-page-bundle.js":
			redirectLegacy(w, r, assetPrefix+name)
		default:
			s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
		}
	}
}

func (s *server) serveWeb(w http.ResponseWriter, r *http.Request, name string) {
	s.serveFile(w, r, filepath.Join(s.webDir, name), mime.TypeByExtension(filepath.Ext(name)))
}

func (s *server) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	switch name {
	case "zp-core.js", "runtime-prelude.js", "worker-prelude.js", "zp-page-bundle.js", "favicon.ico", "manifest.webmanifest":
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
	// Keep sw.js and index.html uncached (no-store) so Service Worker updates
	// propagate immediately. Static assets versioned with ?v=<build id> are
	// content-hashed and cached as immutable for 1 year; unversioned assets use
	// no-cache to allow disk caching with If-Modified-Since (304) revalidation.
	switch name := st.Name(); {
	case name == "sw.js" || name == "index.html":
		w.Header().Set("Cache-Control", "no-store")
	case r.URL.Query().Get("v") != "":
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (s *server) workerBootstrap(w http.ResponseWriter, r *http.Request) {
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, body)
}

// serveConfig emits the client-facing runtime config read by the Service Worker
// on boot (wtGateway, wtGatewayCertHashes, and rtcICEServers).
//
// `rtcICEServers` contains a fresh time-limited credential tuple from the
// embedded TURN server when -rtc-turn-addr is configured. Without embedded
// TURN, the field is `[]`.
func (s *server) serveConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	iceServers := []rtcgw.ICEServerCred{}
	if s.rtcTURN != nil {
		if cred, err := s.rtcTURN.IssueICEServerCreds(""); err == nil {
			iceServers = append(iceServers, cred)
		}
	}
	hashes := s.wtCertHashes
	if hashes == nil {
		hashes = []string{}
	}
	_ = json.NewEncoder(w).Encode(struct {
		WtGateway           string                `json:"wtGateway"`
		WtGatewayCertHashes []string              `json:"wtGatewayCertHashes"`
		RtcICEServers       []rtcgw.ICEServerCred `json:"rtcICEServers"`
	}{s.wtGatewayURL, hashes, iceServers})
}

func (s *server) safeError(w http.ResponseWriter, r *http.Request, code string, status int) {
	escapedCode := html.EscapeString(sanitizeCode(code))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", s.zeroCSP(r))
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>ZeroProxy %s</title><main><h1>ZeroProxy</h1><p>%s</p><button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>`, escapedCode, escapedCode)
}

func sanitizeCode(code string) string {
	code = strings.TrimSpace(code)
	switch code {
	case "BAD_HMAC", "INVALID_SHARE_LINK", "MALFORMED_ROUTE", "SW_NOT_READY",
		"TARGET_PROTOCOL_BLOCKED", "TLS_CERTIFICATE_INVALID", "TLS_HANDSHAKE_FAILED",
		"TARGET_CONNECT_FAILED", "TARGET_HTTP_FAILED", "MALFORMED_HTML", "REALM_INJECTION_FAILURE",
		"REQUEST_BODY_TOO_LARGE", "SUBMISSION_EXPIRED", "POLICY_BLOCKED",
		"REWRITE_FAILED", "SCRIPT_SRC_BLOCKED", "REDIRECT_BODY_NONREPLAYABLE", "REDIRECT_LIMIT_EXCEEDED",
		"WS_BLOCKED", "RTC_GATEWAY_UNAVAILABLE", "WT_UNSUPPORTED":
		return code
	}
	return "POLICY_BLOCKED"
}

func (s *server) isAllowedOrigin(r *http.Request) bool {
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || !strings.EqualFold(u.Host, r.Host) {
			return false
		}
	}
	if sfs := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")); sfs != "" {
		if sfs != "same-origin" && sfs != "none" {
			return false
		}
	}
	return true
}

func (s *server) handlePipe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	upgrader := websocket.Upgrader{
		EnableCompression: false,
		CheckOrigin:       s.isAllowedOrigin,
	}
	c, err := upgrader.Upgrade(w, r, nil)
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

const (
	maxConcurrentStreamsPerSession = 256
	streamSlotAcquireTimeout       = 5 * time.Second
	bridgeIdleTimeout              = 2 * time.Minute
)

func (s *server) acceptStreams(ctx context.Context, sess *yamuxconn.Session) {
	defer sess.Close()
	if s.closed != nil {
		select {
		case <-s.closed:
			return
		default:
		}
	}
	s.mu.Lock()
	if s.sessions != nil {
		s.sessions[sess] = struct{}{}
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.sessions != nil {
			delete(s.sessions, sess)
		}
		s.mu.Unlock()
	}()
	sem := make(chan struct{}, maxConcurrentStreamsPerSession)
	for {
		stream, err := sess.Accept(ctx)
		if err != nil {
			return
		}
		select {
		case sem <- struct{}{}:
		default:
			timer := time.NewTimer(streamSlotAcquireTimeout)
			select {
			case sem <- struct{}{}:
				timer.Stop()
			case <-timer.C:
				_ = stream.Close()
				continue
			case <-ctx.Done():
				timer.Stop()
				_ = stream.Close()
				return
			}
		}
		go func(c net.Conn) {
			defer func() { <-sem }()
			s.bridgeTargetStream(ctx, c)
		}(stream)
	}
}

func (s *server) isDirectTransport() bool {
	if s.transport == TransportDirect {
		return true
	}
	if s.transport == TransportSOCKS5 {
		return false
	}
	mode := strings.ToLower(strings.TrimSpace(s.socksAddr))
	return mode == internalSOCKSMode || mode == directSOCKSMode
}

func (s *server) disallowsPrivateTargets() bool {
	if s.disallowPrivateTargets {
		return true
	}
	if s.allowPrivateTargets {
		return false
	}
	return s.transport == TransportDirect || strings.EqualFold(strings.TrimSpace(s.socksAddr), directSOCKSMode)
}

func (s *server) bridgeTargetStream(ctx context.Context, stream net.Conn) {
	if s.isDirectTransport() {
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
	dialAddr, err := s.resolveInternalTarget(ctx, host, port)
	if err != nil {
		_, _ = stream.Write([]byte{0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	target, err := d.DialContext(ctx, "tcp", dialAddr)
	if err != nil {
		_, _ = stream.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	if _, err := stream.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		_ = target.Close()
		return
	}
	a, b := traceBridge(stream, target, host)
	bridgeConns(ctx, a, b)
}

func (s *server) resolveInternalTarget(ctx context.Context, host, port string) (string, error) {
	disallowPrivate := s.disallowsPrivateTargets()
	var ips []net.IPAddr
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IPAddr{{IP: ip}}
	} else {
		lookupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		resolved, err := net.DefaultResolver.LookupIPAddr(lookupCtx, host)
		if err != nil || len(resolved) == 0 {
			return "", fmt.Errorf("target %q does not resolve", host)
		}
		ips = resolved
	}
	for _, entry := range ips {
		ip := entry.IP
		if len(ip) == 0 || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
			return "", fmt.Errorf("target %q resolves to a blocked address", host)
		}
		if disallowPrivate && netguard.IsNonPublic(ip) {
			return "", fmt.Errorf("target %q resolves to a non-public address", host)
		}
	}
	pick := ips[0].IP
	for _, entry := range ips {
		if entry.IP.To4() != nil {
			pick = entry.IP
			break
		}
	}
	return net.JoinHostPort(pick.String(), port), nil
}

// traceBridge optionally wraps both ends of a bridged stream so each
// direction's read timeline is logged when ZP_BRIDGE_TRACE is set.
// c2u (browser to upstream) logs request bytes leaving the browser;
// u2c (upstream to browser) logs the response.
func traceBridge(stream, target net.Conn, host string) (net.Conn, net.Conn) {
	if os.Getenv("ZP_BRIDGE_TRACE") == "" {
		return stream, target
	}
	start := time.Now()
	return &traceConn{Conn: stream, label: "c2u host=" + host, start: start},
		&traceConn{Conn: target, label: "u2c host=" + host, start: start}
}

// traceConn logs the first read and any read preceded by a >2s gap, so the
// stall boundary (and which direction stalled) is visible without flooding
// the log with every TLS record.
type traceConn struct {
	net.Conn
	label string
	start time.Time
	mu    sync.Mutex
	last  time.Time
	total int64
	reads int
}

func (t *traceConn) Read(p []byte) (int, error) {
	n, err := t.Conn.Read(p)
	t.mu.Lock()
	now := time.Now()
	var gap time.Duration
	if !t.last.IsZero() {
		gap = now.Sub(t.last)
	}
	since := now.Sub(t.start)
	t.last = now
	t.total += int64(n)
	t.reads++
	first := t.reads == 1
	t.mu.Unlock()
	if first || gap > 2*time.Second {
		log.Printf("ZPBRIDGE %s +%dms read=%dB gap=%dms total=%d reads=%d err=%v",
			t.label, since.Milliseconds(), n, gap.Milliseconds(), t.total, t.reads, err)
	}
	return n, err
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

type idleDeadlineConn struct {
	net.Conn
	peer    net.Conn
	timeout time.Duration
}

func (c *idleDeadlineConn) touch() {
	if c.timeout <= 0 {
		return
	}
	deadline := time.Now().Add(c.timeout)
	_ = c.Conn.SetDeadline(deadline)
	if c.peer != nil {
		_ = c.peer.SetDeadline(deadline)
	}
}

func (c *idleDeadlineConn) Read(p []byte) (int, error) {
	c.touch()
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c *idleDeadlineConn) Write(p []byte) (int, error) {
	c.touch()
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func bridgeConns(ctx context.Context, a, b net.Conn) {
	closeBoth := func() {
		_ = a.Close()
		_ = b.Close()
	}
	defer closeBoth()
	wa := &idleDeadlineConn{Conn: a, peer: b, timeout: bridgeIdleTimeout}
	wb := &idleDeadlineConn{Conn: b, peer: a, timeout: bridgeIdleTimeout}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(wb, wa); closeBoth(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(wa, wb); closeBoth(); done <- struct{}{} }()
	select {
	case <-ctx.Done():
		closeBoth()
		return
	case <-done:
		return
	}
}

func (s *server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", s.responseCSP(r))
		if isSiteFrameBootstrap(r) {
			// A page whose own policy demands cross-origin isolation can embed only frames that opt in on both counts.
			w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		}
		next.ServeHTTP(w, r)
	})
}

// responseCSP is zeroCSP, except that the page which boots a site frame's worker (a share route requested for an iframe on a
// loopback host) may be embedded by pages of this proxy at other `*.localhost` hosts. Every other response stays unframeable.
func (s *server) responseCSP(r *http.Request) string {
	csp := s.zeroCSP(r)
	if isSiteFrameBootstrap(r) {
		if src := siteFrameSource(r); src != "" {
			csp = strings.Replace(csp, "frame-ancestors 'none'", "frame-ancestors "+src, 1)
		}
	}
	return csp
}

// isSiteFrameBootstrap reports a share route requested for an iframe on a loopback name: the first response of a site frame, before
// its worker exists.
func isSiteFrameBootstrap(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/zp/p/") && strings.EqualFold(r.Header.Get("Sec-Fetch-Dest"), "iframe") && siteFrameSource(r) != ""
}

// siteFrameSource is the CSP source matching every `<label>.localhost` host on the request's port, or "" when the request did not
// arrive on a loopback name.
func siteFrameSource(r *http.Request) string {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		host, port = r.Host, ""
	}
	host = strings.ToLower(host)
	if host != "localhost" && !strings.HasSuffix(host, ".localhost") {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	src := scheme + "://*.localhost"
	if port != "" {
		src += ":" + port
	}
	return src
}

func (s *server) zeroCSP(r *http.Request) string {
	wsScheme := "ws://"
	if r.TLS != nil || (s.trustForwardedProto(r) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")) {
		wsScheme = "wss://"
	}
	host := r.Host
	if host == "" {
		host = "proxy.example"
	}
	return headers.BuildCSP(wsScheme + host)
}

func (s *server) trustForwardedProto(r *http.Request) bool {
	if s.trustProxyHeaders {
		return true
	}
	remote := strings.TrimSpace(r.RemoteAddr)
	if remote == "" {
		return true
	}
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	if i := strings.IndexByte(remote, '%'); i >= 0 {
		remote = remote[:i]
	}
	ip := net.ParseIP(strings.Trim(remote, "[]"))
	return ip != nil && ip.IsLoopback()
}

func zeroCSP(r *http.Request) string {
	return (&server{}).zeroCSP(r)
}

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gosuda/zeroproxy/internal/yamuxconn"
)

type server struct {
	webDir     string
	kernelWASM string
	socksAddr  string
}

const internalSOCKSMode = "internal"

const (
	controlPrefix = "/zp/"
	assetPrefix   = controlPrefix + "assets/"
)

var emptyFaviconPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
	0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
	0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb, 0x00, 0x00, 0x00, 0x00,
	0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func main() {
	var addr string
	s := &server{}
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&s.webDir, "web", "dist/web", "built static web asset directory")
	flag.StringVar(&s.kernelWASM, "kernel", "dist/kernel.wasm", "compiled Go WASM kernel path")
	flag.StringVar(&s.socksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address with IsolateSOCKSAuth, or 'internal' for the built-in test SOCKS5 parser/direct dialer")
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	h := securityHeaders(mux)
	log.Printf("zeroproxy listening on %s", addr)
	if err := http.ListenAndServe(addr, h); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type routeHandler func(s *server, w http.ResponseWriter, r *http.Request)

// route pairs a path matcher with its handler. prefix==false means an exact
// path match; prefix==true means a strings.HasPrefix match.
type route struct {
	pat     string
	prefix  bool
	handler routeHandler
}

func (rt route) matches(path string) bool {
	if rt.prefix {
		return strings.HasPrefix(path, rt.pat)
	}
	return path == rt.pat
}

// routes is evaluated in order; the first matching entry wins and the rest are
// skipped, exactly mirroring the top-to-bottom switch this table replaced.
// Unmatched paths fall through to the default-deny in handle.
var routes = []route{
	{pat: "/", handler: redirectToControl},
	{pat: "/index.html", handler: redirectToControl},
	{pat: controlPrefix, handler: serveIndex},
	{pat: controlPrefix + "index.html", handler: serveIndex},
	{pat: "/favicon.ico", handler: (*server).emptyFavicon},
	{pat: controlPrefix + "sw.js", handler: serveSW},
	{pat: controlPrefix + "ws-pipe", handler: (*server).handlePipe},
	{pat: controlPrefix + "kernel.wasm", handler: serveKernelWASM},
	{pat: controlPrefix + "p/", prefix: true, handler: serveIndex},
	{pat: controlPrefix + "error/", prefix: true, handler: serveControlError},
	{pat: assetPrefix, prefix: true, handler: serveAssetRoute},
	{pat: controlPrefix + "worker-bootstrap.js", handler: (*server).workerBootstrap},
	{pat: "/p/", prefix: true, handler: redirectLegacyPage},
	{pat: "/__zp/", prefix: true, handler: (*server).legacyZP},
	{pat: "/sw.js", handler: redirectLegacySW},
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	for _, rt := range routes {
		if rt.matches(path) {
			rt.handler(s, w, r)
			return
		}
	}
	s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
}

func redirectToControl(_ *server, w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, controlPrefix, http.StatusFound)
}

func serveIndex(s *server, w http.ResponseWriter, r *http.Request) { s.serveWeb(w, r, "index.html") }

func serveSW(s *server, w http.ResponseWriter, r *http.Request) { s.serveWeb(w, r, "sw.js") }

func serveKernelWASM(s *server, w http.ResponseWriter, r *http.Request) {
	s.serveFile(w, r, s.kernelWASM, "application/wasm")
}

func serveControlError(s *server, w http.ResponseWriter, r *http.Request) {
	s.safeError(w, r, strings.TrimPrefix(r.URL.Path, controlPrefix+"error/"), http.StatusBadRequest)
}

func serveAssetRoute(s *server, w http.ResponseWriter, r *http.Request) {
	s.serveAsset(w, r, strings.TrimPrefix(r.URL.Path, assetPrefix))
}

func redirectLegacyPage(_ *server, w http.ResponseWriter, r *http.Request) {
	redirectLegacy(w, r, controlPrefix+"p/"+strings.TrimPrefix(r.URL.Path, "/p/"))
}

func redirectLegacySW(_ *server, w http.ResponseWriter, r *http.Request) {
	redirectLegacy(w, r, controlPrefix+"sw.js")
}

func redirectLegacy(w http.ResponseWriter, r *http.Request, nextPath string) {
	u := *r.URL
	u.Path = nextPath
	http.Redirect(w, r, u.String(), http.StatusTemporaryRedirect)
}

// legacyControlRedirects maps legacy /__zp/ control paths to their canonical
// /zp/ targets. The lookup replaces the outer switch's exact cases.
var legacyControlRedirects = map[string]string{
	"/__zp/ws-pipe":             controlPrefix + "ws-pipe",
	"/__zp/kernel.wasm":         controlPrefix + "kernel.wasm",
	"/__zp/worker-bootstrap.js": controlPrefix + "worker-bootstrap.js",
}

// legacyAssetNames is the allowlist of legacy /__zp/<name> asset paths that map
// to the canonical /zp/assets/ prefix. Anything else is default-denied.
var legacyAssetNames = map[string]struct{}{
	"zp-core.js":         {},
	"runtime-prelude.js": {},
	"rust-rewriter.js":   {},
	"wasm_exec.js":       {},
	"worker-prelude.js":  {},
}

func (s *server) legacyZP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if next, ok := legacyControlRedirects[path]; ok {
		redirectLegacy(w, r, next)
		return
	}
	if strings.HasPrefix(path, "/__zp/error/") {
		redirectLegacy(w, r, controlPrefix+"error/"+strings.TrimPrefix(path, "/__zp/error/"))
		return
	}
	name := strings.TrimPrefix(path, "/__zp/")
	if _, ok := legacyAssetNames[name]; ok {
		redirectLegacy(w, r, assetPrefix+name)
		return
	}
	s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
}

func (s *server) serveWeb(w http.ResponseWriter, r *http.Request, name string) {
	s.serveFile(w, r, filepath.Join(s.webDir, name), mime.TypeByExtension(filepath.Ext(name)))
}

func (s *server) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	switch name {
	case "zp-core.js", "runtime-prelude.js", "rust-rewriter.js", "wasm_exec.js", "worker-prelude.js", "favicon.ico", "manifest.webmanifest":
		s.serveWeb(w, r, name)
	default:
		s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
	}
}

func (s *server) emptyFavicon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(emptyFaviconPNG)
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
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_LOCATION=__zp_worker_params.get('loc')||self.__ZP_WORKER_TARGET;self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_RUNTIME_TOKEN=__zp_worker_params.get('rt')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&rt=' + encodeURIComponent(self.__ZP_WORKER_RUNTIME_TOKEN) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
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

// readSOCKS5Connect drives the SOCKS5 server handshake to completion and
// returns the requested target host and port. It runs the greeting/auth
// negotiation, then parses the CONNECT request. The wire protocol and every
// reply byte are preserved verbatim by the stage helpers below.
func readSOCKS5Connect(ctx context.Context, rw net.Conn) (string, string, error) {
	if err := socks5Negotiate(ctx, rw); err != nil {
		return "", "", err
	}
	return socks5ReadRequest(ctx, rw)
}

// socks5Negotiate reads the client greeting, selects an auth method, sends the
// method-selection reply, and runs username/password auth when negotiated.
func socks5Negotiate(ctx context.Context, rw net.Conn) error {
	var head [2]byte
	if err := readFull(ctx, rw, head[:]); err != nil {
		return err
	}
	if head[0] != 0x05 || head[1] == 0 {
		return fmt.Errorf("invalid SOCKS5 greeting")
	}
	methods := make([]byte, int(head[1]))
	if err := readFull(ctx, rw, methods); err != nil {
		return err
	}
	method := socks5SelectMethod(methods)
	if _, err := rw.Write([]byte{0x05, method}); err != nil {
		return err
	}
	if method == 0xff {
		return fmt.Errorf("no acceptable SOCKS5 auth method")
	}
	if method == 0x02 {
		return acceptSOCKS5UserPass(ctx, rw)
	}
	return nil
}

// socks5SelectMethod picks the auth method from the client's offer list,
// preferring username/password (0x02) over no-auth (0x00), and returns 0xff
// when neither is offered.
func socks5SelectMethod(methods []byte) byte {
	method := byte(0xff)
	for _, m := range methods {
		if m == 0x02 {
			return 0x02
		}
		if m == 0x00 {
			method = 0x00
		}
	}
	return method
}

// socks5ReadRequest parses a SOCKS5 CONNECT request (command, address, port)
// and returns the target host and decimal port string.
func socks5ReadRequest(ctx context.Context, rw net.Conn) (string, string, error) {
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
	port, err := readSOCKS5Port(ctx, rw)
	if err != nil {
		return "", "", err
	}
	return host, port, nil
}

// readSOCKS5Port reads the two-byte big-endian port and rejects port 0.
func readSOCKS5Port(ctx context.Context, rw net.Conn) (string, error) {
	var portBuf [2]byte
	if err := readFull(ctx, rw, portBuf[:]); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(portBuf[:])
	if port == 0 {
		return "", fmt.Errorf("invalid SOCKS5 port")
	}
	return fmt.Sprint(port), nil
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
		if needsServiceWorkerWASMCSP(r.URL.Path) {
			w.Header().Set("Content-Security-Policy", serviceWorkerCSP(r))
		} else {
			w.Header().Set("Content-Security-Policy", zeroCSP(r))
		}
		next.ServeHTTP(w, r)
	})
}

func needsServiceWorkerWASMCSP(path string) bool {
	return path == controlPrefix+"sw.js" || path == assetPrefix+"rust-rewriter.js" || path == assetPrefix+"wasm_exec.js"
}

func zeroCSP(r *http.Request) string {
	return cspWithScriptSrc(r, "script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'")
}

func serviceWorkerCSP(r *http.Request) string {
	return cspWithScriptSrc(r, "script-src 'self' blob: 'wasm-unsafe-eval'")
}

// cspWithScriptSrc builds the page Content-Security-Policy with the given
// script-src directive. The connect-src websocket origin tracks the request
// scheme (wss:// behind TLS or an https X-Forwarded-Proto, ws:// otherwise).
func cspWithScriptSrc(r *http.Request, scriptSrc string) string {
	wsScheme := "ws://"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		wsScheme = "wss://"
	}
	host := r.Host
	if host == "" {
		host = "proxy.example"
	}
	return "default-src 'none'; " + scriptSrc + "; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src 'self' " + wsScheme + host + "; frame-src 'self' blob: data:; child-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'"
}

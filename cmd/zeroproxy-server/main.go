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
		s.handlePipe(w, r)
	case path == controlPrefix+"kernel.wasm":
		s.serveFile(w, r, s.kernelWASM, "application/wasm")
	case strings.HasPrefix(path, controlPrefix+"p/"):
		s.serveWeb(w, r, "index.html")
	case strings.HasPrefix(path, controlPrefix+"error/"):
		s.safeError(w, r, strings.TrimPrefix(path, controlPrefix+"error/"), http.StatusBadRequest)
	case strings.HasPrefix(path, assetPrefix):
		s.serveAsset(w, r, strings.TrimPrefix(path, assetPrefix))
	case path == controlPrefix+"worker-bootstrap.js":
		s.workerBootstrap(w, r)
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
	case "/__zp/kernel.wasm":
		redirectLegacy(w, r, controlPrefix+"kernel.wasm")
	case "/__zp/worker-bootstrap.js":
		redirectLegacy(w, r, controlPrefix+"worker-bootstrap.js")
	default:
		if strings.HasPrefix(r.URL.Path, "/__zp/error/") {
			redirectLegacy(w, r, controlPrefix+"error/"+strings.TrimPrefix(r.URL.Path, "/__zp/error/"))
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/__zp/")
		switch name {
		case "zp-core.js", "runtime-prelude.js", "rust-rewriter.js", "wasm_exec.js", "worker-prelude.js":
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
	case "zp-core.js", "runtime-prelude.js", "rust-rewriter.js", "wasm_exec.js", "worker-prelude.js", "favicon.ico", "manifest.webmanifest":
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
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_RUNTIME_TOKEN=__zp_worker_params.get('rt')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&rt=' + encodeURIComponent(self.__ZP_WORKER_RUNTIME_TOKEN) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
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
	wsScheme := "ws://"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		wsScheme = "wss://"
	}
	host := r.Host
	if host == "" {
		host = "proxy.example"
	}
	return "default-src 'none'; script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src 'self' " + wsScheme + host + "; frame-src 'self' blob: data:; child-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'"
}

func serviceWorkerCSP(r *http.Request) string {
	return strings.Replace(zeroCSP(r), "script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'", "script-src 'self' blob: 'wasm-unsafe-eval'", 1)
}

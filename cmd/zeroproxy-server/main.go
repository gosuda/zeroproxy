package main

import (
	"context"
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

func main() {
	var addr string
	s := &server{}
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&s.webDir, "web", "web", "static web asset directory")
	flag.StringVar(&s.kernelWASM, "kernel", "bin/kernel.wasm", "compiled Go WASM kernel path")
	flag.StringVar(&s.socksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address configured with IsolateSOCKSAuth")
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
	switch {
	case r.URL.Path == "/__zp/ws-pipe":
		s.handlePipe(w, r)
	case r.URL.Path == "/__zp/kernel.wasm":
		s.serveFile(w, r, s.kernelWASM, "application/wasm")
	case r.URL.Path == "/" || r.URL.Path == "/index.html":
		s.serveWeb(w, r, "index.html")
	case strings.HasPrefix(r.URL.Path, "/p/"):
		s.serveWeb(w, r, "index.html")
	case r.URL.Path == "/sw.js":
		s.serveWeb(w, r, "sw.js")
	case strings.HasPrefix(r.URL.Path, "/__zp/error/"):
		s.safeError(w, r, strings.TrimPrefix(r.URL.Path, "/__zp/error/"), http.StatusBadRequest)
	case r.URL.Path == "/__zp/zp-core.js":
		s.serveWeb(w, r, "zp-core.js")
	case r.URL.Path == "/__zp/runtime-prelude.js":
		s.serveWeb(w, r, "runtime-prelude.js")
	case r.URL.Path == "/__zp/worker-prelude.js":
		s.serveWeb(w, r, "worker-prelude.js")
	case r.URL.Path == "/__zp/wasm_exec.js":
		s.serveWeb(w, r, "wasm_exec.js")
	case r.URL.Path == "/__zp/worker-bootstrap.js":
		s.workerBootstrap(w, r)
	default:
		s.safeError(w, r, "POLICY_BLOCKED", http.StatusForbidden)
	}
}

func (s *server) serveWeb(w http.ResponseWriter, r *http.Request, name string) {
	s.serveFile(w, r, filepath.Join(s.webDir, name), mime.TypeByExtension(filepath.Ext(name)))
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
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';importScripts('/__zp/worker-prelude.js');importScripts('/__zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
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
	case "BAD_HMAC", "INVALID_SHARE_LINK", "MALFORMED_ROUTE", "SW_NOT_READY", "TARGET_PROTOCOL_BLOCKED", "TLS_CERTIFICATE_INVALID", "TLS_HANDSHAKE_FAILED", "TARGET_CONNECT_FAILED", "MALFORMED_HTML", "REALM_INJECTION_FAILURE", "POLICY_BLOCKED":
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
		go s.bridgeToTor(ctx, stream)
	}
}

func (s *server) bridgeToTor(ctx context.Context, stream net.Conn) {
	defer stream.Close()
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	tor, err := d.DialContext(ctx, "tcp", s.socksAddr)
	if err != nil {
		return
	}
	defer tor.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(tor, stream); done <- struct{}{} }()
	go func() { _, _ = io.Copy(stream, tor); done <- struct{}{} }()
	select {
	case <-ctx.Done():
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
	return "default-src 'none'; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src 'self' " + wsScheme + host + "; frame-src 'self' blob: data:; child-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; navigate-to 'self'; manifest-src 'self'"
}

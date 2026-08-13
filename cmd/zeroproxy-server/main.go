package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
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
	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/internal/wtproxy"
	"github.com/gosuda/zeroproxy/internal/yamuxconn"
)

type server struct {
	webDir        string
	socksAddr     string
	wtGatewayURL  string // D4 — public URL the browser uses to reach the WT gateway; empty disables client-side virtual WebTransport
	rtcGatewayURL string // D5 — public URL the browser uses to reach the RTC signaling endpoint; empty disables the virtual RTCPC pass-through
	rtcGateway    *rtcgw.Gateway
	rtcTURN       *rtcgw.TURNServer // D5 embedded TURN (optional) — issues short-term cred tuples via serveConfig
	jarsMu        sync.Mutex
	jars          map[string]*cookiejar.Jar
	// 동기 XHR 중계 허브. Go 는 요청을 park 만 하고 실제 전송은 SW 가 한다
	// (syncfetch.go 의 주석 참고) — 새 egress 경로가 아니다.
	syncHub *syncFetchHub
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
	var addr string
	var wtAddr, wtCert, wtKey, wtPath string
	s := &server{syncHub: newSyncFetchHub()}
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&s.webDir, "web", "dist/web", "built static web asset directory")
	flag.StringVar(&s.socksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address with IsolateSOCKSAuth, or 'internal' for the built-in test SOCKS5 parser/direct dialer")
	// D4 — server-side WebTransport gateway. Empty `-wt-addr` keeps the
	// listener disabled (the page realm still sees the stub WT_UNSUPPORTED
	// error from runtime-prelude's installBlockers fallback).
	flag.StringVar(&wtAddr, "wt-addr", "", "WebTransport (HTTP/3) gateway UDP listen address (e.g. ':18443'); empty disables D4")
	flag.StringVar(&wtCert, "wt-cert", "", "WebTransport listener TLS cert path (optional — falls back to in-memory self-signed dev cert)")
	flag.StringVar(&wtKey, "wt-key", "", "WebTransport listener TLS key path")
	flag.StringVar(&wtPath, "wt-path", "/__zp/wt", "WebTransport CONNECT request path")
	// D4 client-side: the browser-side virtual `WebTransport` shim needs a
	// publicly-reachable URL for the gateway (different from the UDP listen
	// addr, which may be a local bind or an internal LB pool). When empty,
	// the page falls back to the stub WT_UNSUPPORTED behaviour and target
	// `new WebTransport(...)` calls reject (Promise.ready). Operators set
	// this to e.g. `https://proxy.localhost:18443/__zp/wt` for local dogfood.
	flag.StringVar(&s.wtGatewayURL, "wt-public-url", "", "Public URL of the WebTransport gateway (e.g. 'https://proxy.localhost:18443/__zp/wt'); empty hides the gateway from the page-side virtual class")
	// D5 — WebRTC signaling gateway. The gateway runs in-process on the
	// same HTTP listener (`/zp/api/rtc/signal`), so there's no separate
	// addr flag; just an enable toggle + the public URL the page reads
	// from `/zp/api/config`. Empty leaves the legacy stub Handler() up.
	var rtcEnabled bool
	var rtcAllowedIPs string
	var rtcTurnAddr, rtcTurnPublicAddr, rtcTurnExternalIP, rtcTurnRealm, rtcTurnSecret string
	flag.BoolVar(&rtcEnabled, "rtc-enable", false, "Enable the D5 WebRTC signaling gateway (in-process pion/webrtc bridge)")
	flag.StringVar(&s.rtcGatewayURL, "rtc-public-url", "", "Public URL of the RTC signaling endpoint (e.g. 'http://proxy.localhost:18080/zp/api/rtc/signal'); empty disables the page-side virtual RTCPeerConnection pass-through")
	flag.StringVar(&rtcAllowedIPs, "rtc-allowed-ips", "", "Comma-separated list of IPs the gateway's own SDP candidates are allowed to advertise — used to strip host candidates that would leak the operator's LAN/NAT interfaces. Empty = no munging (public-IP-only deployments).")
	flag.StringVar(&rtcTurnAddr, "rtc-turn-addr", "", "UDP listener for the embedded TURN server (e.g. '0.0.0.0:3478'). Empty disables embedded TURN — page realm falls back to host candidates only.")
	flag.StringVar(&rtcTurnPublicAddr, "rtc-turn-public-addr", "", "host:port clients reach the TURN server at (covers NAT / port-forwarding). Defaults to -rtc-turn-addr.")
	flag.StringVar(&rtcTurnExternalIP, "rtc-turn-external-ip", "", "Relay address IP pion advertises in TURN allocation responses. For a port-forwarded box, the public IP. Defaults to listener IP — wrong for NAT'd deployments.")
	flag.StringVar(&rtcTurnRealm, "rtc-turn-realm", "zeroproxy", "TURN realm string")
	flag.StringVar(&rtcTurnSecret, "rtc-turn-secret", "", "Long-term TURN-REST shared secret (hex). Empty = random per-process secret (creds expire on restart).")
	flag.Parse()
	if rtcEnabled {
		var allowed []string
		if rtcAllowedIPs != "" {
			for _, p := range strings.Split(rtcAllowedIPs, ",") {
				if p = strings.TrimSpace(p); p != "" {
					allowed = append(allowed, p)
				}
			}
		}
		gw, err := rtcgw.New(rtcgw.Config{AllowedExternalIPs: allowed})
		if err != nil {
			log.Fatalf("rtcgw: %v", err)
		}
		s.rtcGateway = gw
		if rtcTurnAddr != "" {
			turnSrv, err := rtcgw.NewTURNServer(rtcgw.TURNConfig{
				Addr:         rtcTurnAddr,
				PublicAddr:   rtcTurnPublicAddr,
				ExternalIP:   rtcTurnExternalIP,
				Realm:        rtcTurnRealm,
				SharedSecret: rtcTurnSecret,
			})
			if err != nil {
				log.Fatalf("rtcgw: embedded TURN: %v", err)
			}
			s.rtcTURN = turnSrv
			log.Printf("rtcgw: embedded TURN listening on %s (public %s, realm %q)", rtcTurnAddr, turnSrv.PublicAddr(), rtcTurnRealm)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	h := securityHeaders(mux)

	// D4 listener runs on its own UDP socket — HTTP/3 + WebTransport
	// extension. Disabled by default (empty addr); operator opts in
	// during dogfood with `-wt-addr :18443`. Per-target relay happens
	// inside internal/wtproxy/listener.go::handleUpgrade; the page-side
	// virtual `WebTransport` surface that drives it is a separate
	// follow-up — without it the listener is exercised only by host
	// tests + direct webtransport-go clients.
	if wtAddr != "" {
		wtListener, err := wtproxy.New(wtproxy.Config{
			Addr:                 wtAddr,
			Path:                 wtPath,
			CertFile:             wtCert,
			KeyFile:              wtKey,
			AllowInsecureDevCert: true,
		})
		if err != nil {
			log.Fatalf("wtproxy: %v", err)
		}
		go func() {
			if err := wtListener.Run(context.Background()); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("wtproxy: listener exited: %v", err)
			}
		}()
	}

	// The Go server is a pure byte-pipe — no TLS termination here. The Rust
	// WASM kernel (crates/zp-bundle) handles every target TLS handshake
	// inside the browser, so the relay sees only ciphertext inside yamux
	// streams. ClientHello mimicry is captured into the kernel's hardcoded
	// Chrome 148 spec at build time (web/sw.js captureBrowserFingerprint);
	// the historical `-tls-addr` listener + /zp/api/fp capture endpoint
	// were deleted 2026-06-05 since the SW never actually fetched them in
	// practice (self-signed cert + Chrome's SW HTTPS refusal made the
	// loopback fetch path dead on arrival).
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
	case path == controlPrefix+"api/sync-fetch":
		// 동기 XHR 중계. SW 가 동기 XHR 을 가로채지 못하므로(실측), 페이지는
		// 이 same-origin 엔드포인트로 던지고 Go 가 SW 에 일을 넘긴다.
		// Go 는 타깃으로 직접 나가지 않는다 — syncfetch.go 주석 참고.
		s.handleSyncFetch(w, r)
	case path == controlPrefix+"api/sync-fetch/poll":
		s.handleSyncFetchPoll(w, r)
	case path == controlPrefix+"api/sync-fetch/result":
		s.handleSyncFetchResult(w, r)
	case path == controlPrefix+"api/config":
		// D4/D5 client config — exposes the public WT gateway URL (if
		// `-wt-public-url` is set) + RTC signaling URL (if
		// `-rtc-public-url` is set). SW fetches this once on activate
		// and threads `wtGateway` / `rtcGateway` into the boot JSON the
		// page realm reads.
		s.serveConfig(w, r)
	case path == controlPrefix+"api/rtc/signal":
		// D5 — WebRTC signaling endpoint. Active only when
		// `-rtc-enable` is set; otherwise the stub Handler() at
		// `/__zp/rtc/` is still in place.
		if s.rtcGateway == nil {
			s.safeError(w, r, "RTC_GATEWAY_UNAVAILABLE", http.StatusServiceUnavailable)
			return
		}
		s.rtcGateway.HandlerForAPI().ServeHTTP(w, r)
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
		// D4 fallback: the real WebTransport gateway listens on a
		// SEPARATE UDP port (configured via `-wt-addr`) — it speaks
		// HTTP/3, not HTTP/1.1, so any /__zp/wt arrival on this TCP
		// listener means the page-side virtual class accidentally
		// routed here. Reply 501 with the stable WT_UNSUPPORTED code so
		// the page can detect "gateway not available over HTTP/1.1
		// fallback" and surface a friendlier message.
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
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (s *server) workerBootstrap(w http.ResponseWriter, r *http.Request) {
	body := "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, body)
}

// serveConfig emits the minimal client-facing runtime config the SW
// reads on activate. D4 = wtGateway; D5 = rtcGateway + rtcICEServers.
// SW only ever does ONE fetch on boot.
//
// `rtcICEServers` is a fresh time-limited cred tuple from the
// embedded TURN server (when -rtc-turn-addr is set). Each call to
// serveConfig issues a new cred set so re-registration of the SW
// (which re-fetches /zp/api/config) rotates credentials. Without
// embedded TURN the field is `[]` so page realm's RTCPC falls back
// to host candidates only.
func (s *server) serveConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	wt := strings.ReplaceAll(s.wtGatewayURL, `"`, `\"`)
	rtc := strings.ReplaceAll(s.rtcGatewayURL, `"`, `\"`)
	iceServers := "[]"
	if s.rtcTURN != nil {
		cred, err := s.rtcTURN.IssueICEServerCreds("")
		if err == nil {
			if buf, err := json.Marshal([]rtcgw.ICEServerCred{cred}); err == nil {
				iceServers = string(buf)
			}
		}
	}
	_, _ = fmt.Fprintf(w, `{"wtGateway":"%s","rtcGateway":"%s","rtcICEServers":%s}`, wt, rtc, iceServers)
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
	a, b := traceBridge(stream, target, host)
	bridgeConns(ctx, a, b)
}

// traceBridge optionally wraps both ends of a bridged stream so each
// direction's read timeline is logged — used to localize the cold-bootstrap
// "exactly 60s" first-request stall. Gated by ZP_BRIDGE_TRACE so it is
// zero-cost in normal operation. The discriminator: c2u (browser→upstream)
// logs request bytes leaving the browser; u2c (upstream→browser) logs the
// response. A long gap on c2u before the request means the request was
// stuck on OUR side; a long gap only on u2c (request already forwarded)
// means the upstream held the response.
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

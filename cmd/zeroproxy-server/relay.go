package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
)

// armedChallengeRequestHeader is the SW→server signal that the originating tab
// has the operator opt-in (per-tab arm) for Cloudflare-Turnstile challenge
// compatibility. The relay strips it before forwarding upstream (it is in the
// x-zp-* internal namespace) and uses it as the FIRST of two signals — the
// SECOND is the response-side header/URL classifier from
// headers.IsChallengeDocument. Both must hold for any compat projection.
const armedChallengeRequestHeader = "X-ZP-Arm-Challenge-Compat"

// armedChallengeResponseHeader is the server→SW marker emitted ONLY when both
// signals held (armed AND classifier matched). SW reads it once in addCSP
// then strips it unconditionally, so it never reaches the proxied page.
const armedChallengeResponseHeader = "X-ZP-Challenge-Compat"

// maybeApplyChallengeMarker is the pure projection that appends
// `X-ZP-Challenge-Compat: 1` to the outgoing header list when BOTH signals
// hold. Pure: no I/O, body never inspected. The caller is responsible for
// having already stripped the x-zp-* range from the upstream forward path.
func maybeApplyChallengeMarker(out [][]string, armed bool, finalURL *url.URL, respHeader http.Header) [][]string {
	if !armed || finalURL == nil {
		return out
	}
	cf := ""
	if respHeader != nil {
		cf = respHeader.Get("Cf-Mitigated")
	}
	if !headers.IsChallengeDocument(cf, finalURL.Hostname(), finalURL.Path) {
		return out
	}
	return append(out, []string{armedChallengeResponseHeader, "1"})
}

// Mux frame types for /zp/relay-mux. Single shared WebSocket carries many
// concurrent HTTP request/response pairs, each identified by a u32 stream ID.
// All frames are binary WebSocket frames in the form
//
//	[4-byte big-endian stream ID][1-byte type][payload...]
//
// Types:
//
//	0x01 ENVELOPE   client→server  payload = JSON relayRequest
//	0x02 BODY_UP    client→server  payload = request body chunk (empty = EOF)
//	0x10 HEAD       server→client  payload = JSON relayResponseHead
//	0x11 BODY_DOWN  server→client  payload = response body chunk (empty = EOF)
//	0x20 ERROR      server→client  payload = error code text
//	0x30 CANCEL     client→server  payload = empty (cancel + cleanup)
const (
	muxFrameEnvelope = 0x01
	muxFrameBodyUp   = 0x02
	muxFrameHead     = 0x10
	muxFrameBodyDown = 0x11
	muxFrameError    = 0x20
	muxFrameCancel   = 0x30
)

// transportPool keys an http.Transport off the dial function so the keep-alive
// pool stays per-upstream-mode (direct dial vs Tor SOCKS5). All bridgeRelayWS
// callers share the same Transport for the same dial closure, which is what
// gives us connection reuse across WS requests.
var (
	transportPoolMu sync.Mutex
	transportPool   = map[uintptr]*http.Transport{}
)

// followRedirects performs an upstream HTTP round-trip and follows 3xx
// redirects server-side so the browser never sees a raw Location header. Why
// this matters: relative Location values (e.g. NAVER's `shopsquare.naver.com`
// 303 → `/newshopping`) would otherwise be resolved by the browser against
// the proxy origin (proxy.localhost:18080/newshopping) and hit POLICY_BLOCKED.
//
// 301/302/303 → GET conversion (per RFC + browser convention), body dropped.
// 307/308 require method+body preservation; since the relay body is an io.Pipe
// streamed from the client WS and is non-replayable, on 307/308 we just return
// the redirect response unchanged (rare for GET document loads).
//
// jar (if non-nil) captures Set-Cookie at every hop so auth cookies set during
// the redirect chain are preserved for the next request.
func followRedirects(ctx context.Context, rt http.RoundTripper, req *http.Request, jar *cookiejar.Jar) (*http.Response, *url.URL, error) {
	const maxHops = 10
	cur := req
	curURL := req.URL
	for hop := 0; hop < maxHops; hop++ {
		resp, err := rt.RoundTrip(cur)
		if err != nil {
			return nil, curURL, err
		}
		if jar != nil {
			jar.SetCookies(curURL, resp.Cookies())
		}
		code := resp.StatusCode
		if code != http.StatusMovedPermanently && code != http.StatusFound &&
			code != http.StatusSeeOther && code != http.StatusTemporaryRedirect &&
			code != http.StatusPermanentRedirect {
			return resp, curURL, nil
		}
		loc := resp.Header.Get("Location")
		if loc == "" {
			return resp, curURL, nil
		}
		next, perr := curURL.Parse(loc)
		if perr != nil || (next.Scheme != "http" && next.Scheme != "https") || next.Host == "" {
			return resp, curURL, nil
		}
		// Drain and close before issuing the next hop.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		method := cur.Method
		if code == http.StatusSeeOther || code == http.StatusMovedPermanently || code == http.StatusFound {
			// Browsers convert 301/302/303 to GET; mirror that.
			method = http.MethodGet
		} else if cur.Body != nil && cur.Body != http.NoBody {
			// 307/308 with non-replayable body: cannot redirect server-side.
			return resp, curURL, nil
		}
		nreq, nerr := http.NewRequestWithContext(ctx, method, next.String(), nil)
		if nerr != nil {
			return resp, curURL, nil
		}
		crossHost := next.Host != req.URL.Host
		for k, vs := range req.Header {
			nk := http.CanonicalHeaderKey(k)
			// On GET conversion drop request-body framing headers.
			if method == http.MethodGet && (nk == "Content-Length" || nk == "Content-Type" || nk == "Transfer-Encoding") {
				continue
			}
			// Mimic browser policy: strip credential-bearing headers across origins.
			if crossHost && (nk == "Authorization" || nk == "Cookie") {
				continue
			}
			for _, v := range vs {
				nreq.Header.Add(k, v)
			}
		}
		nreq.Host = next.Host
		nreq.Header.Set("Host", next.Host)
		// Refresh Cookie from jar in case we just captured Set-Cookie this hop.
		if jar != nil {
			if line := jar.DocumentCookie(next); line != "" {
				nreq.Header.Set("Cookie", line)
			}
		}
		cur = nreq
		curURL = next
	}
	resp, err := rt.RoundTrip(cur)
	return resp, curURL, err
}

func poolForDial(dial func(ctx context.Context, host, port string) (net.Conn, error)) *http.Transport {
	key := reflect.ValueOf(dial).Pointer()
	transportPoolMu.Lock()
	defer transportPoolMu.Unlock()
	if t, ok := transportPool[key]; ok {
		return t
	}
	t := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return dial(ctx, host, port)
		},
		TLSClientConfig:       &tls.Config{},
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   16,
		MaxConnsPerHost:       0,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     true,
		DisableCompression:    true, // SW handles content-encoding; preserve the encoded body verbatim.
	}
	transportPool[key] = t
	return t
}

// relayRequest is the first text frame on a /zp/relay WebSocket.
// Body protocol (Step 13 streaming upgrade):
//   - HasBody=false: no body frames follow; server proceeds straight to writing
//     the upstream request.
//   - HasBody=true: client sends binary frames containing body chunks; an
//     empty binary frame terminates the body and unblocks the upstream write.
//     This lets the SW pipe a Request body's ReadableStream chunk-by-chunk
//     instead of buffering the entire body in a base64 envelope.
type relayRequest struct {
	URL     string     `json:"url"`
	Method  string     `json:"method"`
	Headers [][]string `json:"headers"`
	HasBody bool       `json:"has_body,omitempty"`
}

// relayResponseHead is the first text frame sent back to the client.
type relayResponseHead struct {
	OK       bool       `json:"ok"`
	Status   int        `json:"status,omitempty"`
	Headers  [][]string `json:"headers,omitempty"`
	FinalURL string     `json:"finalURL,omitempty"`
	Code     string     `json:"code,omitempty"`
	Host     string     `json:"host,omitempty"`
}

// dialTargetTCP opens a TCP connection to host:port via the configured
// upstream (internal direct dialer or Tor SOCKS5). Returns the bare TCP conn
// so the relay can issue HTTP/1.1 on top of it.
func (s *server) dialTargetTCP(ctx context.Context, host, port string) (net.Conn, error) {
	if strings.EqualFold(strings.TrimSpace(s.socksAddr), internalSOCKSMode) {
		d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	}
	// Tor SOCKS5 mode: open a SOCKS5 conn to s.socksAddr and ask it to CONNECT
	// to host:port. Mirrors the credentials/IsolateSOCKSAuth path used by
	// ws-pipe but without any stream multiplexing on top.
	return dialThroughTorSOCKS(ctx, s.socksAddr, host, port)
}

func bridgeRelayWS(ctx context.Context, ws *websocket.Conn, dial func(ctx context.Context, host, port string) (net.Conn, error), jarFor func(tabID string) *cookiejar.Jar) {
	log.Printf("relay: WS connected; awaiting envelope")
	// Read the first text frame as the request envelope.
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	mt, raw, err := ws.ReadMessage()
	if err != nil {
		log.Printf("relay: ReadMessage error: %v", err)
		return
	}
	if mt != websocket.TextMessage {
		log.Printf("relay: first frame is not text (mt=%d)", mt)
		writeRelayError(ws, "MALFORMED_ROUTE", "")
		return
	}
	log.Printf("relay: envelope bytes=%d", len(raw))
	var req relayRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		log.Printf("relay: JSON unmarshal error: %v", err)
		writeRelayError(ws, "MALFORMED_ROUTE", "")
		return
	}
	log.Printf("relay: target=%s method=%s headers=%d", req.URL, req.Method, len(req.Headers))
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeRelayError(ws, "TARGET_PROTOCOL_BLOCKED", "")
		return
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}
	// Body: io.Pipe between the client WS frames and the upstream request
	// body. A goroutine reads binary frames off the client and writes them to
	// the pipe; an empty binary frame closes the pipe (end of body). The
	// upstream HTTP write blocks on pipeReader until we close it, so the
	// upload is fully streamed without buffering the whole body.
	var body io.Reader
	if req.HasBody {
		pr, pw := io.Pipe()
		body = pr
		go func() {
			defer pw.Close()
			for {
				if ctx.Err() != nil {
					return
				}
				mt, chunk, rerr := ws.ReadMessage()
				if rerr != nil {
					_ = pw.CloseWithError(rerr)
					return
				}
				if mt != websocket.BinaryMessage {
					_ = pw.CloseWithError(fmt.Errorf("relay: expected binary body frame, got mt=%d", mt))
					return
				}
				if len(chunk) == 0 {
					return // EOF
				}
				if _, werr := pw.Write(chunk); werr != nil {
					return
				}
			}
		}()
	}
	// Build the upstream request and route it through the shared transport
	// pool — http.Transport handles connection keep-alive / pooling per host,
	// so the next WS request to the same target reuses the existing TCP/TLS
	// connection instead of paying for a fresh handshake + (optionally) SOCKS5
	// CONNECT round-trip. This was the single largest source of latency: with
	// 30+ subresources per page and 5+ unique hosts, the old "1 WS = 1 fresh
	// TCP/TLS" model spent hundreds of ms per page on handshakes alone.
	httpReq, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		writeRelayError(ws, "MALFORMED_ROUTE", u.Host)
		return
	}
	var tabID string
	// Promote forbidden-header sidechannel (see bridgeMuxRelayWS for rationale).
	var smuggledReferer, smuggledOrigin, smuggledUA string
	var armedChallenge bool
	for _, kv := range req.Headers {
		if len(kv) != 2 {
			continue
		}
		k := strings.TrimSpace(kv[0])
		if isHopByHopHeader(k) {
			continue
		}
		// Extract tabId from X-ZP-Tab-Id (used for per-tab cookie jar), then
		// strip all ZeroProxy internal markers: target servers must never see
		// X-ZP-Tab-Id, X-ZP-Runtime-Token, X-ZP-Stream-Isolation-Key, etc.
		// — they expose tab identity / relay topology.
		if strings.EqualFold(k, "X-ZP-Tab-Id") {
			tabID = strings.TrimSpace(kv[1])
		}
		if strings.EqualFold(k, "X-ZP-Referer") {
			smuggledReferer = strings.TrimSpace(kv[1])
		}
		if strings.EqualFold(k, "X-ZP-Origin") {
			smuggledOrigin = strings.TrimSpace(kv[1])
		}
		if strings.EqualFold(k, "X-ZP-User-Agent") {
			smuggledUA = strings.TrimSpace(kv[1])
		}
		if strings.EqualFold(k, armedChallengeRequestHeader) {
			armedChallenge = strings.TrimSpace(kv[1]) == "1"
		}
		if strings.HasPrefix(strings.ToLower(k), "x-zp-") {
			continue
		}
		httpReq.Header.Add(k, kv[1])
	}
	if smuggledReferer != "" {
		httpReq.Header.Set("Referer", smuggledReferer)
	}
	if smuggledOrigin != "" {
		httpReq.Header.Set("Origin", smuggledOrigin)
	}
	if smuggledUA != "" {
		httpReq.Header.Set("User-Agent", smuggledUA)
	} else if httpReq.Header.Get("User-Agent") == "" {
		httpReq.Header.Set("User-Agent",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
	}
	httpReq.Host = u.Host
	httpReq.Header.Set("Host", u.Host)
	// Per-tab cookie jar (RFC 6265): merge stored cookies into the outgoing
	// request, then capture Set-Cookie from the response.
	jar := jarFor(tabID)
	if jar != nil {
		if cookieLine := jar.DocumentCookie(u); cookieLine != "" {
			httpReq.Header.Set("Cookie", cookieLine)
		}
	}
	rt := poolForDial(dial)
	resp, finalURL, err := followRedirects(ctx, rt, httpReq, jar)
	if err != nil {
		code := "TARGET_CONNECT_FAILED"
		// Classify the most common upstream errors so the styled error page
		// can show something more useful than the generic transport failure.
		msg := err.Error()
		if strings.Contains(msg, "x509:") || strings.Contains(msg, "certificate") {
			code = "TLS_CERTIFICATE_INVALID"
		} else if strings.Contains(msg, "tls:") || strings.Contains(msg, "handshake failure") {
			code = "TLS_HANDSHAKE_FAILED"
		}
		log.Printf("relay: upstream RoundTrip failed for %s: %v", u.Host, err)
		writeRelayError(ws, code, u.Host)
		return
	}
	defer resp.Body.Close()
	// followRedirects already captured Set-Cookie at every hop; the final hop
	// is the one whose cookies belong with finalURL.
	if jar != nil {
		jar.SetCookies(finalURL, resp.Cookies())
	}
	respHeaders := make([][]string, 0, len(resp.Header))
	for k, vs := range resp.Header {
		if isHopByHopHeader(k) {
			continue
		}
		// We followed redirects server-side; drop Location so the browser
		// doesn't try to follow a relative URL against the proxy origin.
		if strings.EqualFold(k, "Location") {
			continue
		}
		for _, v := range vs {
			respHeaders = append(respHeaders, []string{k, v})
		}
	}
	respHeaders = maybeApplyChallengeMarker(respHeaders, armedChallenge, finalURL, resp.Header)
	head := relayResponseHead{
		OK:       true,
		Status:   resp.StatusCode,
		Headers:  respHeaders,
		FinalURL: finalURL.String(),
	}
	if err := writeRelayJSON(ws, head); err != nil {
		return
	}
	// Stream the response body in chunks; empty binary frame signals EOF.
	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
				return
			}
		}
		if rerr != nil {
			break
		}
	}
	_ = ws.WriteMessage(websocket.BinaryMessage, nil)
}

func writeRelayError(ws *websocket.Conn, code, host string) {
	_ = writeRelayJSON(ws, relayResponseHead{OK: false, Code: code, Host: host})
}

func writeRelayJSON(ws *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.TextMessage, data)
}

func splitHostPort(u *url.URL) (string, string) {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		default:
			port = "80"
		}
	}
	return host, port
}

func isHopByHopHeader(h string) bool {
	switch http.CanonicalHeaderKey(h) {
	case "Connection", "Proxy-Connection", "Keep-Alive", "Te", "Trailer",
		"Transfer-Encoding", "Upgrade", "Host":
		return true
	}
	return false
}

// newReader keeps the relayRequest body in memory; bodies are bounded by the
// MAX_REQUEST_BODY_BYTES check on the SW side.
type memReader struct {
	b []byte
	i int
}

func newReader(b []byte) *memReader { return &memReader{b: b} }
func (r *memReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

func dialThroughTorSOCKS(ctx context.Context, socksAddr, host, port string) (net.Conn, error) {
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", socksAddr)
	if err != nil {
		return nil, err
	}
	// Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		_ = conn.Close()
		return nil, fmt.Errorf("SOCKS5 auth refused: %v", resp)
	}
	// CONNECT request: VER=5, CMD=1, RSV=0, ATYP=3 (domain), LEN, host bytes, port BE.
	hostBytes := []byte(host)
	if len(hostBytes) > 255 {
		_ = conn.Close()
		return nil, fmt.Errorf("SOCKS5 host too long")
	}
	portNum, perr := parsePortNumber(port)
	if perr != nil {
		_ = conn.Close()
		return nil, perr
	}
	req := append([]byte{0x05, 0x01, 0x00, 0x03, byte(len(hostBytes))}, hostBytes...)
	req = append(req, byte(portNum>>8), byte(portNum&0xff))
	if _, err := conn.Write(req); err != nil {
		_ = conn.Close()
		return nil, err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if head[1] != 0x00 {
		_ = conn.Close()
		return nil, fmt.Errorf("SOCKS5 connect rejected: rep=%d", head[1])
	}
	// Consume BND.ADDR + BND.PORT (variable length).
	switch head[3] {
	case 0x01:
		if _, err := io.ReadFull(conn, make([]byte, 4+2)); err != nil {
			_ = conn.Close()
			return nil, err
		}
	case 0x03:
		ln := make([]byte, 1)
		if _, err := io.ReadFull(conn, ln); err != nil {
			_ = conn.Close()
			return nil, err
		}
		if _, err := io.ReadFull(conn, make([]byte, int(ln[0])+2)); err != nil {
			_ = conn.Close()
			return nil, err
		}
	case 0x04:
		if _, err := io.ReadFull(conn, make([]byte, 16+2)); err != nil {
			_ = conn.Close()
			return nil, err
		}
	default:
		_ = conn.Close()
		return nil, fmt.Errorf("SOCKS5 unknown ATYP=%d", head[3])
	}
	return conn, nil
}

// muxStream is per-request state owned by the bridgeMuxRelayWS read loop.
// bodyChunks is buffered so the read loop can keep ingesting frames for OTHER
// streams while this stream's upstream HTTP write catches up.
type muxStream struct {
	id         uint32
	bodyChunks chan []byte // nil = EOF terminator
	cancel     context.CancelFunc
}

// bridgeMuxRelayWS implements the multiplexed transport endpoint
// (/zp/relay-mux). One WebSocket, many concurrent HTTP requests. Each stream
// runs its own goroutine; all writes to the shared WS go through sendMu so
// gorilla/websocket's "no concurrent writes" invariant is preserved.
//
// This replaces the "1 WS = 1 HTTP request" model used by bridgeRelayWS. With
// a real-world page that pulls 100+ subresources, the old model paid a fresh
// WS upgrade per request — now the SW opens one mux WS and reuses it.
func bridgeMuxRelayWS(ctx context.Context, ws *websocket.Conn, dial func(ctx context.Context, host, port string) (net.Conn, error), jarFor func(tabID string) *cookiejar.Jar) {
	var sendMu sync.Mutex
	sendFrame := func(streamID uint32, frameType byte, payload []byte) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		// 4-byte stream ID + 1-byte type + payload. Allocate once per frame.
		buf := make([]byte, 5+len(payload))
		binary.BigEndian.PutUint32(buf[:4], streamID)
		buf[4] = frameType
		copy(buf[5:], payload)
		return ws.WriteMessage(websocket.BinaryMessage, buf)
	}

	var streamsMu sync.Mutex
	streams := make(map[uint32]*muxStream)

	addStream := func(id uint32, s *muxStream) {
		streamsMu.Lock()
		streams[id] = s
		streamsMu.Unlock()
	}
	getStream := func(id uint32) *muxStream {
		streamsMu.Lock()
		defer streamsMu.Unlock()
		return streams[id]
	}
	removeStream := func(id uint32) {
		streamsMu.Lock()
		delete(streams, id)
		streamsMu.Unlock()
	}

	handle := func(streamID uint32, env []byte, bodyReader io.Reader, sCtx context.Context, sCancel context.CancelFunc) {
		defer removeStream(streamID)
		defer sCancel()

		var req relayRequest
		if err := json.Unmarshal(env, &req); err != nil {
			_ = sendFrame(streamID, muxFrameError, []byte("MALFORMED_ROUTE"))
			return
		}
		u, err := url.Parse(req.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			_ = sendFrame(streamID, muxFrameError, []byte("TARGET_PROTOCOL_BLOCKED"))
			return
		}
		method := strings.ToUpper(strings.TrimSpace(req.Method))
		if method == "" {
			method = "GET"
		}

		var reqBody io.Reader
		if req.HasBody {
			reqBody = bodyReader
		}
		httpReq, err := http.NewRequestWithContext(sCtx, method, u.String(), reqBody)
		if err != nil {
			_ = sendFrame(streamID, muxFrameError, []byte("MALFORMED_ROUTE"))
			return
		}
		var tabID string
		// Browsers prohibit JS from setting Referer/Origin/User-Agent via
		// fetch(); the SW smuggles them as X-ZP-Referer/X-ZP-Origin/X-ZP-
		// User-Agent so we can promote them back to real headers here before
		// stripping the X-ZP-* prefix range.
		var smuggledReferer, smuggledOrigin, smuggledUA string
		var armedChallenge bool
		for _, kv := range req.Headers {
			if len(kv) != 2 {
				continue
			}
			k := strings.TrimSpace(kv[0])
			if isHopByHopHeader(k) {
				continue
			}
			if strings.EqualFold(k, "X-ZP-Tab-Id") {
				tabID = strings.TrimSpace(kv[1])
			}
			if strings.EqualFold(k, "X-ZP-Referer") {
				smuggledReferer = strings.TrimSpace(kv[1])
			}
			if strings.EqualFold(k, "X-ZP-Origin") {
				smuggledOrigin = strings.TrimSpace(kv[1])
			}
			if strings.EqualFold(k, "X-ZP-User-Agent") {
				smuggledUA = strings.TrimSpace(kv[1])
			}
			if strings.EqualFold(k, armedChallengeRequestHeader) {
				armedChallenge = strings.TrimSpace(kv[1]) == "1"
			}
			if strings.HasPrefix(strings.ToLower(k), "x-zp-") {
				continue
			}
			httpReq.Header.Add(k, kv[1])
		}
		if smuggledReferer != "" {
			httpReq.Header.Set("Referer", smuggledReferer)
		}
		if smuggledOrigin != "" {
			httpReq.Header.Set("Origin", smuggledOrigin)
		}
		// Default UA if SW didn't smuggle one (e.g. older client). Net/http
		// would otherwise send no User-Agent, which scraping detectors reject.
		if smuggledUA != "" {
			httpReq.Header.Set("User-Agent", smuggledUA)
		} else if httpReq.Header.Get("User-Agent") == "" {
			httpReq.Header.Set("User-Agent",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
		}
		httpReq.Host = u.Host
		httpReq.Header.Set("Host", u.Host)
		jar := jarFor(tabID)
		if jar != nil {
			if cookieLine := jar.DocumentCookie(u); cookieLine != "" {
				httpReq.Header.Set("Cookie", cookieLine)
			}
		}
		rt := poolForDial(dial)
		resp, finalURL, err := followRedirects(sCtx, rt, httpReq, jar)
		if err != nil {
			code := "TARGET_CONNECT_FAILED"
			msg := err.Error()
			if strings.Contains(msg, "x509:") || strings.Contains(msg, "certificate") {
				code = "TLS_CERTIFICATE_INVALID"
			} else if strings.Contains(msg, "tls:") || strings.Contains(msg, "handshake failure") {
				code = "TLS_HANDSHAKE_FAILED"
			}
			log.Printf("mux: upstream RoundTrip failed for %s stream=%d: %v", u.Host, streamID, err)
			_ = sendFrame(streamID, muxFrameError, []byte(code))
			return
		}
		defer resp.Body.Close()
		if jar != nil {
			jar.SetCookies(finalURL, resp.Cookies())
		}
		respHeaders := make([][]string, 0, len(resp.Header))
		for k, vs := range resp.Header {
			if isHopByHopHeader(k) {
				continue
			}
			// Server-side redirect following: strip Location so browser
			// doesn't try to follow against the proxy origin.
			if strings.EqualFold(k, "Location") {
				continue
			}
			for _, v := range vs {
				respHeaders = append(respHeaders, []string{k, v})
			}
		}
		respHeaders = maybeApplyChallengeMarker(respHeaders, armedChallenge, finalURL, resp.Header)
		head := relayResponseHead{
			OK:       true,
			Status:   resp.StatusCode,
			Headers:  respHeaders,
			FinalURL: finalURL.String(),
		}
		headBytes, _ := json.Marshal(head)
		if err := sendFrame(streamID, muxFrameHead, headBytes); err != nil {
			return
		}
		buf := make([]byte, 32*1024)
		for {
			if sCtx.Err() != nil {
				return
			}
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if err := sendFrame(streamID, muxFrameBodyDown, buf[:n]); err != nil {
					return
				}
			}
			if rerr != nil {
				break
			}
		}
		_ = sendFrame(streamID, muxFrameBodyDown, nil)
	}

	// streamBodyReader pulls from bodyChunks chan + presents an io.Reader to
	// http.NewRequestWithContext. nil chunk = EOF terminator.
	newBodyReader := func(ch chan []byte) io.ReadCloser {
		return &chanBodyReader{ch: ch}
	}

	// Cleanup all streams on WS close — cancel each context, close each body
	// channel, so all per-stream goroutines unwind.
	cleanupAll := func() {
		streamsMu.Lock()
		ids := make([]uint32, 0, len(streams))
		for id := range streams {
			ids = append(ids, id)
		}
		streamsMu.Unlock()
		for _, id := range ids {
			s := getStream(id)
			if s == nil {
				continue
			}
			if s.cancel != nil {
				s.cancel()
			}
			if s.bodyChunks != nil {
				// Drain + close (non-blocking; close panics if double-close, so guard).
				func() {
					defer func() { _ = recover() }()
					close(s.bodyChunks)
				}()
			}
		}
	}
	defer cleanupAll()

	for {
		if ctx.Err() != nil {
			return
		}
		mt, frame, err := ws.ReadMessage()
		if err != nil {
			log.Printf("mux: read loop exit: %v", err)
			return
		}
		if mt != websocket.BinaryMessage || len(frame) < 5 {
			continue
		}
		streamID := binary.BigEndian.Uint32(frame[:4])
		frameType := frame[4]
		payload := frame[5:]

		switch frameType {
		case muxFrameEnvelope:
			sCtx, sCancel := context.WithCancel(ctx)
			ch := make(chan []byte, 16)
			s := &muxStream{
				id:         streamID,
				bodyChunks: ch,
				cancel:     sCancel,
			}
			addStream(streamID, s)
			envCopy := append([]byte(nil), payload...)
			body := newBodyReader(ch)
			go handle(streamID, envCopy, body, sCtx, sCancel)

		case muxFrameBodyUp:
			s := getStream(streamID)
			if s == nil || s.bodyChunks == nil {
				continue
			}
			if len(payload) == 0 {
				// EOF terminator — close the channel so the body reader returns io.EOF.
				func() {
					defer func() { _ = recover() }()
					s.bodyChunks <- nil // sentinel
				}()
			} else {
				pcopy := append([]byte(nil), payload...)
				// Blocking send. If buffer is full, the read loop pauses momentarily —
				// other streams keep their data buffered on the WebSocket side.
				select {
				case s.bodyChunks <- pcopy:
				case <-ctx.Done():
					return
				}
			}

		case muxFrameCancel:
			s := getStream(streamID)
			if s == nil {
				continue
			}
			if s.cancel != nil {
				s.cancel()
			}
		}
	}
}

// chanBodyReader presents a chan []byte as an io.ReadCloser. nil chunk = EOF.
type chanBodyReader struct {
	ch     chan []byte
	cur    []byte
	closed bool
}

func (r *chanBodyReader) Read(p []byte) (int, error) {
	if r.closed {
		return 0, io.EOF
	}
	for len(r.cur) == 0 {
		chunk, ok := <-r.ch
		if !ok || chunk == nil {
			r.closed = true
			return 0, io.EOF
		}
		r.cur = chunk
	}
	n := copy(p, r.cur)
	r.cur = r.cur[n:]
	return n, nil
}

func (r *chanBodyReader) Close() error {
	r.closed = true
	return nil
}

func parsePortNumber(port string) (uint16, error) {
	var p int
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("invalid port %q", port)
		}
		p = p*10 + int(ch-'0')
		if p > 0xffff {
			return 0, fmt.Errorf("invalid port %q", port)
		}
	}
	if p == 0 {
		return 0, fmt.Errorf("invalid port %q", port)
	}
	return uint16(p), nil
}

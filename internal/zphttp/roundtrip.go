package zphttp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/socks5"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
	"github.com/gosuda/zeroproxy/internal/zpiso"
	"golang.org/x/net/http2"
)

type StreamMux interface {
	OpenStream(context.Context) (net.Conn, error)
}

type TabState struct {
	TabID              string
	CookieJar          *cookiejar.Jar
	StreamIsolationKey []byte
}

type Engine struct {
	Mux StreamMux

	mu sync.Mutex
	h1 map[h2Key][]*h1Conn
	h2 map[h2Key]*h2Conn
}

const TargetUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

const (
	browserIdleConnTimeout = 90 * time.Second
	maxH1IdleConnsPerKey   = 6
)

var fetchTLSProtocols = [...]string{utlskernel.ALPNHTTP2, utlskernel.ALPNHTTP1}
var http1TLSProtocols = [...]string{utlskernel.ALPNHTTP1}

type RequestPolicy struct {
	Credentials     string
	Mode            string
	Redirect        string
	Referrer        string
	ReferrerPolicy  string
	DocumentURL     *url.URL
	DocumentRequest bool
}

func (e *Engine) RoundTrip(ctx context.Context, req *http.Request, target *url.URL, tab *TabState) (*http.Response, error) {
	if target == nil || target.Hostname() == "" {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: missing target host")
	}
	wireReq, err := BuildHTTP1Request(req, target, jar(tab))
	if err != nil {
		return nil, err
	}
	key := h2PoolKey(target, tab)
	if target.Scheme == "https" {
		if hc := e.reserveH2(key); hc != nil {
			return e.roundTripHTTP2(ctx, hc, wireReq)
		}
	}
	if pc := e.reserveH1(key); pc != nil {
		resp, err := e.roundTripHTTP1(pc, wireReq)
		if err == nil || !canRetryHTTP1(wireReq) {
			return resp, err
		}
	}
	tc, err := e.dialTarget(ctx, target, tab, fetchTLSProtocols[:])
	if err != nil {
		return nil, err
	}
	return e.roundTripConn(ctx, tc, wireReq, key)
}

func (e *Engine) roundTripConn(ctx context.Context, tc *targetConn, wireReq *http.Request, key h2Key) (*http.Response, error) {
	if tc.protocol == utlskernel.ALPNHTTP2 {
		hc, err := newH2Conn(tc.conn)
		if err != nil {
			_ = tc.conn.Close()
			return nil, fmt.Errorf("TARGET_CONNECT_FAILED: %w", err)
		}
		hc = e.adoptH2(key, hc)
		return e.roundTripHTTP2(ctx, hc, wireReq)
	}
	return e.roundTripHTTP1(&h1Conn{key: key, conn: tc.conn, br: bufio.NewReader(tc.conn)}, wireReq)
}

func (e *Engine) roundTripHTTP1(pc *h1Conn, wireReq *http.Request) (*http.Response, error) {
	if err := wireReq.Write(pc.conn); err != nil {
		e.closeH1(pc)
		return nil, err
	}
	resp, err := http.ReadResponse(pc.br, wireReq)
	if err != nil {
		e.closeH1(pc)
		return nil, err
	}
	if resp.Body == nil {
		if shouldReuseHTTP1(wireReq, resp) {
			e.releaseH1(pc)
		} else {
			e.closeH1(pc)
		}
		return resp, nil
	}
	resp.Body = &bodyWithH1Reuse{
		ReadCloser: resp.Body,
		engine:     e,
		conn:       pc,
		reusable:   shouldReuseHTTP1(wireReq, resp),
		sawEOF:     responseBodyAlreadyEOF(wireReq, resp),
	}
	return resp, nil
}

func newH2Conn(conn net.Conn) (*h2Conn, error) {
	tr := &http2.Transport{DisableCompression: true, IdleConnTimeout: browserIdleConnTimeout}
	cc, err := tr.NewClientConn(conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if !cc.ReserveNewRequest() {
		_ = cc.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("http2 client connection cannot accept request")
	}
	return &h2Conn{cc: cc, conn: conn}, nil
}

func (e *Engine) roundTripHTTP2(ctx context.Context, hc *h2Conn, wireReq *http.Request) (*http.Response, error) {
	h2Req := wireReq.WithContext(ctx)
	h2Req.Proto = "HTTP/2.0"
	h2Req.ProtoMajor = 2
	h2Req.ProtoMinor = 0
	h2Req.Header.Del("Host")
	resp, err := hc.cc.RoundTrip(h2Req)
	if err != nil {
		if hc.pooled {
			e.forgetH2IfClosing(hc)
		} else {
			hc.close()
		}
		return nil, err
	}
	if !hc.pooled {
		if resp.Body == nil {
			hc.close()
		} else {
			resp.Body = bodyWithH2Close{ReadCloser: resp.Body, hc: hc}
		}
	}
	return resp, nil
}

// DialTarget opens a single target TCP/TLS connection through the required
// WebSocket → yamux → Tor SOCKS5 DOMAINNAME path. It never uses net.Dial or
// http.Transport for target egress. The exported path remains HTTP/1.1-only so
// WebSocket upgrade callers never negotiate h2 accidentally.
func (e *Engine) DialTarget(ctx context.Context, target *url.URL, tab *TabState) (net.Conn, error) {
	tc, err := e.dialTarget(ctx, target, tab, http1TLSProtocols[:])
	if err != nil {
		return nil, err
	}
	return tc.conn, nil
}

func (e *Engine) dialTarget(ctx context.Context, target *url.URL, tab *TabState, tlsProtocols []string) (*targetConn, error) {
	if e == nil || e.Mux == nil {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: transport not initialized")
	}
	if target == nil || target.Hostname() == "" {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: missing target host")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	host := canonicalHost(target)
	port := canonicalPort(target)
	var key []byte
	if tab != nil {
		key = tab.StreamIsolationKey
	}
	token := zpiso.Token(key, host)
	stream, err := e.Mux.OpenStream(ctx)
	if err != nil {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: %w", err)
	}
	if err := socks5.ConnectDomain(ctx, stream, socks5.Options{Host: host, Port: port, Username: token, Password: "zp"}); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: %w", err)
	}
	if target.Scheme == "https" {
		tlsConn, protocol, err := utlskernel.WrapWithALPN(ctx, stream, host, tlsProtocols)
		if err != nil {
			return nil, fmt.Errorf("TLS_HANDSHAKE_FAILED: %w", err)
		}
		if protocol == "" {
			protocol = utlskernel.ALPNHTTP1
		}
		return &targetConn{conn: tlsConn, protocol: protocol}, nil
	}
	return &targetConn{conn: stream, protocol: utlskernel.ALPNHTTP1}, nil
}

func BuildHTTP1Request(src *http.Request, target *url.URL, jar *cookiejar.Jar) (*http.Request, error) {
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	policy := policyFromRequest(src)
	method := "GET"
	var body io.ReadCloser
	var contentLength int64
	if src != nil {
		method = src.Method
		body = src.Body
		contentLength = src.ContentLength
	}
	if method == "" {
		method = "GET"
	}
	u := *target
	wire := &http.Request{Method: method, URL: &u, Header: make(http.Header), Body: body, ContentLength: contentLength, Host: canonicalAuthority(target), Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}
	if src != nil {
		for name, vals := range src.Header {
			lower := strings.ToLower(name)
			if headers.HiddenHeader(name) || strings.HasPrefix(lower, "x-zp-") || lower == "host" || lower == "cookie" || lower == "origin" || lower == "referer" || lower == "accept-encoding" {
				continue
			}
			for _, v := range vals {
				wire.Header.Add(name, v)
			}
		}
	}
	wire.Header.Set("Host", canonicalAuthority(target))
	wire.Host = canonicalAuthority(target)
	wire.Header.Set("User-Agent", TargetUserAgent)
	wire.Header.Set("Accept-Encoding", "identity")
	if jar != nil && policyAllowsCookies(policy, target) {
		cookieCtx := cookiejar.RequestContext{
			TopLevelURL:          policy.DocumentURL,
			Method:               method,
			Credentials:          policy.Credentials,
			IsTopLevelNavigation: policy.DocumentRequest || policy.Mode == "navigate",
		}
		if cookies := jar.CookiesForRequest(target, true, cookieCtx); len(cookies) > 0 {
			parts := make([]string, 0, len(cookies))
			for _, c := range cookies {
				parts = append(parts, c.Name+"="+c.Value)
			}
			wire.Header.Set("Cookie", strings.Join(parts, "; "))
		}
	}
	if origin := originHeader(method, target, policy); origin != "" {
		wire.Header.Set("Origin", origin)
	}
	if ref := refererHeader(target, policy); ref != "" {
		wire.Header.Set("Referer", ref)
	}
	return wire, nil
}

func policyFromRequest(req *http.Request) RequestPolicy {
	p := RequestPolicy{Credentials: "include", Mode: "navigate", Redirect: "follow", Referrer: "about:client", ReferrerPolicy: "strict-origin-when-cross-origin"}
	if req == nil {
		return p
	}
	if v := strings.ToLower(strings.TrimSpace(req.Header.Get("X-Zp-Fetch-Credentials"))); v != "" {
		p.Credentials = v
	}
	if v := strings.ToLower(strings.TrimSpace(req.Header.Get("X-Zp-Fetch-Mode"))); v != "" {
		p.Mode = v
	}
	if v := strings.ToLower(strings.TrimSpace(req.Header.Get("X-Zp-Fetch-Redirect"))); v != "" {
		p.Redirect = v
	}
	if v := strings.TrimSpace(req.Header.Get("X-Zp-Fetch-Referrer")); v != "" {
		p.Referrer = v
	}
	if v := strings.ToLower(strings.TrimSpace(req.Header.Get("X-Zp-Fetch-Referrer-Policy"))); v != "" {
		p.ReferrerPolicy = v
	}
	if raw := strings.TrimSpace(req.Header.Get("X-Zp-Document-Url")); raw != "" {
		if u, err := url.Parse(raw); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			p.DocumentURL = u
		}
	}
	p.DocumentRequest = req.Header.Get("X-Zp-Document-Request") == "1"
	return p
}

func policyAllowsCookies(p RequestPolicy, target *url.URL) bool {
	switch p.Credentials {
	case "omit":
		return false
	case "same-origin":
		source := p.DocumentURL
		if source == nil {
			return true
		}
		return sameOrigin(source, target)
	default:
		return true
	}
}

func originHeader(method string, target *url.URL, p RequestPolicy) string {
	source := p.DocumentURL
	if source == nil {
		source = target
	}
	origin := source.Scheme + "://" + canonicalAuthority(source)
	if method != "GET" && method != "HEAD" {
		return origin
	}
	if !sameOrigin(source, target) && (p.Mode == "cors" || p.Mode == "no-cors") {
		return origin
	}
	return ""
}

func refererHeader(target *url.URL, p RequestPolicy) string {
	source := p.DocumentURL
	if ref := strings.TrimSpace(p.Referrer); ref != "" && ref != "about:client" {
		if ref == "no-referrer" {
			return ""
		}
		if u, err := url.Parse(ref); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			source = u
		}
	}
	if source == nil {
		return ""
	}
	if source.Scheme == "https" && target.Scheme == "http" && (p.ReferrerPolicy == "" || p.ReferrerPolicy == "strict-origin-when-cross-origin" || p.ReferrerPolicy == "no-referrer-when-downgrade") {
		return ""
	}
	switch p.ReferrerPolicy {
	case "no-referrer":
		return ""
	case "origin":
		return source.Scheme + "://" + canonicalAuthority(source) + "/"
	case "same-origin":
		if !sameOrigin(source, target) {
			return ""
		}
		return referrerURLString(source)
	case "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin":
		if sameOrigin(source, target) && p.ReferrerPolicy != "strict-origin" {
			return referrerURLString(source)
		}
		return source.Scheme + "://" + canonicalAuthority(source) + "/"
	case "unsafe-url", "no-referrer-when-downgrade", "":
		return referrerURLString(source)
	default:
		if sameOrigin(source, target) {
			return referrerURLString(source)
		}
		return source.Scheme + "://" + canonicalAuthority(source) + "/"
	}
}

func referrerURLString(u *url.URL) string {
	if u == nil {
		return ""
	}
	v := *u
	v.User = nil
	v.Fragment = ""
	return v.String()
}

func sameOrigin(a, b *url.URL) bool {
	return a != nil && b != nil && a.Scheme == b.Scheme && canonicalAuthority(a) == canonicalAuthority(b)
}

func jar(tab *TabState) *cookiejar.Jar {
	if tab == nil {
		return nil
	}
	return tab.CookieJar
}

func h2PoolKey(target *url.URL, tab *TabState) h2Key {
	host := canonicalHost(target)
	var key []byte
	tabID := ""
	if tab != nil {
		key = tab.StreamIsolationKey
		tabID = tab.TabID
	}
	return h2Key{authority: canonicalAuthority(target), isolation: zpiso.Token(key, host), tabID: tabID}
}

func (e *Engine) reserveH1(key h2Key) *h1Conn {
	e.mu.Lock()
	defer e.mu.Unlock()
	for {
		if e.h1 == nil || len(e.h1[key]) == 0 {
			return nil
		}
		pool := e.h1[key]
		last := len(pool) - 1
		pc := pool[last]
		pool[last] = nil
		if last == 0 {
			delete(e.h1, key)
		} else {
			e.h1[key] = pool[:last]
		}
		if pc.closed {
			continue
		}
		if pc.idleTimer != nil {
			pc.idleTimer.Stop()
			pc.idleTimer = nil
		}
		pc.idle = false
		return pc
	}
}

func (e *Engine) releaseH1(pc *h1Conn) {
	e.mu.Lock()
	if pc.closed {
		e.mu.Unlock()
		return
	}
	if e.h1 == nil {
		e.h1 = make(map[h2Key][]*h1Conn)
	}
	pool := e.h1[pc.key]
	if len(pool) >= maxH1IdleConnsPerKey {
		pc.closed = true
		pc.idle = false
		e.mu.Unlock()
		_ = pc.conn.Close()
		return
	}
	pc.idle = true
	pc.idleTimer = time.AfterFunc(browserIdleConnTimeout, func() { e.closeIdleH1(pc) })
	e.h1[pc.key] = append(pool, pc)
	e.mu.Unlock()
}

func (e *Engine) closeH1(pc *h1Conn) {
	e.mu.Lock()
	if pc.closed {
		e.mu.Unlock()
		return
	}
	pc.closed = true
	pc.idle = false
	if pc.idleTimer != nil {
		pc.idleTimer.Stop()
		pc.idleTimer = nil
	}
	if e.h1 != nil {
		pool := e.h1[pc.key]
		for i, idle := range pool {
			if idle == pc {
				copy(pool[i:], pool[i+1:])
				pool[len(pool)-1] = nil
				if len(pool) == 1 {
					delete(e.h1, pc.key)
				} else {
					e.h1[pc.key] = pool[:len(pool)-1]
				}
				break
			}
		}
	}
	e.mu.Unlock()
	_ = pc.conn.Close()
}

func (e *Engine) closeIdleH1(pc *h1Conn) {
	e.mu.Lock()
	if pc.closed || !pc.idle {
		e.mu.Unlock()
		return
	}
	pc.closed = true
	pc.idle = false
	if pc.idleTimer != nil {
		pc.idleTimer.Stop()
		pc.idleTimer = nil
	}
	if e.h1 != nil {
		pool := e.h1[pc.key]
		for i, idle := range pool {
			if idle == pc {
				copy(pool[i:], pool[i+1:])
				pool[len(pool)-1] = nil
				if len(pool) == 1 {
					delete(e.h1, pc.key)
				} else {
					e.h1[pc.key] = pool[:len(pool)-1]
				}
				break
			}
		}
	}
	e.mu.Unlock()
	_ = pc.conn.Close()
}

func (e *Engine) reserveH2(key h2Key) *h2Conn {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.h2 == nil {
		return nil
	}
	hc := e.h2[key]
	if hc == nil {
		return nil
	}
	if hc.cc.ReserveNewRequest() {
		return hc
	}
	st := hc.cc.State()
	if st.Closed || st.Closing {
		delete(e.h2, key)
		if st.StreamsActive == 0 {
			hc.close()
		}
	}
	return nil
}

func (e *Engine) adoptH2(key h2Key, hc *h2Conn) *h2Conn {
	hc.key = key
	e.mu.Lock()
	if e.h2 == nil {
		e.h2 = make(map[h2Key]*h2Conn)
	}
	if old := e.h2[key]; old != nil {
		if old.cc.ReserveNewRequest() {
			e.mu.Unlock()
			hc.close()
			return old
		}
		st := old.cc.State()
		if st.Closed || st.Closing {
			delete(e.h2, key)
			if st.StreamsActive == 0 {
				old.close()
			}
		} else {
			e.mu.Unlock()
			hc.cc.SetDoNotReuse()
			return hc
		}
	}
	hc.pooled = true
	e.h2[key] = hc
	e.mu.Unlock()
	return hc
}

func (e *Engine) forgetH2IfClosing(hc *h2Conn) {
	st := hc.cc.State()
	if !st.Closed && !st.Closing {
		return
	}
	e.mu.Lock()
	if e.h2 != nil && e.h2[hc.key] == hc {
		delete(e.h2, hc.key)
	}
	e.mu.Unlock()
	if st.StreamsActive == 0 {
		hc.close()
	}
}

func shouldReuseHTTP1(req *http.Request, resp *http.Response) bool {
	return req != nil && resp != nil && !req.Close && !resp.Close && responseBodyFramed(req, resp)
}

func canRetryHTTP1(req *http.Request) bool {
	if req == nil {
		return false
	}
	if req.Body != nil && req.Body != http.NoBody {
		return false
	}
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return true
	default:
		return false
	}
}

func responseBodyAlreadyEOF(req *http.Request, resp *http.Response) bool {
	if req != nil && req.Method == http.MethodHead {
		return true
	}
	if resp == nil {
		return false
	}
	return resp.ContentLength == 0 || (resp.StatusCode >= 100 && resp.StatusCode < 200) || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified
}

func responseBodyFramed(req *http.Request, resp *http.Response) bool {
	if responseBodyAlreadyEOF(req, resp) || resp.ContentLength >= 0 {
		return true
	}
	for _, te := range resp.TransferEncoding {
		if strings.EqualFold(te, "chunked") {
			return true
		}
	}
	return false
}

func canonicalHost(u *url.URL) string { return strings.TrimSuffix(strings.ToLower(u.Hostname()), ".") }
func canonicalAuthority(u *url.URL) string {
	h := canonicalHost(u)
	p := u.Port()
	if p == "" || (u.Scheme == "http" && p == "80") || (u.Scheme == "https" && p == "443") {
		return h
	}
	return net.JoinHostPort(h, p)
}
func canonicalPort(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "http" {
		return "80"
	}
	return "443"
}

type targetConn struct {
	conn     net.Conn
	protocol string
}

type h1Conn struct {
	key       h2Key
	conn      net.Conn
	br        *bufio.Reader
	idleTimer *time.Timer
	closed    bool
	idle      bool
}

type h2Key struct {
	authority string
	isolation string
	tabID     string
}

type h2Conn struct {
	key    h2Key
	cc     *http2.ClientConn
	conn   net.Conn
	pooled bool
}

func (hc *h2Conn) close() {
	_ = hc.cc.Close()
	_ = hc.conn.Close()
}

type bodyWithH1Reuse struct {
	io.ReadCloser
	engine   *Engine
	conn     *h1Conn
	reusable bool
	sawEOF   bool
	once     sync.Once
	closeErr error
}

func (b *bodyWithH1Reuse) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.sawEOF = true
	}
	return n, err
}

func (b *bodyWithH1Reuse) Close() error {
	b.once.Do(func() {
		b.closeErr = b.ReadCloser.Close()
		if b.reusable && b.sawEOF && b.conn.br.Buffered() == 0 {
			b.engine.releaseH1(b.conn)
			return
		}
		b.engine.closeH1(b.conn)
	})
	return b.closeErr
}

type bodyWithH2Close struct {
	io.ReadCloser
	hc *h2Conn
}

func (b bodyWithH2Close) Close() error {
	err := b.ReadCloser.Close()
	b.hc.close()
	return err
}

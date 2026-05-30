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
	// ChallengeCompat is the per-tab, default-OFF arm opt-in for Cloudflare
	// challenge compatibility mode.
	//
	// SECURITY INVARIANT (birth-only): this field MUST be set ONLY at tab birth
	// and never mutated afterwards, because the arm signal arrives over the
	// page-forgeable X-Zp-Challenge-Compat-Arm request header. Birth-only
	// semantics (the existing-tab early return in wasm-kernel tabFromValues) are
	// precisely what stop a proxied page from self-arming a live tab; any future
	// re-arm of a running tab would turn that forgeable header into an active
	// self-arm primitive. Being set-once also makes the lock-free read in jsHTTP
	// race-free by construction, but the security property — not the race
	// property — is the load-bearing reason it is immutable.
	ChallengeCompat bool
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
	targetCHUA             = `"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"`
	targetCHUAFullList     = `"Chromium";v="134.0.0.0", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="134.0.0.0"`
)

var (
	fetchTLSProtocols = [...]string{utlskernel.ALPNHTTP2, utlskernel.ALPNHTTP1}
	http1TLSProtocols = [...]string{utlskernel.ALPNHTTP1}
)

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
	if err := e.validateDialTarget(target); err != nil {
		return nil, err
	}
	host := canonicalHost(target)
	token := zpiso.Token(isolationKey(tab), host)
	stream, err := e.Mux.OpenStream(ctx)
	if err != nil {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: %w", err)
	}
	if err := socks5.ConnectDomain(ctx, stream, socks5.Options{Host: host, Port: canonicalPort(target), Username: token, Password: "zp"}); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: %w", err)
	}
	if target.Scheme == "https" {
		return wrapTargetTLS(ctx, stream, host, tlsProtocols)
	}
	return &targetConn{conn: stream, protocol: utlskernel.ALPNHTTP1}, nil
}

// validateDialTarget runs dialTarget's fail-closed preconditions: the transport
// must be wired, the target must carry a host, and the scheme must be http(s).
func (e *Engine) validateDialTarget(target *url.URL) error {
	if e == nil || e.Mux == nil {
		return fmt.Errorf("TARGET_CONNECT_FAILED: transport not initialized")
	}
	if target == nil || target.Hostname() == "" {
		return fmt.Errorf("TARGET_CONNECT_FAILED: missing target host")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	return nil
}

// isolationKey returns the per-tab stream-isolation key, or nil for a nil tab.
func isolationKey(tab *TabState) []byte {
	if tab == nil {
		return nil
	}
	return tab.StreamIsolationKey
}

// wrapTargetTLS completes the TLS handshake over an established SOCKS5 stream,
// defaulting the negotiated ALPN to HTTP/1.1 when the peer offers none.
func wrapTargetTLS(ctx context.Context, stream net.Conn, host string, tlsProtocols []string) (*targetConn, error) {
	tlsConn, protocol, err := utlskernel.WrapWithALPN(ctx, stream, host, tlsProtocols)
	if err != nil {
		return nil, fmt.Errorf("TLS_HANDSHAKE_FAILED: %w", err)
	}
	if protocol == "" {
		protocol = utlskernel.ALPNHTTP1
	}
	return &targetConn{conn: tlsConn, protocol: protocol}, nil
}

func BuildHTTP1Request(src *http.Request, target *url.URL, jar *cookiejar.Jar) (*http.Request, error) {
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	policy := policyFromRequest(src)
	method, body, contentLength := requestMethodAndBody(src)
	u := *target
	authority := canonicalAuthority(target)
	wire := &http.Request{Method: method, URL: &u, Header: make(http.Header), Body: body, ContentLength: contentLength, Host: authority, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}

	// Order is load-bearing: forward the page's headers FIRST, then force-set
	// the spoofed target identity so an attacker-supplied Host/UA/client-hint/
	// Accept-Encoding value is always overwritten, never trusted.
	copyForwardableHeaders(wire.Header, src)
	wire.Header.Set("Host", authority)
	wire.Host = authority
	applyTargetIdentity(wire.Header)

	applyCookieHeader(wire.Header, jar, policy, target, method)
	if origin := originHeader(method, target, policy); origin != "" {
		wire.Header.Set("Origin", origin)
	}
	if ref := refererHeader(target, policy); ref != "" {
		wire.Header.Set("Referer", ref)
	}
	return wire, nil
}

// requestMethodAndBody extracts the wire method, body, and content length from
// the source request, defaulting an absent or empty method to GET.
func requestMethodAndBody(src *http.Request) (string, io.ReadCloser, int64) {
	if src == nil || src.Method == "" {
		return "GET", srcBody(src), srcContentLength(src)
	}
	return src.Method, src.Body, src.ContentLength
}

func srcBody(src *http.Request) io.ReadCloser {
	if src == nil {
		return nil
	}
	return src.Body
}

func srcContentLength(src *http.Request) int64 {
	if src == nil {
		return 0
	}
	return src.ContentLength
}

// copyForwardableHeaders copies the page-supplied headers onto dst, stripping
// the internal/hop and self-set headers: HiddenHeader, X-Zp-* internal headers,
// and Host/Cookie/Origin/Referer/Accept-Encoding (all force-set later).
func copyForwardableHeaders(dst http.Header, src *http.Request) {
	if src == nil {
		return
	}
	for name, vals := range src.Header {
		if !forwardableHeader(name) {
			continue
		}
		for _, v := range vals {
			dst.Add(name, v)
		}
	}
}

func forwardableHeader(name string) bool {
	if headers.HiddenHeader(name) {
		return false
	}
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "x-zp-") {
		return false
	}
	switch lower {
	case "host", "cookie", "origin", "referer", "accept-encoding":
		return false
	default:
		return true
	}
}

// applyTargetIdentity force-sets the spoofed browser identity: the target
// User-Agent, the full Sec-CH-UA client-hint set, and Accept-Encoding:identity.
func applyTargetIdentity(h http.Header) {
	h.Set("User-Agent", TargetUserAgent)
	setTargetClientHints(h)
	h.Set("Accept-Encoding", "identity")
}

// applyCookieHeader projects the cookie jar onto the wire request when the
// fetch credentials policy permits, preserving the credential/SameSite context.
func applyCookieHeader(h http.Header, jar *cookiejar.Jar, policy RequestPolicy, target *url.URL, method string) {
	if jar == nil || !policyAllowsCookies(policy, target) {
		return
	}
	cookieCtx := cookiejar.RequestContext{
		TopLevelURL:          policy.DocumentURL,
		Method:               method,
		Credentials:          policy.Credentials,
		IsTopLevelNavigation: policy.DocumentRequest || policy.Mode == "navigate",
	}
	cookies := jar.CookiesForRequest(target, true, cookieCtx)
	if len(cookies) == 0 {
		return
	}
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		parts = append(parts, c.Name+"="+c.Value)
	}
	h.Set("Cookie", strings.Join(parts, "; "))
}

func setTargetClientHints(h http.Header) {
	for _, name := range []string{
		"Sec-CH-UA", "Sec-CH-UA-Mobile", "Sec-CH-UA-Platform", "Sec-CH-UA-Arch",
		"Sec-CH-UA-Bitness", "Sec-CH-UA-Full-Version", "Sec-CH-UA-Full-Version-List",
		"Sec-CH-UA-Model", "Sec-CH-UA-Platform-Version",
		"UA", "UA-Mobile", "UA-Platform", "UA-Arch", "UA-Bitness", "UA-Full-Version",
		"UA-Full-Version-List", "UA-Model", "UA-Platform-Version",
	} {
		h.Del(name)
	}
	h.Set("Sec-CH-UA", targetCHUA)
	h.Set("Sec-CH-UA-Mobile", "?0")
	h.Set("Sec-CH-UA-Platform", `"Windows"`)
	h.Set("Sec-CH-UA-Arch", `"x86"`)
	h.Set("Sec-CH-UA-Bitness", `"64"`)
	h.Set("Sec-CH-UA-Full-Version", `"134.0.0.0"`)
	h.Set("Sec-CH-UA-Full-Version-List", targetCHUAFullList)
	h.Set("Sec-CH-UA-Model", `""`)
	h.Set("Sec-CH-UA-Platform-Version", `"10.0.0"`)
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
	p.DocumentURL = parseDocumentURL(req.Header.Get("X-Zp-Document-Url"))
	p.DocumentRequest = req.Header.Get("X-Zp-Document-Request") == "1"
	return p
}

// parseDocumentURL parses the page-forgeable X-Zp-Document-Url header,
// fail-closed: a blank, unparseable, or non-http(s) value yields nil so a
// javascript:/data: source can never be trusted as the document origin.
func parseDocumentURL(raw string) *url.URL {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil
	}
	return u
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
	source := resolveReferrerSource(p)
	if source == nil {
		return ""
	}
	if downgradeSuppressed(source, target, p.ReferrerPolicy) {
		return ""
	}
	return applyReferrerPolicy(source, target, p.ReferrerPolicy)
}

// resolveReferrerSource picks the referrer source URL. It starts from the
// document URL and lets an explicit X-Zp-Fetch-Referrer override it, fail-closed:
// an explicit "no-referrer" (or a non-http(s) override that leaves the source
// nil) yields no source so the caller emits no Referer.
func resolveReferrerSource(p RequestPolicy) *url.URL {
	source := p.DocumentURL
	ref := strings.TrimSpace(p.Referrer)
	if ref == "" || ref == "about:client" {
		return source
	}
	if ref == "no-referrer" {
		return nil
	}
	if u, err := url.Parse(ref); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
		return u
	}
	return source
}

// downgradeSuppressed reports the fail-closed https->http referer downgrade
// guard: an https source navigating to an http target leaks no Referer under
// the default and *-when-downgrade policies.
func downgradeSuppressed(source, target *url.URL, policy string) bool {
	if source.Scheme != "https" || target.Scheme != "http" {
		return false
	}
	return policy == "" || policy == "strict-origin-when-cross-origin" || policy == "no-referrer-when-downgrade"
}

// applyReferrerPolicy maps a (resolved, non-downgraded) source through the
// referrer-policy state machine to the emitted Referer value.
func applyReferrerPolicy(source, target *url.URL, policy string) string {
	switch policy {
	case "no-referrer":
		return ""
	case "origin":
		return referrerOrigin(source)
	case "same-origin":
		return referrerIfSameOrigin(source, target)
	case "unsafe-url", "no-referrer-when-downgrade", "":
		return referrerURLString(source)
	default:
		return referrerWithOriginFallback(source, target, policy)
	}
}

// referrerIfSameOrigin emits the full referrer only for a same-origin target,
// implementing the "same-origin" policy (empty cross-site).
func referrerIfSameOrigin(source, target *url.URL) string {
	if !sameOrigin(source, target) {
		return ""
	}
	return referrerURLString(source)
}

// referrerWithOriginFallback handles the strict-origin family and any unknown
// policy: full referrer same-origin (except "strict-origin", which is always
// origin-only), bare origin cross-site.
func referrerWithOriginFallback(source, target *url.URL, policy string) string {
	if sameOrigin(source, target) && policy != "strict-origin" {
		return referrerURLString(source)
	}
	return referrerOrigin(source)
}

// referrerOrigin renders the bare scheme://authority/ origin form used by the
// origin-only referrer policies.
func referrerOrigin(source *url.URL) string {
	return source.Scheme + "://" + canonicalAuthority(source) + "/"
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
	e.retireH1Locked(pc)
	e.mu.Unlock()
	_ = pc.conn.Close()
}

func (e *Engine) closeIdleH1(pc *h1Conn) {
	e.mu.Lock()
	if pc.closed || !pc.idle {
		e.mu.Unlock()
		return
	}
	e.retireH1Locked(pc)
	e.mu.Unlock()
	_ = pc.conn.Close()
}

// retireH1Locked marks pc closed, stops its idle timer, and unlinks it from the
// idle pool. The caller MUST hold e.mu and is responsible for closing pc.conn
// after unlocking. It does NOT close the connection itself.
func (e *Engine) retireH1Locked(pc *h1Conn) {
	pc.closed = true
	pc.idle = false
	if pc.idleTimer != nil {
		pc.idleTimer.Stop()
		pc.idleTimer = nil
	}
	e.removeFromH1PoolLocked(pc)
}

// removeFromH1PoolLocked unlinks pc from its idle-pool slice, deleting the key
// when the slice empties. The caller MUST hold e.mu.
func (e *Engine) removeFromH1PoolLocked(pc *h1Conn) {
	if e.h1 == nil {
		return
	}
	pool := e.h1[pc.key]
	for i, idle := range pool {
		if idle != pc {
			continue
		}
		copy(pool[i:], pool[i+1:])
		pool[len(pool)-1] = nil
		if len(pool) == 1 {
			delete(e.h1, pc.key)
		} else {
			e.h1[pc.key] = pool[:len(pool)-1]
		}
		return
	}
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
	e.evictH2IfClosingLocked(key, hc)
	return nil
}

func (e *Engine) adoptH2(key h2Key, hc *h2Conn) *h2Conn {
	hc.key = key
	e.mu.Lock()
	if e.h2 == nil {
		e.h2 = make(map[h2Key]*h2Conn)
	}
	old := e.h2[key]
	if old != nil && old.cc.ReserveNewRequest() {
		e.mu.Unlock()
		hc.close()
		return old
	}
	if old != nil && !e.evictH2IfClosingLocked(key, old) {
		e.mu.Unlock()
		hc.cc.SetDoNotReuse()
		return hc
	}
	hc.pooled = true
	e.h2[key] = hc
	e.mu.Unlock()
	return hc
}

// evictH2IfClosingLocked drops conn from the pool under key when its underlying
// client connection is closed/closing, closing it if it has no active streams.
// It reports whether the entry was evicted (true) or left in place because it is
// still live (false). The caller MUST hold e.mu.
func (e *Engine) evictH2IfClosingLocked(key h2Key, conn *h2Conn) bool {
	st := conn.cc.State()
	if !st.Closed && !st.Closing {
		return false
	}
	delete(e.h2, key)
	if st.StreamsActive == 0 {
		conn.close()
	}
	return true
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

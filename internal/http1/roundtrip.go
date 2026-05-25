package http1

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
	h2 map[h2Key]*h2Conn
}

const TargetUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

const h2IdleConnTimeout = 90 * time.Second

var fetchTLSProtocols = [...]string{utlskernel.ALPNHTTP2, utlskernel.ALPNHTTP1}
var http1TLSProtocols = [...]string{utlskernel.ALPNHTTP1}

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
	return roundTripHTTP1(tc.conn, wireReq)
}

func roundTripHTTP1(rw net.Conn, wireReq *http.Request) (*http.Response, error) {
	if err := wireReq.Write(rw); err != nil {
		_ = rw.Close()
		return nil, err
	}
	br := bufio.NewReader(rw)
	resp, err := http.ReadResponse(br, wireReq)
	if err != nil {
		_ = rw.Close()
		return nil, err
	}
	resp.Body = bodyWithConnClose{ReadCloser: resp.Body, conn: rw}
	return resp, nil
}

func newH2Conn(conn net.Conn) (*h2Conn, error) {
	tr := &http2.Transport{DisableCompression: true, IdleConnTimeout: h2IdleConnTimeout}
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
	if jar != nil {
		if cookies := jar.Cookies(target, true); len(cookies) > 0 {
			parts := make([]string, 0, len(cookies))
			for _, c := range cookies {
				parts = append(parts, c.Name+"="+c.Value)
			}
			wire.Header.Set("Cookie", strings.Join(parts, "; "))
		}
	}
	origin := target.Scheme + "://" + canonicalAuthority(target)
	if method != "GET" && method != "HEAD" {
		wire.Header.Set("Origin", origin)
	}
	wire.Header.Set("Referer", target.String())
	return wire, nil
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

type bodyWithConnClose struct {
	io.ReadCloser
	conn io.Closer
}

func (b bodyWithConnClose) Close() error {
	err := b.ReadCloser.Close()
	cerr := b.conn.Close()
	if err != nil {
		return err
	}
	return cerr
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

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

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/socks5"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
	"github.com/gosuda/zeroproxy/internal/zpiso"
)

type StreamMux interface {
	OpenStream(context.Context) (net.Conn, error)
}

type TabState struct {
	TabID              string
	CookieJar          *cookiejar.Jar
	StreamIsolationKey []byte
}

type Engine struct{ Mux StreamMux }

func (e *Engine) RoundTrip(ctx context.Context, req *http.Request, target *url.URL, tab *TabState) (*http.Response, error) {
	rw, err := e.DialTarget(ctx, target, tab)
	if err != nil {
		return nil, err
	}
	wireReq, err := BuildHTTP1Request(req, target, jar(tab))
	if err != nil {
		_ = rw.Close()
		return nil, err
	}
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

// DialTarget opens a single target TCP/TLS connection through the required
// WebSocket → yamux → Tor SOCKS5 DOMAINNAME path. It never uses net.Dial or
// http.Transport for target egress.
func (e *Engine) DialTarget(ctx context.Context, target *url.URL, tab *TabState) (net.Conn, error) {
	if e == nil || e.Mux == nil {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: transport not initialized")
	}
	if target == nil || target.Hostname() == "" {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: missing target host")
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
		tlsConn, err := utlskernel.Wrap(ctx, stream, host)
		if err != nil {
			return nil, fmt.Errorf("TLS_HANDSHAKE_FAILED: %w", err)
		}
		return tlsConn, nil
	}
	return stream, nil
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

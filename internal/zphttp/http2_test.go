package zphttp

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"golang.org/x/net/http2"
)

func TestHTTP2RoundTripUsesClientConn(t *testing.T) {
	client, server := net.Pipe()
	checked := make(chan error, 1)
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		defer server.Close()
		(&http2.Server{}).ServeConn(server, &http2.ServeConnOpts{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := validateHTTP2Request(r); err != nil {
				checked <- err
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			checked <- nil
			w.Header().Set("X-H2", "yes")
			_, _ = io.WriteString(w, "h2-ok")
		})})
	}()

	target, _ := url.Parse("https://example.com/h2?q=1")
	src, _ := http.NewRequest(http.MethodGet, target.String(), nil)
	src.Header.Set("Accept", "text/plain")
	src.Header.Set("X-ZP-Tab-Id", "secret")
	wireReq, err := BuildHTTP1Request(src, target, cookiejar.New())
	if err != nil {
		t.Fatal(err)
	}
	hc, err := newH2Conn(client)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := (&Engine{}).roundTripHTTP2(context.Background(), hc, wireReq)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-checked; err != nil {
		t.Fatal(err)
	}
	if resp.ProtoMajor != 2 || resp.Header.Get("X-H2") != "yes" {
		t.Fatalf("unexpected h2 response: proto=%s headers=%#v", resp.Proto, resp.Header)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "h2-ok" {
		t.Fatalf("body = %q", string(body))
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP/2 connection was not closed after unpooled response body close")
	}
}

func TestHTTP2KeepAliveReusesPooledClientConn(t *testing.T) {
	client, server := net.Pipe()
	paths := make(chan string, 2)
	go func() {
		defer server.Close()
		(&http2.Server{}).ServeConn(server, &http2.ServeConnOpts{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			paths <- r.URL.RequestURI()
			_, _ = io.WriteString(w, "h2-ok")
		})})
	}()

	engine := &Engine{}
	tab := &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	first, _ := url.Parse("https://example.com/first")
	hc, err := newH2Conn(client)
	if err != nil {
		t.Fatal(err)
	}
	hc = engine.adoptH2(h2PoolKey(first, tab), hc)
	t.Cleanup(hc.close)

	wireReq, err := BuildHTTP1Request(mustRequest(t, first), first, tab.CookieJar)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := engine.roundTripHTTP2(context.Background(), hc, wireReq)
	if err != nil {
		t.Fatal(err)
	}
	readAndCloseH2(t, resp)

	second := *first
	second.Path = "/second"
	resp, err = engine.RoundTrip(context.Background(), mustRequest(t, &second), &second, tab)
	if err != nil {
		t.Fatal(err)
	}
	readAndCloseH2(t, resp)

	if got := <-paths; got != "/first" {
		t.Fatalf("first path = %q", got)
	}
	if got := <-paths; got != "/second" {
		t.Fatalf("second path = %q", got)
	}
}

func mustRequest(t *testing.T, target *url.URL) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, target.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func readAndCloseH2(t *testing.T, resp *http.Response) {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "h2-ok" {
		t.Fatalf("body = %q", string(body))
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func validateHTTP2Request(r *http.Request) error {
	if r.ProtoMajor != 2 {
		return fmt.Errorf("proto = %s", r.Proto)
	}
	if r.Host != "example.com" {
		return fmt.Errorf("host = %q", r.Host)
	}
	if r.URL.RequestURI() != "/h2?q=1" {
		return fmt.Errorf("request URI = %q", r.URL.RequestURI())
	}
	if r.Header.Get("Accept") != "text/plain" {
		return fmt.Errorf("accept = %q", r.Header.Get("Accept"))
	}
	if r.Header.Get("Accept-Encoding") != "identity" {
		return fmt.Errorf("accept-encoding = %q", r.Header.Get("Accept-Encoding"))
	}
	if r.Header.Get("X-Zp-Tab-Id") != "" {
		return fmt.Errorf("internal header leaked: %#v", r.Header)
	}
	return nil
}

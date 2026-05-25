package http1

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
)

func TestHTTP1KeepAliveReusesIdleConnectionAfterEOF(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 2)}
	engine := &Engine{Mux: mux}
	tab := &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	target, _ := url.Parse("http://example.com/one")
	serverDone := make(chan error, 1)
	go func() {
		c := <-mux.streams
		defer c.Close()
		br := bufio.NewReader(c)
		if err := acceptSOCKSConnect(br, c); err != nil {
			serverDone <- err
			return
		}
		for _, wantPath := range []string{"/one", "/two"} {
			req, err := http.ReadRequest(br)
			if err != nil {
				serverDone <- err
				return
			}
			if req.URL.RequestURI() != wantPath {
				serverDone <- fmt.Errorf("request path = %q, want %q", req.URL.RequestURI(), wantPath)
				return
			}
			if _, err := io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()

	roundTripAndClose(t, engine, tab, target)
	second := *target
	second.Path = "/two"
	roundTripAndClose(t, engine, tab, &second)
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-mux.streams:
		_ = c.Close()
		t.Fatal("HTTP/1.1 keep-alive opened a second target connection")
	default:
	}
}

func TestHTTP1DoesNotReuseWhenBodyClosedBeforeEOF(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 2)}
	engine := &Engine{Mux: mux}
	tab := &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	target, _ := url.Parse("http://example.com/partial")
	firstDone := serveOneHTTP1Response(t, mux, "/partial", "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	resp, err := engine.RoundTrip(ctx, req, target, tab)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatal(err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	assertNoIdleHTTP1(t, engine, target, tab)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}

	second := *target
	second.Path = "/after-partial-close"
	secondDone := serveOneHTTP1Response(t, mux, "/after-partial-close", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	roundTripAndClose(t, engine, tab, &second)
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
}

func TestHTTP1DoesNotReuseConnectionCloseResponse(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 2)}
	engine := &Engine{Mux: mux}
	tab := &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	target, _ := url.Parse("http://example.com/close")
	firstDone := serveOneHTTP1Response(t, mux, "/close", "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok")
	roundTripAndClose(t, engine, tab, target)
	assertNoIdleHTTP1(t, engine, target, tab)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}

	second := *target
	second.Path = "/after-close"
	secondDone := serveOneHTTP1Response(t, mux, "/after-close", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	roundTripAndClose(t, engine, tab, &second)
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
}

func roundTripAndClose(t *testing.T, engine *Engine, tab *TabState, target *url.URL) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	resp, err := engine.RoundTrip(ctx, req, target, tab)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "ok" {
		t.Fatalf("body = %q", string(body))
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertNoIdleHTTP1(t *testing.T, engine *Engine, target *url.URL, tab *TabState) {
	t.Helper()
	if pc := engine.reserveH1(h2PoolKey(target, tab)); pc != nil {
		engine.closeH1(pc)
		t.Fatal("HTTP/1.1 connection was left idle when it should have been closed")
	}
}

func serveOneHTTP1Response(t *testing.T, mux *pipeMux, wantPath, response string) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		c := <-mux.streams
		defer c.Close()
		br := bufio.NewReader(c)
		if err := acceptSOCKSConnect(br, c); err != nil {
			done <- err
			return
		}
		req, err := http.ReadRequest(br)
		if err != nil {
			done <- err
			return
		}
		if req.URL.RequestURI() != wantPath {
			done <- fmt.Errorf("request path = %q, want %q", req.URL.RequestURI(), wantPath)
			return
		}
		_, err = io.WriteString(c, response)
		done <- err
	}()
	return done
}

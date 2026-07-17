package zphttp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

func testPoolLimits() PoolLimits {
	limits := DefaultPoolLimits()
	limits.MaxOrigins = 4
	limits.MaxIdlePerClass = 1
	limits.DocumentScriptActive = 1
	limits.OrdinaryActive = 1
	limits.LongLivedActive = 1
	limits.IdleTimeout = 20 * time.Millisecond
	return limits
}

func newTestPool(t *testing.T, limits PoolLimits) *Pool {
	t.Helper()
	pool, err := NewPool(limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pool.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Errorf("close pool: %v", err)
		}
	})
	return pool
}

func testRequest(t *testing.T, target string) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func http1Dialer(t *testing.T, responses []string, dials *atomic.Int32, releases *atomic.Int32) DialTarget {
	t.Helper()
	return func(context.Context) (*OwnedTarget, error) {
		dials.Add(1)
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			reader := bufio.NewReader(server)
			for _, response := range responses {
				request, err := http.ReadRequest(reader)
				if err != nil {
					return
				}
				if request.Body != nil {
					_, _ = io.Copy(io.Discard, request.Body)
					_ = request.Body.Close()
				}
				if _, err := io.WriteString(server, response); err != nil {
					return
				}
			}
			_, _ = io.Copy(io.Discard, server)
		}()
		return &OwnedTarget{
			Conn: &TargetConn{Conn: client, Protocol: "http/1.1"},
			Done: func(error) error { releases.Add(1); return nil },
		}, nil
	}
}

func TestHTTP1PoolReusesOriginConnectionAndPreservesEarlyHints(t *testing.T) {
	pool := newTestPool(t, testPoolLimits())
	var dials, releases atomic.Int32
	responses := []string{
		"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </app.js>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Checksum\r\n\r\n3\r\none\r\n0\r\nX-Checksum: complete\r\n\r\n",
		"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo",
	}
	dial := http1Dialer(t, responses, &dials, &releases)
	first, err := pool.RoundTrip(context.Background(), "https://target.zeroproxy.dev:443", Ordinary, testRequest(t, "https://target.zeroproxy.dev/one"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(first.Response.Body)
	if err != nil || string(body) != "one" {
		t.Fatalf("first body=%q error=%v", body, err)
	}
	_ = first.Response.Body.Close()
	if len(first.Informational) != 2 ||
		first.Informational[0].Status != http.StatusContinue ||
		first.Informational[1].Status != http.StatusEarlyHints ||
		first.Informational[1].Headers.Get("Link") == "" {
		t.Fatalf("informational responses=%#v", first.Informational)
	}
	if first.Response.Trailer.Get("X-Checksum") != "complete" {
		t.Fatalf("response trailers=%v", first.Response.Trailer)
	}
	second, err := pool.RoundTrip(context.Background(), "https://target.zeroproxy.dev:443", Ordinary, testRequest(t, "https://target.zeroproxy.dev/two"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	body, err = io.ReadAll(second.Response.Body)
	if err != nil || string(body) != "two" {
		t.Fatalf("second body=%q error=%v", body, err)
	}
	_ = second.Response.Body.Close()
	if dials.Load() != 1 {
		t.Fatalf("HTTP/1.1 dials=%d", dials.Load())
	}
	if err := pool.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("HTTP/1.1 releases=%d", releases.Load())
	}
}

func TestPoolSeparatesLongLivedAndOrdinaryCapacity(t *testing.T) {
	pool := newTestPool(t, testPoolLimits())
	var dials, releases atomic.Int32
	dial := func(context.Context) (*OwnedTarget, error) {
		dials.Add(1)
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			request, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				return
			}
			_ = request.Body.Close()
			_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata")
			_, _ = io.Copy(io.Discard, server)
		}()
		return &OwnedTarget{Conn: &TargetConn{Conn: client, Protocol: "http/1.1"}, Done: func(error) error { releases.Add(1); return nil }}, nil
	}
	longResult, err := pool.RoundTrip(context.Background(), "origin", LongLived, testRequest(t, "https://target.zeroproxy.dev/events"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	ordinaryResult, err := pool.RoundTrip(context.Background(), "origin", Ordinary, testRequest(t, "https://target.zeroproxy.dev/api"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	if dials.Load() != 2 {
		t.Fatalf("separate classes used %d dials", dials.Load())
	}
	_, _ = io.Copy(io.Discard, longResult.Response.Body)
	_ = longResult.Response.Body.Close()
	_, _ = io.Copy(io.Discard, ordinaryResult.Response.Body)
	_ = ordinaryResult.Response.Body.Close()
}

func TestPoolRejectsNewOriginWhenEveryOriginIsActive(t *testing.T) {
	limits := testPoolLimits()
	limits.MaxOrigins = 1
	pool := newTestPool(t, limits)
	var dials, releases atomic.Int32
	dial := http1Dialer(t, []string{"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata"}, &dials, &releases)
	active, err := pool.RoundTrip(context.Background(), "first", Ordinary, testRequest(t, "https://target.zeroproxy.dev/"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.RoundTrip(context.Background(), "second", Ordinary, testRequest(t, "https://other.zeroproxy.dev/"), nil, dial)
	if !errors.Is(err, ErrPoolCapacity) {
		t.Fatalf("second origin error=%v", err)
	}
	_, _ = io.Copy(io.Discard, active.Response.Body)
	_ = active.Response.Body.Close()
}

func TestHTTP2PoolMultiplexesOnePersonaConnection(t *testing.T) {
	pool := newTestPool(t, testPoolLimits())
	var dials, releases, requests atomic.Int32
	dial := func(context.Context) (*OwnedTarget, error) {
		dials.Add(1)
		client, server := net.Pipe()
		go func() {
			handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				response.Header().Set("X-Protocol", "h2")
				_, _ = fmt.Fprint(response, strings.TrimPrefix(request.URL.Path, "/"))
			})
			(&http2.Server{}).ServeConn(server, &http2.ServeConnOpts{Handler: handler})
		}()
		return &OwnedTarget{Conn: &TargetConn{Conn: client, Protocol: "h2"}, Done: func(error) error { releases.Add(1); return nil }}, nil
	}
	for _, path := range []string{"one", "two"} {
		result, err := pool.RoundTrip(context.Background(), "h2-origin", Ordinary, testRequest(t, "https://target.zeroproxy.dev/"+path), nil, dial)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(result.Response.Body)
		if err != nil || string(body) != path || result.Response.Header.Get("X-Protocol") != "h2" {
			t.Fatalf("h2 path=%s body=%q headers=%v error=%v", path, body, result.Response.Header, err)
		}
		_ = result.Response.Body.Close()
	}
	if dials.Load() != 1 || requests.Load() != 2 {
		t.Fatalf("h2 dials=%d requests=%d", dials.Load(), requests.Load())
	}
}

func TestHTTP1PoolRetriesStaleIdleConnectionBeforeUnsafeBytes(t *testing.T) {
	pool := newTestPool(t, testPoolLimits())
	var dials, releases atomic.Int32
	firstClosed := make(chan struct{})
	dial := func(context.Context) (*OwnedTarget, error) {
		attempt := dials.Add(1)
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			request, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				return
			}
			_ = request.Body.Close()
			body := "fresh"
			if attempt == 1 {
				body = "first"
			}
			_, _ = fmt.Fprintf(server, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
			if attempt == 1 {
				close(firstClosed)
				return
			}
			_, _ = io.Copy(io.Discard, server)
		}()
		return &OwnedTarget{
			Conn: &TargetConn{Conn: client, Protocol: "http/1.1"},
			Done: func(error) error { releases.Add(1); return nil },
		}, nil
	}
	first, err := pool.RoundTrip(context.Background(), "stale", Ordinary, testRequest(t, "https://target.zeroproxy.dev/first"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	if body, readErr := io.ReadAll(first.Response.Body); readErr != nil || string(body) != "first" {
		t.Fatalf("first body=%q error=%v", body, readErr)
	}
	_ = first.Response.Body.Close()
	<-firstClosed
	second, err := pool.RoundTrip(context.Background(), "stale", Ordinary, testRequest(t, "https://target.zeroproxy.dev/second"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	if body, readErr := io.ReadAll(second.Response.Body); readErr != nil || string(body) != "fresh" {
		t.Fatalf("second body=%q error=%v", body, readErr)
	}
	_ = second.Response.Body.Close()
	if dials.Load() != 2 {
		t.Fatalf("stale retry dials=%d", dials.Load())
	}
}

type closeBlockingBody struct {
	closed chan struct{}
	once   sync.Once
}

func (body *closeBlockingBody) Read([]byte) (int, error) {
	<-body.closed
	return 0, io.EOF
}

func (body *closeBlockingBody) Close() error {
	body.once.Do(func() { close(body.closed) })
	return nil
}

func TestHTTP1EarlyResponseStopsRequestWriter(t *testing.T) {
	pool := newTestPool(t, testPoolLimits())
	body := &closeBlockingBody{closed: make(chan struct{})}
	request, err := http.NewRequest(http.MethodPost, "https://target.zeroproxy.dev/upload", body)
	if err != nil {
		t.Fatal(err)
	}
	request.ContentLength = -1
	dial := func(context.Context) (*OwnedTarget, error) {
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			incoming, readErr := http.ReadRequest(bufio.NewReader(server))
			if readErr != nil {
				return
			}
			defer incoming.Body.Close()
			_, _ = io.WriteString(server, "HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n")
			_, _ = io.Copy(io.Discard, server)
		}()
		return &OwnedTarget{Conn: &TargetConn{Conn: client, Protocol: "http/1.1"}}, nil
	}
	result, err := pool.RoundTrip(context.Background(), "early-response", Ordinary, request, nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() {
		_, readErr := io.ReadAll(result.Response.Body)
		completed <- errors.Join(readErr, result.Response.Body.Close())
	}()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("early response blocked on unfinished request body")
	}
	select {
	case <-body.closed:
	default:
		t.Fatal("early response did not close the request body")
	}
}

func TestRequestReplayRequiresExplicitBoundedBody(t *testing.T) {
	bounded, err := http.NewRequest(http.MethodPost, "https://target.zeroproxy.dev/", strings.NewReader("buffered"))
	if err != nil {
		t.Fatal(err)
	}
	if !replayableRequest(bounded) {
		t.Fatal("explicit bounded request body is not replayable")
	}
	oversized, err := http.NewRequest(http.MethodPost, "https://target.zeroproxy.dev/", strings.NewReader(strings.Repeat("x", (256<<10)+1)))
	if err != nil {
		t.Fatal(err)
	}
	if replayableRequest(oversized) {
		t.Fatal("oversized request body is replayable")
	}
	streamed, err := http.NewRequest(http.MethodPost, "https://target.zeroproxy.dev/", io.NopCloser(strings.NewReader("streamed")))
	if err != nil {
		t.Fatal(err)
	}
	if replayableRequest(streamed) {
		t.Fatal("unbuffered request body is replayable")
	}
}

func TestPoolIdleReaperClosesOwnedConnection(t *testing.T) {
	limits := testPoolLimits()
	limits.IdleTimeout = 10 * time.Millisecond
	pool := newTestPool(t, limits)
	var dials, releases atomic.Int32
	dial := http1Dialer(t, []string{"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"}, &dials, &releases)
	result, err := pool.RoundTrip(context.Background(), "idle", DocumentScript, testRequest(t, "https://target.zeroproxy.dev/"), nil, dial)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, result.Response.Body)
	_ = result.Response.Body.Close()
	deadline := time.After(2 * time.Second)
	for releases.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("idle pooled connection was not closed")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

package zphttp

import (
	"bufio"
	"bytes"
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

func TestRoundTripStreamsRangePartialContent(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 1)}
	engine := &Engine{Mux: mux}
	target, _ := url.Parse("http://example.com/large.bin")
	releaseRest := make(chan struct{})
	serverDone := serveSOCKSHTTP(t, mux, func(req *http.Request, c net.Conn) error {
		if got := req.Header.Get("Range"); got != "bytes=1024-2048" {
			return fmt.Errorf("range header = %q", got)
		}
		first := []byte("abc")
		rest := bytes.Repeat([]byte{0x5a}, 1022)
		if _, err := fmt.Fprintf(c, "HTTP/1.1 206 Partial Content\r\nContent-Length: %d\r\nContent-Range: bytes 1024-2048/10737418240\r\n\r\n", len(first)+len(rest)); err != nil {
			return err
		}
		if _, err := c.Write(first); err != nil {
			return err
		}
		<-releaseRest
		_, err := c.Write(rest)
		return err
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	req.Header.Set("Range", "bytes=1024-2048")
	resp, err := engine.RoundTrip(ctx, req, target, &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusPartialContent)
	}
	buf := make([]byte, 3)
	readDone := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, buf); readDone <- err }()
	select {
	case err := <-readDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("range response did not stream the first chunk before upstream completed")
	}
	if string(buf) != "abc" {
		t.Fatalf("first chunk = %q", string(buf))
	}
	close(releaseRest)
	if n, err := io.Copy(io.Discard, resp.Body); err != nil || n != 1022 {
		t.Fatalf("remaining body bytes = %d, err = %v", n, err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func TestRoundTripStreamsSSEEventsBeforeConnectionEnds(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 1)}
	engine := &Engine{Mux: mux}
	target, _ := url.Parse("http://example.com/sse")
	releaseSecond := make(chan struct{})
	serverDone := serveSOCKSHTTP(t, mux, func(req *http.Request, c net.Conn) error {
		if got := req.Header.Get("Accept"); got != "text/event-stream" {
			return fmt.Errorf("accept header = %q", got)
		}
		if _, err := io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"); err != nil {
			return err
		}
		if err := writeChunk(c, []byte("data: one\n\n")); err != nil {
			return err
		}
		<-releaseSecond
		if err := writeChunk(c, []byte("data: two\n\n")); err != nil {
			return err
		}
		_, err := io.WriteString(c, "0\r\n\r\n")
		return err
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := engine.RoundTrip(ctx, req, target, &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}
	buf := make([]byte, len("data: one\n\n"))
	readDone := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, buf); readDone <- err }()
	select {
	case err := <-readDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("SSE event was buffered behind the open connection")
	}
	if string(buf) != "data: one\n\n" {
		t.Fatalf("first event = %q", string(buf))
	}
	close(releaseSecond)
	if rest, err := io.ReadAll(resp.Body); err != nil || string(rest) != "data: two\n\n" {
		t.Fatalf("remaining SSE stream = %q, err = %v", string(rest), err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func serveSOCKSHTTP(t *testing.T, mux *pipeMux, handler func(*http.Request, net.Conn) error) <-chan error {
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
		done <- handler(req, c)
	}()
	return done
}

func acceptSOCKSConnect(br *bufio.Reader, c net.Conn) error {
	greeting := make([]byte, 4)
	if _, err := io.ReadFull(br, greeting); err != nil {
		return err
	}
	if greeting[0] != 0x05 || greeting[1] != 0x02 || greeting[2] != 0x02 || greeting[3] != 0x00 {
		return fmt.Errorf("bad socks greeting: %x", greeting)
	}
	if _, err := c.Write([]byte{0x05, 0x02}); err != nil {
		return err
	}
	authHead := make([]byte, 2)
	if _, err := io.ReadFull(br, authHead); err != nil {
		return err
	}
	if _, err := io.CopyN(io.Discard, br, int64(authHead[1])); err != nil {
		return err
	}
	passLen, err := br.ReadByte()
	if err != nil {
		return err
	}
	if _, err := io.CopyN(io.Discard, br, int64(passLen)); err != nil {
		return err
	}
	if _, err := c.Write([]byte{0x01, 0x00}); err != nil {
		return err
	}
	reqHead := make([]byte, 5)
	if _, err := io.ReadFull(br, reqHead); err != nil {
		return err
	}
	if reqHead[0] != 0x05 || reqHead[1] != 0x01 || reqHead[3] != 0x03 {
		return fmt.Errorf("bad socks connect header: %x", reqHead)
	}
	if _, err := io.CopyN(io.Discard, br, int64(reqHead[4])+2); err != nil {
		return err
	}
	_, err = c.Write([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00})
	return err
}

func writeChunk(w io.Writer, p []byte) error {
	if _, err := fmt.Fprintf(w, "%x\r\n", len(p)); err != nil {
		return err
	}
	if _, err := w.Write(p); err != nil {
		return err
	}
	_, err := io.WriteString(w, "\r\n")
	return err
}

package http1

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
)

func TestBuildHTTP1RequestConstructsTargetHeaders(t *testing.T) {
	target, _ := url.Parse("https://example.com/path?q=1")
	jar := cookiejar.New()
	jar.SetDocumentCookie(target, "sid=1; Path=/; Secure")
	src, _ := http.NewRequest("POST", "https://example.com/path?q=1", io.NopCloser(strings.NewReader("x")))
	src.Header.Set("X-ZP-Tab-Id", "secret")
	src.Header.Set("Cookie", "browser=bad")
	src.Header.Set("Connection", "keep-alive")
	src.Header.Set("Accept", "text/html")
	wire, err := BuildHTTP1Request(src, target, jar)
	if err != nil {
		t.Fatal(err)
	}
	if wire.Host != "example.com" || wire.Header.Get("Host") != "example.com" {
		t.Fatalf("host not canonicalized: host=%q header=%q", wire.Host, wire.Header.Get("Host"))
	}
	if wire.Header.Get("X-ZP-Tab-Id") != "" || wire.Header.Get("Connection") != "" {
		t.Fatalf("internal/hop headers leaked: %#v", wire.Header)
	}
	if wire.Header.Get("Cookie") != "sid=1" {
		t.Fatalf("cookie jar not projected: %#v", wire.Header)
	}
	if wire.Header.Get("Origin") != "https://example.com" || wire.Header.Get("Referer") != target.String() {
		t.Fatalf("origin/referer wrong: %#v", wire.Header)
	}
}

type pipeMux struct {
	streams chan net.Conn
}

func (m *pipeMux) OpenStream(context.Context) (net.Conn, error) {
	client, server := net.Pipe()
	m.streams <- server
	return client, nil
}

func TestRoundTripUsesSocksDomainAndHTTP1(t *testing.T) {
	mux := &pipeMux{streams: make(chan net.Conn, 1)}
	engine := &Engine{Mux: mux}
	target, _ := url.Parse("http://example.com/resource?q=1")
	req, _ := http.NewRequest("GET", target.String(), nil)
	done := make(chan error, 1)
	go func() {
		c := <-mux.streams
		defer c.Close()
		br := bufio.NewReader(c)
		greeting := make([]byte, 4)
		if _, err := io.ReadFull(br, greeting); err != nil {
			done <- err
			return
		}
		if greeting[0] != 0x05 || greeting[1] != 0x02 || greeting[2] != 0x02 || greeting[3] != 0x00 {
			done <- io.ErrUnexpectedEOF
			return
		}
		if _, err := c.Write([]byte{0x05, 0x02}); err != nil {
			done <- err
			return
		}
		authHead := make([]byte, 2)
		if _, err := io.ReadFull(br, authHead); err != nil {
			done <- err
			return
		}
		user := make([]byte, int(authHead[1]))
		if _, err := io.ReadFull(br, user); err != nil {
			done <- err
			return
		}
		passLen, err := br.ReadByte()
		if err != nil {
			done <- err
			return
		}
		pass := make([]byte, int(passLen))
		if _, err := io.ReadFull(br, pass); err != nil {
			done <- err
			return
		}
		if len(user) != 43 || string(pass) != "zp" {
			done <- io.ErrUnexpectedEOF
			return
		}
		if _, err := c.Write([]byte{0x01, 0x00}); err != nil {
			done <- err
			return
		}
		reqHead := make([]byte, 5)
		if _, err := io.ReadFull(br, reqHead); err != nil {
			done <- err
			return
		}
		if reqHead[0] != 0x05 || reqHead[1] != 0x01 || reqHead[3] != 0x03 || reqHead[4] != byte(len("example.com")) {
			done <- io.ErrUnexpectedEOF
			return
		}
		host := make([]byte, len("example.com"))
		if _, err := io.ReadFull(br, host); err != nil {
			done <- err
			return
		}
		port := make([]byte, 2)
		if _, err := io.ReadFull(br, port); err != nil {
			done <- err
			return
		}
		if string(host) != "example.com" || port[0] != 0 || port[1] != 80 {
			done <- io.ErrUnexpectedEOF
			return
		}
		if _, err := c.Write([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00}); err != nil {
			done <- err
			return
		}
		wireReq, err := http.ReadRequest(br)
		if err != nil {
			done <- err
			return
		}
		if wireReq.Host != "example.com" || wireReq.URL.RequestURI() != "/resource?q=1" {
			done <- io.ErrUnexpectedEOF
			return
		}
		_, err = c.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: a=b\r\n\r\nok"))
		done <- err
	}()
	resp, err := engine.RoundTrip(context.Background(), req, target, &TabState{CookieJar: cookiejar.New(), StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if string(body) != "ok" || resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected response %d %q", resp.StatusCode, string(body))
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

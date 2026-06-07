package zphttp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

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
	src.Header.Set("Sec-CH-UA-Platform", `"macOS"`)
	src.Header.Set("Sec-CH-UA-Full-Version", `"148.0.0.0"`)
	src.Header.Set("X-ZP-Document-URL", target.String())
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
	if wire.Header.Get("User-Agent") != TargetUserAgent {
		t.Fatalf("user-agent not normalized: %#v", wire.Header)
	}
	if wire.Header.Get("Sec-CH-UA-Platform") != `"Windows"` || wire.Header.Get("Sec-CH-UA-Full-Version") != `"148.0.7778.217"` {
		t.Fatalf("client hints not normalized: %#v", wire.Header)
	}
	if wire.Header.Get("Origin") != "https://example.com" || wire.Header.Get("Referer") != target.String() {
		t.Fatalf("origin/referer wrong: %#v", wire.Header)
	}
}

func TestBuildHTTP1RequestHonorsFetchCredentialsAndReferrerPolicy(t *testing.T) {
	target, _ := url.Parse("https://api.example.test/data")
	source, _ := url.Parse("https://app.example.test/page?q=1#secret")
	jar := cookiejar.New()
	jar.SetDocumentCookie(target, "sid=1; Path=/; Secure")

	src, _ := http.NewRequest("GET", target.String(), nil)
	src.Header.Set("X-ZP-Document-URL", source.String())
	src.Header.Set("X-ZP-Fetch-Credentials", "same-origin")
	src.Header.Set("X-ZP-Fetch-Mode", "cors")
	src.Header.Set("X-ZP-Fetch-Referrer-Policy", "origin")
	wire, err := BuildHTTP1Request(src, target, jar)
	if err != nil {
		t.Fatal(err)
	}
	if got := wire.Header.Get("Cookie"); got != "" {
		t.Fatalf("cross-origin same-origin credentials leaked cookies: %q", got)
	}
	if got := wire.Header.Get("Origin"); got != source.Scheme+"://"+source.Host {
		t.Fatalf("origin = %q", got)
	}
	if got := wire.Header.Get("Referer"); got != source.Scheme+"://"+source.Host+"/" {
		t.Fatalf("referer = %q", got)
	}

	src.Header.Set("X-ZP-Fetch-Referrer-Policy", "unsafe-url")
	wire, err = BuildHTTP1Request(src, target, jar)
	if err != nil {
		t.Fatal(err)
	}
	if got := wire.Header.Get("Referer"); got != "https://app.example.test/page?q=1" {
		t.Fatalf("full referer should strip fragment and credentials, got %q", got)
	}

	src.Header.Set("X-ZP-Fetch-Credentials", "include")
	src.Header.Set("X-ZP-Fetch-Referrer-Policy", "origin")
	wire, err = BuildHTTP1Request(src, target, jar)
	if err != nil {
		t.Fatal(err)
	}
	if got := wire.Header.Get("Cookie"); got != "sid=1" {
		t.Fatalf("include credentials omitted cookies: %q", got)
	}

	src.Header.Set("X-ZP-Fetch-Credentials", "omit")
	wire, err = BuildHTTP1Request(src, target, jar)
	if err != nil {
		t.Fatal(err)
	}
	if got := wire.Header.Get("Cookie"); got != "" {
		t.Fatalf("omit credentials sent cookies: %q", got)
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
	req.Header.Set("X-Zp-Request-Id", "req_test")
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
		if wireReq.Header.Get("User-Agent") != TargetUserAgent {
			done <- fmt.Errorf("user-agent = %q", wireReq.Header.Get("User-Agent"))
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
	var timing TransportTiming
	if err := json.Unmarshal([]byte(resp.Header.Get(transportTimingHeader)), &timing); err != nil {
		t.Fatalf("transport timing header is not JSON: %v", err)
	}
	if timing.RequestID != "req_test" || timing.TargetOriginHash == "" || timing.NegotiatedProtocol != "http/1.1" {
		t.Fatalf("transport timing missing redacted fields: %#v", timing)
	}
	if timing.ConnectionReused || timing.StreamOpenMS < 0 || timing.SOCKSConnectMS < 0 || timing.TimeToFirstByteMS < 0 || timing.TotalMS < 0 || timing.BodyDurationMS < 0 || timing.RetryCount != 0 {
		t.Fatalf("transport timing has invalid values: %#v", timing)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPoolKeySeparatesSchemeAuthorityAndIsolation(t *testing.T) {
	httpURL, _ := url.Parse("http://example.com/")
	httpsURL, _ := url.Parse("https://example.com/")
	tabA := &TabState{TabID: "tab-a", StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	tabB := &TabState{TabID: "tab-b", StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
	httpKey := h2PoolKey(httpURL, tabA)
	httpsKey := h2PoolKey(httpsURL, tabA)
	if httpKey == httpsKey {
		t.Fatal("http and https pool keys must differ")
	}
	if httpKey.scheme != "http" || httpsKey.scheme != "https" {
		t.Fatalf("unexpected schemes in pool keys: %#v %#v", httpKey, httpsKey)
	}
	if h2PoolKey(httpsURL, tabA) == h2PoolKey(httpsURL, tabB) {
		t.Fatal("pool keys must remain isolated per tab")
	}
}

func TestBrowserSchedulerLimitsPerOriginAndQueues(t *testing.T) {
	var engine Engine
	key := h2Key{authority: "example.com", isolation: "iso", tabID: "tab"}
	releases := make([]func(), 0, maxBrowserRequestsPerOrigin)
	for range maxBrowserRequestsPerOrigin {
		release, err := engine.acquireRequestSlot(context.Background(), key, 1)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	acquired := make(chan func(), 1)
	go func() {
		release, err := engine.acquireRequestSlot(context.Background(), key, 1)
		if err != nil {
			t.Errorf("queued acquire: %v", err)
			return
		}
		acquired <- release
	}()
	select {
	case release := <-acquired:
		release()
		t.Fatal("per-origin scheduler did not queue over-limit request")
	case <-time.After(25 * time.Millisecond):
	}
	releases[0]()
	select {
	case release := <-acquired:
		release()
	case <-time.After(time.Second):
		t.Fatal("queued request did not acquire after release")
	}
	for _, release := range releases[1:] {
		release()
	}
	if engine.activeGlobal != 0 || len(engine.activeByKey) != 0 || len(engine.requestWaiter) != 0 {
		t.Fatalf("scheduler state leaked: global=%d byKey=%d waiters=%d", engine.activeGlobal, len(engine.activeByKey), len(engine.requestWaiter))
	}
}

func TestBrowserSchedulerCancelsQueuedRequest(t *testing.T) {
	var engine Engine
	key := h2Key{authority: "example.com", isolation: "iso", tabID: "tab"}
	releases := make([]func(), 0, maxBrowserRequestsPerOrigin)
	for range maxBrowserRequestsPerOrigin {
		release, err := engine.acquireRequestSlot(context.Background(), key, 1)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if release, err := engine.acquireRequestSlot(ctx, key, 1); err == nil {
		release()
		t.Fatal("canceled queued request acquired a slot")
	}
	for _, release := range releases {
		release()
	}
	if engine.activeGlobal != 0 || len(engine.activeByKey) != 0 || len(engine.requestWaiter) != 0 {
		t.Fatalf("scheduler state leaked: global=%d byKey=%d waiters=%d", engine.activeGlobal, len(engine.activeByKey), len(engine.requestWaiter))
	}
}

func TestBrowserSchedulerHonorsFetchPriority(t *testing.T) {
	var engine Engine
	key := h2Key{authority: "example.com", isolation: "iso", tabID: "tab"}
	releases := make([]func(), 0, maxBrowserRequestsPerOrigin)
	for range maxBrowserRequestsPerOrigin {
		release, err := engine.acquireRequestSlot(context.Background(), key, 1)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	low := make(chan func(), 1)
	high := make(chan func(), 1)
	go acquireSlotForTest(t, &engine, key, 0, low)
	go acquireSlotForTest(t, &engine, key, 2, high)
	waitForQueuedRequests(t, &engine, 2)
	releases[0]()
	select {
	case release := <-high:
		release()
	case release := <-low:
		release()
		t.Fatal("low-priority request acquired before queued high-priority request")
	case <-time.After(time.Second):
		t.Fatal("priority request did not acquire")
	}
	for _, release := range releases[1:] {
		release()
	}
	select {
	case release := <-low:
		release()
	case <-time.After(time.Second):
		t.Fatal("low-priority request did not acquire after capacity returned")
	}
}

func acquireSlotForTest(t *testing.T, engine *Engine, key h2Key, priority int, out chan<- func()) {
	t.Helper()
	release, err := engine.acquireRequestSlot(context.Background(), key, priority)
	if err != nil {
		t.Errorf("queued acquire: %v", err)
		return
	}
	out <- release
}

func waitForQueuedRequests(t *testing.T, engine *Engine, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		engine.mu.Lock()
		got := len(engine.requestWaiter)
		engine.mu.Unlock()
		if got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("queued request count did not reach %d", want)
}

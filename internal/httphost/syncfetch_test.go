package httphost

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A synchronous XHR's response goes back through an allowlist. The cookie delta,
// the non-HttpOnly changes the service worker made to the jar, is on it; the
// response's own Set-Cookie never is.
func TestSafeSyncHeader(t *testing.T) {
	for _, name := range []string{"Content-Type", "ETag", "X-ZP-Cookie-Delta", "x-zp-cookie-delta"} {
		if !safeSyncHeader(name) {
			t.Errorf("%q should pass", name)
		}
	}
	for _, name := range []string{"Set-Cookie", "set-cookie", "Cookie", "Authorization", "X-ZP-Set-Cookie", "Location", "X-ZP-Sync-Err"} {
		if safeSyncHeader(name) {
			t.Errorf("%q must not pass", name)
		}
	}
}

func TestParsePendingCookies(t *testing.T) {
	got := parsePendingCookies([]string{
		`["w1","a=1; Path=/"]`,
		`not json`,
		`["only-one"]`,
		`["","empty id"]`,
		`["w2","b=2"]`,
		`["w3","` + strings.Repeat("x", 9000) + `"]`,
	})
	if len(got) != 2 || got[0][0] != "w1" || got[0][1] != "a=1; Path=/" || got[1][0] != "w2" {
		t.Fatalf("shape and bounds: %#v", got)
	}
	var many []string
	for i := 0; i < 50; i++ {
		many = append(many, `["w","c=1"]`)
	}
	if n := len(parsePendingCookies(many)); n != 32 {
		t.Fatalf("at most 32 writes ride one request, got %d", n)
	}
	if parsePendingCookies(nil) != nil {
		t.Fatal("nothing pending: nothing carried")
	}
}

func TestCorsMode(t *testing.T) {
	for in, want := range map[string]string{
		"anonymous": "anonymous", "use-credentials": "use-credentials",
		"": "", "include": "", "Anonymous": "", "anonymous; x": "",
	} {
		if got := corsMode(in); got != want {
			t.Errorf("corsMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSyncFetchRejectsDuplicateRIDWithConflict(t *testing.T) {
	h := NewHandler(Config{SocksAddr: internalSOCKSMode})
	s := &server{syncHub: newSyncFetchHub()}
	first := &syncFetchJob{
		ID:     "dup-1",
		Target: "https://example.com/a",
		Method: http.MethodGet,
		result: make(chan *syncFetchResult, 1),
	}
	if err := s.syncHub.enqueue(first); err != nil {
		t.Fatalf("first enqueue: %v", err)
	}
	if err := s.syncHub.enqueue(first); err != errDuplicateJobID {
		t.Fatalf("duplicate enqueue = %v, want %v", err, errDuplicateJobID)
	}

	done := make(chan struct{})
	req1 := httptest.NewRequest(http.MethodGet, "/zp/api/sync-fetch?rid=job-42&m=GET&u=https://example.com/", nil)
	req1.Header.Set("Sec-Fetch-Site", "same-origin")
	rec1 := httptest.NewRecorder()
	go func() {
		h.ServeHTTP(rec1, req1)
		close(done)
	}()

	// Poll waits until req1 is enqueued; job-42 remains active in syncHub.jobs until result arrives.
	reqPoll := httptest.NewRequest(http.MethodGet, "/zp/api/sync-fetch/poll", nil)
	reqPoll.Header.Set("Sec-Fetch-Site", "same-origin")
	recPoll := httptest.NewRecorder()
	h.ServeHTTP(recPoll, reqPoll)
	if recPoll.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want 200", recPoll.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/zp/api/sync-fetch?rid=job-42&m=GET&u=https://example.com/", nil)
	req2.Header.Set("Sec-Fetch-Site", "same-origin")
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("duplicate rid status = %d, want %d", rec2.Code, http.StatusConflict)
	}

	reqRes := httptest.NewRequest(http.MethodPost, "/zp/api/sync-fetch/result", strings.NewReader("ok"))
	reqRes.Header.Set("Sec-Fetch-Site", "same-origin")
	reqRes.Header.Set("X-ZP-Sync-Id", "job-42")
	reqRes.Header.Set("X-ZP-Sync-Status", "200")
	recRes := httptest.NewRecorder()
	h.ServeHTTP(recRes, reqRes)
	<-done
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", rec1.Code)
	}
}

// Each origin has a Service Worker of its own with its own tabs, so a job parked by a page of one host must reach only a worker polling
// that host, and only that host's worker may answer it.
func TestSyncFetchJobsAreScopedByOriginHost(t *testing.T) {
	hub := newSyncFetchHub()
	job := &syncFetchJob{ID: "scoped-1", Target: "https://example.com/", Method: http.MethodGet, Host: "proxy.localhost:18080", result: make(chan *syncFetchResult, 1)}
	if err := hub.enqueue(job); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	other := hub.queueFor("s-site-1234.localhost:18080")
	select {
	case got := <-other:
		t.Fatalf("a worker of another host was handed job %q", got.ID)
	default:
	}
	if got := hub.takeFor("scoped-1", "s-site-1234.localhost:18080"); got != nil {
		t.Fatal("another host answered a job that is not its own")
	}
	select {
	case got := <-hub.queueFor("proxy.localhost:18080"):
		if got.ID != "scoped-1" {
			t.Fatalf("queued job = %q", got.ID)
		}
	default:
		t.Fatal("the owning host's queue lost the job")
	}
	if got := hub.takeFor("scoped-1", "proxy.localhost:18080"); got == nil {
		t.Fatal("the owning host could not take its job")
	}
}

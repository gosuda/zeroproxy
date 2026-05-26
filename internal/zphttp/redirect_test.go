package zphttp

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestRedirectedRequestReplaysPreservedBody(t *testing.T) {
	target, _ := url.Parse("https://example.com/next")
	req, _ := http.NewRequest(http.MethodPost, "https://example.com/start", io.NopCloser(strings.NewReader("consumed")))
	req.ContentLength = int64(len("payload"))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("payload")), nil }
	next, err := redirectedRequest(req, http.StatusTemporaryRedirect, target)
	if err != nil {
		t.Fatal(err)
	}
	if next.Method != http.MethodPost || next.URL.String() != target.String() || next.ContentLength != int64(len("payload")) {
		t.Fatalf("unexpected redirected request: method=%s url=%s len=%d", next.Method, next.URL, next.ContentLength)
	}
	body, err := io.ReadAll(next.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "payload" {
		t.Fatalf("body = %q, want payload", body)
	}
}

func TestRedirectedRequestRejectsNonReplayablePreservedBody(t *testing.T) {
	target, _ := url.Parse("https://example.com/next")
	req, _ := http.NewRequest(http.MethodPost, "https://example.com/start", io.NopCloser(strings.NewReader("payload")))
	if _, err := redirectedRequest(req, http.StatusTemporaryRedirect, target); err == nil {
		t.Fatal("expected non-replayable body redirect to fail")
	}
}

func TestRedirectedRequestDropsBodyForSeeOther(t *testing.T) {
	target, _ := url.Parse("https://example.com/next")
	req, _ := http.NewRequest(http.MethodPost, "https://example.com/start", io.NopCloser(strings.NewReader("payload")))
	next, err := redirectedRequest(req, http.StatusSeeOther, target)
	if err != nil {
		t.Fatal(err)
	}
	if next.Method != http.MethodGet || next.ContentLength != 0 {
		t.Fatalf("method=%s len=%d, want GET len 0", next.Method, next.ContentLength)
	}
}

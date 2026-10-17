package httphost_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/pkg/httphost"
)

func TestNewServerConfigValidation(t *testing.T) {
	if _, err := httphost.NewServer(httphost.Config{
		Transport: httphost.TransportSOCKS5,
		SocksAddr: "",
	}); err == nil {
		t.Fatal("expected error when TransportSOCKS5 has empty SocksAddr")
	}

	if _, err := httphost.NewServer(httphost.Config{
		Transport: httphost.TransportSOCKS5,
		SocksAddr: "internal",
	}); err == nil {
		t.Fatal("expected error when TransportSOCKS5 has SocksAddr=\"internal\"")
	}

	if _, err := httphost.NewServer(httphost.Config{
		Transport: httphost.TransportSOCKS5,
		SocksAddr: "not-a-host-port",
	}); err == nil {
		t.Fatal("expected error when TransportSOCKS5 has malformed SocksAddr")
	}

	if _, err := httphost.NewServer(httphost.Config{
		Transport: httphost.TransportDirect,
		SocksAddr: "127.0.0.1:9050",
	}); err == nil {
		t.Fatal("expected error when TransportDirect specifies an upstream SOCKS5 address")
	}

	srv, err := httphost.NewServer(httphost.Config{
		Transport:           httphost.TransportDirect,
		AllowPrivateTargets: false,
	})
	if err != nil {
		t.Fatalf("unexpected error for valid TransportDirect config: %v", err)
	}
	if err := srv.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
}

func TestServerCloseUnblocksSyncFetchPoll(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>ok</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := httphost.NewServer(httphost.Config{
		WebDir:              dir,
		Transport:           httphost.TransportDirect,
		AllowPrivateTargets: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	done := make(chan int, 1)
	go func() {
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/zp/api/sync-fetch/poll", nil)
		if err != nil {
			done <- -1
			return
		}
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := ts.Client().Do(req)
		if err != nil {
			done <- -1
			return
		}
		_ = resp.Body.Close()
		done <- resp.StatusCode
	}()

	time.Sleep(50 * time.Millisecond)
	if err := srv.Close(); err != nil {
		t.Fatal(err)
	}

	select {
	case code := <-done:
		if code != http.StatusNoContent {
			t.Fatalf("poll status after Server.Close() = %d, want %d", code, http.StatusNoContent)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Server.Close() did not unblock parked sync-fetch poll")
	}
}

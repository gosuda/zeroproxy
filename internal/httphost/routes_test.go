package httphost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gosuda/zeroproxy/internal/rtcgw"
)

func routeServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

func get(srv *Server, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080"+path, nil))
	return rec
}

func TestRetiredRoutesAreRefusedInsteadOfRedirected(t *testing.T) {
	srv := routeServer(t, Config{SocksAddr: internalSOCKSMode})
	for _, path := range []string{
		"/p/token",
		"/sw.js",
		"/index.html",
		"/__zp/ws-pipe",
		"/__zp/worker-bootstrap.js",
		"/__zp/zp_bundle_sw.js",
		"/__zp/zp-core.js",
		"/zp/assets/zp-core.js",
		"/zp/api/rtc/signal",
	} {
		rec := get(srv, path)
		if rec.Code != http.StatusForbidden {
			t.Errorf("GET %s = %d (Location %q), want %d", path, rec.Code, rec.Header().Get("Location"), http.StatusForbidden)
		}
	}
}

func TestAssetRouteServesOnlyTheRuntimeAllowlist(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"index.html":           "<!doctype html>",
		"zp-core.js":           "core",
		"secret.txt":           "secret",
		"Asset/zp-kernel.wasm": "\x00asm",
		"Asset/private.bin":    "private",
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	srv := routeServer(t, Config{WebDir: dir, SocksAddr: internalSOCKSMode})

	if rec := get(srv, "/zp/Asset/zp-core.js"); rec.Code != http.StatusOK || rec.Body.String() != "core" {
		t.Errorf("zp-core.js = %d %q, want 200 core", rec.Code, rec.Body.String())
	}
	rec := get(srv, "/zp/Asset/zp-kernel.wasm")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/wasm" {
		t.Errorf("zp-kernel.wasm = %d type %q, want 200 application/wasm", rec.Code, rec.Header().Get("Content-Type"))
	}
	for _, path := range []string{"/zp/Asset/secret.txt", "/zp/Asset/private.bin", "/zp/Asset/Asset/zp-kernel.wasm", "/zp/Asset/"} {
		if rec := get(srv, path); rec.Code != http.StatusForbidden {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, http.StatusForbidden)
		}
	}
}

type fixedICE struct{}

func (fixedICE) IssueICEServerCreds(label string) (rtcgw.ICEServerCred, error) {
	return rtcgw.ICEServerCred{URLs: []string{"turn:turn.example:3478"}, Username: "1:" + label, Credential: "pw"}, nil
}

func TestTURNCredentialsRoute(t *testing.T) {
	without := routeServer(t, Config{SocksAddr: internalSOCKSMode})
	rec := get(without, "/zp/rtc/turn-credentials")
	if rec.Code != http.StatusNotImplemented || rec.Header().Get("X-ZP-Error-Code") != "RTC_GATEWAY_UNAVAILABLE" {
		t.Errorf("without TURN = %d code %q, want 501 RTC_GATEWAY_UNAVAILABLE", rec.Code, rec.Header().Get("X-ZP-Error-Code"))
	}

	with := routeServer(t, Config{SocksAddr: internalSOCKSMode, RtcTURN: fixedICE{}})
	rec = get(with, "/zp/rtc/turn-credentials")
	if rec.Code != http.StatusOK {
		t.Fatalf("with TURN = %d, want 200", rec.Code)
	}
	var cred rtcgw.ICEServerCred
	if err := json.Unmarshal(rec.Body.Bytes(), &cred); err != nil {
		t.Fatal(err)
	}
	if len(cred.URLs) != 1 || cred.URLs[0] != "turn:turn.example:3478" || cred.Credential != "pw" {
		t.Errorf("credential = %+v", cred)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("credentials must not be cached, got Cache-Control %q", rec.Header().Get("Cache-Control"))
	}

	cross := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080/zp/rtc/turn-credentials", nil)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	recCross := httptest.NewRecorder()
	with.ServeHTTP(recCross, cross)
	if recCross.Code != http.StatusForbidden {
		t.Errorf("cross-site credential request = %d, want %d", recCross.Code, http.StatusForbidden)
	}
}

func TestWebTransportAndOfferRoutesReportUnprovisioned(t *testing.T) {
	srv := routeServer(t, Config{SocksAddr: internalSOCKSMode})
	for path, code := range map[string]string{"/zp/wt": "WT_UNSUPPORTED", "/zp/rtc/offer": "RTC_GATEWAY_UNAVAILABLE"} {
		rec := get(srv, path)
		if rec.Code != http.StatusNotImplemented || rec.Header().Get("X-ZP-Error-Code") != code {
			t.Errorf("GET %s = %d code %q, want 501 %s", path, rec.Code, rec.Header().Get("X-ZP-Error-Code"), code)
		}
	}
}

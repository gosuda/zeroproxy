package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHandleRouting pins the path-dispatch behavior of (*server).handle: the
// asset allowlist, the default-deny fallthrough, and the redirect/serve cases.
// It is the net for the route-table refactor that replaced the routing switch.
type routeCase struct {
	name       string
	path       string
	wantStatus int
	wantLoc    string // expected Location header for redirects ("" = don't check)
	wantBody   string // substring that must appear in the body ("" = don't check)
}

var routeCases = []routeCase{
	// Redirects to the canonical control prefix.
	{"root redirects to control", "/", http.StatusFound, controlPrefix, ""},
	{"index.html redirects to control", "/index.html", http.StatusFound, controlPrefix, ""},
	{"legacy sw redirects", "/sw.js", http.StatusTemporaryRedirect, controlPrefix + "sw.js", ""},
	{"legacy page redirects", "/p/abc", http.StatusTemporaryRedirect, controlPrefix + "p/abc", ""},
	{"legacy zp ws-pipe redirects", "/__zp/ws-pipe", http.StatusTemporaryRedirect, controlPrefix + "ws-pipe", ""},
	{"legacy zp asset redirects", "/__zp/zp-core.js", http.StatusTemporaryRedirect, assetPrefix + "zp-core.js", ""},
	{"legacy zp error redirects", "/__zp/error/BAD_HMAC", http.StatusTemporaryRedirect, controlPrefix + "error/BAD_HMAC", ""},

	// Serve handlers fail closed (503) because the asset tree is absent, but
	// the key point is they routed to a serve path rather than default-deny.
	{"control index serves", controlPrefix, http.StatusServiceUnavailable, "", "SW_NOT_READY"},
	{"control index.html serves", controlPrefix + "index.html", http.StatusServiceUnavailable, "", "SW_NOT_READY"},
	{"sw.js serves", controlPrefix + "sw.js", http.StatusServiceUnavailable, "", "SW_NOT_READY"},
	{"kernel.wasm serves", controlPrefix + "kernel.wasm", http.StatusServiceUnavailable, "", "SW_NOT_READY"},
	{"deep page serves index", controlPrefix + "p/deep/route", http.StatusServiceUnavailable, "", "SW_NOT_READY"},
	{"allowlisted asset serves", assetPrefix + "zp-core.js", http.StatusServiceUnavailable, "", "SW_NOT_READY"},

	// favicon and worker-bootstrap are served inline (no filesystem).
	{"empty favicon", "/favicon.ico", http.StatusOK, "", ""},
	{"worker bootstrap", controlPrefix + "worker-bootstrap.js", http.StatusOK, "", "importScripts"},

	// control error path returns the sanitized client error class.
	{"control error path", controlPrefix + "error/POLICY_BLOCKED", http.StatusBadRequest, "", "POLICY_BLOCKED"},

	// Security: default-deny for unknown and non-allowlisted asset paths.
	{"unknown path is denied", "/totally/unknown", http.StatusForbidden, "", "POLICY_BLOCKED"},
	{"non-allowlisted asset is denied", assetPrefix + "secret.js", http.StatusForbidden, "", "POLICY_BLOCKED"},
	{"asset path traversal is denied", assetPrefix + "../../etc/passwd", http.StatusForbidden, "", "POLICY_BLOCKED"},
	{"unknown legacy zp asset is denied", "/__zp/secret.js", http.StatusForbidden, "", "POLICY_BLOCKED"},
}

func TestHandleRouting(t *testing.T) {
	// webDir/kernelWASM point at a nonexistent tree on purpose: serve handlers
	// that reach the filesystem fail closed with SW_NOT_READY (503), which is
	// itself an observable, asserted outcome. No real assets are needed.
	s := &server{webDir: "testdata-does-not-exist", kernelWASM: "testdata-does-not-exist/kernel.wasm"}
	for _, tc := range routeCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			s.handle(rec, req)
			tc.assert(t, rec)
		})
	}
}

func (tc routeCase) assert(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != tc.wantStatus {
		t.Fatalf("%s: status = %d, want %d (body %q)", tc.path, rec.Code, tc.wantStatus, rec.Body.String())
	}
	if tc.wantLoc != "" && rec.Header().Get("Location") != tc.wantLoc {
		t.Fatalf("%s: Location = %q, want %q", tc.path, rec.Header().Get("Location"), tc.wantLoc)
	}
	if tc.wantBody != "" && !strings.Contains(rec.Body.String(), tc.wantBody) {
		t.Fatalf("%s: body %q does not contain %q", tc.path, rec.Body.String(), tc.wantBody)
	}
}

// TestServeAssetAllowlist pins serveAsset's allowlist boundary directly: every
// named asset is admitted to the serve path (here failing closed to 503 with no
// real asset tree), while anything off the list is default-denied with
// 403/POLICY_BLOCKED. Admitted assets are asserted to reach the fail-closed
// SW_NOT_READY/503 serve outcome, never 403 and never a stray success.
func TestServeAssetAllowlist(t *testing.T) {
	s := &server{webDir: "testdata-does-not-exist"}

	allowed := []string{
		"zp-core.js", "runtime-prelude.js", "rust-rewriter.js",
		"wasm_exec.js", "worker-prelude.js", "favicon.ico", "manifest.webmanifest",
	}
	for _, name := range allowed {
		req := httptest.NewRequest(http.MethodGet, assetPrefix+name, nil)
		rec := httptest.NewRecorder()
		s.serveAsset(rec, req, name)
		// Admitted to the serve path: with no asset tree present, serveFile
		// fails closed. Asserting the exact 503/SW_NOT_READY rules out both a
		// 403 deny (allowlist regression) and any stray 200/404/500.
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("allowlisted asset %q: status = %d, want 503 (body %q)", name, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "SW_NOT_READY") {
			t.Fatalf("allowlisted asset %q: body %q missing SW_NOT_READY", name, rec.Body.String())
		}
	}

	denied := []string{"secret.js", "config.json", "../main.go", "", "zp-core.js.map"}
	for _, name := range denied {
		req := httptest.NewRequest(http.MethodGet, assetPrefix+name, nil)
		rec := httptest.NewRecorder()
		s.serveAsset(rec, req, name)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("non-allowlisted asset %q: status = %d, want 403", name, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "POLICY_BLOCKED") {
			t.Fatalf("non-allowlisted asset %q: body %q missing POLICY_BLOCKED", name, rec.Body.String())
		}
	}
}

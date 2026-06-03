package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestPageCSPGolden pins cspWithScriptSrc byte-for-byte. This CSP is the
// shell/asset egress-confinement policy (connect-src allow-list, object-src
// 'none', base-uri 'none', default-src 'none'); it was previously unpinned by
// any test, so a refactor could silently drop/reorder a directive or widen
// connect-src. The non-script-src / non-connect-src directive SKELETON is shared
// verbatim with web/zp-core.js fixedCSP (whose JS side is pinned in
// test/js/membrane-invariants.test.js) -- the two are hand-maintained in two
// languages with no shared source, so this golden is the Go half of the
// cross-language divergence guard: drift on either side now fails a test.
func TestPageCSPGolden(t *testing.T) {
	const scriptSrc = "script-src 'self' blob: 'wasm-unsafe-eval'"
	// Everything after connect-src is the language-shared skeleton; if you change
	// it here you must change fixedCSP in web/zp-core.js to match (and vice versa).
	const tail = "; frame-src 'self' blob: data:; child-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'"
	const head = "default-src 'none'; " + scriptSrc + "; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src 'self' "

	t.Run("http request yields ws:// connect-src", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://proxy.example/zp/", nil)
		got := cspWithScriptSrc(req, scriptSrc)
		want := head + "ws://proxy.example" + tail
		if got != want {
			t.Fatalf("cspWithScriptSrc(http) mismatch:\n got=%q\nwant=%q", got, want)
		}
	})

	t.Run("X-Forwarded-Proto https yields wss:// connect-src", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://proxy.example/zp/", nil)
		req.Header.Set("X-Forwarded-Proto", "https")
		got := cspWithScriptSrc(req, scriptSrc)
		want := head + "wss://proxy.example" + tail
		if got != want {
			t.Fatalf("cspWithScriptSrc(xfp=https) mismatch:\n got=%q\nwant=%q", got, want)
		}
	})

	t.Run("empty Host falls back to proxy.example", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://proxy.example/zp/", nil)
		req.Host = ""
		got := cspWithScriptSrc(req, scriptSrc)
		if !strings.Contains(got, "connect-src 'self' ws://proxy.example;") {
			t.Fatalf("empty-host fallback lost: %q", got)
		}
	})

	// Egress-confinement invariants that must hold regardless of inputs: no bare
	// wildcard on connect-src, and the locked-down terminals stay present.
	t.Run("no wildcard egress and locked terminals", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "http://proxy.example/zp/", nil)
		got := cspWithScriptSrc(req, scriptSrc)
		if strings.Contains(got, "connect-src 'self' *") || strings.Contains(got, "connect-src *") {
			t.Fatalf("connect-src must never carry a wildcard: %q", got)
		}
		for _, must := range []string{"default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"} {
			if !strings.Contains(got, must) {
				t.Fatalf("CSP missing locked-down directive %q: %q", must, got)
			}
		}
	})
}

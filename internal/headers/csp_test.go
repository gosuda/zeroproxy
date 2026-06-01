package headers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCSPGolden enforces parity with Rust zp-shared::build_csp output.
// If this fails after intentional CSP changes, regenerate the golden file
// by running cargo test -p zp-shared (which will print the new output)
// then copy it into crates/zp-shared/testdata/csp.golden.
func TestCSPGolden(t *testing.T) {
	want := readGolden(t, "csp.golden")
	got := BuildCSP("wss://proxy.example")
	if got != want {
		t.Fatalf("CSP drift between Rust and Go.\nGo:   %q\nRust: %q", got, want)
	}
}

// TestCSPArmedGolden pins parity with zp-shared on the armed Cloudflare-
// Turnstile branch. If this drifts, regenerate testdata/csp_challenge.golden
// from cargo test -p zp-shared.
func TestCSPArmedGolden(t *testing.T) {
	want := readGolden(t, "csp_challenge.golden")
	got := BuildCSPWith("wss://proxy.example", CSPOptions{ChallengeCompat: true})
	if got != want {
		t.Fatalf("armed CSP drift between Rust and Go.\nGo:   %q\nRust: %q", got, want)
	}
}

// TestCSPDefaultMatchesLegacy pins that BuildCSPWith(zero) equals the legacy
// BuildCSP signature byte-for-byte — callers that have not opted into
// CSPOptions see no change.
func TestCSPDefaultMatchesLegacy(t *testing.T) {
	legacy := BuildCSP("wss://proxy.example")
	opts := BuildCSPWith("wss://proxy.example", CSPOptions{})
	if legacy != opts {
		t.Fatalf("BuildCSPWith zero options diverged from BuildCSP.\nlegacy: %q\nopts:   %q", legacy, opts)
	}
}

func TestCSPStrictNoWildcards(t *testing.T) {
	csp := BuildCSP("wss://proxy.example")
	bad := []string{
		"connect-src *",
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
		"style-src *",
		"img-src *",
		"font-src *",
		"media-src *",
	}
	for _, b := range bad {
		if strings.Contains(csp, b) {
			t.Errorf("CSP must not contain %q; got: %s", b, csp)
		}
	}
	for _, want := range []string{
		"default-src 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"connect-src 'self' wss://proxy.example",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q; got: %s", want, csp)
		}
	}
	if strings.Contains(csp, "challenges.cloudflare.com") {
		t.Errorf("default CSP must not whitelist the Cloudflare challenge host; got: %s", csp)
	}
}

// TestCSPArmedAddsOnlyChallengeHostToFourDirectives pins that the armed
// projection adds exactly one origin (https://challenges.cloudflare.com) to
// exactly four directives (script/frame/child/connect-src) — no wildcards,
// no nonces, no extra eval, no leakage into style/img/font/media/worker.
func TestCSPArmedAddsOnlyChallengeHostToFourDirectives(t *testing.T) {
	armed := BuildCSPWith("wss://proxy.example", CSPOptions{ChallengeCompat: true})
	if got := strings.Count(armed, "https://challenges.cloudflare.com"); got != 4 {
		t.Fatalf("armed CSP must mention challenge host exactly 4 times, got %d:\n%s", got, armed)
	}
	for _, want := range []string{
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
		"frame-src 'self' blob: https://challenges.cloudflare.com",
		"child-src 'self' blob: https://challenges.cloudflare.com",
		"connect-src 'self' wss://proxy.example https://challenges.cloudflare.com",
	} {
		if !strings.Contains(armed, want) {
			t.Errorf("armed CSP missing %q; got: %s", want, armed)
		}
	}
	for _, bad := range []string{
		"style-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
		"img-src 'self' blob: data: https://challenges.cloudflare.com",
		"worker-src 'self' blob: https://challenges.cloudflare.com",
		" *",
		"'nonce-",
	} {
		if strings.Contains(armed, bad) {
			t.Errorf("armed CSP must not contain %q; got: %s", bad, armed)
		}
	}
}

func readGolden(t *testing.T, name string) string {
	t.Helper()
	dir, _ := os.Getwd()
	for i := 0; i < 10; i++ {
		candidate := filepath.Join(dir, "crates", "zp-shared", "testdata", name)
		if data, err := os.ReadFile(candidate); err == nil {
			return strings.TrimRight(string(data), "\r\n")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("%s not found walking up from %s", name, dir)
	return ""
}

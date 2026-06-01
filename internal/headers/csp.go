package headers

import "strings"

// CSPOptions toggles caller-gated CSP projections. The zero value matches
// BuildCSP byte-for-byte (golden-stable).
type CSPOptions struct {
	// ChallengeCompat: when true, project the armed Cloudflare-Turnstile
	// branch. Adds https://challenges.cloudflare.com to exactly four
	// directives (script/frame/child/connect-src). No wildcard, no
	// direct-egress capability, no new eval. The caller is responsible
	// for the per-tab two-signal gate (operator opt-in AND classifier
	// match); this builder is a pure projection. Mirrors
	// zp_shared::CspOptions::challenge_compat.
	ChallengeCompat bool
}

// BuildCSP returns the strict Content-Security-Policy header value for
// ZeroProxy responses. Parity with the Rust implementation in
// crates/zp-shared/src/csp.rs is enforced by the testdata/csp.golden file
// consumed by both `go test ./internal/headers` and `cargo test -p zp-shared`.
//
// wsOrigin is `wss://<proxy-host>` (or `ws://<proxy-host>` over plain HTTP) —
// the only non-self connect target. Wildcards are forbidden.
func BuildCSP(wsOrigin string) string {
	return BuildCSPWith(wsOrigin, CSPOptions{})
}

// BuildCSPWith returns the CSP with explicit policy options. With the zero
// CSPOptions the output is byte-identical to BuildCSP. Armed challenge mode
// adds https://challenges.cloudflare.com to script/frame/child/connect-src;
// see testdata/csp_challenge.golden for the pinned wire form.
func BuildCSPWith(wsOrigin string, opts CSPOptions) string {
	ws := strings.TrimSpace(wsOrigin)
	const cfHost = "https://challenges.cloudflare.com"
	cfSuffix := ""
	if opts.ChallengeCompat {
		cfSuffix = " " + cfHost
	}
	segments := []string{
		"default-src 'none'",
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'" + cfSuffix,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data:",
		"font-src 'self' data:",
		"media-src 'self' blob:",
		"connect-src 'self' " + ws + cfSuffix,
		"frame-src 'self' blob:" + cfSuffix,
		"child-src 'self' blob:" + cfSuffix,
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}
	return strings.Join(segments, "; ")
}

package headers

import (
	"net/http"
	"net/url"
	"strings"
)

// ChallengeHost is the exact Cloudflare-Turnstile widget host. Case-insensitive
// equality. Mirrors zp_shared::CHALLENGE_HOST; parity is enforced via
// crates/zp-shared/testdata/challenge_cases.json consumed by both
// `go test ./internal/headers` and `cargo test -p zp-shared`.
const ChallengeHost = "challenges.cloudflare.com"

// ChallengePlatformPrefix is the same-zone challenge-platform orchestration
// loader path prefix. Exact-prefix match on the URL path component (query and
// fragment never participate). Mirrors zp_shared::CHALLENGE_PLATFORM_PREFIX.
const ChallengePlatformPrefix = "/cdn-cgi/challenge-platform/"

// IsChallengeDocument is the pure predicate form. Returns true when:
//  1. cfMitigated, trimmed and lowered, equals "challenge"; or
//  2. host equals ChallengeHost case-insensitively; or
//  3. path starts with ChallengePlatformPrefix (path match is case-sensitive
//     because the upstream emits a fixed canonical lowercase path).
//
// Pure: no I/O, no body access. The Rust parity test in zp_shared::challenge
// shares the same golden vectors.
func IsChallengeDocument(cfMitigated, host, path string) bool {
	cf := strings.TrimSpace(cfMitigated)
	if cf != "" && strings.EqualFold(cf, "challenge") {
		return true
	}
	if strings.EqualFold(host, ChallengeHost) {
		return true
	}
	return strings.HasPrefix(path, ChallengePlatformPrefix)
}

// TargetIsChallengeDocument is the HTTP-typed wrapper around
// IsChallengeDocument. It reads ONLY headers and the final URL — never the
// response body. nil-safe on both args.
func TargetIsChallengeDocument(header http.Header, finalURL *url.URL) bool {
	cf := ""
	if header != nil {
		cf = header.Get("Cf-Mitigated")
	}
	host, path := "", ""
	if finalURL != nil {
		host = finalURL.Hostname()
		path = finalURL.Path
	}
	return IsChallengeDocument(cf, host, path)
}

// ChallengeSubresourceSkip is the two-signal gate for the ConstructorPolicy
// Cache-Control: no-store skip. Returns true ONLY when ALL hold: the tab is
// armed (operator opt-in), the request is NOT a document navigation
// (isDoc==false), and the response classifies as a challenge by header/URL.
// The isDoc==false term keeps the challenge DOCUMENT (navigation HTML) on
// no-store and lets ONLY classified SUBRESOURCES preserve Cloudflare's cache
// semantics for its turnstile api.js etc.
//
// Pure predicate, header+URL only; it never reads the body, grants no egress,
// and manufactures no eval.
func ChallengeSubresourceSkip(armed, isDoc bool, header http.Header, finalURL *url.URL) bool {
	if !armed || isDoc {
		return false
	}
	return TargetIsChallengeDocument(header, finalURL)
}

// ApplyChallengeCompat emits the internal X-ZP-Challenge-Compat marker header
// ONLY when BOTH gate signals are present: the per-tab arm opt-in (armed) AND
// header/URL classification as a challenge document. Inert otherwise, so the
// non-armed (default) path is byte-identical to today.
//
// B4 STRIP OBLIGATION: this internal marker MUST be consumed-and-deleted at
// the service-worker layer before the response reaches the proxied page, in
// the SAME place X-ZP-Dynamic-Compile is read+deleted. Without that strip the
// page sees the internal control header and the leak undermines the
// fingerprint-blind contract.
func ApplyChallengeCompat(header http.Header, armed bool, finalURL *url.URL) {
	if !armed || header == nil {
		return
	}
	if !TargetIsChallengeDocument(header, finalURL) {
		return
	}
	header.Set("X-ZP-Challenge-Compat", "1")
}

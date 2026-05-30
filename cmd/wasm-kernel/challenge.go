package main

import (
	"net/http"
	"net/url"
	"strings"
)

// challengeCompatHost is the exact Cloudflare challenge widget origin host.
const challengeCompatHost = "challenges.cloudflare.com"

// challengePlatformPrefix is the same-zone orchestration loader path prefix.
const challengePlatformPrefix = "/cdn-cgi/challenge-platform/"

// targetIsChallengeDocument classifies a target response as a Cloudflare
// challenge document or subresource using HEADERS and the FINAL URL ONLY.
// It NEVER reads or sniffs the response body. It is a pure predicate with no
// side effects: it does not synthesize, solve, or bypass the challenge.
func targetIsChallengeDocument(header http.Header, finalURL *url.URL) bool {
	if header != nil && strings.EqualFold(strings.TrimSpace(header.Get("Cf-Mitigated")), "challenge") {
		return true
	}
	if finalURL == nil {
		return false
	}
	if strings.EqualFold(finalURL.Hostname(), challengeCompatHost) {
		return true
	}
	return strings.HasPrefix(finalURL.Path, challengePlatformPrefix)
}

// applyChallengeCompat emits the internal X-ZP-Challenge-Compat marker header
// ONLY when BOTH gate signals are present: the per-tab arm opt-in (armed) AND
// header/URL classification as a challenge document. It is INERT otherwise, so
// the non-armed (default) path is byte-identical to today. This marker only
// signals the downstream service worker; it grants no egress and manufactures
// no eval (the existing target-authoritative eval gate is unchanged).
func applyChallengeCompat(header http.Header, armed bool, finalURL *url.URL) {
	if !armed || header == nil {
		return
	}
	if !targetIsChallengeDocument(header, finalURL) {
		return
	}
	// B4 STRIP OBLIGATION: this internal marker MUST be consumed-and-deleted at
	// the service-worker layer before the response reaches the proxied page, in
	// the SAME place X-ZP-Dynamic-Compile is read+deleted (web/sw.js addCSP).
	// Neither addCSP nor runtime-prelude.js filteredResponseHeaders (which only
	// strips the x-zp-response-* prefix) catches X-ZP-Challenge-Compat today, so
	// whoever introduces the arm sender (B-series) must add the strip there;
	// renaming to x-zp-response-* is INSUFFICIENT because navigation/document
	// responses bypass filteredResponseHeaders. In B1 nothing arms a tab, so this
	// line never executes and the OFF path stays byte-identical.
	header.Set("X-ZP-Challenge-Compat", "1")
}

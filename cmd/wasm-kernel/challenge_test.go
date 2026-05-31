package main

import (
	"net/http"
	"net/url"
	"testing"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

func TestTargetIsChallengeDocument(t *testing.T) {
	cases := []struct {
		name   string
		header http.Header
		url    string
		want   bool
	}{
		{
			name:   "cf-mitigated challenge header",
			header: http.Header{"Cf-Mitigated": {"challenge"}},
			url:    "https://example.com/protected",
			want:   true,
		},
		{
			name:   "cf-mitigated challenge header mixed case and spaces",
			header: http.Header{"Cf-Mitigated": {" Challenge "}},
			url:    "https://example.com/protected",
			want:   true,
		},
		{
			name:   "challenges.cloudflare.com origin",
			header: http.Header{},
			url:    "https://challenges.cloudflare.com/turnstile/v0/api.js",
			want:   true,
		},
		{
			name:   "challenges.cloudflare.com origin case-insensitive",
			header: http.Header{},
			url:    "https://Challenges.Cloudflare.Com/turnstile/v0/api.js",
			want:   true,
		},
		{
			name:   "challenge-platform orchestrate path prefix",
			header: http.Header{},
			url:    "https://2captcha.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc",
			want:   true,
		},
		{
			name:   "non-challenge document",
			header: http.Header{"Content-Type": {"text/html"}},
			url:    "https://example.com/index.html",
			want:   false,
		},
		{
			name:   "cf-mitigated non-challenge value",
			header: http.Header{"Cf-Mitigated": {"challenge-bypass"}},
			url:    "https://example.com/index.html",
			want:   false,
		},
		{
			name:   "lookalike suffix host is not a match",
			header: http.Header{},
			url:    "https://evil-challenges.cloudflare.com.attacker.test/x",
			want:   false,
		},
		{
			name:   "unrelated cdn-cgi path is not a match",
			header: http.Header{},
			url:    "https://example.com/cdn-cgi/trace",
			want:   false,
		},
		{
			name:   "nil header with non-challenge url",
			header: nil,
			url:    "https://example.com/index.html",
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := targetIsChallengeDocument(tc.header, mustURL(t, tc.url))
			if got != tc.want {
				t.Fatalf("targetIsChallengeDocument(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

func TestTargetIsChallengeDocumentNilURL(t *testing.T) {
	if targetIsChallengeDocument(http.Header{}, nil) {
		t.Fatal("nil finalURL with empty header must not classify as challenge")
	}
	if !targetIsChallengeDocument(http.Header{"Cf-Mitigated": {"challenge"}}, nil) {
		t.Fatal("cf-mitigated challenge header must classify even with nil finalURL")
	}
}

func TestApplyChallengeCompatGateMatrix(t *testing.T) {
	challengeURL := mustURL(t, "https://challenges.cloudflare.com/turnstile/v0/api.js")
	plainURL := mustURL(t, "https://example.com/index.html")

	// Armed + classified challenge -> marker emitted.
	h := http.Header{}
	applyChallengeCompat(h, true, challengeURL)
	if h.Get("X-ZP-Challenge-Compat") != "1" {
		t.Fatal("armed + challenge must emit X-ZP-Challenge-Compat: 1")
	}

	// Armed + non-challenge -> no marker (classification gate).
	h = http.Header{}
	applyChallengeCompat(h, true, plainURL)
	if h.Get("X-ZP-Challenge-Compat") != "" {
		t.Fatal("armed + non-challenge must not emit marker")
	}

	// Not armed + classified challenge -> no marker (OFF-path proof).
	h = http.Header{}
	applyChallengeCompat(h, false, challengeURL)
	if h.Get("X-ZP-Challenge-Compat") != "" {
		t.Fatal("not armed + challenge must not emit marker (default OFF path)")
	}

	// Not armed + non-challenge -> no marker.
	h = http.Header{}
	applyChallengeCompat(h, false, plainURL)
	if h.Get("X-ZP-Challenge-Compat") != "" {
		t.Fatal("not armed + non-challenge must not emit marker")
	}
}

func TestApplyChallengeCompatNilHeaderNoPanic(t *testing.T) {
	// Armed + classified but nil header must not panic.
	applyChallengeCompat(nil, true, mustURL(t, "https://challenges.cloudflare.com/x"))
}

// TestChallengeSubresourceSkip pins the gate that decides the no-store skip. The
// SECURITY-LOAD-BEARING term is isDoc: a classified challenge DOCUMENT
// (navigation) must NOT get the skip even when armed, so its HTML stays on
// no-store; only an armed, classified SUBRESOURCE returns true. Deleting the
// isDoc guard would make the document case return true and turn this red.
func TestChallengeSubresourceSkip(t *testing.T) {
	challengeURL := mustURL(t, "https://challenges.cloudflare.com/turnstile/v0/api.js")
	plainURL := mustURL(t, "https://example.com/index.html")
	cfHeader := http.Header{"Cf-Mitigated": {"challenge"}}

	cases := []struct {
		name   string
		armed  bool
		isDoc  bool
		header http.Header
		url    *url.URL
		want   bool
	}{
		{name: "armed subresource on challenge origin -> skip", armed: true, isDoc: false, header: http.Header{}, url: challengeURL, want: true},
		{name: "armed subresource via cf-mitigated -> skip", armed: true, isDoc: false, header: cfHeader, url: plainURL, want: true},
		{name: "armed DOCUMENT on challenge origin -> keep (isDoc guard)", armed: true, isDoc: true, header: http.Header{}, url: challengeURL, want: false},
		{name: "armed DOCUMENT via cf-mitigated -> keep (isDoc guard)", armed: true, isDoc: true, header: cfHeader, url: plainURL, want: false},
		{name: "not armed subresource -> keep (default OFF)", armed: false, isDoc: false, header: http.Header{}, url: challengeURL, want: false},
		{name: "armed subresource non-challenge -> keep (classification gate)", armed: true, isDoc: false, header: http.Header{}, url: plainURL, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := challengeSubresourceSkip(tc.armed, tc.isDoc, tc.header, tc.url)
			if got != tc.want {
				t.Fatalf("challengeSubresourceSkip(armed=%v,isDoc=%v) = %v, want %v", tc.armed, tc.isDoc, got, tc.want)
			}
		})
	}
}

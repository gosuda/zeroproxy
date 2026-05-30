package zphttp

import (
	"net/http"
	"net/url"
	"testing"
)

// C0 membrane freeze: pin request-construction invariants of BuildHTTP1Request
// and the referer/origin policy helpers. White-box (package zphttp) so the
// unexported helpers are exercised directly.

// TestBuildHTTP1RequestPinsFullClientHintSet pins the EXACT Sec-CH-UA client
// hint set and values written onto the wire request. The existing test checks
// only Platform + Full-Version; this pins the whole spoofed identity. A change
// to setTargetClientHints (dropped header, changed value) turns this red.
func TestBuildHTTP1RequestPinsFullClientHintSet(t *testing.T) {
	target, _ := url.Parse("https://example.com/")
	wire, err := BuildHTTP1Request(nil, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Test-local literals (NOT the production constants) so that changing the
	// spoofed identity constants makes this freeze go red -- that is the point.
	want := map[string]string{
		"Sec-CH-UA":                   `"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"`,
		"Sec-CH-UA-Mobile":            "?0",
		"Sec-CH-UA-Platform":          `"Windows"`,
		"Sec-CH-UA-Arch":              `"x86"`,
		"Sec-CH-UA-Bitness":           `"64"`,
		"Sec-CH-UA-Full-Version":      `"134.0.0.0"`,
		"Sec-CH-UA-Full-Version-List": `"Chromium";v="134.0.0.0", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="134.0.0.0"`,
		"Sec-CH-UA-Model":             `""`,
		"Sec-CH-UA-Platform-Version":  `"10.0.0"`,
		"User-Agent":                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
		"Accept-Encoding":             "identity",
	}
	for name, w := range want {
		if got := wire.Header.Get(name); got != w {
			t.Fatalf("%s = %q, want %q", name, got, w)
		}
	}
}

// TestBuildHTTP1RequestStripsClientHintSpoofAttempt pins that a browser-supplied
// Sec-CH-UA (and Accept-Encoding) value is overwritten, never trusted. If the
// Del/Set in setTargetClientHints or the Accept-Encoding override were removed,
// the attacker-controlled value would survive and this fails.
func TestBuildHTTP1RequestStripsClientHintSpoofAttempt(t *testing.T) {
	target, _ := url.Parse("https://example.com/")
	src, _ := http.NewRequest("GET", target.String(), nil)
	src.Header.Set("Sec-CH-UA-Platform", `"Linux"`)
	src.Header.Set("Sec-CH-UA-Model", `"Pixel"`)
	src.Header.Set("Accept-Encoding", "gzip, br")
	src.Header.Set("User-Agent", "EvilBot/1.0")
	wire, err := BuildHTTP1Request(src, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	if wire.Header.Get("Sec-CH-UA-Platform") != `"Windows"` {
		t.Fatalf("client-hint platform spoof survived: %q", wire.Header.Get("Sec-CH-UA-Platform"))
	}
	if wire.Header.Get("Sec-CH-UA-Model") != `""` {
		t.Fatalf("client-hint model spoof survived: %q", wire.Header.Get("Sec-CH-UA-Model"))
	}
	if wire.Header.Get("Accept-Encoding") != "identity" {
		t.Fatalf("Accept-Encoding not forced to identity: %q", wire.Header.Get("Accept-Encoding"))
	}
	if wire.Header.Get("User-Agent") != TargetUserAgent {
		t.Fatalf("User-Agent spoof survived: %q", wire.Header.Get("User-Agent"))
	}
}

// TestBuildHTTP1RequestRejectsNonHTTPScheme pins the fail-closed protocol guard:
// a non-http(s) target yields TARGET_PROTOCOL_BLOCKED and no request. Removing
// the scheme check would let arbitrary schemes through.
func TestBuildHTTP1RequestRejectsNonHTTPScheme(t *testing.T) {
	for _, scheme := range []string{"ftp", "file", "ws", "gopher"} {
		target := &url.URL{Scheme: scheme, Host: "example.com", Path: "/"}
		wire, err := BuildHTTP1Request(nil, target, nil)
		if err == nil || wire != nil {
			t.Fatalf("scheme %q must be blocked, got wire=%v err=%v", scheme, wire, err)
		}
		if err.Error() != "TARGET_PROTOCOL_BLOCKED" {
			t.Fatalf("scheme %q wrong error: %v", scheme, err)
		}
	}
}

// TestRefererHeaderHTTPSDowngradeSuppression pins the fail-closed referer
// downgrade branch: an https source navigating to an http target leaks NO
// referer under default / strict-origin-when-cross-origin /
// no-referrer-when-downgrade policies. Deleting that branch would leak the
// secure-origin URL onto a plaintext request.
func TestRefererHeaderHTTPSDowngradeSuppression(t *testing.T) {
	source, _ := url.Parse("https://app.secure.test/page")
	httpTarget, _ := url.Parse("http://plain.test/x")
	for _, pol := range []string{"", "strict-origin-when-cross-origin", "no-referrer-when-downgrade"} {
		p := RequestPolicy{DocumentURL: source, ReferrerPolicy: pol}
		if got := refererHeader(httpTarget, p); got != "" {
			t.Fatalf("https->http referer leaked under policy %q: %q", pol, got)
		}
	}
	// Same source -> https target under default policy DOES send a referer:
	// pins that suppression is specific to the downgrade, not a blanket empty.
	httpsTarget, _ := url.Parse("https://other.test/y")
	if got := refererHeader(httpsTarget, RequestPolicy{DocumentURL: source}); got == "" {
		t.Fatal("https->https default policy should still send a referer")
	}
}

// TestRefererAndOriginPolicyMatrix pins representative referer/origin policy
// outcomes via the unexported helpers. Each row maps to a switch arm that a
// regression could flip.
func TestRefererAndOriginPolicyMatrix(t *testing.T) {
	source, _ := url.Parse("https://app.example.test/page?q=1#frag")
	sameTarget, _ := url.Parse("https://app.example.test/other")
	crossTarget, _ := url.Parse("https://api.example.test/data")

	// no-referrer: always empty.
	if got := refererHeader(crossTarget, RequestPolicy{DocumentURL: source, ReferrerPolicy: "no-referrer"}); got != "" {
		t.Fatalf("no-referrer leaked: %q", got)
	}
	// strict-origin cross-site: bare origin, no path (and never the full URL).
	if got := refererHeader(crossTarget, RequestPolicy{DocumentURL: source, ReferrerPolicy: "strict-origin"}); got != "https://app.example.test/" {
		t.Fatalf("strict-origin cross = %q", got)
	}
	// same-origin policy, cross-site target: empty.
	if got := refererHeader(crossTarget, RequestPolicy{DocumentURL: source, ReferrerPolicy: "same-origin"}); got != "" {
		t.Fatalf("same-origin policy cross-site should be empty: %q", got)
	}
	// same-origin policy, same-origin target: full URL minus fragment.
	if got := refererHeader(sameTarget, RequestPolicy{DocumentURL: source, ReferrerPolicy: "same-origin"}); got != "https://app.example.test/page?q=1" {
		t.Fatalf("same-origin policy same-site = %q", got)
	}

	// originHeader: cross-origin GET in cors mode emits the source origin.
	gotOrigin := originHeader("GET", crossTarget, RequestPolicy{DocumentURL: source, Mode: "cors"})
	if gotOrigin != "https://app.example.test" {
		t.Fatalf("cross-origin cors GET origin = %q", gotOrigin)
	}
	// Same-origin GET: no Origin header.
	if got := originHeader("GET", sameTarget, RequestPolicy{DocumentURL: source, Mode: "cors"}); got != "" {
		t.Fatalf("same-origin GET should omit Origin: %q", got)
	}
	// Non-safe method always emits Origin regardless of mode.
	if got := originHeader("POST", sameTarget, RequestPolicy{DocumentURL: source, Mode: "navigate"}); got != "https://app.example.test" {
		t.Fatalf("POST should always send Origin: %q", got)
	}
}

// TestPolicyFromRequestDefaultsAndOverrides pins the default fetch policy and
// the X-Zp-* override plumbing, including that a non-http document URL is
// rejected (fail-closed: DocumentURL stays nil rather than trusting a
// javascript:/data: source).
func TestPolicyFromRequestDefaultsAndOverrides(t *testing.T) {
	def := policyFromRequest(nil)
	if def.Credentials != "include" || def.Mode != "navigate" || def.Redirect != "follow" ||
		def.Referrer != "about:client" || def.ReferrerPolicy != "strict-origin-when-cross-origin" {
		t.Fatalf("default policy drifted: %#v", def)
	}

	src, _ := http.NewRequest("GET", "https://example.com/", nil)
	src.Header.Set("X-Zp-Fetch-Credentials", "OMIT")
	src.Header.Set("X-Zp-Document-Url", "javascript:alert(1)")
	src.Header.Set("X-Zp-Document-Request", "1")
	p := policyFromRequest(src)
	if p.Credentials != "omit" {
		t.Fatalf("credentials override/lowercasing failed: %q", p.Credentials)
	}
	if p.DocumentURL != nil {
		t.Fatalf("non-http document URL must be rejected, got %v", p.DocumentURL)
	}
	if !p.DocumentRequest {
		t.Fatalf("document-request flag not honored")
	}
}

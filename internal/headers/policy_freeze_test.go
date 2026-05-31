package headers

import (
	"net/http"
	"testing"
)

// C0 membrane freeze: pin the EXACT response-header strip ("hidden") set of
// ConstructorPolicy. These tests characterize current behavior; each assertion
// names a fail-closed branch whose deletion would turn it red.

// TestConstructorPolicyStripsFullHiddenSet pins every member of the hidden set
// that the existing policy_test.go does not already cover. If any entry is
// removed from the `hidden` map, a sensitive target header would leak onto the
// browser Response and this test fails.
func TestConstructorPolicyStripsFullHiddenSet(t *testing.T) {
	// NOTE: the real code strips "service-worker-allowed" (NOT "sw-allowed").
	strip := []string{
		"Set-Cookie", "Set-Cookie2",
		"Content-Security-Policy", "Content-Security-Policy-Report-Only",
		"Report-To", "Reporting-Endpoints", "NEL",
		"Service-Worker-Allowed",
		"SourceMap", "X-SourceMap",
		"Alt-Svc", "Link", "Refresh", "Clear-Site-Data",
	}
	src := http.Header{}
	for _, name := range strip {
		src.Set(name, "sentinel-"+name)
	}
	out := ConstructorPolicy(src, false, false, false)
	for _, name := range strip {
		if out.Get(name) != "" {
			t.Fatalf("hidden header %q leaked onto Response: %#v", name, out)
		}
	}
}

// TestConstructorPolicyPassesThroughCrossOriginIsolation pins that the
// COOP/COEP/CORP family is NOT in the hidden set and survives untouched.
// A regression that "hardened" the proxy by adding these to `hidden` would
// silently break cross-origin isolation for the proxied page and turn this red.
func TestConstructorPolicyPassesThroughCrossOriginIsolation(t *testing.T) {
	src := http.Header{
		"Cross-Origin-Opener-Policy":   {"same-origin"},
		"Cross-Origin-Embedder-Policy": {"require-corp"},
		"Cross-Origin-Resource-Policy": {"same-site"},
	}
	out := ConstructorPolicy(src, true, true, false)
	cases := map[string]string{
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-site",
	}
	for name, want := range cases {
		if got := out.Get(name); got != want {
			t.Fatalf("%s must pass through, got %q want %q: %#v", name, got, want, out)
		}
	}
}

// TestConstructorPolicyConditionalEncodingHeaders pins the CONDITIONAL strip
// branches: Content-Length is dropped only when bodyTransformed, and
// Content-Encoding only when bodyDecoded. When the flags are false the headers
// must be preserved. This pins the branches themselves, not a blanket strip --
// a change to an unconditional drop (or a no-op) would fail one half.
func TestConstructorPolicyConditionalEncodingHeaders(t *testing.T) {
	// Flags false: both preserved.
	keep := ConstructorPolicy(http.Header{
		"Content-Length":   {"123"},
		"Content-Encoding": {"gzip"},
	}, false, false, false)
	if keep.Get("Content-Length") != "123" {
		t.Fatalf("Content-Length must survive when bodyTransformed=false: %#v", keep)
	}
	if keep.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding must survive when bodyDecoded=false: %#v", keep)
	}

	// bodyTransformed strips Content-Length but keeps Content-Encoding.
	transformed := ConstructorPolicy(http.Header{
		"Content-Length":   {"123"},
		"Content-Encoding": {"gzip"},
	}, true, false, false)
	if transformed.Get("Content-Length") != "" {
		t.Fatalf("Content-Length must be stripped when bodyTransformed=true: %#v", transformed)
	}
	if transformed.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding must survive when bodyDecoded=false: %#v", transformed)
	}

	// bodyDecoded strips Content-Encoding but keeps Content-Length.
	decoded := ConstructorPolicy(http.Header{
		"Content-Length":   {"123"},
		"Content-Encoding": {"gzip"},
	}, false, true, false)
	if decoded.Get("Content-Encoding") != "" {
		t.Fatalf("Content-Encoding must be stripped when bodyDecoded=true: %#v", decoded)
	}
	if decoded.Get("Content-Length") != "123" {
		t.Fatalf("Content-Length must survive when bodyTransformed=false: %#v", decoded)
	}

	// Both flags true: both stripped. Pins that the two branches are
	// independent (not an else-if where one would survive).
	both := ConstructorPolicy(http.Header{
		"Content-Length":   {"123"},
		"Content-Encoding": {"gzip"},
	}, true, true, false)
	if both.Get("Content-Length") != "" || both.Get("Content-Encoding") != "" {
		t.Fatalf("both encoding headers must be stripped when transformed+decoded: %#v", both)
	}
}

// TestConstructorPolicyStripsLocationAndHopByHop pins that Location is always
// withheld (the redirect engine re-adds it later) and that hop-by-hop headers
// are filtered. Deleting either the location branch or isHopByHop's switch
// would turn this red.
func TestConstructorPolicyStripsLocationAndHopByHop(t *testing.T) {
	out := ConstructorPolicy(http.Header{
		"Location":          {"https://target.example/next"},
		"Connection":        {"keep-alive"},
		"Transfer-Encoding": {"chunked"},
		"Upgrade":           {"h2c"},
		"Content-Type":      {"text/html"},
	}, false, false, false)
	for _, name := range []string{"Location", "Connection", "Transfer-Encoding", "Upgrade"} {
		if out.Get(name) != "" {
			t.Fatalf("%s must be withheld from Response: %#v", name, out)
		}
	}
	if out.Get("Content-Type") != "text/html" {
		t.Fatalf("benign header dropped: %#v", out)
	}
}

// TestHiddenHeaderTableOracle pins HiddenHeader as the filtering oracle used by
// BuildHTTP1Request: hidden entries and hop-by-hop headers are reported true;
// COOP/COEP/CORP and benign headers are reported false. Case-insensitivity is
// pinned too. If the hidden set or isHopByHop changes, this fails.
func TestHiddenHeaderTableOracle(t *testing.T) {
	hiddenTrue := []string{
		"set-cookie", "SET-COOKIE2", "content-security-policy",
		"content-security-policy-report-only", "report-to", "reporting-endpoints",
		"nel", "service-worker-allowed", "sourcemap", "x-sourcemap",
		"alt-svc", "link", "refresh", "clear-site-data",
		// hop-by-hop
		"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade",
	}
	for _, name := range hiddenTrue {
		if !HiddenHeader(name) {
			t.Fatalf("HiddenHeader(%q) must be true", name)
		}
	}
	passThrough := []string{
		"Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy",
		"Cross-Origin-Resource-Policy", "Content-Type", "Accept", "Cache-Control",
		"User-Agent",
	}
	for _, name := range passThrough {
		if HiddenHeader(name) {
			t.Fatalf("HiddenHeader(%q) must be false (passes through)", name)
		}
	}
}

package headers

import (
	"net/http"
	"testing"
)

func TestConstructorPolicyStripsForbiddenHeaders(t *testing.T) {
	h := http.Header{"Set-Cookie": {"a=b"}, "Content-Security-Policy": {"default-src *"}, "Location": {"https://target/"}, "Alt-Svc": {"h3=\":443\""}, "Content-Type": {"text/html"}, "Content-Length": {"10"}}
	out := ConstructorPolicy(h, true, false, false)
	for _, name := range []string{"Set-Cookie", "Content-Security-Policy", "Location", "Alt-Svc", "Content-Length"} {
		if out.Get(name) != "" {
			t.Fatalf("%s leaked: %#v", name, out)
		}
	}
	if out.Get("Content-Type") != "text/html" || out.Get("Cache-Control") != "no-store" || out.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("safe headers missing: %#v", out)
	}
	if out.Get("Access-Control-Allow-Origin") != "*" || out.Get("Access-Control-Allow-Headers") != "*" {
		t.Fatalf("CORS emulation headers missing: %#v", out)
	}
}

// TestConstructorPolicyArmedPreservesCacheControl pins the only semantic
// difference of the armed branch: when challengeCompat=true the upstream
// Cache-Control survives (Cloudflare's challenge subresource cache contract).
// Every other strip and the CORS emulation stay identical to the OFF path.
func TestConstructorPolicyArmedPreservesCacheControl(t *testing.T) {
	h := http.Header{
		"Cache-Control": {"public, max-age=3600"},
		"Set-Cookie":    {"a=b"},
		"Content-Type":  {"application/javascript"},
		"Location":      {"https://target/"},
	}
	out := ConstructorPolicy(h, false, false, true)
	if got := out.Get("Cache-Control"); got != "public, max-age=3600" {
		t.Fatalf("armed branch must preserve upstream Cache-Control, got %q", got)
	}
	if out.Get("Set-Cookie") != "" {
		t.Fatalf("armed branch must still strip Set-Cookie, got %#v", out)
	}
	if out.Get("Location") != "" {
		t.Fatalf("armed branch must still strip Location (redirect engine re-adds), got %#v", out)
	}
	if out.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("armed branch must still emit nosniff guard, got %#v", out)
	}
	if out.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("armed branch must still emit CORS emulation, got %#v", out)
	}
}

// TestConstructorPolicyArmedFalseEqualsLegacyOff pins that the OFF path
// (challengeCompat=false) is behaviorally identical to the pre-armed signature
// — every existing call site sees no observable change.
func TestConstructorPolicyArmedFalseEqualsLegacyOff(t *testing.T) {
	h := http.Header{
		"Cache-Control": {"public, max-age=3600"},
		"Content-Type":  {"text/html"},
	}
	out := ConstructorPolicy(h, false, false, false)
	if got := out.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("OFF path must overwrite Cache-Control to no-store, got %q", got)
	}
}

package headers

import (
	"net/http"
	"testing"
)

func TestConstructorPolicyStripsForbiddenHeaders(t *testing.T) {
	h := http.Header{"Set-Cookie": {"a=b"}, "Content-Security-Policy": {"default-src *"}, "Location": {"https://target/"}, "Alt-Svc": {"h3=\":443\""}, "Content-Type": {"text/html"}, "Content-Length": {"10"}}
	out := ConstructorPolicy(h, true, false)
	for _, name := range []string{"Set-Cookie", "Content-Security-Policy", "Location", "Alt-Svc", "Content-Length"} {
		if out.Get(name) != "" {
			t.Fatalf("%s leaked: %#v", name, out)
		}
	}
	if out.Get("Content-Type") != "text/html" || out.Get("Cache-Control") != "no-store" {
		t.Fatalf("safe headers missing: %#v", out)
	}
	if out.Get("Access-Control-Allow-Origin") != "*" || out.Get("Access-Control-Allow-Headers") != "*" {
		t.Fatalf("CORS emulation headers missing: %#v", out)
	}
}

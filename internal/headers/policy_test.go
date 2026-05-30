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

// TestConstructorPolicyChallengeCompatSkipsNoStore pins the B2 challenge-compat
// behavior. challengeCompat is a CALLER-COMPUTED bool: the caller has already
// gated it on the per-tab arm AND classified the response as a challenge
// SUBRESOURCE (never the document). At this layer the only contract is: when
// the bool is true the no-store overwrite is SKIPPED so the target's own
// Cache-Control survives; when false it is applied. The document-vs-subresource
// discrimination lives in the caller (!isDocumentRequest), so this unit pins the
// SUBRESOURCE (skip) and DOCUMENT/default (keep) outcomes via the bool.
func TestConstructorPolicyChallengeCompatSkipsNoStore(t *testing.T) {
	// Subresource path (challengeCompat=true): a present target Cache-Control
	// survives untouched -- Cloudflare's cache/update semantics for api.js are
	// preserved, not overwritten with no-store.
	sub := ConstructorPolicy(http.Header{
		"Cache-Control": {"public, max-age=300"},
		"Content-Type":  {"text/javascript"},
	}, false, false, true)
	if got := sub.Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("challenge subresource must preserve target Cache-Control, got %q: %#v", got, sub)
	}

	// Subresource path with NO target Cache-Control: the "no header" semantics
	// survive (we must NOT synthesize no-store back in).
	subNoCC := ConstructorPolicy(http.Header{
		"Content-Type": {"text/javascript"},
	}, false, false, true)
	if got := subNoCC.Get("Cache-Control"); got != "" {
		t.Fatalf("challenge subresource without Cache-Control must stay header-less, got %q: %#v", got, subNoCC)
	}

	// Document/default path (challengeCompat=false): no-store is still applied,
	// exactly as today. This is what the caller passes for the challenge DOCUMENT
	// and for every non-challenge response.
	doc := ConstructorPolicy(http.Header{
		"Cache-Control": {"public, max-age=300"},
		"Content-Type":  {"text/html"},
	}, false, false, false)
	if got := doc.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("challenge document / default path must keep no-store, got %q: %#v", got, doc)
	}
}

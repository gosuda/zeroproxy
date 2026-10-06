package httphost

import (
	"strings"
	"testing"
)

// A synchronous XHR's response goes back through an allowlist. The cookie delta —
// the non-HttpOnly changes the service worker made to the jar — is on it; the
// response's own Set-Cookie never is.
func TestSafeSyncHeader(t *testing.T) {
	for _, name := range []string{"Content-Type", "ETag", "X-ZP-Cookie-Delta", "x-zp-cookie-delta"} {
		if !safeSyncHeader(name) {
			t.Errorf("%q should pass", name)
		}
	}
	for _, name := range []string{"Set-Cookie", "set-cookie", "Cookie", "Authorization", "X-ZP-Set-Cookie", "Location", "X-ZP-Sync-Err"} {
		if safeSyncHeader(name) {
			t.Errorf("%q must not pass", name)
		}
	}
}

func TestParsePendingCookies(t *testing.T) {
	got := parsePendingCookies([]string{
		`["w1","a=1; Path=/"]`,
		`not json`,
		`["only-one"]`,
		`["","empty id"]`,
		`["w2","b=2"]`,
		`["w3","` + strings.Repeat("x", 9000) + `"]`,
	})
	if len(got) != 2 || got[0][0] != "w1" || got[0][1] != "a=1; Path=/" || got[1][0] != "w2" {
		t.Fatalf("shape and bounds: %#v", got)
	}
	var many []string
	for i := 0; i < 50; i++ {
		many = append(many, `["w","c=1"]`)
	}
	if n := len(parsePendingCookies(many)); n != 32 {
		t.Fatalf("at most 32 writes ride one request, got %d", n)
	}
	if parsePendingCookies(nil) != nil {
		t.Fatal("nothing pending: nothing carried")
	}
}

func TestCorsMode(t *testing.T) {
	for in, want := range map[string]string{
		"anonymous": "anonymous", "use-credentials": "use-credentials",
		"": "", "include": "", "Anonymous": "", "anonymous; x": "",
	} {
		if got := corsMode(in); got != want {
			t.Errorf("corsMode(%q) = %q, want %q", in, got, want)
		}
	}
}

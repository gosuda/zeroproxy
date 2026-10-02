package httphost

import "testing"

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

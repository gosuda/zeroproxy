package cookiejar

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// TestSetDocumentCookieCannotClobberHttpOnly is the adversarial pin for the
// document.cookie HttpOnly-overwrite vector. A proxied page driving
// document.cookie (the non-HTTP API) must not overwrite, nor strip the HttpOnly
// flag from, a server-set HttpOnly session cookie. RFC 6265 §5.3: a non-HTTP API
// may neither create an HttpOnly cookie nor replace an existing one. Without the
// guard, the (Name,Domain,Path) upsert match replaces the server cookie with the
// page's value and drops HttpOnly -- session fixation + HttpOnly bypass.
func TestSetDocumentCookieCannotClobberHttpOnly(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://example.com/")
	// Server (HTTP API) sets an HttpOnly, Secure session cookie.
	j.SetCookies(u, []*http.Cookie{
		{Name: "sid", Value: "server-secret", Domain: "example.com", Path: "/", HttpOnly: true, Secure: true},
	})
	// The page (non-HTTP API) attempts to overwrite it via document.cookie.
	j.SetDocumentCookie(u, "sid=attacker")

	sid := ""
	for _, c := range j.Cookies(u, true) {
		if c.Name == "sid" {
			sid = c.Value
		}
	}
	if sid != "server-secret" {
		t.Fatalf("document.cookie overwrote an HttpOnly server cookie: sid=%q, want server-secret (session fixation)", sid)
	}
	// The HttpOnly cookie must NOT have become document-visible.
	if strings.Contains(j.DocumentCookie(u), "sid=") {
		t.Fatalf("HttpOnly cookie became document-visible after a page write: %q (HttpOnly bypass)", j.DocumentCookie(u))
	}

	// The dual rule: a non-HTTP API cannot MINT an HttpOnly cookie. "doc=1; HttpOnly"
	// from document.cookie must be stored as a normal, document-visible cookie
	// (HttpOnly forced off), not rejected and not hidden.
	j.SetDocumentCookie(u, "doc=1; HttpOnly")
	if !strings.Contains(j.DocumentCookie(u), "doc=1") {
		t.Fatal("a non-HttpOnly document.cookie write must be stored and visible (HttpOnly forced off, not rejected)")
	}

	// And a legitimate document write to a NON-HttpOnly cookie still works (the
	// guard must not break ordinary document.cookie usage).
	j.SetCookies(u, []*http.Cookie{{Name: "pref", Value: "a", Domain: "example.com", Path: "/"}})
	j.SetDocumentCookie(u, "pref=b")
	pref := ""
	for _, c := range j.Cookies(u, true) {
		if c.Name == "pref" {
			pref = c.Value
		}
	}
	if pref != "b" {
		t.Fatalf("document.cookie write to a non-HttpOnly cookie was blocked: pref=%q, want b", pref)
	}
}

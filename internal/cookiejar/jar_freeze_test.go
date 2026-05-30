package cookiejar

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

// C0 membrane freeze: pin cookie domain/path/Secure/HttpOnly/SameSite and
// expiry semantics. White-box (package cookiejar) so the unexported clock
// (j.now) and helpers (domainMatch, pathMatch, recordFromCookie) are driven
// directly and expiry is deterministic, not wall-clock flaky.

func fixedJar(t time.Time) *Jar {
	j := New()
	j.now = func() time.Time { return t }
	return j
}

// TestSetCookieRejectsForeignDomain pins the cross-domain set guard: a cookie
// whose Domain attribute does not domain-match the request host is dropped.
// This is a core injection defense -- deleting the domainMatch check in
// recordFromCookie would let example.com set a cookie scoped to evil.com.
func TestSetCookieRejectsForeignDomain(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/")
	j.SetCookies(u, []*http.Cookie{
		{Name: "foreign", Value: "1", Domain: "evil.test", Path: "/"},
		{Name: "superdomain", Value: "1", Domain: "example.com", Path: "/"},
		{Name: "unrelated", Value: "1", Domain: "notexample.com", Path: "/"},
	})
	names := cookieNames(j.Cookies(u, true))
	if names["foreign"] {
		t.Fatal("cookie scoped to a foreign domain was accepted")
	}
	if names["unrelated"] {
		t.Fatal("cookie scoped to a non-matching domain was accepted")
	}
	if !names["superdomain"] {
		t.Fatal("legitimate parent-domain cookie was rejected")
	}

	// Read back from the FOREIGN origins themselves -- not just the setter
	// origin. This is what makes the cross-origin injection guard load-bearing:
	// the read-side domainMatch in cookies() re-hides a foreign record when
	// read from www.example.com, so reading only there leaves the SET-side
	// reject in recordFromCookie unpinned. If that set-side guard is removed,
	// the injected cookie IS stored host-scoped to the foreign domain and would
	// be sent to it. These reads go red under that mutation, green today.
	evil, _ := url.Parse("https://evil.test/")
	if cookieNames(j.Cookies(evil, true))["foreign"] {
		t.Fatal("foreign-scoped cookie was injected and sent to evil.test")
	}
	notExample, _ := url.Parse("https://notexample.com/")
	if cookieNames(j.Cookies(notExample, true))["unrelated"] {
		t.Fatal("non-matching cookie was injected and sent to notexample.com")
	}
}

// TestDomainCookieScopeVsHostOnly pins domain matching: a cookie set with an
// explicit Domain is sent to subdomains, while a host-only cookie (no Domain
// attribute) is confined to the exact host. Deleting the hostOnly branch in
// domainMatch would over-share the host-only cookie.
func TestDomainCookieScopeVsHostOnly(t *testing.T) {
	setURL, _ := url.Parse("https://www.example.com/")
	j := New()
	j.SetCookies(setURL, []*http.Cookie{
		{Name: "domainwide", Value: "1", Domain: "example.com", Path: "/"},
		{Name: "hostonly", Value: "1", Path: "/"},
	})

	// Request to a sibling subdomain: domainwide travels, hostonly does not.
	sub, _ := url.Parse("https://api.example.com/")
	subNames := cookieNames(j.Cookies(sub, true))
	if !subNames["domainwide"] {
		t.Fatalf("Domain cookie not shared across subdomain: %#v", subNames)
	}
	if subNames["hostonly"] {
		t.Fatalf("host-only cookie leaked to sibling subdomain: %#v", subNames)
	}

	// Request back to the exact host: hostonly is visible again.
	exactNames := cookieNames(j.Cookies(setURL, true))
	if !exactNames["hostonly"] {
		t.Fatalf("host-only cookie missing on exact host: %#v", exactNames)
	}

	// Request from a DEEPER subdomain of the host-only cookie's host
	// (deep.www.example.com). This is the only host that discriminates the
	// hostOnly read branch of domainMatch: a sibling like api.example.com
	// fails the suffix check with or without the branch, but a sub-subdomain
	// of www.example.com is a valid suffix and would over-match if the
	// `if hostOnly { return host == domain }` branch were deleted. The
	// domain-wide cookie (Domain=example.com) must still travel here.
	deep, _ := url.Parse("https://deep.www.example.com/")
	deepNames := cookieNames(j.Cookies(deep, true))
	if deepNames["hostonly"] {
		t.Fatalf("host-only cookie leaked to sub-subdomain: %#v", deepNames)
	}
	if !deepNames["domainwide"] {
		t.Fatalf("Domain cookie not shared to deeper subdomain: %#v", deepNames)
	}
}

// TestPathMatchBoundary pins pathMatch's boundary rule directly: a /account
// cookie matches /account, /account/x and the trailing-slash form, but NOT a
// sibling prefix like /accountx. A loosened prefix check would over-match.
func TestPathMatchBoundary(t *testing.T) {
	matches := []string{"/account", "/account/", "/account/sub", "/account/a/b"}
	for _, p := range matches {
		if !pathMatch(p, "/account") {
			t.Fatalf("pathMatch(%q, \"/account\") = false, want true", p)
		}
	}
	nonMatches := []string{"/accountx", "/acc", "/", "/other"}
	for _, p := range nonMatches {
		if pathMatch(p, "/account") {
			t.Fatalf("pathMatch(%q, \"/account\") = true, want false", p)
		}
	}
}

// TestSecureCookieConfinedToHTTPS pins that a Secure cookie is withheld from a
// plaintext request. Removing the (!r.Secure || secure) guard in cookies()
// would leak it onto http.
func TestSecureCookieConfinedToHTTPS(t *testing.T) {
	j := New()
	httpsURL, _ := url.Parse("https://www.example.com/")
	j.SetCookies(httpsURL, []*http.Cookie{{Name: "sec", Value: "1", Path: "/", Secure: true}})
	if !cookieNames(j.Cookies(httpsURL, true))["sec"] {
		t.Fatal("secure cookie missing on https")
	}
	httpURL, _ := url.Parse("http://www.example.com/")
	if cookieNames(j.Cookies(httpURL, true))["sec"] {
		t.Fatal("secure cookie leaked onto http")
	}
}

// TestHTTPOnlyVisibilityGate pins the HttpOnly visibility split: HttpOnly
// cookies are sent on the request path (includeHTTPOnly=true) but hidden from
// the document/JS view (includeHTTPOnly=false and VisibleRecords). This is the
// document.cookie isolation invariant.
func TestHTTPOnlyVisibilityGate(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/")
	j.SetCookies(u, []*http.Cookie{
		{Name: "session", Value: "1", Path: "/", HttpOnly: true},
		{Name: "pref", Value: "1", Path: "/"},
	})
	reqSide := cookieNames(j.Cookies(u, true))
	if !reqSide["session"] || !reqSide["pref"] {
		t.Fatalf("request side should include HttpOnly: %#v", reqSide)
	}
	docSide := cookieNames(j.Cookies(u, false))
	if docSide["session"] {
		t.Fatalf("HttpOnly cookie exposed to document view: %#v", docSide)
	}
	if !docSide["pref"] {
		t.Fatalf("non-HttpOnly cookie missing from document view: %#v", docSide)
	}
	for _, rec := range j.VisibleRecords(u) {
		if rec.Name == "session" {
			t.Fatal("HttpOnly cookie leaked into VisibleRecords")
		}
	}
}

// TestExpiryAndMaxAgeSemantics pins expiry handling with a fixed clock:
// a past Expires and a non-positive Max-Age are treated as expired, while a
// future Max-Age survives. Deleting the expired() branches would resurrect
// stale cookies.
func TestExpiryAndMaxAgeSemantics(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	j := fixedJar(base)
	u, _ := url.Parse("https://www.example.com/")
	j.SetCookies(u, []*http.Cookie{
		{Name: "past_expires", Value: "1", Path: "/", Expires: base.Add(-time.Hour)},
		{Name: "future_expires", Value: "1", Path: "/", Expires: base.Add(time.Hour)},
		{Name: "future_maxage", Value: "1", Path: "/", MaxAge: 3600},
		{Name: "negative_maxage", Value: "1", Path: "/", MaxAge: -1},
		// http.Cookie.MaxAge == 0 means "unspecified" in Go: recordFromCookie
		// leaves rec.MaxAge nil, so this is a session cookie with no expiry --
		// it must survive (NOT be treated as expired).
		{Name: "zero_maxage_session", Value: "1", Path: "/", MaxAge: 0},
	})
	names := cookieNames(j.Cookies(u, true))
	if names["past_expires"] {
		t.Fatal("cookie with past Expires was returned")
	}
	if names["negative_maxage"] {
		t.Fatal("cookie with negative Max-Age was returned")
	}
	if !names["zero_maxage_session"] {
		t.Fatal("zero (unspecified) Max-Age session cookie must persist, not expire")
	}
	if !names["future_expires"] || !names["future_maxage"] {
		t.Fatalf("live cookies missing: %#v", names)
	}

	// Advance the clock past future_maxage's window: it must now be expired.
	j.now = func() time.Time { return base.Add(2 * time.Hour) }
	later := cookieNames(j.Cookies(u, true))
	if later["future_maxage"] {
		t.Fatal("Max-Age cookie survived past its expiry window")
	}
	if later["future_expires"] {
		t.Fatal("Expires cookie survived past its expiry instant")
	}
}

// TestUpsertWithNegativeMaxAgeDeletes pins the deletion-by-update semantic:
// re-setting an existing cookie with a negative Max-Age removes the record
// from the jar entirely (the upsert delete branch in upsertLocked), not just
// hides it at read time. The white-box len(j.records) assertion isolates that
// removal mechanism: if the upsert negative-MaxAge branch were deleted, the
// record would be REPLACED in place with MaxAge=-1 (len stays 1) rather than
// spliced out (len 0). It must be checked BEFORE any Cookies() read, because
// cookies() purges expired records as a side effect -- a stored MaxAge=-1
// record reads as expired and would be swept away, making the observable read
// (cookie absent) indistinguishable from real removal.
func TestUpsertWithNegativeMaxAgeDeletes(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/")
	j.SetCookies(u, []*http.Cookie{{Name: "tmp", Value: "1", Path: "/"}})
	if !cookieNames(j.Cookies(u, true))["tmp"] {
		t.Fatal("cookie not stored")
	}
	j.SetCookies(u, []*http.Cookie{{Name: "tmp", Value: "1", Path: "/", MaxAge: -1}})
	// White-box: the record must be spliced out of the jar at upsert time.
	// Read j.records directly, before any Cookies() call can purge it.
	if got := len(j.records); got != 0 {
		t.Fatalf("negative Max-Age upsert left %d record(s) in jar, want 0 (record not removed)", got)
	}
	// Observable contract: the deleted cookie is no longer sent.
	if cookieNames(j.Cookies(u, true))["tmp"] {
		t.Fatal("negative Max-Age update did not delete the cookie")
	}
}

// TestInsecureSameSiteNoneRejected pins that SameSite=None without Secure is
// rejected at set time (recordFromCookie), matching the browser invariant.
// This complements the existing public-suffix rejection test.
func TestInsecureSameSiteNoneRejected(t *testing.T) {
	now := time.Now().UTC()
	u, _ := url.Parse("https://www.example.com/")
	if _, ok := recordFromCookie(u, &http.Cookie{Name: "n", Value: "1", Path: "/", SameSite: http.SameSiteNoneMode}, now); ok {
		t.Fatal("SameSite=None without Secure must be rejected")
	}
	if _, ok := recordFromCookie(u, &http.Cookie{Name: "n", Value: "1", Path: "/", SameSite: http.SameSiteNoneMode, Secure: true}, now); !ok {
		t.Fatal("SameSite=None with Secure must be accepted")
	}
}

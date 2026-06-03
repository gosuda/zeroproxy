package cookiejar

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestDocumentCookieExcludesHttpOnlyAndMatchesPathSecure(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/account/index")
	j.SetCookies(u, []*http.Cookie{{Name: "a", Value: "1", Path: "/", Secure: true}, {Name: "secret", Value: "x", Path: "/", HttpOnly: true}, {Name: "p", Value: "2", Path: "/account"}})
	got := j.DocumentCookie(u)
	if strings.Contains(got, "secret=") {
		t.Fatalf("HttpOnly leaked: %q", got)
	}
	if !strings.Contains(got, "a=1") || !strings.Contains(got, "p=2") {
		t.Fatalf("missing visible cookies: %q", got)
	}
	httpURL, _ := url.Parse("http://www.example.com/account/index")
	if strings.Contains(j.DocumentCookie(httpURL), "a=1") {
		t.Fatal("secure cookie exposed on http")
	}
}

func TestVisibleRecordsPreserveCookieMetadata(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/account/index")
	j.SetCookies(u, []*http.Cookie{
		{Name: "root", Value: "1", Path: "/", Secure: true},
		{Name: "scoped", Value: "2", Path: "/account"},
		{Name: "secret", Value: "x", Path: "/", HttpOnly: true},
		{Name: "other", Value: "3", Domain: "other.example.com", Path: "/"},
	})
	records := j.VisibleRecords(u)
	if len(records) != 2 {
		t.Fatalf("expected 2 visible records, got %#v", records)
	}
	if records[0].Name != "scoped" || records[0].Path != "/account" {
		t.Fatalf("path ordering/metadata lost: %#v", records)
	}
	if records[1].Name != "root" || !records[1].Secure || records[1].Path != "/" {
		t.Fatalf("root metadata lost: %#v", records)
	}
	for _, rec := range records {
		if rec.Name == "secret" || rec.Name == "other" {
			t.Fatalf("unexpected visible record: %#v", records)
		}
	}
}

func TestCookiesForRequestAppliesSameSiteAndCredentials(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://api.example.com/account/page")
	topSameSite, _ := url.Parse("https://www.example.com/home")
	topCrossSite, _ := url.Parse("https://other.test/home")
	j.SetCookies(u, []*http.Cookie{
		{Name: "strict", Value: "1", Path: "/", SameSite: http.SameSiteStrictMode},
		{Name: "lax", Value: "1", Path: "/", SameSite: http.SameSiteLaxMode},
		{Name: "default_lax", Value: "1", Path: "/"},
		{Name: "none", Value: "1", Path: "/", SameSite: http.SameSiteNoneMode, Secure: true},
	})

	sameSite := cookieNames(j.CookiesForRequest(u, true, RequestContext{TopLevelURL: topSameSite, Method: "POST", Credentials: "include"}))
	for _, name := range []string{"strict", "lax", "default_lax", "none"} {
		if !sameSite[name] {
			t.Fatalf("same-site request missed %s: %#v", name, sameSite)
		}
	}

	crossFetch := cookieNames(j.CookiesForRequest(u, true, RequestContext{TopLevelURL: topCrossSite, Method: "POST", Credentials: "include"}))
	if crossFetch["strict"] || crossFetch["lax"] || crossFetch["default_lax"] || !crossFetch["none"] {
		t.Fatalf("cross-site subresource SameSite filtering wrong: %#v", crossFetch)
	}

	crossTopGET := cookieNames(j.CookiesForRequest(u, true, RequestContext{TopLevelURL: topCrossSite, Method: "GET", Credentials: "include", IsTopLevelNavigation: true}))
	if crossTopGET["strict"] || !crossTopGET["lax"] || !crossTopGET["default_lax"] || !crossTopGET["none"] {
		t.Fatalf("cross-site top-level GET SameSite filtering wrong: %#v", crossTopGET)
	}

	omit := j.CookiesForRequest(u, true, RequestContext{TopLevelURL: topSameSite, Method: "GET", Credentials: "omit"})
	if len(omit) != 0 {
		t.Fatalf("credentials omit sent cookies: %#v", omit)
	}
}

func TestSetCookiesRejectsPublicSuffixAndInsecureSameSiteNone(t *testing.T) {
	j := New()
	u, _ := url.Parse("https://www.example.com/")
	j.SetCookies(u, []*http.Cookie{
		{Name: "public_suffix", Value: "1", Domain: "com", Path: "/"},
		{Name: "none_insecure", Value: "1", Path: "/", SameSite: http.SameSiteNoneMode},
		{Name: "ok", Value: "1", Domain: "example.com", Path: "/", SameSite: http.SameSiteNoneMode, Secure: true},
	})
	names := cookieNames(j.Cookies(u, true))
	if names["public_suffix"] || names["none_insecure"] || !names["ok"] {
		t.Fatalf("cookie rejection mismatch: %#v", names)
	}
}

func cookieNames(cookies []*http.Cookie) map[string]bool {
	out := make(map[string]bool, len(cookies))
	for _, c := range cookies {
		out[c.Name] = true
	}
	return out
}

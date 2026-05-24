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

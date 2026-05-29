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

package httppersona

import (
	"net/http"
	"testing"
)

func TestApplyFetchSiteHeaderUsesSchemefulRegistrableDomains(t *testing.T) {
	tests := []struct {
		name   string
		source string
		target string
		want   string
	}{
		{name: "no source", target: "https://target.example/", want: "none"},
		{name: "same origin default port", source: "https://a.example/path", target: "https://a.example:443/other", want: "same-origin"},
		{name: "same registrable domain", source: "https://app.example.co.uk/", target: "https://cdn.example.co.uk/asset", want: "same-site"},
		{name: "schemeful cross site", source: "http://app.example.com/", target: "https://cdn.example.com/", want: "cross-site"},
		{name: "public suffix siblings", source: "https://first.github.io/", target: "https://second.github.io/", want: "cross-site"},
		{name: "different IP", source: "https://127.0.0.1/", target: "https://127.0.0.2/", want: "cross-site"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, test.target, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Sec-Fetch-Site", "forged")
			if _, err := ApplyFetchSiteHeader(request, test.source, ""); err != nil {
				t.Fatal(err)
			}
			if got := request.Header.Values("Sec-Fetch-Site"); len(got) != 1 || got[0] != test.want {
				t.Fatalf("Sec-Fetch-Site = %v, want [%q]", got, test.want)
			}
		})
	}
}

func TestApplyFetchSiteHeaderRejectsInvalidSourceContext(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://target.example/", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"not a URL", "file:///tmp/source", "https://user@example.com/"} {
		if _, err := ApplyFetchSiteHeader(request, source, ""); err == nil {
			t.Fatalf("invalid source %q was accepted", source)
		}
	}
}

func TestApplyFetchSiteHeaderPreservesRedirectTaint(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://app.example.com/final", nil)
	if err != nil {
		t.Fatal(err)
	}
	site, err := ApplyFetchSiteHeader(request, "https://app.example.com/start", "cross-site")
	if err != nil {
		t.Fatal(err)
	}
	if site != "cross-site" || request.Header.Get("Sec-Fetch-Site") != "cross-site" {
		t.Fatalf("redirect taint recovered unexpectedly: site=%q header=%q", site, request.Header.Get("Sec-Fetch-Site"))
	}
	site, err = ApplyFetchSiteHeader(request, "https://app.example.com/start", "same-site")
	if err != nil {
		t.Fatal(err)
	}
	if site != "same-site" {
		t.Fatalf("same-site redirect floor recovered to %q", site)
	}
	if _, err := ApplyFetchSiteHeader(request, "https://app.example.com/start", "invalid"); err == nil {
		t.Fatal("invalid redirect site floor was accepted")
	}
}

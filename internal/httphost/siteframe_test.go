package httphost

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func iframeRequest(host, path string) *http.Request {
	r := httptest.NewRequest("GET", "http://"+host+path, nil)
	r.Header.Set("Sec-Fetch-Dest", "iframe")
	return r
}

func TestSiteFrameBootstrapMayBeFramedByLoopbackSiblingsOnly(t *testing.T) {
	s := &server{}
	boot := iframeRequest("s-cloudflare-com-1234abcd.localhost:18080", "/zp/p/abc")
	if csp := s.responseCSP(boot); !strings.Contains(csp, "frame-ancestors http://*.localhost:18080") || strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("site frame bootstrap must be embeddable by *.localhost on its port, got: %s", csp)
	}
	if !isSiteFrameBootstrap(boot) {
		t.Fatal("a share route requested for an iframe on a loopback name is a site frame bootstrap")
	}

	// Everything else stays unframeable: the launcher, a share route opened as a document, a non-loopback host.
	for name, r := range map[string]*http.Request{
		"launcher as iframe":  iframeRequest("proxy.localhost:18080", "/zp/"),
		"share as document":   httptest.NewRequest("GET", "http://s-x.localhost:18080/zp/p/abc", nil),
		"non-loopback iframe": iframeRequest("proxy.example", "/zp/p/abc"),
	} {
		if csp := s.responseCSP(r); !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("%s must keep frame-ancestors 'none', got: %s", name, csp)
		}
		if isSiteFrameBootstrap(r) {
			t.Errorf("%s is not a site frame bootstrap", name)
		}
	}
}

func TestSiteFrameBootstrapIsCrossOriginIsolationCompatible(t *testing.T) {
	// A page that demands cross-origin isolation can embed only frames that opt in on both counts.
	rec := httptest.NewRecorder()
	h := (&server{}).securityHeaders(testHandlerOK())
	h.ServeHTTP(rec, iframeRequest("s-x-1.localhost:18080", "/zp/p/abc"))
	if got := rec.Header().Get("Cross-Origin-Embedder-Policy"); got != "require-corp" {
		t.Errorf("COEP = %q, want require-corp", got)
	}
	if got := rec.Header().Get("Cross-Origin-Resource-Policy"); got != "cross-origin" {
		t.Errorf("CORP = %q, want cross-origin", got)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://proxy.localhost:18080/zp/", nil))
	if rec.Header().Get("Cross-Origin-Embedder-Policy") != "" || rec.Header().Get("Cross-Origin-Resource-Policy") != "" {
		t.Error("ordinary responses must not gain isolation headers")
	}
}

func testHandlerOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
}

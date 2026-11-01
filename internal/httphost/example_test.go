package httphost_test

import (
	"net/http"
	"net/http/httptest"

	"github.com/gosuda/zeroproxy/internal/httphost"
)

// ExampleNewServer demonstrates constructing a Server with explicit
// TransportMode and graceful Close lifecycle.
func ExampleNewServer() {
	zpServer, err := httphost.NewServer(httphost.Config{
		WebDir:       "../../dist/web",
		Transport:    httphost.TransportDirect,
		TargetPolicy: httphost.TargetPolicyAllowPrivate,
	})
	if err != nil {
		panic(err)
	}
	defer zpServer.Close()

	srv := httptest.NewServer(zpServer)
	defer srv.Close()

	// Verify that the server responds without a 5xx error regardless of whether built static assets are present.
	resp, err := http.Get(srv.URL + "/zp/")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		panic("server returned 5xx error")
	}
}

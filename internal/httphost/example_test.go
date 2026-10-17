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
		WebDir:              "../../dist/web",
		Transport:           httphost.TransportDirect,
		AllowPrivateTargets: true,
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

// ExampleNewHandler demonstrates mounting the http.Handler returned by
// NewHandler on an HTTP server.
func ExampleNewHandler() {
	handler := httphost.NewHandler(httphost.Config{
		WebDir:    "../../dist/web",
		SocksAddr: "internal",
	})

	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/zp/")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		panic("handler returned server error")
	}
}


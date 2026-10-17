package httphost_test

import (
	"net/http"
	"net/http/httptest"

	"github.com/gosuda/zeroproxy/internal/httphost"
)

// ExampleNewHandler demonstrates mounting the http.Handler returned by
// NewHandler on an HTTP server.
func ExampleNewHandler() {
	handler := httphost.NewHandler(httphost.Config{
		WebDir:    "../../dist/web",
		SocksAddr: "internal",
	})

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Verify that the handler responds without a 5xx error regardless of whether built static assets are present.
	resp, err := http.Get(srv.URL + "/zp/")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		panic("handler returned server error")
	}
}

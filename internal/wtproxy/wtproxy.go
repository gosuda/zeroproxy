// Package wtproxy implements the server-side WebTransport (HTTP/3) gateway
// that relays virtual WebTransport sessions from proxied pages to target
// origins (see Listener in listener.go).
package wtproxy

import (
	"net/http"
)

// Handler returns an http.Handler that responds 501 Not Implemented with
// the ZeroProxy error code WT_UNSUPPORTED when a WebTransport path is hit
// over HTTP/1.1 or HTTP/2 instead of the UDP HTTP/3 listener.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-ZP-Error-Code", "WT_UNSUPPORTED")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte("ZeroProxy WebTransport gateway is not yet provisioned (WT_UNSUPPORTED).\n"))
	})
}

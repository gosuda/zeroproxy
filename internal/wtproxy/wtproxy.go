// Package wtproxy is the server-side WebTransport (HTTP/3) gateway that
// relays ZeroProxy client virtual WebTransport sessions to target origins.
//
// Status: scaffolding. The runtime client (zp-wtproxy-client and the
// runtime-prelude blocker) currently throws WT_UNSUPPORTED when a target
// constructs `new WebTransport(...)`. The full implementation requires:
//   - HTTP/3 listener (quic-go + WebTransport extension)
//   - Per-tab session multiplexing through yamux
//   - Bidi-stream + datagram relay with backpressure
//   - Subprotocol negotiation forwarding
//
// Until then this package exposes a placeholder Handler that returns 501
// Not Implemented so target sites see a stable, attributable error rather
// than a silent connection failure.
package wtproxy

import (
	"net/http"
)

// Handler returns an http.Handler that responds 501 Not Implemented with
// the ZeroProxy error code WT_UNSUPPORTED. Used by cmd/zeroproxy-server
// once a WebTransport upgrade endpoint is exposed.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-ZP-Error-Code", "WT_UNSUPPORTED")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte("ZeroProxy WebTransport gateway is not yet provisioned (WT_UNSUPPORTED).\n"))
	})
}

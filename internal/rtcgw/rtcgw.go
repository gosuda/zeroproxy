// Package rtcgw provides relay-only WebRTC support for proxied pages via an
// embedded TURN server (turn.go). The page's native RTCPeerConnection is
// restricted to these TURN credentials with `iceTransportPolicy: 'relay'`, so
// remote peers observe only the relay address while DTLS/SRTP media remains
// end-to-end encrypted.
package rtcgw

import (
	"net/http"
)

// Handler returns an http.Handler that responds 501 Not Implemented with
// the ZeroProxy error code RTC_GATEWAY_UNAVAILABLE for legacy signaling routes.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-ZP-Error-Code", "RTC_GATEWAY_UNAVAILABLE")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte("ZeroProxy WebRTC gateway is not yet provisioned (RTC_GATEWAY_UNAVAILABLE).\n"))
	})
}

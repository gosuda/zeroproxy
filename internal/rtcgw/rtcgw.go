// Package rtcgw is D5: WebRTC for proxied pages, relay-only through an
// embedded TURN server (turn.go). The page keeps a native RTCPeerConnection
// forced to these TURN credentials with `iceTransportPolicy: 'relay'`, so
// the remote peer sees only the relay and the relay carries DTLS/SRTP
// ciphertext.
//
// 2026-09-30: this replaced a pion signaling bridge (page-side and
// target-side PeerConnections with an SFU between them). Its target side was
// never negotiated, and page code still received the native connection's own
// SDP and candidates — with it enabled, a remote peer connected to the user
// directly (measured). Handler stays as the 501 answer for the old
// `/zp/api/rtc/signal` route.
package rtcgw

import (
	"net/http"
)

// Handler returns an http.Handler that responds 501 Not Implemented with
// the ZeroProxy error code RTC_GATEWAY_UNAVAILABLE. Used by
// cmd/zeroproxy-server once a WebRTC signaling endpoint is exposed.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-ZP-Error-Code", "RTC_GATEWAY_UNAVAILABLE")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte("ZeroProxy WebRTC gateway is not yet provisioned (RTC_GATEWAY_UNAVAILABLE).\n"))
	})
}

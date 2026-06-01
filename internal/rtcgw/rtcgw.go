// Package rtcgw is the server-side WebRTC signaling + media gateway that
// relays target peer connections through a ZeroProxy-controlled SFU/TURN.
//
// Status: scaffolding. The runtime client (zp-rtcgw-client and the
// runtime-prelude blocker) currently throws RTC_GATEWAY_UNAVAILABLE when a
// target constructs `new RTCPeerConnection(...)`. The full implementation
// requires:
//   - pion/webrtc server-side RTCPeerConnection
//   - pion/turn embedded TURN server
//   - SDP munging (strip target ICE candidates, inject ZeroProxy candidates)
//   - Per-tab session attribution to keep peer streams isolated
//   - Media gateway (SFU) for audio/video forwarding
//
// Until then this package exposes a placeholder Handler that returns 501
// Not Implemented so target sites see a stable, attributable error.
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

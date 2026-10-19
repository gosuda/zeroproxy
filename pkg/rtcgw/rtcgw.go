// Package rtcgw provides the embeddable TURN server for relay-only WebRTC in
// proxied pages.
package rtcgw

import (
	"net/http"

	"github.com/gosuda/zeroproxy/internal/rtcgw"
)

// TURNConfig carries operator-supplied parameters for the embedded TURN server.
type TURNConfig = rtcgw.TURNConfig

// TURNServer wraps an in-process TURN server and issues short-term RFC 7635
// TURN-REST credentials for proxied pages.
type TURNServer = rtcgw.TURNServer

// ICEServerCred holds a time-limited TURN credential tuple returned to the page realm.
type ICEServerCred = rtcgw.ICEServerCred

// NewTURNServer starts the UDP TURN listener. The caller owns the returned
// *TURNServer and must invoke Close to release the UDP socket.
func NewTURNServer(cfg TURNConfig) (*TURNServer, error) {
	return rtcgw.NewTURNServer(cfg)
}

// Handler returns an http.Handler that responds 501 Not Implemented with
// error code RTC_GATEWAY_UNAVAILABLE for legacy signaling routes.
func Handler() http.Handler {
	return rtcgw.Handler()
}

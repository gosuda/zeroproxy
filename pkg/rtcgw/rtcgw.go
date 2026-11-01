// Package rtcgw provides the embeddable TURN server for relay-only WebRTC in
// proxied pages.
package rtcgw

import (
	"net/http"
	"time"

	"github.com/gosuda/zeroproxy/internal/rtcgw"
)

// TURNConfig carries operator-supplied parameters for the embedded TURN server.
type TURNConfig struct {
	// Addr is the UDP listener ip:port (typically "0.0.0.0:3478").
	Addr string
	// PublicAddr is the host:port clients reach the server at (covers NAT and
	// port forwarding). Defaults to Addr.
	PublicAddr string
	// ExternalIP is the relay address IP advertised in TURN allocation
	// responses. For a single-IP host it equals the listener IP.
	ExternalIP string
	// Realm is the TURN realm string.
	Realm string
	// SharedSecret is the long-term TURN-REST shared secret.
	SharedSecret string
	// DefaultTTL is the validity of issued credentials.
	DefaultTTL time.Duration
	// AllowPrivatePeers lets clients relay to loopback, private, and link-local
	// peers. The relay sends UDP directly and cannot ride a SOCKS upstream, so
	// it may reach only what the HTTP path reaches.
	AllowPrivatePeers bool
}

// ICEServerCred is the time-limited TURN credential tuple a proxied page
// passes to its RTCPeerConnection. Username is "<expiry-unix>:<label>" and
// Credential is base64(HMAC-SHA1(secret, username)) per the TURN REST scheme.
type ICEServerCred struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// TURNServer wraps an in-process TURN server and issues short-term TURN-REST
// credentials for proxied pages.
type TURNServer struct {
	inner *rtcgw.TURNServer
}

// NewTURNServer starts the UDP TURN listener. The caller owns the returned
// *TURNServer and must invoke Close to release the UDP socket.
func NewTURNServer(cfg TURNConfig) (*TURNServer, error) {
	inner, err := rtcgw.NewTURNServer(rtcgw.TURNConfig{
		Addr:              cfg.Addr,
		PublicAddr:        cfg.PublicAddr,
		ExternalIP:        cfg.ExternalIP,
		Realm:             cfg.Realm,
		SharedSecret:      cfg.SharedSecret,
		DefaultTTL:        cfg.DefaultTTL,
		AllowPrivatePeers: cfg.AllowPrivatePeers,
	})
	if err != nil {
		return nil, err
	}
	return &TURNServer{inner: inner}, nil
}

// IssueICEServerCreds returns a fresh credential tuple. userLabel attributes
// the credential to a session or tab; an empty label gets a random one.
func (s *TURNServer) IssueICEServerCreds(userLabel string) (ICEServerCred, error) {
	cred, err := s.inner.IssueICEServerCreds(userLabel)
	if err != nil {
		return ICEServerCred{}, err
	}
	return ICEServerCred(cred), nil
}

// PublicAddr returns the host:port clients connect to.
func (s *TURNServer) PublicAddr() string {
	return s.inner.PublicAddr()
}

// Close stops the TURN server and releases its UDP socket. It is idempotent.
func (s *TURNServer) Close() error {
	return s.inner.Close()
}

// Handler returns an http.Handler that responds 501 Not Implemented with
// error code RTC_GATEWAY_UNAVAILABLE for WebRTC signaling routes, which the
// relay-only design does not provide.
func Handler() http.Handler {
	return rtcgw.Handler()
}

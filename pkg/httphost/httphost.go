// Package httphost provides the embeddable ZeroProxy HTTP server: static asset
// serving, /zp/* control routing, the WebSocket yamux byte-pipe bridge, the
// synchronous XHR relay hub, and CSP violation reporting.
package httphost

import (
	"net/http"

	"github.com/gosuda/zeroproxy/internal/httphost"
	irtcgw "github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/pkg/rtcgw"
)

// TransportMode selects how the relay bridges outbound streams.
type TransportMode uint8

const (
	// TransportAuto infers the transport mode from Config.SocksAddr.
	TransportAuto TransportMode = iota
	// TransportSOCKS5 bridges yamux streams to an upstream SOCKS5 proxy at
	// Config.SocksAddr (such as a Tor client listener).
	TransportSOCKS5
	// TransportDirect terminates the inner SOCKS5 handshake in-process and
	// dials resolved target addresses directly over TCP.
	TransportDirect
)

// TargetPolicy decides whether direct egress may reach private targets.
type TargetPolicy uint8

const (
	// TargetPolicyDefault follows the transport: SocksAddr "internal" (a local
	// test relay) permits private targets, while TransportDirect and SocksAddr
	// "direct" block them.
	TargetPolicyDefault TargetPolicy = iota
	// TargetPolicyAllowPrivate permits loopback and RFC 1918 private target
	// IPs. Link-local and unspecified addresses remain blocked.
	TargetPolicyAllowPrivate
	// TargetPolicyBlockPrivate rejects private, loopback, and non-public target
	// IPs in every direct mode, including SocksAddr "internal".
	TargetPolicyBlockPrivate
)

// Config holds the parameters for NewServer.
type Config struct {
	// WebDir is the built static web asset directory (dist/web).
	WebDir string
	// Transport selects the outbound relay mode. TransportAuto infers it from
	// SocksAddr.
	Transport TransportMode
	// SocksAddr is an upstream SOCKS5 host:port, "internal", or "direct".
	SocksAddr string
	// WtGatewayURL is the public WebTransport gateway URL the page reads. Empty
	// hides the gateway.
	WtGatewayURL string
	// WtGatewayCertHashes pins a self-signed development gateway certificate
	// (base64url SHA-256). Nil for an operator certificate that the browser
	// validates normally.
	WtGatewayCertHashes []string
	// RtcTURN is the embedded TURN server for relay-only WebRTC. Nil disables it.
	RtcTURN *rtcgw.TURNServer
	// TargetPolicy decides whether direct egress may reach private targets.
	TargetPolicy TargetPolicy
	// TrustProxyHeaders trusts X-Forwarded-Proto from non-loopback peers.
	TrustProxyHeaders bool
}

// Server implements http.Handler and io.Closer for an embedded ZeroProxy host.
type Server struct {
	inner *httphost.Server
}

// turnCreds adapts the public TURN server to the credential source the host
// expects.
type turnCreds struct {
	turn *rtcgw.TURNServer
}

func (c turnCreds) IssueICEServerCreds(userLabel string) (irtcgw.ICEServerCred, error) {
	cred, err := c.turn.IssueICEServerCreds(userLabel)
	if err != nil {
		return irtcgw.ICEServerCred{}, err
	}
	return irtcgw.ICEServerCred(cred), nil
}

// internal maps each public mode to its host counterpart explicitly so the two
// enums cannot drift apart. An unknown value is passed through and rejected by
// the host's validation.
func (m TransportMode) internal() httphost.TransportMode {
	switch m {
	case TransportAuto:
		return httphost.TransportAuto
	case TransportSOCKS5:
		return httphost.TransportSOCKS5
	case TransportDirect:
		return httphost.TransportDirect
	}
	return httphost.TransportMode(m)
}

func (p TargetPolicy) internal() httphost.TargetPolicy {
	switch p {
	case TargetPolicyDefault:
		return httphost.TargetPolicyDefault
	case TargetPolicyAllowPrivate:
		return httphost.TargetPolicyAllowPrivate
	case TargetPolicyBlockPrivate:
		return httphost.TargetPolicyBlockPrivate
	}
	return httphost.TargetPolicy(p)
}

// NewServer validates cfg and constructs a Server ready to serve HTTP requests.
func NewServer(cfg Config) (*Server, error) {
	icfg := httphost.Config{
		WebDir:              cfg.WebDir,
		Transport:           cfg.Transport.internal(),
		SocksAddr:           cfg.SocksAddr,
		WtGatewayURL:        cfg.WtGatewayURL,
		WtGatewayCertHashes: cfg.WtGatewayCertHashes,
		TargetPolicy:        cfg.TargetPolicy.internal(),
		TrustProxyHeaders:   cfg.TrustProxyHeaders,
	}
	if cfg.RtcTURN != nil {
		icfg.RtcTURN = turnCreds{turn: cfg.RtcTURN}
	}
	inner, err := httphost.NewServer(icfg)
	if err != nil {
		return nil, err
	}
	return &Server{inner: inner}, nil
}

// ServeHTTP serves static assets and /zp/* routes behind the security-headers
// middleware.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.inner.ServeHTTP(w, r)
}

// Close shuts down the synchronous XHR hub and every active relay session. It
// is safe for concurrent and repeated calls.
func (s *Server) Close() error {
	return s.inner.Close()
}

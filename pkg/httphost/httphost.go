// Package httphost provides the embeddable ZeroProxy HTTP server and handler:
// static asset serving, /zp/* control routing, the WebSocket yamux byte-pipe
// bridge, the synchronous XHR relay hub, and CSP violation reporting.
package httphost

import (
	"net/http"

	"github.com/gosuda/zeroproxy/internal/httphost"
)

// TransportMode selects how the relay bridges outbound streams.
type TransportMode = httphost.TransportMode

const (
	// TransportAuto infers the transport mode from Config.SocksAddr.
	TransportAuto = httphost.TransportAuto
	// TransportSOCKS5 bridges yamux streams to an upstream SOCKS5 proxy at
	// Config.SocksAddr (such as a Tor client listener).
	TransportSOCKS5 = httphost.TransportSOCKS5
	// TransportDirect terminates the inner SOCKS5 handshake in-process and
	// dials resolved target addresses directly over TCP.
	TransportDirect = httphost.TransportDirect
)

// Config holds the parameters for NewServer and NewHandler.
type Config = httphost.Config

// Server implements http.Handler and io.Closer for an embedded ZeroProxy host.
type Server = httphost.Server

// NewServer validates cfg and constructs a Server ready to serve HTTP requests.
func NewServer(cfg Config) (*Server, error) {
	return httphost.NewServer(cfg)
}

// NewHandler builds the ZeroProxy HTTP handler wrapped in the security-headers
// middleware. The returned http.Handler is a *Server and implements io.Closer.
func NewHandler(cfg Config) http.Handler {
	return httphost.NewHandler(cfg)
}

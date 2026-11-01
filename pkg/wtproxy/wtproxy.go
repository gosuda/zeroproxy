// Package wtproxy provides the embeddable ZeroProxy WebTransport (HTTP/3)
// gateway listener and HTTP fallback handler.
package wtproxy

import (
	"context"
	"log"
	"net/http"

	"github.com/gosuda/zeroproxy/internal/wtproxy"
)

// Config carries the WebTransport gateway listener parameters.
type Config struct {
	// Addr is the UDP listen address for the QUIC/HTTP-3 listener
	// (for example ":18443").
	Addr string
	// Path is the URL path on which clients send the WebTransport CONNECT
	// request. Defaults to "/zp/wt".
	Path string
	// CertFile and KeyFile are the TLS certificate and key paths. When both are
	// empty the listener uses a self-signed in-memory development certificate,
	// provided AllowInsecureDevCert is set.
	CertFile string
	KeyFile  string
	// AllowInsecureDevCert lets the listener boot without a certificate.
	AllowInsecureDevCert bool
	// AllowedTargetOrigins, when non-empty, restricts the target origins the
	// gateway will dial.
	AllowedTargetOrigins map[string]struct{}
	// AllowPrivateTargets permits targets that resolve to loopback, private,
	// link-local, or otherwise non-public addresses. QUIC cannot ride a SOCKS
	// upstream, so the gateway dials directly and must not reach more than the
	// HTTP path does.
	AllowPrivateTargets bool
	// PageHosts are the hostnames (without scheme or port) whose pages may open
	// sessions.
	PageHosts []string
	// RequireOrigin rejects CONNECT requests that omit the Origin header.
	RequireOrigin bool
	// Logger receives one line per session lifecycle event. nil uses log.Default.
	Logger *log.Logger
}

// Listener wraps a WebTransport HTTP/3 server and manages active sessions.
type Listener struct {
	inner *wtproxy.Listener
}

// New builds a WebTransport gateway Listener without binding the UDP socket.
// Call Run on the returned Listener to start serving.
func New(cfg Config) (*Listener, error) {
	inner, err := wtproxy.New(wtproxy.Config{
		Addr:                 cfg.Addr,
		Path:                 cfg.Path,
		CertFile:             cfg.CertFile,
		KeyFile:              cfg.KeyFile,
		AllowInsecureDevCert: cfg.AllowInsecureDevCert,
		AllowedTargetOrigins: cfg.AllowedTargetOrigins,
		AllowPrivateTargets:  cfg.AllowPrivateTargets,
		PageHosts:            cfg.PageHosts,
		RequireOrigin:        cfg.RequireOrigin,
		Logger:               cfg.Logger,
	})
	if err != nil {
		return nil, err
	}
	return &Listener{inner: inner}, nil
}

// Run blocks until the listener is closed or ctx is done.
func (l *Listener) Run(ctx context.Context) error {
	return l.inner.Run(ctx)
}

// Close terminates the listener and drops every active session.
func (l *Listener) Close() error {
	return l.inner.Close()
}

// CertHashes returns the base64url SHA-256 pin of the in-memory development
// certificate, or nil when an operator certificate is configured.
func (l *Listener) CertHashes() []string {
	return l.inner.CertHashes()
}

// Handler returns an http.Handler that responds 501 Not Implemented with
// error code WT_UNSUPPORTED when a WebTransport path is hit over HTTP/1.1 or HTTP/2.
func Handler() http.Handler {
	return wtproxy.Handler()
}

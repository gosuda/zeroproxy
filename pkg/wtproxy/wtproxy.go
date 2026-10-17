// Package wtproxy provides the embeddable ZeroProxy WebTransport (HTTP/3)
// gateway listener and HTTP fallback handler.
package wtproxy

import (
	"net/http"

	"github.com/gosuda/zeroproxy/internal/wtproxy"
)

// Config carries the WebTransport gateway listener parameters.
type Config = wtproxy.Config

// Listener wraps a WebTransport HTTP/3 server and manages active sessions.
type Listener = wtproxy.Listener

// New builds a WebTransport gateway Listener without binding the UDP socket.
// Call Run on the returned Listener to start serving.
func New(cfg Config) (*Listener, error) {
	return wtproxy.New(cfg)
}

// Handler returns an http.Handler that responds 501 Not Implemented with
// error code WT_UNSUPPORTED when a WebTransport path is hit over HTTP/1.1 or HTTP/2.
func Handler() http.Handler {
	return wtproxy.Handler()
}

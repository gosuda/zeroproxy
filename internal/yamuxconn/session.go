package yamuxconn

import (
	"context"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/hashicorp/yamux"
)

type Session struct{ sess *yamux.Session }

// tunedConfig sets MaxStreamWindowSize to 16 MiB (paired with the Rust kernel
// yamux configuration). The hashicorp/yamux default of 256 KiB stalls
// high-concurrency stream multiplexing over higher-latency proxied paths while
// senders wait for receiver window updates.
func tunedConfig() *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = keepAliveInterval()
	cfg.MaxStreamWindowSize = 16 * 1024 * 1024 // 16 MiB (default 256 KiB)
	return cfg
}

// keepAliveInterval is 30s by default; ZP_KEEPALIVE_SEC overrides it to
// diagnose transport-level stalls between the WASM client and the relay.
func keepAliveInterval() time.Duration {
	if v := os.Getenv("ZP_KEEPALIVE_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 30 * time.Second
}

func Client(conn net.Conn) (*Session, error) {
	s, err := yamux.Client(conn, tunedConfig())
	if err != nil {
		return nil, err
	}
	return &Session{sess: s}, nil
}

func Server(conn net.Conn) (*Session, error) {
	s, err := yamux.Server(conn, tunedConfig())
	if err != nil {
		return nil, err
	}
	return &Session{sess: s}, nil
}

func (s *Session) OpenStream(ctx context.Context) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() { c, err := s.sess.Open(); ch <- result{c: c, err: err} }()
	select {
	case r := <-ch:
		return r.c, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Session) Accept(ctx context.Context) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() { c, err := s.sess.Accept(); ch <- result{c: c, err: err} }()
	select {
	case r := <-ch:
		return r.c, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Session) Close() error   { return s.sess.Close() }
func (s *Session) IsClosed() bool { return s.sess.IsClosed() }

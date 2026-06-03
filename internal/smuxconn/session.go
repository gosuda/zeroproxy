package smuxconn

import (
	"context"
	"net"
	"time"

	"github.com/xtaci/smux"
)

type Session struct{ sess *smux.Session }

func Client(conn net.Conn) (*Session, error) {
	s, err := smux.Client(conn, config())
	if err != nil {
		return nil, err
	}
	return &Session{sess: s}, nil
}

func Server(conn net.Conn) (*Session, error) {
	s, err := smux.Server(conn, config())
	if err != nil {
		return nil, err
	}
	return &Session{sess: s}, nil
}

func config() *smux.Config {
	cfg := smux.DefaultConfig()
	cfg.KeepAliveInterval = 30 * time.Second
	cfg.KeepAliveTimeout = 90 * time.Second
	return cfg
}

func (s *Session) OpenStream(ctx context.Context) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() { c, err := s.sess.OpenStream(); ch <- result{c: c, err: err} }()
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
	go func() { c, err := s.sess.AcceptStream(); ch <- result{c: c, err: err} }()
	select {
	case r := <-ch:
		return r.c, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Session) Close() error   { return s.sess.Close() }
func (s *Session) IsClosed() bool { return s.sess.IsClosed() }

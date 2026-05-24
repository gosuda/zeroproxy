package yamuxconn

import (
	"context"
	"net"
	"time"

	"github.com/hashicorp/yamux"
)

type Session struct{ sess *yamux.Session }

func Client(conn net.Conn) (*Session, error) {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 30 * time.Second
	s, err := yamux.Client(conn, cfg)
	if err != nil {
		return nil, err
	}
	return &Session{sess: s}, nil
}

func Server(conn net.Conn) (*Session, error) {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 30 * time.Second
	s, err := yamux.Server(conn, cfg)
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

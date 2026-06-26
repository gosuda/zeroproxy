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

// 2026-06-13 throughput fix: NAVER 메인 같은 image-heavy 페이지에서 28+
// 동시 스트림이 단일 WS/yamux 세션으로 다중화되며 throughput 붕괴 (real
// Chrome: 모든 다운로드 ~243s stall 후 동시 release). hashicorp/yamux 기본
// MaxStreamWindowSize 256KB 는 high-latency proxied 경로 + 다수 동시
// 스트림에서 너무 작아 sender 가 receiver 의 window-update 를 기다리며
// 자주 stall. 16MB 로 키워 in-flight 데이터 여유 확보 (relay 가 receiver
// 의 read 를 기다리지 않고 더 많이 buffer). Rust kernel 쪽 split_send_size
// 확대 (yamux.rs) 와 짝.
func tunedConfig() *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = keepAliveInterval()
	cfg.MaxStreamWindowSize = 16 * 1024 * 1024 // 16 MiB (default 256 KiB)
	return cfg
}

// keepAliveInterval is 30s by default; ZP_KEEPALIVE_SEC overrides it. The
// override is a diagnostic lever: the cold-bootstrap "exactly 60s" first-
// request stall is pumped loose by the next keepalive ping, so if lowering
// this value shortens the stall proportionally, the stall lives in our
// wasm↔relay transport (keepalive frames never reach the upstream), not in
// the upstream server.
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

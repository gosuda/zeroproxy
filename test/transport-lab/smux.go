package transportlab

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"

	"github.com/xtaci/smux"
)

const (
	MaxSMUXSessions = 8
	MaxSMUXStreams  = 32
	maxSMUXFrame    = 4 << 10
	maxSMUXBuffer   = 64 << 10
)

// SMUXStats describes the bounded state observed by an SMUXLab.
type SMUXStats struct {
	ActiveSessions   int
	OpenedSessions   int
	ClosedSessions   int
	RejectedSessions int
	ActiveStreams    int
	OpenedStreams    int
	ClosedStreams    int
	RejectedStreams  int
	TerminalErrors   int
}

// SMUXLab is a local, bounded xtaci/smux echo peer. It uses net.Pipe so tests
// do not depend on a listening socket or the host network stack.
type SMUXLab struct {
	config smux.Config

	sessionSlots chan struct{}
	streamSlots  chan struct{}

	mu      sync.Mutex
	closing bool
	peers   map[*smuxPeer]struct{}
	streams map[*smux.Stream]struct{}
	stats   SMUXStats
	changed chan struct{}

	workersMu     sync.Mutex
	workersClosed bool
	workers       sync.WaitGroup

	closeOnce sync.Once
	closed    chan struct{}
}

type smuxPeer struct {
	lab *SMUXLab

	mu     sync.Mutex
	done   bool
	server *smux.Session
	client *smux.Session
	raw    net.Conn
}

// NewSMUX creates an echo fixture with deliberately small smux buffers and
// global session and stream limits.
func NewSMUX() *SMUXLab {
	config := smux.DefaultConfig()
	config.KeepAliveDisabled = true
	config.MaxFrameSize = maxSMUXFrame
	config.MaxReceiveBuffer = maxSMUXBuffer
	config.MaxStreamBuffer = maxSMUXFrame

	return &SMUXLab{
		config:       *config,
		sessionSlots: make(chan struct{}, MaxSMUXSessions),
		streamSlots:  make(chan struct{}, MaxSMUXStreams),
		peers:        make(map[*smuxPeer]struct{}),
		streams:      make(map[*smux.Stream]struct{}),
		changed:      make(chan struct{}),
		closed:       make(chan struct{}),
	}
}

// OpenClient returns a real client-side smux session connected to the fixture.
// Closing the returned session releases the corresponding server-side session.
func (l *SMUXLab) OpenClient() (*smux.Session, error) {
	peer, clientConn, err := l.openPeer()
	if err != nil {
		return nil, err
	}

	client, err := smux.Client(clientConn, &l.config)
	if err != nil {
		_ = clientConn.Close()
		l.finishPeer(peer)
		return nil, err
	}
	if !peer.attachClient(client) {
		_ = client.Close()
		return nil, io.ErrClosedPipe
	}
	if !l.startPeer(peer) {
		l.finishPeer(peer)
		return nil, io.ErrClosedPipe
	}
	return client, nil
}

// OpenRawPeer returns the other end of a server-side smux session without
// constructing a client. It is for malformed and truncated wire-peer tests.
func (l *SMUXLab) OpenRawPeer() (net.Conn, error) {
	peer, clientConn, err := l.openPeer()
	if err != nil {
		return nil, err
	}
	if !peer.attachRaw(clientConn) {
		_ = clientConn.Close()
		return nil, io.ErrClosedPipe
	}
	if !l.startPeer(peer) {
		l.finishPeer(peer)
		return nil, io.ErrClosedPipe
	}
	return clientConn, nil
}

func (l *SMUXLab) openPeer() (*smuxPeer, net.Conn, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return nil, nil, io.ErrClosedPipe
	}
	select {
	case l.sessionSlots <- struct{}{}:
	default:
		l.stats.RejectedSessions++
		return nil, nil, fmt.Errorf("smux session limit of %d reached", MaxSMUXSessions)
	}

	serverConn, clientConn := net.Pipe()
	server, err := smux.Server(serverConn, &l.config)
	if err != nil {
		<-l.sessionSlots
		_ = serverConn.Close()
		_ = clientConn.Close()
		return nil, nil, err
	}
	peer := &smuxPeer{lab: l, server: server}
	l.peers[peer] = struct{}{}
	l.stats.ActiveSessions++
	l.stats.OpenedSessions++
	l.signalLocked()
	return peer, clientConn, nil
}

func (p *smuxPeer) attachClient(client *smux.Session) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return false
	}
	p.client = client
	return true
}

func (p *smuxPeer) attachRaw(raw net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return false
	}
	p.raw = raw
	return true
}

func (l *SMUXLab) startPeer(peer *smuxPeer) bool {
	if !l.beginWorker() {
		return false
	}
	peer.mu.Lock()
	if peer.done {
		peer.mu.Unlock()
		l.workers.Done()
		return false
	}
	peer.mu.Unlock()
	go func() {
		defer l.workers.Done()
		defer l.finishPeer(peer)
		l.acceptStreams(peer)
	}()
	return true
}

func (l *SMUXLab) acceptStreams(peer *smuxPeer) {
	for {
		stream, err := peer.server.AcceptStream()
		if err != nil {
			l.recordTerminalError(err)
			return
		}
		if !l.startStream(stream) {
			_ = stream.Close()
		}
	}
}

func (l *SMUXLab) startStream(stream *smux.Stream) bool {
	select {
	case l.streamSlots <- struct{}{}:
	default:
		l.mu.Lock()
		l.stats.RejectedStreams++
		l.signalLocked()
		l.mu.Unlock()
		return false
	}
	if !l.beginWorker() {
		<-l.streamSlots
		return false
	}

	l.mu.Lock()
	if l.closing {
		l.mu.Unlock()
		l.workers.Done()
		<-l.streamSlots
		return false
	}
	l.streams[stream] = struct{}{}
	l.stats.ActiveStreams++
	l.stats.OpenedStreams++
	l.signalLocked()
	l.mu.Unlock()

	go func() {
		defer l.workers.Done()
		defer l.finishStream(stream)
		buffer := make([]byte, maxSMUXFrame)
		_, _ = io.CopyBuffer(stream, stream, buffer)
		_ = stream.Close()
	}()
	return true
}

func (l *SMUXLab) finishStream(stream *smux.Stream) {
	l.mu.Lock()
	if _, ok := l.streams[stream]; ok {
		delete(l.streams, stream)
		l.stats.ActiveStreams--
		l.stats.ClosedStreams++
		l.signalLocked()
	}
	l.mu.Unlock()
	<-l.streamSlots
}

func (l *SMUXLab) finishPeer(peer *smuxPeer) {
	peer.mu.Lock()
	if peer.done {
		peer.mu.Unlock()
		return
	}
	peer.done = true
	server, client, raw := peer.server, peer.client, peer.raw
	peer.mu.Unlock()

	if client != nil {
		_ = client.Close()
	}
	if raw != nil {
		_ = raw.Close()
	}
	if server != nil {
		_ = server.Close()
	}

	l.mu.Lock()
	if _, ok := l.peers[peer]; ok {
		delete(l.peers, peer)
		l.stats.ActiveSessions--
		l.stats.ClosedSessions++
		l.signalLocked()
		<-l.sessionSlots
	}
	l.mu.Unlock()
}

func (l *SMUXLab) beginWorker() bool {
	l.workersMu.Lock()
	defer l.workersMu.Unlock()
	if l.workersClosed {
		return false
	}
	l.workers.Add(1)
	return true
}

func (l *SMUXLab) recordTerminalError(err error) {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
		return
	}
	l.mu.Lock()
	l.stats.TerminalErrors++
	l.signalLocked()
	l.mu.Unlock()
}

// Stats returns a consistent snapshot of fixture accounting.
func (l *SMUXLab) Stats() SMUXStats {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stats
}

// WaitForIdle waits for all client/session and accepted stream state to be
// released. It is suitable for deterministic cleanup assertions.
func (l *SMUXLab) WaitForIdle(ctx context.Context) error {
	for {
		l.mu.Lock()
		if len(l.peers) == 0 && len(l.streams) == 0 {
			l.mu.Unlock()
			return nil
		}
		changed := l.changed
		l.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

// AssertNoLeaks reports any session or stream that escaped fixture cleanup.
func (l *SMUXLab) AssertNoLeaks() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.peers) != 0 || len(l.streams) != 0 || len(l.sessionSlots) != 0 || len(l.streamSlots) != 0 {
		return fmt.Errorf("smux fixture leak: sessions=%d streams=%d session_slots=%d stream_slots=%d", len(l.peers), len(l.streams), len(l.sessionSlots), len(l.streamSlots))
	}
	return nil
}

// Close shuts down every tracked peer and waits for the accept and echo loops
// to exit. It is safe to call more than once.
func (l *SMUXLab) Close() error {
	l.closeOnce.Do(func() {
		l.workersMu.Lock()
		l.workersClosed = true
		l.workersMu.Unlock()

		l.mu.Lock()
		l.closing = true
		peers := make([]*smuxPeer, 0, len(l.peers))
		for peer := range l.peers {
			peers = append(peers, peer)
		}
		l.mu.Unlock()

		for _, peer := range peers {
			l.finishPeer(peer)
		}
		l.workers.Wait()
		close(l.closed)
	})
	<-l.closed
	return nil
}

func (l *SMUXLab) signalLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}

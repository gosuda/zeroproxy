package transportlab

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const (
	// MaxRelayFrameBytes bounds one fixture frame and prevents an untrusted peer
	// from causing an unbounded allocation in a test.
	MaxRelayFrameBytes = 64 << 10
	// MaxRelayBytes is the default total client-to-relay byte quota.
	MaxRelayBytes = 1 << 20

	relayFrameHeaderBytes = 9
	maxRelayAcceptDelay   = 5 * time.Second
)

// RelayFrameType identifies the small, smux-like fixture protocol. Frames are
// encoded as type (one byte), stream ID (four bytes), and payload length (four
// bytes), all integer fields in network byte order.
type RelayFrameType byte

const (
	RelayFrameOpen RelayFrameType = iota + 1
	RelayFrameData
	RelayFrameClose
	RelayFrameAccept
	RelayFrameError
)

const (
	relayErrorDraining = "draining"
	relayErrorQuota    = "quota_exhausted"
)

// RelayFrame is one bounded fixture protocol message. Payloads are never
// recorded by the fixture.
type RelayFrame struct {
	Type     RelayFrameType
	StreamID uint32
	Payload  []byte
}

// WriteRelayFrame writes one bounded relay fixture frame.
func WriteRelayFrame(writer io.Writer, frame RelayFrame) error {
	if !validRelayFrameType(frame.Type) {
		return fmt.Errorf("transport relay fixture invalid frame type %d", frame.Type)
	}
	if len(frame.Payload) > MaxRelayFrameBytes {
		return fmt.Errorf("transport relay fixture frame exceeds %d bytes", MaxRelayFrameBytes)
	}
	var header [relayFrameHeaderBytes]byte
	header[0] = byte(frame.Type)
	binary.BigEndian.PutUint32(header[1:5], frame.StreamID)
	binary.BigEndian.PutUint32(header[5:9], uint32(len(frame.Payload)))
	if err := writeRelayBytes(writer, header[:]); err != nil {
		return err
	}
	return writeRelayBytes(writer, frame.Payload)
}

// ReadRelayFrame reads one bounded relay fixture frame.
func ReadRelayFrame(reader io.Reader) (RelayFrame, error) {
	var header [relayFrameHeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return RelayFrame{}, err
	}
	frameType := RelayFrameType(header[0])
	if !validRelayFrameType(frameType) {
		return RelayFrame{}, fmt.Errorf("transport relay fixture invalid frame type %d", frameType)
	}
	payloadLength := binary.BigEndian.Uint32(header[5:9])
	if payloadLength > MaxRelayFrameBytes {
		return RelayFrame{}, fmt.Errorf("transport relay fixture frame exceeds %d bytes", MaxRelayFrameBytes)
	}
	frame := RelayFrame{
		Type:     frameType,
		StreamID: binary.BigEndian.Uint32(header[1:5]),
		Payload:  make([]byte, payloadLength),
	}
	if _, err := io.ReadFull(reader, frame.Payload); err != nil {
		return RelayFrame{}, err
	}
	return frame, nil
}

func validRelayFrameType(frameType RelayFrameType) bool {
	switch frameType {
	case RelayFrameOpen, RelayFrameData, RelayFrameClose, RelayFrameAccept, RelayFrameError:
		return true
	default:
		return false
	}
}

func writeRelayBytes(writer io.Writer, bytes []byte) error {
	for len(bytes) != 0 {
		written, err := writer.Write(bytes)
		if written < 0 || written > len(bytes) {
			return errors.New("transport relay fixture invalid frame write")
		}
		bytes = bytes[written:]
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// RelayState is the externally observable state of a RelayLab.
type RelayState string

const (
	RelayAccepting      RelayState = "accepting"
	RelayDelayed        RelayState = "delayed"
	RelayDraining       RelayState = "draining"
	RelayDisconnected   RelayState = "disconnected"
	RelayQuotaExhausted RelayState = "quota_exhausted"
	RelayClosed         RelayState = "closed"
)

// RelayScenario controls the bounded local relay fixture. A zero-value quota
// and stream limit use bounded defaults.
type RelayScenario struct {
	AcceptDelay time.Duration
	ByteQuota   int64
	MaxStreams  int
}

// RelayStats contains counters only; relay frame payloads are deliberately not
// retained by the fixture.
type RelayStats struct {
	State               RelayState
	AcceptedConnections int
	ActiveConnections   int
	OpenedStreams       int
	ActiveStreams       int
	ClosedStreams       int
	RejectedStreams     int
	ForwardedBytes      int64
	Disconnects         int
}

// RelayLab is a loopback-only, smux-like byte-stream fixture. It accepts a
// simple OPEN/DATA/CLOSE protocol, echoes accepted DATA frames, and provides
// deterministic delay, graceful-drain, disconnect, and quota transitions.
type RelayLab struct {
	scenario RelayScenario
	tcp      *TCPServer
	done     chan struct{}

	mu          sync.Mutex
	started     bool
	closed      bool
	state       RelayState
	connections map[net.Conn]map[uint32]struct{}
	stats       RelayStats
	changed     chan struct{}
}

// NewRelay creates an unstarted, local-only relay fixture.
func NewRelay(scenario RelayScenario) *RelayLab {
	lab := &RelayLab{
		scenario:    scenario,
		done:        make(chan struct{}),
		connections: make(map[net.Conn]map[uint32]struct{}),
		changed:     make(chan struct{}),
	}
	lab.tcp = NewTCP(lab.serve)
	return lab
}

// Start begins the fixture on a loopback TCP listener.
func (l *RelayLab) Start() error {
	l.mu.Lock()
	if l.started {
		l.mu.Unlock()
		return errors.New("transport relay lab already started")
	}
	if err := l.normalizeScenarioLocked(); err != nil {
		l.mu.Unlock()
		return err
	}
	l.started = true
	if l.scenario.AcceptDelay > 0 {
		l.setStateLocked(RelayDelayed)
	} else {
		l.setStateLocked(RelayAccepting)
	}
	l.mu.Unlock()

	if err := l.tcp.Start(); err != nil {
		l.mu.Lock()
		l.started = false
		l.setStateLocked(RelayClosed)
		l.mu.Unlock()
		return err
	}
	if l.scenario.AcceptDelay > 0 {
		go l.releaseAcceptDelay(l.scenario.AcceptDelay)
	}
	return nil
}

func (l *RelayLab) normalizeScenarioLocked() error {
	if l.scenario.AcceptDelay < 0 || l.scenario.AcceptDelay > maxRelayAcceptDelay {
		return fmt.Errorf("transport relay fixture accept delay must be between zero and %s", maxRelayAcceptDelay)
	}
	if l.scenario.ByteQuota < 0 || l.scenario.ByteQuota > MaxRelayBytes {
		return fmt.Errorf("transport relay fixture byte quota must be between zero and %d", MaxRelayBytes)
	}
	if l.scenario.ByteQuota == 0 {
		l.scenario.ByteQuota = MaxRelayBytes
	}
	if l.scenario.MaxStreams < 0 || l.scenario.MaxStreams > MaxConnections {
		return fmt.Errorf("transport relay fixture stream limit must be between zero and %d", MaxConnections)
	}
	if l.scenario.MaxStreams == 0 {
		l.scenario.MaxStreams = MaxConnections
	}
	return nil
}

func (l *RelayLab) releaseAcceptDelay(delay time.Duration) {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		l.mu.Lock()
		if l.state == RelayDelayed {
			l.setStateLocked(RelayAccepting)
		}
		l.mu.Unlock()
	case <-l.done:
	}
}

// Address returns the loopback authority after Start.
func (l *RelayLab) Address() string {
	return l.tcp.Address()
}

// State returns the current fixture state.
func (l *RelayLab) State() RelayState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

// Stats returns counters and no payload data.
func (l *RelayLab) Stats() RelayStats {
	l.mu.Lock()
	defer l.mu.Unlock()
	stats := l.stats
	stats.State = l.state
	return stats
}

// BeginDrain stops new streams while allowing existing streams to close
// cleanly. It does not close existing TCP connections.
func (l *RelayLab) BeginDrain() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch l.state {
	case RelayAccepting, RelayDelayed:
		l.setStateLocked(RelayDraining)
		return nil
	case RelayDraining:
		return nil
	default:
		return fmt.Errorf("transport relay fixture cannot drain from %s", l.state)
	}
}

// Disconnect deterministically cuts every active client connection. The
// listener remains available so tests can verify that future OPEN frames fail.
func (l *RelayLab) Disconnect() {
	l.mu.Lock()
	if l.closed || l.state == RelayDisconnected {
		l.mu.Unlock()
		return
	}
	l.setStateLocked(RelayDisconnected)
	l.stats.Disconnects++
	connections := l.connectionSliceLocked()
	l.mu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
}

// WaitForIdle waits for all tracked connections and streams to be released.
func (l *RelayLab) WaitForIdle(ctx context.Context) error {
	for {
		l.mu.Lock()
		if l.stats.ActiveConnections == 0 && l.stats.ActiveStreams == 0 {
			l.mu.Unlock()
			return nil
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// AssertNoLeaks reports active connection or stream bookkeeping left behind by
// a test. Call WaitForIdle first when the client has just closed a connection.
func (l *RelayLab) AssertNoLeaks() error {
	stats := l.Stats()
	if stats.ActiveConnections != 0 || stats.ActiveStreams != 0 {
		return fmt.Errorf("transport relay fixture leak: connections=%d streams=%d", stats.ActiveConnections, stats.ActiveStreams)
	}
	return nil
}

// Close stops accepting connections, releases all active streams, and waits for
// the fixture's local handlers to finish.
func (l *RelayLab) Close() error {
	l.mu.Lock()
	if !l.started || l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	l.setStateLocked(RelayClosed)
	close(l.done)
	connections := l.connectionSliceLocked()
	l.mu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
	err := l.tcp.Close()
	if waitErr := l.WaitForIdle(context.Background()); err == nil {
		err = waitErr
	}
	return err
}

func (l *RelayLab) serve(connection net.Conn) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	streams := make(map[uint32]struct{})
	l.connections[connection] = streams
	l.stats.AcceptedConnections++
	l.stats.ActiveConnections++
	l.signalLocked()
	l.mu.Unlock()
	defer l.releaseConnection(connection)

	if !l.awaitDelayedAdmission() {
		return
	}

	for {
		select {
		case <-l.done:
			return
		default:
		}
		frame, err := ReadRelayFrame(connection)
		if err != nil {
			return
		}
		if err := l.handleFrame(connection, streams, frame); err != nil {
			return
		}
	}
}
func (l *RelayLab) awaitDelayedAdmission() bool {
	for {
		l.mu.Lock()
		if l.state != RelayDelayed {
			closed := l.closed
			l.mu.Unlock()
			return !closed
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-changed:
		case <-l.done:
			return false
		}
	}
}

func (l *RelayLab) handleFrame(connection net.Conn, streams map[uint32]struct{}, frame RelayFrame) error {
	switch frame.Type {
	case RelayFrameOpen:
		return l.openStream(connection, streams, frame.StreamID)
	case RelayFrameData:
		return l.forwardData(connection, streams, frame)
	case RelayFrameClose:
		if l.closeStream(streams, frame.StreamID) {
			return WriteRelayFrame(connection, RelayFrame{Type: RelayFrameClose, StreamID: frame.StreamID})
		}
		return l.writeError(connection, frame.StreamID, "unknown_stream")
	default:
		return l.writeError(connection, frame.StreamID, "protocol_error")
	}
}

func (l *RelayLab) openStream(connection net.Conn, streams map[uint32]struct{}, streamID uint32) error {
	l.mu.Lock()
	state := l.state
	if state != RelayAccepting {
		l.stats.RejectedStreams++
		l.signalLocked()
		l.mu.Unlock()
		if state == RelayQuotaExhausted {
			return l.writeError(connection, streamID, relayErrorQuota)
		}
		return l.writeError(connection, streamID, relayErrorDraining)
	}
	if _, exists := streams[streamID]; exists || l.stats.ActiveStreams >= l.scenario.MaxStreams {
		l.stats.RejectedStreams++
		l.signalLocked()
		l.mu.Unlock()
		return l.writeError(connection, streamID, "stream_limit")
	}
	streams[streamID] = struct{}{}
	l.stats.OpenedStreams++
	l.stats.ActiveStreams++
	l.signalLocked()
	l.mu.Unlock()
	return WriteRelayFrame(connection, RelayFrame{Type: RelayFrameAccept, StreamID: streamID})
}

func (l *RelayLab) forwardData(connection net.Conn, streams map[uint32]struct{}, frame RelayFrame) error {
	l.mu.Lock()
	if _, exists := streams[frame.StreamID]; !exists {
		l.mu.Unlock()
		return l.writeError(connection, frame.StreamID, "unknown_stream")
	}
	if int64(len(frame.Payload)) > l.scenario.ByteQuota-l.stats.ForwardedBytes {
		l.setStateLocked(RelayQuotaExhausted)
		l.stats.RejectedStreams++
		l.mu.Unlock()
		_ = l.closeStream(streams, frame.StreamID)
		if err := l.writeError(connection, frame.StreamID, relayErrorQuota); err != nil {
			return err
		}
		return io.EOF
	}
	l.stats.ForwardedBytes += int64(len(frame.Payload))
	l.signalLocked()
	l.mu.Unlock()
	return WriteRelayFrame(connection, RelayFrame{Type: RelayFrameData, StreamID: frame.StreamID, Payload: frame.Payload})
}

func (l *RelayLab) closeStream(streams map[uint32]struct{}, streamID uint32) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, exists := streams[streamID]; !exists {
		return false
	}
	delete(streams, streamID)
	l.stats.ActiveStreams--
	l.stats.ClosedStreams++
	l.signalLocked()
	return true
}

func (l *RelayLab) writeError(connection net.Conn, streamID uint32, code string) error {
	return WriteRelayFrame(connection, RelayFrame{Type: RelayFrameError, StreamID: streamID, Payload: []byte(code)})
}

func (l *RelayLab) releaseConnection(connection net.Conn) {
	l.mu.Lock()
	streams, ok := l.connections[connection]
	if !ok {
		l.mu.Unlock()
		return
	}
	for streamID := range streams {
		delete(streams, streamID)
		l.stats.ActiveStreams--
		l.stats.ClosedStreams++
	}
	delete(l.connections, connection)
	l.stats.ActiveConnections--
	l.signalLocked()
	l.mu.Unlock()
}

func (l *RelayLab) connectionSliceLocked() []net.Conn {
	connections := make([]net.Conn, 0, len(l.connections))
	for connection := range l.connections {
		connections = append(connections, connection)
	}
	return connections
}

func (l *RelayLab) setStateLocked(state RelayState) {
	if l.state == state {
		return
	}
	l.state = state
	l.signalLocked()
}

func (l *RelayLab) signalLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}

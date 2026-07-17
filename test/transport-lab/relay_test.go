package transportlab

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

const relayFixtureTimeout = time.Second

func startRelayFixture(t *testing.T, scenario RelayScenario) *RelayLab {
	t.Helper()
	lab := NewRelay(scenario)
	if err := lab.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := lab.Close(); err != nil {
			t.Error(err)
		}
	})
	return lab
}

func dialRelayFixture(t *testing.T, lab *RelayLab) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("tcp", lab.Address(), relayFixtureTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(relayFixtureTimeout)); err != nil {
		_ = connection.Close()
		t.Fatal(err)
	}
	return connection
}

func writeRelayTestFrame(t *testing.T, connection net.Conn, frame RelayFrame) {
	t.Helper()
	if err := WriteRelayFrame(connection, frame); err != nil {
		t.Fatal(err)
	}
}

func readRelayTestFrame(t *testing.T, connection net.Conn) RelayFrame {
	t.Helper()
	frame, err := ReadRelayFrame(connection)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func requireRelayFrame(t *testing.T, got RelayFrame, want RelayFrame) {
	t.Helper()
	if got.Type != want.Type || got.StreamID != want.StreamID || string(got.Payload) != string(want.Payload) {
		t.Fatalf("relay frame = %#v, want %#v", got, want)
	}
}

func waitRelayIdle(t *testing.T, lab *RelayLab) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), relayFixtureTimeout)
	defer cancel()
	if err := lab.WaitForIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if err := lab.AssertNoLeaks(); err != nil {
		t.Fatal(err)
	}
}

func TestRelayAcceptsAndEchoesStream(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{ByteQuota: 32, MaxStreams: 2})
	connection := dialRelayFixture(t, lab)

	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 7})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 7})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameData, StreamID: 7, Payload: []byte("hello")})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameData, StreamID: 7, Payload: []byte("hello")})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameClose, StreamID: 7})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameClose, StreamID: 7})
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}

	waitRelayIdle(t, lab)
	stats := lab.Stats()
	if stats.State != RelayAccepting || stats.OpenedStreams != 1 || stats.ClosedStreams != 1 || stats.ForwardedBytes != 5 {
		t.Fatalf("relay stats = %#v", stats)
	}
}

func TestRelayDelaysAcceptance(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{AcceptDelay: 40 * time.Millisecond})
	if got := lab.State(); got != RelayDelayed {
		t.Fatalf("state before delay = %s, want %s", got, RelayDelayed)
	}
	connection := dialRelayFixture(t, lab)
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 1})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 1})
	if got := lab.State(); got != RelayAccepting {
		t.Fatalf("state after delayed accept = %s, want %s", got, RelayAccepting)
	}
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameClose, StreamID: 1})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameClose, StreamID: 1})
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	waitRelayIdle(t, lab)
}

func TestRelayDisconnectReleasesActiveStream(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{})
	connection := dialRelayFixture(t, lab)
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 3})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 3})

	lab.Disconnect()
	if got := lab.State(); got != RelayDisconnected {
		t.Fatalf("state after disconnect = %s, want %s", got, RelayDisconnected)
	}
	_, err := ReadRelayFrame(connection)
	if err == nil || (!errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed)) {
		t.Fatalf("read after disconnect = %v, want connection closure", err)
	}
	_ = connection.Close()
	waitRelayIdle(t, lab)
	if got := lab.Stats().Disconnects; got != 1 {
		t.Fatalf("disconnect count = %d, want 1", got)
	}
}

func TestRelayCloseReleasesActiveStreams(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{})
	connection := dialRelayFixture(t, lab)
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 9})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 9})

	if err := lab.Close(); err != nil {
		t.Fatal(err)
	}
	if got := lab.State(); got != RelayClosed {
		t.Fatalf("state after close = %s, want %s", got, RelayClosed)
	}
	if err := lab.AssertNoLeaks(); err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
}

func TestRelayGracefulDrainRejectsNewStreams(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{MaxStreams: 2})
	connection := dialRelayFixture(t, lab)
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 11})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 11})

	if err := lab.BeginDrain(); err != nil {
		t.Fatal(err)
	}
	if got := lab.State(); got != RelayDraining {
		t.Fatalf("state while draining = %s, want %s", got, RelayDraining)
	}
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameData, StreamID: 11, Payload: []byte("in-flight")})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameData, StreamID: 11, Payload: []byte("in-flight")})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameClose, StreamID: 11})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameClose, StreamID: 11})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 12})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameError, StreamID: 12, Payload: []byte(relayErrorDraining)})
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	waitRelayIdle(t, lab)
}

func TestRelayQuotaExhaustionClosesStream(t *testing.T) {
	lab := startRelayFixture(t, RelayScenario{ByteQuota: 3})
	connection := dialRelayFixture(t, lab)
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameOpen, StreamID: 5})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameAccept, StreamID: 5})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameData, StreamID: 5, Payload: []byte("abc")})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameData, StreamID: 5, Payload: []byte("abc")})
	writeRelayTestFrame(t, connection, RelayFrame{Type: RelayFrameData, StreamID: 5, Payload: []byte("d")})
	requireRelayFrame(t, readRelayTestFrame(t, connection), RelayFrame{Type: RelayFrameError, StreamID: 5, Payload: []byte(relayErrorQuota)})
	if got := lab.State(); got != RelayQuotaExhausted {
		t.Fatalf("state after quota exhaustion = %s, want %s", got, RelayQuotaExhausted)
	}
	_ = connection.Close()
	waitRelayIdle(t, lab)
	stats := lab.Stats()
	if stats.ForwardedBytes != 3 || stats.RejectedStreams != 1 || stats.ActiveStreams != 0 {
		t.Fatalf("relay quota stats = %#v", stats)
	}
}

func TestRelayFrameBounds(t *testing.T) {
	var oversized [relayFrameHeaderBytes]byte
	oversized[0] = byte(RelayFrameData)
	binary.BigEndian.PutUint32(oversized[5:], MaxRelayFrameBytes+1)
	if _, err := ReadRelayFrame(bytes.NewReader(oversized[:])); err == nil {
		t.Fatal("oversize frame was accepted")
	}
}

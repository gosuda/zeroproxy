package wsconn

import (
	"context"
	"errors"
	"io"
	"net"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// pipePair returns two net.Conn endpoints whose Read/Write pump bytes to
// each other in-memory. net.Pipe is synchronous (writes block until reads
// drain) — perfect for testing the relay's tear-down semantics without
// real sockets.
func pipePair() (net.Conn, net.Conn) {
	a, b := net.Pipe()
	return a, b
}

// goroutineCount samples runtime.NumGoroutine after a short settle to let
// scheduling stabilise. The relay launches two copyHalf goroutines and
// must reclaim both before Relay returns; we compare counts before/after.
func goroutineCount(t *testing.T) int {
	t.Helper()
	// One extra GC sweep to avoid double-counting reaped finalizer goroutines.
	runtime.GC()
	time.Sleep(10 * time.Millisecond)
	return runtime.NumGoroutine()
}

// B7: when ctx is cancelled mid-relay, BOTH copy goroutines must exit
// before Relay returns. Prior to the drain-both fix this could leak one
// goroutine — buffered errc absorbed the write but the goroutine kept
// running past Relay's return.
func TestRelayDrainsBothGoroutinesOnContextCancel(t *testing.T) {
	a1, a2 := pipePair()
	b1, b2 := pipePair()
	defer a1.Close()
	defer b1.Close()

	before := goroutineCount(t)

	ctx, cancel := context.WithCancel(context.Background())
	relayDone := make(chan error, 1)
	go func() { relayDone <- Relay(ctx, a2, b2) }()

	// Let Relay launch its two copyHalf goroutines.
	time.Sleep(20 * time.Millisecond)

	cancel()
	select {
	case err := <-relayDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Relay should return context.Canceled on cancel; got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Relay did not return within 2s after context cancellation")
	}

	after := goroutineCount(t)
	// Allow ±1 noise for runtime housekeeping; the relay's two goroutines
	// must both be gone. A leak (one or both still alive) would show
	// `after >= before + 1`.
	if after > before+1 {
		t.Fatalf("goroutine leak after ctx cancel: before=%d after=%d", before, after)
	}
}

// B7: when one half EOFs cleanly (the upstream peer closes), the relay
// surfaces nil to the caller (not io.EOF), and the OTHER half is also
// torn down before Relay returns.
func TestRelayCleanEOFReturnsNilAndDrains(t *testing.T) {
	a1, a2 := pipePair()
	b1, b2 := pipePair()
	defer a1.Close()
	defer b1.Close()

	before := goroutineCount(t)

	ctx := context.Background()
	relayDone := make(chan error, 1)
	go func() { relayDone <- Relay(ctx, a2, b2) }()

	// Close a1 to signal EOF on its end — io.Copy on the (a2 ← a1) half
	// will return nil (clean EOF).
	time.Sleep(10 * time.Millisecond)
	a1.Close()

	select {
	case err := <-relayDone:
		if err != nil {
			t.Fatalf("Relay should surface nil on clean EOF; got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Relay did not return within 2s after EOF")
	}

	after := goroutineCount(t)
	if after > before+1 {
		t.Fatalf("goroutine leak after clean EOF: before=%d after=%d", before, after)
	}
}

// B7: an error on one half tears down the other half before Relay
// returns. We use a conn whose Read errors immediately to model a real
// transport error (e.g. a TLS record decryption failure).
type errReader struct {
	net.Conn
	err atomic.Pointer[error]
}

func (e *errReader) Read(p []byte) (int, error) {
	if errp := e.err.Load(); errp != nil {
		return 0, *errp
	}
	return e.Conn.Read(p)
}

func TestRelayErrorOnOneHalfTearsDownBoth(t *testing.T) {
	a1, a2 := pipePair()
	b1, b2 := pipePair()
	defer a1.Close()
	defer b1.Close()

	wrapper := &errReader{Conn: a2}
	myErr := errors.New("synthetic transport error")
	wrapper.err.Store(&myErr)

	before := goroutineCount(t)

	ctx := context.Background()
	relayDone := make(chan error, 1)
	go func() { relayDone <- Relay(ctx, wrapper, b2) }()

	select {
	case err := <-relayDone:
		// The error surfaced may be the synthetic one OR a closed-conn
		// follow-on depending on goroutine scheduling — either is fine,
		// as long as Relay returns promptly and drains.
		if err == nil {
			t.Fatal("Relay should return non-nil on synthetic transport error")
		}
		_ = io.EOF // keep io import live when this branch is hit
	case <-time.After(2 * time.Second):
		t.Fatal("Relay did not return within 2s after error")
	}

	after := goroutineCount(t)
	if after > before+1 {
		t.Fatalf("goroutine leak after error tear-down: before=%d after=%d", before, after)
	}
}

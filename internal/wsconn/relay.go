package wsconn

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
)

// Relay copies bytes in both directions and closes both sides when either half
// terminates. It is used only after a target stream is already constrained to
// the ZeroProxy WebSocket/yamux/Tor path.
//
// B7 invariants:
//   - Either half terminating tears down BOTH endpoints synchronously
//     (closeBoth via sync.Once).
//   - Context cancellation tears down both endpoints AND waits for both
//     copy goroutines to drain before returning. The prior version drained
//     only one entry on ctx.Done; the second copyHalf could keep running
//     after Relay returned and write to a now-irrelevant errc — by spec
//     buffered so it didn't leak, but by liveness the caller had no
//     guarantee that both halves were actually quiesced when control
//     returned. We now wait for the second drain, so on return BOTH
//     goroutines are guaranteed to have exited.
//   - The first non-context, non-EOF error surfaces to the caller; a
//     downstream EOF after the upstream error is suppressed (it's the
//     natural consequence of closing the upstream half).
func Relay(ctx context.Context, a, b net.Conn) error {
	var once sync.Once
	closeBoth := func() { _ = a.Close(); _ = b.Close() }
	errc := make(chan error, 2)
	copyHalf := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		once.Do(closeBoth)
		errc <- err
	}
	go copyHalf(a, b)
	go copyHalf(b, a)

	var first error
	remaining := 2
	select {
	case <-ctx.Done():
		first = ctx.Err()
		once.Do(closeBoth)
	case err := <-errc:
		first = err
		remaining = 1
		// io.Copy returning nil means clean EOF — surface as nil to the
		// caller so the natural "client closed cleanly" path is preserved.
		if errors.Is(err, io.EOF) {
			first = nil
		}
	}
	// Drain the remaining copyHalf goroutines. closeBoth was already invoked
	// above so their io.Copy returns promptly; their errors are discarded
	// (they're almost always "use of closed network connection" from the
	// closeBoth we just issued). On return BOTH goroutines have exited —
	// the caller gets a hard liveness guarantee.
	for i := 0; i < remaining; i++ {
		<-errc
	}
	return first
}

package wsconn

import (
	"context"
	"io"
	"net"
	"sync"
)

// Relay copies bytes in both directions and closes both sides when either half
// terminates. It is used only after a target stream is already constrained to
// the ZeroProxy WebSocket/yamux/Tor path.
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
	select {
	case <-ctx.Done():
		once.Do(closeBoth)
		<-errc
		return ctx.Err()
	case err := <-errc:
		return err
	}
}

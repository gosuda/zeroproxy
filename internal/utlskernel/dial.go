package utlskernel

import (
	"context"
	"net"

	utls "github.com/refraction-networking/utls"
)

// Wrap performs a browser-like uTLS client handshake over an already connected
// stream. ALPN is pinned to http/1.1 for Phase 0; h2 is intentionally omitted
// because no HTTP/2 transport path exists in this design.
func Wrap(ctx context.Context, stream net.Conn, serverName string) (net.Conn, error) {
	cfg := &utls.Config{ServerName: serverName, NextProtos: []string{"http/1.1"}, MinVersion: utls.VersionTLS12}
	conn := utls.UClient(stream, cfg, utls.HelloChrome_Auto)
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = stream.Close()
		return nil, err
	}
	return conn, nil
}

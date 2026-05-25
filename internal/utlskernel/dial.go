package utlskernel

import (
	"context"
	"net"

	utls "github.com/refraction-networking/utls"

	_ "golang.org/x/crypto/x509roots/fallback"
)

// Wrap performs a browser-like uTLS client handshake over an already connected
// stream. ALPN is pinned to http/1.1 for Phase 0; h2 is intentionally omitted
// because no HTTP/2 transport path exists in this design.
func Wrap(ctx context.Context, stream net.Conn, serverName string) (net.Conn, error) {
	cfg := &utls.Config{ServerName: serverName, NextProtos: []string{"http/1.1"}, MinVersion: utls.VersionTLS12}
	conn := utls.UClient(stream, cfg, utls.HelloCustom)
	spec, err := http1OnlyChromeSpec()
	if err != nil {
		_ = stream.Close()
		return nil, err
	}
	if err := conn.ApplyPreset(spec); err != nil {
		_ = stream.Close()
		return nil, err
	}
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = stream.Close()
		return nil, err
	}
	return conn, nil
}

func http1OnlyChromeSpec() (*utls.ClientHelloSpec, error) {
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		return nil, err
	}
	extensions := spec.Extensions[:0]
	alpnSet := false
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			e.AlpnProtocols = []string{"http/1.1"}
			extensions = append(extensions, e)
			alpnSet = true
		case *utls.ApplicationSettingsExtension, *utls.ApplicationSettingsExtensionNew:
			continue
		default:
			extensions = append(extensions, ext)
		}
	}
	if !alpnSet {
		extensions = append(extensions, &utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}})
	}
	spec.Extensions = extensions
	return &spec, nil
}

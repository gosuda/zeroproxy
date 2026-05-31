package utlskernel

import (
	"context"
	"net"

	utls "github.com/refraction-networking/utls"

	_ "golang.org/x/crypto/x509roots/fallback"
)

const (
	ALPNHTTP2 = "h2"
	ALPNHTTP1 = "http/1.1"
)

// WrapWithALPN performs a browser-like uTLS client handshake and returns the
// negotiated application protocol. An empty negotiated protocol means the peer
// did not select ALPN; callers should treat that as HTTP/1.1 fallback.
func WrapWithALPN(ctx context.Context, stream net.Conn, serverName string, protocols []string) (net.Conn, string, error) {
	protocols = normalizedALPN(protocols)
	cfg := &utls.Config{ServerName: serverName, NextProtos: protocols, MinVersion: utls.VersionTLS12}
	conn := utls.UClient(stream, cfg, utls.HelloCustom)
	spec, err := chromeSpecForALPN(protocols)
	if err != nil {
		_ = stream.Close()
		return nil, "", err
	}
	if err := conn.ApplyPreset(spec); err != nil {
		_ = stream.Close()
		return nil, "", err
	}
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = stream.Close()
		return nil, "", err
	}
	return conn, conn.ConnectionState().NegotiatedProtocol, nil
}

func chromeSpecForALPN(protocols []string) (*utls.ClientHelloSpec, error) {
	protocols = normalizedALPN(protocols)
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		return nil, err
	}
	advertiseH2 := containsProtocol(protocols, ALPNHTTP2)
	extensions := spec.Extensions[:0]
	alpnSet := false
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			e.AlpnProtocols = append([]string(nil), protocols...)
			extensions = append(extensions, e)
			alpnSet = true
		case *utls.ApplicationSettingsExtension:
			if !advertiseH2 {
				continue
			}
			e.SupportedProtocols = []string{ALPNHTTP2}
			extensions = append(extensions, e)
		case *utls.ApplicationSettingsExtensionNew:
			if !advertiseH2 {
				continue
			}
			e.SupportedProtocols = []string{ALPNHTTP2}
			extensions = append(extensions, e)
		default:
			extensions = append(extensions, ext)
		}
	}
	if !alpnSet {
		extensions = append(extensions, &utls.ALPNExtension{AlpnProtocols: append([]string(nil), protocols...)})
	}
	spec.Extensions = extensions
	return &spec, nil
}

func normalizedALPN(protocols []string) []string {
	if len(protocols) == 0 {
		return []string{ALPNHTTP1}
	}
	out := make([]string, 0, len(protocols))
	for _, p := range protocols {
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{ALPNHTTP1}
	}
	return out
}

func containsProtocol(protocols []string, needle string) bool {
	for _, p := range protocols {
		if p == needle {
			return true
		}
	}
	return false
}

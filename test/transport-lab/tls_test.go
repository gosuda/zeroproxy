package transportlab

import (
	"crypto/tls"
	"net"
	"testing"
	"time"
)

func TestTLSServerNegotiatesConfiguredALPN(t *testing.T) {
	server := startTLSServer(t, TLSOptions{
		MinVersion: tls.VersionTLS13,
		NextProtos: []string{"h2", "http/1.1"},
	})
	connection := dialTLS(t, server, &tls.Config{
		RootCAs:    server.RootPool(),
		ServerName: "localhost",
		MinVersion: tls.VersionTLS13,
		NextProtos: []string{"http/1.1", "h2"},
	})
	defer connection.Close()

	if state := connection.ConnectionState(); state.Version != tls.VersionTLS13 || state.NegotiatedProtocol != "h2" {
		t.Fatalf("TLS state = version %x, ALPN %q", state.Version, state.NegotiatedProtocol)
	}
}

func TestTLSServerEnforcesConfiguredMinimumVersion(t *testing.T) {
	server := startTLSServer(t, TLSOptions{MinVersion: tls.VersionTLS13})
	dialer := &net.Dialer{Timeout: time.Second}
	connection, err := tls.DialWithDialer(dialer, "tcp", server.Address(), &tls.Config{
		RootCAs:    server.RootPool(),
		ServerName: "localhost",
		MaxVersion: tls.VersionTLS12,
	})
	if connection != nil {
		_ = connection.Close()
	}
	if err == nil {
		t.Fatal("TLS 1.2 handshake unexpectedly succeeded")
	}
}

func TestTLSServerRejectsALPNMismatchAndRefusal(t *testing.T) {
	tests := []struct {
		name    string
		options TLSOptions
		client  []string
	}{
		{
			name:    "ALPN mismatch",
			options: TLSOptions{NextProtos: []string{"h2"}},
			client:  []string{"http/1.1"},
		},
		{
			name:    "configured refusal",
			options: TLSOptions{NextProtos: []string{"h2"}, RefuseHandshake: true},
			client:  []string{"h2"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := startTLSServer(t, test.options)
			dialer := &net.Dialer{Timeout: time.Second}
			connection, err := tls.DialWithDialer(dialer, "tcp", server.Address(), &tls.Config{
				RootCAs:    server.RootPool(),
				ServerName: "localhost",
				NextProtos: test.client,
			})
			if connection != nil {
				_ = connection.Close()
			}
			if err == nil {
				t.Fatal("TLS handshake unexpectedly succeeded")
			}
		})
	}
}

func startTLSServer(t *testing.T, options TLSOptions) *TLSServer {
	t.Helper()
	server, err := NewTLS(options)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func dialTLS(t *testing.T, server *TLSServer, config *tls.Config) *tls.Conn {
	t.Helper()
	dialer := &net.Dialer{Timeout: time.Second}
	connection, err := tls.DialWithDialer(dialer, "tcp", server.Address(), config)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

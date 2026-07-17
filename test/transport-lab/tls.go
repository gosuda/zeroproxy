package transportlab

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"time"
)

const (
	defaultTLSHandshakeTimeout = 2 * time.Second
	maxTLSHandshakeTimeout     = 5 * time.Second
	maxTLSALPNProtocols        = 16
	maxTLSALPNLength           = 255
)

// TLSOptions configures a local TLS endpoint. It intentionally exposes only
// handshake controls so fixture traffic remains local and bounded.
type TLSOptions struct {
	MinVersion       uint16
	NextProtos       []string
	RefuseHandshake  bool
	HandshakeTimeout time.Duration
}

// TLSServer is a bounded local TLS endpoint backed by TCPServer. It generates
// a fresh in-memory localhost certificate for each fixture.
type TLSServer struct {
	server           *TCPServer
	serverConfig     *tls.Config
	certificate      *x509.Certificate
	refuseHandshake  bool
	handshakeTimeout time.Duration
}

// NewTLS creates a TLS fixture. Start must be called before it accepts local
// connections.
func NewTLS(options TLSOptions) (*TLSServer, error) {
	minVersion, err := tlsMinimumVersion(options.MinVersion)
	if err != nil {
		return nil, err
	}
	if err := validateTLSALPN(options.NextProtos); err != nil {
		return nil, err
	}

	certificate, parsedCertificate, err := newTestCertificate()
	if err != nil {
		return nil, err
	}
	server := &TLSServer{
		serverConfig: &tls.Config{
			Certificates: []tls.Certificate{certificate},
			MinVersion:   minVersion,
			NextProtos:   append([]string(nil), options.NextProtos...),
		},
		certificate:      parsedCertificate,
		refuseHandshake:  options.RefuseHandshake,
		handshakeTimeout: boundedTLSHandshakeTimeout(options.HandshakeTimeout),
	}
	server.server = NewTCP(server.serve)
	return server, nil
}

// Start begins the local listener.
func (s *TLSServer) Start() error {
	return s.server.Start()
}

// Address returns the local listener address after Start.
func (s *TLSServer) Address() string {
	return s.server.Address()
}

// Close stops accepting connections and waits for the listener to exit.
func (s *TLSServer) Close() error {
	return s.server.Close()
}

// RootPool returns a root pool containing only this fixture's generated CA.
func (s *TLSServer) RootPool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(s.certificate)
	return pool
}

func (s *TLSServer) serve(connection net.Conn) {
	_ = connection.SetDeadline(time.Now().Add(s.handshakeTimeout))
	defer connection.SetDeadline(time.Time{})

	config := s.serverConfig.Clone()
	config.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if s.refuseHandshake || !hasCompatibleALPN(config.NextProtos, hello.SupportedProtos) {
			return nil, errors.New("transport TLS lab refused handshake")
		}
		return s.serverConfig.Clone(), nil
	}
	_ = tls.Server(connection, config).Handshake()
}

func tlsMinimumVersion(version uint16) (uint16, error) {
	if version == 0 {
		return tls.VersionTLS12, nil
	}
	if version < tls.VersionTLS10 || version > tls.VersionTLS13 {
		return 0, errors.New("transport TLS lab invalid minimum TLS version")
	}
	return version, nil
}

func validateTLSALPN(protocols []string) error {
	if len(protocols) > maxTLSALPNProtocols {
		return errors.New("transport TLS lab too many ALPN protocols")
	}
	seen := make(map[string]struct{}, len(protocols))
	for _, protocol := range protocols {
		if len(protocol) == 0 || len(protocol) > maxTLSALPNLength {
			return errors.New("transport TLS lab invalid ALPN protocol")
		}
		if _, ok := seen[protocol]; ok {
			return errors.New("transport TLS lab duplicate ALPN protocol")
		}
		seen[protocol] = struct{}{}
	}
	return nil
}

func boundedTLSHandshakeTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return defaultTLSHandshakeTimeout
	}
	if timeout > maxTLSHandshakeTimeout {
		return maxTLSHandshakeTimeout
	}
	return timeout
}

func hasCompatibleALPN(server, client []string) bool {
	if len(server) == 0 {
		return true
	}
	for _, offered := range client {
		for _, supported := range server {
			if offered == supported {
				return true
			}
		}
	}
	return false
}

func newTestCertificate() (tls.Certificate, *x509.Certificate, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "transport-lab.local"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	parsedCertificate, err := x509.ParseCertificate(certificateDER)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	certificate := tls.Certificate{
		Certificate: [][]byte{certificateDER},
		PrivateKey:  privateKey,
		Leaf:        parsedCertificate,
	}
	return certificate, parsedCertificate, nil
}

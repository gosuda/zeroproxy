package utlskernel

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"strings"

	"github.com/gosuda/zeroproxy/internal/policy"
	utls "github.com/refraction-networking/utls"
	_ "golang.org/x/crypto/x509roots/fallback"
)

type Persona uint8

const Chrome Persona = 1

// Chrome 149.0.7827.201 has the same non-PSK ClientHello invariants as the
// explicitly pinned uTLS Chrome 133 profile. Do not use HelloChrome_Auto:
// updating uTLS must not silently change the release persona.
var chromeClientHelloID = utls.HelloChrome_133

type FailureKind uint8

const (
	FailureUnknown FailureKind = iota
	FailurePolicy
	FailureCertificate
	FailureTLSProtocol
	FailureALPN
	FailureTimeout
	FailureAbort
)

type Failure struct {
	Kind FailureKind
	Err  error
}

func (failure *Failure) Error() string { return failure.Err.Error() }
func (failure *Failure) Unwrap() error { return failure.Err }

func KindOf(err error) FailureKind {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Kind
	}
	return FailureUnknown
}

type Config struct {
	ServerName string
	Roots      *x509.CertPool
	Persona    Persona
}

func Client(ctx context.Context, conn net.Conn, cfg Config) (*utls.UConn, error) {
	canonicalName, err := policy.CanonicalEgressHost(cfg.ServerName)
	if err != nil || canonicalName != cfg.ServerName {
		return nil, &Failure{Kind: FailurePolicy, Err: errors.New("canonical TLS server name required")}
	}
	if cfg.Persona != Chrome {
		return nil, &Failure{Kind: FailurePolicy, Err: errors.New("unsupported TLS persona")}
	}
	client := utls.UClient(conn, &utls.Config{
		ServerName: cfg.ServerName,
		RootCAs:    cfg.Roots,
		MinVersion: tls.VersionTLS12,
		MaxVersion: tls.VersionTLS13,
		NextProtos: []string{"h2", "http/1.1"},
	}, chromeClientHelloID)
	if err := client.HandshakeContext(ctx); err != nil {
		return nil, closeAfterFailure(client, classifyHandshakeFailure(ctx, err))
	}
	state := client.ConnectionState()
	if !state.HandshakeComplete || len(state.PeerCertificates) == 0 || len(state.VerifiedChains) == 0 {
		return nil, closeAfterFailure(client, &Failure{
			Kind: FailureCertificate,
			Err:  errors.New("TLS certificate verification incomplete"),
		})
	}
	if state.Version < tls.VersionTLS12 || state.Version > tls.VersionTLS13 {
		return nil, closeAfterFailure(client, &Failure{
			Kind: FailureTLSProtocol,
			Err:  errors.New("unsupported target TLS version"),
		})
	}
	if state.NegotiatedProtocol != "" &&
		(state.NegotiatedProtocol != "h2" && state.NegotiatedProtocol != "http/1.1" || !state.NegotiatedProtocolIsMutual) {
		return nil, closeAfterFailure(client, &Failure{
			Kind: FailureALPN,
			Err:  errors.New("unsupported target ALPN"),
		})
	}
	return client, nil
}

func classifyHandshakeFailure(ctx context.Context, err error) *Failure {
	if errors.Is(ctx.Err(), context.Canceled) {
		return &Failure{Kind: FailureAbort, Err: err}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &Failure{Kind: FailureTimeout, Err: err}
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return &Failure{Kind: FailureTimeout, Err: err}
	}
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalidCertificate x509.CertificateInvalidError
	var systemRoots x509.SystemRootsError
	if errors.As(err, &unknownAuthority) || errors.As(err, &hostname) ||
		errors.As(err, &invalidCertificate) || errors.As(err, &systemRoots) {
		return &Failure{Kind: FailureCertificate, Err: err}
	}
	if strings.Contains(err.Error(), "ALPN") || strings.Contains(err.Error(), "application protocol") {
		return &Failure{Kind: FailureALPN, Err: err}
	}
	return &Failure{Kind: FailureTLSProtocol, Err: err}
}

func closeAfterFailure(conn net.Conn, failure *Failure) error {
	if closeErr := conn.Close(); closeErr != nil {
		failure.Err = errors.Join(failure.Err, closeErr)
	}
	return failure
}

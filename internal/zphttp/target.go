package zphttp

import (
	"context"
	"crypto/x509"
	"errors"
	"net"

	"github.com/gosuda/zeroproxy/internal/policy"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
)

type TargetConn struct {
	net.Conn
	Protocol string
}

func SecureTarget(ctx context.Context, conn net.Conn, target policy.Target) (*TargetConn, error) {
	return secureTarget(ctx, conn, target, nil)
}

func secureTarget(ctx context.Context, conn net.Conn, target policy.Target, roots *x509.CertPool) (*TargetConn, error) {
	canonicalHost, err := policy.CanonicalEgressHost(target.Origin.Host)
	if err != nil || canonicalHost != target.Origin.Host {
		return nil, &utlskernel.Failure{Kind: utlskernel.FailurePolicy, Err: policy.ErrAddressPolicy}
	}
	switch target.Origin.Scheme {
	case "http":
		return &TargetConn{Conn: conn, Protocol: "http/1.1"}, nil
	case "https":
		client, err := utlskernel.Client(ctx, conn, utlskernel.Config{
			ServerName: target.Origin.Host,
			Roots:      roots,
			Persona:    utlskernel.Chrome,
		})
		if err != nil {
			return nil, err
		}
		protocol := client.ConnectionState().NegotiatedProtocol
		switch protocol {
		case "":
			protocol = "http/1.1"
		case "h2", "http/1.1":
		default:
			closeErr := client.Close()
			protocolErr := &utlskernel.Failure{Kind: utlskernel.FailureALPN, Err: errors.New("unsupported target ALPN")}
			if closeErr != nil {
				protocolErr.Err = errors.Join(protocolErr.Err, closeErr)
			}
			return nil, protocolErr
		}
		return &TargetConn{Conn: client, Protocol: protocol}, nil
	default:
		return nil, &utlskernel.Failure{Kind: utlskernel.FailurePolicy, Err: errors.New("unsupported target scheme")}
	}
}

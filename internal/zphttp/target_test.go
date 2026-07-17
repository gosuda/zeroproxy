package zphttp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/policy"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
)

func closeTargetTestConn(t *testing.T, conn net.Conn) {
	t.Helper()
	if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Errorf("close connection: %v", err)
	}
}

func TestHTTPUsesRawSOCKSStreamAndCustomPort(t *testing.T) {
	target, err := policy.ParseTarget("http://target.zeroproxy.dev:8080/path")
	if err != nil {
		t.Fatal(err)
	}
	client, server := net.Pipe()
	defer closeTargetTestConn(t, client)
	defer closeTargetTestConn(t, server)
	secured, err := SecureTarget(context.Background(), client, target)
	if err != nil {
		t.Fatal(err)
	}
	if secured.Conn != client {
		t.Fatal("HTTP stream identity changed")
	}
	if secured.Protocol != "http/1.1" {
		t.Fatalf("protocol %q", secured.Protocol)
	}
	if target.Origin.Port != 8080 {
		t.Fatalf("port %d", target.Origin.Port)
	}
}
func TestHTTPSRequiresTLSHandshakeAndCustomPort(t *testing.T) {
	target, err := policy.ParseTarget("https://target.zeroproxy.dev:8443/path")
	if err != nil {
		t.Fatal(err)
	}
	client, server := net.Pipe()
	defer closeTargetTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		header := make([]byte, 5)
		_, err := io.ReadFull(server, header)
		if err == nil {
			length := int(header[3])<<8 | int(header[4])
			_, err = io.ReadFull(server, make([]byte, length))
		}
		if err == nil {
			_, err = server.Write([]byte("not tls"))
		}
		if errors.Is(err, io.ErrClosedPipe) {
			err = nil
		}
		if closeErr := server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		done <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := SecureTarget(ctx, client, target); utlskernel.KindOf(err) != utlskernel.FailureTLSProtocol {
		t.Fatalf("invalid TLS server error kind=%v error=%v", utlskernel.KindOf(err), err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if target.Origin.Port != 8443 {
		t.Fatalf("port %d", target.Origin.Port)
	}
}

func testCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "unused.zeroproxy.dev"},
		DNSNames:     []string{"target.zeroproxy.dev"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, roots
}

func negotiateTargetProtocol(t *testing.T, nextProtos []string) string {
	t.Helper()
	certificate, roots := testCertificate(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Errorf("close listener: %v", closeErr)
		}
	}()
	serverDone := make(chan error, 1)
	go func() {
		raw, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		server := tls.Server(raw, &tls.Config{
			Certificates: []tls.Certificate{certificate},
			NextProtos:   nextProtos,
			MinVersion:   tls.VersionTLS12,
		})
		handshakeErr := server.Handshake()
		closeErr := server.Close()
		if handshakeErr != nil {
			serverDone <- handshakeErr
			return
		}
		serverDone <- closeErr
	}()
	raw, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	target, err := policy.ParseTarget("https://target.zeroproxy.dev:" + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port) + "/")
	if err != nil {
		t.Fatal(err)
	}
	secured, err := secureTarget(context.Background(), raw, target, roots)
	if err != nil {
		t.Fatal(err)
	}
	protocol := secured.Protocol
	closeTargetTestConn(t, secured)
	if err := <-serverDone; err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	return protocol
}

func targetTLSFailure(t *testing.T, serverConfig *tls.Config, host string, roots *x509.CertPool) utlskernel.FailureKind {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	serverDone := make(chan error, 1)
	go func() {
		raw, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		server := tls.Server(raw, serverConfig)
		handshakeErr := server.Handshake()
		_ = server.Close()
		serverDone <- handshakeErr
	}()
	raw, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	target, err := policy.ParseTarget("https://" + host + ":" + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port) + "/")
	if err != nil {
		t.Fatal(err)
	}
	_, secureErr := secureTarget(context.Background(), raw, target, roots)
	_ = raw.Close()
	<-serverDone
	if secureErr == nil {
		t.Fatal("invalid target TLS configuration accepted")
	}
	return utlskernel.KindOf(secureErr)
}

func TestHTTPSFailureKindsSeparateCertificateProtocolAndALPN(t *testing.T) {
	certificate, roots := testCertificate(t)
	base := tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	if kind := targetTLSFailure(t, base.Clone(), "target.zeroproxy.dev", x509.NewCertPool()); kind != utlskernel.FailureCertificate {
		t.Fatalf("untrusted certificate kind=%v", kind)
	}
	if kind := targetTLSFailure(t, base.Clone(), "other.zeroproxy.dev", roots); kind != utlskernel.FailureCertificate {
		t.Fatalf("hostname certificate kind=%v", kind)
	}
	oldTLS := base.Clone()
	oldTLS.MinVersion, oldTLS.MaxVersion = tls.VersionTLS11, tls.VersionTLS11
	if kind := targetTLSFailure(t, oldTLS, "target.zeroproxy.dev", roots); kind != utlskernel.FailureTLSProtocol {
		t.Fatalf("old TLS protocol kind=%v", kind)
	}
	noALPN := base.Clone()
	noALPN.NextProtos = []string{"smtp"}
	if kind := targetTLSFailure(t, noALPN, "target.zeroproxy.dev", roots); kind != utlskernel.FailureALPN {
		t.Fatalf("ALPN mismatch kind=%v", kind)
	}
}

func TestTargetHostMustPassCanonicalSignedAddressPolicy(t *testing.T) {
	target, err := policy.ParseTarget("https://example.test/")
	if err != nil {
		t.Fatal(err)
	}
	client, server := net.Pipe()
	defer closeTargetTestConn(t, client)
	defer closeTargetTestConn(t, server)
	if _, err := SecureTarget(context.Background(), client, target); utlskernel.KindOf(err) != utlskernel.FailurePolicy {
		t.Fatalf("blocked target failure kind=%v error=%v", utlskernel.KindOf(err), err)
	}
}
func TestHTTPSUsesNegotiatedHTTP2(t *testing.T) {
	if protocol := negotiateTargetProtocol(t, []string{"h2", "http/1.1"}); protocol != "h2" {
		t.Fatalf("protocol %q", protocol)
	}
}

func TestHTTPSWithoutALPNUsesHTTP11(t *testing.T) {
	if protocol := negotiateTargetProtocol(t, nil); protocol != "http/1.1" {
		t.Fatalf("protocol %q", protocol)
	}
}

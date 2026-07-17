package utlskernel

import (
	"context"
	"errors"
	"io"
	"net"
	"reflect"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

// These invariants were captured from the supported Chrome 149.0.7827.201
// darwin-arm64 binary. GREASE values and extension order vary per connection.
func TestChrome149ClientHelloInvariants(t *testing.T) {
	spec, err := utls.UTLSIdToSpec(chromeClientHelloID)
	if err != nil {
		t.Fatal(err)
	}
	assertChrome149Spec(t, &spec)
}

func TestChrome149ClientHelloWireInvariants(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := utls.UClient(clientConn, &utls.Config{
		ServerName: "example.test",
		NextProtos: []string{"h2", "http/1.1"},
	}, chromeClientHelloID)
	handshakeDone := make(chan error, 1)
	go func() { handshakeDone <- client.Handshake() }()

	header := make([]byte, 5)
	if _, err := io.ReadFull(serverConn, header); err != nil {
		t.Fatal(err)
	}
	length := int(header[3])<<8 | int(header[4])
	record := make([]byte, 5+length)
	copy(record, header)
	if _, err := io.ReadFull(serverConn, record[5:]); err != nil {
		t.Fatal(err)
	}
	_ = serverConn.Close()
	_ = clientConn.Close()
	if err := <-handshakeDone; err == nil {
		t.Fatal("handshake unexpectedly completed without a server response")
	}

	spec, err := (&utls.Fingerprinter{}).FingerprintClientHello(record)
	if err != nil {
		t.Fatal(err)
	}
	assertChrome149Spec(t, spec)
}

func TestTLSFailureKindsSeparateAbortAndTimeout(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if kind := classifyHandshakeFailure(cancelled, errors.New("closed")).Kind; kind != FailureAbort {
		t.Fatalf("cancel failure kind=%v", kind)
	}
	expired, expire := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer expire()
	if kind := classifyHandshakeFailure(expired, errors.New("closed")).Kind; kind != FailureTimeout {
		t.Fatalf("deadline failure kind=%v", kind)
	}
}

func assertChrome149Spec(t *testing.T, spec *utls.ClientHelloSpec) {
	t.Helper()
	wantCipherSuites := []uint16{
		utls.GREASE_PLACEHOLDER,
		utls.TLS_AES_128_GCM_SHA256,
		utls.TLS_AES_256_GCM_SHA384,
		utls.TLS_CHACHA20_POLY1305_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
		utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
		utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		utls.TLS_RSA_WITH_AES_128_CBC_SHA,
		utls.TLS_RSA_WITH_AES_256_CBC_SHA,
	}
	if !reflect.DeepEqual(spec.CipherSuites, wantCipherSuites) {
		t.Fatalf("cipher suite drift: got %v want %v", spec.CipherSuites, wantCipherSuites)
	}

	assertChrome149Extensions(t, spec.Extensions)
}

func assertChrome149Extensions(t *testing.T, extensions []utls.TLSExtension) {
	t.Helper()
	seen := make(map[string]int, len(extensions))
	var curves []utls.CurveID
	var signatures []utls.SignatureScheme
	var versions []uint16
	var alpn []string
	var applicationSettings []string
	var compression []utls.CertCompressionAlgo
	var keyShares []utls.CurveID
	var pskModes []uint8
	for _, extension := range extensions {
		var name string
		switch extension := extension.(type) {
		case *utls.UtlsGREASEExtension:
			name = "grease"
		case *utls.SNIExtension:
			name = "server_name"
		case *utls.ExtendedMasterSecretExtension:
			name = "extended_master_secret"
		case *utls.RenegotiationInfoExtension:
			name = "renegotiation_info"
		case *utls.SupportedCurvesExtension:
			name, curves = "supported_groups", extension.Curves
		case *utls.SupportedPointsExtension:
			name = "supported_points"
		case *utls.SessionTicketExtension:
			name = "session_ticket"
		case *utls.ALPNExtension:
			name, alpn = "alpn", extension.AlpnProtocols
		case *utls.StatusRequestExtension:
			name = "status_request"
		case *utls.SignatureAlgorithmsExtension:
			name, signatures = "signature_algorithms", extension.SupportedSignatureAlgorithms
		case *utls.SCTExtension:
			name = "signed_certificate_timestamp"
		case *utls.KeyShareExtension:
			name = "key_share"
			for _, share := range extension.KeyShares {
				keyShares = append(keyShares, share.Group)
			}
		case *utls.PSKKeyExchangeModesExtension:
			name, pskModes = "psk_key_exchange_modes", extension.Modes
		case *utls.SupportedVersionsExtension:
			name, versions = "supported_versions", extension.Versions
		case *utls.UtlsCompressCertExtension:
			name, compression = "certificate_compression", extension.Algorithms
		case *utls.ApplicationSettingsExtensionNew:
			name, applicationSettings = "application_settings", extension.SupportedProtocols
		case *utls.GREASEEncryptedClientHelloExtension:
			name = "encrypted_client_hello_grease"
		default:
			t.Fatalf("unexpected TLS extension type %T", extension)
		}
		seen[name]++
	}
	wantExtensions := map[string]int{
		"grease": 2, "server_name": 1, "extended_master_secret": 1,
		"renegotiation_info": 1, "supported_groups": 1, "supported_points": 1,
		"session_ticket": 1, "alpn": 1, "status_request": 1,
		"signature_algorithms": 1, "signed_certificate_timestamp": 1,
		"key_share": 1, "psk_key_exchange_modes": 1, "supported_versions": 1,
		"certificate_compression": 1, "application_settings": 1,
		"encrypted_client_hello_grease": 1,
	}
	if !reflect.DeepEqual(seen, wantExtensions) {
		t.Fatalf("extension multiset drift: got %v want %v", seen, wantExtensions)
	}
	assertEqual(t, "supported groups", curves, []utls.CurveID{utls.GREASE_PLACEHOLDER, utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384})
	assertEqual(t, "key share groups", keyShares, []utls.CurveID{utls.GREASE_PLACEHOLDER, utls.X25519MLKEM768, utls.X25519})
	assertEqual(t, "signature algorithms", signatures, []utls.SignatureScheme{utls.ECDSAWithP256AndSHA256, utls.PSSWithSHA256, utls.PKCS1WithSHA256, utls.ECDSAWithP384AndSHA384, utls.PSSWithSHA384, utls.PKCS1WithSHA384, utls.PSSWithSHA512, utls.PKCS1WithSHA512})
	assertEqual(t, "supported versions", versions, []uint16{utls.GREASE_PLACEHOLDER, utls.VersionTLS13, utls.VersionTLS12})
	assertEqual(t, "PSK modes", pskModes, []uint8{utls.PskModeDHE})
	assertEqual(t, "ALPN", alpn, []string{"h2", "http/1.1"})
	assertEqual(t, "application settings", applicationSettings, []string{"h2"})
	assertEqual(t, "certificate compression", compression, []utls.CertCompressionAlgo{utls.CertCompressionBrotli})
}

func assertEqual[T comparable](t *testing.T, name string, got, want []T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s drift: got %v want %v", name, got, want)
	}
}

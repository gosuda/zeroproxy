package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/hostrole"
	"github.com/gosuda/zeroproxy/internal/release"
)

func testTLSRoles(t *testing.T) *hostrole.Classifier {
	t.Helper()
	roles, err := hostrole.New("control.example", "assets.example", "relay.example", "example")
	if err != nil {
		t.Fatal(err)
	}
	return roles
}

func writeTestCertificate(t *testing.T, dnsNames []string) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "unused.example"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(time.Hour),
		DNSNames:     dnsNames,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	certificatePath := filepath.Join(directory, "tls.crt")
	keyPath := filepath.Join(directory, "tls.key")
	if err := os.WriteFile(certificatePath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certificatePath, keyPath
}

func TestTLSCertificateSANSetIsExactBeforeListen(t *testing.T) {
	roles := testTLSRoles(t)
	names := []string{"control.example", "assets.example", "relay.example", "*.browse.example"}
	certificatePath, keyPath := writeTestCertificate(t, names)
	cfg := config{TLSCert: certificatePath, TLSKey: keyPath}
	if _, _, digest, err := loadValidatedTLSCertificate(cfg, roles, time.Now().UTC()); err != nil || len(digest) != 64 {
		t.Fatalf("exact role certificate rejected: digest=%q error=%v", digest, err)
	}
	for _, invalid := range [][]string{
		{"control.example", "assets.example", "relay.example"},
		{"control.example", "assets.example", "relay.example", "*.example"},
		{"control.example", "assets.example", "relay.example", "*.browse.example", "*.extra.example"},
	} {
		invalidCertificate, invalidKey := writeTestCertificate(t, invalid)
		if _, _, _, err := loadValidatedTLSCertificate(config{TLSCert: invalidCertificate, TLSKey: invalidKey}, roles, time.Now().UTC()); err == nil {
			t.Fatalf("invalid SAN set accepted: %v", invalid)
		}
	}
	_, otherKey := writeTestCertificate(t, names)
	if _, _, _, err := loadValidatedTLSCertificate(config{TLSCert: certificatePath, TLSKey: otherKey}, roles, time.Now().UTC()); err == nil {
		t.Fatal("certificate/key mismatch accepted")
	}
}

func writeSignedTLSReadiness(t *testing.T, readiness tlsReadiness) (string, string, string) {
	t.Helper()
	directory := t.TempDir()
	for _, name := range []string{"tls-readiness.schema.json", "release-signing-keys.schema.json", "release-signature.schema.json"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "protocol", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	publicA, privateA, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicB, privateB, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	keys := release.KeySet{
		SchemaVersion: 1, KeyEpoch: readiness.KeyEpoch, Threshold: 2, DevelopmentOnly: true,
		Keys: []release.Key{
			{ID: "test-release", Role: "release", Owner: "release owner", PublicKey: base64.RawURLEncoding.EncodeToString(publicA), ValidFrom: now.Add(-time.Hour).Format(time.RFC3339), ValidUntil: now.Add(time.Hour).Format(time.RFC3339)},
			{ID: "test-security", Role: "security", Owner: "security owner", PublicKey: base64.RawURLEncoding.EncodeToString(publicB), ValidFrom: now.Add(-time.Hour).Format(time.RFC3339), ValidUntil: now.Add(time.Hour).Format(time.RFC3339)},
		},
	}
	readinessData, err := json.Marshal(readiness)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := release.CanonicalJSON(readinessData)
	if err != nil {
		t.Fatal(err)
	}
	signatures := release.SignatureSet{
		Algorithm: "Ed25519", Canonicalization: "RFC8785", KeyEpoch: readiness.KeyEpoch, DevelopmentOnly: true,
		Signatures: []release.Signature{
			{KeyID: "test-release", Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateA, canonical))},
			{KeyID: "test-security", Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateB, canonical))},
		},
	}
	keysData, _ := json.Marshal(keys)
	signaturesData, _ := json.Marshal(signatures)
	readinessPath := filepath.Join(directory, "tls-readiness.json")
	keysPath := filepath.Join(directory, "release-signing-keys.json")
	signaturesPath := filepath.Join(directory, "tls-readiness.sig")
	for path, data := range map[string][]byte{readinessPath: readinessData, keysPath: keysData, signaturesPath: signaturesData} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return readinessPath, signaturesPath, keysPath
}

func TestHSTSIncludeSubDomainsRequiresMatchingSignedReadiness(t *testing.T) {
	roles := testTLSRoles(t)
	now := time.Now().UTC()
	readiness := tlsReadiness{
		SchemaVersion: 1, KeyEpoch: 1,
		ControlAuthority: roles.Authority(hostrole.Control), AssetAuthority: roles.Authority(hostrole.Asset),
		RelayAuthority: roles.Authority(hostrole.Relay), BrowseWildcardAuthority: roles.BrowseWildcardAuthority(),
		CertificateSPKISHA256: strings.Repeat("a", 64),
		ControlReady:          true, AssetReady: true, RelayReady: true, BrowseReady: true,
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339),
	}
	readinessPath, signaturesPath, keysPath := writeSignedTLSReadiness(t, readiness)
	cfg := config{TLSReadiness: readinessPath, TLSReadinessSignatures: signaturesPath, ReleaseSigningKeys: keysPath, DevelopmentMode: true}
	ready, err := verifyTLSReadiness(cfg, roles, readiness.CertificateSPKISHA256, now)
	if err != nil || !ready {
		t.Fatalf("valid signed TLS readiness rejected: ready=%v error=%v", ready, err)
	}
	if _, err := verifyTLSReadiness(cfg, roles, strings.Repeat("b", 64), now); err == nil {
		t.Fatal("readiness for another certificate accepted")
	}
	if ready, err := verifyTLSReadiness(config{}, roles, readiness.CertificateSPKISHA256, now); err != nil || ready {
		t.Fatalf("missing readiness enabled HSTS: ready=%v error=%v", ready, err)
	}

	app := testServer(t)
	response := httptest.NewRecorder()
	app.securityHeaders(response)
	if strings.Contains(response.Header().Get("Strict-Transport-Security"), "includeSubDomains") {
		t.Fatal("HSTS includes subdomains without readiness")
	}
	app.hstsIncludeSubDomains = true
	response = httptest.NewRecorder()
	app.securityHeaders(response)
	if response.Header().Get("Strict-Transport-Security") != "max-age=31536000; includeSubDomains" {
		t.Fatalf("ready HSTS header = %q", response.Header().Get("Strict-Transport-Security"))
	}
}

func TestHTTPRedirectUsesExactAuthorityAndDoesNotReachApplication(t *testing.T) {
	roles, err := hostrole.New("control.example:8443", "assets.example:8443", "relay.example:8443", "example")
	if err != nil {
		t.Fatal(err)
	}
	handler := httpsRedirectHandler{roles: roles}
	request := httptest.NewRequest(http.MethodPost, "http://relay.example/_zp/carrier?secret=no", strings.NewReader("sensitive"))
	request.Host = "relay.example:80"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPermanentRedirect || response.Header().Get("Location") != "https://relay.example:8443/_zp/carrier?secret=no" {
		t.Fatalf("redirect status=%d location=%q", response.Code, response.Header().Get("Location"))
	}
	for _, authority := range []string{"relay.example:8080", "relay.example.evil", "evilrelay.example"} {
		request = httptest.NewRequest(http.MethodGet, "http://"+authority+"/", nil)
		request.Host = authority
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusMisdirectedRequest {
			t.Fatalf("authority %q status=%d", authority, response.Code)
		}
	}
}

package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gosuda/zeroproxy/internal/hostrole"
	"github.com/gosuda/zeroproxy/internal/release"
)

type tlsReadiness struct {
	SchemaVersion           uint64 `json:"schema_version"`
	KeyEpoch                uint64 `json:"key_epoch"`
	ControlAuthority        string `json:"control_authority"`
	AssetAuthority          string `json:"asset_authority"`
	RelayAuthority          string `json:"relay_authority"`
	BrowseWildcardAuthority string `json:"browse_wildcard_authority"`
	CertificateSPKISHA256   string `json:"certificate_spki_sha256"`
	ControlReady            bool   `json:"control_ready"`
	AssetReady              bool   `json:"asset_ready"`
	RelayReady              bool   `json:"relay_ready"`
	BrowseReady             bool   `json:"browse_ready"`
	IssuedAt                string `json:"issued_at"`
	ExpiresAt               string `json:"expires_at"`
}

func authorityDNSName(authority string) (string, error) {
	if !strings.Contains(authority, ":") {
		return authority, nil
	}
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		return "", err
	}
	return host, nil
}

func loadValidatedTLSCertificate(cfg config, roles *hostrole.Classifier, now time.Time) (tls.Certificate, *x509.Certificate, string, error) {
	certificate, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("load TLS certificate/key: %w", err)
	}
	if len(certificate.Certificate) == 0 {
		return tls.Certificate{}, nil, "", errors.New("TLS certificate chain is empty")
	}
	var leaf *x509.Certificate
	for index, raw := range certificate.Certificate {
		parsed, err := x509.ParseCertificate(raw)
		if err != nil {
			return tls.Certificate{}, nil, "", fmt.Errorf("parse TLS certificate %d: %w", index, err)
		}
		if now.Before(parsed.NotBefore) || !now.Before(parsed.NotAfter) {
			return tls.Certificate{}, nil, "", fmt.Errorf("TLS certificate %d is not currently valid", index)
		}
		if index == 0 {
			leaf = parsed
		}
	}

	authorities := []string{
		roles.Authority(hostrole.Control),
		roles.Authority(hostrole.Asset),
		roles.Authority(hostrole.Relay),
		roles.BrowseWildcardAuthority(),
	}
	wildcardName, err := authorityDNSName(roles.BrowseWildcardAuthority())
	if err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("TLS browsing authority: %w", err)
	}
	expected := make(map[string]struct{}, len(authorities))
	for _, authority := range authorities {
		name, err := authorityDNSName(authority)
		if err != nil {
			return tls.Certificate{}, nil, "", fmt.Errorf("TLS authority %q: %w", authority, err)
		}
		expected[name] = struct{}{}
	}
	if len(expected) != 4 || len(leaf.DNSNames) != 4 || len(leaf.IPAddresses) != 0 || len(leaf.EmailAddresses) != 0 || len(leaf.URIs) != 0 {
		return tls.Certificate{}, nil, "", errors.New("TLS SAN set must contain only the four role DNS names")
	}
	seen := make(map[string]struct{}, len(leaf.DNSNames))
	wildcards := 0
	for _, name := range leaf.DNSNames {
		if name != strings.ToLower(name) {
			return tls.Certificate{}, nil, "", errors.New("TLS DNS SAN names must be lowercase")
		}
		if _, duplicate := seen[name]; duplicate {
			return tls.Certificate{}, nil, "", errors.New("duplicate TLS DNS SAN")
		}
		seen[name] = struct{}{}
		if _, ok := expected[name]; !ok {
			return tls.Certificate{}, nil, "", fmt.Errorf("unexpected TLS DNS SAN %q", name)
		}
		if strings.Contains(name, "*") {
			wildcards++
			if name != wildcardName || strings.Count(name, "*") != 1 {
				return tls.Certificate{}, nil, "", errors.New("TLS browsing wildcard SAN is not exact")
			}
		}
	}
	if wildcards != 1 {
		return tls.Certificate{}, nil, "", errors.New("TLS SAN set must contain exactly one browsing wildcard")
	}
	for name := range expected {
		if _, ok := seen[name]; !ok {
			return tls.Certificate{}, nil, "", fmt.Errorf("missing TLS DNS SAN %q", name)
		}
	}
	for _, role := range []hostrole.Role{hostrole.Control, hostrole.Asset, hostrole.Relay} {
		name, _ := authorityDNSName(roles.Authority(role))
		if err := leaf.VerifyHostname(name); err != nil {
			return tls.Certificate{}, nil, "", fmt.Errorf("TLS SAN does not cover %q: %w", name, err)
		}
	}
	browseProbe := strings.Replace(wildcardName, "*", "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1)
	if err := leaf.VerifyHostname(browseProbe); err != nil {
		return tls.Certificate{}, nil, "", fmt.Errorf("TLS SAN does not cover browsing host: %w", err)
	}

	certificate.Leaf = leaf
	digest := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return certificate, leaf, hex.EncodeToString(digest[:]), nil
}

func verifyTLSReadiness(cfg config, roles *hostrole.Classifier, spkiDigest string, now time.Time) (bool, error) {
	if cfg.TLSReadiness == "" && cfg.TLSReadinessSignatures == "" {
		return false, nil
	}
	if cfg.TLSReadiness == "" || cfg.TLSReadinessSignatures == "" {
		return false, errors.New("TLS readiness document and signatures must be configured together")
	}
	protocolDirectory := filepath.Dir(cfg.ReleaseSigningKeys)
	verify := release.VerifyProductionFilesWithSchemas
	if cfg.DevelopmentMode {
		verify = release.VerifyDevelopmentFilesWithSchemas
	}
	if err := verify(
		cfg.TLSReadiness,
		filepath.Join(protocolDirectory, "tls-readiness.schema.json"),
		cfg.ReleaseSigningKeys,
		filepath.Join(protocolDirectory, "release-signing-keys.schema.json"),
		cfg.TLSReadinessSignatures,
		filepath.Join(protocolDirectory, "release-signature.schema.json"),
	); err != nil {
		return false, fmt.Errorf("verify TLS readiness signature: %w", err)
	}
	data, err := os.ReadFile(cfg.TLSReadiness)
	if err != nil {
		return false, err
	}
	var readiness tlsReadiness
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&readiness); err != nil {
		return false, fmt.Errorf("decode TLS readiness: %w", err)
	}
	keysData, err := os.ReadFile(cfg.ReleaseSigningKeys)
	if err != nil {
		return false, err
	}
	var keys release.KeySet
	if err := json.Unmarshal(keysData, &keys); err != nil {
		return false, fmt.Errorf("decode TLS readiness key set: %w", err)
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, readiness.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, readiness.ExpiresAt)
	if readiness.SchemaVersion != 1 || readiness.KeyEpoch != keys.KeyEpoch || issuedErr != nil || expiresErr != nil ||
		now.Before(issuedAt) || !now.Before(expiresAt) || !issuedAt.Before(expiresAt) ||
		!readiness.ControlReady || !readiness.AssetReady || !readiness.RelayReady || !readiness.BrowseReady ||
		readiness.ControlAuthority != roles.Authority(hostrole.Control) ||
		readiness.AssetAuthority != roles.Authority(hostrole.Asset) ||
		readiness.RelayAuthority != roles.Authority(hostrole.Relay) ||
		readiness.BrowseWildcardAuthority != roles.BrowseWildcardAuthority() ||
		readiness.CertificateSPKISHA256 != spkiDigest {
		return false, errors.New("TLS readiness tuple does not match the active roles and certificate")
	}
	return true, nil
}

type httpsRedirectHandler struct {
	roles *hostrole.Classifier
}

func (h httpsRedirectHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	authority, ok := h.roles.HTTPSRedirectAuthority(r.Host)
	if !ok {
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		return
	}
	http.Redirect(w, r, "https://"+authority+r.URL.RequestURI(), http.StatusPermanentRedirect)
}

func hardenedHTTPServer(address string, handler http.Handler, errorLog *log.Logger) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ErrorLog:          errorLog,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
}

func serveHTTPAndHTTPS(cfg config, app *server) error {
	now := time.Now().UTC()
	certificate, _, spkiDigest, err := loadValidatedTLSCertificate(cfg, app.roles, now)
	if err != nil {
		return err
	}
	app.hstsIncludeSubDomains, err = verifyTLSReadiness(cfg, app.roles, spkiDigest, now)
	if err != nil {
		return err
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}

	httpsListener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	httpListener, err := net.Listen("tcp", cfg.HTTPListen)
	if err != nil {
		_ = httpsListener.Close()
		return err
	}
	httpsServer := hardenedHTTPServer(cfg.Listen, app, app.logger.HTTPErrorLog())
	httpsServer.TLSConfig = tlsConfig
	httpServer := hardenedHTTPServer(cfg.HTTPListen, httpsRedirectHandler{roles: app.roles}, app.logger.HTTPErrorLog())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errorsChannel := make(chan error, 2)
	go func() { errorsChannel <- httpsServer.Serve(tls.NewListener(httpsListener, tlsConfig)) }()
	go func() { errorsChannel <- httpServer.Serve(httpListener) }()

	err = nil
	select {
	case <-ctx.Done():
	case err = <-errorsChannel:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	_ = httpsServer.Shutdown(shutdownCtx)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

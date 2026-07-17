package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xtaci/smux"
	"golang.org/x/crypto/hkdf"

	"github.com/gosuda/zeroproxy/internal/diagnostics"
	"github.com/gosuda/zeroproxy/internal/errorauthority"
	"github.com/gosuda/zeroproxy/internal/hostrole"
	"github.com/gosuda/zeroproxy/internal/relayauth"
	"github.com/gosuda/zeroproxy/internal/relayprofile"
	"github.com/gosuda/zeroproxy/internal/release"
	"github.com/gosuda/zeroproxy/internal/socks5"
	"github.com/gosuda/zeroproxy/internal/wsconn"
)

type capabilityConfig struct {
	ID, VerifierKey, ExpiresAt, RelayProfileDigest string
	Epoch                                          uint64
	MaxSessions, MaxStreams                        uint32
	UploadByteBudget, DownloadByteBudget           uint64
	MaxFrameBytes, MaxMessageBytes                 uint32
	MaxFramesPerSecond                             uint32
	HandshakeTimeoutMS, IdleTimeoutMS              uint32
	SessionDeadlineMS                              uint32
	Origins                                        []string
}
type config struct {
	Listen, HTTPListen, TLSCert, TLSKey, ControlHost, AssetHost, RelayHost, BrowseDomain, TorSOCKS, StaticDir, BuildTreeSHA256 string
	DeploymentSalt, ReplayLedgerPath, RelayProfile, RelayProfileSignatures                                                     string
	ReleaseSigningKeys, MigrationDisposition, MigrationSignatures, CompatibilityDeltas, CompatibilitySignatures                string
	TLSReadiness, TLSReadinessSignatures                                                                                       string
	DevelopmentMode                                                                                                            bool
	AllowAnonymousCapabilities                                                                                                 bool
	Capabilities                                                                                                               []capabilityConfig
}

type server struct {
	roles                       *hostrole.Classifier
	capabilities                *relayauth.MemoryCapabilityStore
	torSOCKS, staticDir         string
	controlHost, browseDomain   string
	buildTreeSHA256             string
	allowedTargetPorts          map[uint16]struct{}
	relayPublicURL, relayOrigin string
	deploymentID                string
	relayProfile                relayprofile.Verified
	deploymentSalt              [32]byte
	developmentMode             bool
	hstsIncludeSubDomains       bool
	allowAnonymousCapabilities  bool
	issueMu                     sync.Mutex
	issueTimes                  map[string][]time.Time
	upgrader                    websocket.Upgrader
	logger                      *diagnostics.Logger
}

func loadConfig(path string) (config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return config{}, err
	}
	return decodeConfig(data)
}

func decodeConfig(data []byte) (config, error) {
	var cfg config
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return config{}, err
	}
	if !completeConfig(cfg) {
		return config{}, errors.New("incomplete server config")
	}
	return cfg, nil
}

func completeConfig(cfg config) bool {
	return cfg.Listen != "" &&
		cfg.HTTPListen != "" &&
		cfg.TLSCert != "" &&
		cfg.TLSKey != "" &&
		cfg.TorSOCKS != "" &&
		cfg.StaticDir != "" &&
		cfg.DeploymentSalt != "" &&
		cfg.ReplayLedgerPath != "" &&
		cfg.RelayProfile != "" &&
		cfg.RelayProfileSignatures != "" &&
		cfg.ReleaseSigningKeys != "" &&
		(cfg.TLSReadiness == "") == (cfg.TLSReadinessSignatures == "") &&
		validBuildTreeDigest(cfg.BuildTreeSHA256)
}

func validBuildTreeDigest(digest string) bool {
	return len(digest) == 64 && strings.Trim(digest, "0123456789abcdef") == ""
}

func deriveSessionBindingDigest(verifier [32]byte, deploymentID, capabilityID string, origins []string) [32]byte {
	sorted := append([]string(nil), origins...)
	sort.Strings(sorted)
	mac := hmac.New(sha256.New, verifier[:])
	mac.Write([]byte("zeroproxy-session-binding-v2\x00"))
	mac.Write([]byte(deploymentID))
	mac.Write([]byte{0})
	mac.Write([]byte(capabilityID))
	for _, origin := range sorted {
		mac.Write([]byte{0})
		mac.Write([]byte(origin))
	}
	var digest [32]byte
	copy(digest[:], mac.Sum(nil))
	return digest
}

func configuredLimits(entry capabilityConfig) relayauth.Limits {
	return relayauth.Limits{
		MaxStreams: entry.MaxStreams, UploadByteBudget: entry.UploadByteBudget,
		DownloadByteBudget: entry.DownloadByteBudget, MaxFrameBytes: entry.MaxFrameBytes,
		MaxMessageBytes: entry.MaxMessageBytes, MaxFramesPerSecond: entry.MaxFramesPerSecond,
		HandshakeTimeoutMS: entry.HandshakeTimeoutMS, IdleTimeoutMS: entry.IdleTimeoutMS,
		SessionDeadlineMS: entry.SessionDeadlineMS,
	}
}
func carrierLimits(profile relayprofile.Limits) relayauth.Limits {
	return relayauth.Limits{
		MaxStreams: profile.MaxStreams, UploadByteBudget: profile.UploadByteBudget,
		DownloadByteBudget: profile.DownloadByteBudget, MaxFrameBytes: profile.MaxFrameBytes,
		MaxMessageBytes: profile.MaxMessageBytes, MaxFramesPerSecond: profile.MaxFramesPerSecond,
		HandshakeTimeoutMS: profile.HandshakeTimeoutMS, IdleTimeoutMS: profile.IdleTimeoutMS,
		SessionDeadlineMS: profile.SessionDeadlineMS,
	}
}

func limitsWithinProfile(entry capabilityConfig, profile relayprofile.Limits) bool {
	limits := configuredLimits(entry)
	return entry.MaxSessions > 0 && entry.MaxSessions <= profile.MaxSessions &&
		limits.MaxStreams <= profile.MaxStreams &&
		limits.UploadByteBudget <= profile.UploadByteBudget &&
		limits.DownloadByteBudget <= profile.DownloadByteBudget &&
		limits.MaxFrameBytes <= profile.MaxFrameBytes &&
		limits.MaxMessageBytes <= profile.MaxMessageBytes &&
		limits.MaxFramesPerSecond <= profile.MaxFramesPerSecond &&
		limits.HandshakeTimeoutMS <= profile.HandshakeTimeoutMS &&
		limits.IdleTimeoutMS <= profile.IdleTimeoutMS &&
		limits.SessionDeadlineMS <= profile.SessionDeadlineMS
}

func capabilityStore(entries []capabilityConfig, ledger relayauth.ReplayLedger, profile relayprofile.Verified) (*relayauth.MemoryCapabilityStore, error) {
	store := relayauth.NewCapabilityStore(ledger)
	profileExpiry, err := time.Parse(time.RFC3339, profile.Profile.ExpiresAt)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.RelayProfileDigest != profile.DigestBase64URL() || !limitsWithinProfile(entry, profile.Profile.Limits) {
			return nil, errors.New("capability exceeds or mismatches relay profile")
		}
		raw, err := base64.RawURLEncoding.DecodeString(entry.VerifierKey)
		if err != nil || len(raw) != 32 {
			return nil, errors.New("invalid verifier key")
		}
		expiry, err := time.Parse(time.RFC3339, entry.ExpiresAt)
		if err != nil || expiry.After(profileExpiry) {
			return nil, errors.New("capability expiry exceeds relay profile")
		}
		var key [32]byte
		copy(key[:], raw)
		claims := relayauth.Claims{
			CapabilityID: entry.ID, DeploymentID: profile.Profile.DeploymentID,
			SessionBindingDigest: deriveSessionBindingDigest(key, profile.Profile.DeploymentID, entry.ID, entry.Origins),
			VerifierKey:          key, ExpiresAt: expiry, Epoch: entry.Epoch, Limits: configuredLimits(entry),
			RelayProfileDigest: profile.Digest, AllowedOrigins: entry.Origins, MaxSessions: entry.MaxSessions,
		}
		if err := store.Install(claims); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func (s *server) admitCapability(remote string, now time.Time) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	s.issueMu.Lock()
	defer s.issueMu.Unlock()
	if len(s.issueTimes) >= 4096 {
		if _, exists := s.issueTimes[host]; !exists {
			return false
		}
	}
	cutoff := now.Add(-time.Minute)
	recent := s.issueTimes[host][:0]
	for _, issued := range s.issueTimes[host] {
		if issued.After(cutoff) {
			recent = append(recent, issued)
		}
	}
	if len(recent) >= 10 {
		s.issueTimes[host] = recent
		return false
	}
	s.issueTimes[host] = append(recent, now)
	return true
}
func (s *server) issueCapability(w http.ResponseWriter, r *http.Request) {
	if !s.acceptsCapabilityRequest(r) || !s.admitCapability(r.RemoteAddr, time.Now()) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	origin, err := s.capabilityRequestOrigin(r)
	if err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	id, secret, claims, expires, err := s.issueAnonymousCapability(origin)
	if err != nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	s.writeCapability(w, id, secret, claims, expires)
}

func (s *server) acceptsCapabilityRequest(r *http.Request) bool {
	return s.allowAnonymousCapabilities &&
		r.Method == http.MethodPost &&
		r.Header.Get("Origin") == "https://"+s.controlHost &&
		strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
}

func (s *server) capabilityRequestOrigin(r *http.Request) (string, error) {
	var input struct {
		Origin             string `json:"origin"`
		RelayProfileDigest string `json:"relay_profile_digest"`
		ApprovedVisibility bool   `json:"approved_visibility"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1025))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return "", errors.New("invalid capability request")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return "", errors.New("invalid capability request")
	}
	installedDigest := s.relayProfile.DigestBase64URL()
	if !input.ApprovedVisibility || input.RelayProfileDigest != installedDigest ||
		!s.roles.AllowedBrowseOrigin(input.Origin) {
		return "", errors.New("invalid capability request")
	}
	return input.Origin, nil
}

func (s *server) defaultCarrierLimits() relayauth.Limits {
	return carrierLimits(s.relayProfile.Profile.Limits)
}

func (s *server) issueAnonymousCapability(origin string) (string, [32]byte, relayauth.Claims, time.Time, error) {
	id, secret, verifier, err := s.newCapabilityMaterial()
	if err != nil {
		return "", [32]byte{}, relayauth.Claims{}, time.Time{}, err
	}
	now := time.Now()
	profileExpires, err := time.Parse(time.RFC3339, s.relayProfile.Profile.ExpiresAt)
	if err != nil || !now.Before(profileExpires) {
		return "", [32]byte{}, relayauth.Claims{}, time.Time{}, errors.New("relay profile expired")
	}
	expires := now.Add(15 * time.Minute)
	if profileExpires.Before(expires) {
		expires = profileExpires
	}
	claims, err := s.capabilities.InstallAndGet(relayauth.Claims{
		CapabilityID: id, DeploymentID: s.deploymentID,
		SessionBindingDigest: deriveSessionBindingDigest(verifier, s.deploymentID, id, []string{origin}),
		VerifierKey:          verifier, ExpiresAt: expires, Epoch: 1, Limits: s.defaultCarrierLimits(),
		RelayProfileDigest: s.relayProfile.Digest, AllowedOrigins: []string{origin}, MaxSessions: s.relayProfile.Profile.Limits.MaxSessions,
	})
	if err != nil {
		return "", [32]byte{}, relayauth.Claims{}, time.Time{}, err
	}
	return id, secret, claims, expires, nil
}

func (s *server) newCapabilityMaterial() (string, [32]byte, [32]byte, error) {
	var secret, verifier [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", secret, verifier, err
	}
	reader := hkdf.New(sha256.New, secret[:], s.deploymentSalt[:], []byte("zeroproxy-carrier-v2"))
	if _, err := io.ReadFull(reader, verifier[:]); err != nil {
		return "", secret, verifier, err
	}
	var idBytes [24]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return "", secret, verifier, err
	}
	return base64.RawURLEncoding.EncodeToString(idBytes[:]), secret, verifier, nil
}

func (s *server) writeCapability(w http.ResponseWriter, id string, secret [32]byte, claims relayauth.Claims, expires time.Time) {
	ports := append([]uint16(nil), s.relayProfile.Profile.AllowedTargetPorts...)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"capability_id":        id,
		"capability_secret":    base64.RawURLEncoding.EncodeToString(secret[:]),
		"deployment_salt":      base64.RawURLEncoding.EncodeToString(s.deploymentSalt[:]),
		"claims_digest":        base64.RawURLEncoding.EncodeToString(claims.Digest[:]),
		"capability_epoch":     claims.Epoch,
		"expires_at":           expires.Format(time.RFC3339),
		"relay_url":            s.relayPublicURL,
		"relay_profile_digest": s.relayProfile.DigestBase64URL(),
		"allowed_target_ports": ports,
	})
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	role := s.roles.Classify(r.Host)
	switch role {
	case hostrole.Relay:
		s.securityHeaders(w)
		if r.URL.Path != "/_zp/carrier" {
			http.NotFound(w, r)
			return
		}
		s.handleCarrier(w, r)
	case hostrole.Control:
		s.serveControl(w, r)
	case hostrole.Asset:
		s.serveAsset(w, r)
	case hostrole.Browse:
		s.serveBrowse(w, r)
	default:
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
	}
}
func (s *server) securityHeaders(w http.ResponseWriter) {
	hsts := "max-age=31536000"
	if s.hstsIncludeSubDomains {
		hsts += "; includeSubDomains"
	}
	w.Header().Set("Strict-Transport-Security", hsts)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Origin-Agent-Cluster", "?1")
}
func (s *server) serveControlEndpoint(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/_zp/version.json":
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.staticDir, "_zp", "version.json"))
	case "/control/build-proof.json":
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"build_tree_sha256": s.buildTreeSHA256})
	case "/control/capability":
		s.issueCapability(w, r)
	case "/control/config.json":
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"browse_domain":                   s.browseDomain,
			"development_mode":                s.developmentMode,
			"installed_relay_profile_digests": []string{s.relayProfile.DigestBase64URL()},
			"release_signing_keys":            s.relayProfile.Keys,
			"address_policy":                  s.relayProfile.AddressPolicy,
			"address_policy_signatures":       s.relayProfile.AddressPolicySignatures,
			"relay_profiles": []map[string]any{{
				"digest":     s.relayProfile.DigestBase64URL(),
				"profile":    s.relayProfile.Profile,
				"signatures": s.relayProfile.Signatures,
			}},
		})
	default:
		if !strings.HasPrefix(r.URL.Path, "/_zp/assets/") {
			return false
		}
		s.serveAsset(w, r)
	}
	return true
}

const migrationCSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

var v1ImportSunset = time.Date(2026, time.October, 9, 0, 0, 0, 0, time.UTC)

const sharePathPrefix = "/_zp/s/v2/"
const maxShareURLBytes = 16 * 1024

func validSharePath(path, rawQuery string) bool {
	if rawQuery != "" || !strings.HasPrefix(path, sharePathPrefix) || len(path) > maxShareURLBytes {
		return false
	}
	encoded := strings.TrimPrefix(path, sharePathPrefix)
	if encoded == "" || strings.Contains(encoded, "/") {
		return false
	}
	envelope, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return err == nil && len(envelope) >= 29
}

func (s *server) serveShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", controlCSP("/control/index.html", "'none'", "https://"+s.roles.BrowseWildcardAuthority()))
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Allow", "GET, HEAD")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !validSharePath(r.URL.Path, r.URL.RawQuery) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.staticDir, "control", "index.html"))
}

func (s *server) serveMigration(w http.ResponseWriter, r *http.Request, now time.Time) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", migrationCSP)
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Allow", "GET, HEAD")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := "migrate-v1.html"
	if !now.Before(v1ImportSunset) {
		name = "migrate-v1-sunset.html"
	}
	http.ServeFile(w, r, filepath.Join(s.staticDir, "control", name))
}

func migrationDecoderPath(path string) bool {
	switch path {
	case "/control/migrate-v1.mjs", "/control/v1-importer.mjs", "/control/import-nonce-store.mjs":
		return true
	default:
		return false
	}
}

func controlCSP(path, frameAncestor, browseFrameSource string) string {
	switch path {
	case "/control/bridge.html":
		return "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors " + frameAncestor
	case "/control/coordinator.mjs":
		return "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
	case "/control/index.html":
		return "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src " + browseFrameSource + "; base-uri 'none'; frame-ancestors 'none'"
	default:
		return "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
	}
}

func (s *server) serveControl(w http.ResponseWriter, r *http.Request) {
	s.serveControlAt(w, r, time.Now())
}

func (s *server) serveControlAt(w http.ResponseWriter, r *http.Request, now time.Time) {
	s.securityHeaders(w)
	if r.URL.Path == "/migrate/v1" {
		s.serveMigration(w, r, now)
		return
	}
	if strings.HasPrefix(r.URL.Path, sharePathPrefix) {
		s.serveShare(w, r)
		return
	}
	if !now.Before(v1ImportSunset) && migrationDecoderPath(r.URL.Path) {
		http.NotFound(w, r)
		return
	}
	if s.serveControlEndpoint(w, r) {
		return
	}
	path := filepath.Clean(r.URL.Path)
	if path == "/" {
		path = "/control/index.html"
	}
	frameAncestor := "https://" + s.roles.BrowseWildcardAuthority()
	browseFrameSource := "https://" + s.roles.BrowseWildcardAuthority()
	w.Header().Set("Content-Security-Policy", controlCSP(path, frameAncestor, browseFrameSource))
	if path == "/control/index.html" {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	}
	if !strings.HasPrefix(path, "/control/") && !strings.HasPrefix(path, "/generated/") {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.staticDir, strings.TrimPrefix(path, "/")))
}
func (s *server) serveAsset(w http.ResponseWriter, r *http.Request) {
	s.securityHeaders(w)
	trimmed := strings.TrimPrefix(r.URL.Path, "/_zp/assets/")
	parts := strings.Split(trimmed, "/")
	assetPath, valid := assetFilePath(s.staticDir, parts)
	if !valid {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if strings.HasSuffix(r.URL.Path, ".wasm") {
		w.Header().Set("Content-Type", "application/wasm")
	}
	http.ServeFile(w, r, assetPath)
}

func assetFilePath(staticDir string, parts []string) (string, bool) {
	if len(parts) < 2 || len(parts[0]) != 64 || strings.Trim(parts[0], "0123456789abcdef") != "" {
		return "", false
	}
	relative := strings.Join(parts[1:], "/")
	if !fs.ValidPath(relative) || strings.Contains(relative, `\`) {
		return "", false
	}
	local, err := filepath.Localize(relative)
	if err != nil {
		return "", false
	}
	return filepath.Join(staticDir, "_zp", "assets", parts[0], local), true
}

func trustedBrowseModulePath(staticDir, requestPath string) (string, bool) {
	relative := strings.TrimPrefix(requestPath, "/")
	if (!strings.HasPrefix(relative, "generated/") && !strings.HasPrefix(relative, "runtime/")) ||
		!fs.ValidPath(relative) || strings.Contains(relative, `\`) {
		return "", false
	}
	local, err := filepath.Localize(relative)
	if err != nil {
		return "", false
	}
	return filepath.Join(staticDir, local), true
}
func (s *server) serveBrowse(w http.ResponseWriter, r *http.Request) {
	s.securityHeaders(w)
	if r.URL.Path == "/_zp/sw.js" {
		w.Header().Set("Service-Worker-Allowed", "/")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.staticDir, "_zp", "sw.js"))
		return
	}
	if strings.HasPrefix(r.URL.Path, "/_zp/assets/") {
		s.serveAsset(w, r)
		return
	}
	if r.URL.Path == "/_zp/version.json" {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.staticDir, "_zp", "version.json"))
		return
	}
	if r.URL.Path == "/_zp/config" {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"control_host":  s.controlHost,
			"browse_domain": s.browseDomain,
		})
		return
	}
	if r.URL.Path == "/_zp/target-worker-host" {
		if r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://"+s.controlHost)
		http.ServeFile(w, r, filepath.Join(s.staticDir, "target-worker-host.html"))
		return
	}
	if r.URL.Path == "/_zp/target-worker-host.mjs" {
		if r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		http.ServeFile(w, r, filepath.Join(s.staticDir, "target-worker-host.mjs"))
		return
	}
	if r.URL.Path == "/bootstrap.mjs" {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.staticDir, "bootstrap.mjs"))
		return
	}
	if modulePath, valid := trustedBrowseModulePath(s.staticDir, r.URL.Path); valid {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, modulePath)
		return
	}
	if r.URL.Path != "/" && r.URL.Path != "/_zp/bootstrap" {
		http.Error(w, "service worker control required", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	csp := "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' " + s.relayOrigin + "; frame-src https://" + s.controlHost + " https://" + s.roles.BrowseWildcardAuthority() + "; base-uri 'none'; object-src 'none'"
	w.Header().Set("Content-Security-Policy", csp)
	http.ServeFile(w, r, filepath.Join(s.staticDir, "bootstrap.html"))
}

func (s *server) handleCarrier(w http.ResponseWriter, r *http.Request) {
	origin, message, status := s.carrierRequestOrigin(r)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() {
		if err := ws.Close(); err != nil {
			s.logger.DebugFailure("carrier_websocket_close", errorauthority.CodeServerCloseFailed, errorauthority.StageWebsocket, err)
		}
	}()
	ws.SetReadLimit(relayauth.MaxHandshakeFrameBytes)
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	session := relayauth.NewSession(origin, s.capabilities)
	defer session.Close()
	authenticated, err := s.authenticateCarrier(ws, session)
	if err != nil {
		return
	}
	uploadBudget, downloadBudget, err := remainingCarrierBudgets(authenticated)
	if err != nil {
		return
	}
	_ = ws.SetReadDeadline(session.CarrierDeadline())
	_ = ws.SetWriteDeadline(session.CarrierDeadline())
	ws.SetReadLimit(int64(authenticated.accept.NegotiatedLimits.MaxMessageBytes))
	s.serveCarrierMux(r.Context(), ws, authenticated.accept, uploadBudget, downloadBudget, session.CarrierDeadline())
}

func (s *server) carrierRequestOrigin(r *http.Request) (string, string, int) {
	if r.URL.RawQuery != "" {
		return "", "credential-free carrier path required", http.StatusBadRequest
	}
	origin := r.Header.Get("Origin")
	if !s.roles.AllowedBrowseOrigin(origin) {
		return "", "forbidden", http.StatusForbidden
	}
	protocols := websocket.Subprotocols(r)
	if len(protocols) != 1 || protocols[0] != relayauth.Protocol {
		return "", "exact subprotocol required", http.StatusBadRequest
	}
	return origin, "", 0
}

type authenticatedCarrier struct {
	accept        relayauth.ServerAccept
	uploadBytes   uint64
	downloadBytes uint64
}

func canonicalFrameBytes(value any) (uint64, error) {
	encoded, err := relayauth.Marshal(value)
	return uint64(len(encoded)), err
}

func (s *server) authenticateCarrier(ws *websocket.Conn, session *relayauth.Session) (authenticatedCarrier, error) {
	var result authenticatedCarrier
	var init relayauth.ClientInit
	if err := readAuthFrame(ws, &init); err != nil {
		return result, err
	}
	size, err := canonicalFrameBytes(init)
	if err != nil {
		return result, err
	}
	result.uploadBytes += size
	challenge, err := session.Begin(init)
	if err != nil {
		return result, err
	}
	if err := ws.SetReadDeadline(session.HandshakeDeadline()); err != nil {
		return result, err
	}
	if err := ws.SetWriteDeadline(session.HandshakeDeadline()); err != nil {
		return result, err
	}
	if err := writeAuthFrame(ws, challenge); err != nil {
		return result, err
	}
	size, err = canonicalFrameBytes(challenge)
	if err != nil {
		return result, err
	}
	result.downloadBytes += size
	var auth relayauth.ClientAuth
	if err := readAuthFrame(ws, &auth); err != nil {
		return result, err
	}
	size, err = canonicalFrameBytes(auth)
	if err != nil {
		return result, err
	}
	result.uploadBytes += size
	result.accept, err = session.Finish(auth)
	if err != nil {
		return result, err
	}
	if err := writeAuthFrame(ws, result.accept); err != nil {
		return result, err
	}
	size, err = canonicalFrameBytes(result.accept)
	if err != nil {
		return result, err
	}
	result.downloadBytes += size
	return result, nil
}

func remainingCarrierBudgets(authenticated authenticatedCarrier) (uint64, uint64, error) {
	limits := authenticated.accept.NegotiatedLimits
	if authenticated.uploadBytes >= limits.UploadByteBudget || authenticated.downloadBytes >= limits.DownloadByteBudget {
		return 0, 0, relayauth.ErrProtocol
	}
	return limits.UploadByteBudget - authenticated.uploadBytes, limits.DownloadByteBudget - authenticated.downloadBytes, nil
}

func (s *server) serveCarrierMux(ctx context.Context, ws *websocket.Conn, accept relayauth.ServerAccept, uploadBudget, downloadBudget uint64, sessionDeadline time.Time) {
	limits := accept.NegotiatedLimits
	carrier := wsconn.New(ws, int64(limits.MaxMessageBytes), uploadBudget, downloadBudget, limits.MaxFramesPerSecond, time.Duration(limits.IdleTimeoutMS)*time.Millisecond, sessionDeadline)
	mux, err := smux.Server(carrier, smux.DefaultConfig())
	if err != nil {
		return
	}
	defer func() {
		if err := mux.Close(); err != nil {
			s.logger.DebugFailure("carrier_multiplexer_close", errorauthority.CodeServerCloseFailed, errorauthority.StageSmux, err)
		}
	}()
	s.serveMux(ctx, mux, accept.NegotiatedLimits.MaxStreams)
}
func contains(values []string, want string) bool {
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if strings.TrimSpace(part) == want {
				return true
			}
		}
	}
	return false
}
func readAuthFrame(ws *websocket.Conn, dst any) error {
	kind, data, err := ws.ReadMessage()
	if err != nil {
		return err
	}
	if kind != websocket.BinaryMessage {
		return relayauth.ErrProtocol
	}
	return relayauth.Unmarshal(data, dst)
}
func writeAuthFrame(ws *websocket.Conn, value any) error {
	data, err := relayauth.Marshal(value)
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.BinaryMessage, data)
}
func (s *server) serveMux(ctx context.Context, mux *smux.Session, max uint32) {
	sem := make(chan struct{}, max)
	for {
		stream, err := mux.AcceptStream()
		if err != nil {
			return
		}
		select {
		case sem <- struct{}{}:
			go func() { defer func() { <-sem }(); s.bridgeSOCKS(ctx, stream) }()
		default:
			_ = stream.Close()
		}
	}
}
func (s *server) bridgeSOCKS(ctx context.Context, stream *smux.Stream) {
	defer func() {
		if err := stream.Close(); err != nil {
			s.logger.DebugFailure("socks_stream_close", errorauthority.CodeServerCloseFailed, errorauthority.StageSocks, err)
		}
	}()
	request, err := socks5.ReadConnectWithPolicy(stream, func(_ string, port uint16) bool { _, ok := s.allowedTargetPorts[port]; return ok })
	if err != nil {
		_ = socks5.Reply(stream, 1)
		return
	}
	dialer := net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", s.torSOCKS)
	if err != nil {
		_ = socks5.Reply(stream, 1)
		return
	}
	defer func() {
		if err := conn.Close(); err != nil {
			s.logger.DebugFailure("tor_socks_connection_close", errorauthority.CodeServerCloseFailed, errorauthority.StageSocks, err)
		}
	}()
	if err := socks5.Connect(conn, request.Host, request.Port, request.Credentials); err != nil {
		_ = socks5.Reply(stream, 5)
		return
	}
	if err := socks5.Reply(stream, 0); err != nil {
		return
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Minute))
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(conn, stream)
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() { _, _ = io.Copy(stream, conn); _ = stream.Close(); done <- struct{}{} }()
	<-done
}

func verifyReleaseConfig(cfg config) error {
	paths := []string{cfg.ReleaseSigningKeys, cfg.MigrationDisposition, cfg.MigrationSignatures, cfg.CompatibilityDeltas, cfg.CompatibilitySignatures}
	for _, path := range paths {
		if path == "" {
			return errors.New("release verification paths are required")
		}
	}
	verify := release.VerifyProductionFiles
	if cfg.DevelopmentMode {
		verify = release.VerifyDevelopmentFiles
	} else {
		if cfg.AllowAnonymousCapabilities {
			return errors.New("anonymous capability issuance is forbidden in production")
		}
		if cfg.TorSOCKS == "" {
			return errors.New("tor SOCKS is required in production")
		}
	}
	if err := verify(cfg.MigrationDisposition, cfg.ReleaseSigningKeys, cfg.MigrationSignatures); err != nil {
		return fmt.Errorf("migration disposition: %w", err)
	}
	if err := verify(cfg.CompatibilityDeltas, cfg.ReleaseSigningKeys, cfg.CompatibilitySignatures); err != nil {
		return fmt.Errorf("compatibility deltas: %w", err)
	}
	return nil
}

func main() {
	configPath := flag.String("config", "", "server config JSON")
	flag.Parse()
	logger := diagnostics.NewLogger(slog.Default())
	if *configPath == "" {
		logger.ErrorFailure("config_required", errorauthority.CodeServerFailed, errorauthority.StageBootstrap, nil)
		os.Exit(2)
	}
	if err := runServer(*configPath); err != nil {
		logger.ErrorFailure("server_failed", errorauthority.CodeServerFailed, errorauthority.StageBootstrap, err)
		if os.Getenv("ZEROPROXY_DEVELOPMENT_DIAGNOSTICS") == "1" {
			_, _ = fmt.Fprintf(os.Stderr, "development startup detail: %v\n", err)
		}
		os.Exit(1)
	}
}

func runServer(configPath string) error {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if err := verifyReleaseConfig(cfg); err != nil {
		return fmt.Errorf("verify release: %w", err)
	}
	app, err := newServer(cfg)
	if err != nil {
		return err
	}
	return serveHTTPS(cfg, app)
}

func configuredRelayProfile(cfg config) (relayprofile.Verified, error) {
	protocolDirectory := filepath.Dir(cfg.ReleaseSigningKeys)
	return relayprofile.Load(relayprofile.Paths{
		Profile:                 cfg.RelayProfile,
		Schema:                  filepath.Join(protocolDirectory, "relay-profile.schema.json"),
		Keys:                    cfg.ReleaseSigningKeys,
		KeysSchema:              filepath.Join(protocolDirectory, "release-signing-keys.schema.json"),
		Signatures:              cfg.RelayProfileSignatures,
		SignatureSchema:         filepath.Join(protocolDirectory, "release-signature.schema.json"),
		AddressPolicy:           filepath.Join(protocolDirectory, "address-policy.json"),
		AddressPolicySchema:     filepath.Join(protocolDirectory, "address-policy.schema.json"),
		AddressPolicySignatures: filepath.Join(protocolDirectory, "address-policy.sig"),
	}, cfg.DevelopmentMode, time.Now().UTC())
}

func newServer(cfg config) (*server, error) {
	profile, err := configuredRelayProfile(cfg)
	if err != nil {
		return nil, fmt.Errorf("relay profile: %w", err)
	}
	roles, err := hostrole.New(cfg.ControlHost, cfg.AssetHost, cfg.RelayHost, cfg.BrowseDomain)
	if err != nil {
		return nil, fmt.Errorf("host roles: %w", err)
	}
	deploymentSalt, err := issuerMaterial(cfg, profile, roles)
	if err != nil {
		return nil, err
	}
	allowedPorts, err := allowedTargetPortSet(profile.Profile.AllowedTargetPorts)
	if err != nil {
		return nil, err
	}
	ledger, err := relayauth.NewFileReplayLedger(cfg.ReplayLedgerPath)
	if err != nil {
		return nil, fmt.Errorf("replay ledger: %w", err)
	}
	caps, err := capabilityStore(cfg.Capabilities, ledger, profile)
	if err != nil {
		return nil, fmt.Errorf("capabilities: %w", err)
	}
	return &server{
		roles:                      roles,
		capabilities:               caps,
		torSOCKS:                   cfg.TorSOCKS,
		staticDir:                  cfg.StaticDir,
		controlHost:                roles.Authority(hostrole.Control),
		buildTreeSHA256:            cfg.BuildTreeSHA256,
		browseDomain:               cfg.BrowseDomain,
		allowedTargetPorts:         allowedPorts,
		relayPublicURL:             profile.RelayURL(),
		relayOrigin:                profile.Profile.RelayWSSOrigin,
		deploymentID:               profile.Profile.DeploymentID,
		relayProfile:               profile,
		deploymentSalt:             deploymentSalt,
		developmentMode:            cfg.DevelopmentMode,
		allowAnonymousCapabilities: cfg.AllowAnonymousCapabilities,
		issueTimes:                 make(map[string][]time.Time),
		logger:                     diagnostics.NewLogger(slog.Default()),
		upgrader:                   newCarrierUpgrader(roles),
	}, nil
}

func allowedTargetPortSet(ports []uint16) (map[uint16]struct{}, error) {
	allowed := make(map[uint16]struct{}, len(ports))
	for _, port := range ports {
		if port == 0 {
			return nil, errors.New("invalid allowed target port")
		}
		allowed[port] = struct{}{}
	}
	return allowed, nil
}

func issuerDigest(value string) ([32]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return [32]byte{}, false
	}
	var digest [32]byte
	copy(digest[:], decoded)
	return digest, true
}

func issuerMaterial(cfg config, profile relayprofile.Verified, roles *hostrole.Classifier) ([32]byte, error) {
	deploymentSalt, saltOK := issuerDigest(cfg.DeploymentSalt)
	relayURL, err := url.Parse(profile.Profile.RelayWSSOrigin)
	if !saltOK || err != nil || relayURL.Host != roles.Authority(hostrole.Relay) ||
		profile.Profile.AllowedBrowseDomain != cfg.BrowseDomain {
		return [32]byte{}, errors.New("relay profile does not match server authority configuration")
	}
	return deploymentSalt, nil
}

func newCarrierUpgrader(roles *hostrole.Classifier) websocket.Upgrader {
	return websocket.Upgrader{
		HandshakeTimeout:  10 * time.Second,
		EnableCompression: false,
		CheckOrigin: func(r *http.Request) bool {
			return roles.AllowedBrowseOrigin(r.Header.Get("Origin"))
		},
		Subprotocols: []string{relayauth.Protocol},
	}
}

func serveHTTPS(cfg config, app *server) error {
	return serveHTTPAndHTTPS(cfg, app)
}

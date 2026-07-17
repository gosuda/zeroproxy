package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xtaci/smux"
	"golang.org/x/crypto/hkdf"

	"github.com/gosuda/zeroproxy/internal/hostrole"
	"github.com/gosuda/zeroproxy/internal/relayauth"
	"github.com/gosuda/zeroproxy/internal/relayprofile"
	"github.com/gosuda/zeroproxy/internal/socks5"
)

func testServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	for path, body := range map[string]string{
		"control/index.html":             "control",
		"control/bridge.html":            "bridge",
		"control/coordinator.mjs":        "coordinator",
		"control/migrate-v1.html":        "migration-active",
		"control/migrate-v1-sunset.html": "migration-ended",
		"control/migrate-v1.mjs":         "migration-controller",
		"control/v1-importer.mjs":        "migration-decoder",
		"control/import-nonce-store.mjs": "migration-nonce-store",
		"bootstrap.html":                 "bootstrap",
		"bootstrap.mjs":                  "export{}",
		"target-worker-host.html":        "target-worker-host",
		"target-worker-host.mjs":         "target-worker-host-module",
		"_zp/sw.js":                      "import \"/_zp/assets/test/sw/sw.mjs\";",
	} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	roles, err := hostrole.New("control.example", "assets.example", "relay.example", "example")
	if err != nil {
		t.Fatal(err)
	}
	var relayDigest, deploymentSalt [32]byte
	relayDigest[0], deploymentSalt[0] = 1, 1
	profile := relayprofile.Verified{
		Digest: relayDigest,
		Profile: relayprofile.Profile{
			SchemaVersion: 1, ProfileID: "test-relay", DisplayName: "Test relay", DeploymentID: "test-deployment",
			RelayWSSOrigin: "wss://relay.example", CarrierPath: "/_zp/carrier", AllowedBrowseDomain: "example",
			AllowedTargetSchemes: []string{"http", "https"}, AllowedTargetPorts: []uint16{443},
			AddressPolicyDigest: strings.Repeat("a", 64), TorMode: "SOCKS5_DOMAIN_RFC1929",
			Limits: relayprofile.Limits{
				MaxSessions: 2, MaxStreams: 64, UploadByteBudget: 1 << 30, DownloadByteBudget: 1 << 30,
				MaxFrameBytes: 64 << 10, MaxMessageBytes: 1 << 20, MaxFramesPerSecond: 1000,
				HandshakeTimeoutMS: 10000, IdleTimeoutMS: 60000, SessionDeadlineMS: 900000,
			},
			PrivacyDisclosure: relayprofile.PrivacyDisclosure,
			IssuedAt:          "2026-07-01T00:00:00Z", ExpiresAt: "2027-01-01T00:00:00Z", KeyEpoch: 1,
		},
	}
	return &server{
		roles:                      roles,
		capabilities:               relayauth.NewMemoryCapabilityStore(),
		staticDir:                  dir,
		controlHost:                "control.example",
		browseDomain:               "example",
		buildTreeSHA256:            strings.Repeat("b", 64),
		allowedTargetPorts:         map[uint16]struct{}{443: {}},
		relayPublicURL:             profile.RelayURL(),
		relayOrigin:                profile.Profile.RelayWSSOrigin,
		deploymentID:               profile.Profile.DeploymentID,
		relayProfile:               profile,
		deploymentSalt:             deploymentSalt,
		allowAnonymousCapabilities: true,
		issueTimes:                 make(map[string][]time.Time),
		upgrader:                   newCarrierUpgrader(roles),
	}
}

func TestV1MigrationWindowIsLocalBoundedAndFailClosed(t *testing.T) {
	s := testServer(t)
	request := func(method, path string) *http.Request {
		r := httptest.NewRequest(method, "https://control.example"+path, nil)
		r.Host = "control.example"
		return r
	}
	beforeSunset := v1ImportSunset.Add(-time.Nanosecond)
	afterSunset := v1ImportSunset

	active := httptest.NewRecorder()
	s.serveControlAt(active, request(http.MethodGet, "/migrate/v1"), beforeSunset)
	if active.Code != http.StatusOK || active.Body.String() != "migration-active" {
		t.Fatalf("active migration response status=%d body=%q", active.Code, active.Body.String())
	}
	for name, want := range map[string]string{
		"Cache-Control":              "no-store",
		"Content-Security-Policy":    migrationCSP,
		"Cross-Origin-Opener-Policy": "same-origin",
		"Referrer-Policy":            "no-referrer",
	} {
		if got := active.Header().Get(name); got != want {
			t.Fatalf("active migration %s=%q, want %q", name, got, want)
		}
	}

	head := httptest.NewRecorder()
	s.serveControlAt(head, request(http.MethodHead, "/migrate/v1"), beforeSunset)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("migration HEAD status=%d body=%q", head.Code, head.Body.String())
	}

	ended := httptest.NewRecorder()
	s.serveControlAt(ended, request(http.MethodGet, "/migrate/v1"), afterSunset)
	if ended.Code != http.StatusOK || ended.Body.String() != "migration-ended" || strings.Contains(ended.Body.String(), "migration-decoder") {
		t.Fatalf("ended migration response status=%d body=%q", ended.Code, ended.Body.String())
	}

	methodRejected := httptest.NewRecorder()
	s.serveControlAt(methodRejected, request(http.MethodPost, "/migrate/v1"), beforeSunset)
	if methodRejected.Code != http.StatusMethodNotAllowed || methodRejected.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("migration method response status=%d allow=%q", methodRejected.Code, methodRejected.Header().Get("Allow"))
	}

	for _, path := range []string{"/control/migrate-v1.mjs", "/control/v1-importer.mjs", "/control/import-nonce-store.mjs"} {
		response := httptest.NewRecorder()
		s.serveControlAt(response, request(http.MethodGet, path), afterSunset)
		if response.Code != http.StatusNotFound {
			t.Fatalf("post-sunset decoder path %q returned %d", path, response.Code)
		}
	}
}

func TestEncryptedShareRouteIsExactAndNoStore(t *testing.T) {
	s := testServer(t)
	envelope := base64.RawURLEncoding.EncodeToString(make([]byte, 29))
	request := func(method, path string) *http.Request {
		r := httptest.NewRequest(method, "https://control.example"+path, nil)
		r.Host = "control.example"
		return r
	}

	response := httptest.NewRecorder()
	s.ServeHTTP(response, request(http.MethodGet, sharePathPrefix+envelope))
	if response.Code != http.StatusOK || response.Body.String() != "control" {
		t.Fatalf("share response status=%d body=%q", response.Code, response.Body.String())
	}
	for name, want := range map[string]string{
		"Cache-Control":              "no-store",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Referrer-Policy":            "no-referrer",
	} {
		if got := response.Header().Get(name); got != want {
			t.Fatalf("share %s=%q, want %q", name, got, want)
		}
	}
	if csp := response.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-src https://*.browse.example") {
		t.Fatalf("share CSP %q does not admit persistent browsing hosts", csp)
	}

	head := httptest.NewRecorder()
	s.ServeHTTP(head, request(http.MethodHead, sharePathPrefix+envelope))
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("share HEAD status=%d body=%q", head.Code, head.Body.String())
	}

	for _, path := range []string{
		sharePathPrefix,
		sharePathPrefix + "AA",
		sharePathPrefix + envelope + "=",
		sharePathPrefix + envelope + "?extra=1",
		sharePathPrefix + envelope + "/extra",
	} {
		rejected := httptest.NewRecorder()
		s.ServeHTTP(rejected, request(http.MethodGet, path))
		if rejected.Code != http.StatusNotFound {
			t.Fatalf("invalid share path %q returned %d", path, rejected.Code)
		}
	}

	methodRejected := httptest.NewRecorder()
	s.ServeHTTP(methodRejected, request(http.MethodPost, sharePathPrefix+envelope))
	if methodRejected.Code != http.StatusMethodNotAllowed {
		t.Fatalf("share POST returned %d", methodRejected.Code)
	}
}

func TestCapabilityIssuanceRequiresExplicitInstalledRelayApproval(t *testing.T) {
	s := testServer(t)
	origin := "https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"
	digest := s.relayProfile.DigestBase64URL()
	for name, body := range map[string]string{
		"approval omitted": `{"origin":"` + origin + `","relay_profile_digest":"` + digest + `"}`,
		"wrong digest":     `{"origin":"` + origin + `","relay_profile_digest":"` + strings.Repeat("B", 43) + `","approved_visibility":true}`,
		"unknown field":    `{"origin":"` + origin + `","relay_profile_digest":"` + digest + `","approved_visibility":true,"extra":true}`,
		"trailing JSON":    `{"origin":"` + origin + `","relay_profile_digest":"` + digest + `","approved_visibility":true}{}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "https://control.example/control/capability", strings.NewReader(body))
			request.Host = "control.example"
			request.Header.Set("Origin", "https://control.example")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			s.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("unapproved capability returned %d", response.Code)
			}
		})
	}
}

func TestControlServesContentHashedCookieCoreAssets(t *testing.T) {
	s := testServer(t)
	hash := strings.Repeat("a", 64)
	asset := filepath.Join(s.staticDir, "_zp", "assets", hash, "cookie_core.wasm")
	if err := os.MkdirAll(filepath.Dir(asset), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("wasm"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://control.example/_zp/assets/"+hash+"/cookie_core.wasm", nil)
	request.Host = "control.example"
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "wasm" {
		t.Fatalf("asset response %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache policy %q", response.Header().Get("Cache-Control"))
	}
	if response.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("asset content type %q", response.Header().Get("Content-Type"))
	}
	nestedAsset := filepath.Join(s.staticDir, "_zp", "assets", hash, "sw", "sw.mjs")
	if err := os.MkdirAll(filepath.Dir(nestedAsset), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedAsset, []byte("service worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "https://control.example/_zp/assets/"+hash+"/sw/sw.mjs", nil)
	request.Host = "control.example"
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "service worker" {
		t.Fatalf("nested asset response %d %q", response.Code, response.Body.String())
	}
	for _, unsafePath := range []string{
		"/_zp/assets/" + hash + "/sw/../secret",
		"/_zp/assets/" + hash + `/..\secret`,
	} {
		request = httptest.NewRequest(http.MethodGet, "https://control.example/", nil)
		request.Host = "control.example"
		request.URL.Path = unsafePath
		response = httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("unsafe asset path %q returned %d", unsafePath, response.Code)
		}
	}
	request = httptest.NewRequest(http.MethodGet, "https://control.example/_zp/assets/not-a-hash/cookie_core.wasm", nil)
	request.Host = "control.example"
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unhashed asset status %d", response.Code)
	}
}
func TestControlBuildProofBindsConfiguredTree(t *testing.T) {
	s := testServer(t)
	request := httptest.NewRequest(http.MethodGet, "https://control.example/control/build-proof.json", nil)
	request.Host = "control.example"
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("build proof response status=%d cache=%q", response.Code, response.Header().Get("Cache-Control"))
	}
	if response.Body.String() != "{\"build_tree_sha256\":\""+s.buildTreeSHA256+"\"}\n" {
		t.Fatalf("build proof body %q", response.Body.String())
	}
}

func TestCoordinatorCSPAllowsWasmWithoutStringEvaluation(t *testing.T) {
	s := testServer(t)
	request := httptest.NewRequest(http.MethodGet, "https://control.example/control/coordinator.mjs", nil)
	request.Host = "control.example"
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	csp := response.Header().Get("Content-Security-Policy")
	if response.Code != http.StatusOK || response.Body.String() != "coordinator" {
		t.Fatalf("coordinator response status=%d body=%q", response.Code, response.Body.String())
	}
	if !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval'") || strings.Contains(csp, "'unsafe-eval'") {
		t.Fatalf("coordinator CSP %q", csp)
	}
	if got := response.Header().Get("Cross-Origin-Opener-Policy"); got != "" {
		t.Fatalf("coordinator module received top-level COOP %q", got)
	}
	request = httptest.NewRequest(http.MethodGet, "https://control.example/", nil)
	request.Host = "control.example"
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	csp = response.Header().Get("Content-Security-Policy")
	if response.Code != http.StatusOK || response.Body.String() != "control" ||
		response.Header().Get("Cross-Origin-Opener-Policy") != "same-origin" ||
		!strings.Contains(csp, "frame-src https://*.browse.example") {
		t.Fatalf("control shell status=%d body=%q COOP=%q CSP=%q", response.Code, response.Body.String(), response.Header().Get("Cross-Origin-Opener-Policy"), csp)
	}
}

func TestRelayIssuerProfileMatchesConfiguredAuthorities(t *testing.T) {
	material := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	profile := testServer(t).relayProfile
	profile.Profile.RelayWSSOrigin = "wss://relay.example:8443"
	cfg := config{BrowseDomain: "example", DeploymentSalt: material}
	roles, err := hostrole.New("control.example:8443", "assets.example:8443", "relay.example:8443", "example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := issuerMaterial(cfg, profile, roles); err != nil {
		t.Fatalf("matching relay profile rejected: %v", err)
	}
	otherRoles, err := hostrole.New("control.example:8443", "assets.example:8443", "other.example:8443", "example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := issuerMaterial(cfg, profile, otherRoles); err == nil {
		t.Fatal("relay host mismatch accepted")
	}
	cfg.BrowseDomain = "other.example"
	if _, err := issuerMaterial(cfg, profile, roles); err == nil {
		t.Fatal("browse domain mismatch accepted")
	}
	cfg.BrowseDomain, cfg.DeploymentSalt = "example", "invalid"
	if _, err := issuerMaterial(cfg, profile, roles); err == nil {
		t.Fatal("invalid deployment salt accepted")
	}
}

func TestCarrierNegotiatesSubprotocolExactlyOnce(t *testing.T) {
	app := testServer(t)
	server := httptest.NewServer(app)
	t.Cleanup(server.Close)
	address := strings.TrimPrefix(server.URL, "http://")
	dialer := websocket.Dialer{
		Subprotocols: []string{relayauth.Protocol},
		NetDialContext: func(_ context.Context, network, _ string) (net.Conn, error) {
			return net.Dial(network, address)
		},
	}
	header := http.Header{"Origin": []string{"https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"}}
	connection, response, err := dialer.Dial("ws://relay.example/_zp/carrier", header)
	if err != nil {
		t.Fatalf("carrier upgrade failed: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	values := response.Header.Values("Sec-WebSocket-Protocol")
	if len(values) != 1 || values[0] != relayauth.Protocol {
		t.Fatalf("carrier subprotocol headers %q", values)
	}
}

func TestCarrierAdmissionRequiresCredentialFreePathAndSoleProtocol(t *testing.T) {
	app := testServer(t)
	origin := "https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"
	for _, testCase := range []struct {
		name      string
		target    string
		protocols string
	}{
		{name: "query credential", target: "https://relay.example/_zp/carrier?token=secret", protocols: relayauth.Protocol},
		{name: "alternate protocol", target: "https://relay.example/_zp/carrier", protocols: relayauth.Protocol + ", ambient.v1"},
		{name: "duplicate protocol", target: "https://relay.example/_zp/carrier", protocols: relayauth.Protocol + ", " + relayauth.Protocol},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, testCase.target, nil)
			request.Header.Set("Origin", origin)
			request.Header.Set("Sec-WebSocket-Protocol", testCase.protocols)
			if _, _, status := app.carrierRequestOrigin(request); status != http.StatusBadRequest {
				t.Fatalf("status = %d", status)
			}
		})
	}
}

func TestServerConfigRejectsUnboundBuildTree(t *testing.T) {
	cfg := config{
		Listen:                 "127.0.0.1:443",
		HTTPListen:             "127.0.0.1:80",
		TLSCert:                "cert.pem",
		TLSKey:                 "key.pem",
		TorSOCKS:               "127.0.0.1:9050",
		StaticDir:              "dist/web",
		BuildTreeSHA256:        strings.Repeat("a", 64),
		DeploymentSalt:         "salt",
		ReplayLedgerPath:       "/var/lib/zeroproxy/replay.json",
		RelayProfile:           "relay.json",
		RelayProfileSignatures: "relay.sig",
		ReleaseSigningKeys:     "keys.json",
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeConfig(encoded); err != nil {
		t.Fatalf("valid build binding rejected: %v", err)
	}
	cfg.TLSReadiness = "tls-readiness.json"
	encoded, err = json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeConfig(encoded); err == nil {
		t.Fatal("unpaired TLS readiness document accepted")
	}
	cfg.TLSReadiness = ""
	for _, invalid := range []string{"", strings.Repeat("a", 63), strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		cfg.BuildTreeSHA256 = invalid
		encoded, err = json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeConfig(encoded); err == nil {
			t.Fatalf("invalid build binding %q accepted", invalid)
		}
	}
}

func TestNonstandardPortAuthorityFlowsAcrossControlAndBrowse(t *testing.T) {
	s := testServer(t)
	s.relayOrigin = "wss://relay.example:8443"
	roles, err := hostrole.New("control.example:8443", "assets.example:8443", "relay.example:8443", "example")
	if err != nil {
		t.Fatal(err)
	}
	s.roles = roles
	s.upgrader = newCarrierUpgrader(roles)
	s.controlHost = roles.Authority(hostrole.Control)
	id := "abcdefghijklmnopqrstuvwxyz234567"
	controlAuthority := "control.example:8443"
	browseAuthority := "o-" + id + ".browse.example:8443"

	digest := s.relayProfile.DigestBase64URL()
	body := `{"origin":"https://` + browseAuthority + `","relay_profile_digest":"` + digest + `","approved_visibility":true}`
	capability := httptest.NewRequest(http.MethodPost, "https://"+controlAuthority+"/control/capability", strings.NewReader(body))
	capability.Host = controlAuthority
	capability.Header.Set("Origin", "https://"+controlAuthority)
	capability.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, capability)
	if response.Code != http.StatusOK {
		t.Fatalf("capability status %d body %q", response.Code, response.Body.String())
	}

	bridge := httptest.NewRequest(http.MethodGet, "https://"+controlAuthority+"/control/bridge.html", nil)
	bridge.Host = controlAuthority
	response = httptest.NewRecorder()
	s.ServeHTTP(response, bridge)
	if response.Code != http.StatusOK {
		t.Fatalf("bridge status %d body %q", response.Code, response.Body.String())
	}
	frameAncestor := "frame-ancestors https://*.browse.example:8443"
	if !strings.Contains(response.Header().Get("Content-Security-Policy"), frameAncestor) {
		t.Fatalf("bridge CSP %q does not contain %q", response.Header().Get("Content-Security-Policy"), frameAncestor)
	}

	browseConfig := httptest.NewRequest(http.MethodGet, "https://"+browseAuthority+"/_zp/config", nil)
	browseConfig.Host = browseAuthority
	response = httptest.NewRecorder()
	s.ServeHTTP(response, browseConfig)
	var browseConfiguration map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &browseConfiguration); response.Code != http.StatusOK || err != nil ||
		browseConfiguration["control_host"] != controlAuthority || browseConfiguration["browse_domain"] != "example" {
		t.Fatalf("browse config status=%d body=%q error=%v", response.Code, response.Body.String(), err)
	}

	browseRoot := httptest.NewRequest(http.MethodGet, "https://"+browseAuthority+"/", nil)
	browseRoot.Host = browseAuthority
	response = httptest.NewRecorder()
	s.ServeHTTP(response, browseRoot)
	csp := response.Header().Get("Content-Security-Policy")
	frameSource := "frame-src https://control.example:8443 https://*.browse.example:8443"
	connectSource := "connect-src 'self' wss://relay.example:8443"
	if response.Code != http.StatusOK || !strings.Contains(csp, frameSource) || !strings.Contains(csp, connectSource) {
		t.Fatalf("browse root status=%d CSP=%q lacks frame %q or relay %q", response.Code, csp, frameSource, connectSource)
	}
	wrongRelayPort := httptest.NewRequest(http.MethodGet, "https://relay.example/_zp/carrier", nil)
	wrongRelayPort.Host = "relay.example"
	response = httptest.NewRecorder()
	s.ServeHTTP(response, wrongRelayPort)
	if response.Code != http.StatusMisdirectedRequest {
		t.Fatalf("wrong relay authority port status=%d", response.Code)
	}
	wrongOriginPort := httptest.NewRequest(http.MethodGet, "https://relay.example:8443/_zp/carrier", nil)
	wrongOriginPort.Host = "relay.example:8443"
	wrongOriginPort.Header.Set("Origin", "https://o-"+id+".browse.example")
	wrongOriginPort.Header.Set("Sec-WebSocket-Protocol", relayauth.Protocol)
	if _, _, status := s.carrierRequestOrigin(wrongOriginPort); status != http.StatusForbidden {
		t.Fatalf("wrong browsing Origin port status=%d", status)
	}
}

func TestUnknownHostIsMisdirected(t *testing.T) {
	s := testServer(t)
	request := httptest.NewRequest(http.MethodGet, "https://evil.example/", nil)
	request.Host = "evil.example"
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusMisdirectedRequest {
		t.Fatalf("status %d", response.Code)
	}
}
func TestBrowsingHostOnlyServesBootstrapAndInternal(t *testing.T) {
	s := testServer(t)
	id := "abcdefghijklmnopqrstuvwxyz234567"
	host := "o-" + id + ".browse.example"
	request := httptest.NewRequest(http.MethodGet, "https://"+host+"/", nil)
	request.Host = host
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "bootstrap" {
		t.Fatalf("bootstrap %d %q", response.Code, response.Body.String())
	}
	csp := response.Header().Get("Content-Security-Policy")
	if strings.Contains(csp, "default-src *") || strings.Contains(csp, "connect-src *") || strings.Contains(csp, "'unsafe-eval'") || !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval'") || !strings.Contains(csp, "worker-src 'self'") {
		t.Fatalf("unsafe or incomplete CSP %q", csp)
	}
	if got := response.Header().Get("Cross-Origin-Opener-Policy"); got != "" {
		t.Fatalf("browse bootstrap received control-shell COOP %q", got)
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/_zp/target-worker-host", nil)
	request.Host = host
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	hostCSP := response.Header().Get("Content-Security-Policy")
	if response.Code != http.StatusOK || response.Body.String() != "target-worker-host" ||
		response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Cross-Origin-Opener-Policy") != "" ||
		!strings.Contains(hostCSP, "worker-src 'self'") ||
		!strings.Contains(hostCSP, "frame-ancestors https://control.example") {
		t.Fatalf("target worker host status=%d body=%q cache=%q COOP=%q CSP=%q", response.Code, response.Body.String(), response.Header().Get("Cache-Control"), response.Header().Get("Cross-Origin-Opener-Policy"), hostCSP)
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/_zp/target-worker-host.mjs", nil)
	request.Host = host
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "target-worker-host-module" ||
		response.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("target worker host module status=%d body=%q CORP=%q", response.Code, response.Body.String(), response.Header().Get("Cross-Origin-Resource-Policy"))
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/_zp/sw.js", nil)
	request.Host = host
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "import \"/_zp/assets/test/sw/sw.mjs\";" {
		t.Fatalf("service worker entry %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Service-Worker-Allowed") != "/" || response.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("service worker headers scope=%q cache=%q", response.Header().Get("Service-Worker-Allowed"), response.Header().Get("Cache-Control"))
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/sw.js", nil)
	request.Host = host
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code == http.StatusOK {
		t.Fatal("legacy service worker entry remains exposed")
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/target", nil)
	request.Host = host
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("target status %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "https://"+host+"/generated/placeholder.mjs", nil)
	request.Host = host
	request.URL.Path = "/generated/../control/index.html"
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || response.Body.String() == "control" {
		t.Fatalf("browse traversal status=%d body=%q", response.Code, response.Body.String())
	}
}
func TestCapabilityConfigRequiresRelayDigest(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	_, err := capabilityStore([]capabilityConfig{{ID: "cap", VerifierKey: key, ExpiresAt: "2099-01-01T00:00:00Z", MaxSessions: 1, MaxStreams: 1, Origins: []string{"https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"}}}, relayauth.NewMemoryReplayLedger(), testServer(t).relayProfile)
	if err == nil {
		t.Fatal("missing relay profile digest accepted")
	}
}

func TestAnonymousCapabilityUsesExactHKDFAndBoundClaims(t *testing.T) {
	app := testServer(t)
	origin := "https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"
	id, secret, claims, _, err := app.issueAnonymousCapability(origin)
	if err != nil {
		t.Fatal(err)
	}
	reader := hkdf.New(sha256.New, secret[:], app.deploymentSalt[:], []byte("zeroproxy-carrier-v2"))
	var wantVerifier [32]byte
	if _, err := io.ReadFull(reader, wantVerifier[:]); err != nil {
		t.Fatal(err)
	}
	if claims.VerifierKey != wantVerifier {
		t.Fatal("stored verifier does not match exact HKDF")
	}
	wantBinding := deriveSessionBindingDigest(wantVerifier, app.deploymentID, id, []string{origin})
	if claims.SessionBindingDigest != wantBinding || claims.DeploymentID != app.deploymentID ||
		claims.RelayProfileDigest != app.relayProfile.Digest || claims.Digest == [32]byte{} {
		t.Fatal("issued claims are not deployment, session, and relay bound")
	}
}

func TestHandshakeBytesConsumeBothNegotiatedBudgets(t *testing.T) {
	limits := testServer(t).defaultCarrierLimits()
	limits.UploadByteBudget = 100
	limits.DownloadByteBudget = 200
	authenticated := authenticatedCarrier{
		accept:      relayauth.ServerAccept{NegotiatedLimits: limits},
		uploadBytes: 100, downloadBytes: 20,
	}
	if _, _, err := remainingCarrierBudgets(authenticated); err == nil {
		t.Fatal("upload budget smaller than handshake accepted")
	}
	authenticated.uploadBytes = 10
	authenticated.downloadBytes = 200
	if _, _, err := remainingCarrierBudgets(authenticated); err == nil {
		t.Fatal("download budget smaller than handshake accepted")
	}
	authenticated.downloadBytes = 20
	upload, download, err := remainingCarrierBudgets(authenticated)
	if err != nil || upload != 90 || download != 180 {
		t.Fatalf("remaining budgets = (%d, %d, %v)", upload, download, err)
	}
}

func TestReleaseGateAcceptsDevelopmentAndRejectsItAsProduction(t *testing.T) {
	cfg := config{
		ReleaseSigningKeys:      "../../protocol/release-signing-keys.json",
		MigrationDisposition:    "../../protocol/v1-migration-disposition.json",
		MigrationSignatures:     "../../protocol/v1-migration-disposition.sig",
		CompatibilityDeltas:     "../../protocol/compatibility-deltas.json",
		CompatibilitySignatures: "../../protocol/compatibility-deltas.sig",
		DevelopmentMode:         true,
	}
	if err := verifyReleaseConfig(cfg); err != nil {
		t.Fatal(err)
	}
	cfg.DevelopmentMode = false
	cfg.TorSOCKS = "127.0.0.1:9050"
	if err := verifyReleaseConfig(cfg); err == nil {
		t.Fatal("production accepted development-only signing material")
	}
}

func TestProductionReleaseGateRequiresTorAndDisablesAnonymousIssuance(t *testing.T) {
	cfg := config{
		ReleaseSigningKeys:         "keys",
		MigrationDisposition:       "migration",
		MigrationSignatures:        "migration.sig",
		CompatibilityDeltas:        "deltas",
		CompatibilitySignatures:    "deltas.sig",
		AllowAnonymousCapabilities: true,
	}
	if err := verifyReleaseConfig(cfg); err == nil {
		t.Fatal("production anonymous issuance accepted")
	}
}

func TestServerLoadsOneVerifiedRelayProfileAuthority(t *testing.T) {
	protocolDirectory := filepath.Join("..", "..", "protocol")
	digest := "e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24"
	cfg := config{
		ControlHost: "control.example.test", AssetHost: "assets.example.test", RelayHost: "relay.example.test",
		BrowseDomain: "example.test", TorSOCKS: "127.0.0.1:9050", StaticDir: t.TempDir(),
		BuildTreeSHA256: strings.Repeat("a", 64), DeploymentSalt: base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		ReplayLedgerPath:       filepath.Join(t.TempDir(), "replay.json"),
		RelayProfile:           filepath.Join(protocolDirectory, "relay-profiles", digest+".json"),
		RelayProfileSignatures: filepath.Join(protocolDirectory, "relay-profiles", digest+".sig"),
		ReleaseSigningKeys:     filepath.Join(protocolDirectory, "release-signing-keys.json"),
		DevelopmentMode:        true, AllowAnonymousCapabilities: true,
	}
	app, err := newServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if app.relayProfile.Profile.DeploymentID != app.deploymentID ||
		app.relayProfile.DigestBase64URL() != "5GZyhBGAXqPJfJugRrDYjW4Ed8BoMHjEQYVLzmWAHiQ" ||
		app.relayPublicURL != "wss://relay.example.test/_zp/carrier" {
		t.Fatalf("server relay profile mismatch: %#v", app.relayProfile.Profile)
	}
	request := httptest.NewRequest(http.MethodGet, "https://control.example.test/control/config.json", nil)
	request.Host = "control.example.test"
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	var published struct {
		DevelopmentMode    bool `json:"development_mode"`
		ReleaseSigningKeys struct {
			Keys []json.RawMessage `json:"keys"`
		} `json:"release_signing_keys"`
		RelayProfiles []struct {
			Digest     string               `json:"digest"`
			Profile    relayprofile.Profile `json:"profile"`
			Signatures struct {
				Signatures []json.RawMessage `json:"signatures"`
			} `json:"signatures"`
		} `json:"relay_profiles"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &published) != nil ||
		!published.DevelopmentMode || len(published.RelayProfiles) != 1 ||
		published.RelayProfiles[0].Digest != app.relayProfile.DigestBase64URL() ||
		published.RelayProfiles[0].Profile.DeploymentID != app.deploymentID ||
		len(published.ReleaseSigningKeys.Keys) != 2 || len(published.RelayProfiles[0].Signatures.Signatures) != 2 {
		t.Fatalf("published relay profile tuple rejected: status=%d body=%s", response.Code, response.Body.String())
	}
	cfg.BrowseDomain = "other.example.test"
	cfg.ReplayLedgerPath = filepath.Join(t.TempDir(), "replay.json")
	if _, err := newServer(cfg); err == nil {
		t.Fatal("server accepted a relay profile for another browsing domain")
	}
}

func TestRelayEgressUsesAuthenticatedTorDomainRequest(t *testing.T) {
	tor, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tor.Close() }()
	type torResult struct {
		request socks5.Request
		err     error
	}
	torRequest := make(chan torResult, 1)
	go func() {
		conn, acceptErr := tor.Accept()
		if acceptErr != nil {
			torRequest <- torResult{err: acceptErr}
			return
		}
		defer func() { _ = conn.Close() }()
		request, readErr := socks5.ReadConnectWithPolicy(conn, func(host string, port uint16) bool {
			return host == "www.example.co.uk" && port == 443
		})
		if readErr == nil {
			readErr = socks5.Reply(conn, 0)
		}
		torRequest <- torResult{request: request, err: readErr}
	}()

	browserCarrier, relayCarrier := net.Pipe()
	defer func() { _ = browserCarrier.Close(); _ = relayCarrier.Close() }()
	relayMux, err := smux.Server(relayCarrier, smux.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = relayMux.Close() }()
	browserMux, err := smux.Client(browserCarrier, smux.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = browserMux.Close() }()
	app := &server{
		torSOCKS:           tor.Addr().String(),
		allowedTargetPorts: map[uint16]struct{}{443: {}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go app.serveMux(ctx, relayMux, 1)
	stream, err := browserMux.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	credentials := &socks5.Credentials{Username: "derived-user", Password: "derived-password"}
	if err := socks5.Connect(stream, "WWW.EXAMPLE.CO.UK", 443, credentials); err != nil {
		t.Fatal(err)
	}
	result := <-torRequest
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.request.Host != "www.example.co.uk" || result.request.Port != 443 ||
		result.request.Credentials == nil ||
		result.request.Credentials.Username != credentials.Username ||
		result.request.Credentials.Password != credentials.Password {
		t.Fatalf("Tor request mismatch: %#v", result.request)
	}
}

package main

// zeroproxy-server — CLI 래퍼. HTTP 핸들러 자체는 internal/httphost 가
// 소유한다 (REFACTOR.md §3.4). 여기서는 플래그 파싱 + 게이트웨이(TURN,
// WebTransport) 조립 + ListenAndServe 만 한다.

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/gosuda/zeroproxy/internal/httphost"
	"github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/internal/wtproxy"
)

func main() {
	var addr string
	var wtAddr, wtCert, wtKey, wtPath string
	var cfg httphost.Config
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&cfg.WebDir, "web", "dist/web", "built static web asset directory")
	flag.StringVar(&cfg.SocksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address with IsolateSOCKSAuth, or 'internal' for the built-in test SOCKS5 parser/direct dialer")
	// D4 — server-side WebTransport gateway. Empty `-wt-addr` keeps the
	// listener disabled (the page realm still sees the stub WT_UNSUPPORTED
	// error from runtime-prelude's installBlockers fallback).
	flag.StringVar(&wtAddr, "wt-addr", "", "WebTransport (HTTP/3) gateway UDP listen address (e.g. ':18443'); empty disables D4")
	flag.StringVar(&wtCert, "wt-cert", "", "WebTransport listener TLS cert path (optional — falls back to in-memory self-signed dev cert)")
	flag.StringVar(&wtKey, "wt-key", "", "WebTransport listener TLS key path")
	flag.StringVar(&wtPath, "wt-path", "/__zp/wt", "WebTransport CONNECT request path")
	// D4 client-side: the browser-side virtual `WebTransport` shim needs a
	// publicly-reachable URL for the gateway (different from the UDP listen
	// addr, which may be a local bind or an internal LB pool). When empty,
	// the page falls back to the stub WT_UNSUPPORTED behaviour and target
	// `new WebTransport(...)` calls reject (Promise.ready). Operators set
	// this to e.g. `https://proxy.localhost:18443/__zp/wt` for local dogfood.
	flag.StringVar(&cfg.WtGatewayURL, "wt-public-url", "", "Public URL of the WebTransport gateway (e.g. 'https://proxy.localhost:18443/__zp/wt'); empty hides the gateway from the page-side virtual class")
	var wtPageHosts string
	flag.StringVar(&wtPageHosts, "wt-page-hosts", "", "Comma-separated hostnames whose pages may open WebTransport sessions on the gateway (Origin check, any port). Default: the -wt-public-url hostname")
	// D5 — WebRTC runs relay-only through the embedded TURN server: the
	// page's native RTCPeerConnection is forced to its credentials with
	// `iceTransportPolicy: 'relay'`, so the remote peer sees only the relay
	// and the relay carries DTLS/SRTP ciphertext. The pion signaling bridge
	// this replaced (`-rtc-public-url`) was bypassed by page code — peers
	// connected to the user directly — and was removed 2026-09-30.
	var rtcEnabled bool
	var rtcDeprecatedURL, rtcDeprecatedIPs string
	var rtcTurnAddr, rtcTurnPublicAddr, rtcTurnExternalIP, rtcTurnRealm, rtcTurnSecret string
	flag.BoolVar(&rtcEnabled, "rtc-enable", false, "Enable D5 WebRTC: relay-only through the embedded TURN server (requires -rtc-turn-addr)")
	flag.StringVar(&rtcDeprecatedURL, "rtc-public-url", "", "Deprecated, ignored: the signaling bridge was removed (WebRTC is relay-only through -rtc-turn-addr)")
	flag.StringVar(&rtcDeprecatedIPs, "rtc-allowed-ips", "", "Deprecated, ignored: see -rtc-public-url")
	flag.StringVar(&rtcTurnAddr, "rtc-turn-addr", "", "UDP listener for the embedded TURN server (e.g. '0.0.0.0:3478'); required by -rtc-enable. Must be routable — Chrome ignores TURN servers on loopback")
	flag.StringVar(&rtcTurnPublicAddr, "rtc-turn-public-addr", "", "host:port clients reach the TURN server at (covers NAT / port-forwarding). Defaults to -rtc-turn-addr.")
	flag.StringVar(&rtcTurnExternalIP, "rtc-turn-external-ip", "", "Relay address IP pion advertises in TURN allocation responses. For a port-forwarded box, the public IP. Defaults to listener IP — wrong for NAT'd deployments.")
	flag.StringVar(&rtcTurnRealm, "rtc-turn-realm", "zeroproxy", "TURN realm string")
	flag.StringVar(&rtcTurnSecret, "rtc-turn-secret", "", "Long-term TURN-REST shared secret (hex). Empty = random per-process secret (creds expire on restart).")
	flag.Parse()
	if rtcDeprecatedURL != "" || rtcDeprecatedIPs != "" {
		log.Printf("rtcgw: -rtc-public-url / -rtc-allowed-ips are ignored — the signaling bridge was removed; WebRTC runs relay-only through -rtc-turn-addr")
	}
	if rtcEnabled {
		if rtcTurnAddr == "" {
			log.Fatalf("rtcgw: -rtc-enable requires -rtc-turn-addr — WebRTC runs relay-only through the embedded TURN server")
		}
		turnSrv, err := rtcgw.NewTURNServer(rtcgw.TURNConfig{
			Addr:         rtcTurnAddr,
			PublicAddr:   rtcTurnPublicAddr,
			ExternalIP:   rtcTurnExternalIP,
			Realm:        rtcTurnRealm,
			SharedSecret: rtcTurnSecret,
			// Direct UDP egress may reach only what the HTTP path reaches.
			AllowPrivatePeers: cfg.SocksAddr == "internal",
		})
		if err != nil {
			log.Fatalf("rtcgw: embedded TURN: %v", err)
		}
		cfg.RtcTURN = turnSrv
		log.Printf("rtcgw: embedded TURN listening on %s (public %s, realm %q)", rtcTurnAddr, turnSrv.PublicAddr(), rtcTurnRealm)
		if cfg.SocksAddr != "internal" {
			log.Printf("rtcgw: WARNING TURN relays UDP DIRECTLY (not via %s): remote peers see this server's address (media stays end-to-end encrypted)", cfg.SocksAddr)
		}
	}
	// D4 listener runs on its own UDP socket — HTTP/3 + WebTransport
	// extension. Disabled by default (empty addr); operator opts in
	// during dogfood with `-wt-addr :18443`. Per-target relay happens
	// inside internal/wtproxy/listener.go::handleUpgrade. Built before the
	// HTTP handler so `/zp/api/config` can publish the dev cert's pin.
	var wtListener *wtproxy.Listener
	if wtAddr != "" {
		// Pages are served by the proxy's HTTP origin — normally the same
		// hostname as the gateway on another port.
		var pageHosts []string
		for _, h := range strings.Split(wtPageHosts, ",") {
			if h = strings.TrimSpace(h); h != "" {
				pageHosts = append(pageHosts, h)
			}
		}
		if len(pageHosts) == 0 {
			if u, err := url.Parse(cfg.WtGatewayURL); err == nil && u.Hostname() != "" {
				pageHosts = []string{u.Hostname()}
			}
		}
		var err error
		wtListener, err = wtproxy.New(wtproxy.Config{
			PageHosts:            pageHosts,
			Addr:                 wtAddr,
			Path:                 wtPath,
			CertFile:             wtCert,
			KeyFile:              wtKey,
			AllowInsecureDevCert: true,
			// Direct egress may reach only what the HTTP path reaches:
			// `internal` dials directly (private networks included); a real
			// SOCKS upstream (Tor) cannot reach them.
			AllowPrivateTargets: cfg.SocksAddr == "internal",
		})
		if err != nil {
			log.Fatalf("wtproxy: %v", err)
		}
		cfg.WtGatewayCertHashes = wtListener.CertHashes()
		if cfg.SocksAddr != "internal" {
			// QUIC cannot ride a SOCKS5/Tor upstream, and a WebTransport
			// relay must terminate the browser's session. Both break the
			// byte-pipe invariant the HTTP path keeps — say so at startup.
			log.Printf("wtproxy: WARNING WebTransport egress is DIRECT (not via %s): targets see this server's address, and the gateway terminates WebTransport TLS (sees stream plaintext)", cfg.SocksAddr)
		}
	}
	h := httphost.NewHandler(cfg)
	if wtListener != nil {
		go func() {
			if err := wtListener.Run(context.Background()); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("wtproxy: listener exited: %v", err)
			}
		}()
	}

	// The Go server is a pure byte-pipe — no TLS termination here. The Rust
	// WASM kernel (crates/zp-bundle) handles every target TLS handshake
	// inside the browser, so the relay sees only ciphertext inside yamux
	// streams. ClientHello mimicry is captured into the kernel's hardcoded
	// Chrome 148 spec at build time (web/sw.js captureBrowserFingerprint);
	// the historical `-tls-addr` listener + /zp/api/fp capture endpoint
	// were deleted 2026-06-05 since the SW never actually fetched them in
	// practice (self-signed cert + Chrome's SW HTTPS refusal made the
	// loopback fetch path dead on arrival).
	log.Printf("zeroproxy listening on %s", addr)
	if err := http.ListenAndServe(addr, h); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

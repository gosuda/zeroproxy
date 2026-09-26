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
	// D5 — WebRTC signaling gateway. The gateway runs in-process on the
	// same HTTP listener (`/zp/api/rtc/signal`), so there's no separate
	// addr flag; just an enable toggle + the public URL the page reads
	// from `/zp/api/config`. Empty leaves the legacy stub Handler() up.
	var rtcEnabled bool
	var rtcAllowedIPs string
	var rtcTurnAddr, rtcTurnPublicAddr, rtcTurnExternalIP, rtcTurnRealm, rtcTurnSecret string
	flag.BoolVar(&rtcEnabled, "rtc-enable", false, "Enable the D5 WebRTC signaling gateway (in-process pion/webrtc bridge)")
	flag.StringVar(&cfg.RtcGatewayURL, "rtc-public-url", "", "Public URL of the RTC signaling endpoint (e.g. 'http://proxy.localhost:18080/zp/api/rtc/signal'); empty disables the page-side virtual RTCPeerConnection pass-through")
	flag.StringVar(&rtcAllowedIPs, "rtc-allowed-ips", "", "Comma-separated list of IPs the gateway's own SDP candidates are allowed to advertise — used to strip host candidates that would leak the operator's LAN/NAT interfaces. Empty = no munging (public-IP-only deployments).")
	flag.StringVar(&rtcTurnAddr, "rtc-turn-addr", "", "UDP listener for the embedded TURN server (e.g. '0.0.0.0:3478'). Empty disables embedded TURN — page realm falls back to host candidates only.")
	flag.StringVar(&rtcTurnPublicAddr, "rtc-turn-public-addr", "", "host:port clients reach the TURN server at (covers NAT / port-forwarding). Defaults to -rtc-turn-addr.")
	flag.StringVar(&rtcTurnExternalIP, "rtc-turn-external-ip", "", "Relay address IP pion advertises in TURN allocation responses. For a port-forwarded box, the public IP. Defaults to listener IP — wrong for NAT'd deployments.")
	flag.StringVar(&rtcTurnRealm, "rtc-turn-realm", "zeroproxy", "TURN realm string")
	flag.StringVar(&rtcTurnSecret, "rtc-turn-secret", "", "Long-term TURN-REST shared secret (hex). Empty = random per-process secret (creds expire on restart).")
	flag.Parse()
	if rtcEnabled {
		var allowed []string
		if rtcAllowedIPs != "" {
			for _, p := range strings.Split(rtcAllowedIPs, ",") {
				if p = strings.TrimSpace(p); p != "" {
					allowed = append(allowed, p)
				}
			}
		}
		gw, err := rtcgw.New(rtcgw.Config{AllowedExternalIPs: allowed})
		if err != nil {
			log.Fatalf("rtcgw: %v", err)
		}
		cfg.RtcGateway = gw
		if rtcTurnAddr != "" {
			turnSrv, err := rtcgw.NewTURNServer(rtcgw.TURNConfig{
				Addr:         rtcTurnAddr,
				PublicAddr:   rtcTurnPublicAddr,
				ExternalIP:   rtcTurnExternalIP,
				Realm:        rtcTurnRealm,
				SharedSecret: rtcTurnSecret,
			})
			if err != nil {
				log.Fatalf("rtcgw: embedded TURN: %v", err)
			}
			cfg.RtcTURN = turnSrv
			log.Printf("rtcgw: embedded TURN listening on %s (public %s, realm %q)", rtcTurnAddr, turnSrv.PublicAddr(), rtcTurnRealm)
		}
	}
	h := httphost.NewHandler(cfg)

	// D4 listener runs on its own UDP socket — HTTP/3 + WebTransport
	// extension. Disabled by default (empty addr); operator opts in
	// during dogfood with `-wt-addr :18443`. Per-target relay happens
	// inside internal/wtproxy/listener.go::handleUpgrade; the page-side
	// virtual `WebTransport` surface that drives it is a separate
	// follow-up — without it the listener is exercised only by host
	// tests + direct webtransport-go clients.
	if wtAddr != "" {
		wtListener, err := wtproxy.New(wtproxy.Config{
			Addr:                 wtAddr,
			Path:                 wtPath,
			CertFile:             wtCert,
			KeyFile:              wtKey,
			AllowInsecureDevCert: true,
		})
		if err != nil {
			log.Fatalf("wtproxy: %v", err)
		}
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

package main

// zeroproxy-server is the CLI entrypoint. The HTTP handler lives in
// internal/httphost; this binary parses flags, assembles the optional TURN
// and WebTransport gateways, and runs the HTTP/HTTPS listener.

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gosuda/zeroproxy/internal/httphost"
	"github.com/gosuda/zeroproxy/internal/rtcgw"
	"github.com/gosuda/zeroproxy/internal/wtproxy"
)

func main() {
	var addr, tlsCert, tlsKey string
	var wtAddr, wtCert, wtKey, wtPath string
	var cfg httphost.Config
	flag.StringVar(&addr, "addr", ":8080", "HTTP/HTTPS listen address")
	flag.StringVar(&tlsCert, "tls-cert", "", "path to TLS certificate PEM")
	flag.StringVar(&tlsKey, "tls-key", "", "path to TLS private key PEM")
	flag.StringVar(&cfg.WebDir, "web", "dist/web", "built static web asset directory")
	flag.StringVar(&cfg.SocksAddr, "socks", "127.0.0.1:9050", "Tor SOCKS5 address, 'direct' for public-only direct dialer, or 'internal' for local test SOCKS5 dialer")
	flag.BoolVar(&cfg.DisallowPrivateTargets, "disallow-private-targets", false, "reject private/loopback target IPs in internal/direct mode and gateways")
	flag.BoolVar(&cfg.TrustProxyHeaders, "trust-proxy-headers", false, "trust X-Forwarded-Proto from non-loopback peers")
	flag.StringVar(&wtAddr, "wt-addr", "", "WebTransport (HTTP/3) gateway UDP listen address (e.g. ':18443'); empty disables D4")
	flag.StringVar(&wtCert, "wt-cert", "", "WebTransport listener TLS cert path (optional, falls back to in-memory self-signed dev cert)")
	flag.StringVar(&wtKey, "wt-key", "", "WebTransport listener TLS key path")
	flag.StringVar(&wtPath, "wt-path", "/__zp/wt", "WebTransport CONNECT request path")
	flag.StringVar(&cfg.WtGatewayURL, "wt-public-url", "", "Public URL of the WebTransport gateway (e.g. 'https://proxy.localhost:18443/__zp/wt'); empty hides the gateway from the page-side virtual class")
	var wtPageHosts string
	flag.StringVar(&wtPageHosts, "wt-page-hosts", "", "Comma-separated hostnames whose pages may open WebTransport sessions on the gateway (Origin check, any port). Default: the -wt-public-url hostname")
	var rtcEnabled bool
	var rtcDeprecatedURL, rtcDeprecatedIPs string
	var rtcTurnAddr, rtcTurnPublicAddr, rtcTurnExternalIP, rtcTurnRealm, rtcTurnSecret string
	flag.BoolVar(&rtcEnabled, "rtc-enable", false, "Enable D5 WebRTC: relay-only through the embedded TURN server (requires -rtc-turn-addr)")
	flag.StringVar(&rtcDeprecatedURL, "rtc-public-url", "", "Deprecated, ignored: the signaling bridge was removed (WebRTC is relay-only through -rtc-turn-addr)")
	flag.StringVar(&rtcDeprecatedIPs, "rtc-allowed-ips", "", "Deprecated, ignored: see -rtc-public-url")
	flag.StringVar(&rtcTurnAddr, "rtc-turn-addr", "", "UDP listener for the embedded TURN server (e.g. '0.0.0.0:3478'); required by -rtc-enable. Must be routable: Chrome ignores TURN servers on loopback")
	flag.StringVar(&rtcTurnPublicAddr, "rtc-turn-public-addr", "", "host:port clients reach the TURN server at (covers NAT / port-forwarding). Defaults to -rtc-turn-addr.")
	flag.StringVar(&rtcTurnExternalIP, "rtc-turn-external-ip", "", "Relay address IP pion advertises in TURN allocation responses. For a port-forwarded box, the public IP. Defaults to listener IP.")
	flag.StringVar(&rtcTurnRealm, "rtc-turn-realm", "zeroproxy", "TURN realm string")
	flag.StringVar(&rtcTurnSecret, "rtc-turn-secret", "", "Long-term TURN-REST shared secret (hex). Empty = random per-process secret (creds expire on restart).")
	flag.Parse()

	if (tlsCert != "") != (tlsKey != "") {
		log.Fatalf("both -tls-cert and -tls-key must be provided together")
	}
	allowPrivate := strings.EqualFold(strings.TrimSpace(cfg.SocksAddr), "internal") && !cfg.DisallowPrivateTargets

	if rtcDeprecatedURL != "" || rtcDeprecatedIPs != "" {
		log.Printf("rtcgw: -rtc-public-url / -rtc-allowed-ips are ignored; WebRTC runs relay-only through -rtc-turn-addr")
	}
	if rtcEnabled {
		if rtcTurnAddr == "" {
			log.Fatalf("rtcgw: -rtc-enable requires -rtc-turn-addr; WebRTC runs relay-only through the embedded TURN server")
		}
		turnSrv, err := rtcgw.NewTURNServer(rtcgw.TURNConfig{
			Addr:              rtcTurnAddr,
			PublicAddr:        rtcTurnPublicAddr,
			ExternalIP:        rtcTurnExternalIP,
			Realm:             rtcTurnRealm,
			SharedSecret:      rtcTurnSecret,
			AllowPrivatePeers: allowPrivate,
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
	var wtListener *wtproxy.Listener
	if wtAddr != "" {
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
			RequireOrigin:        len(pageHosts) > 0,
			Addr:                 wtAddr,
			Path:                 wtPath,
			CertFile:             wtCert,
			KeyFile:              wtKey,
			AllowInsecureDevCert: true,
			AllowPrivateTargets:  allowPrivate,
		})
		if err != nil {
			log.Fatalf("wtproxy: %v", err)
		}
		cfg.WtGatewayCertHashes = wtListener.CertHashes()
		if cfg.SocksAddr != "internal" {
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

	srv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	log.Printf("zeroproxy listening on %s", addr)
	var serveErr error
	if tlsCert != "" && tlsKey != "" {
		serveErr = srv.ListenAndServeTLS(tlsCert, tlsKey)
	} else {
		serveErr = srv.ListenAndServe()
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatal(serveErr)
	}
}

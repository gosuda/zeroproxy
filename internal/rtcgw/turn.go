package rtcgw

// Embedded TURN server — pion/turn/v4 spun in-process alongside the
// WebRTC gateway so operators don't need to deploy coturn out-of-band.
// Uses long-term TURN-REST short-term credentials (RFC 7635): each
// `IssueICEServerCreds` call returns a fresh username/password tuple
// derived from `sharedSecret`, valid for `ttl`. The page realm reads
// the tuple from `/zp/api/config` (boot JSON) and feeds it into the
// native `RTCPeerConnection`'s `iceServers` array.
//
// Topology:
//
//	page realm RTCPC ──(STUN/TURN)──▶ this TURN server
//	                                  │
//	                                  ▼
//	                              relay UDP to target's peer
//
// The TURN server's external IP is what target peers see — page IP
// stays private. Operator must supply `-rtc-turn-external-ip` when
// behind NAT; otherwise pion fills the relay address with the
// listener's local IP (host) and connectivity will fail through NAT.
//
// **Disabled by default**: requires `-rtc-enable` AND
// `-rtc-turn-addr <ip:port>`. Empty `-rtc-turn-addr` keeps the legacy
// "no embedded TURN" mode (page-side iceServers stays empty, host
// candidates only).

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// TURNServer wraps a pion/turn/v4 Server with the cred-issuance
// helper the page-side config endpoint uses.
type TURNServer struct {
	server       *turn.Server
	publicAddr   string // host:port advertised to clients (covers NAT)
	realm        string
	sharedSecret string
	defaultTTL   time.Duration

	mu       sync.Mutex
	conn     *net.UDPConn
}

// TURNConfig carries operator-supplied knobs. `Addr` is the UDP
// listener `ip:port` (typically `0.0.0.0:3478`). `PublicAddr` is what
// clients reach the server at (covers NAT — for a port-forwarded box
// it's `<public-ip>:3478`). `ExternalIP` is the relay-address IP
// pion advertises in TURN allocation responses; for a single-IP host
// this is the same as the listener IP. `Realm` is the TURN realm
// string (any operator-meaningful identifier).
type TURNConfig struct {
	Addr         string        // "0.0.0.0:3478"
	PublicAddr   string        // host:port clients reach
	ExternalIP   string        // relay address IP (NAT-aware)
	Realm        string        // TURN realm
	SharedSecret string        // long-term auth shared secret
	DefaultTTL   time.Duration // default cred validity (e.g. 30 min)
}

// NewTURNServer starts the TURN listener. The caller owns the
// returned *TURNServer and must invoke Close() to tear down the UDP
// socket + pion server goroutines.
func NewTURNServer(cfg TURNConfig) (*TURNServer, error) {
	if cfg.Addr == "" {
		return nil, fmt.Errorf("rtcgw: TURNConfig.Addr required")
	}
	if cfg.Realm == "" {
		cfg.Realm = "zeroproxy"
	}
	if cfg.DefaultTTL == 0 {
		cfg.DefaultTTL = 30 * time.Minute
	}
	if cfg.SharedSecret == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("rtcgw: random secret: %w", err)
		}
		cfg.SharedSecret = hex.EncodeToString(buf)
	}

	udpAddr, err := net.ResolveUDPAddr("udp4", cfg.Addr)
	if err != nil {
		return nil, fmt.Errorf("rtcgw: resolve %q: %w", cfg.Addr, err)
	}
	conn, err := net.ListenUDP("udp4", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("rtcgw: TURN ListenUDP %q: %w", cfg.Addr, err)
	}

	externalIP := cfg.ExternalIP
	if externalIP == "" {
		// Fall back to the listener's local IP. For containerized /
		// NAT'd deployments this is wrong and TURN will fail across
		// NAT — operator must supply `-rtc-turn-external-ip`.
		externalIP = udpAddr.IP.String()
		if externalIP == "0.0.0.0" || externalIP == "::" {
			externalIP = "127.0.0.1"
		}
	}
	relayGen := &turn.RelayAddressGeneratorStatic{
		RelayAddress: net.ParseIP(externalIP),
		Address:      "0.0.0.0",
	}
	if relayGen.RelayAddress == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("rtcgw: invalid external IP %q", externalIP)
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm:         cfg.Realm,
		AuthHandler:   turn.NewLongTermAuthHandler(cfg.SharedSecret, logging.NewDefaultLoggerFactory().NewLogger("turn")),
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn:            conn,
				RelayAddressGenerator: relayGen,
			},
		},
	})
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("rtcgw: turn.NewServer: %w", err)
	}

	publicAddr := cfg.PublicAddr
	if publicAddr == "" {
		publicAddr = cfg.Addr
	}

	return &TURNServer{
		server:       server,
		publicAddr:   publicAddr,
		realm:        cfg.Realm,
		sharedSecret: cfg.SharedSecret,
		defaultTTL:   cfg.DefaultTTL,
		conn:         conn,
	}, nil
}

// Close tears down the TURN server + UDP socket. Idempotent.
func (s *TURNServer) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.server != nil {
		_ = s.server.Close()
		s.server = nil
	}
	if s.conn != nil {
		_ = s.conn.Close()
		s.conn = nil
	}
	return nil
}

// ICEServerCred is the cred tuple the page realm consumes.
// `URLs` is one or two TURN URLs (UDP + TLS variants). `Username` +
// `Credential` are short-term derived per RFC 7635 — username is
// `<expiry-unix>:<userlabel>`, credential is base64(HMAC-SHA1(secret,
// username)).
type ICEServerCred struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// IssueICEServerCreds returns a fresh time-limited cred tuple the
// caller can hand to the page realm. `userLabel` lets operators
// attribute creds to a specific session / tab (it's embedded in the
// username but pion's auth handler treats the cred as opaque
// HMAC-derived input). `userLabel` empty → a random hex label.
func (s *TURNServer) IssueICEServerCreds(userLabel string) (ICEServerCred, error) {
	if s == nil {
		return ICEServerCred{}, fmt.Errorf("rtcgw: nil TURN server")
	}
	if userLabel == "" {
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			return ICEServerCred{}, fmt.Errorf("rtcgw: random label: %w", err)
		}
		userLabel = hex.EncodeToString(buf)
	}
	username, password, err := turn.GenerateLongTermTURNRESTCredentials(s.sharedSecret, userLabel, s.defaultTTL)
	if err != nil {
		return ICEServerCred{}, fmt.Errorf("rtcgw: GenerateLongTermTURNRESTCredentials: %w", err)
	}
	return ICEServerCred{
		URLs:       []string{"turn:" + s.publicAddr},
		Username:   username,
		Credential: password,
	}, nil
}

// PublicAddr returns the host:port clients connect to.
func (s *TURNServer) PublicAddr() string {
	if s == nil {
		return ""
	}
	return s.publicAddr
}

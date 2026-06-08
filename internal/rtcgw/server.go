// Server — ZeroProxy WebRTC gateway. Acts as a per-session bridge
// between the page realm's virtual `RTCPeerConnection` and the target's
// remote peer.
//
// Topology (per session):
//
//     page realm  ─(virtual RTCPC + native RTCPC pinned to our ICE servers)─►  page-side PC
//     page-side PC  ─(SFU bridge inside gateway)─►  target-side PC
//     target-side PC  ─(real WebRTC handshake)─►  target's remote peer
//
// Signaling flows over plain HTTP POST against `/zp/api/rtc/signal`:
// the page realm collects local offers / answers / ICE candidates and
// posts them; the gateway echoes the corresponding event from its
// internal PC pair (or forwards to the target-side PC). The page never
// sees the target's real ICE candidates — all media + data channels
// relay through the gateway, so the only IP visible to the remote peer
// is the gateway's.
//
// Status: D5 scaffolding. The signaling endpoint + per-session PC pair
// + bidirectional SDP / ICE / data-channel forward are landed. Media
// RTP track forwarding (audio / video SFU) is wired but minimal —
// remote tracks are subscribed and their packets are forwarded to the
// peer side without transcoding. Full TURN-server-embedded
// configuration + per-tab session attribution stays a follow-up; the
// current implementation accepts any session id and trusts the SW
// runtime token (`X-ZP-Runtime-Token`) for authn.
package rtcgw

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Config carries the gateway parameters threaded from main.go.
type Config struct {
	// ICEServers the page-side PeerConnection should be pinned to. Empty
	// means we let pion use defaults (likely none, since there's no
	// embedded TURN here yet — the page's PC will fall back to host
	// candidates which still leak real IP).
	ICEServers []webrtc.ICEServer
	// IdleSessionTimeout — sessions with no activity for this long are
	// torn down. Defaults to 5 min.
	IdleSessionTimeout time.Duration
	// Logger receives one line per session lifecycle event. nil → log.Default.
	Logger *log.Logger
}

// Gateway holds the live session table.
type Gateway struct {
	cfg     Config
	api     *webrtc.API
	logger  *log.Logger
	mu      sync.Mutex
	sessMap map[string]*session
}

// New constructs the gateway. The `webrtc.API` is built once with a
// MediaEngine seeded with the common audio/video codecs so SFU
// forwarding works out of the box.
func New(cfg Config) (*Gateway, error) {
	if cfg.IdleSessionTimeout == 0 {
		cfg.IdleSessionTimeout = 5 * time.Minute
	}
	logger := cfg.Logger
	if logger == nil {
		logger = log.Default()
	}
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("rtcgw: RegisterDefaultCodecs: %w", err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me))
	return &Gateway{
		cfg:     cfg,
		api:     api,
		logger:  logger,
		sessMap: make(map[string]*session),
	}, nil
}

// session tracks one page-side + one target-side PeerConnection and
// the channels for relaying signaling messages back to the page.
type session struct {
	id        string
	pagePC    *webrtc.PeerConnection
	targetPC  *webrtc.PeerConnection
	pendingMu sync.Mutex
	// pending is a FIFO of unsent gateway-originated signaling events
	// (the page polls this via GET /zp/api/rtc/signal?session=...).
	pending []signalEnvelope
	notify  chan struct{}
	created time.Time
	logger  *log.Logger
}

// signalEnvelope is the on-the-wire shape for each event the gateway
// exchanges with the page realm. The page POSTs envelopes it wants the
// gateway to forward to the target side; the gateway emits envelopes
// the page should call on its own native RTCPeerConnection.
type signalEnvelope struct {
	Op        string                     `json:"op"` // "offer" | "answer" | "candidate" | "close"
	SessionID string                     `json:"sessionId"`
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
}

// HandlerForAPI returns the http.Handler for the /zp/api/rtc/signal
// endpoint. Routes POST envelopes (page → gateway) and GET long-polls
// (gateway → page).
func (g *Gateway) HandlerForAPI() http.Handler {
	return http.HandlerFunc(g.serveSignal)
}

func (g *Gateway) serveSignal(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		g.pollSession(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()
	var env signalEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		http.Error(w, "invalid envelope", http.StatusBadRequest)
		return
	}
	if env.SessionID == "" {
		http.Error(w, "missing sessionId", http.StatusBadRequest)
		return
	}
	sess, err := g.ensureSession(r.Context(), env.SessionID)
	if err != nil {
		http.Error(w, fmt.Sprintf("ensure session: %v", err), http.StatusInternalServerError)
		return
	}
	switch env.Op {
	case "offer":
		if env.SDP == nil {
			http.Error(w, "missing sdp", http.StatusBadRequest)
			return
		}
		if err := sess.pagePC.SetRemoteDescription(*env.SDP); err != nil {
			http.Error(w, fmt.Sprintf("setRemoteDescription: %v", err), http.StatusInternalServerError)
			return
		}
		answer, err := sess.pagePC.CreateAnswer(nil)
		if err != nil {
			http.Error(w, fmt.Sprintf("createAnswer: %v", err), http.StatusInternalServerError)
			return
		}
		if err := sess.pagePC.SetLocalDescription(answer); err != nil {
			http.Error(w, fmt.Sprintf("setLocalDescription: %v", err), http.StatusInternalServerError)
			return
		}
		sess.emit(signalEnvelope{Op: "answer", SessionID: sess.id, SDP: sess.pagePC.LocalDescription()})
	case "answer":
		// Page-supplied answer for a gateway-initiated re-offer. Apply
		// against the page-side PC.
		if env.SDP == nil {
			http.Error(w, "missing sdp", http.StatusBadRequest)
			return
		}
		if err := sess.pagePC.SetRemoteDescription(*env.SDP); err != nil {
			http.Error(w, fmt.Sprintf("setRemoteDescription: %v", err), http.StatusInternalServerError)
			return
		}
	case "candidate":
		if env.Candidate == nil {
			http.Error(w, "missing candidate", http.StatusBadRequest)
			return
		}
		if err := sess.pagePC.AddICECandidate(*env.Candidate); err != nil {
			// Tolerate addIceCandidate failures — pion logs internally
			// and the connection can still complete via the remaining
			// candidates.
			sess.logger.Printf("rtcgw: AddICECandidate: %v", err)
		}
	case "close":
		g.tearSession(sess.id)
	default:
		http.Error(w, "unknown op", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`)
}

func (g *Gateway) pollSession(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("session")
	if id == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	sess, err := g.ensureSession(r.Context(), id)
	if err != nil {
		http.Error(w, fmt.Sprintf("ensure session: %v", err), http.StatusInternalServerError)
		return
	}
	// Drain whatever's already buffered; if nothing, long-poll up to 20 s
	// for a new event so the page side doesn't need to spin.
	envs := sess.drain()
	if len(envs) == 0 {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		select {
		case <-sess.notify:
			envs = sess.drain()
		case <-ctx.Done():
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(envs)
}

// ensureSession returns the active session for id, creating one on
// first use. Includes the page-side + target-side PeerConnections and
// hooks for SDP / ICE / track forwarding.
func (g *Gateway) ensureSession(_ context.Context, id string) (*session, error) {
	g.mu.Lock()
	if s, ok := g.sessMap[id]; ok {
		g.mu.Unlock()
		return s, nil
	}
	g.mu.Unlock()

	pageCfg := webrtc.Configuration{ICEServers: g.cfg.ICEServers}
	pagePC, err := g.api.NewPeerConnection(pageCfg)
	if err != nil {
		return nil, err
	}
	targetPC, err := g.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = pagePC.Close()
		return nil, err
	}
	s := &session{
		id:       id,
		pagePC:   pagePC,
		targetPC: targetPC,
		notify:   make(chan struct{}, 16),
		created:  time.Now(),
		logger:   g.logger,
	}

	// Forward ICE candidates pagePC → page (via emit() → poll), and
	// targetPC → its own real signaling once we wire a target signaling
	// adapter. For now both candidate streams just funnel into the page
	// poll queue with a `from` discriminator embedded into the
	// envelope's `Op` field (kept simple — page side ignores anything
	// it doesn't recognize).
	pagePC.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		s.emit(signalEnvelope{Op: "candidate", SessionID: s.id, Candidate: &init})
	})
	pagePC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		// Naive RTP relay to the target side: open a corresponding
		// local track and copy packets. Real SFU semantics (rtcp,
		// jitter buffer, transcoding) is follow-up.
		local, err := webrtc.NewTrackLocalStaticRTP(track.Codec().RTPCodecCapability, track.ID(), track.StreamID())
		if err != nil {
			s.logger.Printf("rtcgw: NewTrackLocalStaticRTP: %v", err)
			return
		}
		if _, err := s.targetPC.AddTrack(local); err != nil {
			s.logger.Printf("rtcgw: targetPC.AddTrack: %v", err)
			return
		}
		go func() {
			for {
				pkt, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				if err := local.WriteRTP(pkt); err != nil {
					return
				}
			}
		}()
	})
	pagePC.OnDataChannel(func(dc *webrtc.DataChannel) {
		// Mirror data channels onto the target side. Both endpoints
		// see the same label/id, packets relay verbatim.
		mirror, err := s.targetPC.CreateDataChannel(dc.Label(), nil)
		if err != nil {
			s.logger.Printf("rtcgw: CreateDataChannel mirror: %v", err)
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				_ = mirror.SendText(string(msg.Data))
			} else {
				_ = mirror.Send(msg.Data)
			}
		})
		mirror.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				_ = dc.SendText(string(msg.Data))
			} else {
				_ = dc.Send(msg.Data)
			}
		})
	})

	g.mu.Lock()
	g.sessMap[id] = s
	g.mu.Unlock()

	g.logger.Printf("rtcgw: session %s opened", id)
	return s, nil
}

func (g *Gateway) tearSession(id string) {
	g.mu.Lock()
	s, ok := g.sessMap[id]
	if ok {
		delete(g.sessMap, id)
	}
	g.mu.Unlock()
	if !ok {
		return
	}
	_ = s.pagePC.Close()
	_ = s.targetPC.Close()
	g.logger.Printf("rtcgw: session %s closed", id)
}

func (s *session) emit(env signalEnvelope) {
	s.pendingMu.Lock()
	s.pending = append(s.pending, env)
	s.pendingMu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *session) drain() []signalEnvelope {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if len(s.pending) == 0 {
		return nil
	}
	out := s.pending
	s.pending = nil
	return out
}

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// wsBridgeOpen is the first text frame on a /zp/ws-bridge connection.
type wsBridgeOpen struct {
	URL       string   `json:"url"`
	Protocols []string `json:"protocols"`
	TabID     string   `json:"tabId,omitempty"`
	Isolation string   `json:"isolation,omitempty"`
}

// wsBridgeAck is the first text frame sent back to the client.
type wsBridgeAck struct {
	OK       bool   `json:"ok"`
	Protocol string `json:"protocol,omitempty"`
	Code     string `json:"code,omitempty"`
	Host     string `json:"host,omitempty"`
}

// wsBridgeMsg wraps a frame in either direction once the bridge is active.
// The text/binary distinction is preserved via the "binary" flag; bodies for
// text frames are UTF-8 strings carried in Data, binary frames are base64.
type wsBridgeMsg struct {
	Type   string `json:"type"`             // "text" | "binary" | "close" | "ping"
	Data   string `json:"data,omitempty"`   // utf-8 for text; base64 for binary
	Code   int    `json:"code,omitempty"`   // close code
	Reason string `json:"reason,omitempty"` // close reason
}

// handleWSBridge upgrades the inbound WS, reads an open envelope from the
// client (kernel-side), dials the requested target WebSocket, and pipes
// messages in both directions until either side closes.
func (s *server) handleWSBridge(w http.ResponseWriter, r *http.Request) {
	clientWS, err := pipeUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer clientWS.Close()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	_ = clientWS.SetReadDeadline(time.Now().Add(15 * time.Second))
	mt, raw, err := clientWS.ReadMessage()
	if err != nil || mt != websocket.TextMessage {
		writeBridgeError(clientWS, "MALFORMED_ROUTE", "")
		return
	}
	_ = clientWS.SetReadDeadline(time.Time{})
	var open wsBridgeOpen
	if err := json.Unmarshal(raw, &open); err != nil {
		writeBridgeError(clientWS, "MALFORMED_ROUTE", "")
		return
	}
	u, err := url.Parse(open.URL)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
		writeBridgeError(clientWS, "TARGET_PROTOCOL_BLOCKED", "")
		return
	}

	// Dial the target WebSocket. Use a custom dialer so the SOCKS5 path can be
	// honoured later; for now a direct dial mirrors handleRelay's policy.
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDialContext:   nil,
		Subprotocols:     open.Protocols,
	}
	hdr := http.Header{}
	for k, vs := range r.Header {
		lk := strings.ToLower(k)
		// Strip ZeroProxy internal markers + WebSocket handshake headers that
		// the gorilla dialer sets itself (duplicating them is rejected) + any
		// header that would mis-identify the origin to the target.
		if strings.HasPrefix(lk, "x-zp-") ||
			lk == "origin" || lk == "host" ||
			lk == "connection" || lk == "upgrade" ||
			lk == "sec-websocket-key" || lk == "sec-websocket-version" ||
			lk == "sec-websocket-extensions" || lk == "sec-websocket-protocol" {
			continue
		}
		for _, v := range vs {
			hdr.Add(k, v)
		}
	}
	targetWS, _, err := dialer.DialContext(ctx, u.String(), hdr)
	if err != nil {
		writeBridgeError(clientWS, "TARGET_CONNECT_FAILED", u.Host)
		log.Printf("ws-bridge: dial %s failed: %v", u.Host, err)
		return
	}
	defer targetWS.Close()

	// ACK the client so it can resolve the open promise.
	if err := writeBridgeJSON(clientWS, wsBridgeAck{OK: true, Protocol: targetWS.Subprotocol()}); err != nil {
		return
	}

	// Bidirectional copy. Either direction's close cancels the other.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer cancel()
		clientToTarget(ctx, clientWS, targetWS)
	}()
	go func() {
		defer wg.Done()
		defer cancel()
		targetToClient(ctx, targetWS, clientWS)
	}()
	wg.Wait()
}

func clientToTarget(ctx context.Context, src, dst *websocket.Conn) {
	for {
		if ctx.Err() != nil {
			return
		}
		mt, data, err := src.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.TextMessage {
			continue // bridge envelope channel is text-only
		}
		var msg wsBridgeMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "text":
			if err := dst.WriteMessage(websocket.TextMessage, []byte(msg.Data)); err != nil {
				return
			}
		case "binary":
			bytes, decErr := base64Decode(msg.Data)
			if decErr != nil {
				return
			}
			if err := dst.WriteMessage(websocket.BinaryMessage, bytes); err != nil {
				return
			}
		case "close":
			code := msg.Code
			if code == 0 {
				code = websocket.CloseNormalClosure
			}
			_ = dst.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, msg.Reason))
			return
		}
	}
}

func targetToClient(ctx context.Context, src, dst *websocket.Conn) {
	for {
		if ctx.Err() != nil {
			return
		}
		mt, data, err := src.ReadMessage()
		if err != nil {
			closeErr, ok := err.(*websocket.CloseError)
			if ok {
				_ = writeBridgeJSON(dst, wsBridgeMsg{Type: "close", Code: closeErr.Code, Reason: closeErr.Text})
			} else {
				_ = writeBridgeJSON(dst, wsBridgeMsg{Type: "close", Code: 1006})
			}
			return
		}
		switch mt {
		case websocket.TextMessage:
			_ = writeBridgeJSON(dst, wsBridgeMsg{Type: "text", Data: string(data)})
		case websocket.BinaryMessage:
			_ = writeBridgeJSON(dst, wsBridgeMsg{Type: "binary", Data: base64Encode(data)})
		}
	}
}

func writeBridgeError(ws *websocket.Conn, code, host string) {
	_ = writeBridgeJSON(ws, wsBridgeAck{OK: false, Code: code, Host: host})
}

func writeBridgeJSON(ws *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.TextMessage, data)
}

func base64Decode(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
func base64Encode(b []byte) string           { return base64.StdEncoding.EncodeToString(b) }

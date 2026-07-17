package transportlab

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// MaxWebSocketHandshakeBytes prevents a hostile peer from holding a fixture
	// slot while supplying an unbounded HTTP upgrade request.
	MaxWebSocketHandshakeBytes = 16 << 10
	// MaxWebSocketFrameCount caps the number of scripted target frames.
	MaxWebSocketFrameCount = 64
	// MaxWebSocketFrameBytes caps one scripted frame payload.
	MaxWebSocketFrameBytes = 1 << 20
	// MaxWebSocketScriptBytes caps all bytes emitted after a successful upgrade.
	MaxWebSocketScriptBytes = 4 << 20
	// MaxWebSocketSlowlorisChunks bounds delayed writes in one script.
	MaxWebSocketSlowlorisChunks = 64
	// MaxWebSocketSlowlorisDuration prevents one scripted slowloris from
	// monopolizing a bounded TCP fixture indefinitely.
	MaxWebSocketSlowlorisDuration = time.Second
	// WebSocketHandshakeTimeout prevents incomplete client upgrades from
	// permanently consuming a TCP fixture slot.
	WebSocketHandshakeTimeout = time.Second
	// WebSocketWriteTimeout bounds a client that stops reading scripted bytes.
	WebSocketWriteTimeout = time.Second
)

var webSocketGUID = []byte("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")

// TargetWebSocketFrame is one raw RFC 6455 frame sent by the target fixture.
// Masked frames and oversized control frames deliberately permit hostile target
// behavior; production code must reject them rather than this fixture repairing
// the bytes.
type TargetWebSocketFrame struct {
	FIN     bool
	Opcode  byte
	Payload []byte
	Masked  bool
	MaskKey [4]byte
}

// TargetWebSocketClose emits a valid target close frame after scripted frames.
// Code zero emits a close frame without a status code.
type TargetWebSocketClose struct {
	Code   uint16
	Reason string
}

// TargetWebSocketSlowloris writes raw post-upgrade bytes in delayed chunks.
// Bytes are intentionally raw so tests can slow-drip incomplete frame headers
// and payloads exactly as received from a hostile target.
type TargetWebSocketSlowloris struct {
	Bytes      []byte
	ChunkBytes int
	Delay      time.Duration
}

// TargetWebSocketScenario scripts one raw target WebSocket connection.
// MalformedUpgrade, when supplied, is sent verbatim instead of a successful
// upgrade and terminates the script. No request or payload data is retained.
type TargetWebSocketScenario struct {
	MalformedUpgrade []byte
	Frames           []TargetWebSocketFrame
	Slowloris        *TargetWebSocketSlowloris
	Close            *TargetWebSocketClose
}

// NewTargetWebSocketHandler validates a bounded target-WebSocket script and
// returns a TCP handler suitable for NewTCP.
func NewTargetWebSocketHandler(scenario TargetWebSocketScenario) (TCPHandler, error) {
	if err := validateTargetWebSocketScenario(scenario); err != nil {
		return nil, err
	}
	return func(connection net.Conn) {
		serveTargetWebSocket(connection, scenario)
	}, nil
}

func validateTargetWebSocketScenario(scenario TargetWebSocketScenario) error {
	if len(scenario.MalformedUpgrade) > MaxWebSocketHandshakeBytes {
		return fmt.Errorf("transport WebSocket malformed upgrade exceeds %d bytes", MaxWebSocketHandshakeBytes)
	}
	if len(scenario.Frames) > MaxWebSocketFrameCount {
		return fmt.Errorf("transport WebSocket script exceeds %d frames", MaxWebSocketFrameCount)
	}

	total := 0
	for index, frame := range scenario.Frames {
		if frame.Opcode > 0x0f {
			return fmt.Errorf("transport WebSocket frame %d has invalid opcode", index)
		}
		if len(frame.Payload) > MaxWebSocketFrameBytes {
			return fmt.Errorf("transport WebSocket frame %d exceeds %d bytes", index, MaxWebSocketFrameBytes)
		}
		total += len(frame.Payload) + webSocketFrameHeaderBytes(len(frame.Payload), frame.Masked)
	}
	if scenario.Close != nil {
		if !validTargetWebSocketClose(*scenario.Close) {
			return errors.New("transport WebSocket close is invalid")
		}
		if len(scenario.Frames) == MaxWebSocketFrameCount {
			return fmt.Errorf("transport WebSocket script exceeds %d frames", MaxWebSocketFrameCount)
		}
		total += len(scenario.Close.Reason) + 4
	}
	if scenario.Slowloris != nil {
		slow := scenario.Slowloris
		if slow.ChunkBytes <= 0 || slow.Delay < 0 {
			return errors.New("transport WebSocket slowloris chunk size and delay must be non-negative")
		}
		chunks := 0
		if len(slow.Bytes) != 0 {
			chunks = 1 + (len(slow.Bytes)-1)/slow.ChunkBytes
		}
		if chunks > MaxWebSocketSlowlorisChunks {
			return fmt.Errorf("transport WebSocket slowloris exceeds %d chunks", MaxWebSocketSlowlorisChunks)
		}
		if gaps := chunks - 1; gaps > 0 && slow.Delay > MaxWebSocketSlowlorisDuration/time.Duration(gaps) {
			return fmt.Errorf("transport WebSocket slowloris exceeds %s", MaxWebSocketSlowlorisDuration)
		}
		total += len(slow.Bytes)
	}
	if total > MaxWebSocketScriptBytes {
		return fmt.Errorf("transport WebSocket script exceeds %d bytes", MaxWebSocketScriptBytes)
	}
	return nil
}

func validTargetWebSocketClose(close TargetWebSocketClose) bool {
	if len(close.Reason) > 123 || !utf8.ValidString(close.Reason) {
		return false
	}
	if close.Code == 0 {
		return close.Reason == ""
	}
	return close.Code == 1000 || close.Code == 1001 || close.Code == 1002 || close.Code == 1003 ||
		(close.Code >= 1007 && close.Code <= 1014) || (close.Code >= 3000 && close.Code <= 4999)
}

func serveTargetWebSocket(connection net.Conn, scenario TargetWebSocketScenario) {
	if err := connection.SetReadDeadline(time.Now().Add(WebSocketHandshakeTimeout)); err != nil {
		return
	}
	reader := bufio.NewReaderSize(connection, MaxWebSocketHandshakeBytes)
	requestBytes, err := readWebSocketUpgrade(reader)
	if err != nil {
		return
	}
	if err := connection.SetReadDeadline(time.Time{}); err != nil {
		return
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(requestBytes)))
	if err != nil || !validWebSocketUpgrade(request) {
		return
	}
	_ = request.Body.Close()
	if err := connection.SetWriteDeadline(time.Now().Add(WebSocketWriteTimeout + MaxWebSocketSlowlorisDuration)); err != nil {
		return
	}

	if len(scenario.MalformedUpgrade) != 0 {
		_, _ = connection.Write(scenario.MalformedUpgrade)
		return
	}
	if _, err := io.WriteString(connection, webSocketUpgradeResponse(request.Header.Get("Sec-WebSocket-Key"))); err != nil {
		return
	}
	for _, frame := range scenario.Frames {
		if err := writeTargetWebSocketFrame(connection, frame); err != nil {
			return
		}
	}
	if scenario.Slowloris != nil {
		if err := writeTargetWebSocketSlowloris(connection, *scenario.Slowloris); err != nil {
			return
		}
	}
	if scenario.Close != nil {
		closePayload := make([]byte, 2+len(scenario.Close.Reason))
		closePayload[0] = byte(scenario.Close.Code >> 8)
		closePayload[1] = byte(scenario.Close.Code)
		copy(closePayload[2:], scenario.Close.Reason)
		if scenario.Close.Code == 0 {
			closePayload = nil
		}
		_ = writeTargetWebSocketFrame(connection, TargetWebSocketFrame{FIN: true, Opcode: 8, Payload: closePayload})
	}
}

func readWebSocketUpgrade(reader *bufio.Reader) ([]byte, error) {
	request := make([]byte, 0, 1024)
	for len(request) < MaxWebSocketHandshakeBytes {
		value, err := reader.ReadByte()
		if err != nil {
			return nil, err
		}
		request = append(request, value)
		if len(request) >= 4 && bytes.Equal(request[len(request)-4:], []byte("\r\n\r\n")) {
			return request, nil
		}
	}
	return nil, errors.New("transport WebSocket upgrade exceeds byte limit")
}

func validWebSocketUpgrade(request *http.Request) bool {
	if request.Method != http.MethodGet || request.ProtoMajor != 1 || request.ProtoMinor != 1 {
		return false
	}
	if !webSocketHeaderToken(request.Header.Get("Connection"), "upgrade") ||
		!webSocketHeaderToken(request.Header.Get("Upgrade"), "websocket") ||
		request.Header.Get("Sec-WebSocket-Version") != "13" {
		return false
	}
	key, err := base64.StdEncoding.DecodeString(request.Header.Get("Sec-WebSocket-Key"))
	return err == nil && len(key) == 16
}

func webSocketHeaderToken(header, want string) bool {
	for _, value := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(value), want) {
			return true
		}
	}
	return false
}

func webSocketUpgradeResponse(key string) string {
	digest := sha1.New()
	_, _ = digest.Write([]byte(key))
	_, _ = digest.Write(webSocketGUID)
	accept := base64.StdEncoding.EncodeToString(digest.Sum(nil))
	return "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"
}

func writeTargetWebSocketSlowloris(connection net.Conn, slow TargetWebSocketSlowloris) error {
	for offset := 0; offset < len(slow.Bytes); {
		end := offset + slow.ChunkBytes
		if end > len(slow.Bytes) {
			end = len(slow.Bytes)
		}
		if _, err := connection.Write(slow.Bytes[offset:end]); err != nil {
			return err
		}
		offset = end
		if offset < len(slow.Bytes) && slow.Delay > 0 {
			time.Sleep(slow.Delay)
		}
	}
	return nil
}

func writeTargetWebSocketFrame(connection net.Conn, frame TargetWebSocketFrame) error {
	payloadLength := len(frame.Payload)
	header := make([]byte, 0, webSocketFrameHeaderBytes(payloadLength, frame.Masked))
	first := frame.Opcode
	if frame.FIN {
		first |= 0x80
	}
	header = append(header, first)
	lengthByte := byte(0)
	if frame.Masked {
		lengthByte |= 0x80
	}
	switch {
	case payloadLength <= 125:
		header = append(header, lengthByte|byte(payloadLength))
	case payloadLength <= 0xffff:
		header = append(header, lengthByte|126, byte(payloadLength>>8), byte(payloadLength))
	default:
		header = append(header, lengthByte|127)
		for shift := 56; shift >= 0; shift -= 8 {
			header = append(header, byte(uint64(payloadLength)>>shift))
		}
	}
	payload := frame.Payload
	if frame.Masked {
		header = append(header, frame.MaskKey[:]...)
		payload = append([]byte(nil), frame.Payload...)
		for index := range payload {
			payload[index] ^= frame.MaskKey[index%len(frame.MaskKey)]
		}
	}
	if _, err := connection.Write(header); err != nil {
		return err
	}
	_, err := connection.Write(payload)
	return err
}

func webSocketFrameHeaderBytes(payloadLength int, masked bool) int {
	header := 2
	if payloadLength > 125 && payloadLength <= 0xffff {
		header += 2
	} else if payloadLength > 0xffff {
		header += 8
	}
	if masked {
		header += 4
	}
	return header
}

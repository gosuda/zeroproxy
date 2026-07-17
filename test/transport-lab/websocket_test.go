package transportlab

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

const webSocketFixtureTimeout = time.Second

func startTargetWebSocketFixture(t *testing.T, scenario TargetWebSocketScenario) *TCPServer {
	t.Helper()
	handler, err := NewTargetWebSocketHandler(scenario)
	if err != nil {
		t.Fatal(err)
	}
	server := NewTCP(handler)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func dialTargetWebSocketFixture(t *testing.T, server *TCPServer) (net.Conn, *bufio.Reader) {
	t.Helper()
	connection, err := net.DialTimeout("tcp", server.Address(), webSocketFixtureTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(webSocketFixtureTimeout)); err != nil {
		_ = connection.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if _, err := io.WriteString(connection, "GET /socket HTTP/1.1\r\nHost: fixture.test\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	return connection, bufio.NewReader(connection)
}

func readWebSocketFixtureHeader(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var header bytes.Buffer
	for header.Len() < MaxWebSocketHandshakeBytes {
		value, err := reader.ReadByte()
		if err != nil {
			t.Fatal(err)
		}
		header.WriteByte(value)
		if strings.HasSuffix(header.String(), "\r\n\r\n") {
			return header.String()
		}
	}
	t.Fatal("WebSocket response header exceeded bound")
	return ""
}

type fixtureWebSocketFrame struct {
	FIN     bool
	Opcode  byte
	Masked  bool
	Payload []byte
}

func readFixtureWebSocketFrame(t *testing.T, reader *bufio.Reader) fixtureWebSocketFrame {
	t.Helper()
	first, err := reader.ReadByte()
	if err != nil {
		t.Fatal(err)
	}
	second, err := reader.ReadByte()
	if err != nil {
		t.Fatal(err)
	}
	frame := fixtureWebSocketFrame{FIN: first&0x80 != 0, Opcode: first & 0x0f, Masked: second&0x80 != 0}
	length := uint64(second & 0x7f)
	switch length {
	case 126:
		var encoded [2]byte
		if _, err := io.ReadFull(reader, encoded[:]); err != nil {
			t.Fatal(err)
		}
		length = uint64(encoded[0])<<8 | uint64(encoded[1])
	case 127:
		var encoded [8]byte
		if _, err := io.ReadFull(reader, encoded[:]); err != nil {
			t.Fatal(err)
		}
		for _, value := range encoded {
			length = length<<8 | uint64(value)
		}
	}
	if length > MaxWebSocketFrameBytes {
		t.Fatalf("fixture frame declared %d bytes", length)
	}
	var key [4]byte
	if frame.Masked {
		if _, err := io.ReadFull(reader, key[:]); err != nil {
			t.Fatal(err)
		}
	}
	frame.Payload = make([]byte, int(length))
	if _, err := io.ReadFull(reader, frame.Payload); err != nil {
		t.Fatal(err)
	}
	if frame.Masked {
		for index := range frame.Payload {
			frame.Payload[index] ^= key[index%len(key)]
		}
	}
	return frame
}

func assertSuccessfulWebSocketUpgrade(t *testing.T, reader *bufio.Reader) {
	t.Helper()
	header := readWebSocketFixtureHeader(t, reader)
	if header != "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n" {
		t.Fatalf("upgrade response = %q", header)
	}
}

func TestTargetWebSocketValidUpgradeFragmentedFramesAndClose(t *testing.T) {
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{
		Frames: []TargetWebSocketFrame{
			{FIN: false, Opcode: 1, Payload: []byte("hel")},
			{FIN: true, Opcode: 0, Payload: []byte("lo")},
		},
		Close: &TargetWebSocketClose{Code: 1000, Reason: "done"},
	})
	_, reader := dialTargetWebSocketFixture(t, server)
	assertSuccessfulWebSocketUpgrade(t, reader)

	first := readFixtureWebSocketFrame(t, reader)
	if first.FIN || first.Opcode != 1 || first.Masked || !bytes.Equal(first.Payload, []byte("hel")) {
		t.Fatalf("first fragmented frame = %#v", first)
	}
	second := readFixtureWebSocketFrame(t, reader)
	if !second.FIN || second.Opcode != 0 || second.Masked || !bytes.Equal(second.Payload, []byte("lo")) {
		t.Fatalf("second fragmented frame = %#v", second)
	}
	closeFrame := readFixtureWebSocketFrame(t, reader)
	if closeFrame.Opcode != 8 || !closeFrame.FIN || closeFrame.Masked || !bytes.Equal(closeFrame.Payload, []byte{0x03, 0xe8, 'd', 'o', 'n', 'e'}) {
		t.Fatalf("close frame = %#v", closeFrame)
	}
}

func TestTargetWebSocketSendsMalformedUpgrade(t *testing.T) {
	malformed := []byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n")
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{MalformedUpgrade: malformed})
	_, reader := dialTargetWebSocketFixture(t, server)

	if got := readWebSocketFixtureHeader(t, reader); got != string(malformed) {
		t.Fatalf("malformed upgrade = %q", got)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("malformed upgrade left scripted frame bytes: %v", err)
	}
}

func TestTargetWebSocketSendsMaskedTargetFrame(t *testing.T) {
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{Frames: []TargetWebSocketFrame{{
		FIN:     true,
		Opcode:  1,
		Payload: []byte("masked target"),
		Masked:  true,
		MaskKey: [4]byte{1, 2, 3, 4},
	}}})
	_, reader := dialTargetWebSocketFixture(t, server)
	assertSuccessfulWebSocketUpgrade(t, reader)

	frame := readFixtureWebSocketFrame(t, reader)
	if !frame.Masked || frame.Opcode != 1 || !frame.FIN || !bytes.Equal(frame.Payload, []byte("masked target")) {
		t.Fatalf("masked target frame = %#v", frame)
	}
}

func TestTargetWebSocketSendsControlOverflow(t *testing.T) {
	payload := bytes.Repeat([]byte{'x'}, 126)
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{Frames: []TargetWebSocketFrame{{FIN: true, Opcode: 9, Payload: payload}}})
	_, reader := dialTargetWebSocketFixture(t, server)
	assertSuccessfulWebSocketUpgrade(t, reader)

	frame := readFixtureWebSocketFrame(t, reader)
	if frame.Opcode != 9 || !frame.FIN || frame.Masked || !bytes.Equal(frame.Payload, payload) {
		t.Fatalf("oversized control frame = %#v", frame)
	}
}

func TestTargetWebSocketSlowlorisDelaysRawFrameBytes(t *testing.T) {
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{Slowloris: &TargetWebSocketSlowloris{
		Bytes:      []byte{0x81, 0x02, 'o', 'k'},
		ChunkBytes: 1,
		Delay:      80 * time.Millisecond,
	}})
	connection, reader := dialTargetWebSocketFixture(t, server)
	assertSuccessfulWebSocketUpgrade(t, reader)

	first, err := reader.ReadByte()
	if err != nil || first != 0x81 {
		t.Fatalf("slowloris first byte = %x, %v", first, err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(10 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("slowloris did not delay its next byte")
	} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatalf("slowloris read error = %v, want timeout", err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(webSocketFixtureTimeout)); err != nil {
		t.Fatal(err)
	}
	remaining := make([]byte, 3)
	if _, err := io.ReadFull(reader, remaining); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(remaining, []byte{0x02, 'o', 'k'}) {
		t.Fatalf("slowloris remaining bytes = %x", remaining)
	}
}

func TestTargetWebSocketScenarioBounds(t *testing.T) {
	maximumFrame := make([]byte, MaxWebSocketFrameBytes)
	for name, scenario := range map[string]TargetWebSocketScenario{
		"frame count": {Frames: make([]TargetWebSocketFrame, MaxWebSocketFrameCount+1)},
		"frame bytes": {Frames: []TargetWebSocketFrame{{Payload: make([]byte, MaxWebSocketFrameBytes+1)}}},
		"script bytes": {Frames: []TargetWebSocketFrame{
			{Payload: maximumFrame}, {Payload: maximumFrame}, {Payload: maximumFrame}, {Payload: maximumFrame}, {Payload: maximumFrame},
		}},
		"slowloris chunks":   {Slowloris: &TargetWebSocketSlowloris{Bytes: make([]byte, MaxWebSocketSlowlorisChunks+1), ChunkBytes: 1}},
		"slowloris duration": {Slowloris: &TargetWebSocketSlowloris{Bytes: []byte{1, 2}, ChunkBytes: 1, Delay: MaxWebSocketSlowlorisDuration + time.Nanosecond}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewTargetWebSocketHandler(scenario); err == nil {
				t.Fatal("unbounded WebSocket script was accepted")
			}
		})
	}
}

func TestTargetWebSocketRejectsOversizedUpgrade(t *testing.T) {
	server := startTargetWebSocketFixture(t, TargetWebSocketScenario{})
	connection, err := net.DialTimeout("tcp", server.Address(), webSocketFixtureTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if err := connection.SetDeadline(time.Now().Add(webSocketFixtureTimeout)); err != nil {
		t.Fatal(err)
	}
	request := "GET /socket HTTP/1.1\r\nHost: fixture.test\r\nX-Fill: " + strings.Repeat("x", MaxWebSocketHandshakeBytes) + "\r\n\r\n"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatal(err)
	}
	var response [1]byte
	if count, _ := connection.Read(response[:]); count != 0 {
		t.Fatalf("oversized upgrade emitted response byte %x", response[0])
	}
}

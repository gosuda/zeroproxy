package wsproto

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/zphttp"
)

func TestConnFramesPreserveOrderAndPayloadIntegrity(t *testing.T) {
	client, server := net.Pipe()
	conn := &Conn{c: client}
	defer conn.Close()

	const frames = 128
	payloads := make([][]byte, frames)
	for i := range payloads {
		payloads[i] = []byte(fmt.Sprintf("frame-%03d-%s", i, bytes.Repeat([]byte{byte('a' + i%26)}, i%31+1)))
	}

	serverDone := make(chan error, 1)
	go func() {
		defer server.Close()
		for i, want := range payloads {
			op, got, err := readClientFrame(server)
			if err != nil {
				serverDone <- err
				return
			}
			wantOp := byte(OpText)
			if i%2 == 1 {
				wantOp = OpBinary
			}
			if op != wantOp || !bytes.Equal(got, want) {
				serverDone <- fmt.Errorf("frame %d op/payload = %x/%q, want %x/%q", i, op, got, wantOp, want)
				return
			}
			if err := writeServerFrame(server, op, got); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()

	for i, payload := range payloads {
		op := byte(OpText)
		if i%2 == 1 {
			op = OpBinary
		}
		if err := conn.WriteFrame(op, payload); err != nil {
			t.Fatal(err)
		}
		gotOp, got, err := conn.ReadFrame(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if gotOp != op || !bytes.Equal(got, payload) {
			t.Fatalf("echo %d op/payload = %x/%q, want %x/%q", i, gotOp, got, op, payload)
		}
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// TestReadFrameRejectsOversizedFrameWithoutAllocating asserts the 64-bit length
// guard (client.go readOne ~:184) fails closed BEFORE make([]byte, l): an
// oversized declared payload is rejected as POLICY_BLOCKED with no allocation and
// no payload read. Two declared lengths are required because they kill
// mutually-exclusive regressions (proven by mutation testing):
//   - 64<<20+1 catches a raised/weakened cap (e.g. l > 1<<62): the guard must
//     still reject one byte over the real 64 MiB limit.
//   - math.MaxUint64 catches the guard being moved AFTER make([]byte, l):
//     make([]byte, MaxUint64) raises a RECOVERABLE "makeslice: len out of range"
//     panic, so a recover() that fires proves allocation was attempted before the
//     guard — a fail-closed violation. A clean POLICY_BLOCKED return is the pass.
//
// Only the 10-byte header is written (no payload); on correct production the guard
// fires before any ReadFull, so the deadline is never hit.
func TestReadFrameRejectsOversizedFrameWithoutAllocating(t *testing.T) {
	for _, tc := range []struct {
		name string
		l    uint64
	}{
		{"one byte over cap", uint64(64<<20) + 1},
		{"max uint64 (guard must precede make)", math.MaxUint64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			conn := &Conn{c: client}
			// Deadlines turn a regression (blocked ReadFull) into a fast red
			// instead of a hang; correct production fires the guard first.
			deadline := time.Now().Add(2 * time.Second)
			_ = client.SetDeadline(deadline)
			_ = server.SetDeadline(deadline)

			go func() {
				defer server.Close()
				var hdr [10]byte
				hdr[0] = 0x80 | OpBinary
				hdr[1] = 127
				binary.BigEndian.PutUint64(hdr[2:], tc.l)
				_, _ = server.Write(hdr[:]) // header only; NO payload follows.
			}()

			// A makeslice panic means make([]byte, l) ran before the guard —
			// the oversized frame was allocated before being rejected.
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("oversized frame allocated before guard (fail-closed: guard must precede make([]byte, l)): %v", r)
				}
			}()

			op, payload, err := conn.ReadFrame(context.Background())
			if err == nil {
				t.Fatalf("oversized frame accepted: op=%x len=%d (fail-closed violated)", op, len(payload))
			}
			if !strings.Contains(err.Error(), "POLICY_BLOCKED") {
				t.Fatalf("oversized frame error = %v, want POLICY_BLOCKED", err)
			}
			if op != 0 || payload != nil {
				t.Fatalf("oversized frame passed data through: op=%x payload=%q (must not tunnel)", op, payload)
			}
		})
	}
}

// TestReadFrameRejectsUnsupportedOpcode asserts the default branch (client.go
// ReadFrame ~:113-114) fails closed for opcodes the proxy does not understand
// (0x3, 0x7). A silent passthrough here would let an attacker smuggle frames the
// membrane never inspected; the contract is POLICY_BLOCKED + no data tunneled.
func TestReadFrameRejectsUnsupportedOpcode(t *testing.T) {
	for _, op := range []byte{0x3, 0x7} {
		t.Run(fmt.Sprintf("opcode_0x%x", op), func(t *testing.T) {
			client, server := net.Pipe()
			conn := &Conn{c: client}
			deadline := time.Now().Add(2 * time.Second)
			_ = client.SetDeadline(deadline)
			_ = server.SetDeadline(deadline)

			go func() {
				defer server.Close()
				// A fully-formed, fin, unmasked frame carrying a small payload — the
				// frame is well-formed; only the opcode is unsupported.
				_ = writeServerFrame(server, op, []byte("smuggled"))
			}()

			gotOp, payload, err := conn.ReadFrame(context.Background())
			if err == nil {
				t.Fatalf("unsupported opcode 0x%x accepted: op=%x (silent passthrough)", op, gotOp)
			}
			if !strings.Contains(err.Error(), "POLICY_BLOCKED") {
				t.Fatalf("unsupported opcode error = %v, want POLICY_BLOCKED", err)
			}
			if gotOp != 0 || payload != nil {
				t.Fatalf("unsupported opcode passed data through: op=%x payload=%q", gotOp, payload)
			}
		})
	}
}

// TestReadFramePingTriggersMaskedPongThenContinues asserts client.go ReadFrame
// ~:101-102: a Ping is answered with an auto-emitted Pong that MUST be masked
// (client→server frames are always masked per RFC6455), and ReadFrame then keeps
// reading and delivers the following data frame. readClientFrame asserts the mask
// bit, so an unmasked Pong fails the read.
func TestReadFramePingTriggersMaskedPongThenContinues(t *testing.T) {
	client, server := net.Pipe()
	conn := &Conn{c: client}
	deadline := time.Now().Add(2 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	serverDone := make(chan error, 1)
	go func() {
		defer server.Close()
		// net.Pipe is synchronous: send Ping, then READ the client's Pong before
		// writing the data frame, or both sides deadlock.
		if err := writeServerFrame(server, OpPing, []byte("hb")); err != nil {
			serverDone <- err
			return
		}
		pop, ppayload, err := readClientFrame(server) // asserts masked at line 79-80.
		if err != nil {
			serverDone <- fmt.Errorf("reading auto-pong: %w", err)
			return
		}
		if pop != OpPong {
			serverDone <- fmt.Errorf("auto-reply op = 0x%x, want OpPong 0x%x", pop, OpPong)
			return
		}
		if !bytes.Equal(ppayload, []byte("hb")) {
			serverDone <- fmt.Errorf("pong payload = %q, want %q", ppayload, "hb")
			return
		}
		if err := writeServerFrame(server, OpText, []byte("after-ping")); err != nil {
			serverDone <- err
			return
		}
		serverDone <- nil
	}()

	op, payload, err := conn.ReadFrame(context.Background())
	if err != nil {
		t.Fatalf("ReadFrame after ping: %v", err)
	}
	if op != OpText || !bytes.Equal(payload, []byte("after-ping")) {
		t.Fatalf("post-ping frame op/payload = 0x%x/%q, want Text/%q", op, payload, "after-ping")
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// TestReadFrameReassemblesFragmentedMessage asserts client.go ~:108-118: a
// non-fin Text frame followed by a fin Continuation frame is reassembled in order
// into a single Text message. writeServerFrame forces fin=1, so we emit the raw
// frame bytes ourselves to control the FIN bit.
func TestReadFrameReassemblesFragmentedMessage(t *testing.T) {
	client, server := net.Pipe()
	conn := &Conn{c: client}
	deadline := time.Now().Add(2 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	go func() {
		defer server.Close()
		// Frame 1: opcode Text, FIN=0, payload "hello-".
		_, _ = server.Write(writeRawServerFrame(false, OpText, []byte("hello-")))
		// Frame 2: opcode Continuation, FIN=1, payload "world".
		_, _ = server.Write(writeRawServerFrame(true, OpContinuation, []byte("world")))
	}()

	op, payload, err := conn.ReadFrame(context.Background())
	if err != nil {
		t.Fatalf("ReadFrame fragmented: %v", err)
	}
	if op != OpText {
		t.Fatalf("reassembled op = 0x%x, want Text 0x%x", op, OpText)
	}
	if !bytes.Equal(payload, []byte("hello-world")) {
		t.Fatalf("reassembled payload = %q, want %q", payload, "hello-world")
	}
}

// TestReadFrameClosePropagatesOpClose asserts client.go ~:106-107: a Close frame
// surfaces to the caller as OpClose (so the proxy can tear the tunnel down) rather
// than being swallowed or mistaken for data.
func TestReadFrameClosePropagatesOpClose(t *testing.T) {
	client, server := net.Pipe()
	conn := &Conn{c: client}
	deadline := time.Now().Add(2 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)

	// RFC6455 Close payload: 2-byte status code (1000) + reason.
	closePayload := append([]byte{0x03, 0xe8}, []byte("bye")...)
	go func() {
		defer server.Close()
		_ = writeServerFrame(server, OpClose, closePayload)
	}()

	op, payload, err := conn.ReadFrame(context.Background())
	if err != nil {
		t.Fatalf("ReadFrame close: %v", err)
	}
	if op != OpClose {
		t.Fatalf("close op = 0x%x, want OpClose 0x%x", op, OpClose)
	}
	if !bytes.Equal(payload, closePayload) {
		t.Fatalf("close payload = %q, want %q", payload, closePayload)
	}
}

// TestDialFailsClosedOnBadUpgrade asserts the handshake validation in Dial
// (client.go ~:79-88) fails closed. Three peers that do NOT complete a valid
// RFC6455 upgrade — a 200 (not 101), a 101 with a wrong Sec-WebSocket-Accept, and
// a 101 with the Accept header absent — must each yield TARGET_CONNECT_FAILED and
// a nil *Conn, so no tunnel is ever established over an unverified peer.
func TestDialFailsClosedOnBadUpgrade(t *testing.T) {
	target, _ := url.Parse("ws://example.com/socket")

	cases := []struct {
		name       string
		respond    func(server net.Conn, key string)
		wantSuffix string
	}{
		{
			name: "status_200_not_101",
			respond: func(server net.Conn, key string) {
				_, _ = server.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"))
			},
			wantSuffix: "websocket upgrade failed",
		},
		{
			name: "101_wrong_accept",
			respond: func(server net.Conn, key string) {
				_, _ = server.Write([]byte(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"Upgrade: websocket\r\n" +
						"Connection: Upgrade\r\n" +
						"Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n"))
			},
			wantSuffix: "websocket accept mismatch",
		},
		{
			name: "101_absent_accept",
			respond: func(server net.Conn, key string) {
				_, _ = server.Write([]byte(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"Upgrade: websocket\r\n" +
						"Connection: Upgrade\r\n\r\n"))
			},
			wantSuffix: "websocket accept mismatch",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := &dialPipeMux{streams: make(chan net.Conn, 1)}
			engine := &zphttp.Engine{Mux: mux}

			serverDone := make(chan error, 1)
			go func() {
				server := <-mux.streams
				defer server.Close()
				_ = server.SetDeadline(time.Now().Add(2 * time.Second))
				br := bufio.NewReader(server)
				if err := serveSOCKS5(server, br); err != nil {
					serverDone <- fmt.Errorf("socks5: %w", err)
					return
				}
				req, err := http.ReadRequest(br)
				if err != nil {
					serverDone <- fmt.Errorf("read upgrade request: %w", err)
					return
				}
				key := req.Header.Get("Sec-WebSocket-Key")
				if key == "" {
					serverDone <- fmt.Errorf("upgrade request missing Sec-WebSocket-Key")
					return
				}
				tc.respond(server, key)
				serverDone <- nil
			}()

			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			tab := &zphttp.TabState{StreamIsolationKey: []byte("0123456789abcdef0123456789abcdef")}
			conn, _, err := Dial(ctx, engine, target, nil, tab, "")

			if err == nil {
				t.Fatalf("bad upgrade accepted (fail-closed violated): conn=%v", conn)
			}
			if conn != nil {
				t.Fatalf("Dial returned non-nil Conn on bad upgrade: tunnel must not proceed")
			}
			if !strings.Contains(err.Error(), "TARGET_CONNECT_FAILED") {
				t.Fatalf("bad upgrade error = %v, want TARGET_CONNECT_FAILED", err)
			}
			if !strings.Contains(err.Error(), tc.wantSuffix) {
				t.Fatalf("bad upgrade error = %v, want suffix %q", err, tc.wantSuffix)
			}
			if serr := <-serverDone; serr != nil {
				t.Fatal(serr)
			}
		})
	}
}

// dialPipeMux hands each OpenStream caller one end of a net.Pipe and surfaces the
// other end on streams, mirroring zphttp's own pipeMux test helper so Dial drives
// the real SOCKS5 → HTTP upgrade path instead of a mock.
type dialPipeMux struct {
	streams chan net.Conn
}

func (m *dialPipeMux) OpenStream(context.Context) (net.Conn, error) {
	client, server := net.Pipe()
	m.streams <- server
	return client, nil
}

// serveSOCKS5 plays the minimal SOCKS5 server side (greeting → username/password
// auth → CONNECT reply) that socks5.ConnectDomain expects, consuming the request
// bytes without recoupling to the token length. The byte sequence mirrors
// zphttp/roundtrip_test.go's pipeMux handler.
func serveSOCKS5(server net.Conn, br *bufio.Reader) error {
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(br, greeting); err != nil {
		return err
	}
	if greeting[0] != 0x05 {
		return fmt.Errorf("socks5 greeting version = 0x%02x", greeting[0])
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(br, methods); err != nil {
		return err
	}
	// Select username/password auth (0x02).
	if _, err := server.Write([]byte{0x05, 0x02}); err != nil {
		return err
	}
	authHead := make([]byte, 2) // version + username length
	if _, err := io.ReadFull(br, authHead); err != nil {
		return err
	}
	user := make([]byte, int(authHead[1]))
	if _, err := io.ReadFull(br, user); err != nil {
		return err
	}
	passLen, err := br.ReadByte()
	if err != nil {
		return err
	}
	pass := make([]byte, int(passLen))
	if _, err := io.ReadFull(br, pass); err != nil {
		return err
	}
	if _, err := server.Write([]byte{0x01, 0x00}); err != nil { // auth success
		return err
	}
	reqHead := make([]byte, 5) // ver, cmd, rsv, atyp, domainlen
	if _, err := io.ReadFull(br, reqHead); err != nil {
		return err
	}
	if reqHead[3] != 0x03 {
		return fmt.Errorf("socks5 atyp = 0x%02x, want DOMAINNAME", reqHead[3])
	}
	host := make([]byte, int(reqHead[4]))
	if _, err := io.ReadFull(br, host); err != nil {
		return err
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(br, port); err != nil {
		return err
	}
	// CONNECT success reply with a zero IPv4 BND.ADDR.
	_, err = server.Write([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00})
	return err
}

func readClientFrame(r io.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	if h[0]&0x80 == 0 {
		return 0, nil, fmt.Errorf("fragmented client frame")
	}
	op := h[0] & 0x0f
	if h[1]&0x80 == 0 {
		return 0, nil, fmt.Errorf("unmasked client frame")
	}
	l := uint64(h[1] & 0x7f)
	if l == 126 {
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		l = uint64(binary.BigEndian.Uint16(b[:]))
	} else if l == 127 {
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		l = binary.BigEndian.Uint64(b[:])
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, l)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return op, payload, nil
}

func writeServerFrame(w io.Writer, op byte, payload []byte) error {
	_, err := w.Write(writeRawServerFrame(true, op, payload))
	return err
}

// writeRawServerFrame builds an unmasked server→client frame with an explicit FIN
// bit, so tests can emit non-final fragments that writeServerFrame (always FIN=1)
// cannot express.
func writeRawServerFrame(fin bool, op byte, payload []byte) []byte {
	var hdr [10]byte
	hdr[0] = op & 0x0f
	if fin {
		hdr[0] |= 0x80
	}
	n := 2
	switch l := len(payload); {
	case l < 126:
		hdr[1] = byte(l)
	case l <= 65535:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:], uint16(l))
		n = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(l))
		n = 10
	}
	return append(hdr[:n], payload...)
}

package wsproto

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"testing"
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
	var hdr [10]byte
	hdr[0] = 0x80 | (op & 0x0f)
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
	if _, err := w.Write(hdr[:n]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

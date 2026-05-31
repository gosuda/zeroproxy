package wsproto

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/gosuda/zeroproxy/internal/zphttp"
)

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

type Conn struct {
	c  net.Conn
	mu sync.Mutex
}

//nolint:cyclop // TODO(complexity): WebSocket dial (cyclop 13); performs the RFC6455 handshake (key gen, header construction, 101 validation). Protocol-critical; needs dedicated differential-harness decomposition.
func Dial(ctx context.Context, engine *zphttp.Engine, target *url.URL, protocols []string, tab *zphttp.TabState, origin string) (*Conn, *http.Response, error) {
	if target.Scheme != "ws" && target.Scheme != "wss" {
		return nil, nil, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	httpURL := *target
	if target.Scheme == "ws" {
		httpURL.Scheme = "http"
	} else {
		httpURL.Scheme = "https"
	}
	c, err := engine.DialTarget(ctx, &httpURL, tab)
	if err != nil {
		return nil, nil, err
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = c.Close()
		return nil, nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	req := &http.Request{Method: http.MethodGet, URL: &httpURL, Header: make(http.Header), Host: httpURL.Host, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	req.Header.Set("User-Agent", zphttp.TargetUserAgent)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if len(protocols) > 0 {
		req.Header.Set("Sec-WebSocket-Protocol", strings.Join(protocols, ", "))
	}
	if err := req.Write(c); err != nil {
		_ = c.Close()
		return nil, nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), req)
	if err != nil {
		_ = c.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols || !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		_ = c.Close()
		_ = resp.Body.Close()
		return nil, resp, fmt.Errorf("TARGET_CONNECT_FAILED: websocket upgrade failed")
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		_ = c.Close()
		_ = resp.Body.Close()
		return nil, resp, fmt.Errorf("TARGET_CONNECT_FAILED: websocket accept mismatch")
	}
	return &Conn{c: c}, resp, nil
}

func (c *Conn) ReadFrame(ctx context.Context) (byte, []byte, error) {
	var message []byte
	var msgOp byte
	for {
		op, fin, payload, err := c.readOne(ctx)
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			_ = c.WriteFrame(OpPong, payload)
			continue
		case OpPong:
			continue
		case OpClose:
			return OpClose, payload, nil
		case OpText, OpBinary:
			msgOp = op
			message = append(message[:0], payload...)
		case OpContinuation:
			message = append(message, payload...)
		default:
			return 0, nil, fmt.Errorf("POLICY_BLOCKED: unsupported websocket opcode")
		}
		if fin {
			return msgOp, message, nil
		}
	}
}

func (c *Conn) WriteFrame(op byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var hdr [14]byte
	hdr[0] = 0x80 | (op & 0x0f)
	maskBit := byte(0x80)
	n := 2
	l := len(payload)
	if l < 126 {
		hdr[1] = maskBit | byte(l)
	} else if l <= 65535 {
		hdr[1] = maskBit | 126
		binary.BigEndian.PutUint16(hdr[2:], uint16(l))
		n = 4
	} else {
		hdr[1] = maskBit | 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(l))
		n = 10
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	copy(hdr[n:], mask[:])
	n += 4
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	if _, err := c.c.Write(hdr[:n]); err != nil {
		return err
	}
	_, err := c.c.Write(masked)
	return err
}

func (c *Conn) Close() error { _ = c.WriteFrame(OpClose, nil); return c.c.Close() }

//nolint:cyclop // TODO(complexity): WebSocket frame reader (cyclop 12); decodes the RFC6455 frame header (FIN/opcode/mask/length variants). Protocol byte-parser; needs dedicated differential-harness decomposition.
func (c *Conn) readOne(ctx context.Context) (op byte, fin bool, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(ctxReader{ctx: ctx, r: c.c}, h[:]); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	op = h[0] & 0x0f
	masked := h[1]&0x80 != 0
	l := uint64(h[1] & 0x7f)
	if l == 126 {
		var b [2]byte
		if _, err = io.ReadFull(ctxReader{ctx: ctx, r: c.c}, b[:]); err != nil {
			return
		}
		l = uint64(binary.BigEndian.Uint16(b[:]))
	}
	if l == 127 {
		var b [8]byte
		if _, err = io.ReadFull(ctxReader{ctx: ctx, r: c.c}, b[:]); err != nil {
			return
		}
		l = binary.BigEndian.Uint64(b[:])
	}
	if l > 64<<20 {
		err = fmt.Errorf("POLICY_BLOCKED: websocket frame too large")
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(ctxReader{ctx: ctx, r: c.c}, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, l)
	if _, err = io.ReadFull(ctxReader{ctx: ctx, r: c.c}, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + guid))
	return base64.StdEncoding.EncodeToString(h[:])
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (r ctxReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

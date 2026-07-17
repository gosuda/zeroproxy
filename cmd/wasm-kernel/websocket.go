package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"golang.org/x/net/http/httpguts"
	"io"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	webSocketText         byte = 0x1
	webSocketBinary       byte = 0x2
	webSocketClose        byte = 0x8
	webSocketPing         byte = 0x9
	webSocketPong         byte = 0xa
	webSocketContinuation byte = 0x0

	defaultWebSocketMessageBytes = defaultQueueBytes
	defaultWebSocketQueueItems   = defaultQueueChunks
)

const webSocketCloseTimeout = 5 * time.Second

var (
	errWebSocketClosed       = errors.New("websocket closed")
	errWebSocketProtocol     = errors.New("websocket protocol error")
	errWebSocketMessageLimit = errors.New("websocket message limit")
)

type webSocketFrame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readWebSocketFrame validates RFC 6455 framing before it lets a target byte
// reach the browser-facing stream. Target frames are never allowed to be
// masked; accepting one would make the target framing ambiguous with a carrier
// implementation error.
func readWebSocketFrame(r io.Reader, maxPayload int, requireMasked bool) (webSocketFrame, error) {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return webSocketFrame{}, err
	}
	frame, masked, err := parseWebSocketFrameHeader(header, requireMasked)
	if err != nil {
		return webSocketFrame{}, err
	}
	marker := header[1] & 0x7f
	length, err := readWebSocketFrameLength(r, marker)
	if err != nil {
		return webSocketFrame{}, err
	}
	if (marker == 126 && length < 126) || (marker == 127 && length <= 0xffff) {
		return webSocketFrame{}, errWebSocketProtocol
	}
	if err := validateInboundWebSocketFrame(frame, length, maxPayload); err != nil {
		return webSocketFrame{}, err
	}
	payload, err := readWebSocketFramePayload(r, int(length), masked)
	if err != nil {
		return webSocketFrame{}, err
	}
	frame.payload = payload
	return frame, nil
}

func parseWebSocketFrameHeader(header [2]byte, requireMasked bool) (webSocketFrame, bool, error) {
	if header[0]&0x70 != 0 {
		return webSocketFrame{}, false, errWebSocketProtocol
	}
	frame := webSocketFrame{fin: header[0]&0x80 != 0, opcode: header[0] & 0x0f}
	masked := header[1]&0x80 != 0
	if masked != requireMasked || !validWebSocketOpcode(frame.opcode) {
		return webSocketFrame{}, false, errWebSocketProtocol
	}
	return frame, masked, nil
}

func validWebSocketOpcode(opcode byte) bool {
	switch opcode {
	case webSocketContinuation, webSocketText, webSocketBinary, webSocketClose, webSocketPing, webSocketPong:
		return true
	default:
		return false
	}
}

func validWebSocketHandshakeHeaders(header http.Header) bool {
	if len(header) > 128 {
		return false
	}
	bytes := 0
	for name, values := range header {
		if !httpguts.ValidHeaderFieldName(name) || len(values) > 8 {
			return false
		}
		bytes += len(name)
		for _, value := range values {
			if !httpguts.ValidHeaderFieldValue(value) {
				return false
			}
			bytes += len(value)
		}
		if bytes > 64<<10 {
			return false
		}
	}
	return len(header.Values("Sec-WebSocket-Accept")) == 1 &&
		len(header.Values("Sec-WebSocket-Protocol")) <= 1 &&
		len(header.Values("Sec-WebSocket-Extensions")) <= 1
}

func readWebSocketFrameLength(r io.Reader, marker byte) (uint64, error) {
	switch marker {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			return 0, err
		}
		return uint64(binary.BigEndian.Uint16(extended[:])), nil
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			return 0, err
		}
		length := binary.BigEndian.Uint64(extended[:])
		if length&(uint64(1)<<63) != 0 {
			return 0, errWebSocketProtocol
		}
		return length, nil
	default:
		return uint64(marker), nil
	}
}

func validateInboundWebSocketFrame(frame webSocketFrame, length uint64, maxPayload int) error {
	if maxPayload <= 0 || length > uint64(maxPayload) {
		return errWebSocketMessageLimit
	}
	if frame.opcode >= webSocketClose && (!frame.fin || length > 125) {
		return errWebSocketProtocol
	}
	return nil
}

func readWebSocketFramePayload(r io.Reader, length int, masked bool) ([]byte, error) {
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return payload, nil
}

func writeAll(w io.Writer, bytes []byte) error {
	for len(bytes) != 0 {
		written, err := w.Write(bytes)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		bytes = bytes[written:]
	}
	return nil
}

func writeWebSocketFrame(w io.Writer, frame webSocketFrame, masked bool) error {
	header, err := encodeWebSocketFrameHeader(frame, masked)
	if err != nil {
		return err
	}
	if err := writeAll(w, header); err != nil {
		return err
	}
	return writeWebSocketFramePayload(w, frame.payload, masked)
}

func encodeWebSocketFrameHeader(frame webSocketFrame, masked bool) ([]byte, error) {
	if frame.opcode >= webSocketClose && (!frame.fin || len(frame.payload) > 125) {
		return nil, errWebSocketProtocol
	}
	if len(frame.payload) > defaultWebSocketMessageBytes {
		return nil, errWebSocketMessageLimit
	}
	first := frame.opcode
	if frame.fin {
		first |= 0x80
	}
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	return appendWebSocketFrameLength([]byte{first}, len(frame.payload), maskBit), nil
}

func appendWebSocketFrameLength(header []byte, length int, maskBit byte) []byte {
	switch {
	case length < 126:
		return append(header, maskBit|byte(length))
	case length <= 0xffff:
		return append(header, maskBit|126, byte(length>>8), byte(length))
	default:
		return append(header, maskBit|127, 0, 0, 0, 0, byte(uint64(length)>>24), byte(uint64(length)>>16), byte(uint64(length)>>8), byte(length))
	}
}

func writeWebSocketFramePayload(w io.Writer, payload []byte, masked bool) error {
	if !masked {
		return writeAll(w, payload)
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	maskedPayload := make([]byte, len(payload))
	for i := range payload {
		maskedPayload[i] = payload[i] ^ mask[i&3]
	}
	if err := writeAll(w, mask[:]); err != nil {
		return err
	}
	return writeAll(w, maskedPayload)
}

func writeWebSocketMessage(w io.Writer, opcode byte, payload []byte, maxFrame int) error {
	maxFrame, err := validateWebSocketMessage(opcode, payload, maxFrame)
	if err != nil {
		return err
	}
	if len(payload) == 0 {
		return writeWebSocketFrame(w, webSocketFrame{fin: true, opcode: opcode}, true)
	}
	return writeWebSocketMessageFragments(w, opcode, payload, maxFrame)
}

func validateWebSocketMessage(opcode byte, payload []byte, maxFrame int) (int, error) {
	if opcode != webSocketText && opcode != webSocketBinary {
		return 0, errWebSocketProtocol
	}
	if len(payload) > defaultWebSocketMessageBytes {
		return 0, errWebSocketMessageLimit
	}
	if maxFrame <= 0 || maxFrame > defaultStreamChunkBytes {
		return defaultStreamChunkBytes, nil
	}
	return maxFrame, nil
}

func writeWebSocketMessageFragments(w io.Writer, opcode byte, payload []byte, maxFrame int) error {
	for offset := 0; offset < len(payload); {
		end := min(offset+maxFrame, len(payload))
		frameOpcode := opcode
		if offset != 0 {
			frameOpcode = webSocketContinuation
		}
		if err := writeWebSocketFrame(w, webSocketFrame{fin: end == len(payload), opcode: frameOpcode, payload: payload[offset:end]}, true); err != nil {
			return err
		}
		offset = end
	}
	return nil
}

type serializedWebSocketWriter struct {
	writer   io.Writer
	maxFrame int
	mu       sync.Mutex
}

func (w *serializedWebSocketWriter) frame(frame webSocketFrame) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeWebSocketFrame(w.writer, frame, true)
}

func (w *serializedWebSocketWriter) message(opcode byte, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeWebSocketMessage(w.writer, opcode, payload, w.maxFrame)
}

type webSocketWriteDeadlineSetter interface {
	SetWriteDeadline(time.Time) error
}

func beginWebSocketCloseWriteDeadline(conn webSocketWriteDeadlineSetter, now time.Time) error {
	return conn.SetWriteDeadline(now.Add(webSocketCloseTimeout))
}

func validWebSocketCloseCode(code uint16) bool {
	return code == 1000 || code == 1001 || code == 1002 || code == 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
}

func encodeWebSocketClose(code uint16, reason string) ([]byte, error) {
	if code == 1005 && reason == "" {
		return nil, nil
	}
	if !validWebSocketCloseCode(code) || !utf8.ValidString(reason) || len(reason) > 123 {
		return nil, errWebSocketProtocol
	}
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload, code)
	copy(payload[2:], reason)
	return payload, nil
}

func decodeWebSocketClose(payload []byte) (uint16, string, error) {
	if len(payload) == 0 {
		return 1005, "", nil
	}
	if len(payload) == 1 {
		return 0, "", errWebSocketProtocol
	}
	code := binary.BigEndian.Uint16(payload[:2])
	reason := string(payload[2:])
	if !validWebSocketCloseCode(code) || !utf8.ValidString(reason) {
		return 0, "", errWebSocketProtocol
	}
	return code, reason, nil
}

type webSocketEventKind string

const (
	webSocketEventOpen    webSocketEventKind = "open"
	webSocketEventMessage webSocketEventKind = "message"
	webSocketEventError   webSocketEventKind = "error"
	webSocketEventClose   webSocketEventKind = "close"
)

type webSocketEvent struct {
	Kind       webSocketEventKind
	RequestID  string
	DataKind   string
	Data       []byte
	Protocol   string
	Code       uint16
	Reason     string
	WasClean   bool
	ErrorCode  string
	SetCookies []string
}

type webSocketOutbound struct {
	seq     uint64
	opcode  byte
	payload []byte
	close   bool
	code    uint16
	reason  string
	ack     chan error
}

type webSocketQueue struct {
	mu       sync.Mutex
	items    []webSocketOutbound
	bytes    int
	maxBytes int
	maxItems int
	closed   bool
	cause    error
	wake     chan struct{}
}

func newWebSocketQueue(maxBytes, maxItems int) *webSocketQueue {
	if maxBytes <= 0 {
		maxBytes = defaultQueueBytes
	}
	if maxItems <= 0 {
		maxItems = defaultWebSocketQueueItems
	}
	return &webSocketQueue{maxBytes: maxBytes, maxItems: maxItems, wake: make(chan struct{}, 1)}
}

func (q *webSocketQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *webSocketQueue) enqueue(item webSocketOutbound) (<-chan error, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return nil, causeOrClosed(q.cause)
	}
	if len(item.payload) > q.maxBytes || len(q.items) >= q.maxItems || q.bytes > q.maxBytes-len(item.payload) {
		return nil, newTransactionError("WEBSOCKET_SEND_QUEUE_FULL", "WEBSOCKET", true)
	}
	item.ack = make(chan error, 1)
	q.items = append(q.items, item)
	q.bytes += len(item.payload)
	q.signal()
	return item.ack, nil
}

func (q *webSocketQueue) dequeue(ctx context.Context) (webSocketOutbound, error) {
	for {
		q.mu.Lock()
		if len(q.items) != 0 {
			item := q.items[0]
			q.items = q.items[1:]
			q.bytes -= len(item.payload)
			q.mu.Unlock()
			return item, nil
		}
		if q.closed {
			cause := q.cause
			q.mu.Unlock()
			return webSocketOutbound{}, causeOrClosed(cause)
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return webSocketOutbound{}, errTransactionCanceled
		case <-q.wake:
		}
	}
}

func (q *webSocketQueue) close(cause error) {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed, q.cause = true, cause
	items := q.items
	q.items = nil
	q.bytes = 0
	q.mu.Unlock()
	for _, item := range items {
		item.ack <- causeOrClosed(cause)
	}
	q.signal()
}

func (q *webSocketQueue) usage() (int, int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes, len(q.items)
}

type webSocketState uint8

const (
	webSocketConnecting webSocketState = iota
	webSocketOpen
	webSocketClosing
	webSocketClosed
)

// webSocketTransaction owns only bounded message queues. Network code supplies
// the reader/writer loops, while this state machine guarantees a single close
// sequence even when cancellation and relay loss race.
type webSocketTransaction struct {
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	emit     func(webSocketEvent)
	outbound *webSocketQueue
	incoming chan webSocketEvent

	mu              sync.Mutex
	state           webSocketState
	nextSend        uint64
	terminal        *webSocketEvent
	opened          bool
	closeStarted    chan struct{}
	closeSignalOnce sync.Once
	closeOnce       sync.Once
	dispatchWG      sync.WaitGroup
}

func newWebSocketTransaction(id string, queueBytes, queueItems int, emit func(webSocketEvent)) *webSocketTransaction {
	ctx, cancel := context.WithCancel(context.Background())
	t := &webSocketTransaction{
		id: id, ctx: ctx, cancel: cancel, emit: emit,
		outbound:     newWebSocketQueue(queueBytes, queueItems),
		incoming:     make(chan webSocketEvent, queueItems),
		closeStarted: make(chan struct{}),
		state:        webSocketConnecting,
	}
	t.dispatchWG.Add(1)
	go t.dispatch()
	return t
}

func (t *webSocketTransaction) Context() context.Context      { return t.ctx }
func (t *webSocketTransaction) CloseStarted() <-chan struct{} { return t.closeStarted }

func (t *webSocketTransaction) open(protocol string, setCookies []string) error {
	t.mu.Lock()
	if t.state != webSocketConnecting {
		t.mu.Unlock()
		return newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	t.state, t.opened = webSocketOpen, true
	emit := t.emit
	t.mu.Unlock()
	if emit != nil {
		emit(webSocketEvent{Kind: webSocketEventOpen, RequestID: t.id, Protocol: protocol, SetCookies: setCookies})
	}
	return nil
}

func (t *webSocketTransaction) send(seq uint64, kind string, payload []byte) (<-chan error, error) {
	if kind != "text" && kind != "binary" || len(payload) > defaultWebSocketMessageBytes || (kind == "text" && !utf8.Valid(payload)) {
		return nil, newTransactionError("WEBSOCKET_MESSAGE_INVALID", "WEBSOCKET", false)
	}
	t.mu.Lock()
	if t.state != webSocketOpen {
		t.mu.Unlock()
		return nil, newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	if seq != t.nextSend {
		t.mu.Unlock()
		return nil, newTransactionError("WEBSOCKET_SEQUENCE", "WEBSOCKET", false)
	}
	opcode := webSocketBinary
	if kind == "text" {
		opcode = webSocketText
	}
	ack, err := t.outbound.enqueue(webSocketOutbound{seq: seq, opcode: opcode, payload: append([]byte(nil), payload...)})
	if err == nil {
		t.nextSend++
	}
	t.mu.Unlock()
	return ack, err
}

func (t *webSocketTransaction) close(code uint16, reason string) (<-chan error, error) {
	payload, err := encodeWebSocketClose(code, reason)
	if err != nil {
		return nil, newTransactionError("WEBSOCKET_CLOSE_INVALID", "WEBSOCKET", false)
	}
	t.mu.Lock()
	if t.state == webSocketClosed {
		t.mu.Unlock()
		return nil, newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	if t.state == webSocketClosing {
		t.mu.Unlock()
		return nil, newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	if t.state != webSocketOpen {
		t.mu.Unlock()
		return nil, newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	t.state = webSocketClosing
	t.closeSignalOnce.Do(func() { close(t.closeStarted) })
	ack, err := t.outbound.enqueue(webSocketOutbound{close: true, opcode: webSocketClose, payload: payload, code: code, reason: reason})
	t.mu.Unlock()
	return ack, err
}

func (t *webSocketTransaction) receive(kind string, payload []byte) error {
	if kind != "text" && kind != "binary" || len(payload) > defaultWebSocketMessageBytes || (kind == "text" && !utf8.Valid(payload)) {
		return newTransactionError("WEBSOCKET_MESSAGE_INVALID", "WEBSOCKET", false)
	}
	t.mu.Lock()
	open := t.state == webSocketOpen
	t.mu.Unlock()
	if !open {
		return newTransactionError("WEBSOCKET_STATE", "WEBSOCKET", false)
	}
	event := webSocketEvent{Kind: webSocketEventMessage, RequestID: t.id, DataKind: kind, Data: append([]byte(nil), payload...)}
	select {
	case t.incoming <- event:
		return nil
	case <-t.ctx.Done():
		return errTransactionCanceled
	}
}

func (t *webSocketTransaction) finish(code uint16, reason string, clean bool, errorCode string) bool {
	changed := false
	t.closeOnce.Do(func() {
		changed = true
		t.mu.Lock()
		t.state = webSocketClosed
		terminal := webSocketEvent{Kind: webSocketEventClose, RequestID: t.id, Code: code, Reason: reason, WasClean: clean, ErrorCode: errorCode}
		t.terminal = &terminal
		t.mu.Unlock()
		t.cancel()
		cause := errWebSocketClosed
		switch errorCode {
		case "RELAY_LOST":
			cause = newTransactionError("RELAY_LOST", "RELAY", true)
		case "RELAY_LOST_UNSAFE":
			cause = newTransactionError("RELAY_LOST_UNSAFE", "RELAY", false)
		case "CANCELED":
			cause = errTransactionCanceled
		}
		t.outbound.close(cause)
		close(t.incoming)
	})
	return changed
}

func (t *webSocketTransaction) cancelSocket() bool { return t.finish(1006, "", false, "CANCELED") }
func (t *webSocketTransaction) relayLost() bool    { return t.finish(1006, "", false, "RELAY_LOST") }

func (t *webSocketTransaction) dispatch() {
	defer t.dispatchWG.Done()
	for event := range t.incoming {
		if t.emit != nil {
			t.emit(event)
		}
	}
	t.mu.Lock()
	terminal := t.terminal
	emit, opened := t.emit, t.opened
	t.mu.Unlock()
	if terminal != nil && emit != nil {
		if terminal.ErrorCode != "" && terminal.ErrorCode != "CANCELED" {
			emit(webSocketEvent{Kind: webSocketEventError, RequestID: t.id, ErrorCode: terminal.ErrorCode})
		}
		if opened {
			emit(*terminal)
		}
	}
}

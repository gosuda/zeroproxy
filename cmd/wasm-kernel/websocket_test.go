package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

type shortWebSocketWriter struct{ bytes.Buffer }

func (w *shortWebSocketWriter) Write(payload []byte) (int, error) {
	if len(payload) > 2 {
		payload = payload[:2]
	}
	return w.Buffer.Write(payload)
}

type blockingWebSocketWriter struct {
	bytes.Buffer
	first   chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *blockingWebSocketWriter) Write(payload []byte) (int, error) {
	w.once.Do(func() {
		close(w.first)
		<-w.release
	})
	return w.Buffer.Write(payload)
}

type deadlineBlockingWebSocketWriter struct {
	started      chan struct{}
	deadlineSet  chan struct{}
	startOnce    sync.Once
	deadlineOnce sync.Once
}

func (w *deadlineBlockingWebSocketWriter) Write([]byte) (int, error) {
	w.startOnce.Do(func() { close(w.started) })
	<-w.deadlineSet
	return 0, context.DeadlineExceeded
}

func (w *deadlineBlockingWebSocketWriter) SetWriteDeadline(time.Time) error {
	w.deadlineOnce.Do(func() { close(w.deadlineSet) })
	return nil
}

func TestWebSocketRejectsNonCanonicalLengthsAndCompletesWrites(t *testing.T) {
	for _, wire := range [][]byte{
		{0x81, 126, 0, 125},
		{0x81, 127, 0, 0, 0, 0, 0, 0, 0, 126},
	} {
		if _, err := readWebSocketFrame(bytes.NewReader(wire), 256, false); !errors.Is(err, errWebSocketProtocol) {
			t.Fatalf("noncanonical frame %x error = %v", wire, err)
		}
	}
	writer := &shortWebSocketWriter{}
	if err := writeWebSocketFrame(writer, webSocketFrame{fin: true, opcode: webSocketText, payload: []byte("complete")}, false); err != nil {
		t.Fatalf("short writer frame: %v", err)
	}
	frame, err := readWebSocketFrame(bytes.NewReader(writer.Bytes()), 64, false)
	if err != nil || string(frame.payload) != "complete" {
		t.Fatalf("short writer frame = (%+v, %v)", frame, err)
	}
}

func TestWebSocketHandshakeHeaderBounds(t *testing.T) {
	valid := http.Header{
		"Connection":             {"Upgrade"},
		"Upgrade":                {"websocket"},
		"Sec-Websocket-Accept":   {"accepted"},
		"Sec-Websocket-Protocol": {"chat"},
	}
	if !validWebSocketHandshakeHeaders(valid) {
		t.Fatal("valid handshake headers rejected")
	}
	valid.Add("Sec-Websocket-Accept", "duplicated")
	if validWebSocketHandshakeHeaders(valid) {
		t.Fatal("duplicate handshake acceptance allowed")
	}
}

func TestWebSocketClientFramesAreMaskedAndFragmented(t *testing.T) {
	var wire bytes.Buffer
	payload := bytes.Repeat([]byte("a"), 19)
	if err := writeWebSocketMessage(&wire, webSocketText, payload, 7); err != nil {
		t.Fatalf("write fragmented message: %v", err)
	}
	var joined []byte
	for wantOpcode := webSocketText; ; wantOpcode = webSocketContinuation {
		frame, err := readWebSocketFrame(&wire, 32, true)
		if err != nil {
			t.Fatalf("read masked frame: %v", err)
		}
		if frame.opcode != wantOpcode {
			t.Fatalf("opcode = %d, want %d", frame.opcode, wantOpcode)
		}
		joined = append(joined, frame.payload...)
		if frame.fin {
			break
		}
	}
	if !bytes.Equal(joined, payload) {
		t.Fatalf("joined payload = %q, want %q", joined, payload)
	}
}

func TestWebSocketPingCannotInterleaveWithFragmentedSend(t *testing.T) {
	target := &blockingWebSocketWriter{first: make(chan struct{}), release: make(chan struct{})}
	writer := &serializedWebSocketWriter{writer: target, maxFrame: 7}
	messageDone := make(chan error, 1)
	go func() {
		messageDone <- writer.message(webSocketText, bytes.Repeat([]byte("a"), 19))
	}()
	select {
	case <-target.first:
	case <-time.After(time.Second):
		t.Fatal("fragmented send did not begin")
	}
	pingDone := make(chan error, 1)
	go func() {
		pingDone <- writer.frame(webSocketFrame{fin: true, opcode: webSocketPing, payload: []byte("p")})
	}()
	select {
	case err := <-pingDone:
		t.Fatalf("ping completed inside fragmented send: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(target.release)
	if err := <-messageDone; err != nil {
		t.Fatalf("fragmented send: %v", err)
	}
	if err := <-pingDone; err != nil {
		t.Fatalf("ping send: %v", err)
	}
	reader := bytes.NewReader(target.Bytes())
	for index, opcode := range []byte{webSocketText, webSocketContinuation, webSocketContinuation, webSocketPing} {
		frame, err := readWebSocketFrame(reader, 32, true)
		if err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
		if frame.opcode != opcode {
			t.Fatalf("frame %d opcode = %d, want %d", index, frame.opcode, opcode)
		}
	}
	if reader.Len() != 0 {
		t.Fatalf("trailing interleaved bytes = %d", reader.Len())
	}
}

func TestWebSocketCloseDeadlineInterruptsBlockedDataWrite(t *testing.T) {
	target := &deadlineBlockingWebSocketWriter{
		started:     make(chan struct{}),
		deadlineSet: make(chan struct{}),
	}
	writer := &serializedWebSocketWriter{writer: target, maxFrame: 7}
	messageDone := make(chan error, 1)
	go func() {
		messageDone <- writer.message(webSocketBinary, bytes.Repeat([]byte("a"), 19))
	}()
	select {
	case <-target.started:
	case <-time.After(time.Second):
		t.Fatal("blocked data write did not begin")
	}
	closeDone := make(chan error, 1)
	go func() {
		if err := beginWebSocketCloseWriteDeadline(target, time.Now()); err != nil {
			closeDone <- err
			return
		}
		closeDone <- writer.frame(webSocketFrame{fin: true, opcode: webSocketClose})
	}()
	for name, done := range map[string]<-chan error{"data write": messageDone, "close write": closeDone} {
		select {
		case err := <-done:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("%s error = %v, want deadline exceeded", name, err)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s remained blocked after close deadline", name)
		}
	}
}

func TestWebSocketRejectsMaskedTargetAndMalformedClose(t *testing.T) {
	var wire bytes.Buffer
	if err := writeWebSocketFrame(&wire, webSocketFrame{fin: true, opcode: webSocketText, payload: []byte("target")}, true); err != nil {
		t.Fatalf("write test frame: %v", err)
	}
	if _, err := readWebSocketFrame(&wire, 32, false); !errors.Is(err, errWebSocketProtocol) {
		t.Fatalf("masked target frame error = %v, want protocol error", err)
	}
	if _, _, err := decodeWebSocketClose([]byte{3}); !errors.Is(err, errWebSocketProtocol) {
		t.Fatalf("one-byte close error = %v, want protocol error", err)
	}
}

func TestWebSocketBoundedSendBackpressureAndCloseSequence(t *testing.T) {
	var events []webSocketEvent
	var eventsMu sync.Mutex
	socket := newWebSocketTransaction(testRequestID, 5, 1, func(event webSocketEvent) {
		eventsMu.Lock()
		events = append(events, event)
		eventsMu.Unlock()
	})
	if err := socket.open("chat", nil); err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := socket.send(0, "text", []byte("1234")); err != nil {
		t.Fatalf("first send: %v", err)
	}
	if _, err := socket.send(1, "binary", []byte("5")); err == nil {
		t.Fatal("queue full send was accepted")
	}
	bytesUsed, items := socket.outbound.usage()
	if bytesUsed != 4 || items != 1 {
		t.Fatalf("queue usage = (%d, %d), want (4, 1)", bytesUsed, items)
	}
	if !socket.finish(1000, "done", true, "") {
		t.Fatal("first finish did not transition")
	}
	if socket.finish(1000, "again", true, "") {
		t.Fatal("second finish emitted another terminal sequence")
	}
	socket.dispatchWG.Wait()
	eventsMu.Lock()
	defer eventsMu.Unlock()
	var closes int
	for _, event := range events {
		if event.Kind == webSocketEventClose {
			closes++
			if event.Code != 1000 || event.Reason != "done" || !event.WasClean {
				t.Fatalf("close event = %+v", event)
			}
		}
	}
	if closes != 1 {
		t.Fatalf("close events = %d, want 1", closes)
	}
}

func TestWebSocketRelayLossReleasesBlockedProducerOnce(t *testing.T) {
	socket := newWebSocketTransaction(testRequestID, 16, 2, nil)
	if err := socket.open("", nil); err != nil {
		t.Fatalf("open: %v", err)
	}
	ack, err := socket.send(0, "binary", []byte("queued"))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if !socket.relayLost() {
		t.Fatal("relay loss did not transition")
	}
	if socket.relayLost() {
		t.Fatal("second relay loss emitted another terminal sequence")
	}
	select {
	case err := <-ack:
		if err == nil || err.Error() != "RELAY_LOST" {
			t.Fatalf("producer error = %v, want RELAY_LOST", err)
		}
	case <-time.After(time.Second):
		t.Fatal("relay loss did not release blocked producer")
	}
	if _, err := socket.send(1, "text", []byte("late")); err == nil {
		t.Fatal("send after relay loss was accepted")
	}
}

func TestWebSocketCloseQueuesValidatedCloseFrame(t *testing.T) {
	socket := newWebSocketTransaction(testRequestID, 32, 2, nil)
	if err := socket.open("", nil); err != nil {
		t.Fatalf("open: %v", err)
	}
	select {
	case <-socket.CloseStarted():
		t.Fatal("close-start signal fired before close")
	default:
	}
	ack, err := socket.close(1000, "done")
	if err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-socket.CloseStarted():
	default:
		t.Fatal("close-start signal did not fire synchronously")
	}
	item, err := socket.outbound.dequeue(context.Background())
	if err != nil {
		t.Fatalf("dequeue close: %v", err)
	}
	if !item.close || item.code != 1000 || item.reason != "done" || item.opcode != webSocketClose {
		t.Fatalf("queued close = %+v", item)
	}
	code, reason, err := decodeWebSocketClose(item.payload)
	if err != nil || code != 1000 || reason != "done" {
		t.Fatalf("close payload = (%d, %q, %v)", code, reason, err)
	}
	item.ack <- nil
	if err := <-ack; err != nil {
		t.Fatalf("close acknowledgement: %v", err)
	}
	if !socket.finish(code, reason, true, "") {
		t.Fatal("close completion did not terminate socket")
	}
	socket.dispatchWG.Wait()
}

func TestWebSocketCloseWithoutCodeUsesEmptyWirePayload(t *testing.T) {
	socket := newWebSocketTransaction(testRequestID, 32, 2, nil)
	if err := socket.open("", nil); err != nil {
		t.Fatalf("open: %v", err)
	}
	ack, err := socket.close(1005, "")
	if err != nil {
		t.Fatalf("close without code: %v", err)
	}
	item, err := socket.outbound.dequeue(context.Background())
	if err != nil {
		t.Fatalf("dequeue close without code: %v", err)
	}
	if !item.close || item.code != 1005 || len(item.payload) != 0 {
		t.Fatalf("queued close without code = %+v", item)
	}
	code, reason, err := decodeWebSocketClose(item.payload)
	if err != nil || code != 1005 || reason != "" {
		t.Fatalf("empty close payload = (%d, %q, %v)", code, reason, err)
	}
	item.ack <- nil
	if err := <-ack; err != nil {
		t.Fatalf("close acknowledgement: %v", err)
	}
	if socket.Context().Err() != nil {
		t.Fatal("writing the close frame terminated before the peer handshake")
	}
	socket.cancelSocket()
	socket.dispatchWG.Wait()
}

func TestWebSocketReceiveAndCancelDispatch(t *testing.T) {
	received := make(chan webSocketEvent, 1)
	socket := newWebSocketTransaction(testRequestID, 32, 2, func(event webSocketEvent) {
		if event.Kind == webSocketEventMessage {
			received <- event
		}
	})
	if err := socket.open("", nil); err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := socket.receive("text", []byte("message")); err != nil {
		t.Fatalf("receive: %v", err)
	}
	select {
	case event := <-received:
		if event.DataKind != "text" || string(event.Data) != "message" {
			t.Fatalf("received event = %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("message event was not dispatched")
	}
	if !socket.cancelSocket() {
		t.Fatal("cancel did not terminate socket")
	}
	socket.dispatchWG.Wait()
}

package main

import (
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

const testRequestID = "request-stream-test-0001"

type eventRecorder struct {
	mu     sync.Mutex
	events []streamEvent
}

func (r *eventRecorder) emit(event streamEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *eventRecorder) terminalEvents() []streamEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	var terminals []streamEvent
	for _, event := range r.events {
		if event.Kind == streamEventTerminal {
			terminals = append(terminals, event)
		}
	}
	return terminals
}

func receiveEvent(t *testing.T, events <-chan streamEvent) streamEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatal("stream event timed out")
		return streamEvent{}
	}
}

func TestTransactionCancelBeforeHeadersEmitsExactlyOneTerminal(t *testing.T) {
	recorder := &eventRecorder{}
	transaction := newTransaction(testRequestID, 8, 16, 2, false, recorder.emit)
	if !transaction.cancelTransaction() {
		t.Fatal("first cancellation must transition the transaction")
	}
	if transaction.cancelTransaction() {
		t.Fatal("duplicate cancellation must be idempotent")
	}
	if err := transaction.emitHeaders(responseMetadata{}); err == nil {
		t.Fatal("headers after cancellation must fail closed")
	}
	terminals := recorder.terminalEvents()
	if len(terminals) != 1 {
		t.Fatalf("terminal events = %d, want 1", len(terminals))
	}
	if terminals[0].Terminal.Code != "CANCELED" || terminals[0].Terminal.OK {
		t.Fatalf("terminal = %+v, want canceled failure", terminals[0].Terminal)
	}
}

func TestBoundedChunkQueueRejectsCountAndByteOverflow(t *testing.T) {
	queue := newBoundedChunkQueue(6, 1)
	if _, err := queue.enqueue(0, []byte("1234")); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.enqueue(1, []byte("56")); err == nil {
		t.Fatal("queue count bound did not reject a second chunk")
	}
	bytes, chunks := queue.usage()
	if bytes != 4 || chunks != 1 {
		t.Fatalf("queue usage = (%d, %d)", bytes, chunks)
	}
	queue.close(nil)
}

func TestUploadIsPullDrivenSequencedAndCloseIdempotent(t *testing.T) {
	events := make(chan streamEvent, 4)
	transaction := newTransaction(testRequestID, 4, 6, 1, true, func(event streamEvent) { events <- event })
	reader := newUploadReader(transaction)
	type readResult struct {
		count int
		err   error
	}
	firstRead := make(chan readResult, 1)
	go func() {
		buffer := make([]byte, 4)
		count, err := reader.Read(buffer)
		firstRead <- readResult{count: count, err: err}
	}()
	pull := receiveEvent(t, events)
	if pull.Kind != streamEventPull || pull.Seq != 0 || pull.DesiredBytes != 4 {
		t.Fatalf("pull = %+v", pull)
	}
	if _, err := transaction.acceptUpload(1, []byte("late")); err == nil {
		t.Fatal("out-of-order upload sequence accepted")
	}
	ack, err := transaction.acceptUpload(0, []byte("1234"))
	if err != nil {
		t.Fatal(err)
	}
	result := <-firstRead
	if result.err != nil || result.count != 4 {
		t.Fatalf("read = (%d, %v)", result.count, result.err)
	}
	if err := <-ack; err != nil {
		t.Fatalf("chunk acknowledgement = %v", err)
	}

	secondRead := make(chan error, 1)
	go func() {
		_, err := reader.Read(make([]byte, 4))
		secondRead <- err
	}()
	pull = receiveEvent(t, events)
	if pull.Kind != streamEventPull || pull.Seq != 1 {
		t.Fatalf("second pull = %+v", pull)
	}
	if err := transaction.endUpload(1); err != nil {
		t.Fatal(err)
	}
	if err := transaction.endUpload(1); err != nil {
		t.Fatalf("duplicate CLOSE was not idempotent: %v", err)
	}
	if err := <-secondRead; !errors.Is(err, io.EOF) {
		t.Fatalf("read after close = %v", err)
	}
	if _, err := transaction.acceptUpload(1, []byte("x")); err == nil {
		t.Fatal("CHUNK after CLOSE accepted")
	}
}

func TestUploadReaderCloseAcknowledgesLatePulledChunk(t *testing.T) {
	events := make(chan streamEvent, 2)
	transaction := newTransaction(testRequestID, 8, 16, 2, true, func(event streamEvent) { events <- event })
	reader := newUploadReader(transaction)
	readDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(make([]byte, 8))
		readDone <- err
	}()
	pull := receiveEvent(t, events)
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-readDone:
		if !errors.Is(err, errTransactionCanceled) {
			t.Fatalf("closed upload read = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upload reader close did not unblock read")
	}
	ack, err := transaction.acceptUpload(pull.Seq, []byte("late"))
	if err != nil {
		t.Fatalf("late pulled chunk was not drained: %v", err)
	}
	if ackErr := <-ack; ackErr != nil {
		t.Fatalf("late pulled chunk acknowledgement = %v", ackErr)
	}
	if _, chunks := transaction.upload.usage(); chunks != 0 {
		t.Fatalf("discarded upload retained %d chunks", chunks)
	}
	transaction.mu.Lock()
	terminal := transaction.terminal
	transaction.mu.Unlock()
	if terminal != nil {
		t.Fatalf("closing request upload terminated the response: %#v", terminal)
	}
}

func TestUploadReaderCloseAcknowledgesPartiallyConsumedChunk(t *testing.T) {
	transaction := newTransaction(testRequestID, 8, 16, 2, true, nil)
	reader := newUploadReader(transaction)
	ack := make(chan error, 1)
	reader.current = queuedChunk{seq: 0, data: []byte("partial"), ack: ack}
	reader.offset = 2
	transaction.mu.Lock()
	transaction.uploadOutstanding = ack
	transaction.mu.Unlock()
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-ack:
		if err != nil {
			t.Fatalf("discarded partial chunk acknowledgement = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("closing partial upload did not release producer")
	}
	if _, err := reader.Read(make([]byte, 2)); !errors.Is(err, errTransactionCanceled) {
		t.Fatalf("read after partial close = %v", err)
	}
}

func TestUploadReaderCloseRacingAcceptAlwaysReleasesProducer(t *testing.T) {
	type accepted struct {
		ack <-chan error
		err error
	}
	for range 100 {
		events := make(chan streamEvent, 2)
		transaction := newTransaction(testRequestID, 8, 16, 2, true, func(event streamEvent) { events <- event })
		reader := newUploadReader(transaction)
		readDone := make(chan error, 1)
		go func() {
			_, err := reader.Read(make([]byte, 8))
			readDone <- err
		}()
		pull := receiveEvent(t, events)
		acceptDone := make(chan accepted, 1)
		closeDone := make(chan error, 1)
		go func() {
			ack, err := transaction.acceptUpload(pull.Seq, []byte("racing"))
			acceptDone <- accepted{ack: ack, err: err}
		}()
		go func() { closeDone <- reader.Close() }()
		accepted := <-acceptDone
		if accepted.err != nil {
			t.Fatalf("racing chunk rejected: %v", accepted.err)
		}
		if err := <-closeDone; err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-accepted.ack:
			if err != nil {
				t.Fatalf("racing chunk acknowledgement = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("racing accept/dequeue retained producer acknowledgement")
		}
		select {
		case <-readDone:
		case <-time.After(time.Second):
			t.Fatal("racing close retained upload reader")
		}
	}
}

func TestCancelMidUploadReleasesProducerAndReader(t *testing.T) {
	events := make(chan streamEvent, 2)
	transaction := newTransaction(testRequestID, 8, 16, 2, true, func(event streamEvent) { events <- event })
	reader := newUploadReader(transaction)
	if err := transaction.requestUpload(8); err != nil {
		t.Fatal(err)
	}
	pull := receiveEvent(t, events)
	ack, err := transaction.acceptUpload(pull.Seq, []byte("stream"))
	if err != nil {
		t.Fatal(err)
	}
	transaction.cancelTransaction()
	select {
	case err := <-ack:
		if !errors.Is(err, errTransactionCanceled) {
			t.Fatalf("producer acknowledgement = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not release upload producer")
	}
	if _, err := reader.Read(make([]byte, 2)); !errors.Is(err, errTransactionCanceled) {
		t.Fatalf("reader after cancellation = %v", err)
	}
}

func TestDownloadReadsOnlyAfterPullAndEmitsOneChunk(t *testing.T) {
	events := make(chan streamEvent, 4)
	transaction := newTransaction(testRequestID, 8, 16, 2, false, func(event streamEvent) { events <- event })
	if err := transaction.emitHeaders(responseMetadata{}); err != nil {
		t.Fatal(err)
	}
	if event := receiveEvent(t, events); event.Kind != streamEventHeaders {
		t.Fatalf("first event = %+v", event)
	}
	bufferReady := make(chan []byte, 1)
	go func() {
		buffer, _ := transaction.nextDownloadBuffer()
		bufferReady <- buffer
	}()
	select {
	case <-bufferReady:
		t.Fatal("target read admitted before PULL")
	default:
	}
	if err := transaction.requestDownload(1, 5); err == nil {
		t.Fatal("out-of-order PULL accepted")
	}
	if err := transaction.requestDownload(0, 5); err != nil {
		t.Fatal(err)
	}
	buffer := <-bufferReady
	if len(buffer) != 5 {
		t.Fatalf("read buffer length = %d", len(buffer))
	}
	if err := transaction.download([]byte("bytes")); err != nil {
		t.Fatal(err)
	}
	chunk := receiveEvent(t, events)
	if chunk.Kind != streamEventChunk || chunk.Seq != 0 || string(chunk.Data) != "bytes" {
		t.Fatalf("chunk = %+v", chunk)
	}
	if err := transaction.download([]byte("more")); err == nil {
		t.Fatal("CHUNK without a new PULL accepted")
	}
	transaction.finish(terminalOutcome{OK: true})
	terminal := receiveEvent(t, events)
	if terminal.Kind != streamEventTerminal || !terminal.Terminal.OK || terminal.Terminal.FinalSeq != 1 {
		t.Fatalf("terminal = %+v", terminal)
	}
}

func TestCancelMidDownloadUnblocksPendingReadExactlyOnce(t *testing.T) {
	events := make(chan streamEvent, 3)
	transaction := newTransaction(testRequestID, 8, 16, 2, false, func(event streamEvent) { events <- event })
	if err := transaction.emitHeaders(responseMetadata{}); err != nil {
		t.Fatal(err)
	}
	_ = receiveEvent(t, events)
	done := make(chan error, 1)
	go func() {
		_, err := transaction.nextDownloadBuffer()
		done <- err
	}()
	if err := transaction.cancelFrame(0, "CONSUMER_CANCEL"); err != nil {
		t.Fatal(err)
	}
	if err := transaction.cancelFrame(0, "CONSUMER_CANCEL"); err != nil {
		t.Fatalf("duplicate CANCEL was not idempotent: %v", err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, errTransactionCanceled) {
			t.Fatalf("download cancellation = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("download remained blocked after cancellation")
	}
	terminal := receiveEvent(t, events)
	if terminal.Kind != streamEventTerminal || terminal.Terminal.Code != "CANCELED" {
		t.Fatalf("terminal = %+v", terminal)
	}
}

func TestMidBodyFailureTerminatesPendingPull(t *testing.T) {
	events := make(chan streamEvent, 3)
	transaction := newTransaction(testRequestID, 8, 16, 2, false, func(event streamEvent) { events <- event })
	if err := transaction.emitHeaders(responseMetadata{}); err != nil {
		t.Fatal(err)
	}
	_ = receiveEvent(t, events)
	done := make(chan error, 1)
	go func() {
		_, err := transaction.nextDownloadBuffer()
		done <- err
	}()
	transaction.finish(terminalOutcome{Code: "RESPONSE_BODY", Stage: "BODY", Retryable: true})
	if err := <-done; err == nil || err.Error() != "RESPONSE_BODY" {
		t.Fatalf("pending pull failure = %v", err)
	}
	terminal := receiveEvent(t, events)
	if terminal.Kind != streamEventTerminal || terminal.Terminal.Code != "RESPONSE_BODY" {
		t.Fatalf("terminal = %+v", terminal)
	}
}

func TestStreamIdleAndTotalDeadlinesAreTerminal(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		idle  time.Duration
		total time.Duration
		code  string
	}{
		{name: "idle", idle: 10 * time.Millisecond, total: time.Second, code: "STREAM_IDLE_TIMEOUT"},
		{name: "total", idle: time.Second, total: 10 * time.Millisecond, code: "STREAM_TOTAL_TIMEOUT"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			events := make(chan streamEvent, 1)
			transaction := newTransaction(testRequestID, 8, 16, 2, false, func(event streamEvent) { events <- event })
			transaction.startDeadlines(testCase.idle, testCase.total)
			terminal := receiveEvent(t, events)
			if terminal.Terminal == nil || terminal.Terminal.Code != testCase.code {
				t.Fatalf("deadline terminal = %+v", terminal)
			}
		})
	}
}

func TestRelayLossIsTerminalAndRejectsLateFrames(t *testing.T) {
	recorder := &eventRecorder{}
	transaction := newTransaction(testRequestID, 8, 16, 2, true, recorder.emit)
	if !transaction.relayLost() {
		t.Fatal("relay loss must transition transaction")
	}
	if transaction.relayLost() {
		t.Fatal("duplicate relay loss emitted another terminal")
	}
	if _, err := transaction.acceptUpload(0, []byte("late")); err == nil {
		t.Fatal("late CHUNK accepted")
	}
	if err := transaction.requestDownload(0, 1); err == nil {
		t.Fatal("late PULL accepted")
	}
	terminals := recorder.terminalEvents()
	if len(terminals) != 1 || terminals[0].Terminal.Code != "RELAY_LOST" {
		t.Fatalf("terminals = %+v", terminals)
	}
}

func TestRequestIDLedgerRejectsDuplicateAndMalformedIDs(t *testing.T) {
	var ledger requestIDLedger
	if err := ledger.reserve(testRequestID); err != nil {
		t.Fatalf("first request ID rejected: %v", err)
	}
	if err := ledger.reserve(testRequestID); err == nil {
		t.Fatal("duplicate request ID accepted")
	}
	if err := ledger.reserve("too-short"); err == nil {
		t.Fatal("malformed request ID accepted")
	}
}

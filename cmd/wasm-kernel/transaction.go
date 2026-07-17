package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/gosuda/zeroproxy/internal/errorauthority"
)

const (
	defaultStreamChunkBytes = 64 << 10
	defaultQueueBytes       = 256 << 10
	defaultQueueChunks      = 4
	requestIDFilterWords    = 256 // 2 KiB of bounded replay state per kernel.
)

var (
	errTransactionCanceled = errors.New("transaction canceled")
	errQueueClosed         = errors.New("queue closed")
)

type transactionError struct {
	Code      string
	Stage     string
	Retryable bool
}

func (e *transactionError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

const classificationRequestID = "classification_check_0001"

func normalizeTransactionError(code, stage string, retryable bool) *transactionError {
	classification := errorauthority.InternalError{
		Code:          errorauthority.ErrorCode(code),
		Stage:         errorauthority.ErrorStage(stage),
		Retryable:     retryable,
		RequestID:     classificationRequestID,
		InternalCause: nil,
	}
	if classification.Validate(errorauthority.ErrorVersion) != nil {
		return &transactionError{
			Code:      string(errorauthority.CodeInternalFailed),
			Stage:     string(errorauthority.StageInternal),
			Retryable: false,
		}
	}
	return &transactionError{Code: code, Stage: stage, Retryable: retryable}
}

func newTransactionError(code, stage string, retryable bool) error {
	return normalizeTransactionError(code, stage, retryable)
}

type transactionState uint8

const (
	transactionOpen transactionState = iota
	transactionTerminal
)

type terminalOutcome struct {
	OK        bool
	Code      string
	Stage     string
	Retryable bool
	FinalSeq  uint64
}

type streamEventKind string

const (
	streamEventHeaders  streamEventKind = "HEADERS"
	streamEventPull     streamEventKind = "PULL"
	streamEventChunk    streamEventKind = "CHUNK"
	streamEventTerminal streamEventKind = "TERMINAL"
)

type redirectMetadata struct {
	Mode       string
	IsRedirect bool
	Location   string
}

type informationalResponseMetadata struct {
	Status  int
	Headers [][2]string
}

// responseMetadata is intentionally byte-free. Response payload bytes travel
// only in individually acknowledged download events.
type responseMetadata struct {
	Status        int
	StatusText    string
	Headers       [][2]string
	URL           string
	Redirected    bool
	ResponseType  string
	RequestSite   string
	Redirect      redirectMetadata
	Informational []informationalResponseMetadata
}

type streamEvent struct {
	Kind         streamEventKind
	RequestID    string
	Seq          uint64
	DesiredBytes int
	Data         []byte
	Headers      *responseMetadata
	Terminal     *terminalOutcome
}

type queuedChunk struct {
	seq  uint64
	data []byte
	ack  chan error
}

// boundedChunkQueue retains a fixed number of request-body chunks and bytes.
// Producers receive an acknowledgement only after the HTTP writer consumes the
// complete chunk, which is the upload backpressure signal used by the JS ABI.
type boundedChunkQueue struct {
	mu        sync.Mutex
	items     []queuedChunk
	bytes     int
	maxBytes  int
	maxChunks int
	closed    bool
	cause     error
	wake      chan struct{}
}

func newBoundedChunkQueue(maxBytes, maxChunks int) *boundedChunkQueue {
	if maxBytes <= 0 {
		maxBytes = defaultQueueBytes
	}
	if maxChunks <= 0 {
		maxChunks = defaultQueueChunks
	}
	return &boundedChunkQueue{maxBytes: maxBytes, maxChunks: maxChunks, wake: make(chan struct{}, 1)}
}

func (q *boundedChunkQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *boundedChunkQueue) enqueue(seq uint64, data []byte) (<-chan error, error) {
	if len(data) == 0 {
		return nil, newTransactionError("BODY_CHUNK_EMPTY", "BODY", false)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		if q.cause != nil {
			return nil, q.cause
		}
		return nil, errQueueClosed
	}
	if len(data) > q.maxBytes || len(q.items) >= q.maxChunks || q.bytes > q.maxBytes-len(data) {
		return nil, newTransactionError("UPLOAD_QUEUE_FULL", "BODY", true)
	}
	ack := make(chan error, 1)
	q.items = append(q.items, queuedChunk{seq: seq, data: data, ack: ack})
	q.bytes += len(data)
	q.signal()
	return ack, nil
}

func (q *boundedChunkQueue) dequeue(ctx context.Context) (queuedChunk, error) {
	for {
		q.mu.Lock()
		if len(q.items) != 0 {
			item := q.items[0]
			q.items = q.items[1:]
			q.bytes -= len(item.data)
			q.mu.Unlock()
			return item, nil
		}
		if q.closed {
			cause := q.cause
			q.mu.Unlock()
			if cause != nil {
				return queuedChunk{}, cause
			}
			return queuedChunk{}, io.EOF
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return queuedChunk{}, ctx.Err()
		case <-q.wake:
		}
	}
}

func (q *boundedChunkQueue) close(cause error) {
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
func (q *boundedChunkQueue) discard() {
	q.mu.Lock()
	items := q.items
	q.items = nil
	q.bytes = 0
	q.mu.Unlock()
	for _, item := range items {
		item.ack <- nil
	}
}

func causeOrClosed(cause error) error {
	if cause != nil {
		return cause
	}
	return errQueueClosed
}

func (q *boundedChunkQueue) usage() (bytes, chunks int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes, len(q.items)
}

// transaction is the transport-neutral state machine. The js/wasm entrypoint
// supplies the network runner and event serializer; tests can prove every
// transition without a browser or relay.
type transaction struct {
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	upload   *boundedChunkQueue
	emit     func(streamEvent)
	maxChunk int

	mu                    sync.Mutex
	state                 transactionState
	nextUploadSeq         uint64
	uploadEnded           bool
	uploadDiscarding      bool
	uploadPullOutstanding bool
	uploadPullBytes       int
	uploadOutstanding     chan error
	nextDownloadSeq       uint64
	downloadPull          bool
	downloadPullBytes     int
	headersEmitted        bool
	terminal              *terminalOutcome
	cancelCode            string
	inputErrorSeq         uint64
	inputErrorCode        string
	downloadWake          chan struct{}
	idleTimeout           time.Duration
	idleTimer             *time.Timer
	totalTimer            *time.Timer
}

func newTransaction(id string, maxChunk, queueBytes, queueChunks int, bodyExpected bool, emit func(streamEvent)) *transaction {
	if maxChunk <= 0 {
		maxChunk = defaultStreamChunkBytes
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &transaction{
		id:           id,
		ctx:          ctx,
		cancel:       cancel,
		upload:       newBoundedChunkQueue(queueBytes, queueChunks),
		emit:         emit,
		maxChunk:     maxChunk,
		downloadWake: make(chan struct{}, 1),
	}
	if !bodyExpected {
		t.uploadEnded = true
		t.upload.close(nil)
	}
	return t
}

func (t *transaction) Context() context.Context { return t.ctx }

func (t *transaction) touchIdleLocked() {
	if t.idleTimer != nil {
		t.idleTimer.Reset(t.idleTimeout)
	}
}

func (t *transaction) startDeadlines(idle, total time.Duration) {
	t.mu.Lock()
	if t.state != transactionOpen || t.idleTimer != nil || t.totalTimer != nil {
		t.mu.Unlock()
		return
	}
	t.idleTimeout = idle
	if idle > 0 {
		t.idleTimer = time.AfterFunc(idle, func() {
			t.finish(terminalOutcome{Code: "STREAM_IDLE_TIMEOUT", Stage: "BODY", Retryable: true})
		})
	}
	if total > 0 {
		t.totalTimer = time.AfterFunc(total, func() {
			t.finish(terminalOutcome{Code: "STREAM_TOTAL_TIMEOUT", Stage: "BODY", Retryable: true})
		})
	}
	t.mu.Unlock()
}

func (t *transaction) discardUpload() {
	t.mu.Lock()
	if t.state != transactionOpen || t.uploadEnded || t.uploadDiscarding {
		t.mu.Unlock()
		return
	}
	t.uploadDiscarding = true
	outstanding := t.uploadOutstanding
	t.uploadOutstanding = nil
	t.mu.Unlock()
	if outstanding != nil {
		outstanding <- nil
	}
	t.upload.discard()
}

func (t *transaction) requestUpload(desired int) error {
	if desired < 1 || desired > t.maxChunk {
		return newTransactionError("PULL_LIMIT", "BODY", false)
	}
	t.mu.Lock()
	if t.state != transactionOpen {
		t.mu.Unlock()
		return newTransactionError("REQUEST_TERMINAL", "BODY", false)
	}
	if t.uploadDiscarding {
		t.mu.Unlock()
		return io.EOF
	}
	if t.uploadEnded {
		t.mu.Unlock()
		return io.EOF
	}
	if t.uploadPullOutstanding {
		t.mu.Unlock()
		return newTransactionError("PULL_OUTSTANDING", "BODY", false)
	}
	t.uploadPullOutstanding = true
	t.uploadPullBytes = desired
	seq := t.nextUploadSeq
	emit := t.emit
	t.touchIdleLocked()
	t.mu.Unlock()
	if emit != nil {
		emit(streamEvent{Kind: streamEventPull, RequestID: t.id, Seq: seq, DesiredBytes: desired})
	}
	return nil
}

func (t *transaction) acceptUpload(seq uint64, data []byte) (<-chan error, error) {
	if len(data) == 0 || len(data) > t.maxChunk {
		return nil, newTransactionError("BODY_CHUNK_LIMIT", "BODY", false)
	}
	t.mu.Lock()
	if t.state != transactionOpen {
		t.mu.Unlock()
		return nil, newTransactionError("REQUEST_TERMINAL", "BODY", false)
	}
	if t.uploadEnded || !t.uploadPullOutstanding || seq != t.nextUploadSeq || len(data) > t.uploadPullBytes {
		t.mu.Unlock()
		return nil, newTransactionError("BODY_SEQUENCE", "BODY", false)
	}
	if t.uploadDiscarding {
		ack := make(chan error, 1)
		ack <- nil
		t.nextUploadSeq++
		t.uploadPullOutstanding = false
		t.uploadPullBytes = 0
		t.touchIdleLocked()
		t.mu.Unlock()
		return ack, nil
	}
	ack, err := t.upload.enqueue(seq, data)
	if err == nil {
		t.nextUploadSeq++
		t.uploadPullOutstanding = false
		t.uploadPullBytes = 0
		t.touchIdleLocked()
	}
	t.mu.Unlock()
	return ack, err
}

func (t *transaction) endUpload(finalSeq uint64) error {
	t.mu.Lock()
	if t.uploadEnded && finalSeq == t.nextUploadSeq {
		t.mu.Unlock()
		return nil
	}
	if t.state != transactionOpen {
		t.mu.Unlock()
		return newTransactionError("REQUEST_TERMINAL", "BODY", false)
	}
	if !t.uploadPullOutstanding || finalSeq != t.nextUploadSeq {
		t.mu.Unlock()
		return newTransactionError("BODY_SEQUENCE", "BODY", false)
	}
	t.uploadEnded = true
	t.uploadPullOutstanding = false
	t.uploadPullBytes = 0
	t.touchIdleLocked()
	t.mu.Unlock()
	t.upload.close(nil)
	return nil
}

func (t *transaction) signalDownload() {
	select {
	case t.downloadWake <- struct{}{}:
	default:
	}
}

func (t *transaction) requestDownload(seq uint64, desired int) error {
	if desired < 1 || desired > t.maxChunk {
		return newTransactionError("PULL_LIMIT", "BODY", false)
	}
	t.mu.Lock()
	if t.state != transactionOpen {
		t.mu.Unlock()
		return newTransactionError("REQUEST_TERMINAL", "BODY", false)
	}
	if !t.headersEmitted || t.downloadPull || seq != t.nextDownloadSeq {
		t.mu.Unlock()
		return newTransactionError("DOWNLOAD_SEQUENCE", "BODY", false)
	}
	t.downloadPull = true
	t.downloadPullBytes = desired
	t.touchIdleLocked()
	t.mu.Unlock()
	t.signalDownload()
	return nil
}

func (t *transaction) nextDownloadBuffer() ([]byte, error) {
	for {
		t.mu.Lock()
		if t.state != transactionOpen {
			outcome := t.terminal
			t.mu.Unlock()
			if outcome != nil {
				return nil, terminalCause(*outcome)
			}
			return nil, errTransactionCanceled
		}
		if t.downloadPull {
			size := t.downloadPullBytes
			t.mu.Unlock()
			return make([]byte, size), nil
		}
		t.mu.Unlock()
		select {
		case <-t.ctx.Done():
			return nil, errTransactionCanceled
		case <-t.downloadWake:
		}
	}
}

func (t *transaction) download(data []byte) error {
	if len(data) == 0 || len(data) > t.maxChunk {
		return newTransactionError("DOWNLOAD_CHUNK_LIMIT", "BODY", false)
	}
	t.mu.Lock()
	if t.state != transactionOpen {
		t.mu.Unlock()
		return newTransactionError("REQUEST_TERMINAL", "BODY", false)
	}
	if !t.downloadPull || len(data) > t.downloadPullBytes {
		t.mu.Unlock()
		return newTransactionError("DOWNLOAD_BACKPRESSURE", "BODY", false)
	}
	seq := t.nextDownloadSeq
	t.nextDownloadSeq++
	t.downloadPull = false
	t.downloadPullBytes = 0
	emit := t.emit
	t.touchIdleLocked()
	t.mu.Unlock()
	if emit != nil {
		emit(streamEvent{Kind: streamEventChunk, RequestID: t.id, Seq: seq, Data: data})
	}
	return nil
}

func (t *transaction) emitHeaders(metadata responseMetadata) error {
	t.mu.Lock()
	if t.state != transactionOpen || t.headersEmitted {
		t.mu.Unlock()
		return newTransactionError("REQUEST_TERMINAL", "HTTP", false)
	}
	t.headersEmitted = true
	emit := t.emit
	t.touchIdleLocked()
	t.mu.Unlock()
	if emit != nil {
		emit(streamEvent{Kind: streamEventHeaders, RequestID: t.id, Headers: &metadata})
	}
	return nil
}

func (t *transaction) finish(outcome terminalOutcome) bool {
	t.mu.Lock()
	if t.state == transactionTerminal {
		t.mu.Unlock()
		return false
	}
	t.state = transactionTerminal
	outcome.FinalSeq = t.nextDownloadSeq
	t.terminal = &outcome
	uploadOutstanding := t.uploadOutstanding
	t.uploadOutstanding = nil
	idleTimer, totalTimer := t.idleTimer, t.totalTimer
	t.idleTimer, t.totalTimer = nil, nil
	emit := t.emit
	t.mu.Unlock()
	if idleTimer != nil {
		idleTimer.Stop()
	}
	if totalTimer != nil {
		totalTimer.Stop()
	}
	t.cancel()
	t.signalDownload()
	t.upload.close(terminalCause(outcome))
	if uploadOutstanding != nil {
		uploadOutstanding <- terminalCause(outcome)
	}
	if emit != nil {
		emit(streamEvent{Kind: streamEventTerminal, RequestID: t.id, Terminal: &outcome})
	}
	return true
}

func terminalCause(outcome terminalOutcome) error {
	if outcome.OK {
		return errQueueClosed
	}
	if outcome.Code == "CANCELED" {
		return errTransactionCanceled
	}
	return newTransactionError(outcome.Code, outcome.Stage, outcome.Retryable)
}

func (t *transaction) cancelTransaction() bool {
	return t.finish(terminalOutcome{Code: "CANCELED", Stage: "BODY", Retryable: false})
}

func (t *transaction) cancelFrame(seq uint64, code string) error {
	t.mu.Lock()
	if t.state == transactionTerminal {
		idempotent := t.terminal != nil && t.terminal.Code == "CANCELED" &&
			t.terminal.FinalSeq == seq && t.cancelCode == code
		t.mu.Unlock()
		if idempotent {
			return nil
		}
		return newTransactionError("CANCEL_SEQUENCE", "BODY", false)
	}
	if seq != t.nextDownloadSeq {
		t.mu.Unlock()
		return newTransactionError("CANCEL_SEQUENCE", "BODY", false)
	}
	t.cancelCode = code
	t.mu.Unlock()
	t.finish(terminalOutcome{Code: "CANCELED", Stage: "BODY", Retryable: false})
	return nil
}

func (t *transaction) errorFrame(seq uint64, code string) error {
	classification := normalizeTransactionError(code, "BODY", false)
	if classification.Code != code {
		return classification
	}
	t.mu.Lock()
	if t.state == transactionTerminal {
		idempotent := t.inputErrorCode == code && t.inputErrorSeq == seq
		t.mu.Unlock()
		if idempotent {
			return nil
		}
		return newTransactionError("ERROR_SEQUENCE", "BODY", false)
	}
	if !t.uploadPullOutstanding || seq != t.nextUploadSeq {
		t.mu.Unlock()
		return newTransactionError("ERROR_SEQUENCE", "BODY", false)
	}
	t.inputErrorSeq = seq
	t.inputErrorCode = code
	t.mu.Unlock()
	t.finish(terminalOutcome{Code: classification.Code, Stage: classification.Stage, Retryable: classification.Retryable})
	return nil
}

func (t *transaction) relayLost() bool {
	return t.finish(terminalOutcome{Code: "RELAY_LOST", Stage: "RELAY", Retryable: true})
}

// uploadReader provides the HTTP writer a chunk-at-a-time body view. It does
// not coalesce the entire upload, and it resolves each producer acknowledgement
// only when that chunk has been consumed by the request writer.
type uploadReader struct {
	t         *transaction
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	current   queuedChunk
	offset    int
}

func newUploadReader(transaction *transaction) *uploadReader {
	ctx, cancel := context.WithCancel(transaction.Context())
	return &uploadReader{t: transaction, ctx: ctx, cancel: cancel}
}

func (r *uploadReader) Close() error {
	r.t.discardUpload()
	r.closeOnce.Do(r.cancel)
	return nil
}

func (r *uploadReader) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	if r.ctx.Err() != nil || r.t.Context().Err() != nil {
		return 0, errTransactionCanceled
	}
	if err := r.loadCurrent(min(len(dst), r.t.maxChunk)); err != nil {
		return 0, err
	}
	n := copy(dst, r.current.data[r.offset:])
	r.offset += n
	r.releaseCurrentIfConsumed()
	return n, nil
}

func (r *uploadReader) loadCurrent(desired int) error {
	if r.current.data != nil {
		return nil
	}
	if err := r.t.requestUpload(desired); err != nil {
		return uploadReadError(err)
	}
	item, err := r.t.upload.dequeue(r.ctx)
	if err != nil {
		return uploadReadError(err)
	}
	r.t.mu.Lock()
	open := r.t.state == transactionOpen
	discarding := r.t.uploadDiscarding || r.ctx.Err() != nil
	terminal := r.t.terminal
	if open && !discarding {
		r.current, r.offset = item, 0
		r.t.uploadOutstanding = r.current.ack
		r.t.mu.Unlock()
		return nil
	}
	r.t.mu.Unlock()
	if open {
		item.ack <- nil
	} else {
		item.ack <- terminalCause(*terminal)
	}
	return errTransactionCanceled
}

func uploadReadError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, errTransactionCanceled) {
		return errTransactionCanceled
	}
	return err
}

func (r *uploadReader) releaseCurrentIfConsumed() {
	if r.offset != len(r.current.data) {
		return
	}
	r.t.mu.Lock()
	acknowledge := r.t.uploadOutstanding == r.current.ack
	if acknowledge {
		r.t.uploadOutstanding = nil
	}
	r.t.mu.Unlock()
	if acknowledge {
		r.current.ack <- nil
	}
	r.current, r.offset = queuedChunk{}, 0
}

// requestIDLedger is a fixed-size, fail-closed replay filter. It has no
// unbounded terminal-request map: a false positive can only reject a new
// request, never admit a replayed request ID.
type requestIDLedger struct {
	mu   sync.Mutex
	bits [requestIDFilterWords]uint64
}

func (l *requestIDLedger) reserve(id string) error {
	if !validRequestID(id) {
		return newTransactionError("REQUEST_ID_INVALID", "INTERNAL", false)
	}
	sum := sha256.Sum256([]byte(id))
	indexes := [4]uint16{
		uint16(sum[0])<<8 | uint16(sum[1]),
		uint16(sum[8])<<8 | uint16(sum[9]),
		uint16(sum[16])<<8 | uint16(sum[17]),
		uint16(sum[24])<<8 | uint16(sum[25]),
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	seen := true
	for _, index := range indexes {
		slot := index % (requestIDFilterWords * 64)
		word, bit := slot/64, uint(slot%64)
		if l.bits[word]&(uint64(1)<<bit) == 0 {
			seen = false
		}
	}
	if seen {
		return newTransactionError("REQUEST_ID_REPLAY", "INTERNAL", false)
	}
	for _, index := range indexes {
		slot := index % (requestIDFilterWords * 64)
		word, bit := slot/64, uint(slot%64)
		l.bits[word] |= uint64(1) << bit
	}
	return nil
}

func validRequestID(id string) bool {
	if len(id) < 16 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !validRequestIDCharacter(c) {
			return false
		}
	}
	return true
}

func validRequestIDCharacter(c rune) bool {
	if c == '-' || c == '_' {
		return true
	}
	switch {
	case c >= 'a' && c <= 'z':
		return true
	case c >= 'A' && c <= 'Z':
		return true
	case c >= '0' && c <= '9':
		return true
	default:
		return false
	}
}

func (t *transaction) String() string {
	return fmt.Sprintf("transaction(%s)", t.id)
}

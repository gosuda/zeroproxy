package transportlab

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// MaxHTTP2ResponseBytes bounds scripted response data before it reaches a client.
	MaxHTTP2ResponseBytes = 1 << 20
	// MaxHTTP2Chunks bounds a response's independently flushed chunks.
	MaxHTTP2Chunks = 1024
	// MaxSSEEvents bounds a single scripted event stream.
	MaxSSEEvents = 1024

	maxHTTP2HeaderBytes       = 64 << 10
	maxHTTP2ScenarioDelay     = 5 * time.Second
	maxHTTP2SSEEventDataBytes = 64 << 10
)

// SSEEvent is one server-sent event. Data is split into data fields at newlines.
type SSEEvent struct {
	ID    string
	Event string
	Data  string
	Retry time.Duration
}

// HTTP2Scenario scripts one local HTTP/2 response. BodyChunks and SSEEvents are
// written in order and flushed after each item. ObserveCancellation keeps the
// stream open after scripted output so a test can observe client cancellation.
type HTTP2Scenario struct {
	RequirePath         string
	Status              int
	Headers             http.Header
	BodyChunks          [][]byte
	SSEEvents           []SSEEvent
	ChunkDelay          time.Duration
	EventDelay          time.Duration
	ObserveCancellation bool
}

// HTTP2Lab is a bounded TLS HTTP/2 target fixture. It never leaves loopback and
// records only request metadata, never request bodies.
type HTTP2Lab struct {
	server *httptest.Server
	slots  chan struct{}

	mu            sync.Mutex
	scenarios     []HTTP2Scenario
	requests      []http.Request
	cancellations int
	cancelled     chan struct{}
	started       bool
}

// NewHTTP2 creates an unstarted HTTP/2 fixture with ordered scenarios.
func NewHTTP2(scenarios ...HTTP2Scenario) *HTTP2Lab {
	lab := &HTTP2Lab{
		scenarios: append([]HTTP2Scenario(nil), scenarios...),
		slots:     make(chan struct{}, MaxConnections),
		cancelled: make(chan struct{}, MaxConnections),
	}
	lab.server = httptest.NewUnstartedServer(http.HandlerFunc(lab.serve))
	lab.server.EnableHTTP2 = true
	return lab
}

// Start begins a loopback-only TLS server with HTTP/2 enabled.
func (l *HTTP2Lab) Start() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.started {
		return errors.New("transport HTTP/2 lab already started")
	}
	if err := validateHTTP2Scenarios(l.scenarios); err != nil {
		return err
	}
	l.server.StartTLS()
	l.started = true
	return nil
}

// URL returns the fixture's local HTTPS authority after Start.
func (l *HTTP2Lab) URL() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.started {
		return ""
	}
	return l.server.URL
}

// Client returns a client configured to trust only this fixture's test certificate.
func (l *HTTP2Lab) Client() *http.Client {
	return l.server.Client()
}

// Close cancels active streams and shuts down the local test server.
func (l *HTTP2Lab) Close(ctx context.Context) error {
	l.mu.Lock()
	started := l.started
	l.mu.Unlock()
	if !started {
		return nil
	}
	l.server.CloseClientConnections()
	return l.server.Config.Shutdown(ctx)
}

// Requests returns metadata-only copies of observed requests.
func (l *HTTP2Lab) Requests() []http.Request {
	l.mu.Lock()
	defer l.mu.Unlock()
	requests := make([]http.Request, len(l.requests))
	copy(requests, l.requests)
	return requests
}

// Cancellations reports the number of ObserveCancellation scenarios whose client
// stream was canceled or whose server context was terminated.
func (l *HTTP2Lab) Cancellations() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cancellations
}

// WaitForCancellation blocks until one observed stream is canceled or ctx ends.
func (l *HTTP2Lab) WaitForCancellation(ctx context.Context) error {
	select {
	case <-l.cancelled:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l *HTTP2Lab) serve(response http.ResponseWriter, request *http.Request) {
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	default:
		http.Error(response, "transport lab connection limit", http.StatusServiceUnavailable)
		return
	}

	request.Body = http.MaxBytesReader(response, request.Body, MaxRequestBody)
	if _, err := io.Copy(io.Discard, request.Body); err != nil {
		http.Error(response, "transport lab request body limit", http.StatusRequestEntityTooLarge)
		return
	}
	_ = request.Body.Close()
	l.record(request)

	scenario, ok := l.nextScenario()
	if !ok || (scenario.RequirePath != "" && request.URL.Path != scenario.RequirePath) {
		http.Error(response, "transport lab scenario mismatch", http.StatusNotFound)
		return
	}
	if scenario.ObserveCancellation {
		defer func() {
			if request.Context().Err() != nil {
				l.noteCancellation()
			}
		}()
	}

	for name, values := range scenario.Headers {
		for _, value := range values {
			response.Header().Add(name, value)
		}
	}
	if len(scenario.SSEEvents) != 0 && response.Header().Get("Content-Type") == "" {
		response.Header().Set("Content-Type", "text/event-stream")
	}
	status := scenario.Status
	if status == 0 {
		status = http.StatusOK
	}
	response.WriteHeader(status)
	flusher, _ := response.(http.Flusher)

	for index, chunk := range scenario.BodyChunks {
		if _, err := response.Write(chunk); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		if index+1 < len(scenario.BodyChunks) && !waitHTTP2(request.Context(), scenario.ChunkDelay) {
			return
		}
	}
	for index, event := range scenario.SSEEvents {
		if _, err := io.WriteString(response, event.wire()); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		if index+1 < len(scenario.SSEEvents) && !waitHTTP2(request.Context(), scenario.EventDelay) {
			return
		}
	}
	if scenario.ObserveCancellation {
		<-request.Context().Done()
	}
}

func (l *HTTP2Lab) nextScenario() (HTTP2Scenario, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.scenarios) == 0 {
		return HTTP2Scenario{}, false
	}
	scenario := l.scenarios[0]
	l.scenarios = l.scenarios[1:]
	return scenario, true
}

func (l *HTTP2Lab) record(request *http.Request) {
	clone := request.Clone(request.Context())
	clone.Body = nil
	l.mu.Lock()
	l.requests = append(l.requests, *clone)
	l.mu.Unlock()
}

func (l *HTTP2Lab) noteCancellation() {
	l.mu.Lock()
	l.cancellations++
	l.mu.Unlock()
	select {
	case l.cancelled <- struct{}{}:
	default:
	}
}

func (event SSEEvent) wire() string {
	var builder strings.Builder
	if event.ID != "" {
		builder.WriteString("id: ")
		builder.WriteString(event.ID)
		builder.WriteByte('\n')
	}
	if event.Event != "" {
		builder.WriteString("event: ")
		builder.WriteString(event.Event)
		builder.WriteByte('\n')
	}
	if event.Retry > 0 {
		builder.WriteString("retry: ")
		builder.WriteString(strconv.FormatInt(event.Retry.Milliseconds(), 10))
		builder.WriteByte('\n')
	}
	for _, line := range strings.Split(event.Data, "\n") {
		builder.WriteString("data: ")
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	builder.WriteByte('\n')
	return builder.String()
}

func waitHTTP2(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return true
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func validateHTTP2Scenarios(scenarios []HTTP2Scenario) error {
	for _, scenario := range scenarios {
		if scenario.Status != 0 && (scenario.Status < 100 || scenario.Status > 599) {
			return errors.New("transport HTTP/2 lab invalid status")
		}
		if len(scenario.BodyChunks) > MaxHTTP2Chunks || len(scenario.SSEEvents) > MaxSSEEvents {
			return errors.New("transport HTTP/2 lab response item limit")
		}
		var bytes int
		for _, chunk := range scenario.BodyChunks {
			bytes += len(chunk)
			if bytes > MaxHTTP2ResponseBytes {
				return errors.New("transport HTTP/2 lab response byte limit")
			}
		}
		for name, values := range scenario.Headers {
			bytes += len(name)
			for _, value := range values {
				bytes += len(value)
			}
			if bytes > MaxHTTP2ResponseBytes+maxHTTP2HeaderBytes {
				return errors.New("transport HTTP/2 lab response byte limit")
			}
		}
		if bytes > MaxHTTP2ResponseBytes || headerBytes(scenario.Headers) > maxHTTP2HeaderBytes {
			return errors.New("transport HTTP/2 lab response byte limit")
		}
		for _, event := range scenario.SSEEvents {
			if len(event.Data) > maxHTTP2SSEEventDataBytes {
				return errors.New("transport HTTP/2 lab SSE event byte limit")
			}
			bytes += len(event.wire())
			if bytes > MaxHTTP2ResponseBytes {
				return errors.New("transport HTTP/2 lab response byte limit")
			}
		}
		delays := time.Duration(max(0, len(scenario.BodyChunks)-1))*scenario.ChunkDelay + time.Duration(max(0, len(scenario.SSEEvents)-1))*scenario.EventDelay
		if scenario.ChunkDelay < 0 || scenario.EventDelay < 0 || delays > maxHTTP2ScenarioDelay {
			return errors.New("transport HTTP/2 lab delay limit")
		}
	}
	return nil
}

func headerBytes(headers http.Header) int {
	bytes := 0
	for name, values := range headers {
		bytes += len(name)
		for _, value := range values {
			bytes += len(value)
		}
	}
	return bytes
}

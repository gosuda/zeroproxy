// Package transportlab supplies bounded, deterministic hostile transport fixtures.
package transportlab

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	MaxConnections = 64
	MaxRequestBody = 1 << 20
)

// Scenario controls a single response without exposing production network authority.
type Scenario struct {
	Status      int
	Headers     http.Header
	Body        []byte
	HeaderDelay time.Duration
	ChunkDelay  time.Duration
	ChunkBytes  int
	CloseEarly  bool
	RawResponse []byte
	RequirePath string
}

// Lab is a bounded local HTTP/1.1 target with scripted responses and observed requests.
type Lab struct {
	server *http.Server
	listen net.Listener
	slots  chan struct{}

	mu        sync.Mutex
	scenarios []Scenario
	requests  []http.Request
}

// TCPHandler scripts byte-level protocols such as SOCKS, TLS, smux, and WebSocket.
// It receives a connection only after the lab has accounted for its bounded slot.
type TCPHandler func(net.Conn)

// TCPServer is a bounded local byte-stream endpoint for hostile protocol fixtures.
type TCPServer struct {
	listen  net.Listener
	handler TCPHandler
	slots   chan struct{}
	done    chan struct{}
}

func NewTCP(handler TCPHandler) *TCPServer {
	return &TCPServer{handler: handler, slots: make(chan struct{}, MaxConnections), done: make(chan struct{})}
}

func (s *TCPServer) Start() error {
	if s.listen != nil {
		return errors.New("transport TCP lab already started")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	s.listen = listener
	go func() {
		defer close(s.done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			select {
			case s.slots <- struct{}{}:
				go func() {
					defer func() { <-s.slots }()
					defer connection.Close()
					if s.handler != nil {
						s.handler(connection)
					}
				}()
			default:
				_ = connection.Close()
			}
		}
	}()
	return nil
}

func (s *TCPServer) Address() string {
	if s.listen == nil {
		return ""
	}
	return s.listen.Addr().String()
}

func (s *TCPServer) Close() error {
	if s.listen == nil {
		return nil
	}
	err := s.listen.Close()
	<-s.done
	return err
}

func New(scenarios ...Scenario) *Lab {
	lab := &Lab{scenarios: append([]Scenario(nil), scenarios...), slots: make(chan struct{}, MaxConnections)}
	lab.server = &http.Server{Handler: http.HandlerFunc(lab.serve)}
	return lab
}

func (l *Lab) Start() error {
	if l.listen != nil {
		return errors.New("transport lab already started")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	l.listen = listener
	go func() { _ = l.server.Serve(listener) }()
	return nil
}

func (l *Lab) URL() string {
	if l.listen == nil {
		return ""
	}
	return "http://" + l.listen.Addr().String()
}

func (l *Lab) Close(ctx context.Context) error {
	if l.listen == nil {
		return nil
	}
	return l.server.Shutdown(ctx)
}

func (l *Lab) Requests() []http.Request {
	l.mu.Lock()
	defer l.mu.Unlock()
	requests := make([]http.Request, len(l.requests))
	copy(requests, l.requests)
	return requests
}

func (l *Lab) nextScenario() (Scenario, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.scenarios) == 0 {
		return Scenario{}, false
	}
	scenario := l.scenarios[0]
	l.scenarios = l.scenarios[1:]
	return scenario, true
}

func (l *Lab) record(request *http.Request) {
	clone := request.Clone(request.Context())
	clone.Body = nil
	l.mu.Lock()
	l.requests = append(l.requests, *clone)
	l.mu.Unlock()
}

func (l *Lab) serve(response http.ResponseWriter, request *http.Request) {
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	default:
		http.Error(response, "transport lab connection limit", http.StatusServiceUnavailable)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, MaxRequestBody)
	l.record(request)
	scenario, ok := l.nextScenario()
	if !ok || (scenario.RequirePath != "" && request.URL.Path != scenario.RequirePath) {
		http.Error(response, "transport lab scenario mismatch", http.StatusNotFound)
		return
	}
	if scenario.HeaderDelay > 0 {
		time.Sleep(scenario.HeaderDelay)
	}
	if len(scenario.RawResponse) != 0 {
		connection, _, err := response.(http.Hijacker).Hijack()
		if err == nil {
			_, _ = connection.Write(scenario.RawResponse)
			_ = connection.Close()
		}
		return
	}
	for name, values := range scenario.Headers {
		for _, value := range values {
			response.Header().Add(name, value)
		}
	}
	status := scenario.Status
	if status == 0 {
		status = http.StatusOK
	}
	response.WriteHeader(status)
	writer := bufio.NewWriter(response)
	chunk := scenario.ChunkBytes
	if chunk <= 0 {
		chunk = len(scenario.Body)
	}
	for offset := 0; offset < len(scenario.Body); offset += chunk {
		end := offset + chunk
		if end > len(scenario.Body) {
			end = len(scenario.Body)
		}
		if _, err := writer.Write(scenario.Body[offset:end]); err != nil {
			return
		}
		if err := writer.Flush(); err != nil {
			return
		}
		if scenario.ChunkDelay > 0 && end < len(scenario.Body) {
			time.Sleep(scenario.ChunkDelay)
		}
	}
	if scenario.CloseEarly {
		if connection, _, err := response.(http.Hijacker).Hijack(); err == nil {
			_ = connection.Close()
		}
	}
}

// Drain reads a bounded stream to EOF for cancellation and leak assertions.
func Drain(reader io.ReadCloser, maximum int64) error {
	defer reader.Close()
	_, err := io.Copy(io.Discard, io.LimitReader(reader, maximum+1))
	return err
}

// Package testproxy provides a fail-closed recording proxy for non-certifying browser egress tests.
package testproxy

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxDestinationLength = 1024
	maxConnections       = 64
	maxTunnelLifetime    = 5 * time.Minute
)

// Event records one browser-requested proxy destination without URL paths, headers, or bodies.
type Event struct {
	Sequence    uint64 `json:"sequence"`
	Method      string `json:"method"`
	Destination string `json:"destination"`
	Allowed     bool   `json:"allowed"`
}

// Recorder is an HTTP CONNECT/forward proxy restricted to an exact endpoint allowlist.
type Recorder struct {
	allowed   map[string]struct{}
	dialer    net.Dialer
	transport *http.Transport
	writer    io.Writer
	mu        sync.Mutex
	sequence  uint64
	slots     chan struct{}
}

// New returns a recorder that binds no sockets and dials only exact allowlisted host:port endpoints.
func New(allowedEndpoints []string, writer io.Writer) (*Recorder, error) {
	if writer == nil {
		return nil, fmt.Errorf("test proxy event writer is required")
	}
	allowed := make(map[string]struct{}, len(allowedEndpoints))
	for _, value := range allowedEndpoints {
		endpoint := normalizeEndpoint(value, 0)
		if endpoint == "" {
			return nil, fmt.Errorf("invalid test proxy allowlisted endpoint %q", value)
		}
		allowed[endpoint] = struct{}{}
	}
	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	recorder := &Recorder{
		allowed: allowed,
		dialer:  dialer,
		writer:  writer,
		slots:   make(chan struct{}, maxConnections),
	}
	recorder.transport = &http.Transport{
		Proxy:                 nil,
		DialContext:           recorder.dialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	return recorder, nil
}

func normalizeHost(value string) string {
	if len(value) == 0 || len(value) > maxDestinationLength || strings.ContainsAny(value, "\x00\r\n/@") {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(value), ".")
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	if host == "" || strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return ""
	}
	return host
}

func normalizeEndpoint(value string, defaultPort int) string {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		if defaultPort == 0 {
			return ""
		}
		host, portText = value, strconv.Itoa(defaultPort)
	}
	host = normalizeHost(host)
	port, err := strconv.Atoi(portText)
	if host == "" || err != nil || port < 1 || port > 65535 {
		return ""
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}
func (recorder *Recorder) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err == nil && (host == "localhost" || strings.HasSuffix(strings.ToLower(host), ".localhost")) {
		address = net.JoinHostPort("127.0.0.1", port)
	}
	return recorder.dialer.DialContext(ctx, network, address)
}

func requestDestination(request *http.Request) (string, string) {
	raw := request.Host
	defaultPort := 0
	if request.Method != http.MethodConnect && request.URL.Host != "" {
		raw = request.URL.Host
		switch request.URL.Scheme {
		case "http":
			defaultPort = 80
		case "https":
			defaultPort = 443
		}
	}
	endpoint := normalizeEndpoint(raw, defaultPort)
	if endpoint == "" {
		return raw, ""
	}
	return endpoint, endpoint
}

func (recorder *Recorder) record(method, destination string, allowed bool) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.sequence++
	return json.NewEncoder(recorder.writer).Encode(Event{
		Sequence: recorder.sequence, Method: method, Destination: destination, Allowed: allowed,
	})
}

// ServeHTTP records the destination, rejects non-allowlisted endpoints, and forwards no proxy credentials.
func (recorder *Recorder) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	destination, endpoint := requestDestination(request)
	_, allowed := recorder.allowed[endpoint]
	if err := recorder.record(request.Method, destination, allowed); err != nil {
		http.Error(response, "test proxy evidence unavailable", http.StatusServiceUnavailable)
		return
	}
	if !allowed {
		http.Error(response, "test proxy destination denied", http.StatusForbidden)
		return
	}
	select {
	case recorder.slots <- struct{}{}:
		defer func() { <-recorder.slots }()
	default:
		http.Error(response, "test proxy connection limit reached", http.StatusServiceUnavailable)
		return
	}
	if request.Method == http.MethodConnect {
		recorder.serveConnect(response, request, destination)
		return
	}
	recorder.serveForward(response, request)
}

func (recorder *Recorder) serveForward(response http.ResponseWriter, request *http.Request) {
	outbound := request.Clone(request.Context())
	outbound.RequestURI = ""
	outbound.Header.Del("Proxy-Authorization")
	outbound.Header.Del("Proxy-Connection")
	result, err := recorder.transport.RoundTrip(outbound)
	if err != nil {
		http.Error(response, "test proxy upstream unavailable", http.StatusBadGateway)
		return
	}
	defer func() { _ = result.Body.Close() }()
	for name, values := range result.Header {
		for _, value := range values {
			response.Header().Add(name, value)
		}
	}
	response.WriteHeader(result.StatusCode)
	_, _ = io.Copy(response, result.Body)
}

func (recorder *Recorder) serveConnect(response http.ResponseWriter, request *http.Request, destination string) {
	upstream, err := recorder.dialContext(request.Context(), "tcp", destination)
	if err != nil {
		http.Error(response, "test proxy tunnel unavailable", http.StatusBadGateway)
		return
	}
	hijacker, ok := response.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(response, "test proxy tunnel unsupported", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	defer func() { _ = client.Close() }()
	defer func() { _ = upstream.Close() }()
	deadline := time.Now().Add(maxTunnelLifetime)
	_ = client.SetDeadline(deadline)
	_ = upstream.SetDeadline(deadline)
	if err := writeConnectEstablished(buffered); err != nil {
		return
	}
	copyDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstream, client)
		if connection, ok := upstream.(*net.TCPConn); ok {
			_ = connection.CloseWrite()
		}
		close(copyDone)
	}()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
	_ = upstream.Close()
	<-copyDone
}

func writeConnectEstablished(buffered *bufio.ReadWriter) error {
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return err
	}
	return buffered.Flush()
}

// CloseIdleConnections releases outbound keep-alive connections.
func (recorder *Recorder) CloseIdleConnections() {
	recorder.transport.CloseIdleConnections()
}

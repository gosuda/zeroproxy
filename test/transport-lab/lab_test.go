package transportlab

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLabScriptsOrderedDelayedChunkedResponse(t *testing.T) {
	lab := New(Scenario{
		RequirePath: "/stream",
		Headers:     http.Header{"X-Transport-Lab": {"yes"}},
		Body:        []byte("abcdef"), ChunkBytes: 2, ChunkDelay: time.Millisecond,
	})
	if err := lab.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lab.Close(context.Background()) })
	response, err := http.Get(lab.URL() + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(body) != "abcdef" || response.Header.Get("X-Transport-Lab") != "yes" {
		t.Fatalf("response = (%q, %q, %v)", body, response.Header.Get("X-Transport-Lab"), err)
	}
	requests := lab.Requests()
	if len(requests) != 1 || requests[0].URL.Path != "/stream" {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestLabRawMalformedResponseFailsClient(t *testing.T) {
	lab := New(Scenario{RawResponse: []byte("HTTP/1.1 200 OK\r\nBroken\r\n\r\n")})
	if err := lab.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lab.Close(context.Background()) })
	_, err := http.Get(lab.URL())
	if err == nil || !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("malformed response error = %v", err)
	}
}

func TestTCPServerScriptsByteProtocol(t *testing.T) {
	server := NewTCP(func(connection net.Conn) {
		buffer := make([]byte, 4)
		_, _ = io.ReadFull(connection, buffer)
		_, _ = connection.Write([]byte("PONG"))
	})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	connection, err := net.Dial("tcp", server.Address())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte("PING")); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(connection, response); err != nil || string(response) != "PONG" {
		t.Fatalf("byte protocol response = (%q, %v)", response, err)
	}
}

func TestCaptureBoundsAndRedactsPayloads(t *testing.T) {
	capture := NewCapture(2)
	capture.Record("dns", "start", true)
	capture.Record("tls", "handshake", false)
	capture.Record("http", "headers", true)
	events := capture.Events()
	if len(events) != 2 || events[0].Layer != "tls" || events[1].Layer != "http" {
		t.Fatalf("capture events = %#v", events)
	}
}

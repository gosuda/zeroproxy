package smuxconn

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestSessionOpenAcceptRoundTripsStreams(t *testing.T) {
	left, right := net.Pipe()
	client, server := newSessionPair(t, left, right)
	defer client.Close()
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	accepted := make(chan net.Conn, 1)
	errs := make(chan error, 1)
	go func() {
		stream, err := server.Accept(ctx)
		if err != nil {
			errs <- err
			return
		}
		accepted <- stream
	}()

	clientStream, err := client.OpenStream(ctx)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	defer clientStream.Close()

	serverStream := recvStream(t, accepted, errs)
	defer serverStream.Close()

	writeRead(t, clientStream, serverStream, "client-to-server")
	writeRead(t, serverStream, clientStream, "server-to-client")
}

func TestSessionReportsClosedAfterClose(t *testing.T) {
	left, right := net.Pipe()
	client, server := newSessionPair(t, left, right)
	defer server.Close()

	if client.IsClosed() {
		t.Fatal("new client session is closed")
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !client.IsClosed() {
		t.Fatal("closed client session did not report closed")
	}
}

func TestSessionAcceptHonorsContextCancellation(t *testing.T) {
	left, right := net.Pipe()
	client, server := newSessionPair(t, left, right)
	defer client.Close()
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stream, err := server.Accept(ctx)
	if err == nil {
		_ = stream.Close()
		t.Fatal("Accept returned nil error after context cancellation")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Accept error = %v, want context.Canceled", err)
	}
}

func newSessionPair(t *testing.T, left, right net.Conn) (*Session, *Session) {
	t.Helper()
	serverCh := make(chan *Session, 1)
	errCh := make(chan error, 1)
	go func() {
		server, err := Server(right)
		if err != nil {
			errCh <- err
			return
		}
		serverCh <- server
	}()

	client, err := Client(left)
	if err != nil {
		t.Fatalf("Client: %v", err)
	}
	select {
	case server := <-serverCh:
		return client, server
	case err := <-errCh:
		_ = client.Close()
		t.Fatalf("Server: %v", err)
	case <-time.After(5 * time.Second):
		_ = client.Close()
		t.Fatal("Server timed out")
	}
	return nil, nil
}

func recvStream(t *testing.T, streams <-chan net.Conn, errs <-chan error) net.Conn {
	t.Helper()
	select {
	case stream := <-streams:
		return stream
	case err := <-errs:
		t.Fatalf("Accept: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("Accept timed out")
	}
	return nil
}

func writeRead(t *testing.T, writer, reader net.Conn, msg string) {
	t.Helper()
	if _, err := io.WriteString(writer, msg); err != nil {
		t.Fatalf("Write(%q): %v", msg, err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(reader, buf); err != nil {
		t.Fatalf("ReadFull(%q): %v", msg, err)
	}
	if string(buf) != msg {
		t.Fatalf("round trip = %q, want %q", string(buf), msg)
	}
}

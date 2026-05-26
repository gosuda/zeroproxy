package main

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestBridgeToTorClosesBothEndsOnContextCancel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, stream := net.Pipe()
	defer client.Close()
	s := &server{socksAddr: ln.Addr().String()}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.bridgeToTor(ctx, stream); close(done) }()
	var upstream net.Conn
	select {
	case upstream = <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not dial upstream")
	}
	defer upstream.Close()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not return after cancellation")
	}
	buf := make([]byte, 1)
	_ = upstream.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, err := upstream.Read(buf); err == nil {
		t.Fatal("upstream remained readable after bridge cancellation")
	}
	_ = client.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, err := client.Read(buf); err == nil {
		t.Fatal("stream peer remained readable after bridge cancellation")
	}
}

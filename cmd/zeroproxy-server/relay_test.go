package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
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

func TestBridgeInternalSOCKSConnectsToTarget(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	targetDone := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			targetDone <- err
			return
		}
		defer c.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(c, buf); err != nil {
			targetDone <- err
			return
		}
		if string(buf) != "ping" {
			targetDone <- fmt.Errorf("target payload = %q", buf)
			return
		}
		_, err = c.Write([]byte("pong"))
		targetDone <- err
	}()

	client, stream := net.Pipe()
	defer client.Close()
	s := &server{socksAddr: internalSOCKSMode}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { s.bridgeTargetStream(ctx, stream); close(done) }()

	if _, err := client.Write([]byte{0x05, 0x02, 0x02, 0x00}); err != nil {
		t.Fatal(err)
	}
	method := make([]byte, 2)
	if _, err := io.ReadFull(client, method); err != nil {
		t.Fatal(err)
	}
	if method[0] != 0x05 || method[1] != 0x02 {
		t.Fatalf("auth method = %x", method)
	}
	if _, err := client.Write([]byte{0x01, 0x02, 'z', 'p', 0x02, 'o', 'k'}); err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 2)
	if _, err := io.ReadFull(client, auth); err != nil {
		t.Fatal(err)
	}
	if auth[0] != 0x01 || auth[1] != 0x00 {
		t.Fatalf("auth response = %x", auth)
	}
	host := []byte("localhost")
	req := make([]byte, 0, 7+len(host))
	req = append(req, 0x05, 0x01, 0x00, 0x03, byte(len(host)))
	req = append(req, host...)
	var port [2]byte
	binary.BigEndian.PutUint16(port[:], uint16(ln.Addr().(*net.TCPAddr).Port))
	req = append(req, port[:]...)
	if _, err := client.Write(req); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	if reply[0] != 0x05 || reply[1] != 0x00 {
		t.Fatalf("connect reply = %x", reply)
	}
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 4)
	if _, err := io.ReadFull(client, echo); err != nil {
		t.Fatal(err)
	}
	if string(echo) != "pong" {
		t.Fatalf("echo = %q", echo)
	}
	select {
	case err := <-targetDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("target did not finish")
	}
	cancel()
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("internal bridge did not return")
	}
}

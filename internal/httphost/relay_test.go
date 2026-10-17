package httphost

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
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

func dialSOCKS5IPv4(t *testing.T, s *server, ip net.IP, port uint16) byte {
	t.Helper()
	client, stream := net.Pipe()
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { s.bridgeTargetStream(ctx, stream); close(done) }()

	if _, err := client.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	method := make([]byte, 2)
	if _, err := io.ReadFull(client, method); err != nil {
		t.Fatal(err)
	}
	if method[0] != 0x05 || method[1] != 0x00 {
		t.Fatalf("auth method = %x", method)
	}
	ip4 := ip.To4()
	req := []byte{0x05, 0x01, 0x00, 0x01, ip4[0], ip4[1], ip4[2], ip4[3], byte(port >> 8), byte(port)}
	if _, err := client.Write(req); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	<-done
	return reply[1]
}

func TestBridgeInternalSOCKSBlocksLinkLocalAndPrivateTargets(t *testing.T) {
	internalSrv := &server{socksAddr: internalSOCKSMode}
	if rep := dialSOCKS5IPv4(t, internalSrv, net.ParseIP("169.254.169.254"), 80); rep == 0x00 {
		t.Fatal("internal mode must reject 169.254.169.254")
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	disallowSrv := &server{socksAddr: internalSOCKSMode, disallowPrivateTargets: true}
	if rep := dialSOCKS5IPv4(t, disallowSrv, net.ParseIP("127.0.0.1"), port); rep == 0x00 {
		t.Fatal("DisallowPrivateTargets must reject 127.0.0.1")
	}

	directSrv := &server{socksAddr: directSOCKSMode}
	if rep := dialSOCKS5IPv4(t, directSrv, net.ParseIP("127.0.0.1"), port); rep == 0x00 {
		t.Fatal("direct mode must reject 127.0.0.1")
	}
}

func TestCrossOriginRejectedOnPipeAndConfig(t *testing.T) {
	h := NewHandler(Config{SocksAddr: internalSOCKSMode})

	for _, path := range []string{"/zp/ws-pipe", "/zp/api/config"} {
		req := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080"+path, nil)
		req.Header.Set("Origin", "https://evil.example")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s with cross-origin Origin = %d, want %d", path, rec.Code, http.StatusForbidden)
		}

		reqCrossSite := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080"+path, nil)
		reqCrossSite.Header.Set("Sec-Fetch-Site", "cross-site")
		recCrossSite := httptest.NewRecorder()
		h.ServeHTTP(recCrossSite, reqCrossSite)
		if recCrossSite.Code != http.StatusForbidden {
			t.Fatalf("%s with cross-site Sec-Fetch-Site = %d, want %d", path, recCrossSite.Code, http.StatusForbidden)
		}
	}

	reqOK := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080/zp/api/config", nil)
	reqOK.Header.Set("Origin", "http://proxy.localhost:8080")
	reqOK.Header.Set("Sec-Fetch-Site", "same-origin")
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("/zp/api/config same-origin = %d, want %d", recOK.Code, http.StatusOK)
	}
}

func TestZeroCSPHonorsForwardedProtoOnlyFromTrustedPeers(t *testing.T) {
	untrusted := &server{trustProxyHeaders: false}
	reqRemote := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080/zp/", nil)
	reqRemote.RemoteAddr = "203.0.113.9:4321"
	reqRemote.Header.Set("X-Forwarded-Proto", "https")
	if csp := untrusted.zeroCSP(reqRemote); !strings.Contains(csp, "ws://proxy.localhost:8080") {
		t.Fatalf("untrusted remote peer spoofed X-Forwarded-Proto: %s", csp)
	}

	reqLoopback := httptest.NewRequest(http.MethodGet, "http://proxy.localhost:8080/zp/", nil)
	reqLoopback.RemoteAddr = "127.0.0.1:4321"
	reqLoopback.Header.Set("X-Forwarded-Proto", "https")
	if csp := untrusted.zeroCSP(reqLoopback); !strings.Contains(csp, "wss://proxy.localhost:8080") {
		t.Fatalf("loopback peer X-Forwarded-Proto ignored: %s", csp)
	}

	trusted := &server{trustProxyHeaders: true}
	if csp := trusted.zeroCSP(reqRemote); !strings.Contains(csp, "wss://proxy.localhost:8080") {
		t.Fatalf("TrustProxyHeaders=true did not honor X-Forwarded-Proto: %s", csp)
	}
}

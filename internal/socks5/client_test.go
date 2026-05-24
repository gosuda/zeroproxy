package socks5

import (
	"bytes"
	"context"
	"io"
	"testing"
)

type scriptedRW struct {
	in  bytes.Buffer
	out bytes.Buffer
}

func (s *scriptedRW) Read(p []byte) (int, error)  { return s.in.Read(p) }
func (s *scriptedRW) Write(p []byte) (int, error) { return s.out.Write(p) }

func TestConnectDomainUsesAuthAndDomainATYP(t *testing.T) {
	rw := &scriptedRW{}
	rw.in.Write([]byte{0x05, 0x02})
	rw.in.Write([]byte{0x01, 0x00})
	rw.in.Write([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00})
	if err := ConnectDomain(context.Background(), rw, Options{Host: "Example.COM", Port: "443", Username: "token", Password: "zp"}); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(&rw.out)
	wantPrefix := []byte{0x05, 0x02, 0x02, 0x00, 0x01, 0x05, 't', 'o', 'k', 'e', 'n', 0x02, 'z', 'p', 0x05, 0x01, 0x00, 0x03, 0x0b}
	if !bytes.HasPrefix(got, wantPrefix) {
		t.Fatalf("handshake prefix mismatch: %v", got)
	}
	if !bytes.Contains(got, []byte("example.com")) {
		t.Fatalf("domain was not normalized/preserved as domain: %v", got)
	}
}

func TestConnectDomainRejectsIPLiteral(t *testing.T) {
	if err := ConnectDomain(context.Background(), &scriptedRW{}, Options{Host: "93.184.216.34", Port: "80"}); err == nil {
		t.Fatal("expected IP literal rejection")
	}
}

package transportlab

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/socks5"
)

const socksFixtureTimeout = time.Second

func startRFC1929Fixture(t *testing.T, scenario SOCKS5Scenario) *TCPServer {
	t.Helper()
	server := NewTCP(RFC1929Handler(scenario))
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func dialRFC1929Fixture(t *testing.T, server *TCPServer) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("tcp", server.Address(), socksFixtureTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(socksFixtureTimeout)); err != nil {
		_ = connection.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func TestRFC1929HandlerAcceptsDomainConnect(t *testing.T) {
	observed := make(chan SOCKS5Request, 1)
	server := startRFC1929Fixture(t, SOCKS5Scenario{
		Username: "fixture-user",
		Password: "fixture-password",
		Accept:   true,
		Observed: observed,
	})

	if err := socks5.Connect(
		dialRFC1929Fixture(t, server),
		"WWW.EXAMPLE.CO.UK",
		443,
		&socks5.Credentials{Username: "fixture-user", Password: "fixture-password"},
	); err != nil {
		t.Fatalf("domain CONNECT failed: %v", err)
	}

	select {
	case request := <-observed:
		if request != (SOCKS5Request{Host: "www.example.co.uk", Port: 443}) {
			t.Fatalf("observed authority = %#v", request)
		}
	case <-time.After(socksFixtureTimeout):
		t.Fatal("fixture did not observe CONNECT authority")
	}
}

func TestRFC1929HandlerRejectsNoAuthDowngrade(t *testing.T) {
	server := startRFC1929Fixture(t, SOCKS5Scenario{Username: "fixture-user", Password: "fixture-password", Accept: true})
	connection := dialRFC1929Fixture(t, server)

	if _, err := connection.Write([]byte{5, 1, 0}); err != nil {
		t.Fatal(err)
	}
	var selection [2]byte
	if _, err := io.ReadFull(connection, selection[:]); err != nil {
		t.Fatal(err)
	}
	if selection != [2]byte{5, 0xff} {
		t.Fatalf("authentication selection = %x", selection)
	}
}

func TestRFC1929HandlerRejectsBadCredentials(t *testing.T) {
	observed := make(chan SOCKS5Request, 1)
	server := startRFC1929Fixture(t, SOCKS5Scenario{
		Username: "fixture-user",
		Password: "fixture-password",
		Accept:   true,
		Observed: observed,
	})

	err := socks5.Connect(
		dialRFC1929Fixture(t, server),
		"www.example.co.uk",
		443,
		&socks5.Credentials{Username: "fixture-user", Password: "wrong-password"},
	)
	if err == nil {
		t.Fatal("bad credentials were accepted")
	}
	select {
	case request := <-observed:
		t.Fatalf("CONNECT was observed after authentication failure: %#v", request)
	default:
	}
}

func TestRFC1929HandlerReturnsConnectRejection(t *testing.T) {
	observed := make(chan SOCKS5Request, 1)
	server := startRFC1929Fixture(t, SOCKS5Scenario{
		Username: "fixture-user",
		Password: "fixture-password",
		Observed: observed,
	})

	err := socks5.Connect(
		dialRFC1929Fixture(t, server),
		"www.example.co.uk",
		443,
		&socks5.Credentials{Username: "fixture-user", Password: "fixture-password"},
	)
	var reply *socks5.ReplyError
	if !errors.As(err, &reply) || reply.Code != 5 {
		t.Fatalf("CONNECT rejection = %v", err)
	}

	select {
	case request := <-observed:
		if request != (SOCKS5Request{Host: "www.example.co.uk", Port: 443}) {
			t.Fatalf("observed authority = %#v", request)
		}
	case <-time.After(socksFixtureTimeout):
		t.Fatal("fixture did not observe rejected CONNECT authority")
	}
}

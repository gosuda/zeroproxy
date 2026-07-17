package socks5

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
)

func closeClientTestConn(t *testing.T, conn net.Conn) {
	t.Helper()
	if err := conn.Close(); err != nil {
		t.Errorf("close connection: %v", err)
	}
}

func TestConnectDomainWithAuthentication(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		err := func() error {
			var greeting [3]byte
			if _, err := io.ReadFull(server, greeting[:]); err != nil {
				return err
			}
			if !bytes.Equal(greeting[:], []byte{5, 1, 2}) {
				return fmt.Errorf("greeting %x", greeting)
			}
			if err := writeFull(server, []byte{5, 2}); err != nil {
				return err
			}
			auth := make([]byte, 1+1+4+1+4)
			if _, err := io.ReadFull(server, auth); err != nil {
				return err
			}
			if !bytes.Equal(auth, []byte{1, 4, 'u', 's', 'e', 'r', 4, 'p', 'a', 's', 's'}) {
				return fmt.Errorf("auth %x", auth)
			}
			if err := writeFull(server, []byte{1, 0}); err != nil {
				return err
			}
			request := make([]byte, 5+len("www.example.co.uk")+2)
			if _, err := io.ReadFull(server, request); err != nil {
				return err
			}
			if !bytes.Equal(request[:5], []byte{5, 1, 0, 3, 17}) ||
				string(request[5:22]) != "www.example.co.uk" {
				return fmt.Errorf("request %x", request)
			}
			return writeFull(server, []byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
		}()
		if closeErr := server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		done <- err
	}()
	if err := Connect(client, "WWW.EXAMPLE.CO.UK", 443, &Credentials{Username: "user", Password: "pass"}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestConnectRejectsNoAuthenticationDowngrade(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		err := func() error {
			var greeting [3]byte
			if _, err := io.ReadFull(server, greeting[:]); err != nil {
				return err
			}
			if !bytes.Equal(greeting[:], []byte{5, 1, 2}) {
				return fmt.Errorf("greeting %x", greeting)
			}
			return writeFull(server, []byte{5, 0})
		}()
		if closeErr := server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		done <- err
	}()
	if err := Connect(client, "www.example.co.uk", 443, &Credentials{Username: "user", Password: "pass"}); err == nil {
		t.Fatal("no-authentication downgrade accepted")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestConnectRejectsMissingIsolationCredentialsBeforeWriting(t *testing.T) {
	for name, credentials := range map[string]*Credentials{
		"nil":            nil,
		"empty username": {Password: "password"},
		"empty password": {Username: "username"},
	} {
		t.Run(name, func(t *testing.T) {
			client, server := net.Pipe()
			defer closeClientTestConn(t, client)
			defer closeClientTestConn(t, server)
			if err := Connect(client, "www.example.co.uk", 443, credentials); err == nil {
				t.Fatal("missing isolation credentials accepted")
			}
		})
	}
}

func TestConnectReplyPreservesFailureCode(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		done <- writeFull(server, []byte{5, 4, 0, 1})
		_ = server.Close()
	}()
	err := readConnectReply(client)
	var reply *ReplyError
	if !errors.As(err, &reply) || reply.Code != 4 || !errors.Is(err, ErrProtocol) {
		t.Fatalf("reply error=%v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

package socks5

import (
	"bytes"
	"io"
	"net"
	"testing"
)

type connectResult struct {
	request Request
	err     error
}

func authenticateTestClient(t *testing.T, conn net.Conn) {
	t.Helper()
	if err := writeFull(conn, []byte{5, 1, 2}); err != nil {
		t.Fatal(err)
	}
	var selection [2]byte
	if _, err := io.ReadFull(conn, selection[:]); err != nil {
		t.Fatal(err)
	}
	if selection != [2]byte{5, 2} {
		t.Fatalf("selection %x", selection)
	}
	if err := writeFull(conn, []byte{1, 4, 'u', 's', 'e', 'r', 4, 'p', 'a', 's', 's'}); err != nil {
		t.Fatal(err)
	}
	var response [2]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil {
		t.Fatal(err)
	}
	if response != [2]byte{1, 0} {
		t.Fatalf("authentication response %x", response)
	}
}

func TestReadConnectRequiresDomainAndPreservesIsolationCredentials(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan connectResult, 1)
	go func() {
		request, err := ReadConnect(server)
		if closeErr := server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		done <- connectResult{request: request, err: err}
	}()
	if err := writeFull(client, []byte{5, 2, 0, 2}); err != nil {
		t.Fatal(err)
	}
	var selection [2]byte
	if _, err := io.ReadFull(client, selection[:]); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(selection[:], []byte{5, 2}) {
		t.Fatalf("selection %x", selection)
	}
	if err := writeFull(client, []byte{1, 4, 'u', 's', 'e', 'r', 4, 'p', 'a', 's', 's'}); err != nil {
		t.Fatal(err)
	}
	var auth [2]byte
	if _, err := io.ReadFull(client, auth[:]); err != nil {
		t.Fatal(err)
	}
	host := "www.example.co.uk"
	if err := writeFull(client, append([]byte{5, 1, 0, 3, byte(len(host))}, append([]byte(host), 1, 187)...)); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.request.Host != host || result.request.Port != 443 || result.request.Credentials.Username != "user" {
		t.Fatalf("request %#v", result.request)
	}
}

func TestReadConnectBlocksIPAndMetadataDestinations(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "metadata.google.internal", "service.internal", "printer.local", "localhost", "bad..example"} {
		client, server := net.Pipe()
		done := make(chan error, 1)
		go func() {
			_, err := ReadConnect(server)
			if closeErr := server.Close(); err == nil && closeErr != nil {
				err = closeErr
			}
			done <- err
		}()
		authenticateTestClient(t, client)
		if err := writeFull(client, append([]byte{5, 1, 0, 3, byte(len(host))}, append([]byte(host), 0, 80)...)); err != nil {
			closeClientTestConn(t, client)
			t.Fatal(err)
		}
		if err := <-done; err == nil {
			closeClientTestConn(t, client)
			t.Errorf("accepted %q", host)
		}
		closeClientTestConn(t, client)
	}
}

func TestReadConnectRejectsUnapprovedPort(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		_, err := ReadConnect(server)
		if closeErr := server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		done <- err
	}()
	authenticateTestClient(t, client)
	host := "www.example.co.uk"
	if err := writeFull(client, append([]byte{5, 1, 0, 3, byte(len(host))}, append([]byte(host), 0, 22)...)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("port 22 accepted")
	}
}

func TestReadConnectRejectsNoAuthenticationClient(t *testing.T) {
	client, server := net.Pipe()
	defer closeClientTestConn(t, client)
	done := make(chan error, 1)
	go func() {
		_, err := ReadConnect(server)
		_ = server.Close()
		done <- err
	}()
	if err := writeFull(client, []byte{5, 1, 0}); err != nil {
		t.Fatal(err)
	}
	var selection [2]byte
	if _, err := io.ReadFull(client, selection[:]); err != nil {
		t.Fatal(err)
	}
	if selection != [2]byte{5, 0xff} {
		t.Fatalf("selection %x", selection)
	}
	if err := <-done; err == nil {
		t.Fatal("no-authentication client accepted")
	}
}

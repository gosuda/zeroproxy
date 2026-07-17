package socks5

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"

	"github.com/gosuda/zeroproxy/internal/policy"
)

type Request struct {
	Host        string
	Port        uint16
	Credentials *Credentials
}

type DestinationPolicy func(host string, port uint16) bool

func WebDestination(_ string, port uint16) bool { return port == 80 || port == 443 }

func ReadConnect(conn net.Conn) (Request, error) { return ReadConnectWithPolicy(conn, WebDestination) }
func ReadConnectWithPolicy(conn net.Conn, policy DestinationPolicy) (Request, error) {
	method, err := negotiateServerAuthentication(conn)
	if err != nil {
		return Request{}, err
	}
	credentials, err := readServerCredentials(conn, method)
	if err != nil {
		return Request{}, err
	}
	host, port, err := readConnectDestination(conn)
	if err != nil {
		return Request{}, err
	}
	if policy == nil || !policy(host, port) {
		return Request{}, errors.New("destination policy rejected port")
	}
	return Request{Host: host, Port: port, Credentials: credentials}, nil
}

func negotiateServerAuthentication(conn net.Conn) (byte, error) {
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		return 0, err
	}
	if greeting[0] != 5 || greeting[1] == 0 || greeting[1] > 16 {
		return 0, ErrProtocol
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return 0, err
	}
	method := preferredAuthenticationMethod(methods)
	if err := writeFull(conn, []byte{5, method}); err != nil {
		return 0, err
	}
	if method == 0xff {
		return 0, ErrProtocol
	}
	return method, nil
}

func preferredAuthenticationMethod(methods []byte) byte {
	for _, candidate := range methods {
		if candidate == 2 {
			return 2
		}
	}
	return 0xff
}

func readServerCredentials(conn net.Conn, method byte) (*Credentials, error) {
	if method != 2 {
		return nil, ErrProtocol
	}
	parsed, err := readCredentials(conn)
	if err != nil {
		return nil, err
	}
	if err := writeFull(conn, []byte{1, 0}); err != nil {
		return nil, err
	}
	return &parsed, nil
}

func readConnectDestination(conn net.Conn) (string, uint16, error) {
	var header [5]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return "", 0, err
	}
	if !validConnectHeader(header) {
		return "", 0, ErrProtocol
	}
	host, err := readConnectHost(conn, header[4])
	if err != nil {
		return "", 0, err
	}
	port, err := readConnectPort(conn)
	if err != nil {
		return "", 0, err
	}
	canonicalHost, err := policy.CanonicalEgressHost(host)
	if err != nil || canonicalHost != host {
		return "", 0, errors.New("destination policy rejected domain")
	}
	return canonicalHost, port, nil
}

func validConnectHeader(header [5]byte) bool {
	return header[0] == 5 && header[1] == 1 && header[2] == 0 && header[3] == 3 && header[4] != 0
}

func readConnectHost(conn net.Conn, length byte) (string, error) {
	hostBytes := make([]byte, int(length))
	if _, err := io.ReadFull(conn, hostBytes); err != nil {
		return "", err
	}
	return strings.ToLower(string(hostBytes)), nil
}

func readConnectPort(conn net.Conn) (uint16, error) {
	var portBytes [2]byte
	if _, err := io.ReadFull(conn, portBytes[:]); err != nil {
		return 0, err
	}
	port := binary.BigEndian.Uint16(portBytes[:])
	if port == 0 {
		return 0, ErrProtocol
	}
	return port, nil
}

func readCredentials(conn net.Conn) (Credentials, error) {
	var header [2]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return Credentials{}, err
	}
	if header[0] != 1 || header[1] == 0 {
		return Credentials{}, ErrProtocol
	}
	username := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, username); err != nil {
		return Credentials{}, err
	}
	var length [1]byte
	if _, err := io.ReadFull(conn, length[:]); err != nil {
		return Credentials{}, err
	}
	password := make([]byte, int(length[0]))
	if _, err := io.ReadFull(conn, password); err != nil {
		return Credentials{}, err
	}
	return Credentials{Username: string(username), Password: string(password)}, nil
}

func Reply(conn net.Conn, code byte) error {
	return writeFull(conn, []byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

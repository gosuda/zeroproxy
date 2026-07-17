package socks5

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"

	"github.com/gosuda/zeroproxy/internal/policy"
)

var ErrProtocol = errors.New("SOCKS5 protocol error")

type ReplyError struct {
	Code byte
}

func (err *ReplyError) Error() string {
	return fmt.Sprintf("SOCKS5 connect reply %d", err.Code)
}

func (err *ReplyError) Unwrap() error {
	return ErrProtocol
}

type Credentials struct{ Username, Password string }

func Connect(conn net.Conn, host string, port uint16, credentials *Credentials) error {
	canonicalHost, err := validateConnectDestination(host, port, credentials)
	if err != nil {
		return err
	}
	method, err := negotiateClientAuthentication(conn, credentials)
	if err != nil {
		return err
	}
	if method == 2 {
		if err := authenticate(conn, *credentials); err != nil {
			return err
		}
	}
	if err := writeConnectRequest(conn, canonicalHost, port); err != nil {
		return err
	}
	return readConnectReply(conn)
}

func validateConnectDestination(host string, port uint16, credentials *Credentials) (string, error) {
	if port == 0 {
		return "", errors.New("invalid SOCKS5 destination")
	}
	canonicalHost, err := policy.CanonicalEgressHost(host)
	if err != nil {
		return "", err
	}
	if credentials == nil || credentials.Username == "" || credentials.Password == "" ||
		len(credentials.Username) > 255 || len(credentials.Password) > 255 {
		return "", errors.New("invalid SOCKS5 credentials")
	}
	return canonicalHost, nil
}

func negotiateClientAuthentication(conn net.Conn, _ *Credentials) (byte, error) {
	if err := writeFull(conn, []byte{5, 1, 2}); err != nil {
		return 0, err
	}
	var selection [2]byte
	if _, err := io.ReadFull(conn, selection[:]); err != nil {
		return 0, err
	}
	if selection != [2]byte{5, 2} {
		return 0, fmt.Errorf("%w: RFC 1929 required", ErrProtocol)
	}
	return 2, nil
}

func writeConnectRequest(conn net.Conn, host string, port uint16) error {
	request := make([]byte, 7+len(host))
	request[0], request[1], request[2], request[3], request[4] = 5, 1, 0, 3, byte(len(host))
	copy(request[5:], host)
	binary.BigEndian.PutUint16(request[5+len(host):], port)
	return writeFull(conn, request)
}

func readConnectReply(conn net.Conn) error {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return err
	}
	if header[0] != 5 || header[2] != 0 {
		return ErrProtocol
	}
	if header[1] != 0 {
		return &ReplyError{Code: header[1]}
	}
	addressBytes, err := replyAddressBytes(conn, header[3])
	if err != nil {
		return err
	}
	_, err = io.ReadFull(conn, make([]byte, addressBytes+2))
	return err
}

func replyAddressBytes(conn net.Conn, addressType byte) (int, error) {
	switch addressType {
	case 1:
		return 4, nil
	case 4:
		return 16, nil
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return 0, err
		}
		return int(length[0]), nil
	default:
		return 0, ErrProtocol
	}
}
func authenticate(conn net.Conn, c Credentials) error {
	message := make([]byte, 3+len(c.Username)+len(c.Password))
	message[0], message[1] = 1, byte(len(c.Username))
	copy(message[2:], c.Username)
	offset := 2 + len(c.Username)
	message[offset] = byte(len(c.Password))
	copy(message[offset+1:], c.Password)
	if err := writeFull(conn, message); err != nil {
		return err
	}
	var response [2]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil {
		return err
	}
	if response[0] != 1 || response[1] != 0 {
		return errors.New("SOCKS5 authentication failed")
	}
	return nil
}
func writeFull(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

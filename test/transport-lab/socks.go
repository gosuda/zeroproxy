package transportlab

import (
	"bufio"
	"io"
	"net"
)

// SOCKS5Scenario scripts an RFC 1929 authenticated SOCKS CONNECT exchange.
type SOCKS5Scenario struct {
	Username string
	Password string
	Accept   bool
	Observed chan<- SOCKS5Request
}

// SOCKS5Request records only bounded authority data from the scripted exchange.
type SOCKS5Request struct {
	Host string
	Port uint16
}

// RFC1929Handler rejects unauthenticated downgrade attempts and accepts only
// SOCKS5 DOMAIN CONNECT requests, matching the production privacy boundary.
func RFC1929Handler(scenario SOCKS5Scenario) TCPHandler {
	return func(connection net.Conn) {
		reader := bufio.NewReader(io.LimitReader(connection, 4096))
		version, err := reader.ReadByte()
		if err != nil || version != 5 {
			return
		}
		methods, err := reader.ReadByte()
		if err != nil || methods == 0 || methods > 16 {
			return
		}
		values := make([]byte, methods)
		if _, err = io.ReadFull(reader, values); err != nil {
			return
		}
		auth := false
		for _, method := range values {
			auth = auth || method == 2
		}
		if !auth {
			_, _ = connection.Write([]byte{5, 0xff})
			return
		}
		if _, err = connection.Write([]byte{5, 2}); err != nil {
			return
		}
		if version, err = reader.ReadByte(); err != nil || version != 1 {
			return
		}
		userLength, err := reader.ReadByte()
		if err != nil || userLength == 0 {
			return
		}
		user := make([]byte, userLength)
		if _, err = io.ReadFull(reader, user); err != nil {
			return
		}
		passwordLength, err := reader.ReadByte()
		if err != nil || passwordLength == 0 {
			return
		}
		password := make([]byte, passwordLength)
		if _, err = io.ReadFull(reader, password); err != nil {
			return
		}
		if string(user) != scenario.Username || string(password) != scenario.Password {
			_, _ = connection.Write([]byte{1, 1})
			return
		}
		if _, err = connection.Write([]byte{1, 0}); err != nil {
			return
		}
		request := make([]byte, 4)
		if _, err = io.ReadFull(reader, request); err != nil || request[0] != 5 || request[1] != 1 || request[2] != 0 || request[3] != 3 {
			return
		}
		hostLength, err := reader.ReadByte()
		if err != nil || hostLength == 0 {
			return
		}
		host := make([]byte, hostLength)
		if _, err = io.ReadFull(reader, host); err != nil {
			return
		}
		port := make([]byte, 2)
		if _, err = io.ReadFull(reader, port); err != nil {
			return
		}
		if scenario.Observed != nil {
			scenario.Observed <- SOCKS5Request{Host: string(host), Port: uint16(port[0])<<8 | uint16(port[1])}
		}
		if !scenario.Accept {
			_, _ = connection.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
			return
		}
		_, _ = connection.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	}
}

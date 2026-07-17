package transportlab

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	DNSQueryTypeA    uint16 = 1
	DNSQueryTypeAAAA uint16 = 28
)

// DNSQuery is the intentionally minimal record retained for an observed DNS request.
// Name is a lower-case fully-qualified domain name; no request payload is retained.
type DNSQuery struct {
	Name string
	Type uint16
}

// DNSResponseKind selects the deterministic reply produced for a scripted query.
type DNSResponseKind uint8

const (
	DNSResponseA DNSResponseKind = iota + 1
	DNSResponseAAAA
	DNSResponseNXDOMAIN
	DNSResponseMalformed
	DNSResponseTimeout
)

// DNSScenario consumes one query in arrival order. Query fields left at zero match any
// query. Delay applies before the reply; a timeout scenario remains deliberately silent.
type DNSScenario struct {
	Query    DNSQuery
	Response DNSResponseKind
	Address  netip.Addr
	Delay    time.Duration
}

// DNSServer is a bounded, loopback-only UDP DNS fixture. It stores only query names and
// types, never query payloads or client addresses.
type DNSServer struct {
	mu        sync.Mutex
	conn      *net.UDPConn
	done      chan struct{}
	stopping  chan struct{}
	closed    bool
	closeErr  error
	scenarios []DNSScenario
	queries   []DNSQuery
	slots     chan struct{}
	workers   sync.WaitGroup
}

// NewDNS creates a fixture whose scenarios are consumed in UDP arrival order.
func NewDNS(scenarios ...DNSScenario) *DNSServer {
	return &DNSServer{
		scenarios: append([]DNSScenario(nil), scenarios...),
		slots:     make(chan struct{}, MaxConnections),
	}
}

// Start binds the fixture to a loopback-only ephemeral UDP port.
func (s *DNSServer) Start() error {
	if err := validateDNSScenarios(s.scenarios); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		return errors.New("transport DNS lab already started")
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		return err
	}
	s.conn = conn
	s.done = make(chan struct{})
	s.stopping = make(chan struct{})
	go s.serve(conn, s.done, s.stopping)
	return nil
}

// Address returns the loopback UDP address after Start.
func (s *DNSServer) Address() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return ""
	}
	return s.conn.LocalAddr().String()
}

// Close stops the listener and cancels delayed replies.
func (s *DNSServer) Close() error {
	s.mu.Lock()
	if s.conn == nil {
		s.mu.Unlock()
		return nil
	}
	conn, done, stopping := s.conn, s.done, s.stopping
	if !s.closed {
		s.closed = true
		close(stopping)
		s.closeErr = conn.Close()
	}
	err := s.closeErr
	s.mu.Unlock()

	<-done
	s.workers.Wait()
	return err
}

// Queries returns a snapshot containing only captured names and types.
func (s *DNSServer) Queries() []DNSQuery {
	s.mu.Lock()
	defer s.mu.Unlock()
	queries := make([]DNSQuery, len(s.queries))
	copy(queries, s.queries)
	return queries
}

func (s *DNSServer) serve(conn *net.UDPConn, done chan struct{}, stopping <-chan struct{}) {
	defer close(done)
	buffer := make([]byte, 4096)
	for {
		n, remote, err := conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		packet := append([]byte(nil), buffer[:n]...)
		select {
		case s.slots <- struct{}{}:
			s.workers.Add(1)
			go func() {
				defer func() {
					<-s.slots
					s.workers.Done()
				}()
				s.handle(conn, remote, packet, stopping)
			}()
		default:
			// A bounded fixture drops excess datagrams rather than accumulating work.
		}
	}
}

func (s *DNSServer) handle(conn *net.UDPConn, remote *net.UDPAddr, packet []byte, stopping <-chan struct{}) {
	query, question, id, flags, err := parseDNSQuery(packet)
	if err != nil {
		if reply := dnsErrorReply(id, flags, nil, 1); len(reply) != 0 {
			_, _ = conn.WriteToUDP(reply, remote)
		}
		return
	}

	scenario, matches := s.nextScenario(query)
	if !matches {
		_, _ = conn.WriteToUDP(dnsErrorReply(id, flags, question, 1), remote)
		return
	}
	if scenario.Delay > 0 {
		timer := time.NewTimer(scenario.Delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-stopping:
			return
		}
	}
	if scenario.Response == DNSResponseTimeout {
		return
	}
	if scenario.Response == DNSResponseMalformed {
		// Preserve the transaction ID while intentionally violating the DNS header length.
		_, _ = conn.WriteToUDP([]byte{byte(id >> 8), byte(id), 0x80}, remote)
		return
	}

	var reply []byte
	switch scenario.Response {
	case DNSResponseA, DNSResponseAAAA:
		reply = dnsAddressReply(id, flags, question, scenario.Response, scenario.Address)
	case DNSResponseNXDOMAIN:
		reply = dnsErrorReply(id, flags, question, 3)
	default:
		reply = dnsErrorReply(id, flags, question, 2)
	}
	_, _ = conn.WriteToUDP(reply, remote)
}

// nextScenario records the minimal query observation before consuming exactly one script.
func (s *DNSServer) nextScenario(query DNSQuery) (DNSScenario, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queries = append(s.queries, query)
	if len(s.scenarios) == 0 {
		return DNSScenario{}, false
	}
	scenario := s.scenarios[0]
	s.scenarios = s.scenarios[1:]
	return scenario, dnsQueryMatches(scenario.Query, query)
}

func validateDNSScenarios(scenarios []DNSScenario) error {
	for index, scenario := range scenarios {
		if scenario.Delay < 0 {
			return fmt.Errorf("DNS scenario %d has negative delay", index)
		}
		if scenario.Query.Name != "" {
			if _, err := canonicalDNSName(scenario.Query.Name); err != nil {
				return fmt.Errorf("DNS scenario %d query name: %w", index, err)
			}
		}
		switch scenario.Response {
		case DNSResponseA:
			if !scenario.Address.Is4() {
				return fmt.Errorf("DNS scenario %d A response needs an IPv4 address", index)
			}
		case DNSResponseAAAA:
			if !scenario.Address.Is6() || scenario.Address.Is4() {
				return fmt.Errorf("DNS scenario %d AAAA response needs an IPv6 address", index)
			}
		case DNSResponseNXDOMAIN, DNSResponseMalformed, DNSResponseTimeout:
		default:
			return fmt.Errorf("DNS scenario %d has unknown response kind", index)
		}
	}
	return nil
}

func dnsQueryMatches(expected, actual DNSQuery) bool {
	if expected.Name != "" {
		name, err := canonicalDNSName(expected.Name)
		if err != nil || name != actual.Name {
			return false
		}
	}
	return expected.Type == 0 || expected.Type == actual.Type
}

func parseDNSQuery(packet []byte) (DNSQuery, []byte, uint16, uint16, error) {
	if len(packet) < 12 {
		return DNSQuery{}, nil, 0, 0, errors.New("short DNS header")
	}
	id, flags := binary.BigEndian.Uint16(packet[:2]), binary.BigEndian.Uint16(packet[2:4])
	if flags&0x8000 != 0 || binary.BigEndian.Uint16(packet[4:6]) != 1 {
		return DNSQuery{}, nil, id, flags, errors.New("invalid DNS query header")
	}
	offset := 12
	name, next, err := parseDNSName(packet, offset)
	if err != nil || next+4 > len(packet) {
		return DNSQuery{}, nil, id, flags, errors.New("invalid DNS question")
	}
	queryType := binary.BigEndian.Uint16(packet[next : next+2])
	if binary.BigEndian.Uint16(packet[next+2:next+4]) != 1 {
		return DNSQuery{}, nil, id, flags, errors.New("unsupported DNS query class")
	}
	return DNSQuery{Name: name, Type: queryType}, append([]byte(nil), packet[12:next+4]...), id, flags, nil
}

func parseDNSName(packet []byte, offset int) (string, int, error) {
	var labels []string
	for {
		if offset >= len(packet) {
			return "", 0, errors.New("truncated DNS name")
		}
		length := int(packet[offset])
		offset++
		if length == 0 {
			if len(labels) == 0 {
				return ".", offset, nil
			}
			return strings.ToLower(strings.Join(labels, ".")) + ".", offset, nil
		}
		if length&0xc0 != 0 || length > 63 || offset+length > len(packet) {
			return "", 0, errors.New("compressed or invalid DNS name")
		}
		label := packet[offset : offset+length]
		for _, octet := range label {
			if octet < 0x21 || octet > 0x7e {
				return "", 0, errors.New("non-printable DNS label")
			}
		}
		labels = append(labels, string(label))
		offset += length
		if len(labels) > 127 {
			return "", 0, errors.New("too many DNS labels")
		}
	}
}

func canonicalDNSName(name string) (string, error) {
	if name == "." {
		return name, nil
	}
	name = strings.TrimSuffix(name, ".")
	if name == "" || len(name) > 253 {
		return "", errors.New("invalid DNS name")
	}
	labels := strings.Split(name, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return "", errors.New("invalid DNS label length")
		}
		for _, rune := range label {
			if rune < 0x21 || rune > 0x7e {
				return "", errors.New("invalid DNS label")
			}
		}
	}
	return strings.ToLower(strings.Join(labels, ".")) + ".", nil
}

func dnsHeader(id, requestFlags uint16, answers uint16, rcode uint16) []byte {
	header := make([]byte, 12)
	binary.BigEndian.PutUint16(header[:2], id)
	flags := uint16(0x8000 | 0x0400 | 0x0080) // response, authoritative, recursion available
	flags |= requestFlags & 0x0100
	flags |= rcode & 0x000f
	binary.BigEndian.PutUint16(header[2:4], flags)
	binary.BigEndian.PutUint16(header[4:6], 1)
	binary.BigEndian.PutUint16(header[6:8], answers)
	return header
}

func dnsErrorReply(id, requestFlags uint16, question []byte, rcode uint16) []byte {
	reply := dnsHeader(id, requestFlags, 0, rcode)
	return append(reply, question...)
}

func dnsAddressReply(id, requestFlags uint16, question []byte, kind DNSResponseKind, address netip.Addr) []byte {
	payload := address.AsSlice()
	reply := dnsHeader(id, requestFlags, 1, 0)
	reply = append(reply, question...)
	reply = append(reply, 0xc0, 0x0c)
	if kind == DNSResponseA {
		reply = append(reply, 0, byte(DNSQueryTypeA))
	} else {
		reply = append(reply, 0, byte(DNSQueryTypeAAAA))
	}
	reply = append(reply, 0, 1) // IN
	reply = append(reply, 0, 0, 0, 60)
	reply = append(reply, 0, byte(len(payload)))
	reply = append(reply, payload...)
	return reply
}

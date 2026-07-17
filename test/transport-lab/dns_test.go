package transportlab

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"reflect"
	"strings"
	"testing"
	"time"
)

const dnsFixtureTimeout = time.Second

func startDNSFixture(t *testing.T, scenarios ...DNSScenario) *DNSServer {
	t.Helper()
	server := NewDNS(scenarios...)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
	})
	return server
}

func dialDNSFixture(t *testing.T, server *DNSServer) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("udp", server.Address(), dnsFixtureTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func TestDNSFixtureScriptsAAndAAAAAndCapturesQueries(t *testing.T) {
	server := startDNSFixture(t,
		DNSScenario{
			Query:    DNSQuery{Name: "A.Fixture.Test.", Type: DNSQueryTypeA},
			Response: DNSResponseA,
			Address:  netip.MustParseAddr("192.0.2.44"),
		},
		DNSScenario{
			Query:    DNSQuery{Name: "aaaa.fixture.test.", Type: DNSQueryTypeAAAA},
			Response: DNSResponseAAAA,
			Address:  netip.MustParseAddr("2001:db8::44"),
		},
	)
	connection := dialDNSFixture(t, server)

	if reply := exchangeDNS(t, connection, 101, "a.fixture.test.", DNSQueryTypeA, dnsFixtureTimeout); replyAddress(t, reply) != netip.MustParseAddr("192.0.2.44") {
		t.Fatalf("A response address = %s", replyAddress(t, reply))
	}
	if reply := exchangeDNS(t, connection, 102, "AAAA.FIXTURE.TEST.", DNSQueryTypeAAAA, dnsFixtureTimeout); replyAddress(t, reply) != netip.MustParseAddr("2001:db8::44") {
		t.Fatalf("AAAA response address = %s", replyAddress(t, reply))
	}

	want := []DNSQuery{
		{Name: "a.fixture.test.", Type: DNSQueryTypeA},
		{Name: "aaaa.fixture.test.", Type: DNSQueryTypeAAAA},
	}
	if got := server.Queries(); !reflect.DeepEqual(got, want) {
		t.Fatalf("captured queries = %#v, want %#v", got, want)
	}
}

func TestDNSFixtureScriptsNXDOMAIN(t *testing.T) {
	server := startDNSFixture(t, DNSScenario{
		Query:    DNSQuery{Name: "missing.fixture.test.", Type: DNSQueryTypeA},
		Response: DNSResponseNXDOMAIN,
	})

	reply := exchangeDNS(t, dialDNSFixture(t, server), 103, "missing.fixture.test.", DNSQueryTypeA, dnsFixtureTimeout)
	if rcode := binary.BigEndian.Uint16(reply[2:4]) & 0x000f; rcode != 3 {
		t.Fatalf("NXDOMAIN rcode = %d", rcode)
	}
	if answers := binary.BigEndian.Uint16(reply[6:8]); answers != 0 {
		t.Fatalf("NXDOMAIN answers = %d", answers)
	}
}

func TestDNSFixtureScriptsMalformedReply(t *testing.T) {
	server := startDNSFixture(t, DNSScenario{
		Query:    DNSQuery{Name: "malformed.fixture.test.", Type: DNSQueryTypeA},
		Response: DNSResponseMalformed,
	})

	reply := exchangeDNS(t, dialDNSFixture(t, server), 104, "malformed.fixture.test.", DNSQueryTypeA, dnsFixtureTimeout)
	if len(reply) >= 12 {
		t.Fatalf("malformed reply length = %d, want less than DNS header", len(reply))
	}
	if got := binary.BigEndian.Uint16(reply[:2]); got != 104 {
		t.Fatalf("malformed reply transaction ID = %d", got)
	}
}

func TestDNSFixtureScriptsTimeout(t *testing.T) {
	server := startDNSFixture(t, DNSScenario{
		Query:    DNSQuery{Name: "timeout.fixture.test.", Type: DNSQueryTypeA},
		Response: DNSResponseTimeout,
	})
	connection := dialDNSFixture(t, server)

	writeDNSQuery(t, connection, 105, "timeout.fixture.test.", DNSQueryTypeA)
	expectDNSReadTimeout(t, connection, 50*time.Millisecond)
}

func TestDNSFixtureScriptsSlowResponse(t *testing.T) {
	const delay = 80 * time.Millisecond
	server := startDNSFixture(t, DNSScenario{
		Query:    DNSQuery{Name: "slow.fixture.test.", Type: DNSQueryTypeA},
		Response: DNSResponseA,
		Address:  netip.MustParseAddr("198.51.100.80"),
		Delay:    delay,
	})
	connection := dialDNSFixture(t, server)

	writeDNSQuery(t, connection, 106, "slow.fixture.test.", DNSQueryTypeA)
	expectDNSReadTimeout(t, connection, delay/4)
	if err := connection.SetReadDeadline(time.Now().Add(dnsFixtureTimeout)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 512)
	n, err := connection.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if got := replyAddress(t, buffer[:n]); got != netip.MustParseAddr("198.51.100.80") {
		t.Fatalf("slow response address = %s", got)
	}
}

func exchangeDNS(t *testing.T, connection net.Conn, id uint16, name string, queryType uint16, timeout time.Duration) []byte {
	t.Helper()
	writeDNSQuery(t, connection, id, name, queryType)
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 512)
	n, err := connection.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte(nil), buffer[:n]...)
}

func writeDNSQuery(t *testing.T, connection net.Conn, id uint16, name string, queryType uint16) {
	t.Helper()
	question := dnsTestQuestion(t, name, queryType)
	packet := make([]byte, 12, 12+len(question))
	binary.BigEndian.PutUint16(packet[:2], id)
	binary.BigEndian.PutUint16(packet[2:4], 0x0100)
	binary.BigEndian.PutUint16(packet[4:6], 1)
	packet = append(packet, question...)
	if _, err := connection.Write(packet); err != nil {
		t.Fatal(err)
	}
}

func dnsTestQuestion(t *testing.T, name string, queryType uint16) []byte {
	t.Helper()
	canonical, err := canonicalDNSName(name)
	if err != nil {
		t.Fatal(err)
	}
	question := make([]byte, 0, len(canonical)+5)
	if canonical == "." {
		question = append(question, 0)
	} else {
		for _, label := range stringsSplitDNSName(canonical) {
			question = append(question, byte(len(label)))
			question = append(question, label...)
		}
		question = append(question, 0)
	}
	question = binary.BigEndian.AppendUint16(question, queryType)
	return binary.BigEndian.AppendUint16(question, 1)
}

func stringsSplitDNSName(canonical string) []string {
	return strings.Split(strings.TrimSuffix(canonical, "."), ".")
}

func expectDNSReadTimeout(t *testing.T, connection net.Conn, timeout time.Duration) {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	var buffer [512]byte
	_, err := connection.Read(buffer[:])
	var networkError net.Error
	if !errors.As(err, &networkError) || !networkError.Timeout() {
		t.Fatalf("read error = %v, want timeout", err)
	}
}

func replyAddress(t *testing.T, reply []byte) netip.Addr {
	t.Helper()
	if len(reply) < 12 || binary.BigEndian.Uint16(reply[6:8]) != 1 {
		t.Fatalf("invalid address reply header: %x", reply)
	}
	_, offset, err := parseDNSName(reply, 12)
	if err != nil || offset+4 > len(reply) {
		t.Fatalf("invalid echoed question: %v", err)
	}
	offset += 4
	if offset+12 > len(reply) || reply[offset] != 0xc0 || reply[offset+1] != 0x0c {
		t.Fatalf("invalid answer name: %x", reply[offset:])
	}
	offset += 2
	if binary.BigEndian.Uint16(reply[offset:offset+2]) != DNSQueryTypeA && binary.BigEndian.Uint16(reply[offset:offset+2]) != DNSQueryTypeAAAA {
		t.Fatalf("invalid answer type: %d", binary.BigEndian.Uint16(reply[offset:offset+2]))
	}
	offset += 8 // type, class, TTL
	length := int(binary.BigEndian.Uint16(reply[offset : offset+2]))
	offset += 2
	if offset+length != len(reply) {
		t.Fatalf("invalid answer length: %d", length)
	}
	address, ok := netip.AddrFromSlice(reply[offset:])
	if !ok {
		t.Fatalf("invalid answer address: %x", reply[offset:])
	}
	return address
}

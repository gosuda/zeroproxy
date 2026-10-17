// Package netguard holds the one rule for which addresses the proxy's direct
// egress may reach. The HTTP path dials through the SOCKS upstream; the
// WebTransport gateway (QUIC) and the TURN relay (UDP) cannot, so they check
// this instead; they must not reach further than the HTTP path does.
package netguard

import "net"

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// IsNonPublic reports whether ip is loopback, private, link-local,
// unspecified, multicast, carrier-grade NAT, benchmarking, or IPv6
// transition/documentation space: networks that a proxied page must not reach
// unless the proxy's HTTP path reaches them too (`-socks internal`).
func IsNonPublic(ip net.IP) bool {
	if len(ip) == 0 {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || cgnat.Contains(ip) {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 198 && (ip4[1]&0xfe) == 18 {
			return true
		}
		if ip4[0] == 192 && ip4[1] == 0 && ip4[2] == 0 {
			return true
		}
		if ip4.Equal(net.IPv4bcast) {
			return true
		}
		return false
	}
	if ip16 := ip.To16(); ip16 != nil {
		if ip16[0] == 0x00 && ip16[1] == 0x64 && ip16[2] == 0xff && ip16[3] == 0x9b {
			return true
		}
		if ip16[0] == 0x20 && ip16[1] == 0x02 {
			return true
		}
		if ip16[0] == 0x20 && ip16[1] == 0x01 && ip16[2] == 0x00 && ip16[3] == 0x00 {
			return true
		}
		if ip16[0] == 0x20 && ip16[1] == 0x01 && ip16[2] == 0x0d && ip16[3] == 0xb8 {
			return true
		}
	}
	return false
}

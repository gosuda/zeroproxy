// Package netguard holds the one rule for which addresses the proxy's direct
// egress may reach. The HTTP path dials through the SOCKS upstream; the
// WebTransport gateway (QUIC) and the TURN relay (UDP) cannot, so they check
// this instead — and must not reach further than the HTTP path does.
package netguard

import "net"

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// IsNonPublic reports whether ip is loopback, private, link-local,
// unspecified, multicast or carrier-grade NAT space — the operator's own
// networks, which a proxied page must not reach unless the proxy's HTTP path
// reaches them too (`-socks internal`, a direct dialer).
func IsNonPublic(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || cgnat.Contains(ip)
}

package netguard

import (
	"net"
	"testing"
)

func TestIsNonPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1":           true,
		"10.1.2.3":            true,
		"172.16.0.1":          true,
		"192.168.0.14":        true,
		"169.254.169.254":     true,
		"100.64.0.1":          true,
		"192.0.0.1":           true,
		"198.18.0.1":          true,
		"198.19.255.254":      true,
		"0.0.0.0":             true,
		"224.0.0.1":           true,
		"::1":                 true,
		"fc00::1":             true,
		"fe80::1":             true,
		"64:ff9b::127.0.0.1":  true,
		"64:ff9b:1::10.0.0.1": true,
		"2002:7f00:0001::":    true,
		"2001:0000:4136:e378:8000:63bf:3fff:fdd2": true,
		"2001:db8::1":     true,
		"1.1.1.1":         false,
		"8.8.8.8":         false,
		"100.128.0.1":     false,
		"198.20.0.1":      false,
		"2606:4700::1111": false,
	} {
		if got := IsNonPublic(net.ParseIP(addr)); got != want {
			t.Errorf("IsNonPublic(%s) = %v, want %v", addr, got, want)
		}
	}
}

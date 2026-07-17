package policy

import (
	"errors"
	"net"
	"strings"

	"golang.org/x/net/idna"
)

var ErrAddressPolicy = errors.New("target host rejected by address policy")

// CanonicalEgressHost applies the signed address-policy rules before a target
// name is serialized as a SOCKS5 DOMAIN. It never resolves the name locally.
func CanonicalEgressHost(raw string) (string, error) {
	if raw == "" || len(raw) > 253 || strings.TrimSpace(raw) != raw || strings.HasSuffix(raw, ".") {
		return "", ErrAddressPolicy
	}
	host, err := idna.Lookup.ToASCII(strings.ToLower(raw))
	if err != nil || host == "" || len(host) > 253 || strings.Contains(host, "..") || strings.ContainsAny(host, "[]:") {
		return "", ErrAddressPolicy
	}
	if net.ParseIP(host) != nil || numericAddressForm(host) {
		return "", ErrAddressPolicy
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return "", ErrAddressPolicy
	}
	for _, label := range labels {
		if !validAddressLabel(label) {
			return "", ErrAddressPolicy
		}
	}
	for _, suffix := range blockedAddressSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return "", ErrAddressPolicy
		}
	}
	return host, nil
}

func numericAddressForm(host string) bool {
	if strings.HasPrefix(host, "0x") {
		if rest := host[2:]; rest != "" && strings.Trim(rest, "0123456789abcdef") == "" {
			return true
		}
	}
	return strings.Trim(host, "0123456789.") == ""
}

func validAddressLabel(label string) bool {
	if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, character := range label {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

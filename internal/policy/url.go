package policy

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

var (
	ErrUnsupportedScheme = errors.New("unsupported target scheme")
	ErrUserInfo          = errors.New("target URL userinfo is forbidden")
	ErrInvalidURL        = errors.New("invalid target URL")
)

type Origin struct {
	Scheme string
	Host   string
	Port   uint16
}

func (o Origin) String() string {
	return o.Scheme + "://" + net.JoinHostPort(o.Host, strconv.Itoa(int(o.Port)))
}
func (o Origin) EffectiveHost() string {
	if (o.Scheme == "http" && o.Port == 80) || (o.Scheme == "https" && o.Port == 443) {
		return o.Host
	}
	return net.JoinHostPort(o.Host, strconv.Itoa(int(o.Port)))
}

type Target struct {
	URL      *url.URL
	Origin   Origin
	Fragment string
}

func ParseTarget(raw string) (Target, error) {
	u, scheme, err := parseHTTPURL(raw)
	if err != nil {
		return Target{}, err
	}
	host, err := canonicalTargetHost(u)
	if err != nil {
		return Target{}, err
	}
	port, err := targetPort(u, scheme)
	if err != nil {
		return Target{}, err
	}
	fragment := u.Fragment
	normalizeTargetURL(u, scheme, host, port)
	return Target{URL: u, Origin: Origin{Scheme: scheme, Host: host, Port: port}, Fragment: fragment}, nil
}

func parseHTTPURL(raw string) (*url.URL, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, "", ErrInvalidURL
	}
	if u.User != nil {
		return nil, "", ErrUserInfo
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, "", ErrUnsupportedScheme
	}
	return u, scheme, nil
}

func canonicalTargetHost(u *url.URL) (string, error) {
	host, err := idna.Lookup.ToASCII(strings.TrimSuffix(strings.ToLower(u.Hostname()), "."))
	if err != nil || host == "" {
		return "", ErrInvalidURL
	}
	return host, nil
}

func targetPort(u *url.URL, scheme string) (uint16, error) {
	defaultPort := uint16(80)
	if scheme == "https" {
		defaultPort = 443
	}
	rawPort := u.Port()
	if rawPort == "" {
		return defaultPort, nil
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || port == 0 {
		return 0, ErrInvalidURL
	}
	return uint16(port), nil
}

func normalizeTargetURL(u *url.URL, scheme, host string, port uint16) {
	u.Scheme, u.Host, u.User, u.Fragment = scheme, net.JoinHostPort(host, strconv.Itoa(int(port))), nil, ""
	if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
		u.Host = host
	}
}

func Resolve(base Target, reference string) (Target, error) {
	ref, err := url.Parse(reference)
	if err != nil {
		return Target{}, fmt.Errorf("reference: %w", ErrInvalidURL)
	}
	resolved := base.URL.ResolveReference(ref)
	return ParseTarget(resolved.String())
}

package hostrole

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type Role uint8

const (
	Unknown Role = iota
	Control
	Asset
	Relay
	Browse
)

var originIDPattern = regexp.MustCompile(`^[a-z2-7]{32}$`)

type Classifier struct {
	control, asset, relay                           string
	controlHost, assetHost, relayHost, browseDomain string
	port                                            uint16
	browse, browseHost                              *regexp.Regexp
}

func New(control, asset, relay, browseDomain string) (*Classifier, error) {
	controlAuthority, controlHost, controlPort, err := canonicalHTTPSAuthority(control)
	if err != nil {
		return nil, err
	}
	assetAuthority, assetHost, assetPort, err := canonicalHTTPSAuthority(asset)
	if err != nil {
		return nil, err
	}
	relayAuthority, relayHost, relayPort, err := canonicalHTTPSAuthority(relay)
	if err != nil {
		return nil, err
	}
	browseDomain = strings.ToLower(browseDomain)
	if !validHostname(browseDomain) || controlPort != assetPort || controlPort != relayPort ||
		controlHost == assetHost || controlHost == relayHost || assetHost == relayHost {
		return nil, errors.New("invalid host role authority")
	}
	browseHostBase := `^o-[a-z2-7]{32}\.browse\.` + regexp.QuoteMeta(browseDomain)
	portSuffix := ""
	if controlPort != 443 {
		portSuffix = ":" + strconv.Itoa(int(controlPort))
	}
	return &Classifier{
		control: controlAuthority, asset: assetAuthority, relay: relayAuthority,
		controlHost: controlHost, assetHost: assetHost, relayHost: relayHost,
		browseDomain: browseDomain, port: controlPort,
		browseHost: regexp.MustCompile(browseHostBase + `$`),
		browse:     regexp.MustCompile(browseHostBase + regexp.QuoteMeta(portSuffix) + `$`),
	}, nil
}

func canonicalAuthority(raw string, defaultPort uint16) (string, string, uint16, error) {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.HasSuffix(raw, ".") || strings.ContainsAny(raw, "/@?#") {
		return "", "", 0, errors.New("invalid host role authority")
	}
	host := raw
	port := defaultPort
	if strings.Contains(raw, ":") {
		parsedHost, parsedPort, err := net.SplitHostPort(raw)
		if err != nil || parsedPort == "" {
			return "", "", 0, errors.New("invalid host role authority")
		}
		value, err := strconv.ParseUint(parsedPort, 10, 16)
		if err != nil || value == 0 || parsedPort != strconv.FormatUint(value, 10) {
			return "", "", 0, errors.New("invalid host role authority")
		}
		host, port = parsedHost, uint16(value)
	}
	host = strings.ToLower(host)
	if !validHostname(host) {
		return "", "", 0, errors.New("invalid host role authority")
	}
	authority := host
	if port != 443 {
		authority = net.JoinHostPort(host, strconv.Itoa(int(port)))
	}
	return authority, host, port, nil
}

func canonicalHTTPSAuthority(raw string) (string, string, uint16, error) {
	return canonicalAuthority(raw, 443)
}

func validHostname(host string) bool {
	if host == "" || len(host) > 253 || net.ParseIP(host) != nil || strings.HasPrefix(host, ".") ||
		strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func (c *Classifier) Classify(hostport string) Role {
	authority, _, port, err := canonicalHTTPSAuthority(hostport)
	if err != nil || port != c.port {
		return Unknown
	}
	switch authority {
	case c.control:
		return Control
	case c.asset:
		return Asset
	case c.relay:
		return Relay
	}
	if c.browse.MatchString(authority) {
		return Browse
	}
	return Unknown
}

func (c *Classifier) AllowedBrowseOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Scheme == "https" && parsed.Opaque == "" && parsed.User == nil &&
		parsed.Path == "" && parsed.RawPath == "" && parsed.RawQuery == "" && !parsed.ForceQuery &&
		parsed.Fragment == "" && c.Classify(parsed.Host) == Browse
}

func (c *Classifier) Authority(role Role) string {
	switch role {
	case Control:
		return c.control
	case Asset:
		return c.asset
	case Relay:
		return c.relay
	default:
		return ""
	}
}

func (c *Classifier) BrowseAuthority(originID string) (string, error) {
	if !originIDPattern.MatchString(originID) {
		return "", errors.New("invalid browse origin ID")
	}
	return c.browseAuthority("o-" + originID + ".browse." + c.browseDomain), nil
}

func (c *Classifier) BrowseWildcardAuthority() string {
	return c.browseAuthority("*.browse." + c.browseDomain)
}

func (c *Classifier) browseAuthority(host string) string {
	if c.port == 443 {
		return host
	}
	return net.JoinHostPort(host, strconv.Itoa(int(c.port)))
}

func (c *Classifier) HTTPSRedirectAuthority(httpAuthority string) (string, bool) {
	_, host, port, err := canonicalAuthority(httpAuthority, 80)
	if err != nil || port != 80 {
		return "", false
	}
	switch host {
	case c.controlHost:
		return c.control, true
	case c.assetHost:
		return c.asset, true
	case c.relayHost:
		return c.relay, true
	default:
		if c.browseHost.MatchString(host) {
			return c.browseAuthority(host), true
		}
		return "", false
	}
}

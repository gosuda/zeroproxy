package httppersona

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// ApplyFetchSiteHeader derives schemeful Fetch Metadata from trusted virtual
// context. It overrides any serialized browser Headers value.
func ApplyFetchSiteHeader(request *http.Request, sourceRawURL, floor string) (string, error) {
	site := "none"
	if sourceRawURL != "" {
		source, err := url.Parse(sourceRawURL)
		if err != nil || !validSiteURL(source) {
			return "", errors.New("invalid fetch metadata source URL")
		}
		switch {
		case sameOrigin(source, request.URL):
			site = "same-origin"
		case source.Scheme == request.URL.Scheme && sameRegistrableDomain(source.Hostname(), request.URL.Hostname()):
			site = "same-site"
		default:
			site = "cross-site"
		}
	}
	site, err := fetchSiteFloor(site, floor)
	if err != nil {
		return "", err
	}
	request.Header.Set("Sec-Fetch-Site", site)
	return site, nil
}

func fetchSiteFloor(site, floor string) (string, error) {
	if floor == "" {
		return site, nil
	}
	siteRank, siteOK := fetchSiteRank(site)
	floorRank, floorOK := fetchSiteRank(floor)
	if !siteOK || !floorOK {
		return "", errors.New("invalid fetch metadata site floor")
	}
	if floorRank > siteRank {
		return floor, nil
	}
	return site, nil
}

func fetchSiteRank(site string) (int, bool) {
	switch site {
	case "none":
		return 3, true
	case "cross-site":
		return 2, true
	case "same-site":
		return 1, true
	case "same-origin":
		return 0, true
	default:
		return 0, false
	}
}

func validSiteURL(value *url.URL) bool {
	return value != nil && (value.Scheme == "http" || value.Scheme == "https") && value.Host != "" && value.User == nil
}

func sameOrigin(left, right *url.URL) bool {
	return left.Scheme == right.Scheme && strings.EqualFold(left.Hostname(), right.Hostname()) && effectivePort(left) == effectivePort(right)
}

func effectivePort(value *url.URL) string {
	if port := value.Port(); port != "" {
		return port
	}
	if value.Scheme == "https" {
		return "443"
	}
	return "80"
}

func sameRegistrableDomain(left, right string) bool {
	left = strings.TrimSuffix(strings.ToLower(left), ".")
	right = strings.TrimSuffix(strings.ToLower(right), ".")
	if left == right {
		return true
	}
	if net.ParseIP(left) != nil || net.ParseIP(right) != nil {
		return false
	}
	leftSite, leftErr := publicsuffix.EffectiveTLDPlusOne(left)
	rightSite, rightErr := publicsuffix.EffectiveTLDPlusOne(right)
	return leftErr == nil && rightErr == nil && leftSite == rightSite
}

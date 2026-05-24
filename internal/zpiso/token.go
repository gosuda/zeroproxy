package zpiso

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"
)

const tokenPrefix = "zp-streamiso-v1\x00"

// Token derives the Tor IsolateSOCKSAuth username for host. The derivation is
// stable for a site inside one tab/session, excludes paths and queries, and
// never performs DNS resolution.
func Token(streamIsolationKey []byte, host string) string {
	site := IsolationSite(host)
	mac := hmac.New(sha256.New, streamIsolationKey)
	_, _ = mac.Write([]byte(tokenPrefix))
	_, _ = mac.Write([]byte(site))
	sum := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(sum)[:43]
}

// IsolationSite returns lower-case punycode eTLD+1 when available, otherwise
// the normalized host. Literal brackets and a trailing dot are stripped without
// ever resolving the name locally.
func IsolationSite(host string) string {
	h := strings.TrimSpace(host)
	h = strings.TrimPrefix(strings.TrimSuffix(h, "]"), "[")
	h = strings.TrimSuffix(h, ".")
	h = strings.ToLower(h)
	ascii, err := idna.Lookup.ToASCII(h)
	if err == nil && ascii != "" {
		h = strings.ToLower(ascii)
	}
	if site, err := publicsuffix.EffectiveTLDPlusOne(h); err == nil && site != "" {
		return site
	}
	return h
}

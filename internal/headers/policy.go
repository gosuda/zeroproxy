package headers

import (
	"net/http"
	"strings"
)

var hidden = map[string]struct{}{
	"set-cookie": {}, "set-cookie2": {},
	"content-security-policy": {}, "content-security-policy-report-only": {},
	"report-to": {}, "reporting-endpoints": {}, "nel": {},
	"service-worker-allowed": {},
	"sourcemap":              {}, "x-sourcemap": {},
	"alt-svc": {}, "link": {}, "refresh": {}, "clear-site-data": {},
}

// ConstructorPolicy returns headers safe to expose on the browser Response. It
// strips target policy/storage/network-control headers and applies ZeroProxy's
// no-store default. Location is intentionally excluded unless explicitly
// allowed by the redirect engine after final response resolution.
//
// challengeCompat is a CALLER-COMPUTED two-signal gate result (per-tab arm AND
// header/URL classification as a challenge SUBRESOURCE, never the document).
// When true the no-store overwrite is SKIPPED so Cloudflare's own cache/update
// semantics for its challenge subresources (e.g. api.js) survive. It changes
// ONLY the Cache-Control overwrite: every other strip, the CORS emulation, and
// the proxy transport are untouched, so it grants no egress and no eval. When
// false (every existing call path) the no-store overwrite is applied exactly as
// before, keeping the default/OFF path behaviorally identical.
//
//nolint:cyclop,gocognit // TODO(complexity): response-header policy builder (cyclop 11 / gocognit 16); decides which upstream headers survive into the proxied response (CSP, encoding, security). Security-sensitive header allowlist; needs dedicated differential-harness decomposition.
func ConstructorPolicy(src http.Header, bodyTransformed, bodyDecoded, challengeCompat bool) http.Header {
	dst := make(http.Header, len(src)+6)
	for name, vals := range src {
		canon := http.CanonicalHeaderKey(name)
		lower := strings.ToLower(canon)
		if _, ok := hidden[lower]; ok {
			continue
		}
		if lower == "content-length" && bodyTransformed {
			continue
		}
		if lower == "content-encoding" && bodyDecoded {
			continue
		}
		if lower == "location" {
			continue
		}
		if isHopByHop(lower) {
			continue
		}
		for _, v := range vals {
			dst.Add(canon, v)
		}
	}
	if !challengeCompat {
		dst.Set("Cache-Control", "no-store")
	}
	dst.Set("X-Content-Type-Options", "nosniff")
	dst.Set("Access-Control-Allow-Origin", "*")
	dst.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
	dst.Set("Access-Control-Allow-Headers", "*")
	dst.Set("Access-Control-Expose-Headers", "*")
	return dst
}

func isHopByHop(lower string) bool {
	switch lower {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func HiddenHeader(name string) bool {
	_, ok := hidden[strings.ToLower(http.CanonicalHeaderKey(name))]
	if ok {
		return true
	}
	return isHopByHop(strings.ToLower(name))
}

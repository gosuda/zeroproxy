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
func ConstructorPolicy(src http.Header, bodyTransformed, bodyDecoded, challengeCompat bool) http.Header {
	dst := make(http.Header, len(src)+6)
	for name, vals := range src {
		canon := http.CanonicalHeaderKey(name)
		if stripFromResponse(strings.ToLower(canon), bodyTransformed, bodyDecoded) {
			continue
		}
		for _, v := range vals {
			dst.Add(canon, v)
		}
	}
	applyResponseDefaults(dst, challengeCompat)
	return dst
}

// stripFromResponse reports whether an upstream response header (keyed by its
// lowercase canonical name) must be withheld from the browser Response. It is
// the fail-closed allowlist gate: the unconditional hidden/storage/network
// strips, the two body-rewrite-conditional encoding strips, the always-withheld
// Location (the redirect engine re-adds it after final resolution), and the
// hop-by-hop set.
//
// This is DELIBERATELY distinct from HiddenHeader, which is the request-side
// oracle and does NOT strip location/content-length/content-encoding. They must
// not be merged: routing ConstructorPolicy through HiddenHeader would leak
// Location onto the Response.
func stripFromResponse(lower string, bodyTransformed, bodyDecoded bool) bool {
	if _, ok := hidden[lower]; ok {
		return true
	}
	if lower == "content-length" && bodyTransformed {
		return true
	}
	if lower == "content-encoding" && bodyDecoded {
		return true
	}
	if lower == "location" {
		return true
	}
	return isHopByHop(lower)
}

// applyResponseDefaults overwrites dst with ZeroProxy's fixed response-header
// block: the no-store default (SKIPPED when challengeCompat lets the target's
// own Cache-Control survive), the nosniff guard, and the CORS emulation. These
// use Set, so any upstream copy of these names that survived the copy loop is
// overwritten here -- the forced values are authoritative, never appended to.
func applyResponseDefaults(dst http.Header, challengeCompat bool) {
	if !challengeCompat {
		dst.Set("Cache-Control", "no-store")
	}
	dst.Set("X-Content-Type-Options", "nosniff")
	dst.Set("Access-Control-Allow-Origin", "*")
	dst.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
	dst.Set("Access-Control-Allow-Headers", "*")
	dst.Set("Access-Control-Expose-Headers", "*")
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

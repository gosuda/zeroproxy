package headers

import (
	"net/http"
	"reflect"
	"sort"
	"testing"
)

// Characterization oracle for ConstructorPolicy.
//
// THE TRANSFORM.GO LESSON: a decomposition can pass every spot-check test and
// still corrupt behavior. The existing policy_test.go / policy_freeze_test.go
// assert individual headers via Get(); they never feed the inputs that would
// expose three classes of corruption a refactor can introduce silently:
//
//  1. INJECTED-HEADER OVERWRITE. The forced security/CORS headers
//     (X-Content-Type-Options, Access-Control-Allow-*, and the no-store
//     Cache-Control default) are written with Set after the copy loop. An
//     upstream copy of one of these names is NOT in `hidden`/hop-by-hop, so it
//     passes the loop and is then OVERWRITTEN. A regression that used Add, or
//     moved the defaults before the loop, would leak the upstream value
//     alongside the forced one. We must feed hostile upstream copies and assert
//     the output is EXACTLY the forced value, single-valued.
//
//  2. MULTI-VALUE PRESERVATION + ORDER. Surviving headers are copied per-value
//     with Add. A Set-in-loop regression would collapse multi-valued headers
//     silently. We feed a two-valued surviving header and assert both values
//     survive in order.
//
//  3. OUTPUT KEY CANONICALIZATION. Keys are emitted via CanonicalHeaderKey.
//
// This oracle pins the FULL output header map (every key, every value, in
// order) for a representative + edge-case corpus, so any change to which
// headers survive, what value they carry, or how many copies they carry turns
// it red. The golden values were derived by running the CURRENT (undecomposed)
// ConstructorPolicy and stay as permanent regression coverage.

// policyOracleCase is one corpus entry: an input header set + flag triple, and
// the EXACT expected output header map (canonical keys -> ordered values).
type policyOracleCase struct {
	name            string
	src             http.Header
	bodyTransformed bool
	bodyDecoded     bool
	challengeCompat bool
	want            http.Header // exact, full output map
}

// forcedDefaults is the fixed block ConstructorPolicy always injects, EXCEPT
// the Cache-Control no-store default which is conditional on !challengeCompat.
// Spelling it once keeps the golden table readable without hiding the assertion
// (the table still pins the full map; this is only corpus-construction sugar).
func forcedDefaults(noStore bool) http.Header {
	h := http.Header{
		"X-Content-Type-Options":        {"nosniff"},
		"Access-Control-Allow-Origin":   {"*"},
		"Access-Control-Allow-Methods":  {"GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"},
		"Access-Control-Allow-Headers":  {"*"},
		"Access-Control-Expose-Headers": {"*"},
	}
	if noStore {
		h["Cache-Control"] = []string{"no-store"}
	}
	return h
}

// merge builds an expected output map from the forced defaults plus the
// surviving upstream headers. Surviving headers must use canonical keys.
func merge(noStore bool, surviving http.Header) http.Header {
	out := forcedDefaults(noStore)
	for k, vs := range surviving {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

func policyOracleCorpus() []policyOracleCase {
	return []policyOracleCase{
		{
			// Representative real response: benign headers survive, the full
			// hidden set + Location + hop-by-hop are stripped, defaults injected.
			name: "representative_mixed",
			src: http.Header{
				"Content-Type":                 {"text/html; charset=utf-8"},
				"Cross-Origin-Opener-Policy":   {"same-origin"},
				"Cross-Origin-Embedder-Policy": {"require-corp"},
				"Cross-Origin-Resource-Policy": {"same-site"},
				"Vary":                         {"Accept-Encoding"},
				"Etag":                         {"\"abc123\""},
				// stripped:
				"Set-Cookie":              {"sid=1; Path=/"},
				"Content-Security-Policy": {"default-src 'self'"},
				"Location":                {"https://target.example/next"},
				"Alt-Svc":                 {"h3=\":443\""},
				"Connection":              {"keep-alive"},
				"Transfer-Encoding":       {"chunked"},
				"Clear-Site-Data":         {"\"cache\""},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Content-Type":                 {"text/html; charset=utf-8"},
				"Cross-Origin-Opener-Policy":   {"same-origin"},
				"Cross-Origin-Embedder-Policy": {"require-corp"},
				"Cross-Origin-Resource-Policy": {"same-site"},
				"Vary":                         {"Accept-Encoding"},
				"Etag":                         {"\"abc123\""},
			}),
		},
		{
			// GAP 1: hostile upstream copies of the FORCED headers. None of these
			// is in hidden/hop-by-hop, so they pass the loop and must be
			// OVERWRITTEN by the trailing Set calls -- exactly one forced value
			// each, no leak of the upstream value, no duplication.
			name: "hostile_upstream_overwrites_forced",
			src: http.Header{
				"X-Content-Type-Options":        {"sniff-me"},
				"Access-Control-Allow-Origin":   {"https://evil.example"},
				"Access-Control-Allow-Methods":  {"TRACE"},
				"Access-Control-Allow-Headers":  {"X-Evil"},
				"Access-Control-Expose-Headers": {"X-Evil"},
				"Cache-Control":                 {"public, max-age=999999"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			// want == forced defaults only; every hostile copy overwritten.
			want: merge(true, http.Header{}),
		},
		{
			// GAP 2: multi-value preservation + ORDER for a surviving header.
			name: "multivalue_order_preserved",
			src: http.Header{
				"Vary": {"Accept-Encoding", "Origin", "User-Agent"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Vary": {"Accept-Encoding", "Origin", "User-Agent"},
			}),
		},
		{
			// GAP 3: output key canonicalization. Lowercase input key must emit
			// as canonical, with its value intact.
			name: "noncanonical_input_key_canonicalized",
			src: http.Header{
				"x-custom-thing": {"v1"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"X-Custom-Thing": {"v1"},
			}),
		},
		{
			// Conditional encoding strips: both flags false -> both survive.
			name: "encoding_flags_false_both_survive",
			src: http.Header{
				"Content-Length":   {"123"},
				"Content-Encoding": {"gzip"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Content-Length":   {"123"},
				"Content-Encoding": {"gzip"},
			}),
		},
		{
			// bodyTransformed strips Content-Length, keeps Content-Encoding.
			name: "transformed_strips_content_length",
			src: http.Header{
				"Content-Length":   {"123"},
				"Content-Encoding": {"gzip"},
			},
			bodyTransformed: true,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Content-Encoding": {"gzip"},
			}),
		},
		{
			// bodyDecoded strips Content-Encoding, keeps Content-Length.
			name: "decoded_strips_content_encoding",
			src: http.Header{
				"Content-Length":   {"123"},
				"Content-Encoding": {"gzip"},
			},
			bodyTransformed: false,
			bodyDecoded:     true,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Content-Length": {"123"},
			}),
		},
		{
			// Both flags true -> both encoding headers stripped (independent
			// branches, not else-if).
			name: "both_flags_strip_both_encoding",
			src: http.Header{
				"Content-Length":   {"123"},
				"Content-Encoding": {"gzip"},
			},
			bodyTransformed: true,
			bodyDecoded:     true,
			challengeCompat: false,
			want:            merge(true, http.Header{}),
		},
		{
			// challengeCompat=true subresource path: present upstream
			// Cache-Control SURVIVES (no-store overwrite skipped).
			name: "challengecompat_preserves_cache_control",
			src: http.Header{
				"Cache-Control": {"public, max-age=300"},
				"Content-Type":  {"text/javascript"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: true,
			// noStore=false: no forced Cache-Control; the surviving upstream one
			// is carried instead.
			want: merge(false, http.Header{
				"Cache-Control": {"public, max-age=300"},
				"Content-Type":  {"text/javascript"},
			}),
		},
		{
			// challengeCompat=true with NO upstream Cache-Control: stays
			// header-less (we must not synthesize no-store back in).
			name: "challengecompat_no_cache_control_stays_absent",
			src: http.Header{
				"Content-Type": {"text/javascript"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: true,
			want: merge(false, http.Header{
				"Content-Type": {"text/javascript"},
			}),
		},
		{
			// Full hidden-set strip with sentinels. Every member must vanish;
			// only the forced defaults remain.
			name: "full_hidden_set_stripped",
			src: http.Header{
				"Set-Cookie":                          {"s1"},
				"Set-Cookie2":                         {"s2"},
				"Content-Security-Policy":             {"default-src *"},
				"Content-Security-Policy-Report-Only": {"default-src *"},
				"Report-To":                           {"{}"},
				"Reporting-Endpoints":                 {"e=\"/r\""},
				"Nel":                                 {"{}"},
				"Service-Worker-Allowed":              {"/"},
				"Sourcemap":                           {"/a.map"},
				"X-Sourcemap":                         {"/b.map"},
				"Alt-Svc":                             {"h3=\":443\""},
				"Link":                                {"</a>; rel=preload"},
				"Refresh":                             {"5"},
				"Clear-Site-Data":                     {"\"*\""},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want:            merge(true, http.Header{}),
		},
		{
			// Empty input: only the forced defaults appear.
			name: "empty_input_defaults_only",
			src:  http.Header{},
			want: merge(true, http.Header{}),
		},
		{
			// Hop-by-hop full set stripped; a benign header survives alongside
			// the defaults.
			name: "hop_by_hop_full_set_stripped",
			src: http.Header{
				"Connection":          {"close"},
				"Keep-Alive":          {"timeout=5"},
				"Proxy-Authenticate":  {"Basic"},
				"Proxy-Authorization": {"Basic x"},
				"Te":                  {"trailers"},
				"Trailer":             {"X-Foo"},
				"Transfer-Encoding":   {"chunked"},
				"Upgrade":             {"h2c"},
				"Content-Type":        {"application/json"},
			},
			bodyTransformed: false,
			bodyDecoded:     false,
			challengeCompat: false,
			want: merge(true, http.Header{
				"Content-Type": {"application/json"},
			}),
		},
	}
}

// assertHeaderMapEqual compares two header maps exactly: same key set, and for
// each key the same ordered value slice. Failure prints a sorted, readable
// diff so a leaked/dropped header is obvious.
func assertHeaderMapEqual(t *testing.T, got, want http.Header) {
	t.Helper()
	if reflect.DeepEqual(map[string][]string(got), map[string][]string(want)) {
		return
	}
	// Build a unified, sorted view of every key for a precise failure message.
	keys := map[string]struct{}{}
	for k := range got {
		keys[k] = struct{}{}
	}
	for k := range want {
		keys[k] = struct{}{}
	}
	ordered := make([]string, 0, len(keys))
	for k := range keys {
		ordered = append(ordered, k)
	}
	sort.Strings(ordered)
	for _, k := range ordered {
		g := got[k]
		w := want[k]
		if !reflect.DeepEqual(g, w) {
			t.Errorf("header %q: got %#v want %#v", k, g, w)
		}
	}
}

// TestConstructorPolicyCharacterizationOracle is the behavior-preservation
// proof: it pins the FULL output header map for every corpus entry. It must be
// GREEN against the current undecomposed function and stay green through the
// decomposition; any divergence in which headers survive, their values, their
// order, or their canonical keys turns it red.
func TestConstructorPolicyCharacterizationOracle(t *testing.T) {
	for _, tc := range policyOracleCorpus() {
		t.Run(tc.name, func(t *testing.T) {
			got := ConstructorPolicy(tc.src, tc.bodyTransformed, tc.bodyDecoded, tc.challengeCompat)
			assertHeaderMapEqual(t, got, tc.want)
		})
	}
}

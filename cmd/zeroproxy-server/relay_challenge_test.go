package main

import (
	"net/http"
	"net/url"
	"testing"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

// TestMaybeApplyChallengeMarkerOnlyEmitsWhenBothSignalsHold pins the
// two-signal gate: the X-ZP-Challenge-Compat response marker MUST be appended
// only when the per-tab arm AND the header/URL classifier BOTH hold. The OFF
// path (any signal missing) must return the input slice unchanged so existing
// disarmed SW responses are byte-identical to today.
func TestMaybeApplyChallengeMarkerOnlyEmitsWhenBothSignalsHold(t *testing.T) {
	in := [][]string{{"Content-Type", "application/javascript"}}
	cfURL := mustURL(t, "https://challenges.cloudflare.com/turnstile/v0/api.js")
	plainURL := mustURL(t, "https://example.test/index.html")

	// Disarmed + challenge URL → no marker.
	out := maybeApplyChallengeMarker(in, false, cfURL, http.Header{})
	if hasMarker(out) {
		t.Fatal("disarmed must not emit X-ZP-Challenge-Compat")
	}
	if len(out) != len(in) {
		t.Fatal("disarmed must leave header slice length unchanged")
	}

	// Armed + non-challenge URL → no marker.
	out = maybeApplyChallengeMarker(in, true, plainURL, http.Header{})
	if hasMarker(out) {
		t.Fatal("armed + non-challenge URL must not emit marker")
	}

	// Armed + nil URL → no marker (defensive).
	out = maybeApplyChallengeMarker(in, true, nil, http.Header{})
	if hasMarker(out) {
		t.Fatal("nil finalURL must not emit marker")
	}

	// Armed + challenge URL → marker appended exactly once.
	out = maybeApplyChallengeMarker(in, true, cfURL, http.Header{})
	if !hasMarker(out) {
		t.Fatal("armed + challenge URL must emit marker")
	}
	if got := countMarker(out); got != 1 {
		t.Fatalf("marker must appear exactly once, got %d", got)
	}

	// Armed + ordinary URL but Cf-Mitigated: challenge header → marker.
	out = maybeApplyChallengeMarker(
		in, true, plainURL,
		http.Header{"Cf-Mitigated": {"challenge"}},
	)
	if !hasMarker(out) {
		t.Fatal("armed + Cf-Mitigated:challenge must emit marker even on plain URL")
	}
}

// TestMaybeApplyChallengeMarkerDoesNotMutateInputSlice pins that the OFF path
// returns the same slice header (defensive: callers may share it).
func TestMaybeApplyChallengeMarkerDoesNotMutateInputSlice(t *testing.T) {
	in := [][]string{{"X", "1"}}
	out := maybeApplyChallengeMarker(in, false, mustURL(t, "https://x/"), nil)
	if len(in) != 1 || in[0][0] != "X" || in[0][1] != "1" {
		t.Fatalf("input slice was mutated: %#v", in)
	}
	// On the disarmed path the returned slice should be the same header.
	if len(out) != 1 || &out[0] != &in[0] {
		// Note: identity comparison via element pointer; append-not-taken means
		// the slice header is untouched and shares the same backing array.
		t.Fatalf("disarmed must return the input slice unchanged, got %#v", out)
	}
}

func hasMarker(headers [][]string) bool {
	for _, kv := range headers {
		if len(kv) == 2 && kv[0] == armedChallengeResponseHeader && kv[1] == "1" {
			return true
		}
	}
	return false
}

func countMarker(headers [][]string) int {
	n := 0
	for _, kv := range headers {
		if len(kv) == 2 && kv[0] == armedChallengeResponseHeader {
			n++
		}
	}
	return n
}

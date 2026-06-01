package headers

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

type challengeCase struct {
	Name        string `json:"name"`
	CfMitigated string `json:"cf_mitigated"`
	Host        string `json:"host"`
	Path        string `json:"path"`
	Want        bool   `json:"want"`
}

// TestChallengeClassifierMatchesGolden cross-validates IsChallengeDocument
// against the same vectors zp_shared::is_challenge_document uses.
func TestChallengeClassifierMatchesGolden(t *testing.T) {
	cases := readChallengeGolden(t)
	if len(cases) == 0 {
		t.Fatal("challenge_cases.json must not be empty")
	}
	for _, c := range cases {
		got := IsChallengeDocument(c.CfMitigated, c.Host, c.Path)
		if got != c.Want {
			t.Errorf("case %q: cf=%q host=%q path=%q want %v got %v",
				c.Name, c.CfMitigated, c.Host, c.Path, c.Want, got)
		}
	}
}

func TestTargetIsChallengeDocumentNilSafe(t *testing.T) {
	if TargetIsChallengeDocument(nil, nil) {
		t.Fatal("nil header + nil URL must classify as non-challenge")
	}
	u, _ := url.Parse("https://challenges.cloudflare.com/turnstile/v0/api.js")
	if !TargetIsChallengeDocument(nil, u) {
		t.Fatal("nil header but challenge URL must classify true")
	}
	h := http.Header{"Cf-Mitigated": {"challenge"}}
	if !TargetIsChallengeDocument(h, nil) {
		t.Fatal("Cf-Mitigated: challenge but nil URL must classify true")
	}
}

func TestChallengeSubresourceSkipFourSignalGate(t *testing.T) {
	u, _ := url.Parse("https://challenges.cloudflare.com/turnstile/v0/api.js")
	h := http.Header{}
	// All four conditions: armed=true, isDoc=false, classifier match → skip.
	if !ChallengeSubresourceSkip(true, false, h, u) {
		t.Fatal("armed+subresource+challenge must skip")
	}
	// Disarmed.
	if ChallengeSubresourceSkip(false, false, h, u) {
		t.Fatal("disarmed must never skip")
	}
	// Document navigation.
	if ChallengeSubresourceSkip(true, true, h, u) {
		t.Fatal("document navigation must never skip (HTML stays on no-store)")
	}
	// Classifier miss.
	uMiss, _ := url.Parse("https://example.test/index.html")
	if ChallengeSubresourceSkip(true, false, http.Header{}, uMiss) {
		t.Fatal("non-challenge URL must never skip even when armed")
	}
}

// TestApplyChallengeCompatOnlyEmitsWhenBothSignalsHold pins the inertness
// guarantee: the OFF path (any signal missing) MUST leave the header map
// untouched, so existing callers see no observable change.
func TestApplyChallengeCompatOnlyEmitsWhenBothSignalsHold(t *testing.T) {
	u, _ := url.Parse("https://challenges.cloudflare.com/api")
	uMiss, _ := url.Parse("https://example.test/")

	// Disarmed + challenge URL → no marker.
	h := http.Header{}
	ApplyChallengeCompat(h, false, u)
	if h.Get("X-ZP-Challenge-Compat") != "" {
		t.Fatal("disarmed must not emit marker")
	}

	// Armed + non-challenge URL → no marker.
	h = http.Header{}
	ApplyChallengeCompat(h, true, uMiss)
	if h.Get("X-ZP-Challenge-Compat") != "" {
		t.Fatal("non-challenge URL must not emit marker even when armed")
	}

	// Both signals → marker set to exactly "1".
	h = http.Header{}
	ApplyChallengeCompat(h, true, u)
	if got := h.Get("X-ZP-Challenge-Compat"); got != "1" {
		t.Fatalf("armed+challenge must emit X-ZP-Challenge-Compat=1, got %q", got)
	}

	// nil header → no panic.
	ApplyChallengeCompat(nil, true, u)
}

// TestChallengeHostSuffixDecoy pins the case-insensitive EXACT host match.
// A suffix decoy must not slip through and silently grant armed CSP to a
// malicious host that ends in .challenges.cloudflare.com.
func TestChallengeHostSuffixDecoy(t *testing.T) {
	if IsChallengeDocument("", "challenges.cloudflare.com.evil.test", "/") {
		t.Fatal("suffix decoy must not classify as challenge")
	}
	if IsChallengeDocument("", "evil.challenges.cloudflare.com", "/") {
		t.Fatal("subdomain decoy must not classify as challenge")
	}
}

func readChallengeGolden(t *testing.T) []challengeCase {
	t.Helper()
	dir, _ := os.Getwd()
	for i := 0; i < 10; i++ {
		candidate := filepath.Join(dir, "crates", "zp-shared", "testdata", "challenge_cases.json")
		if data, err := os.ReadFile(candidate); err == nil {
			var cases []challengeCase
			if err := json.Unmarshal(data, &cases); err != nil {
				t.Fatalf("parse challenge_cases.json: %v", err)
			}
			return cases
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("challenge_cases.json not found walking up from %s", dir)
	return nil
}

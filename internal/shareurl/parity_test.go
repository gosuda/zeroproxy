package shareurl

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParityWithRustShareURL ensures Go's URL validation accepts/rejects the
// same inputs as Rust's zp_shared::shareurl::parse_share_url. Both consume
// crates/zp-shared/testdata/shareurl_cases.json.
func TestParityWithRustShareURL(t *testing.T) {
	cases := loadShareURLCases(t)
	zeros := bytes.NewReader(make([]byte, 256))
	for _, c := range cases {
		zeros.Seek(0, 0)
		_, err := NewWithRand(zeros, c.Input)
		if c.OK && err != nil {
			t.Errorf("input %q: Go rejected but Rust accepts (%v)", c.Input, err)
			continue
		}
		if !c.OK && err == nil {
			t.Errorf("input %q: Go accepted but Rust rejects (reason %s)", c.Input, c.Reason)
		}
	}
}

// TestShareURLNewWithRandRejectsBadSchemes is a quick local sanity check.
func TestShareURLNewWithRandRejectsBadSchemes(t *testing.T) {
	zeros := bytes.NewReader(make([]byte, 256))
	for _, bad := range []string{"ws://x", "wss://x", "javascript:1", "data:,a", "file:///x", "blob:abc", "", "   ", "notaurl"} {
		zeros.Seek(0, 0)
		if _, err := NewWithRand(zeros, bad); err == nil {
			t.Errorf("expected rejection for %q", bad)
		}
	}
}

// Round-trips a valid URL through crypto/rand to verify the happy path
// remains functional after parity tightening.
func TestShareURLAcceptsHTTPAndHTTPS(t *testing.T) {
	for _, u := range []string{"https://example.com/", "http://example.com/path?q=1"} {
		out, err := NewWithRand(rand.Reader, u)
		if err != nil {
			t.Errorf("expected acceptance for %q, got %v", u, err)
		}
		if !strings.HasPrefix(out, "/zp/p/") {
			t.Errorf("missing /zp/p/ prefix in %q", out)
		}
		// Parse the input is a valid URL still.
		if _, perr := url.Parse(u); perr != nil {
			t.Errorf("bad URL fixture %q: %v", u, perr)
		}
	}
}

type shareURLCase struct {
	Input  string `json:"input"`
	OK     bool   `json:"ok"`
	Scheme string `json:"scheme,omitempty"`
	Host   string `json:"host,omitempty"`
	Reason string `json:"reason,omitempty"`
}

func loadShareURLCases(t *testing.T) []shareURLCase {
	t.Helper()
	dir, _ := os.Getwd()
	for i := 0; i < 10; i++ {
		path := filepath.Join(dir, "crates", "zp-shared", "testdata", "shareurl_cases.json")
		if _, err := os.Stat(path); err == nil {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var cases []shareURLCase
			if err := json.Unmarshal(data, &cases); err != nil {
				t.Fatal(err)
			}
			return cases
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("shareurl_cases.json not found")
	return nil
}

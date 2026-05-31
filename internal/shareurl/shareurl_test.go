package shareurl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/crypto/hkdf"
)

func TestNewWithRandRoundTripsEnvelope(t *testing.T) {
	const target = "https://example.com/path?q=1#frag"
	random := strings.NewReader(strings.Repeat("x", 80))
	path, err := NewWithRand(random, target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, ControlPrefix+"p/") || !strings.Contains(path, "#k=") {
		t.Fatalf("unexpected share path %q", path)
	}
	parts := strings.Split(strings.TrimPrefix(path, ControlPrefix+"p/"), "#k=")
	if len(parts) != 2 {
		t.Fatalf("malformed share path %q", path)
	}
	got := decryptForTest(t, parts[0], parts[1])
	if got != target {
		t.Fatalf("got %q want %q", got, target)
	}
}

func TestNewWithRandAndServersCarriesRelayList(t *testing.T) {
	const target = "https://example.com/path"
	path, err := NewWithRandAndServers(strings.NewReader(strings.Repeat("x", 80)), target, []string{
		"wss://relay.example:443/ws",
		"wss://relay.example/ws",
		"ws://proxy.localhost:8080/zp/ws-pipe",
	})
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.SplitN(strings.TrimPrefix(path, ControlPrefix+"p/"), "#", 2)
	if len(parts) != 2 {
		t.Fatalf("malformed share path %q", path)
	}
	params, err := url.ParseQuery(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	if got := decryptForTest(t, parts[0], params.Get("k")); got != target {
		t.Fatalf("got %q want %q", got, target)
	}
	wantServers := []string{"wss://relay.example/ws", "ws://proxy.localhost:8080/zp/ws-pipe"}
	if strings.Join(params["server"], "\n") != strings.Join(wantServers, "\n") {
		t.Fatalf("servers = %#v, want %#v", params["server"], wantServers)
	}
	if !strings.Contains(path, "server=wss%3A%2F%2Frelay.example%2Fws&server=ws%3A%2F%2Fproxy.localhost%3A8080%2Fzp%2Fws-pipe") {
		t.Fatalf("relay servers not encoded in order: %q", path)
	}
}

func TestNewRejectsNonHTTPURLs(t *testing.T) {
	for _, target := range []string{"", "://bad", "ws://example.com/socket", "wss://example.com/socket", "javascript:alert(1)", "data:text/html,hi", "/relative"} {
		if _, err := NewWithRand(strings.NewReader(strings.Repeat("x", 80)), target); err == nil {
			t.Fatalf("NewWithRand(%q) succeeded", target)
		}
	}
	for _, target := range []string{"http://example.com/", "https://example.com/path"} {
		if _, err := NewWithRand(strings.NewReader(strings.Repeat("x", 80)), target); err != nil {
			t.Fatalf("NewWithRand(%q): %v", target, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Characterization oracle (behavior-preservation proof).
//
// THE TRANSFORM.GO LESSON: a green decrypt round-trip is NOT enough. A reordered
// or subtly-corrupted function can still decrypt correctly. These golden tables
// freeze the EXACT observable behavior of the CURRENT (pre-decomposition) code:
//   * exact full share-path strings (locks IV/ciphertext/tag assembly + fragment
//     encoding + relay-server ordering), derived from a fixed io.Reader seed;
//   * exact error strings for every rejection branch;
//   * order-discriminating relay corpora that distinguish the CURRENT validation
//     order (count-before-parse, post-dedup count, byte-accumulate-before-dedup,
//     first-failing-server-wins) from any plausible reordering.
// Every expected value below was produced by RUNNING the current code, then
// frozen. If a decomposition changes any byte, one of these fails.
//
// The fixed reader is 80 bytes of 'x' (64-byte seed + 16-byte IV), matching the
// existing round-trip tests, so the golden strings are reproducible.

func fixedReader() io.Reader { return strings.NewReader(strings.Repeat("x", 80)) }

func TestNewWithRandAndServers_GoldenPaths(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		servers []string
		want    string
	}{
		{
			name:   "https with query and fragment, no servers",
			target: "https://example.com/path?q=1#frag",
			want:   "/zp/p/eHh4eHh4eHh4eHh4eHh4eIRIkG1kf2-7MFSHXtEOyKsGTPBGny25c3KxeManFS88nq7MV4yF8_MwR6ghGmIXmT_motZWmAqxtGPEBz4FjkXCM1O5VlrfyudrlmRcc8IL#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
		},
		{
			name:    "https with relay servers (dedup + default-port strip + order)",
			target:  "https://example.com/path",
			servers: []string{"wss://relay.example:443/ws", "wss://relay.example/ws", "ws://proxy.localhost:8080/zp/ws-pipe"},
			want:    "/zp/p/eHh4eHh4eHh4eHh4eHh4eIRIkG1kf2-7MFSHXtEOyKvBwni9ryndDvRCNNPp9x6foyLSYfD7xtgdO0GwsRK82SpJmr2XaXriQYqZ_0WtGIE#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA&server=wss%3A%2F%2Frelay.example%2Fws&server=ws%3A%2F%2Fproxy.localhost%3A8080%2Fzp%2Fws-pipe",
		},
		{
			name:   "http target, no servers",
			target: "http://example.com/",
			want:   "/zp/p/eHh4eHh4eHh4eHh4eHh4eGD2wwf3pssbrhy-l3jPIAgaCd6Z87IeXesaMtPJQEtSkdyZL3aPjYZUVOznQI9cZXXd4njoLKkoVRGEkQj9ZFA#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
		},
		{
			name:   "host-only http canonicalized to add trailing slash",
			target: "http://example.com",
			want:   "/zp/p/eHh4eHh4eHh4eHh4eHh4eGD2wwf3pssbrhy-l3jPIAjAUisyTCe0qFeTsfORYzevSK5mx5BVsZqMf75u4Aw7feQqCLBSrYzVZfY4YjMVaGQ#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
		},
		{
			name:   "host case preserved (url.String does not lowercase target host)",
			target: "https://Example.COM/Path",
			want:   "/zp/p/eHh4eHh4eHh4eHh4eHh4eOHWWxMahmbnZOqSVnxNx60uARvcXfqSKHrLqYfzIZgccQp1jClyl08hr1z-ULtAg4OewgvRse10iid1vln1r9I#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NewWithRandAndServers(fixedReader(), tc.target, tc.servers)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("path mismatch:\n got  %q\n want %q", got, tc.want)
			}
		})
	}
}

func TestNewWithRandAndServers_Rejections(t *testing.T) {
	// Every non-http(s) / malformed target collapses to one fail-closed error.
	for _, target := range []string{"", "://bad", "ws://example.com/socket", "wss://example.com/socket", "javascript:alert(1)", "data:text/html,hi", "/relative", "https://"} {
		_, err := NewWithRandAndServers(fixedReader(), target, nil)
		if err == nil || err.Error() != "shareurl: unsupported target URL" {
			t.Fatalf("target %q: got err %v, want %q", target, err, "shareurl: unsupported target URL")
		}
	}
	// A bad relay server propagates the relay error out of the constructor.
	if _, err := NewWithRandAndServers(fixedReader(), "https://h/", []string{"ws://example.com/x"}); err == nil || err.Error() != "shareurl: insecure relay server" {
		t.Fatalf("relay error not propagated: %v", err)
	}
	// Truncated random source surfaces as an EOF-class error, not a partial token.
	if _, err := NewWithRandAndServers(strings.NewReader("short"), "https://h/", nil); err == nil || err.Error() != "unexpected EOF" {
		t.Fatalf("short reader: got %v, want unexpected EOF", err)
	}
}

func TestNormalizeRelayServers_Golden(t *testing.T) {
	cases := []struct {
		name    string
		in      []string
		want    []string
		wantErr string
	}{
		{name: "nil input", in: nil, want: nil},
		{name: "empty slice", in: []string{}, want: nil},
		{name: "whitespace and empty entries skipped", in: []string{"  ", "", "  wss://h/x  "}, want: []string{"wss://h/x"}},
		{
			name: "canonicalization corpus",
			in:   []string{"wss://UPPER.Example/Path", "wss://[::1]:443/", "wss://h:8443", "wss://h"},
			want: []string{"wss://upper.example/Path", "wss://[::1]/", "wss://h:8443/", "wss://h/"},
		},
		{name: "wss default port 443 stripped", in: []string{"wss://a:443/x"}, want: []string{"wss://a/x"}},
		{name: "wss non-default port kept", in: []string{"wss://a:8443/x"}, want: []string{"wss://a:8443/x"}},
		{name: "ws loopback default port 80 stripped", in: []string{"ws://localhost:80/x"}, want: []string{"ws://localhost/x"}},
		{name: "ws loopback localhost allowed", in: []string{"ws://localhost/x"}, want: []string{"ws://localhost/x"}},
		{name: "ws loopback 127.0.0.1 allowed", in: []string{"ws://127.0.0.1/x"}, want: []string{"ws://127.0.0.1/x"}},
		{name: "ws loopback [::1] allowed", in: []string{"ws://[::1]/x"}, want: []string{"ws://[::1]/x"}},
		{name: "ws loopback subdomain.localhost allowed", in: []string{"ws://sub.localhost/x"}, want: []string{"ws://sub.localhost/x"}},
		{name: "ws loopback trailing-dot localhost allowed", in: []string{"ws://localhost./x"}, want: []string{"ws://localhost./x"}},
		{name: "missing path defaults to slash", in: []string{"wss://h"}, want: []string{"wss://h/"}},
		{name: "ws non-loopback rejected as insecure", in: []string{"ws://example.com/x"}, wantErr: "shareurl: insecure relay server"},
		{name: "http scheme unsupported", in: []string{"http://h/x"}, wantErr: "shareurl: unsupported relay server"},
		{name: "userinfo rejected as malformed", in: []string{"wss://user:pass@h/x"}, wantErr: "shareurl: malformed relay server"},
		{name: "fragment rejected as malformed", in: []string{"wss://h/x#frag"}, wantErr: "shareurl: malformed relay server"},
		{name: "missing host rejected as malformed", in: []string{"wss:///x"}, wantErr: "shareurl: malformed relay server"},
		{
			// ORDER LOCK: count check happens at the TOP of the loop iteration,
			// BEFORE parsing the 9th entry. So 8 valid + a malformed 9th yields
			// "too many", NOT "malformed". A parse-then-count reorder would
			// return the wrong error and only this case catches it.
			name:    "count check precedes parse (8 valid + malformed 9th)",
			in:      []string{"wss://s1/x", "wss://s2/x", "wss://s3/x", "wss://s4/x", "wss://s5/x", "wss://s6/x", "wss://s7/x", "wss://s8/x", "::bad::"},
			wantErr: "shareurl: too many relay servers",
		},
		{
			// ORDER LOCK: the count limit checks len(out) (POST-dedup). 20 copies
			// of one valid server collapse to a single entry and never trip the
			// "too many" limit. A pre-dedup count would wrongly reject this.
			name: "post-dedup count: 20 duplicates collapse to one",
			in:   []string{"wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x", "wss://dup/x"},
			want: []string{"wss://dup/x"},
		},
		{
			// First failing server wins: a valid server followed by an insecure
			// ws:// server returns "insecure", proving per-server checks run in
			// input order and short-circuit on the first failure.
			name:    "first failing server determines error",
			in:      []string{"wss://ok/x", "ws://example.com/x"},
			wantErr: "shareurl: insecure relay server",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeRelayServers(tc.in)
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("got err %v, want %q", err, tc.wantErr)
				}
				if got != nil {
					t.Fatalf("expected nil output on error, got %#v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("output mismatch:\n got  %#v\n want %#v", got, tc.want)
			}
		})
	}
}

func TestNormalizeRelayServers_ByteLimitOrder(t *testing.T) {
	// ORDER LOCK: total bytes accumulate (total += len(normalized)) BEFORE the
	// dedup check, so duplicates count toward the byte budget even though they
	// never reach the output. 50 identical long servers stay at one output entry
	// yet trip the byte limit. A "dedup-before-accumulate" reorder would pass.
	long := "wss://averylonghostnamesegment.example.invalid.subdomain.zone./pathpathpathpathpathpathpathpathpathpathpathpathpathpath"
	dup := make([]string, 0, 50)
	for i := 0; i < 50; i++ {
		dup = append(dup, long)
	}
	got, err := NormalizeRelayServers(dup)
	if err == nil || err.Error() != "shareurl: relay server list too large" {
		t.Fatalf("got err %v, want relay server list too large", err)
	}
	if got != nil {
		t.Fatalf("expected nil output, got %#v", got)
	}
}

func decryptForTest(t *testing.T, encrypted, key string) string {
	t.Helper()
	seed, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := base64.RawURLEncoding.DecodeString(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if len(seed) != 64 || len(blob) < aes.BlockSize+sha256.Size || (len(blob)-aes.BlockSize-sha256.Size)%aes.BlockSize != 0 {
		t.Fatalf("bad envelope lengths seed=%d blob=%d", len(seed), len(blob))
	}
	iv := blob[:aes.BlockSize]
	ciphertext := blob[aes.BlockSize : len(blob)-sha256.Size]
	tag := blob[len(blob)-sha256.Size:]
	macKey := deriveForTest(t, seed, shareInfoMAC)
	mac := hmac.New(sha256.New, macKey)
	_, _ = mac.Write(shareMACPrefix)
	_, _ = mac.Write(iv)
	_, _ = mac.Write(ciphertext)
	if !hmac.Equal(tag, mac.Sum(nil)) {
		t.Fatal("bad hmac")
	}
	block, err := aes.NewCipher(deriveForTest(t, seed, shareInfoEnc))
	if err != nil {
		t.Fatal(err)
	}
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ciphertext)
	pad := int(plain[len(plain)-1])
	if pad == 0 || pad > aes.BlockSize || pad > len(plain) {
		t.Fatalf("bad padding %d", pad)
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			t.Fatalf("bad padding byte %d want %d", b, pad)
		}
	}
	return string(plain[:len(plain)-pad])
}

func deriveForTest(t *testing.T, seed, info []byte) []byte {
	t.Helper()
	out := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, seed, nil, info), out); err != nil {
		t.Fatal(err)
	}
	return out
}

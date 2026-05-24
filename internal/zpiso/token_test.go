package zpiso

import "testing"

func TestTokenSiteGranularity(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	a := Token(key, "www.Example.COM")
	b := Token(key, "login.example.com")
	c := Token(key, "example.net")
	if len(a) != 43 {
		t.Fatalf("token length=%d", len(a))
	}
	if a != b {
		t.Fatalf("same eTLD+1 should share token: %q %q", a, b)
	}
	if a == c {
		t.Fatal("different sites must isolate")
	}
}

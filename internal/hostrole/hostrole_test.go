package hostrole

import "testing"

func TestExactHostRoles(t *testing.T) {
	c, err := New("control.example", "assets.example", "relay.example", "example")
	if err != nil {
		t.Fatal(err)
	}
	id := "abcdefghijklmnopqrstuvwxyz234567"
	cases := map[string]Role{"control.example": Control, "control.example:443": Control, "assets.example": Asset, "relay.example": Relay, "o-" + id + ".browse.example": Browse, "control.example:8443": Unknown, "o-" + id + ".browse.example:8443": Unknown, "evilrelay.example": Unknown, "o-" + id + ".browse.example.evil": Unknown, "x.o-" + id + ".browse.example": Unknown}
	for host, want := range cases {
		if got := c.Classify(host); got != want {
			t.Errorf("%s: got %v want %v", host, got, want)
		}
	}
	if !c.AllowedBrowseOrigin("https://o-" + id + ".browse.example") {
		t.Fatal("valid browse origin rejected")
	}
	if c.AllowedBrowseOrigin("https://o-" + id + ".browse.example.evil") {
		t.Fatal("suffix origin accepted")
	}
	withPort, err := New("control.example:8443", "assets.example:8443", "relay.example:8443", "example")
	if err != nil {
		t.Fatal(err)
	}
	if withPort.Classify("relay.example") != Unknown ||
		withPort.Classify("relay.example:8443") != Relay ||
		!withPort.AllowedBrowseOrigin("https://o-"+id+".browse.example:8443") ||
		withPort.AllowedBrowseOrigin("https://o-"+id+".browse.example") {
		t.Fatal("non-default authority port was not enforced exactly")
	}
	if got, ok := c.HTTPSRedirectAuthority("relay.example"); !ok || got != "relay.example" {
		t.Fatalf("default redirect authority = %q, %v", got, ok)
	}
	if got, ok := withPort.HTTPSRedirectAuthority("o-" + id + ".browse.example:80"); !ok || got != "o-"+id+".browse.example:8443" {
		t.Fatalf("browse redirect authority = %q, %v", got, ok)
	}
	for _, authority := range []string{"relay.example:8080", "evilrelay.example", "relay.example.evil"} {
		if _, ok := c.HTTPSRedirectAuthority(authority); ok {
			t.Fatalf("invalid HTTP authority %q accepted", authority)
		}
	}
	if got := withPort.BrowseWildcardAuthority(); got != "*.browse.example:8443" {
		t.Fatalf("wildcard authority = %q", got)
	}
	if _, err := New("control.example", "assets.example:8443", "relay.example", "example"); err == nil {
		t.Fatal("mismatched authority ports accepted")
	}
}

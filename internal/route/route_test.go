package route

import (
	"testing"
	"time"
)

func TestRouteIsOneShotAndCapabilityBound(t *testing.T) {
	table := NewTable()
	binding, err := table.Register(Binding{ProfileID: "p", TabID: "t", DocumentID: "d", OriginID: "o", Target: "https://example.test/a#section", Kind: Document}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if binding.Target != "https://example.test/a" || binding.Fragment != "section" {
		t.Fatalf("target split %#v", binding)
	}
	if _, err := table.Consume(binding.ID, "wrong", "t", "d", "o"); err == nil {
		t.Fatal("wrong profile consumed route")
	}
	got, err := table.Consume(binding.ID, "p", "t", "d", "o")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != binding.ID {
		t.Fatal("route mismatch")
	}
	if _, err := table.Consume(binding.ID, "p", "t", "d", "o"); err == nil {
		t.Fatal("replayed route")
	}
}

func TestRouteRejectsUnsupportedTargets(t *testing.T) {
	table := NewTable()
	for _, target := range []string{"ftp://example.test", "https://u:p@example.test", "javascript:alert(1)"} {
		if _, err := table.Register(Binding{ProfileID: "p", TabID: "t", DocumentID: "d", OriginID: "o", Target: target, Kind: Resource}, time.Minute); err == nil {
			t.Fatalf("accepted %q", target)
		}
	}
}


package htmltx

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

func TestTransformDelegatesWholeDocumentToRustHook(t *testing.T) {
	target, err := url.Parse("https://example.com/app/")
	if err != nil {
		t.Fatal(err)
	}
	called := false
	out, err := Transform(strings.NewReader(`<html><body>raw</body></html>`), Options{
		TabID:        "tab-1",
		EntryID:      "entry-1",
		TargetURL:    target,
		RuntimeToken: "rt-1",
		Servers:      []string{"wss://relay.example/ws"},
		DocumentRewriter: func(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers []string) (string, error) {
			called = true
			if source != `<html><body>raw</body></html>` {
				t.Fatalf("unexpected source: %q", source)
			}
			if targetURL != "https://example.com/app/" {
				t.Fatalf("unexpected target URL: %q", targetURL)
			}
			if controlPrefix != "/zp/" {
				t.Fatalf("unexpected control prefix: %q", controlPrefix)
			}
			if !strings.Contains(runtimePrelude, "runtime-prelude.js") {
				t.Fatalf("runtime prelude was not passed: %q", runtimePrelude)
			}
			if tabID != "tab-1" || runtimeToken != "rt-1" {
				t.Fatalf("unexpected runtime context tab=%q rt=%q", tabID, runtimeToken)
			}
			if len(servers) != 1 || servers[0] != "wss://relay.example/ws" {
				t.Fatalf("unexpected servers: %#v", servers)
			}
			return `<html><body>rust</body></html>`, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("document rewriter hook was not called")
	}
	if string(out) != `<html><body>rust</body></html>` {
		t.Fatalf("unexpected delegated output: %s", out)
	}
}

func TestTransformRequiresRustDocumentRewriter(t *testing.T) {
	target, err := url.Parse("https://example.com/app/")
	if err != nil {
		t.Fatal(err)
	}
	_, err = Transform(strings.NewReader(`<body>raw</body>`), Options{TargetURL: target})
	if !errors.Is(err, ErrMalformedHTML) {
		t.Fatalf("Transform error = %v, want ErrMalformedHTML", err)
	}
}

func TestRuntimePreludeIsSingleRuntimeAsset(t *testing.T) {
	target, err := url.Parse(`https://example.com/path?q="</script><script>evil()</script>&x=1`)
	if err != nil {
		t.Fatal(err)
	}
	prelude := runtimePrelude(Options{
		TabID:          `tab"</script><script>evil()</script>`,
		EntryID:        "entry",
		TargetURL:      target,
		DocumentCookie: `a="</script>`,
		RuntimeToken:   "rt",
	})
	if !strings.Contains(prelude, "runtime-prelude.js") {
		t.Fatalf("missing runtime prelude asset: %s", prelude)
	}
	if strings.Contains(prelude, "zp-core.js") || strings.Contains(prelude, "http-rewriter.js") {
		t.Fatalf("unexpected multi-asset injection: %s", prelude)
	}
	if strings.Contains(prelude, `</script><script>evil()`) {
		t.Fatalf("boot JSON was not script-safe: %s", prelude)
	}
}

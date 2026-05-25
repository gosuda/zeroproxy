package htmltx

import (
	"bytes"
	"net/url"
	"strings"
	"testing"
)

func TestTransformInjectsAndLaundersDocumentNavigation(t *testing.T) {
	target, _ := url.Parse("https://example.com/dir/page.html")
	out, err := Transform(strings.NewReader(`<!doctype html><html><head><base href="https://evil.test/"><script src="/early.js"></script><link rel="preconnect" href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test/"></head><body><a href="/next" ping="https://ping.test">n</a><form action="submit"><button formaction="/alt">go</button></form><iframe src="/child" srcdoc="<p>x</p>"></iframe><object data="x"></object></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"/__zp/zp-core.js", "/__zp/runtime-prelude.js", "/p/", "#k=", "data-zp-target-url=\"https://example.com/next\"", "data-zp-target-url=\"https://example.com/child\"", "ZeroProxy blocked object"} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{"<base", "http-equiv=\"refresh\"", " ping=", "rel=\"preconnect\"", "id=\"zp-topbar\""} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("forbidden %q remained in %s", forbidden, s)
		}
	}
	if bytes.Contains(out, []byte("https://evil.test")) {
		t.Fatalf("uncontrolled navigation hint leaked: %s", s)
	}
}

func TestTransformLeavesJavascriptAndFragmentsUnwrapped(t *testing.T) {
	target, _ := url.Parse("https://example.com/")
	out, err := Transform(strings.NewReader(`<body><a href="#x">hash</a><a href="javascript:alert(1)">js</a></body>`), Options{TabID: "t", EntryID: "e", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `href="#x"`) || !strings.Contains(s, `href="javascript:alert(1)"`) {
		t.Fatalf("expected fragment/javascript to remain inert: %s", s)
	}
}

func TestTransformPreservesRawScriptAndStyleText(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/")
	out, err := Transform(strings.NewReader(`<html><head><style>body::before{content:"x<&>"}</style></head><body><script>window.__cfg={"base":new URL("..",location).pathname,"amp":"<&>"};import("/_app/start.js");</script></body></html>`), Options{TabID: "t", EntryID: "e", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`content:"x<&>"`, `window.__cfg={"base":new URL("..",location).pathname`, `import("/_app/start.js")`} {
		if !strings.Contains(s, want) {
			t.Fatalf("raw script/style text was escaped or corrupted; missing %q in %s", want, s)
		}
	}
	if strings.Contains(s, "&#34;") || strings.Contains(s, "&lt;&amp;&gt;") {
		t.Fatalf("raw script/style text was entity-escaped: %s", s)
	}
}

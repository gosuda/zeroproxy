package htmltx

import (
	"encoding/json"
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
	for _, want := range []string{"/__zp/zp-core.js", "/__zp/runtime-prelude.js", "/p/", "#k=", "__ZP_SET_BASE", "https://evil.test/", "data-zp-target-url=\"https://example.com/next\"", "data-zp-target-url=\"https://example.com/child\"", "ZeroProxy blocked object"} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{"<base", "http-equiv=\"refresh\"", " ping=", "rel=\"preconnect\"", "id=\"zp-topbar\""} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("forbidden %q remained in %s", forbidden, s)
		}
	}
}

func TestTransformPreservesFragmentsAndBlocksExecutableNavigationSchemes(t *testing.T) {
	target, _ := url.Parse("https://example.com/")
	out, err := Transform(strings.NewReader(`<body><a href="#x">hash</a><a href="javascript:alert(1)" data-zp-target-url="https://attacker.test/">js</a><a href="DATA:text/html,hello">data</a><form action="vbscript:msgbox(1)"></form><iframe src="data:text/html,frame"></iframe></body>`), Options{TabID: "t", EntryID: "e", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `href="#x"`) {
		t.Fatalf("expected fragment link to remain local: %s", s)
	}
	for _, forbidden := range []string{`href="javascript:`, `href="DATA:`, `action="vbscript:`, `src="data:`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("executable navigation scheme remained in active attribute %q: %s", forbidden, s)
		}
	}
	if strings.Contains(s, `https://attacker.test/`) {
		t.Fatalf("target-supplied ZeroProxy control attribute remained: %s", s)
	}
	if got := strings.Count(s, `data-zp-blocked-url=`); got != 4 {
		t.Fatalf("blocked URL marker count = %d, want 4 in %s", got, s)
	}
}

func TestRuntimePreludeEmbedsBootAsInertJSON(t *testing.T) {
	target, _ := url.Parse(`https://example.com/path?q="</script><script>evil()</script>&x=1`)
	tabID := `tab"</script><script>evil()</script>`
	out, err := Transform(strings.NewReader(`<body></body>`), Options{
		TabID:          tabID,
		EntryID:        "entry",
		TargetURL:      target,
		DocumentCookie: `a="</script>`,
		RuntimeToken:   `tok<&>`,
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, `Object.defineProperty(window,"__ZP_BOOT"`) {
		t.Fatalf("boot config was embedded in executable JavaScript: %s", s)
	}
	const open = `<script nonce=zp id=__zp-boot type=application/json>`
	start := strings.Index(s, open)
	if start < 0 {
		t.Fatalf("missing inert boot JSON script in %s", s)
	}
	start += len(open)
	end := strings.Index(s[start:], `</script>`)
	if end < 0 {
		t.Fatalf("unterminated boot JSON script in %s", s)
	}
	bootRaw := s[start : start+end]
	for _, unsafe := range []string{"<", ">", "&"} {
		if strings.Contains(bootRaw, unsafe) {
			t.Fatalf("boot JSON contains raw %q in %s", unsafe, bootRaw)
		}
	}
	var boot map[string]string
	if err := json.Unmarshal([]byte(bootRaw), &boot); err != nil {
		t.Fatalf("boot JSON did not decode: %v in %s", err, bootRaw)
	}
	if boot["tabId"] != tabID || boot["targetUrl"] != target.String() || boot["runtimeToken"] != `tok<&>` {
		t.Fatalf("boot JSON mismatch: %#v", boot)
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

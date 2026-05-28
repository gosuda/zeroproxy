package htmltx

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestTransformInjectsAndLaundersDocumentNavigation(t *testing.T) {
	target, _ := url.Parse("https://example.com/dir/page.html")
	out, err := Transform(strings.NewReader(`<!doctype html><html><head><base href="https://evil.test/"><script src="/early.js"></script><link rel="preconnect" href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test/"></head><body><a href="/next" ping="https://ping.test">n</a><form action="submit"><button formaction="/alt">go</button></form><iframe src="/child" srcdoc="<p>x</p>"></iframe><object data="x"></object></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target, Servers: []string{"wss://relay.example/ws"}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"/zp/assets/zp-core.js", "/zp/assets/runtime-prelude.js", "/zp/p/", "#k=", "server=wss%3A%2F%2Frelay.example%2Fws", "__ZP_SET_BASE", "https://evil.test/", `data-zp-target-url="https://example.com/next"`, `data-zp-target-url="https://example.com/dir/submit"`, `data-zp-target-url="https://example.com/alt"`, `data-zp-target-url="https://example.com/child"`, `data-zp-blocked-rel="preconnect"`, `ZeroProxy blocked object`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{"<base", "http-equiv=\"refresh\"", " ping=", " rel=\"preconnect\"", "id=\"zp-topbar\"", `href="/next"`, `action="submit"`, `formaction="/alt"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("forbidden %q remained in %s", forbidden, s)
		}
	}
}

func TestTransformSuppressesIconLinksWithoutLosingVisibleTarget(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="touch.png"></head><body></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		`rel="icon"`,
		`rel="apple-touch-icon"`,
		`href="data:application/x-zeroproxy-icon,1"`,
		`data-zp-target-url="https://example.com/favicon.ico"`,
		`data-zp-target-url="https://example.com/app/touch.png"`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{`href="/favicon.ico"`, `href="touch.png"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("raw icon href %q remained in %s", forbidden, s)
		}
	}
}
func TestTransformPreservesBlockedHeadLinkForHydration(t *testing.T) {
	target, _ := url.Parse("https://example.com/check")
	out, err := Transform(strings.NewReader(`<html><head><!--m67kuz--><link rel="preconnect" href="https://am.i.mullvad.net"/><!----></head><body></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`<!--m67kuz-->`, `<link`, `data-zp-blocked-rel="preconnect"`, `data-zp-blocked-url="https://am.i.mullvad.net"`, `<!---->`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{` rel="preconnect"`, ` href="https://am.i.mullvad.net"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("active blocked link attribute %q remained in %s", forbidden, s)
		}
	}
	marker := strings.Index(s, `<!--m67kuz-->`)
	link := strings.Index(s[marker:], `<link`)
	closingMarker := strings.Index(s[marker:], `<!---->`)
	if marker < 0 || link < 0 || closingMarker < 0 || link > closingMarker {
		t.Fatalf("blocked head link no longer occupies the Svelte hydration slot: %s", s)
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
	for _, want := range []string{`content:"x<&>"`, `__ZP_EXEC_INLINE_SCRIPT(`} {
		if !strings.Contains(s, want) {
			t.Fatalf("raw script/style text was escaped or corrupted; missing %q in %s", want, s)
		}
	}
	if strings.Contains(s, "&#34;") || strings.Contains(s, "&lt;&amp;&gt;") {
		t.Fatalf("raw script/style text was entity-escaped: %s", s)
	}
}

func TestTransformRewritesPhase2ScriptSourcesAndHandlers(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<body onLoad="location.href='/boot'"><script src="/app.js"></script><script>window.location.href='/classic'</script><script type="module">window.location.href='/module'</script><button onclick="return location.href"></button><img onerror="Function('return location.href')()"></body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`/zp/api/script?`, `u=https%3A%2F%2Fexample.com%2Fapp.js`, `kind=classic`, `__ZP_EXEC_INLINE_SCRIPT(`, `__ZP_EXEC_INLINE_MODULE(`, `__ZP_EXEC_EVENT(`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{`src="/app.js"`, `onclick="return location.href"`, `onLoad="location.href='/boot'"`, `onerror="Function(`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("unrewritten script source or handler remained: %q in %s", forbidden, s)
		}
	}
}
func TestTransformStripsIntegrityButBacksUpForRuntimeMasking(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/")
	out, err := Transform(strings.NewReader(`<body><script src="/app.js" integrity="sha384-script" data-zp-integrity="attacker"></script><link rel="stylesheet" href="/app.css" integrity="sha256-style"></body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`data-zp-integrity="sha384-script"`, `data-zp-integrity="sha256-style"`, `/zp/api/script?`, `href="https://example.com/app.css"`, `data-zp-target-url="https://example.com/app.css"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{` integrity="sha384-script"`, ` integrity="sha256-style"`, `data-zp-integrity="attacker"`, `href="/app.css"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("forbidden integrity marker %q remained in %s", forbidden, s)
		}
	}
}

func TestTransformAbsolutizesPassiveSubresources(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<body><img src="/logo.png"><video poster="poster.jpg"><source src="../media.webm"></video><img src="data:image/png;base64,AAAA"></body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`src="https://example.com/logo.png"`, `poster="https://example.com/app/poster.jpg"`, `src="https://example.com/media.webm"`, `src="data:image/png;base64,AAAA"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{`src="/logo.png"`, `poster="poster.jpg"`, `src="../media.webm"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("unresolved passive subresource %q remained in %s", forbidden, s)
		}
	}
}

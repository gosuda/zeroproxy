package htmltx

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestTransformInjectsAndLaundersDocumentNavigation(t *testing.T) {
	target, _ := url.Parse("https://example.com/dir/page.html")
	out, err := Transform(strings.NewReader(`<!doctype html><html><head><base href="https://evil.test/"><script src="/early.js"></script><link rel="preconnect" href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test/"><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-target' https://challenges.cloudflare.com"></head><body><a href="/next" ping="https://ping.test">n</a><form action="submit"><button formaction="/alt">go</button></form><iframe src="/child" srcdoc="<p>x</p>"></iframe><object data="x"></object></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target, Servers: []string{"wss://relay.example/ws"}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"/zp/assets/zp-core.js", "/zp/assets/rust-rewriter.js", "/zp/assets/runtime-prelude.js", "/zp/p/", "#k=", "server=wss%3A%2F%2Frelay.example%2Fws", "__ZP_SET_BASE", "https://evil.test/", `data-zp-target-url="https://example.com/next"`, `data-zp-target-url="https://example.com/dir/submit"`, `data-zp-target-url="https://example.com/alt"`, `data-zp-target-url="https://example.com/child"`, `data-zp-blocked-rel="preconnect"`, `ZeroProxy blocked object`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{"<base", "http-equiv=\"refresh\"", "Content-Security-Policy", "challenges.cloudflare.com", " ping=", " rel=\"preconnect\"", "id=\"zp-topbar\"", `href="/next"`, `action="submit"`, `formaction="/alt"`} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("forbidden %q remained in %s", forbidden, s)
		}
	}
}

func TestTransformBootConfigIncludesResponseReferrerPolicy(t *testing.T) {
	target, _ := url.Parse("https://example.com/")
	out, err := Transform(strings.NewReader(`<body>ok</body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target, ReferrerPolicy: "no-referrer"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"referrerPolicy":"no-referrer"`) {
		t.Fatalf("boot referrer policy missing in %s", s)
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

func TestTransformRewritesSVGUseXLinkHref(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<html><body><svg><use xlink:href="/dist/symbols.svg#icon-a" href="/dist/symbols.svg#icon-a"></use></svg></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, `xlink:href="/dist/symbols.svg#icon-a"`) || strings.Contains(s, `href="/dist/symbols.svg#icon-a"`) {
		t.Fatalf("raw SVG href remained in %s", s)
	}
	if got := strings.Count(s, `/zp/api/fetch?`); got != 2 {
		t.Fatalf("proxied SVG href count = %d, want 2 in %s", got, s)
	}
	if !strings.Contains(s, `data-zp-target-url="https://example.com/dist/symbols.svg#icon-a"`) {
		t.Fatalf("visible SVG target missing in %s", s)
	}
}

func TestTransformKeepsModuleScriptURLStableForModuleGraph(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<html><body><script type="module" src="/assets/main.js"></script><script src="/assets/classic.js"></script></body></html>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target, RuntimeToken: "rt"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `kind=module`) || !strings.Contains(s, `u=https%3A%2F%2Fexample.com%2Fassets%2Fmain.js`) {
		t.Fatalf("module script was not proxied: %s", s)
	}
	moduleStart := strings.Index(s, `kind=module`)
	moduleEnd := strings.Index(s[moduleStart:], `>`)
	moduleTag := s[moduleStart : moduleStart+moduleEnd]
	if strings.Contains(moduleTag, `tab=`) || strings.Contains(moduleTag, `rt=`) {
		t.Fatalf("module script URL should stay stable across graph imports: %s", moduleTag)
	}
	if !strings.Contains(s, `kind=classic`) || !strings.Contains(s, `tab=tab`) || !strings.Contains(s, `rt=rt`) {
		t.Fatalf("classic script lost runtime authorization query: %s", s)
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

func TestRuntimePreludeEmbedsSelfRemovingBoot(t *testing.T) {
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
	if strings.Contains(s, `id=__zp-boot`) || strings.Contains(s, `type=application/json`) {
		t.Fatalf("boot config left an observable JSON marker: %s", s)
	}
	if !strings.Contains(s, `Object.defineProperty(window,'__ZP_BOOT'`) || !strings.Contains(s, `document.currentScript.remove()`) {
		t.Fatalf("missing self-removing boot script in %s", s)
	}
	const open = `<script nonce=zp>(function(){const boot=`
	start := strings.Index(s, open)
	if start < 0 {
		t.Fatalf("missing boot payload in %s", s)
	}
	start += len(open)
	end := strings.Index(s[start:], `;Object.defineProperty`)
	if end < 0 {
		t.Fatalf("unterminated boot payload in %s", s)
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

func TestTransformBlocksInlineScriptsWhenStaticRewriterUnavailable(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/")
	out, err := Transform(strings.NewReader(`<html><head><style>body::before{content:"x<&>"}</style></head><body><script>window.__cfg={"base":new URL("..",location).pathname,"amp":"<&>"};import("/_app/start.js");</script></body></html>`), Options{TabID: "t", EntryID: "e", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`content:"x<&>"`, `Blocked by ZeroProxy rewrite policy`} {
		if !strings.Contains(s, want) {
			t.Fatalf("raw script/style text was escaped or corrupted; missing %q in %s", want, s)
		}
	}
	if strings.Contains(s, "&#34;") || strings.Contains(s, "&lt;&amp;&gt;") {
		t.Fatalf("raw script/style text was entity-escaped: %s", s)
	}
}

func TestTransformRewritesStaticScriptsAndHandlers(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	fake := func(source, kind, targetURL, controlPrefix string) (string, error) {
		return "__rewritten(" + kind + "):" + source, nil
	}
	out, err := Transform(strings.NewReader(`<body onLoad="location.href='/boot'"><script src="/app.js"></script><script>window.location.href='/classic'</script><script type="module">window.location.href='/module'</script><button onclick="return location.href"></button><img onerror="Function('return location.href')()"></body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target, ScriptRewriter: fake})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{`/zp/api/script?`, `u=https%3A%2F%2Fexample.com%2Fapp.js`, `kind=classic`, `nonce="zp"`, `__rewritten(classic):window.location.href='/classic'`, `__rewritten(module):window.location.href='/module'`, `data-zp-blocked-onclick="return location.href"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	for _, forbidden := range []string{`src="/app.js"`, ` onclick="return location.href"`, ` onLoad="location.href='/boot'"`, ` onerror="Function(`} {
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
	for _, want := range []string{`data-zp-integrity="sha384-script"`, `data-zp-integrity="sha256-style"`, `/zp/api/script?`, `/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fapp.css`, `data-zp-target-url="https://example.com/app.css"`} {
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

func TestTransformProxiesPassiveSubresources(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	out, err := Transform(strings.NewReader(`<body><img src="/logo.png" srcset="/small.png 1x, ../large.png 2x"><video poster="poster.jpg"><source src="../media.webm"></video><svg><use href="/icons.svg#icon-a"></use></svg><img src="data:image/png;base64,AAAA"></body>`), Options{TabID: "tab", EntryID: "entry", TargetURL: target})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		`src="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flogo.png"`,
		`data-zp-target-url="https://example.com/logo.png"`,
		`srcset="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fsmall.png 1x, /zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flarge.png 2x"`,
		`data-zp-target-srcset="https://example.com/small.png 1x, https://example.com/large.png 2x"`,
		`poster="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fapp%2Fposter.jpg"`,
		`src="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fmedia.webm"`,
		`href="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Ficons.svg#icon-a"`,
		`data-zp-target-url="https://example.com/icons.svg#icon-a"`,
		`src="data:image/png;base64,AAAA"`,
	} {
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

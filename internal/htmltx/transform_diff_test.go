package htmltx

// transform_diff_test.go contains a DIFFERENTIAL EQUIVALENCE harness that pins
// rewriteToken's exact post-mutation behavior. It vendors the ORIGINAL
// rewriteToken (verbatim from base 5f7fa6e) as origRewriteToken and proves the
// decomposed rewriteToken produces byte-identical structured tokens over a large
// corpus of REAL x/net/html tokenizer output.
//
// WHY THIS EXISTS: rewriteToken does `attrs := tok.Attr[:0]`, aliasing the
// backing array. Subsequent in-place appends overwrite the array WHILE later
// `attr(tok,...)` / `executableScriptKind(tok)` re-read it. A prior refactor
// replaced these post-mutation reads with clean pre-loop snapshots and dropped
// the data-zp-static-script marker (and icon/stylesheet duplicate-attr tails) on
// some inputs; the suite missed it. This harness is the arbiter.

import (
	crand "crypto/rand"
	"fmt"
	mrand "math/rand"
	"net/url"
	"strings"
	"testing"

	"github.com/gosuda/zeroproxy/internal/shareurl"

	xhtml "golang.org/x/net/html"
)

// withDetRand replaces the process-global crypto/rand.Reader with a deterministic
// stream seeded from `seed` for the duration of fn, then restores it. Resetting to
// the SAME seed before both the NEW and ORIGINAL calls means: if both issue the
// identical sequence of shareurl calls (which true equivalence requires) they
// consume identical random bytes and produce identical share-paths. A refactor
// that changes HOW MANY times shareurl is called still diverges and is caught.
// Tests using this MUST NOT run in parallel (the override is global).
func withDetRand(seed int64, fn func()) {
	saved := crand.Reader
	crand.Reader = mrand.New(mrand.NewSource(seed))
	defer func() { crand.Reader = saved }()
	fn()
}

// origRewriteToken is the VERBATIM original from base 5f7fa6e. DO NOT EDIT.
// It calls the unchanged package helpers (attr, executableScriptKind, etc.).
func origRewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
	tag := strings.ToLower(tok.Data)
	blockedLinkRel := ""
	if tag == "link" {
		for _, a := range tok.Attr {
			if strings.EqualFold(a.Key, "rel") && containsBlockedLinkRel(a.Val) {
				blockedLinkRel = a.Val
				break
			}
		}
	}
	attrs := tok.Attr[:0]
	var dataTarget string
	var blockedLinkHref string
	var integrityBackup string
	hasIntegrityBackup := false
	var nonceBackup string
	hasNonceBackup := false
	for _, a := range tok.Attr {
		key := strings.ToLower(a.Key)
		if key == "data-zp-target-url" || key == "data-zp-target-srcset" || key == "data-zp-blocked-url" || key == "data-zp-blocked-rel" || key == "data-zp-integrity" || key == "data-zp-target-nonce" {
			continue
		}
		if key == "integrity" && (tag == "script" || tag == "link") {
			integrityBackup = a.Val
			hasIntegrityBackup = true
			continue
		}
		if key == "nonce" && tag == "script" && executableScriptKind(tok) != "" {
			if strings.TrimSpace(a.Val) != "" && a.Val != "zp" {
				nonceBackup = a.Val
				hasNonceBackup = true
			}
			continue
		}
		if tag == "a" && key == "ping" {
			continue
		}
		if key == "srcdoc" && (tag == "iframe" || tag == "frame") {
			a.Val = injectSrcdoc(a.Val, opt)
			attrs = append(attrs, a)
			continue
		}
		if blockedLinkRel != "" {
			if key == "rel" {
				continue
			}
			if key == "href" {
				if trimmed := strings.TrimSpace(a.Val); trimmed != "" {
					blockedLinkHref = trimmed
				}
				continue
			}
		}
		if tag == "link" && key == "href" && isIconLinkRel(attr(tok, "rel")) {
			trimmed := strings.TrimSpace(a.Val)
			if target, ok := resolveTargetURL(a.Val, opt); ok {
				a.Val = "data:application/x-zeroproxy-icon,1"
				dataTarget = target
			} else {
				a.Val = "data:application/x-zeroproxy-icon,1"
				if trimmed != "" {
					attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
				}
			}
			attrs = append(attrs, a)
			continue
		}
		if tag == "link" && key == "href" && isStylesheetLinkRel(attr(tok, "rel")) {
			trimmed := strings.TrimSpace(a.Val)
			wrapped, target, ok := wrapFetchURL(a.Val, opt)
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewriteSrcsetAttr(tag, key) {
			rewritten, visible, changed := rewriteSrcset(a.Val, opt)
			if changed {
				a.Val = rewritten
				attrs = upsertAttr(attrs, "data-zp-target-srcset", visible)
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewritePassiveAttr(tag, key) {
			trimmed := strings.TrimSpace(a.Val)
			if wrapped, target, ok := wrapFetchURL(a.Val, opt); ok {
				a.Val = wrapped
				dataTarget = target
			} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
			attrs = append(attrs, a)
			continue
		}
		if strings.HasPrefix(key, "on") && len(key) > 2 {
			attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-" + key, Val: a.Val})
			continue
		}
		if tag == "script" && key == "src" && executableScriptKind(tok) != "" {
			trimmed := strings.TrimSpace(a.Val)
			wrapped, target, ok := wrapScriptURL(a.Val, opt, executableScriptKind(tok))
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				if trimmed != "" {
					attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
				}
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewriteAttr(tag, key) {
			trimmed := strings.TrimSpace(a.Val)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				attrs = append(attrs, a)
				continue
			}
			wrapped, target, ok := wrapAttrURL(a.Val, opt, isDocumentNavigationAttr(tag, key))
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else if isDocumentNavigationAttr(tag, key) {
				a.Val = "#"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
		}
		attrs = append(attrs, a)
	}
	if hasIntegrityBackup {
		attrs = upsertAttr(attrs, "data-zp-integrity", integrityBackup)
	}
	if hasNonceBackup {
		attrs = upsertAttr(attrs, "data-zp-target-nonce", nonceBackup)
	}
	if blockedLinkRel != "" {
		attrs = upsertAttr(attrs, "data-zp-blocked-rel", blockedLinkRel)
	}
	if blockedLinkHref != "" {
		attrs = upsertAttr(attrs, "data-zp-blocked-url", blockedLinkHref)
	}
	if dataTarget != "" {
		attrs = upsertAttr(attrs, "data-zp-target-url", dataTarget)
	}
	if tag == "script" && executableScriptKind(tok) != "" {
		attrs = upsertAttr(attrs, "nonce", "zp")
		if attr(tok, "src") == "" {
			attrs = upsertAttr(attrs, "data-zp-static-script", "1")
		}
	}
	tok.Attr = attrs
	return tok
}

// cloneToken deep-copies a token preserving len AND cap of Attr exactly, so both
// the original and refactored runs observe identical append/realloc behavior
// (cap determines when the aliased read freezes).
func cloneToken(t xhtml.Token) xhtml.Token {
	c := t
	if t.Attr != nil {
		attrs := make([]xhtml.Attribute, len(t.Attr), cap(t.Attr))
		copy(attrs, t.Attr)
		c.Attr = attrs
	}
	return c
}

// tokensEqual compares two tokens structurally: Type, DataAtom, Data, and every
// Attr element (Namespace/Key/Val). String()-only comparison is intentionally
// avoided because the prior failure was an unasserted structured difference.
func tokensEqual(a, b xhtml.Token) (bool, string) {
	if a.Type != b.Type {
		return false, fmt.Sprintf("Type: %v != %v", a.Type, b.Type)
	}
	if a.DataAtom != b.DataAtom {
		return false, fmt.Sprintf("DataAtom: %v != %v", a.DataAtom, b.DataAtom)
	}
	if a.Data != b.Data {
		return false, fmt.Sprintf("Data: %q != %q", a.Data, b.Data)
	}
	if len(a.Attr) != len(b.Attr) {
		return false, fmt.Sprintf("Attr len: %d != %d\n  a=%v\n  b=%v", len(a.Attr), len(b.Attr), a.Attr, b.Attr)
	}
	for i := range a.Attr {
		if a.Attr[i].Namespace != b.Attr[i].Namespace || a.Attr[i].Key != b.Attr[i].Key || a.Attr[i].Val != b.Attr[i].Val {
			return false, fmt.Sprintf("Attr[%d]: %#v != %#v", i, a.Attr[i], b.Attr[i])
		}
	}
	// Defense in depth: also compare String() rendering.
	if a.String() != b.String() {
		return false, fmt.Sprintf("String(): %q != %q", a.String(), b.String())
	}
	return true, ""
}

// diffCorpusTokens tokenizes every fragment with the REAL x/net/html tokenizer
// and returns every StartTag/SelfClosingTag token (the inputs rewriteToken sees).
func diffCorpusTokens(t *testing.T) []xhtml.Token {
	t.Helper()
	var toks []xhtml.Token
	for _, frag := range diffCorpusFragments() {
		z := xhtml.NewTokenizer(strings.NewReader(frag))
		for {
			tt := z.Next()
			if tt == xhtml.ErrorToken {
				break
			}
			if tt == xhtml.StartTagToken || tt == xhtml.SelfClosingTagToken {
				toks = append(toks, z.Token())
			}
		}
	}
	return toks
}

func diffOptions() Options {
	target := mustParseURL("https://example.com/dir/page.html")
	return Options{
		TabID:        "tab",
		EntryID:      "entry",
		TargetURL:    target,
		RuntimeToken: "rt",
		Servers:      []string{"wss://relay.example/ws"},
	}
}

func mustParseURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

// diffCorpusFragments returns HTML fragments spanning every rewriteToken branch
// plus adversarial attribute orderings, duplicate attributes, on* handlers, and
// control-attribute (data-zp-*) injections. The cartesian expansion below pushes
// the token count well past 1000 with varying attribute counts to exercise many
// distinct backing-array capacities (cap drives the aliasing freeze point).
func diffCorpusFragments() []string {
	var frags []string

	// 1. Hand-authored shapes hitting each branch and known divergence triggers.
	frags = append(frags, diffCorpusHandcrafted()...)

	// 2. Cartesian expansion: tags x attribute sets. Many caps, many orderings.
	tags := []string{
		"a", "area", "form", "input", "button", "iframe", "frame", "link",
		"img", "source", "audio", "video", "track", "image", "use", "script",
		"style", "object", "embed", "div", "meta", "base",
	}
	attrSets := [][]string{
		{},
		{`href="/x"`},
		{`src="/x"`},
		{`href="/x"`, `rel="stylesheet"`},
		{`rel="icon"`, `href="/fav.ico"`},
		{`href="/fav.ico"`, `rel="icon"`},
		{`rel="preconnect"`, `href="https://evil.test"`},
		{`href="https://evil.test"`, `rel="preconnect"`},
		{`type="module"`, `src="/m.js"`},
		{`src="/m.js"`, `type="module"`},
		{`type=""`, `src="#frag"`},
		{`src="#frag"`, `type=""`},
		{`src="#frag"`},
		{`type="text/javascript"`, `src="/c.js"`, `integrity="sha384-x"`, `nonce="abc"`},
		{`nonce="abc"`, `type=""`, `src="/c.js"`},
		{`onclick="x()"`, `href="/x"`},
		{`href="/x"`, `onclick="x()"`, `onmouseover="y()"`},
		{`srcset="/a.png 1x, /b.png 2x"`, `src="/a.png"`},
		{`ping="https://p.test"`, `href="/n"`},
		{`href="javascript:alert(1)"`},
		{`href="DATA:text/html,x"`},
		{`action="vbscript:msgbox(1)"`},
		{`srcdoc="<p>x</p>"`, `src="/c"`},
		{`poster="p.jpg"`, `src="/v.webm"`},
		{`data-zp-target-url="https://attacker.test/"`, `href="/n"`},
		{`data-zp-blocked-url="x"`, `data-zp-integrity="y"`, `data-zp-target-nonce="z"`, `href="/n"`},
		{`integrity="sha256-x"`, `href="/s.css"`, `rel="stylesheet"`},
		{`xlink:href="/icons.svg#a"`, `href="/icons.svg#a"`},
		{`type="speculationrules"`},
		{`href="#hash"`},
		{`href=""`},
		{`href="   "`},
		{`type="application/json"`, `src="/d.js"`},
		{`href="/a"`, `href="/b"`}, // duplicate attr
		{`onclick="a"`, `onclick="b"`},
		{`rel="stylesheet preload"`, `href="/s.css"`},
		{`rel="manifest"`, `href="/app.webmanifest"`},
		{`href="mailto:x@y.z"`},
		{`href="tel:+123"`},
	}
	for _, tg := range tags {
		for _, set := range attrSets {
			frags = append(frags, "<"+tg+joinAttrs(set)+">")
			frags = append(frags, "<"+tg+joinAttrs(set)+"/>")
		}
	}
	return frags
}

func joinAttrs(set []string) string {
	if len(set) == 0 {
		return ""
	}
	return " " + strings.Join(set, " ")
}

func diffCorpusHandcrafted() []string {
	return []string{
		// data-zp-static-script divergence triggers (the prior 12 mismatches).
		`<script type="" src="#frag"></script>`,
		`<script src="#frag"></script>`,
		`<script type="text/javascript" src="#x"></script>`,
		`<script src="#x" type="module"></script>`,
		`<script type="module" src="#x"></script>`,
		`<script>code()</script>`,
		`<script type=""></script>`,
		`<script nonce="real" type="">a()</script>`,
		`<script nonce="zp" type="">a()</script>`,
		`<script src="/app.js" integrity="sha384-s" data-zp-integrity="atk"></script>`,
		// icon/stylesheet duplicate-attr tails.
		`<link rel="icon" href="/favicon.ico">`,
		`<link rel="apple-touch-icon" href="bad:scheme">`,
		`<link rel="icon" href="javascript:x">`,
		`<link rel="stylesheet" href="/app.css" integrity="sha256-s">`,
		`<link rel="stylesheet" href="javascript:x">`,
		`<link rel="stylesheet" href="">`,
		`<link rel="preconnect" href="https://evil.test">`,
		`<link rel="modulepreload" href="/m.js">`,
		// passive subresources + srcset.
		`<img src="/logo.png" srcset="/small.png 1x, ../large.png 2x">`,
		`<img src="data:image/png;base64,AAAA">`,
		`<video poster="poster.jpg"><source src="../media.webm"></video>`,
		`<svg><use xlink:href="/d.svg#a" href="/d.svg#a"></use></svg>`,
		`<source srcset="a.png, b.png 2x" src="c.png">`,
		// navigation + blocked schemes.
		`<a href="#x">h</a>`,
		`<a href="javascript:alert(1)" data-zp-target-url="https://attacker.test/">j</a>`,
		`<a href="DATA:text/html,hello">d</a>`,
		`<form action="vbscript:msgbox(1)"></form>`,
		`<iframe src="data:text/html,frame"></iframe>`,
		`<a href="/next" ping="https://ping.test">n</a>`,
		`<form action="submit"><button formaction="/alt">go</button></form>`,
		`<iframe src="/child" srcdoc="<p>x</p>"></iframe>`,
		// on* handlers interleaved with rewritable attrs.
		`<body onLoad="location.href='/boot'"><button onclick="x"></button></body>`,
		`<img onerror="f()" src="/i.png" onload="g()">`,
		`<div onclick="a" data-zp-target-url="inj" href="/x"></div>`,
		// control-attribute injection that must be stripped.
		`<a data-zp-target-url="x" data-zp-blocked-url="y" data-zp-blocked-rel="z" data-zp-integrity="i" data-zp-target-nonce="n" data-zp-target-srcset="s" href="/n">x</a>`,
		// dense multi-attr to exercise larger caps.
		`<a href="/n" ping="https://p" onclick="c" onmouseover="m" data-zp-target-url="x" rel="noopener" class="link" id="a1" title="t">x</a>`,
		`<link rel="icon stylesheet" href="/both" integrity="sha-x" data-zp-integrity="atk" nonce="n">`,
	}
}

// TestDiffRewriteTokenEquivalence proves the decomposed rewriteToken produces
// structurally identical tokens to the vendored original across the full corpus.
func TestDiffRewriteTokenEquivalence(t *testing.T) {
	opt := diffOptions()
	toks := diffCorpusTokens(t)
	if len(toks) < 1280 {
		t.Fatalf("corpus too small: %d tokens, want >= 1280", len(toks))
	}
	mismatches := 0
	for i, base := range toks {
		var got, want xhtml.Token
		withDetRand(1, func() { got = rewriteToken(cloneToken(base), opt) })
		withDetRand(1, func() { want = origRewriteToken(cloneToken(base), opt) })
		if ok, why := tokensEqual(got, want); !ok {
			mismatches++
			if mismatches <= 20 {
				t.Errorf("token %d (%q): %s", i, base.String(), why)
			}
		}
	}
	if mismatches != 0 {
		t.Fatalf("rewriteToken diverged from original on %d/%d tokens", mismatches, len(toks))
	}
	t.Logf("rewriteToken == origRewriteToken on %d tokens, 0 mismatches", len(toks))
}

// snapshotRewriteToken is a DELIBERATELY BROKEN variant that takes clean pre-loop
// snapshots of scriptKind/hasSrc/rel (the prior failure mode). It exists ONLY so
// TestDiffHarnessDetectsSnapshotRegression can confirm the harness actually sees
// the divergence the suite missed. It is never used by production code.
func snapshotRewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
	tag := strings.ToLower(tok.Data)
	// THE BUG: snapshot before the loop instead of re-reading post-mutation.
	snapKind := executableScriptKind(tok)
	snapHasSrc := attr(tok, "src") != ""
	snapRel := attr(tok, "rel")
	blockedLinkRel := ""
	if tag == "link" && containsBlockedLinkRel(snapRel) {
		blockedLinkRel = snapRel
	}
	attrs := tok.Attr[:0]
	var dataTarget string
	var blockedLinkHref string
	var integrityBackup string
	hasIntegrityBackup := false
	var nonceBackup string
	hasNonceBackup := false
	for _, a := range tok.Attr {
		key := strings.ToLower(a.Key)
		if key == "data-zp-target-url" || key == "data-zp-target-srcset" || key == "data-zp-blocked-url" || key == "data-zp-blocked-rel" || key == "data-zp-integrity" || key == "data-zp-target-nonce" {
			continue
		}
		if key == "integrity" && (tag == "script" || tag == "link") {
			integrityBackup = a.Val
			hasIntegrityBackup = true
			continue
		}
		if key == "nonce" && tag == "script" && snapKind != "" {
			if strings.TrimSpace(a.Val) != "" && a.Val != "zp" {
				nonceBackup = a.Val
				hasNonceBackup = true
			}
			continue
		}
		if tag == "a" && key == "ping" {
			continue
		}
		if key == "srcdoc" && (tag == "iframe" || tag == "frame") {
			a.Val = injectSrcdoc(a.Val, opt)
			attrs = append(attrs, a)
			continue
		}
		if blockedLinkRel != "" {
			if key == "rel" {
				continue
			}
			if key == "href" {
				if trimmed := strings.TrimSpace(a.Val); trimmed != "" {
					blockedLinkHref = trimmed
				}
				continue
			}
		}
		if tag == "link" && key == "href" && isIconLinkRel(snapRel) {
			trimmed := strings.TrimSpace(a.Val)
			if target, ok := resolveTargetURL(a.Val, opt); ok {
				a.Val = "data:application/x-zeroproxy-icon,1"
				dataTarget = target
			} else {
				a.Val = "data:application/x-zeroproxy-icon,1"
				if trimmed != "" {
					attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
				}
			}
			attrs = append(attrs, a)
			continue
		}
		if tag == "link" && key == "href" && isStylesheetLinkRel(snapRel) {
			trimmed := strings.TrimSpace(a.Val)
			wrapped, target, ok := wrapFetchURL(a.Val, opt)
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewriteSrcsetAttr(tag, key) {
			rewritten, visible, changed := rewriteSrcset(a.Val, opt)
			if changed {
				a.Val = rewritten
				attrs = upsertAttr(attrs, "data-zp-target-srcset", visible)
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewritePassiveAttr(tag, key) {
			trimmed := strings.TrimSpace(a.Val)
			if wrapped, target, ok := wrapFetchURL(a.Val, opt); ok {
				a.Val = wrapped
				dataTarget = target
			} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
			attrs = append(attrs, a)
			continue
		}
		if strings.HasPrefix(key, "on") && len(key) > 2 {
			attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-" + key, Val: a.Val})
			continue
		}
		if tag == "script" && key == "src" && snapKind != "" {
			trimmed := strings.TrimSpace(a.Val)
			wrapped, target, ok := wrapScriptURL(a.Val, opt, snapKind)
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else {
				a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
				if trimmed != "" {
					attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
				}
			}
			attrs = append(attrs, a)
			continue
		}
		if shouldRewriteAttr(tag, key) {
			trimmed := strings.TrimSpace(a.Val)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				attrs = append(attrs, a)
				continue
			}
			wrapped, target, ok := wrapAttrURL(a.Val, opt, isDocumentNavigationAttr(tag, key))
			if ok {
				a.Val = wrapped
				dataTarget = target
			} else if isDocumentNavigationAttr(tag, key) {
				a.Val = "#"
				attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
			}
		}
		attrs = append(attrs, a)
	}
	if hasIntegrityBackup {
		attrs = upsertAttr(attrs, "data-zp-integrity", integrityBackup)
	}
	if hasNonceBackup {
		attrs = upsertAttr(attrs, "data-zp-target-nonce", nonceBackup)
	}
	if blockedLinkRel != "" {
		attrs = upsertAttr(attrs, "data-zp-blocked-rel", blockedLinkRel)
	}
	if blockedLinkHref != "" {
		attrs = upsertAttr(attrs, "data-zp-blocked-url", blockedLinkHref)
	}
	if dataTarget != "" {
		attrs = upsertAttr(attrs, "data-zp-target-url", dataTarget)
	}
	if tag == "script" && snapKind != "" {
		attrs = upsertAttr(attrs, "nonce", "zp")
		if !snapHasSrc {
			attrs = upsertAttr(attrs, "data-zp-static-script", "1")
		}
	}
	tok.Attr = attrs
	return tok
}

// TestDiffHarnessDetectsSnapshotRegression is a META-TEST: it confirms the
// harness CAN detect the exact regression the suite missed. The snapshot variant
// MUST diverge from the original; if it does not, the harness is too weak to
// trust a 0 from TestDiffRewriteTokenEquivalence.
func TestDiffHarnessDetectsSnapshotRegression(t *testing.T) {
	opt := diffOptions()
	toks := diffCorpusTokens(t)
	mismatches := 0
	for _, base := range toks {
		var got, want xhtml.Token
		withDetRand(1, func() { got = snapshotRewriteToken(cloneToken(base), opt) })
		withDetRand(1, func() { want = origRewriteToken(cloneToken(base), opt) })
		if ok, _ := tokensEqual(got, want); !ok {
			mismatches++
		}
	}
	if mismatches == 0 {
		t.Fatalf("harness FAILED to detect the snapshot regression; it is too weak to trust")
	}
	t.Logf("harness detected snapshot regression on %d tokens (sanity check passed)", mismatches)
}

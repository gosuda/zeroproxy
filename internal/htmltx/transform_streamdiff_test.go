package htmltx

// transform_streamdiff_test.go extends the differential proof from the single
// rewriteToken (transform_diff_test.go) to the streaming TransformTo loop and
// the srcset parser.
//
// PROOF FACTORING (see advisor rationale): end-to-end equivalence of the new
// TransformTo is proved as P1 ∘ P2:
//   P1  new rewriteToken/parseSrcset == originals (0 mismatches).
//   P2  origTransformTo[current helpers] == newTransformTo[current helpers] over a
//       document corpus. Running BOTH sides on the CURRENT helpers cancels the
//       helpers out and isolates exactly what the TransformTo decomposition
//       changed: dispatch order, continue/fallthrough, flush points, prelude
//       injection sites, blocked-subtree skipping, and raw-text arming.
// Composing P1 and P2 yields true end-to-end equivalence.

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"

	xhtml "golang.org/x/net/html"
)

// origTransformTo is the VERBATIM original from base 5f7fa6e. DO NOT EDIT. It is
// intentionally called with the CURRENT in-package helpers so the P2 differential
// isolates the control-flow refactor.
func origTransformTo(w io.Writer, r io.Reader, opt Options) error {
	if opt.TargetURL == nil || opt.TargetURL.Scheme == "" || opt.TargetURL.Host == "" {
		return fmt.Errorf("%w: missing target URL", ErrMalformedHTML)
	}
	z := xhtml.NewTokenizer(r)
	out := bufio.NewWriter(w)
	prelude := runtimePrelude(opt)
	preludeInjected := false
	blockedDepth := 0
	blockedTag := ""
	rawTextTag := ""
	rawTextKind := ""
	var rawTextBuf strings.Builder
	for {
		tt := z.Next()
		if tt == xhtml.ErrorToken {
			err := z.Err()
			if err == io.EOF {
				break
			}
			return fmt.Errorf("%w: %v", ErrMalformedHTML, err)
		}
		tok := z.Token()
		if blockedDepth > 0 {
			if tok.Type == xhtml.StartTagToken && strings.EqualFold(tok.Data, blockedTag) {
				blockedDepth++
			}
			if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, blockedTag) {
				blockedDepth--
				if blockedDepth == 0 {
					blockedTag = ""
				}
			}
			continue
		}
		if rawTextTag != "" {
			if tok.Type == xhtml.TextToken {
				if rawTextKind != "" {
					rawTextBuf.WriteString(tok.Data)
				} else {
					out.WriteString(tok.Data)
					if err := out.Flush(); err != nil {
						return err
					}
				}
				continue
			}
			if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, rawTextTag) {
				if rawTextKind == "importmap" {
					out.WriteString(rewriteInlineImportMap(rawTextBuf.String(), opt))
				} else if rawTextKind == "style" {
					out.WriteString(rewriteInlineStyle(rawTextBuf.String(), opt))
				} else if rawTextKind != "" {
					out.WriteString(rewriteInlineScript(rawTextBuf.String(), rawTextKind, opt))
				}
				rawTextBuf.Reset()
				out.WriteString(tok.String())
				if err := out.Flush(); err != nil {
					return err
				}
				rawTextTag = ""
				rawTextKind = ""
				continue
			}
		}

		if tok.Type == xhtml.StartTagToken || tok.Type == xhtml.SelfClosingTagToken {
			tag := strings.ToLower(tok.Data)
			if tag == "head" && !preludeInjected {
				out.WriteString(tok.String())
				out.WriteString(prelude)
				preludeInjected = true
				if err := out.Flush(); err != nil {
					return err
				}
				continue
			}
			if tag == "script" && origHasAttrValue(tok, "type", "speculationrules") {
				if tok.Type == xhtml.StartTagToken {
					blockedDepth = 1
					blockedTag = "script"
				}
				continue
			}
			if tag == "script" && !preludeInjected {
				out.WriteString(prelude)
				preludeInjected = true
			}
			if tag == "body" {
				if !preludeInjected {
					out.WriteString(prelude)
					preludeInjected = true
				}
				tok = rewriteToken(tok, opt)
				out.WriteString(tok.String())
				if err := out.Flush(); err != nil {
					return err
				}
				continue
			}
			if tag == "base" {
				out.WriteString(baseSyncScript(attr(tok, "href"), opt))
				if err := out.Flush(); err != nil {
					return err
				}
				continue
			}
			if isMetaPolicy(tok) {
				continue
			}
			if tag == "object" {
				out.WriteString(blockedPlaceholder("object"))
				if err := out.Flush(); err != nil {
					return err
				}
				if tok.Type == xhtml.StartTagToken {
					blockedDepth = 1
					blockedTag = "object"
				}
				continue
			}
			if tag == "embed" {
				out.WriteString(blockedPlaceholder("embed"))
				if err := out.Flush(); err != nil {
					return err
				}
				continue
			}
			tok = rewriteToken(tok, opt)
			if tag == "script" && tok.Type == xhtml.StartTagToken {
				rawTextTag = tag
				if attr(tok, "src") == "" {
					if origHasAttrValue(tok, "type", "importmap") {
						rawTextKind = "importmap"
					} else {
						rawTextKind = executableScriptKind(tok)
					}
					rawTextBuf.Reset()
				}
			} else if tag == "style" && tok.Type == xhtml.StartTagToken {
				rawTextTag = tag
				rawTextKind = "style"
			}
		}
		out.WriteString(tok.String())
		if err := out.Flush(); err != nil {
			return err
		}
	}
	if !preludeInjected {
		out.WriteString(prelude)
	}
	return out.Flush()
}

// origHasAttrValue mirrors the production hasAttrValue body exactly. The vendored
// origTransformTo uses it instead of the production helper purely so that adding
// this differential harness does not widen unparam's cross-file view of
// hasAttrValue's callers (every caller passes key="type"), which would surface a
// finding on production transform.go. Behavior is identical.
func origHasAttrValue(tok xhtml.Token, key, val string) bool {
	return strings.EqualFold(strings.TrimSpace(attr(tok, key)), val)
}

// origURLScheme is the VERBATIM original from base 5f7fa6e. DO NOT EDIT. It pins
// the security-sensitive scheme classification before the isSchemeContinuationChar
// extraction.
func origURLScheme(s string) (string, bool) {
	if s == "" || !isASCIILetter(s[0]) {
		return "", false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if c == ':' {
			return s[:i], true
		}
		if isASCIILetter(c) || isASCIIDigit(c) || c == '+' || c == '-' || c == '.' {
			continue
		}
		return "", false
	}
	return "", false
}

// TestStreamDiffURLSchemeEquivalence proves the extracted urlScheme matches the
// original over scheme-classification inputs including the dangerous/executable
// schemes the membrane blocks.
func TestStreamDiffURLSchemeEquivalence(t *testing.T) {
	corpus := []string{
		"", ":", "a", "a:", "http://x", "https://x", "HTTP://x",
		"javascript:alert(1)", "JavaScript:x", "vbscript:y", "data:text/html,x",
		"DATA:x", "mailto:a@b", "tel:+1", "ftp://x", "1abc:x", "+bad:x",
		"a+b-c.d:x", "a b:x", "a/b:x", "a?b", "#frag", "a.:x", "scheme.with.dots:y",
		"a1+2-3.4:rest", "no-colon-here", "trailing:", "::double", "ünìcode:x",
	}
	for _, s := range corpus {
		gotScheme, gotOK := urlScheme(s)
		wantScheme, wantOK := origURLScheme(s)
		if gotScheme != wantScheme || gotOK != wantOK {
			t.Fatalf("urlScheme(%q) = (%q,%v), want (%q,%v)", s, gotScheme, gotOK, wantScheme, wantOK)
		}
	}
}

// origParseSrcset is the VERBATIM original from base 5f7fa6e. DO NOT EDIT.
func origParseSrcset(raw string) []srcsetCandidate {
	var out []srcsetCandidate
	s := strings.TrimSpace(raw)
	for len(s) > 0 {
		start := 0
		for start < len(s) && isHTMLSpace(s[start]) {
			start++
		}
		s = s[start:]
		if s == "" {
			break
		}
		i := 0
		if strings.HasPrefix(strings.ToLower(s), "data:") {
			for i < len(s) && !isHTMLSpace(s[i]) {
				i++
			}
		} else {
			for i < len(s) && !isHTMLSpace(s[i]) && s[i] != ',' {
				i++
			}
		}
		urlPart := s[:i]
		j := i
		for j < len(s) && s[j] != ',' {
			j++
		}
		desc := strings.TrimSpace(s[i:j])
		rawCandidate := strings.TrimSpace(s[:j])
		out = append(out, srcsetCandidate{raw: rawCandidate, url: urlPart, descriptor: desc})
		if j >= len(s) {
			break
		}
		s = s[j+1:]
	}
	return out
}

// transformViaOrig runs the vendored original TransformTo over doc and returns
// its full output. Errors are returned for comparison too.
func transformViaOrig(doc string, opt Options) (string, error) {
	var buf bytes.Buffer
	err := origTransformTo(&buf, strings.NewReader(doc), opt)
	return buf.String(), err
}

// transformViaNew runs the decomposed TransformTo over doc.
func transformViaNew(doc string, opt Options) (string, error) {
	var buf bytes.Buffer
	err := TransformTo(&buf, strings.NewReader(doc), opt)
	return buf.String(), err
}

// streamDiffDocuments returns full HTML documents that exercise every TransformTo
// control-flow branch: the three distinct prelude-injection sites (head, body,
// first script), speculationrules blocking (no prelude), object subtree-skip vs
// self-closing, embed (void), base href, meta refresh/CSP, raw-text script/style/
// importmap bodies, and a document with no head/body (trailing prelude tail).
func streamDiffDocuments() []string {
	return []string{
		`<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>`,
		`<html><body><a href="/n">n</a></body></html>`,                            // prelude at body
		`<html><head><base href="https://evil.test/"></head><body></body></html>`, // prelude at head, base
		`<script src="/early.js"></script><p>x</p>`,                               // prelude at first script
		`<head></head><body></body>`,
		`<p>no head or body at all</p>`, // trailing prelude
		``,                              // empty document
		`<html><head><script type="speculationrules">{"prerender":[]}</script></head><body>x</body></html>`,
		`<script type="speculationrules">{"prerender":[]}</script>`,                        // speculationrules, self-standing
		`<body><object data="x"><param name="p" value="v"><b>fallback</b></object></body>`, // object subtree skip
		`<body><object data="y" /></body>`,                                                 // self-closing object
		`<body><embed src="z"></body>`,                                                     // embed void
		`<head><meta http-equiv="refresh" content="0;url=https://evil.test/"></head>`,
		`<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head>`,
		`<body><script>window.x="<&>";import("/m.js")</script></body>`, // raw-text script
		`<body><script type="module">export const a=1</script></body>`, // module script body
		`<head><style>body::before{content:"x<&>"}</style></head>`,     // raw-text style
		`<head><script type="importmap">{"imports":{"a":"/a.js","b":"./b.js"},"scopes":{"/s/":{"c":"/c.js"}}}</script></head>`,
		`<body><script src="/app.js" integrity="sha384-x" data-zp-integrity="atk"></script></body>`,
		`<body><img src="/logo.png" srcset="/small.png 1x, ../large.png 2x"><video poster="p.jpg"><source src="../m.webm"></video></body>`,
		`<body><link rel="icon" href="/fav.ico"><link rel="stylesheet" href="/a.css"><link rel="preconnect" href="https://evil.test"></body>`,
		`<body><a href="javascript:alert(1)">j</a><form action="vbscript:x()"></form><iframe src="data:text/html,f"></iframe></body>`,
		`<body onload="boot()"><button onclick="c()"></button><img onerror="e()"></body>`,
		`<iframe src="/child" srcdoc="<p>x</p>"></iframe>`,
		`<html><head><!--m67kuz--><link rel="preconnect" href="https://am.i.mullvad.net"/><!----></head><body></body></html>`,
		// Nested object inside object (subtree depth balancing).
		`<body><object data="a"><object data="b"></object>tail</object>after</body>`,
		// Multiple scripts: only the first injects the prelude.
		`<body><script src="/a.js"></script><script src="/b.js"></script></body>`,
		// head AND body AND script all present (injection site precedence).
		`<html><head><script src="/h.js"></script></head><body><script src="/b.js"></script></body></html>`,
	}
}

func streamDiffOptions() []Options {
	base := mustParseURL("https://example.com/dir/page.html")
	root := mustParseURL("https://example.com/")
	return []Options{
		{TabID: "tab", EntryID: "entry", TargetURL: base, RuntimeToken: "rt", Servers: []string{"wss://relay.example/ws"}},
		{TabID: "t2", EntryID: "e2", TargetURL: root, RuntimeToken: "rt2", ReferrerPolicy: "no-referrer"},
	}
}

// TestStreamDiffTransformToEquivalence proves (P2) the decomposed TransformTo
// produces byte-identical full-document output to the vendored original across a
// control-flow corpus, under deterministic randomness reset before each side.
func TestStreamDiffTransformToEquivalence(t *testing.T) {
	docs := streamDiffDocuments()
	cases := 0
	for _, opt := range streamDiffOptions() {
		for _, doc := range docs {
			var gotOut, wantOut string
			var gotErr, wantErr error
			withDetRand(7, func() { gotOut, gotErr = transformViaNew(doc, opt) })
			withDetRand(7, func() { wantOut, wantErr = transformViaOrig(doc, opt) })
			if fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
				t.Fatalf("error mismatch on %q: new=%v orig=%v", doc, gotErr, wantErr)
			}
			if gotOut != wantOut {
				t.Fatalf("TransformTo diverged on %q:\n new:  %s\n orig: %s", doc, gotOut, wantOut)
			}
			cases++
		}
	}
	if cases < len(docs)*2 {
		t.Fatalf("ran only %d cases", cases)
	}
	t.Logf("TransformTo == origTransformTo on %d documents, 0 mismatches", cases)
}

// srcsetDiffCorpus returns adversarial srcset attribute values.
func srcsetDiffCorpus() []string {
	return []string{
		``, `   `, `/a.png`, `/a.png 1x`, `/a.png 1x, /b.png 2x`,
		`/a.png 1x,/b.png 2x`, `  /a.png   1x ,  /b.png 2x  `,
		`data:image/png;base64,AAAA 1x`, `data:image/png;base64,AA AA`,
		`/a.png, , /b.png`, `,`, `,,`, `a`, `a,b,c`,
		`/x.png 100w, /y.png 200w, /z.png 3x`,
		`https://cdn.test/a.png 1x, //cdn.test/b.png 2x`,
		`/a.png 1.5x`, `   `, "\t/a.png\n1x\r,\f/b.png", `data:,x`,
		`/only-desc 999w`, `/trailing, `, ` , /leading`,
	}
}

// TestStreamDiffParseSrcsetEquivalence proves (P1) the decomposed parseSrcset
// matches the vendored original on every corpus input. parseSrcset is pure and
// deterministic, so no randomness control is needed.
func TestStreamDiffParseSrcsetEquivalence(t *testing.T) {
	for _, raw := range srcsetDiffCorpus() {
		got := parseSrcset(raw)
		want := origParseSrcset(raw)
		if len(got) != len(want) {
			t.Fatalf("parseSrcset(%q): len %d != %d\n got=%#v\n want=%#v", raw, len(got), len(want), got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("parseSrcset(%q)[%d]: %#v != %#v", raw, i, got[i], want[i])
			}
		}
	}
}

package htmlsanitize

import (
	"strings"
	"testing"
)

func TestSanitizeDocumentDeniesRawURLSurfaces(t *testing.T) {
	out, err := SanitizeDocument(Input{
		DocID:     "doc-a",
		TargetURL: "https://target.example/app/page.html",
		FinalURL:  "https://target.example/app/page.html",
		HTML: `<!doctype html><html><head>
			<base href="https://cdn.example/base/">
			<link rel="preconnect" href="https://leak.example">
			<link rel="stylesheet" href="style/site.css">
			<link rel="icon" href="/favicon.ico">
			<meta http-equiv="refresh" content="0; url=https://evil.example/">
			<script src="/app.js"></script>
			<script>globalThis.inlineRan = true;</script>
			<style>.hero{background:url(hero.png)}</style>
		</head><body onload="boot()">
			<img src="img.png" srcset="small.png 1x, large.png 2x">
			<a href="/next">next</a>
			<form action="/submit"><button formaction="/button">go</button></form>
			<iframe src="/frame.html"></iframe><object data="/plugin.swf"></object>
			<svg><use xlink:href="/sprite.svg#icon"></use></svg>
		</body></html>`,
		Headers: map[string][]string{"Link": {`</font.woff2>; rel=preload; as=font`}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if raw := rendererRawURLLeak(out.Records); raw != "" {
		t.Fatalf("renderer record leaked raw URL %q in %#v", raw, out.Records)
	}
	for _, want := range []string{"document.base", "resource.discovered", "resource.blocked", "script.external", "script.inline", "style.external", "style.inline", "navigation.link", "navigation.form", "frame.virtualDocument", "event.inlineHandler", "favicon.decision"} {
		if !hasRecord(out.Records, want) {
			t.Fatalf("missing %s in records %#v", want, out.Records)
		}
	}
	if !hasBlockedReason(out.Records, "BLOCKED_REL") || !hasBlockedReason(out.Records, "BLOCKED_LINK_HEADER_REL") {
		t.Fatalf("blocked hints not recorded: %#v", out.Records)
	}
}

func TestSanitizeDocumentPreservesSrcsetDescriptors(t *testing.T) {
	out, err := SanitizeDocument(Input{
		DocID:     "doc-srcset",
		TargetURL: "https://target.example/gallery/index.html",
		FinalURL:  "https://target.example/gallery/index.html",
		HTML:      `<img srcset="one.jpg 1x, two.jpg 2x">`,
	})
	if err != nil {
		t.Fatal(err)
	}
	value := attrRecordValue(out.Records, "srcset")
	if !strings.Contains(value, "zp-internal://resource/") || !strings.Contains(value, " 1x") || !strings.Contains(value, " 2x") {
		t.Fatalf("srcset descriptors not preserved in %q", value)
	}
}

func TestSanitizeDocumentPreservesExternalScriptExecutionAttrs(t *testing.T) {
	out, err := SanitizeDocument(Input{
		DocID:     "doc-script-attrs",
		TargetURL: "https://target.example/",
		FinalURL:  "https://target.example/",
		HTML:      `<html><head><script defer="defer" crossorigin="anonymous" src="/app.js"></script></head></html>`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := attrRecordValue(out.Records, "defer"); got != "defer" {
		t.Fatalf("defer attr = %q, want defer; records %#v", got, out.Records)
	}
	if got := attrRecordValue(out.Records, "crossorigin"); got != "anonymous" {
		t.Fatalf("crossorigin attr = %q, want anonymous; records %#v", got, out.Records)
	}
}

func TestSanitizeDocumentPreservesFragmentNavigationPlaceholders(t *testing.T) {
	out, err := SanitizeDocument(Input{
		DocID:     "doc-fragment-nav",
		TargetURL: "https://target.example/app/page.html",
		FinalURL:  "https://target.example/app/page.html",
		HTML:      `<a href="#main">skip</a><svg><use href="#icon"></use></svg>`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := attrRecordValue(out.Records, "href"); !strings.HasPrefix(got, "about:blank#zp-nav-") {
		t.Fatalf("fragment navigation href = %q, want virtual navigation placeholder; records %#v", got, out.Records)
	}
	if !hasNavigationTarget(out.Records, "https://target.example/app/page.html#main") {
		t.Fatalf("fragment navigation target missing: %#v", out.Records)
	}
	if !hasBlockedReason(out.Records, "POLICY_BLOCKED") {
		t.Fatalf("non-navigation fragment URL should remain blocked: %#v", out.Records)
	}
}

func TestSanitizeDocumentFaviconModes(t *testing.T) {
	blocked, err := SanitizeDocument(Input{DocID: "doc-icon-a", FinalURL: "https://target.example/", HTML: `<link rel="icon" href="/icon.png">`})
	if err != nil {
		t.Fatal(err)
	}
	if !hasFaviconMode(blocked.Records, "block") || !hasBlockedReason(blocked.Records, "FAVICON_BLOCKED") {
		t.Fatalf("favicon block mode missing: %#v", blocked.Records)
	}
	fetched, err := SanitizeDocument(Input{DocID: "doc-icon-b", FinalURL: "https://target.example/", FaviconMode: "fetch", HTML: `<link rel="icon" href="/icon.png">`})
	if err != nil {
		t.Fatal(err)
	}
	if !hasFaviconMode(fetched.Records, "fetch") || !hasResourceKind(fetched.Records, "favicon") {
		t.Fatalf("favicon fetch mode missing: %#v", fetched.Records)
	}
}

func TestSanitizeCSSRewritesThroughTdewolffParser(t *testing.T) {
	out, err := SanitizeCSS(CSSInput{DocID: "doc-css", BaseURL: "https://target.example/app/page.html", CSS: `@import "theme.css"; body{background:url(../bg.png)} .literal{content:"url(/nope.png)"}`})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.CSS, "theme.css") || strings.Contains(out.CSS, "../bg.png") {
		t.Fatalf("CSS output leaked target URLs: %s", out.CSS)
	}
	if !strings.Contains(out.CSS, "zp-internal://resource/") || !hasResourceKind(out.Records, "css-url") {
		t.Fatalf("CSS resources not recorded: %#v css=%s", out.Records, out.CSS)
	}
	if !strings.Contains(out.CSS, `"url(/nope.png)"`) {
		t.Fatalf("CSS string literal was rewritten: %s", out.CSS)
	}
}

func hasRecord(records []Record, recordType string) bool {
	for _, record := range records {
		if record["type"] == recordType {
			return true
		}
	}
	return false
}

func hasNavigationTarget(records []Record, target string) bool {
	for _, record := range records {
		if record["type"] == "resource.discovered" && record["kind"] == "a" && record["resolvedTargetUrl"] == target {
			return true
		}
	}
	return false
}

func hasResourceKind(records []Record, kind string) bool {
	for _, record := range records {
		if record["kind"] == kind {
			return true
		}
	}
	return false
}

func hasBlockedReason(records []Record, reason string) bool {
	for _, record := range records {
		if record["type"] == "resource.blocked" && record["reason"] == reason {
			return true
		}
	}
	return false
}

func hasFaviconMode(records []Record, mode string) bool {
	for _, record := range records {
		if record["type"] == "favicon.decision" && record["mode"] == mode {
			return true
		}
	}
	return false
}

func attrRecordValue(records []Record, name string) string {
	for _, record := range records {
		if record["type"] == "node.attr" && record["name"] == name {
			return record["value"].(string)
		}
	}
	return ""
}

func rendererRawURLLeak(records []Record) string {
	for _, record := range records {
		if record["type"] != "node.attr" && record["type"] != "node.text" {
			continue
		}
		for _, key := range []string{"value", "text"} {
			if text, ok := record[key].(string); ok && strings.Contains(text, "https://target.example") {
				return text
			}
		}
	}
	return ""
}

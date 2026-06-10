package cssrewrite

import (
	"strings"
	"testing"
)

func TestRewriteUsesTdewolffCSSParserForStylesheets(t *testing.T) {
	out, err := Rewrite(`@import "/reset.css";
body { background: url(/img/bg.png#hero); mask: url("https://cdn.example/mask.svg"); }
.icon { background-image: url(data:image/png;base64,aaaa); }
.literal::before { content: "url(/not-a-fetch.png)"; }`, "https://target.example/app/page.html", "/zp/")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`@import "https://target.example/reset.css";`,
		`url("https://target.example/img/bg.png#hero")`,
		`url("https://cdn.example/mask.svg")`,
		`url(data:image/png;base64,aaaa)`,
		`"url(/not-a-fetch.png)"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("rewritten CSS missing %q in:\n%s", want, out)
		}
	}
}

func TestRewriteUsesTdewolffCSSParserForStyleAttributes(t *testing.T) {
	out, err := Rewrite(`color: red; background: url(../bg.png); --literal: "url(/not.png)"`, "https://target.example/app/page.html", "/zp/")
	if err != nil {
		t.Fatal(err)
	}
	want := `background: url("https://target.example/bg.png")`
	if !strings.Contains(out, want) {
		t.Fatalf("style attribute URL not rewritten: %s", out)
	}
	if !strings.Contains(out, `--literal: "url(/not.png)"`) {
		t.Fatalf("string literal was rewritten: %s", out)
	}
}

func TestRewriteFailsClosedOnMalformedCSS(t *testing.T) {
	if _, err := Rewrite(`body { background: url(a b) }`, "https://target.example/", "/zp/"); err == nil {
		t.Fatal("Rewrite accepted malformed CSS")
	}
}

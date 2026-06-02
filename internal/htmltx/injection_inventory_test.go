package htmltx

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	xhtml "golang.org/x/net/html"
)

type injectionInventory struct {
	Scripts      []injectedScript `json:"scripts"`
	ControlAttrs []controlAttr    `json:"controlAttrs"`
}

type injectedScript struct {
	Scope  string `json:"scope"`
	Src    string `json:"src,omitempty"`
	Inline string `json:"inline,omitempty"`
}

type controlAttr struct {
	Scope string `json:"scope"`
	Tag   string `json:"tag"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

func TestTransformInjectionInventorySnapshot(t *testing.T) {
	target, _ := url.Parse("https://example.com/dir/page.html")
	out, err := Transform(strings.NewReader(`<!doctype html><html><head><base href="https://example.com/base/"><link rel="preconnect" href="https://cdn.example/"><link rel="icon" href="/favicon.ico"><script src="/early.js" integrity="sha384-i" nonce="targetnonce"></script></head><body><a href="/next" ping="https://ping.test">n</a><form action="submit"><button formaction="/alt">go</button></form><iframe src="/child" srcdoc="<p>x</p>"></iframe><object data="x"></object></body></html>`), Options{
		TabID:        "tab",
		EntryID:      "entry",
		TargetURL:    target,
		RuntimeToken: "rt",
		Servers:      []string{"wss://relay.example/ws"},
	})
	if err != nil {
		t.Fatal(err)
	}

	got := collectInjectionInventory(t, "document", string(out))
	gotJSON := marshalInventory(t, got)
	golden := filepath.Join("testdata", "injection_inventory.json")
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v\ninitial snapshot:\n%s", err, gotJSON)
	}
	if !bytes.Equal(gotJSON, bytes.TrimSpace(want)) {
		t.Fatalf("injection inventory changed; update %s only with explicit rationale\nwant:\n%s\n\ngot:\n%s", golden, want, gotJSON)
	}
}

func collectInjectionInventory(t *testing.T, scope string, html string) injectionInventory {
	t.Helper()
	z := xhtml.NewTokenizer(strings.NewReader(html))
	var inv injectionInventory
	var currentScript *injectedScript
	for {
		switch tt := z.Next(); tt {
		case xhtml.ErrorToken:
			if z.Err() == nil {
				return sortedInventory(inv)
			}
			return sortedInventory(inv)
		case xhtml.StartTagToken, xhtml.SelfClosingTagToken:
			tok := z.Token()
			tag := strings.ToLower(tok.Data)
			if tag == "script" {
				script := injectedScript{Scope: scope}
				for _, attr := range tok.Attr {
					if strings.EqualFold(attr.Key, "src") && strings.HasPrefix(attr.Val, "/zp/assets/") {
						script.Src = attr.Val
					}
				}
				if script.Src != "" {
					inv.Scripts = append(inv.Scripts, script)
					currentScript = nil
				} else {
					currentScript = &script
				}
			} else {
				currentScript = nil
			}
			for _, attr := range tok.Attr {
				name := strings.ToLower(attr.Key)
				if strings.HasPrefix(name, "data-zp-") {
					inv.ControlAttrs = append(inv.ControlAttrs, controlAttr{
						Scope: scope,
						Tag:   tag,
						Name:  name,
						Value: attr.Val,
					})
				}
				if name == "srcdoc" && (tag == "iframe" || tag == "frame") {
					child := collectInjectionInventory(t, scope+"/srcdoc", attr.Val)
					inv.Scripts = append(inv.Scripts, child.Scripts...)
					inv.ControlAttrs = append(inv.ControlAttrs, child.ControlAttrs...)
				}
			}
		case xhtml.TextToken:
			if currentScript == nil {
				continue
			}
			marker := inlineInjectionMarker(z.Token().Data)
			if marker != "" {
				currentScript.Inline = marker
				inv.Scripts = append(inv.Scripts, *currentScript)
			}
			currentScript = nil
		case xhtml.EndTagToken:
			currentScript = nil
		}
	}
}

func inlineInjectionMarker(source string) string {
	switch {
	case strings.Contains(source, "__ZP_BOOT"):
		return "boot-config"
	case strings.Contains(source, "__ZP_SET_BASE"):
		return "base-sync"
	default:
		return ""
	}
}

func sortedInventory(inv injectionInventory) injectionInventory {
	sort.Slice(inv.Scripts, func(i, j int) bool {
		a, b := inv.Scripts[i], inv.Scripts[j]
		return a.Scope+a.Src+a.Inline < b.Scope+b.Src+b.Inline
	})
	sort.Slice(inv.ControlAttrs, func(i, j int) bool {
		a, b := inv.ControlAttrs[i], inv.ControlAttrs[j]
		return a.Scope+a.Tag+a.Name+a.Value < b.Scope+b.Tag+b.Name+b.Value
	})
	return inv
}

func marshalInventory(t *testing.T, inv injectionInventory) []byte {
	t.Helper()
	out, err := json.MarshalIndent(inv, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return out
}

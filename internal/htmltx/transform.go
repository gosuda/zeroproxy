package htmltx

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"strings"

	"github.com/gosuda/zeroproxy/internal/shareurl"

	xhtml "golang.org/x/net/html"
)

type Options struct {
	TabID          string
	EntryID        string
	TargetURL      *url.URL
	DocumentCookie string
	RuntimeToken   string
}

var ErrMalformedHTML = errors.New("MALFORMED_HTML")

// Transform rewrites a target HTML stream into a top-level ZeroProxy document.
func Transform(r io.Reader, opt Options) ([]byte, error) {
	var out bytes.Buffer
	if err := TransformTo(&out, r, opt); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// TransformTo rewrites a target HTML stream into w without buffering the full
// transformed document. It uses x/net/html's tokenizer and stops on tokenizer
// or write failures; malformed but parser-recoverable markup is emitted after
// token-level recovery.
func TransformTo(w io.Writer, r io.Reader, opt Options) error {
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
				out.WriteString(tok.Data)
				continue
			}
			if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, rawTextTag) {
				out.WriteString(tok.String())
				rawTextTag = ""
				continue
			}
		}

		if tok.Type == xhtml.StartTagToken || tok.Type == xhtml.SelfClosingTagToken {
			tag := strings.ToLower(tok.Data)
			if tag == "head" && !preludeInjected {
				out.WriteString(tok.String())
				out.WriteString(prelude)
				preludeInjected = true
				continue
			}
			if tag == "script" && hasAttrValue(tok, "type", "speculationrules") {
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
				continue
			}
			if shouldDropToken(tok) {
				continue
			}
			if tag == "base" {
				out.WriteString(baseSyncScript(attr(tok, "href"), opt))
				continue
			}
			if isMetaRefresh(tok) {
				continue
			}
			if tag == "object" {
				out.WriteString(blockedPlaceholder("object"))
				if tok.Type == xhtml.StartTagToken {
					blockedDepth = 1
					blockedTag = "object"
				}
				continue
			}
			if tag == "embed" {
				out.WriteString(blockedPlaceholder("embed"))
				continue
			}
			if (tag == "script" || tag == "style") && tok.Type == xhtml.StartTagToken {
				rawTextTag = tag
			}
			tok = rewriteToken(tok, opt)
		}
		out.WriteString(tok.String())
	}
	if !preludeInjected {
		out.WriteString(prelude)
	}
	return out.Flush()
}

func runtimePrelude(opt Options) string {
	boot := map[string]string{
		"tabId": opt.TabID, "entryId": opt.EntryID,
		"targetUrl": opt.TargetURL.String(), "documentCookie": opt.DocumentCookie,
		"runtimeToken": opt.RuntimeToken,
	}
	b, _ := json.Marshal(boot)
	return `<script nonce="zp" src="/__zp/zp-core.js"></script><script nonce="zp">Object.defineProperty(window,"__ZP_BOOT",{value:` + string(b) + `,configurable:true});try{document.currentScript.remove()}catch{}</script><script nonce="zp" src="/__zp/runtime-prelude.js"></script>`
}

func rewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
	tag := strings.ToLower(tok.Data)
	attrs := tok.Attr[:0]
	var dataTarget string
	for _, a := range tok.Attr {
		key := strings.ToLower(a.Key)
		if tag == "a" && key == "ping" {
			continue
		}
		if key == "srcdoc" && (tag == "iframe" || tag == "frame") {
			a.Val = injectSrcdoc(a.Val, opt)
			attrs = append(attrs, a)
			continue
		}
		if shouldRewriteAttr(tag, key) {
			trimmed := strings.TrimSpace(a.Val)
			lower := strings.ToLower(trimmed)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(lower, "javascript:") {
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
	if dataTarget != "" {
		attrs = upsertAttr(attrs, "data-zp-target-url", dataTarget)
	}
	tok.Attr = attrs
	return tok
}

func shouldRewriteAttr(tag, key string) bool {
	switch key {
	case "href":
		return tag == "a" || tag == "area"
	case "action":
		return tag == "form"
	case "formaction":
		return tag == "input" || tag == "button"
	case "src":
		return tag == "iframe" || tag == "frame"
	}
	return false
}

func isDocumentNavigationAttr(tag, key string) bool {
	return (tag == "a" || tag == "area" || tag == "form" || tag == "input" || tag == "button" || tag == "iframe" || tag == "frame") && shouldRewriteAttr(tag, key)
}

func wrapAttrURL(raw string, opt Options, nav bool) (wrapped, target string, ok bool) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.HasPrefix(s, "#") {
		return raw, "", false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "javascript:") {
		return raw, "", false
	}
	u, err := url.Parse(s)
	if err != nil {
		return "#", "", false
	}
	abs := opt.TargetURL.ResolveReference(u)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return "#", "", false
	}
	sharePath, err := shareurl.New(abs.String())
	if err != nil {
		return "#", "", false
	}
	return sharePath, abs.String(), true
}

func injectSrcdoc(src string, opt Options) string {
	return runtimePrelude(opt) + src
}
func baseSyncScript(raw string, opt Options) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	abs := opt.TargetURL.ResolveReference(u)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return ""
	}
	b, _ := json.Marshal(abs.String())
	return `<script nonce="zp">window.__ZP_SET_BASE&&window.__ZP_SET_BASE(` + string(b) + `);</script>`
}

func shouldDropToken(tok xhtml.Token) bool {
	tag := strings.ToLower(tok.Data)
	if tag == "link" {
		rel := strings.ToLower(attr(tok, "rel"))
		for _, blocked := range []string{"modulepreload", "preload", "prefetch", "preconnect", "dns-prefetch", "prerender", "manifest"} {
			if containsToken(rel, blocked) {
				return true
			}
		}
	}
	return false
}

func isMetaRefresh(tok xhtml.Token) bool {
	if !strings.EqualFold(tok.Data, "meta") {
		return false
	}
	return strings.EqualFold(attr(tok, "http-equiv"), "refresh")
}

func blockedPlaceholder(kind string) string {
	return `<div class="zp-blocked-embed" data-zp-blocked="` + html.EscapeString(kind) + `">ZeroProxy blocked ` + html.EscapeString(kind) + ` content</div>`
}

func attr(tok xhtml.Token, key string) string {
	for _, a := range tok.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func hasAttrValue(tok xhtml.Token, key, val string) bool {
	return strings.EqualFold(strings.TrimSpace(attr(tok, key)), val)
}

func containsToken(list, token string) bool {
	for _, part := range strings.Fields(strings.ReplaceAll(list, ",", " ")) {
		if part == token {
			return true
		}
	}
	return false
}

func upsertAttr(attrs []xhtml.Attribute, key, val string) []xhtml.Attribute {
	for i := range attrs {
		if strings.EqualFold(attrs[i].Key, key) {
			attrs[i].Val = val
			return attrs
		}
	}
	return append(attrs, xhtml.Attribute{Key: key, Val: val})
}

func pathEscape(s string) string {
	return strings.NewReplacer("/", "", "\\", "", "?", "", "#", "").Replace(s)
}

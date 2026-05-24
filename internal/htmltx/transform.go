package htmltx

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"strings"

	xhtml "golang.org/x/net/html"
)

type Options struct {
	TabID          string
	EntryID        string
	TargetURL      *url.URL
	DocumentCookie string
}

var ErrMalformedHTML = errors.New("MALFORMED_HTML")

// Transform rewrites a target HTML stream into a top-level ZeroProxy document.
// It uses x/net/html's tokenizer and stops on tokenizer/read failures; malformed
// but parser-recoverable markup is emitted after token-level recovery.
func Transform(r io.Reader, opt Options) ([]byte, error) {
	if opt.TargetURL == nil || opt.TargetURL.Scheme == "" || opt.TargetURL.Host == "" {
		return nil, fmt.Errorf("%w: missing target URL", ErrMalformedHTML)
	}
	z := xhtml.NewTokenizer(r)
	var out bytes.Buffer
	prelude := runtimePrelude(opt)
	topbar := topbarHTML(opt)
	preludeInjected := false
	topbarInjected := false
	blockedDepth := 0
	blockedTag := ""
	for {
		tt := z.Next()
		if tt == xhtml.ErrorToken {
			err := z.Err()
			if err == io.EOF {
				break
			}
			return nil, fmt.Errorf("%w: %v", ErrMalformedHTML, err)
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
				if !topbarInjected {
					out.WriteString(topbar)
					topbarInjected = true
				}
				continue
			}
			if shouldDropToken(tok) {
				continue
			}
			if tag == "base" || isMetaRefresh(tok) {
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
			tok = rewriteToken(tok, opt)
		}
		out.WriteString(tok.String())
	}
	if !preludeInjected {
		out2 := bytes.Buffer{}
		out2.WriteString(prelude)
		out2.Write(out.Bytes())
		out = out2
	}
	if !topbarInjected {
		out2 := bytes.Buffer{}
		out2.WriteString(topbar)
		out2.Write(out.Bytes())
		out = out2
	}
	return out.Bytes(), nil
}

func runtimePrelude(opt Options) string {
	boot := map[string]string{
		"tabId": opt.TabID, "entryId": opt.EntryID,
		"targetUrl": opt.TargetURL.String(), "documentCookie": opt.DocumentCookie,
	}
	b, _ := json.Marshal(boot)
	return `<script nonce="zp" src="/__zp/zp-core.js"></script><script nonce="zp">Object.defineProperty(window,"__ZP_BOOT",{value:` + string(b) + `,configurable:true});</script><script nonce="zp" src="/__zp/runtime-prelude.js"></script>`
}

func topbarHTML(opt Options) string {
	host := html.EscapeString(opt.TargetURL.Host)
	href := html.EscapeString(opt.TargetURL.String())
	return `<div id="zp-topbar" role="banner" style="position:sticky;top:0;z-index:2147483647;display:flex;gap:.75rem;align-items:center;padding:.45rem .75rem;background:#111827;color:#f9fafb;font:13px system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25)"><strong>ZeroProxy</strong><span style="opacity:.8">` + host + `</span><input aria-label="Virtual address" value="` + href + `" readonly style="flex:1;min-width:0;color:#111827;background:#f9fafb;border:0;border-radius:4px;padding:.25rem .4rem"><button type="button" onclick="history.back()">Back</button><button type="button" onclick="location.reload()">Retry</button></div>`
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
	enc := base64.RawURLEncoding.EncodeToString([]byte(abs.String()))
	return "/v/" + pathEscape(opt.TabID) + "/n/" + enc, abs.String(), true
}

func injectSrcdoc(src string, opt Options) string {
	return runtimePrelude(opt) + src
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

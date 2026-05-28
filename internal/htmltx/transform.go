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
	Servers        []string
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
				}
				continue
			}
			if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, rawTextTag) {
				if rawTextKind == "importmap" {
					out.WriteString(rewriteImportMap(rawTextBuf.String(), opt))
				} else if rawTextKind != "" {
					out.WriteString(rewriteInlineScript(rawTextBuf.String(), rawTextKind, opt))
				}
				rawTextBuf.Reset()
				out.WriteString(tok.String())
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
			tok = rewriteToken(tok, opt)
			if tag == "script" && tok.Type == xhtml.StartTagToken {
				rawTextTag = tag
				if attr(tok, "src") == "" {
					if hasAttrValue(tok, "type", "importmap") {
						rawTextKind = "importmap"
					} else {
						rawTextKind = executableScriptKind(tok)
					}
					rawTextBuf.Reset()
				}
			} else if tag == "style" && tok.Type == xhtml.StartTagToken {
				rawTextTag = tag
				rawTextKind = ""
			}
		}
		out.WriteString(tok.String())
	}
	if !preludeInjected {
		out.WriteString(prelude)
	}
	return out.Flush()
}

type bootConfig struct {
	TabID          string   `json:"tabId"`
	EntryID        string   `json:"entryId"`
	TargetURL      string   `json:"targetUrl"`
	DocumentCookie string   `json:"documentCookie"`
	RuntimeToken   string   `json:"runtimeToken"`
	Servers        []string `json:"servers,omitempty"`
}

func runtimePrelude(opt Options) string {
	bootJSON, _ := json.Marshal(bootConfig{
		TabID:          opt.TabID,
		EntryID:        opt.EntryID,
		TargetURL:      opt.TargetURL.String(),
		DocumentCookie: opt.DocumentCookie,
		RuntimeToken:   opt.RuntimeToken,
		Servers:        opt.Servers,
	})
	var b strings.Builder
	b.Grow(len(bootJSON) + 170)
	b.WriteString(`<script nonce=zp src=/zp/assets/zp-core.js></script><script nonce=zp src=/zp/assets/rust-rewriter.js></script><script nonce=zp id=__zp-boot type=application/json>`)
	b.Write(bootJSON)
	b.WriteString(`</script><script nonce=zp src=/zp/assets/runtime-prelude.js></script>`)
	return b.String()
}

func rewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
	tag := strings.ToLower(tok.Data)
	attrs := tok.Attr[:0]
	var dataTarget string
	var integrityBackup string
	hasIntegrityBackup := false
	for _, a := range tok.Attr {
		key := strings.ToLower(a.Key)
		if key == "data-zp-target-url" || key == "data-zp-blocked-url" || key == "data-zp-integrity" {
			continue
		}
		if key == "integrity" && (tag == "script" || tag == "link") {
			integrityBackup = a.Val
			hasIntegrityBackup = true
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
		if strings.HasPrefix(key, "on") && len(key) > 2 {
			a.Val = rewriteEventHandler(a.Val, opt)
			attrs = append(attrs, a)
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

func hasExecutableURLScheme(s string) bool {
	scheme, ok := urlScheme(s)
	return ok && (strings.EqualFold(scheme, "javascript") || strings.EqualFold(scheme, "data") || strings.EqualFold(scheme, "vbscript"))
}

func urlScheme(s string) (string, bool) {
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

func isASCIILetter(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}

func isASCIIDigit(c byte) bool {
	return '0' <= c && c <= '9'
}

func wrapAttrURL(raw string, opt Options, nav bool) (wrapped, target string, ok bool) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.HasPrefix(s, "#") {
		return raw, "", false
	}
	if hasExecutableURLScheme(s) {
		return "#", "", false
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

func wrapScriptURL(raw string, opt Options, kind string) (wrapped, target string, ok bool) {
	s := strings.TrimSpace(raw)
	blocked := shareurl.ControlPrefix + "error/POLICY_BLOCKED"
	if s == "" || strings.HasPrefix(s, "#") || hasExecutableURLScheme(s) {
		return blocked, "", false
	}
	u, err := url.Parse(s)
	if err != nil {
		return blocked, "", false
	}
	abs := opt.TargetURL.ResolveReference(u)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return blocked, "", false
	}
	q := url.Values{}
	q.Set("u", abs.String())
	q.Set("kind", kind)
	return shareurl.ControlPrefix + "api/script?" + q.Encode(), abs.String(), true
}

func executableScriptKind(tok xhtml.Token) string {
	t := strings.TrimSpace(strings.ToLower(attr(tok, "type")))
	if t == "module" {
		return "module"
	}
	if t == "" || t == "text/javascript" || t == "application/javascript" || t == "application/ecmascript" || t == "text/ecmascript" {
		return "classic"
	}
	return ""
}

func rewriteInlineScript(source, kind string, opt Options) string {
	if kind == "module" {
		payload, _ := json.Marshal(source)
		return `__ZP_EXEC_INLINE_MODULE(` + string(payload) + `);`
	}
	payload, _ := json.Marshal(source)
	return `__ZP_EXEC_INLINE_SCRIPT(` + string(payload) + `);`
}

func rewriteEventHandler(source string, opt Options) string {
	payload, _ := json.Marshal(source)
	return `return __ZP_EXEC_EVENT(this,event,` + string(payload) + `)`
}
func rewriteImportMap(source string, opt Options) string {
	var doc map[string]any
	if err := json.Unmarshal([]byte(source), &doc); err != nil {
		return `{}`
	}
	rewriteAddress := func(raw string) string {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			return shareurl.ControlPrefix + "error/POLICY_BLOCKED"
		}
		abs := opt.TargetURL.ResolveReference(u)
		if abs.Scheme != "http" && abs.Scheme != "https" {
			return shareurl.ControlPrefix + "error/POLICY_BLOCKED"
		}
		q := url.Values{}
		q.Set("kind", "module")
		q.Set("u", abs.String())
		return shareurl.ControlPrefix + "api/script?" + q.Encode()
	}
	if imports, ok := doc["imports"].(map[string]any); ok {
		for k, v := range imports {
			if s, ok := v.(string); ok {
				imports[k] = rewriteAddress(s)
			}
		}
	}
	if scopes, ok := doc["scopes"].(map[string]any); ok {
		next := make(map[string]any, len(scopes))
		for scope, rawEntries := range scopes {
			scopeKey := rewriteAddress(scope)
			entries, _ := rawEntries.(map[string]any)
			out := make(map[string]any, len(entries))
			for k, v := range entries {
				if s, ok := v.(string); ok {
					out[k] = rewriteAddress(s)
				}
			}
			next[scopeKey] = out
		}
		doc["scopes"] = next
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return `{}`
	}
	return string(b)
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
	baseJSON, _ := json.Marshal(abs.String())
	var b strings.Builder
	b.Grow(len(baseJSON) + 70)
	b.WriteString(`<script nonce=zp>window.__ZP_SET_BASE&&window.__ZP_SET_BASE(`)
	b.Write(baseJSON)
	b.WriteString(`);</script>`)
	return b.String()
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

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
	TabID                 string
	EntryID               string
	TargetURL             *url.URL
	DocumentCookie        string
	DocumentReferrer      string
	RuntimeToken          string
	Servers               []string
	DynamicCompileAllowed bool
	ReferrerPolicy        string
	ScriptRewriter        func(source, kind, targetURL, controlPrefix string) (string, error)
	CSSRewriter           func(source, baseURL string) (string, error)
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
					if err := out.Flush(); err != nil {
						return err
					}
				}
				continue
			}
			if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, rawTextTag) {
				if rawTextKind == "importmap" {
					out.WriteString(rewriteImportMap(rawTextBuf.String(), opt))
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
					if hasAttrValue(tok, "type", "importmap") {
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

type bootConfig struct {
	TabID                 string   `json:"tabId"`
	EntryID               string   `json:"entryId"`
	TargetURL             string   `json:"targetUrl"`
	DocumentCookie        string   `json:"documentCookie"`
	DocumentReferrer      string   `json:"documentReferrer,omitempty"`
	RuntimeToken          string   `json:"runtimeToken"`
	Servers               []string `json:"servers,omitempty"`
	DynamicCompileAllowed bool     `json:"dynamicCompileAllowed,omitempty"`
	ReferrerPolicy        string   `json:"referrerPolicy,omitempty"`
}

func runtimePrelude(opt Options) string {
	bootJSON, _ := json.Marshal(bootConfig{
		TabID:                 opt.TabID,
		EntryID:               opt.EntryID,
		TargetURL:             opt.TargetURL.String(),
		DocumentCookie:        opt.DocumentCookie,
		DocumentReferrer:      opt.DocumentReferrer,
		RuntimeToken:          opt.RuntimeToken,
		Servers:               opt.Servers,
		DynamicCompileAllowed: opt.DynamicCompileAllowed,
		ReferrerPolicy:        opt.ReferrerPolicy,
	})
	var b strings.Builder
	b.Grow(len(bootJSON) + 130)
	b.WriteString(`<script nonce=zp src=/zp/assets/zp-core.js></script><script nonce=zp src=/zp/assets/rust-rewriter.js></script><script nonce=zp>(function(){const boot=`)
	b.Write(bootJSON)
	b.WriteString(`;Object.defineProperty(window,'__ZP_BOOT',{value:boot,enumerable:false,configurable:true,writable:false});try{document.currentScript.remove()}catch{}})();</script><script nonce=zp src=/zp/assets/runtime-prelude.js></script>`)
	return b.String()
}

func rewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
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

func shouldRewriteAttr(tag, key string) bool {
	key = attrLocalName(key)
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

func shouldRewritePassiveAttr(tag, key string) bool {
	key = attrLocalName(key)
	switch key {
	case "href":
		return tag == "link" || tag == "image" || tag == "use"
	case "src":
		return tag == "img" || tag == "source" || tag == "audio" || tag == "video" || tag == "track" || tag == "input"
	case "poster":
		return tag == "video"
	}
	return false
}

func shouldRewriteSrcsetAttr(tag, key string) bool {
	key = attrLocalName(key)
	return key == "srcset" && (tag == "img" || tag == "source")
}

func attrLocalName(key string) string {
	if i := strings.IndexByte(key, ':'); i >= 0 {
		return key[i+1:]
	}
	return key
}

func rewriteSrcset(raw string, opt Options) (rewritten, visible string, changed bool) {
	candidates := parseSrcset(raw)
	if len(candidates) == 0 {
		return raw, raw, false
	}
	out := make([]string, 0, len(candidates))
	vis := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if c.url == "" {
			continue
		}
		wrapped, target, ok := wrapFetchURL(c.url, opt)
		if !ok {
			out = append(out, c.raw)
			vis = append(vis, c.raw)
			continue
		}
		out = append(out, joinSrcsetCandidate(wrapped, c.descriptor))
		vis = append(vis, joinSrcsetCandidate(target, c.descriptor))
		changed = true
	}
	if !changed {
		return raw, raw, false
	}
	return strings.Join(out, ", "), strings.Join(vis, ", "), true
}

type srcsetCandidate struct {
	raw        string
	url        string
	descriptor string
}

func parseSrcset(raw string) []srcsetCandidate {
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

func joinSrcsetCandidate(urlPart, descriptor string) string {
	if strings.TrimSpace(descriptor) == "" {
		return urlPart
	}
	return urlPart + " " + strings.TrimSpace(descriptor)
}

func isHTMLSpace(b byte) bool {
	return b == ' ' || b == '\n' || b == '\t' || b == '\r' || b == '\f'
}

func hasDangerousURLScheme(s string) bool {
	scheme, ok := urlScheme(s)
	return ok && (strings.EqualFold(scheme, "javascript") || strings.EqualFold(scheme, "vbscript"))
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

func resolveTargetURL(raw string, opt Options) (target string, ok bool) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.HasPrefix(s, "#") || hasExecutableURLScheme(s) {
		return "", false
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", false
	}
	abs := opt.TargetURL.ResolveReference(u)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return "", false
	}
	return abs.String(), true
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
	sharePath, err := shareurl.NewWithServers(abs.String(), opt.Servers)
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
	if kind != "module" {
		q.Set("tab", opt.TabID)
		q.Set("rt", opt.RuntimeToken)
	}
	return shareurl.ControlPrefix + "api/script?" + q.Encode(), abs.String(), true
}

func wrapFetchURL(raw string, opt Options) (wrapped, target string, ok bool) {
	target, ok = resolveTargetURL(raw, opt)
	if !ok {
		return shareurl.ControlPrefix + "error/POLICY_BLOCKED", "", false
	}
	networkTarget := target
	fragment := ""
	if u, err := url.Parse(target); err == nil && u.Fragment != "" {
		fragment = "#" + u.EscapedFragment()
		u.Fragment = ""
		u.RawFragment = ""
		networkTarget = u.String()
	}
	q := url.Values{}
	q.Set("url", networkTarget)
	return shareurl.ControlPrefix + "api/fetch?" + q.Encode() + fragment, target, true
}

func isStylesheetLinkRel(rel string) bool {
	for _, token := range strings.Fields(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(rel)), ",", " ")) {
		if token == "stylesheet" {
			return true
		}
	}
	return false
}

func isIconLinkRel(rel string) bool {
	for _, token := range strings.Fields(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(rel)), ",", " ")) {
		switch token {
		case "icon", "mask-icon", "apple-touch-icon", "apple-touch-icon-precomposed", "apple-touch-startup-image", "fluid-icon":
			return true
		}
	}
	return false
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
	if strings.TrimSpace(source) == "" {
		return source
	}
	if opt.ScriptRewriter != nil {
		if code, err := opt.ScriptRewriter(source, kind, opt.TargetURL.String(), shareurl.ControlPrefix); err == nil {
			return code
		}
	}
	return blockScriptSource()
}

func rewriteEventHandler(source string, opt Options) string {
	if strings.TrimSpace(source) == "" {
		return source
	}
	if opt.ScriptRewriter != nil {
		if code, err := opt.ScriptRewriter(source, "event-handler", opt.TargetURL.String(), shareurl.ControlPrefix); err == nil {
			return code
		}
	}
	return `throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError')`
}

func rewriteInlineStyle(source string, opt Options) string {
	if opt.CSSRewriter != nil {
		if code, err := opt.CSSRewriter(source, opt.TargetURL.String()); err == nil {
			return code
		}
	}
	return source
}

func blockScriptSource() string {
	return `throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');`
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
		q.Set("tab", opt.TabID)
		q.Set("rt", opt.RuntimeToken)
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

func containsBlockedLinkRel(rel string) bool {
	rel = strings.ToLower(rel)
	for _, blocked := range []string{"modulepreload", "preload", "prefetch", "preconnect", "dns-prefetch", "prerender", "manifest"} {
		if containsToken(rel, blocked) {
			return true
		}
	}
	return false
}

func isMetaPolicy(tok xhtml.Token) bool {
	if !strings.EqualFold(tok.Data, "meta") {
		return false
	}
	equiv := strings.TrimSpace(attr(tok, "http-equiv"))
	return strings.EqualFold(equiv, "refresh") || strings.EqualFold(equiv, "content-security-policy") || strings.EqualFold(equiv, "content-security-policy-report-only")
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

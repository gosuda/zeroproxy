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

// streamTransformer carries the streaming-rewrite state for TransformTo across a
// single document. It mirrors the original's local variables exactly; out is a
// bufio.Writer whose WriteString errors are intentionally ignored (only Flush
// errors propagate), preserving the original error-handling contract.
type streamTransformer struct {
	out             *bufio.Writer
	opt             Options
	prelude         string
	preludeInjected bool
	blockedDepth    int
	blockedTag      string
	rawTextTag      string
	rawTextKind     string
	rawTextBuf      strings.Builder
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
	st := &streamTransformer{
		out:     bufio.NewWriter(w),
		opt:     opt,
		prelude: runtimePrelude(opt),
	}
	for {
		tt := z.Next()
		if tt == xhtml.ErrorToken {
			if err := z.Err(); err != io.EOF {
				return fmt.Errorf("%w: %v", ErrMalformedHTML, err)
			}
			break
		}
		if err := st.handleToken(z.Token()); err != nil {
			return err
		}
	}
	if !st.preludeInjected {
		st.out.WriteString(st.prelude)
	}
	return st.out.Flush()
}

// handleToken dispatches one token through the blocked-subtree, raw-text, and
// start-tag stages in the same order as the original monolithic loop. A handled
// token short-circuits; otherwise the token is written verbatim as the tail.
func (st *streamTransformer) handleToken(tok xhtml.Token) error {
	if st.blockedDepth > 0 {
		st.trackBlockedDepth(tok)
		return nil
	}
	if st.rawTextTag != "" {
		if handled, err := st.handleRawText(tok); handled || err != nil {
			return err
		}
	}
	if tok.Type == xhtml.StartTagToken || tok.Type == xhtml.SelfClosingTagToken {
		if handled, err := st.handleStartTag(&tok); handled || err != nil {
			return err
		}
	}
	st.out.WriteString(tok.String())
	return st.out.Flush()
}

// trackBlockedDepth consumes tokens inside a blocked subtree, balancing nested
// open/close of blockedTag until the subtree closes.
func (st *streamTransformer) trackBlockedDepth(tok xhtml.Token) {
	if tok.Type == xhtml.StartTagToken && strings.EqualFold(tok.Data, st.blockedTag) {
		st.blockedDepth++
	}
	if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, st.blockedTag) {
		st.blockedDepth--
		if st.blockedDepth == 0 {
			st.blockedTag = ""
		}
	}
}

// handleRawText buffers or emits the body of an open raw-text element (script /
// style / importmap), flushing the rewritten content on the closing tag. Returns
// handled=true when the token belongs to the raw-text stream.
func (st *streamTransformer) handleRawText(tok xhtml.Token) (bool, error) {
	if tok.Type == xhtml.TextToken {
		if st.rawTextKind != "" {
			st.rawTextBuf.WriteString(tok.Data)
			return true, nil
		}
		st.out.WriteString(tok.Data)
		return true, st.out.Flush()
	}
	if tok.Type == xhtml.EndTagToken && strings.EqualFold(tok.Data, st.rawTextTag) {
		return true, st.closeRawText(tok)
	}
	return false, nil
}

// closeRawText emits the rewritten raw-text content followed by the closing tag,
// then clears the raw-text state.
func (st *streamTransformer) closeRawText(tok xhtml.Token) error {
	switch {
	case st.rawTextKind == "importmap":
		st.out.WriteString(rewriteImportMap(st.rawTextBuf.String(), st.opt))
	case st.rawTextKind == "style":
		st.out.WriteString(rewriteInlineStyle(st.rawTextBuf.String(), st.opt))
	case st.rawTextKind != "":
		st.out.WriteString(rewriteInlineScript(st.rawTextBuf.String(), st.rawTextKind, st.opt))
	}
	st.rawTextBuf.Reset()
	st.out.WriteString(tok.String())
	st.rawTextTag = ""
	st.rawTextKind = ""
	return st.out.Flush()
}

// handleStartTag applies the per-element policy (prelude injection, blocking,
// placeholders, rewriting). It mutates *tok in place where the element is
// rewritten so the verbatim tail write observes the rewrite. Returns handled=true
// when the element produced its own output and the tail write must be skipped.
func (st *streamTransformer) handleStartTag(tok *xhtml.Token) (bool, error) {
	tag := strings.ToLower(tok.Data)
	if tag == "head" && !st.preludeInjected {
		return true, st.emitWithPrelude(tok.String())
	}
	if tag == "script" && hasAttrValue(*tok, "type", "speculationrules") {
		if tok.Type == xhtml.StartTagToken {
			st.enterBlocked("script")
		}
		return true, nil
	}
	if tag == "script" && !st.preludeInjected {
		st.injectPrelude()
	}
	if tag == "body" {
		st.injectPrelude()
		*tok = rewriteToken(*tok, st.opt)
		st.out.WriteString(tok.String())
		return true, st.out.Flush()
	}
	return st.handleSpecialStartTag(tok, tag)
}

// handleSpecialStartTag covers base/meta/object/embed blocking and the default
// rewrite path that arms raw-text capture for script/style.
func (st *streamTransformer) handleSpecialStartTag(tok *xhtml.Token, tag string) (bool, error) {
	switch {
	case tag == "base":
		st.out.WriteString(baseSyncScript(attr(*tok, "href"), st.opt))
		return true, st.out.Flush()
	case isMetaPolicy(*tok):
		return true, nil
	case tag == "object":
		return true, st.emitBlockedSubtree("object", tok)
	case tag == "embed":
		st.out.WriteString(blockedPlaceholder("embed"))
		return true, st.out.Flush()
	}
	*tok = rewriteToken(*tok, st.opt)
	st.armRawTextCapture(*tok, tag)
	return false, nil
}

// armRawTextCapture sets the raw-text state when a rewritten script/style start
// tag begins a raw-text element. The script src check re-reads the rewritten
// token, matching the original.
func (st *streamTransformer) armRawTextCapture(tok xhtml.Token, tag string) {
	if tok.Type != xhtml.StartTagToken {
		return
	}
	if tag == "script" {
		st.armScriptCapture(tok)
		return
	}
	if tag == "style" {
		st.rawTextTag = tag
		st.rawTextKind = "style"
	}
}

// armScriptCapture arms raw-text capture for a script start tag, classifying the
// body as importmap vs executable kind only when the script has no (rewritten)
// src, exactly as the original.
func (st *streamTransformer) armScriptCapture(tok xhtml.Token) {
	st.rawTextTag = "script"
	if attr(tok, "src") != "" {
		return
	}
	if hasAttrValue(tok, "type", "importmap") {
		st.rawTextKind = "importmap"
	} else {
		st.rawTextKind = executableScriptKind(tok)
	}
	st.rawTextBuf.Reset()
}

// injectPrelude writes the runtime prelude once per document.
func (st *streamTransformer) injectPrelude() {
	if !st.preludeInjected {
		st.out.WriteString(st.prelude)
		st.preludeInjected = true
	}
}

// emitWithPrelude writes a leading fragment, then the prelude, marking it injected.
func (st *streamTransformer) emitWithPrelude(lead string) error {
	st.out.WriteString(lead)
	st.out.WriteString(st.prelude)
	st.preludeInjected = true
	return st.out.Flush()
}

// enterBlocked starts skipping a blocked subtree rooted at the given tag.
func (st *streamTransformer) enterBlocked(tag string) {
	st.blockedDepth = 1
	st.blockedTag = tag
}

// emitBlockedSubtree writes a blocked-content placeholder and begins skipping the
// element's subtree when it is a (non-self-closing) start tag.
func (st *streamTransformer) emitBlockedSubtree(kind string, tok *xhtml.Token) error {
	st.out.WriteString(blockedPlaceholder(kind))
	if err := st.out.Flush(); err != nil {
		return err
	}
	if tok.Type == xhtml.StartTagToken {
		st.enterBlocked(kind)
	}
	return nil
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

// tokenRewriter accumulates the in-place attribute rewrite for a single token.
//
// ALIASING CONTRACT (must be preserved): attrs is seeded with tok.Attr[:0], so it
// shares tok.Attr's backing array. Appending to attrs overwrites that array in
// place while the loop still reads it. Methods here re-read tok via attr(tok,...)
// and executableScriptKind(tok) at the SAME points the monolithic original did,
// so they observe the same post-mutation state. tok.Attr is NOT reassigned until
// finish(); no per-attribute decision may be hoisted to a clean pre-loop snapshot.
type tokenRewriter struct {
	tok                xhtml.Token
	opt                Options
	tag                string
	attrs              []xhtml.Attribute
	dataTarget         string
	blockedLinkRel     string
	blockedLinkHref    string
	integrityBackup    string
	hasIntegrityBackup bool
	nonceBackup        string
	hasNonceBackup     bool
}

func rewriteToken(tok xhtml.Token, opt Options) xhtml.Token {
	rw := tokenRewriter{
		tok:            tok,
		opt:            opt,
		tag:            strings.ToLower(tok.Data),
		attrs:          tok.Attr[:0],
		blockedLinkRel: initialBlockedLinkRel(tok),
	}
	for _, a := range tok.Attr {
		rw.rewriteAttr(a)
	}
	return rw.finish()
}

// initialBlockedLinkRel scans the original attribute list for a blocked link rel.
// It reads the pre-mutation rel only for <link>, exactly as the original did
// before seeding attrs; this is a read of the rel token used as a per-token flag,
// not a substitute for the post-mutation attr(tok,"rel") reads inside the loop.
func initialBlockedLinkRel(tok xhtml.Token) string {
	if strings.ToLower(tok.Data) != "link" {
		return ""
	}
	for _, a := range tok.Attr {
		if strings.EqualFold(a.Key, "rel") && containsBlockedLinkRel(a.Val) {
			return a.Val
		}
	}
	return ""
}

// rewriteAttr processes one attribute, mirroring the original branch order. Each
// dispatch helper returns true when it has fully handled the attribute (the
// original's `continue`); a false return falls through to the next branch.
func (rw *tokenRewriter) rewriteAttr(a xhtml.Attribute) {
	key := strings.ToLower(a.Key)
	if rw.dropMaskedAttr(a, key) {
		return
	}
	if rw.handleBlockedLinkAttr(a, key) {
		return
	}
	if rw.handleLinkHrefAttr(a, key) {
		return
	}
	if rw.handleSubresourceAttr(a, key) {
		return
	}
	if rw.handleEventHandlerAttr(a, key) {
		return
	}
	if rw.handleScriptSrcAttr(a, key) {
		return
	}
	rw.handleNavigationAttr(a, key)
}

// dropMaskedAttr handles attributes that are removed from the visible output:
// target-supplied control attributes, integrity/nonce (backed up for runtime
// masking), <a ping>, and srcdoc (rewritten in place and kept).
func (rw *tokenRewriter) dropMaskedAttr(a xhtml.Attribute, key string) bool {
	if isZPControlAttr(key) {
		return true
	}
	if rw.backupMaskedAttr(a, key) {
		return true
	}
	if rw.tag == "a" && key == "ping" {
		return true
	}
	if key == "srcdoc" && (rw.tag == "iframe" || rw.tag == "frame") {
		a.Val = injectSrcdoc(a.Val, rw.opt)
		rw.attrs = append(rw.attrs, a)
		return true
	}
	return false
}

// backupMaskedAttr strips integrity (from script/link) and the executable script
// nonce, stashing each for the runtime masking layer. executableScriptKind(rw.tok)
// is re-read post-mutation, as the original did.
func (rw *tokenRewriter) backupMaskedAttr(a xhtml.Attribute, key string) bool {
	if key == "integrity" && (rw.tag == "script" || rw.tag == "link") {
		rw.integrityBackup = a.Val
		rw.hasIntegrityBackup = true
		return true
	}
	if key == "nonce" && rw.tag == "script" && executableScriptKind(rw.tok) != "" {
		if strings.TrimSpace(a.Val) != "" && a.Val != "zp" {
			rw.nonceBackup = a.Val
			rw.hasNonceBackup = true
		}
		return true
	}
	return false
}

// handleBlockedLinkAttr strips rel/href from a blocked <link>, backing up the
// href into blockedLinkHref. Only active once a blocked rel was detected.
func (rw *tokenRewriter) handleBlockedLinkAttr(a xhtml.Attribute, key string) bool {
	if rw.blockedLinkRel == "" {
		return false
	}
	if key == "rel" {
		return true
	}
	if key == "href" {
		if trimmed := strings.TrimSpace(a.Val); trimmed != "" {
			rw.blockedLinkHref = trimmed
		}
		return true
	}
	return false
}

// handleLinkHrefAttr rewrites icon and stylesheet <link href> attributes. It
// re-reads attr(rw.tok,"rel") post-mutation, exactly as the original did.
func (rw *tokenRewriter) handleLinkHrefAttr(a xhtml.Attribute, key string) bool {
	if rw.tag != "link" || key != "href" {
		return false
	}
	if isIconLinkRel(attr(rw.tok, "rel")) {
		rw.rewriteIconHref(a)
		return true
	}
	if isStylesheetLinkRel(attr(rw.tok, "rel")) {
		rw.rewriteStylesheetHref(a)
		return true
	}
	return false
}

func (rw *tokenRewriter) rewriteIconHref(a xhtml.Attribute) {
	trimmed := strings.TrimSpace(a.Val)
	if target, ok := resolveTargetURL(a.Val, rw.opt); ok {
		a.Val = "data:application/x-zeroproxy-icon,1"
		rw.dataTarget = target
	} else {
		a.Val = "data:application/x-zeroproxy-icon,1"
		if trimmed != "" {
			rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
		}
	}
	rw.attrs = append(rw.attrs, a)
}

func (rw *tokenRewriter) rewriteStylesheetHref(a xhtml.Attribute) {
	trimmed := strings.TrimSpace(a.Val)
	if wrapped, target, ok := wrapFetchURL(a.Val, rw.opt); ok {
		a.Val = wrapped
		rw.dataTarget = target
	} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
		a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
		rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
	}
	rw.attrs = append(rw.attrs, a)
}

// handleSubresourceAttr rewrites passive subresource URLs and srcset lists.
func (rw *tokenRewriter) handleSubresourceAttr(a xhtml.Attribute, key string) bool {
	if shouldRewriteSrcsetAttr(rw.tag, key) {
		if rewritten, visible, changed := rewriteSrcset(a.Val, rw.opt); changed {
			a.Val = rewritten
			rw.attrs = upsertAttr(rw.attrs, "data-zp-target-srcset", visible)
		}
		rw.attrs = append(rw.attrs, a)
		return true
	}
	if shouldRewritePassiveAttr(rw.tag, key) {
		trimmed := strings.TrimSpace(a.Val)
		if wrapped, target, ok := wrapFetchURL(a.Val, rw.opt); ok {
			a.Val = wrapped
			rw.dataTarget = target
		} else if trimmed != "" && hasDangerousURLScheme(trimmed) {
			a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
			rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
		}
		rw.attrs = append(rw.attrs, a)
		return true
	}
	return false
}

// handleEventHandlerAttr neutralizes inline on* handlers into data-zp-blocked-*.
func (rw *tokenRewriter) handleEventHandlerAttr(a xhtml.Attribute, key string) bool {
	if strings.HasPrefix(key, "on") && len(key) > 2 {
		rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-" + key, Val: a.Val})
		return true
	}
	return false
}

// handleScriptSrcAttr proxies an executable <script src>, blocking unsafe URLs.
// It re-reads executableScriptKind(rw.tok) post-mutation, as the original did.
func (rw *tokenRewriter) handleScriptSrcAttr(a xhtml.Attribute, key string) bool {
	if rw.tag != "script" || key != "src" || executableScriptKind(rw.tok) == "" {
		return false
	}
	trimmed := strings.TrimSpace(a.Val)
	if wrapped, target, ok := wrapScriptURL(a.Val, rw.opt, executableScriptKind(rw.tok)); ok {
		a.Val = wrapped
		rw.dataTarget = target
	} else {
		a.Val = shareurl.ControlPrefix + "error/POLICY_BLOCKED"
		if trimmed != "" {
			rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
		}
	}
	rw.attrs = append(rw.attrs, a)
	return true
}

// handleNavigationAttr rewrites document-navigation URLs (and other rewritable
// attrs), then appends the attribute. This is the loop's fall-through tail.
func (rw *tokenRewriter) handleNavigationAttr(a xhtml.Attribute, key string) {
	if shouldRewriteAttr(rw.tag, key) {
		trimmed := strings.TrimSpace(a.Val)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			rw.attrs = append(rw.attrs, a)
			return
		}
		nav := isDocumentNavigationAttr(rw.tag, key)
		if wrapped, target, ok := wrapAttrURL(a.Val, rw.opt, nav); ok {
			a.Val = wrapped
			rw.dataTarget = target
		} else if nav {
			a.Val = "#"
			rw.attrs = append(rw.attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
		}
	}
	rw.attrs = append(rw.attrs, a)
}

// finish appends the deferred backup/marker attributes in the original order and
// writes attrs back onto the token. The static-script marker re-reads
// attr(rw.tok,"src") post-mutation, preserving the aliasing-driven behavior.
func (rw *tokenRewriter) finish() xhtml.Token {
	if rw.hasIntegrityBackup {
		rw.attrs = upsertAttr(rw.attrs, "data-zp-integrity", rw.integrityBackup)
	}
	if rw.hasNonceBackup {
		rw.attrs = upsertAttr(rw.attrs, "data-zp-target-nonce", rw.nonceBackup)
	}
	if rw.blockedLinkRel != "" {
		rw.attrs = upsertAttr(rw.attrs, "data-zp-blocked-rel", rw.blockedLinkRel)
	}
	if rw.blockedLinkHref != "" {
		rw.attrs = upsertAttr(rw.attrs, "data-zp-blocked-url", rw.blockedLinkHref)
	}
	if rw.dataTarget != "" {
		rw.attrs = upsertAttr(rw.attrs, "data-zp-target-url", rw.dataTarget)
	}
	if rw.tag == "script" && executableScriptKind(rw.tok) != "" {
		rw.attrs = upsertAttr(rw.attrs, "nonce", "zp")
		if attr(rw.tok, "src") == "" {
			rw.attrs = upsertAttr(rw.attrs, "data-zp-static-script", "1")
		}
	}
	rw.tok.Attr = rw.attrs
	return rw.tok
}

func isZPControlAttr(key string) bool {
	switch key {
	case "data-zp-target-url", "data-zp-target-srcset", "data-zp-blocked-url",
		"data-zp-blocked-rel", "data-zp-integrity", "data-zp-target-nonce":
		return true
	}
	return false
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
	switch attrLocalName(key) {
	case "href":
		return tagIn(tag, "link", "image", "use")
	case "src":
		return tagIn(tag, "img", "source", "audio", "video", "track", "input")
	case "poster":
		return tag == "video"
	}
	return false
}

// tagIn reports whether tag matches any of the candidates.
func tagIn(tag string, candidates ...string) bool {
	for _, c := range candidates {
		if tag == c {
			return true
		}
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
		s = trimLeadingHTMLSpace(s)
		if s == "" {
			break
		}
		cand, rest, more := nextSrcsetCandidate(s)
		out = append(out, cand)
		if !more {
			break
		}
		s = rest
	}
	return out
}

// nextSrcsetCandidate parses one candidate from the head of s. It returns the
// candidate, the remainder after the separating comma, and whether more input
// follows (false when this candidate ends the list).
func nextSrcsetCandidate(s string) (cand srcsetCandidate, rest string, more bool) {
	i := srcsetURLEnd(s)
	j := i
	for j < len(s) && s[j] != ',' {
		j++
	}
	cand = srcsetCandidate{
		raw:        strings.TrimSpace(s[:j]),
		url:        s[:i],
		descriptor: strings.TrimSpace(s[i:j]),
	}
	if j >= len(s) {
		return cand, "", false
	}
	return cand, s[j+1:], true
}

// srcsetURLEnd returns the index where the URL portion of a candidate ends. A
// data: URL runs to the next space; any other URL stops at the first space or
// comma.
func srcsetURLEnd(s string) int {
	i := 0
	if strings.HasPrefix(strings.ToLower(s), "data:") {
		for i < len(s) && !isHTMLSpace(s[i]) {
			i++
		}
		return i
	}
	for i < len(s) && !isHTMLSpace(s[i]) && s[i] != ',' {
		i++
	}
	return i
}

// trimLeadingHTMLSpace drops leading HTML whitespace.
func trimLeadingHTMLSpace(s string) string {
	start := 0
	for start < len(s) && isHTMLSpace(s[start]) {
		start++
	}
	return s[start:]
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
		if !isSchemeContinuationChar(c) {
			return "", false
		}
	}
	return "", false
}

// isSchemeContinuationChar reports whether c is valid in a URL scheme after the
// leading letter (RFC 3986 scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
func isSchemeContinuationChar(c byte) bool {
	return isASCIILetter(c) || isASCIIDigit(c) || c == '+' || c == '-' || c == '.'
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
	if imports, ok := doc["imports"].(map[string]any); ok {
		rewriteImportMapAddresses(imports, opt)
	}
	if scopes, ok := doc["scopes"].(map[string]any); ok {
		doc["scopes"] = rewriteImportMapScopes(scopes, opt)
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return `{}`
	}
	return string(b)
}

// rewriteImportMapAddress maps a single import-map specifier address to its
// proxied module script URL, blocking non-http(s) targets.
func rewriteImportMapAddress(raw string, opt Options) string {
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

// rewriteImportMapAddresses rewrites every string-valued address in a specifier
// map in place.
func rewriteImportMapAddresses(addresses map[string]any, opt Options) {
	for k, v := range addresses {
		if s, ok := v.(string); ok {
			addresses[k] = rewriteImportMapAddress(s, opt)
		}
	}
}

// rewriteImportMapScopes rewrites both the scope keys and their nested specifier
// maps, returning a fresh map keyed by the rewritten scope addresses.
func rewriteImportMapScopes(scopes map[string]any, opt Options) map[string]any {
	next := make(map[string]any, len(scopes))
	for scope, rawEntries := range scopes {
		scopeKey := rewriteImportMapAddress(scope, opt)
		entries, _ := rawEntries.(map[string]any)
		out := make(map[string]any, len(entries))
		for k, v := range entries {
			if s, ok := v.(string); ok {
				out[k] = rewriteImportMapAddress(s, opt)
			}
		}
		next[scopeKey] = out
	}
	return next
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

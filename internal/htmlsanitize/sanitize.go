package htmlsanitize

import (
	"fmt"
	"io"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

type state struct {
	docID        string
	targetURL    string
	finalURL     string
	base         *url.URL
	faviconMode  string
	seq          int
	nextNode     int
	nextResource int
	records      []Record
}

func SanitizeDocument(input Input) (Output, error) {
	state, err := stateFromInput(input)
	if err != nil {
		return Output{}, err
	}
	state.add("document.start", map[string]any{
		"targetUrl": input.TargetURL,
		"finalUrl":  state.finalURL,
		"charset":   input.Charset,
	})
	state.processLinkHeaders(input.Headers)
	root, err := html.Parse(strings.NewReader(input.HTML))
	if err != nil {
		return Output{}, fmt.Errorf("HTML_PARSE_FAILED: %w", err)
	}
	state.walk(root, "")
	state.add("document.end", nil)
	return Output{V: schemaVersion, DocID: state.docID, TargetURL: input.TargetURL, FinalURL: state.finalURL, Records: state.records}, nil
}

func newState(input Input) *state {
	finalURL := strings.TrimSpace(input.FinalURL)
	if finalURL == "" {
		finalURL = strings.TrimSpace(input.TargetURL)
	}
	base, _ := url.Parse(finalURL)
	return &state{
		docID:       nonEmpty(input.DocID, "doc-1"),
		targetURL:   input.TargetURL,
		finalURL:    finalURL,
		base:        base,
		faviconMode: nonEmpty(input.FaviconMode, "block"),
		records:     []Record{},
	}
}

func stateFromInput(input Input) (*state, error) {
	state := newState(input)
	if state.finalURL == "" {
		return nil, fmt.Errorf("missing final URL")
	}
	if state.base == nil || state.base.Scheme == "" {
		return nil, fmt.Errorf("invalid final URL")
	}
	return state, nil
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func (s *state) walk(node *html.Node, parentID string) {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		s.walkOne(child, parentID)
	}
}

func (s *state) walkOne(node *html.Node, parentID string) {
	switch node.Type {
	case html.ElementNode:
		s.walkElement(node, parentID)
	case html.TextNode:
		s.text(parentID, node.Data)
	case html.CommentNode:
		s.add("node.comment", map[string]any{"parentNodeId": parentID, "text": node.Data})
	}
}

func (s *state) walkElement(node *html.Node, parentID string) {
	tag := strings.ToLower(node.Data)
	if s.blockWholeElement(tag, node) {
		return
	}
	nodeID := s.nodeID()
	s.add("node.create", map[string]any{"nodeId": nodeID, "parentNodeId": parentID, "tag": tag})
	if s.handleSpecialElement(node, nodeID, tag) {
		return
	}
	s.handleAttrs(node.Attr, nodeID, tag)
	s.walk(node, nodeID)
}

func (s *state) blockWholeElement(tag string, node *html.Node) bool {
	if tag != "object" && tag != "embed" {
		return false
	}
	s.blockResource(resourceKindFor(tag, "src"), tag, "src", attrValue(node.Attr, "src"), "BLOCKED_ELEMENT", "")
	return true
}

func (s *state) handleSpecialElement(node *html.Node, nodeID, tag string) bool {
	switch tag {
	case "base":
		s.handleBase(node, nodeID)
		return true
	case "link":
		return s.handleLink(node, nodeID)
	case "script":
		s.handleScript(node, nodeID)
		return true
	case "style":
		s.handleStyle(node, nodeID)
		return true
	case "meta":
		return s.handleMeta(node, nodeID)
	default:
		return false
	}
}

func (s *state) handleBase(node *html.Node, nodeID string) {
	href := attrValue(node.Attr, "href")
	if target, ok := resolveHTTP(s.base, href); ok {
		s.base = target
		s.add("document.base", map[string]any{"nodeId": nodeID, "resolvedTargetUrl": target.String()})
	}
}

func (s *state) handleMeta(node *html.Node, nodeID string) bool {
	httpEquiv := strings.ToLower(strings.TrimSpace(attrValue(node.Attr, "http-equiv")))
	if httpEquiv == "refresh" || httpEquiv == "content-security-policy" || httpEquiv == "content-security-policy-report-only" {
		s.add("node.remove", map[string]any{"nodeId": nodeID, "tag": "meta", "reason": "META_POLICY_BLOCKED"})
		return true
	}
	s.handleAttrs(node.Attr, nodeID, "meta")
	return false
}

func (s *state) handleLink(node *html.Node, nodeID string) bool {
	rel := attrValue(node.Attr, "rel")
	href := attrValue(node.Attr, "href")
	s.copySafeAttrsExcept(node.Attr, nodeID, "link", "href")
	if isBlockedRel(rel) {
		s.blockResource("link", "link", "href", href, "BLOCKED_REL", nodeID)
		return true
	}
	if isIconRel(rel) {
		s.handleFavicon(href, nodeID)
		return true
	}
	if isStylesheetRel(rel) {
		s.discoverLinkedStyle(href, nodeID)
	}
	return true
}

func (s *state) handleScript(node *html.Node, nodeID string) {
	scriptType := strings.ToLower(strings.TrimSpace(attrValue(node.Attr, "type")))
	src := attrValue(node.Attr, "src")
	kind := scriptKind(scriptType)
	s.copySafeAttrsExcept(node.Attr, nodeID, "script", "src")
	if kind == "pass" {
		s.blockResource("script", "script", "type", scriptType, "UNSUPPORTED_SCRIPT_TYPE", nodeID)
		return
	}
	if src != "" {
		s.externalScript(kind, src, nodeID)
		return
	}
	s.add(kind+".inline", map[string]any{"nodeId": nodeID, "source": textContent(node), "filename": s.finalURL})
}

func (s *state) handleStyle(node *html.Node, nodeID string) {
	cssText := s.rewriteCSS(textContent(node), "style", "text", nodeID)
	s.add("style.inline", map[string]any{"nodeId": nodeID, "css": cssText})
	s.text(nodeID, cssText)
}

func (s *state) handleFavicon(href, nodeID string) {
	if strings.EqualFold(s.faviconMode, "fetch") {
		resourceID := s.discover("favicon", "link", "href", href, "blob", "backend", nodeID)
		s.add("favicon.decision", map[string]any{"nodeId": nodeID, "mode": "fetch", "resourceId": resourceID})
		return
	}
	s.blockResource("favicon", "link", "href", href, "FAVICON_BLOCKED", nodeID)
	s.add("favicon.decision", map[string]any{"nodeId": nodeID, "mode": "block"})
}

func (s *state) discoverLinkedStyle(href, nodeID string) {
	resourceID := s.discover("style", "link", "href", href, "blob", "backend", nodeID)
	if resourceID == "" {
		return
	}
	s.attr(nodeID, "href", internalResourceURL(resourceID))
	s.add("style.external", map[string]any{"nodeId": nodeID, "resourceId": resourceID})
}

func (s *state) externalScript(kind, src, nodeID string) {
	resourceKind := "script"
	recordType := "script.external"
	if kind == "module" {
		resourceKind = "module"
		recordType = "module.external"
	}
	resourceID := s.discover(resourceKind, "script", "src", src, "internal", "backend", nodeID)
	if resourceID != "" {
		s.add(recordType, map[string]any{"nodeId": nodeID, "resourceId": resourceID})
	}
}

func scriptKind(scriptType string) string {
	switch scriptType {
	case "", "text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript":
		return "script"
	case "module":
		return "module"
	default:
		return "pass"
	}
}

func textContent(node *html.Node) string {
	var out strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.TextNode {
			_, _ = io.WriteString(&out, child.Data)
		}
	}
	return out.String()
}

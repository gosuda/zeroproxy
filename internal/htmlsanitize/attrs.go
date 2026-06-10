package htmlsanitize

import (
	"strings"

	"golang.org/x/net/html"
)

func (s *state) handleAttrs(attrs []html.Attribute, nodeID, tag string) {
	for _, attr := range attrs {
		s.handleAttr(attr, nodeID, tag)
	}
}

func (s *state) copySafeAttrsExcept(attrs []html.Attribute, nodeID, tag, excluded string) {
	for _, attr := range attrs {
		if attrLocalName(attr.Key) != excluded {
			s.handleAttr(attr, nodeID, tag)
		}
	}
}

func (s *state) handleAttr(attr html.Attribute, nodeID, tag string) {
	name := strings.ToLower(attr.Key)
	local := attrLocalName(name)
	if isEventHandler(local) {
		s.add("event.inlineHandler", map[string]any{"nodeId": nodeID, "event": local[2:], "source": attr.Val})
		return
	}
	s.dispatchAttr(tag, nodeID, name, local, attr.Val)
}

func (s *state) dispatchAttr(tag, nodeID, name, local, value string) {
	switch attrPolicy(tag, local) {
	case "style":
		s.attr(nodeID, name, s.rewriteCSS(value, tag, name, nodeID))
	case "navigation":
		s.navigationAttr(tag, nodeID, name, value)
	case "frame":
		s.frameAttr(tag, nodeID, name, value)
	case "passive":
		s.passiveAttr(tag, nodeID, name, value)
	case "srcset":
		s.srcsetAttr(tag, nodeID, name, value)
	case "blocked-url":
		s.blockResource(resourceKindFor(tag, name), tag, name, value, "URL_ATTRIBUTE_BLOCKED", nodeID)
	default:
		s.attr(nodeID, name, value)
	}
}

func attrPolicy(tag, local string) string {
	switch local {
	case "style":
		return "style"
	case "srcset":
		return srcsetPolicy(tag)
	case "href":
		return hrefPolicy(tag)
	case "action":
		return formActionPolicy(tag)
	case "formaction":
		return formActionPolicy(tag)
	case "src":
		return srcPolicy(tag)
	case "poster":
		return posterPolicy(tag)
	default:
		return fallbackAttrPolicy(local)
	}
}

func srcsetPolicy(tag string) string {
	if tag == "img" || tag == "source" {
		return "srcset"
	}
	return fallbackAttrPolicy("srcset")
}

func hrefPolicy(tag string) string {
	if tag == "a" || tag == "area" {
		return "navigation"
	}
	if tag == "link" || tag == "image" || tag == "use" {
		return "passive"
	}
	return fallbackAttrPolicy("href")
}

func formActionPolicy(tag string) string {
	if tag == "form" || tag == "input" || tag == "button" {
		return "navigation"
	}
	return fallbackAttrPolicy("action")
}

func srcPolicy(tag string) string {
	if tag == "iframe" || tag == "frame" {
		return "frame"
	}
	if tagIn(tag, "img", "source", "audio", "video", "track", "input") {
		return "passive"
	}
	return fallbackAttrPolicy("src")
}

func posterPolicy(tag string) string {
	if tag == "video" {
		return "passive"
	}
	return fallbackAttrPolicy("poster")
}

func fallbackAttrPolicy(local string) string {
	if denyURLAttr(local) {
		return "blocked-url"
	}
	return "pass"
}

func denyURLAttr(local string) bool {
	switch local {
	case "href", "src", "action", "formaction", "poster", "data", "manifest", "xlink:href":
		return true
	default:
		return false
	}
}

func isEventHandler(local string) bool {
	return strings.HasPrefix(local, "on") && len(local) > 2
}

func (s *state) navigationAttr(tag, nodeID, name, value string) {
	kind := "navigation.link"
	if tag == "form" || name == "formaction" {
		kind = "navigation.form"
	}
	target, ok := resolveNavigationHTTP(s.base, value)
	if !ok {
		s.blockResource(tag, tag, name, value, "POLICY_BLOCKED", nodeID)
		return
	}
	resourceID := s.resource(tag, tag, name, value, target, "virtual-navigation", "none", nodeID)
	s.attr(nodeID, name, safeNavigationURL(resourceID))
	s.add(kind, map[string]any{"nodeId": nodeID, "resourceId": resourceID})
}

func (s *state) frameAttr(tag, nodeID, name, value string) {
	resourceID := s.discover("iframe", tag, name, value, "virtual-navigation", "backend", nodeID)
	if resourceID == "" {
		return
	}
	s.attr(nodeID, name, safeFrameURL(resourceID))
	s.add("frame.virtualDocument", map[string]any{"nodeId": nodeID, "resourceId": resourceID})
}

func (s *state) passiveAttr(tag, nodeID, name, value string) {
	resourceID := s.discover(resourceKindFor(tag, name), tag, name, value, "blob", "backend", nodeID)
	if resourceID != "" {
		s.attr(nodeID, name, internalResourceURL(resourceID))
	}
}

func (s *state) srcsetAttr(tag, nodeID, name, value string) {
	candidates := parseSrcset(value)
	if len(candidates) == 0 {
		s.blockResource("image", tag, name, value, "SRCSET_PARSE_FAILED", nodeID)
		return
	}
	safeCandidates := s.rewriteSrcsetCandidates(candidates, tag, nodeID, name)
	if len(safeCandidates) > 0 {
		s.attr(nodeID, name, strings.Join(safeCandidates, ", "))
	}
}

func (s *state) rewriteSrcsetCandidates(candidates []srcsetCandidate, tag, nodeID, name string) []string {
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		resourceID := s.discover("image", tag, name, candidate.URL, "blob", "backend", nodeID)
		if resourceID == "" {
			continue
		}
		out = append(out, joinSrcsetCandidate(internalResourceURL(resourceID), candidate.Descriptor))
	}
	return out
}

func attrValue(attrs []html.Attribute, key string) string {
	for _, attr := range attrs {
		if strings.EqualFold(attrLocalName(attr.Key), key) {
			return attr.Val
		}
	}
	return ""
}

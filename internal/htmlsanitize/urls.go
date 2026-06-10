package htmlsanitize

import (
	"net/url"
	"strings"
)

func resolveHTTP(base *url.URL, raw string) (*url.URL, bool) {
	trimmed := strings.TrimSpace(raw)
	if blockedURLText(trimmed) {
		return nil, false
	}
	rel, err := url.Parse(trimmed)
	if err != nil {
		return nil, false
	}
	resolved := rel
	if base != nil {
		resolved = base.ResolveReference(rel)
	}
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return nil, false
	}
	return resolved, true
}

func resolveNavigationHTTP(base *url.URL, raw string) (*url.URL, bool) {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "#") {
		rel, err := url.Parse(trimmed)
		if err != nil {
			return nil, false
		}
		resolved := rel
		if base != nil {
			resolved = base.ResolveReference(rel)
		}
		if resolved.Scheme != "http" && resolved.Scheme != "https" {
			return nil, false
		}
		return resolved, true
	}
	return resolveHTTP(base, raw)
}

func blockedURLText(trimmed string) bool {
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return true
	}
	if !hasScheme(trimmed) {
		return false
	}
	scheme := strings.ToLower(strings.SplitN(trimmed, ":", 2)[0])
	return scheme == "javascript" || scheme == "data" || scheme == "vbscript" || scheme == "blob" || scheme == "about"
}

func hasScheme(value string) bool {
	if value == "" || !isSchemeStart(value[0]) {
		return false
	}
	for i := 1; i < len(value); i++ {
		c := value[i]
		if c == ':' {
			return true
		}
		if !isSchemeChar(c) {
			return false
		}
	}
	return false
}

func isSchemeStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isSchemeChar(c byte) bool {
	return isSchemeStart(c) || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'
}

func attrLocalName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if _, local, ok := strings.Cut(name, ":"); ok {
		return local
	}
	return name
}

func internalResourceURL(resourceID string) string {
	return "zp-internal://resource/" + resourceID
}

func safeNavigationURL(resourceID string) string {
	return "about:blank#zp-nav-" + resourceID
}

func safeFrameURL(resourceID string) string {
	return "about:blank#zp-frame-" + resourceID
}

var resourceKindByTag = map[string]string{
	"script":  "script",
	"link":    "style",
	"img":     "image",
	"picture": "image",
	"audio":   "media",
	"video":   "media",
	"track":   "track",
	"iframe":  "iframe",
	"frame":   "iframe",
	"object":  "object",
	"embed":   "embed",
}

func resourceKindFor(tag, attr string) string {
	tag = strings.ToLower(tag)
	attr = attrLocalName(attr)
	if tag == "source" {
		return sourceResourceKind(attr)
	}
	if tag == "image" || tag == "use" {
		return svgResourceKind(attr)
	}
	if kind, ok := resourceKindByTag[tag]; ok {
		return kind
	}
	return "resource"
}

func sourceResourceKind(attr string) string {
	if attr == "src" || attr == "srcset" {
		return "image"
	}
	return "resource"
}

func svgResourceKind(attr string) string {
	if attr == "href" {
		return "svg"
	}
	return "resource"
}

func tagIn(tag string, values ...string) bool {
	for _, value := range values {
		if tag == value {
			return true
		}
	}
	return false
}

func isBlockedRel(rel string) bool {
	for _, token := range relTokens(rel) {
		if blockedRelToken(token) {
			return true
		}
	}
	return false
}

func isIconRel(rel string) bool {
	for _, token := range relTokens(rel) {
		if token == "icon" || token == "mask-icon" || token == "apple-touch-icon" || token == "apple-touch-icon-precomposed" || token == "apple-touch-startup-image" || token == "fluid-icon" {
			return true
		}
	}
	return false
}

func isStylesheetRel(rel string) bool {
	for _, token := range relTokens(rel) {
		if token == "stylesheet" {
			return true
		}
	}
	return false
}

func blockedRelToken(token string) bool {
	return token == "modulepreload" || token == "preload" || token == "prefetch" || token == "preconnect" || token == "dns-prefetch" || token == "prerender" || token == "manifest"
}

func relTokens(rel string) []string {
	fields := strings.FieldsFunc(rel, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' })
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if token := strings.ToLower(strings.TrimSpace(field)); token != "" {
			out = append(out, token)
		}
	}
	return out
}

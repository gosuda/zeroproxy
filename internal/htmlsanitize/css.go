package htmlsanitize

import (
	"fmt"
	"net/url"

	"github.com/gosuda/zeroproxy/internal/cssrewrite"
)

func SanitizeCSS(input CSSInput) (CSSOutput, error) {
	base, err := url.Parse(input.BaseURL)
	if err != nil {
		return CSSOutput{}, fmt.Errorf("invalid CSS base URL: %w", err)
	}
	state := newState(Input{DocID: input.DocID, FinalURL: base.String()})
	state.base = base
	cssText := state.rewriteCSS(input.CSS, input.Kind, "style", "")
	state.add("document.end", nil)
	return CSSOutput{V: schemaVersion, DocID: state.docID, BaseURL: base.String(), CSS: cssText, Records: state.records}, nil
}

func (s *state) rewriteCSS(source, element, attribute, nodeID string) string {
	out, err := cssrewrite.RewriteWithMapper(source, s.base.String(), func(raw string, target *url.URL) string {
		resourceID := s.resource("css-url", element, attribute, raw, target, "internal", "backend", nodeID)
		return internalResourceURL(resourceID)
	})
	if err != nil {
		s.add("resource.blocked", map[string]any{
			"kind":        "css-url",
			"element":     element,
			"attribute":   attribute,
			"reason":      "CSS_PARSE_FAILED",
			"diagnostics": []string{err.Error()},
		})
		return ""
	}
	return out
}

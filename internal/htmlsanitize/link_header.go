package htmlsanitize

import "strings"

func (s *state) processLinkHeaders(headers map[string][]string) {
	for name, values := range headers {
		if strings.EqualFold(name, "Link") {
			s.processLinkHeaderValues(values)
		}
	}
}

func (s *state) processLinkHeaderValues(values []string) {
	for _, value := range values {
		for _, entry := range splitLinkHeader(value) {
			s.processLinkHeaderEntry(entry)
		}
	}
}

func (s *state) processLinkHeaderEntry(entry string) {
	target, rel := linkHeaderTargetRel(entry)
	if target == "" || !isBlockedRel(rel) {
		return
	}
	s.blockResource("link-header", "http", "Link", target, "BLOCKED_LINK_HEADER_REL", "")
}

func splitLinkHeader(value string) []string {
	parts := []string{}
	start := 0
	inAngle := false
	inQuote := false
	for idx, ch := range value {
		switch ch {
		case '<':
			if !inQuote {
				inAngle = true
			}
		case '>':
			if !inQuote {
				inAngle = false
			}
		case '"':
			inQuote = !inQuote
		case ',':
			if !inAngle && !inQuote {
				parts = append(parts, strings.TrimSpace(value[start:idx]))
				start = idx + 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(value[start:]))
	return parts
}

func linkHeaderTargetRel(entry string) (string, string) {
	target := ""
	rel := ""
	for idx, part := range strings.Split(entry, ";") {
		part = strings.TrimSpace(part)
		if idx == 0 && strings.HasPrefix(part, "<") && strings.Contains(part, ">") {
			target = strings.TrimSuffix(strings.TrimPrefix(part, "<"), ">")
			continue
		}
		if key, value, ok := strings.Cut(part, "="); ok && strings.EqualFold(strings.TrimSpace(key), "rel") {
			rel = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	return target, rel
}

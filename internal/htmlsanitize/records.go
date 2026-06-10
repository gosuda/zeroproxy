package htmlsanitize

import "net/url"

func (s *state) add(recordType string, fields map[string]any) {
	s.seq++
	record := Record{"v": schemaVersion, "type": recordType, "docId": s.docID, "seq": s.seq}
	for key, value := range fields {
		record[key] = value
	}
	s.records = append(s.records, record)
}

func (s *state) nodeID() string {
	s.nextNode++
	return "n" + itoa(s.nextNode)
}

func (s *state) resourceID() string {
	s.nextResource++
	return "r" + itoa(s.nextResource)
}

func (s *state) attr(nodeID, name, value string) {
	s.add("node.attr", map[string]any{"nodeId": nodeID, "name": name, "value": value})
}

func (s *state) text(parentID, text string) {
	if text == "" {
		return
	}
	s.add("node.text", map[string]any{"parentNodeId": parentID, "text": text})
}

func (s *state) discover(kind, element, attribute, rawURL, renderPolicy, fetchPolicy, nodeID string) string {
	target, ok := resolveHTTP(s.base, rawURL)
	if !ok {
		s.blockResource(kind, element, attribute, rawURL, "POLICY_BLOCKED", nodeID)
		return ""
	}
	return s.resource(kind, element, attribute, rawURL, target, renderPolicy, fetchPolicy, nodeID)
}

func (s *state) resource(kind, element, attribute, rawURL string, target *url.URL, renderPolicy, fetchPolicy, nodeID string) string {
	resourceID := s.resourceID()
	s.add("resource.discovered", map[string]any{
		"resourceId":        resourceID,
		"kind":              kind,
		"attribute":         attribute,
		"element":           element,
		"rawValue":          rawURL,
		"resolvedTargetUrl": target.String(),
		"baseUrl":           s.base.String(),
		"initiatorNodeId":   nodeID,
		"fetchPolicy":       fetchPolicy,
		"renderPolicy":      renderPolicy,
		"safeUrl":           internalResourceURL(resourceID),
		"diagnostics":       []string{"target URL kept out of renderer attributes"},
	})
	return resourceID
}

func (s *state) blockResource(kind, element, attribute, rawURL, reason, nodeID string) {
	s.add("resource.blocked", map[string]any{
		"kind":            kind,
		"attribute":       attribute,
		"element":         element,
		"rawValue":        rawURL,
		"initiatorNodeId": nodeID,
		"reason":          reason,
		"renderPolicy":    "block",
		"diagnostics":     []string{reason},
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

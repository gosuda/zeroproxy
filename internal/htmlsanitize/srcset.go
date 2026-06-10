package htmlsanitize

import "strings"

type srcsetCandidate struct {
	Raw        string
	URL        string
	Descriptor string
}

func parseSrcset(raw string) []srcsetCandidate {
	rest := strings.TrimSpace(raw)
	out := []srcsetCandidate{}
	for rest != "" {
		candidate, next, more := nextSrcsetCandidate(rest)
		if candidate.Raw != "" {
			out = append(out, candidate)
		}
		if !more {
			break
		}
		rest = trimHTMLSpace(next)
	}
	return out
}

func nextSrcsetCandidate(input string) (srcsetCandidate, string, bool) {
	urlEnd := srcsetURLEnd(input)
	candidateEnd := srcsetCandidateEnd(input, urlEnd)
	candidate := srcsetCandidate{
		Raw:        strings.TrimSpace(input[:candidateEnd]),
		URL:        strings.TrimSpace(input[:urlEnd]),
		Descriptor: strings.TrimSpace(input[urlEnd:candidateEnd]),
	}
	if candidateEnd >= len(input) {
		return candidate, "", false
	}
	return candidate, input[candidateEnd+1:], true
}

func srcsetCandidateEnd(input string, urlEnd int) int {
	candidateEnd := len(input)
	for offset, ch := range input[urlEnd:] {
		if ch == ',' {
			return urlEnd + offset
		}
	}
	return candidateEnd
}

func srcsetURLEnd(input string) int {
	if strings.HasPrefix(strings.ToLower(input), "data:") {
		return dataURLSrcsetEnd(input)
	}
	for idx, ch := range input {
		if isHTMLSpace(ch) || ch == ',' {
			return idx
		}
	}
	return len(input)
}

func dataURLSrcsetEnd(input string) int {
	for idx, ch := range input {
		if isHTMLSpace(ch) {
			return idx
		}
	}
	return len(input)
}

func trimHTMLSpace(input string) string {
	return strings.TrimLeftFunc(input, isHTMLSpace)
}

func isHTMLSpace(ch rune) bool {
	return ch == ' ' || ch == '\n' || ch == '\t' || ch == '\r' || ch == '\f'
}

func joinSrcsetCandidate(urlPart, descriptor string) string {
	descriptor = strings.TrimSpace(descriptor)
	if descriptor == "" {
		return urlPart
	}
	return urlPart + " " + descriptor
}

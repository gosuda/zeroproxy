package cssrewrite

import (
	"bytes"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
)

type Replacement struct {
	Start int
	End   int
	Text  string
}

type URLMapper func(raw string, target *url.URL) string

func Rewrite(source, baseURL, controlPrefix string) (string, error) {
	return RewriteWithMapper(source, baseURL, func(_ string, target *url.URL) string {
		return target.String()
	})
}

func RewriteWithMapper(source, baseURL string, mapper URLMapper) (string, error) {
	if err := validate(source); err != nil {
		return "", fmt.Errorf("CSS_PARSE_FAILED: %w", err)
	}
	replacements := CollectReplacementsWithMapper(source, baseURL, mapper)
	return ApplyReplacements(source, replacements), nil
}

func CollectReplacements(source, baseURL, controlPrefix string) []Replacement {
	return CollectReplacementsWithMapper(source, baseURL, func(_ string, target *url.URL) string {
		return target.String()
	})
}

func CollectReplacementsWithMapper(source, baseURL string, mapper URLMapper) []Replacement {
	lexer := css.NewLexer(parse.NewInputString(source))
	state := collectState{importDepth: -1}
	for {
		tt, raw := lexer.Next()
		if tt == css.ErrorToken {
			break
		}
		state.handleToken(source, baseURL, mapper, tt, raw)
	}
	return state.replacements
}

type collectState struct {
	pos          int
	depth        int
	importDepth  int
	replacements []Replacement
}

func (s *collectState) handleToken(source, baseURL string, mapper URLMapper, tt css.TokenType, raw []byte) {
	start := s.pos
	s.pos += len(raw)
	if s.endImport(tt) {
		s.importDepth = -1
	}
	if isImportToken(tt, raw) {
		s.importDepth = s.depth
		return
	}
	s.updateDepth(tt)
	s.addTokenReplacement(source, baseURL, mapper, tt, raw, start, s.pos)
}

func (s *collectState) endImport(tt css.TokenType) bool {
	return s.importDepth == s.depth && endsImport(tt)
}

func (s *collectState) updateDepth(tt css.TokenType) {
	if isOpenBracket(tt) {
		s.depth++
	} else if s.depth > 0 && isCloseBracket(tt) {
		s.depth--
	}
}

func (s *collectState) addTokenReplacement(source, baseURL string, mapper URLMapper, tt css.TokenType, raw []byte, start, end int) {
	if tt == css.URLToken {
		addURLReplacement(&s.replacements, start, end, tokenURL(raw), baseURL, mapper, true)
		return
	}
	if tt == css.StringToken && s.importDepth == s.depth {
		addURLReplacement(&s.replacements, start, end, tokenString(raw), baseURL, mapper, false)
	}
	_ = source
}

func isImportToken(tt css.TokenType, raw []byte) bool {
	return tt == css.AtKeywordToken && strings.EqualFold(string(raw), "@import")
}

func isOpenBracket(tt css.TokenType) bool {
	return tt == css.LeftBraceToken || tt == css.LeftBracketToken || tt == css.LeftParenthesisToken
}

func isCloseBracket(tt css.TokenType) bool {
	return tt == css.RightBraceToken || tt == css.RightBracketToken || tt == css.RightParenthesisToken
}

func ApplyReplacements(source string, replacements []Replacement) string {
	if len(replacements) == 0 {
		return source
	}
	out := strings.Builder{}
	out.Grow(len(source))
	pos := 0
	for _, r := range replacements {
		if r.Start < pos || r.Start > r.End || r.End > len(source) {
			continue
		}
		out.WriteString(source[pos:r.Start])
		out.WriteString(r.Text)
		pos = r.End
	}
	out.WriteString(source[pos:])
	return out.String()
}

func validate(source string) error {
	if err := lexCSS(source); err != nil {
		return err
	}
	if parseCSS(source, false) == nil {
		return nil
	}
	return parseCSS(source, true)
}

func lexCSS(source string) error {
	lexer := css.NewLexer(parse.NewInput(bytes.NewBufferString(source)))
	for {
		tt, _ := lexer.Next()
		switch tt {
		case css.ErrorToken:
			if err := lexer.Err(); err != nil && err != io.EOF {
				return err
			}
			return nil
		case css.BadStringToken, css.BadURLToken:
			return fmt.Errorf("bad %s token", tt)
		}
	}
}

func parseCSS(source string, inline bool) error {
	parser := css.NewParser(parse.NewInput(bytes.NewBufferString(source)), inline)
	for {
		gt, _, _ := parser.Next()
		if gt == css.ErrorGrammar {
			if err := parser.Err(); err != nil && err != io.EOF {
				return err
			}
			return nil
		}
	}
}

func endsImport(tt css.TokenType) bool {
	return tt == css.SemicolonToken || tt == css.LeftBraceToken || tt == css.RightBraceToken
}

func addURLReplacement(replacements *[]Replacement, start, end int, raw, baseURL string, mapper URLMapper, wrapURL bool) {
	next := mappedURL(raw, baseURL, mapper)
	if next == "" {
		return
	}
	text := quote(next)
	if wrapURL {
		text = "url(" + text + ")"
	}
	*replacements = append(*replacements, Replacement{Start: start, End: end, Text: text})
}

func tokenURL(raw []byte) string {
	text := strings.TrimSpace(string(raw))
	if len(text) < 5 || !strings.HasSuffix(text, ")") {
		return ""
	}
	inner := strings.TrimSpace(text[4 : len(text)-1])
	return stripCSSQuotes(inner)
}

func tokenString(raw []byte) string {
	return stripCSSQuotes(string(raw))
}

func stripCSSQuotes(text string) string {
	if len(text) >= 2 {
		first := text[0]
		last := text[len(text)-1]
		if (first == '\'' || first == '"') && first == last {
			return text[1 : len(text)-1]
		}
	}
	return text
}

func mappedURL(raw, baseURL string, mapper URLMapper) string {
	trimmed := strings.TrimSpace(raw)
	if mapper == nil || isBlockedURLText(trimmed) {
		return ""
	}
	target := resolveHTTPURL(trimmed, baseURL)
	if target == nil {
		return ""
	}
	return mapper(trimmed, target)
}

func isBlockedURLText(trimmed string) bool {
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.Contains(trimmed, "var(") {
		return true
	}
	lower := strings.ToLower(trimmed)
	return hasBlockedScheme(lower)
}

func hasBlockedScheme(lower string) bool {
	for _, prefix := range []string{"data:", "blob:", "about:", "javascript:", "vbscript:"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func resolveHTTPURL(raw, baseURL string) *url.URL {
	resolved, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil
	}
	target := base.ResolveReference(resolved)
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil
	}
	return target
}

func quote(value string) string {
	var b strings.Builder
	b.Grow(len(value) + 2)
	b.WriteByte('"')
	for i := 0; i < len(value); i++ {
		if value[i] == '"' || value[i] == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(value[i])
	}
	b.WriteByte('"')
	return b.String()
}

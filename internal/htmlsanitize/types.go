package htmlsanitize

const schemaVersion = 1

// Input is the complete document sanitizer input. It carries raw target text and
// response metadata; renderer records are emitted only after URL-bearing state is
// replaced with internal references.
type Input struct {
	DocID         string
	TargetURL     string
	FinalURL      string
	HTML          string
	Charset       string
	ControlPrefix string
	FaviconMode   string
	Headers       map[string][]string
}

type CSSInput struct {
	DocID   string
	BaseURL string
	CSS     string
	Kind    string
}

type Output struct {
	V         int      `json:"v"`
	DocID     string   `json:"docId"`
	TargetURL string   `json:"targetUrl"`
	FinalURL  string   `json:"finalUrl"`
	Records   []Record `json:"records"`
}

type CSSOutput struct {
	V       int      `json:"v"`
	DocID   string   `json:"docId"`
	BaseURL string   `json:"baseUrl"`
	CSS     string   `json:"css"`
	Records []Record `json:"records"`
}

type Record map[string]any

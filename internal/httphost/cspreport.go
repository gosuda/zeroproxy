package httphost

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
)

// cspReportMaxBody bounds the size of incoming CSP violation report payloads.
//
// Proxied documents run under a narrow CSP (such as `img-src 'self' blob: data:`).
// Unrewritten URLs blocked by the browser never reach the Service Worker and
// therefore do not appear in `__zp_refusals()`. Browser CSP violation reports
// carry the offending `blocked-uri`, `source-file`, and `line-number` via the
// HTTP response header's `report-uri` directive without being gated by
// `connect-src`. Reports are logged server-side only without exposing a read
// endpoint to the page.
const cspReportMaxBody = 64 << 10

type cspReportEnvelope struct {
	Report struct {
		DocumentURI        string `json:"document-uri"`
		Referrer           string `json:"referrer"`
		BlockedURI         string `json:"blocked-uri"`
		EffectiveDirective string `json:"effective-directive"`
		ViolatedDirective  string `json:"violated-directive"`
		SourceFile         string `json:"source-file"`
		LineNumber         int    `json:"line-number"`
		ColumnNumber       int    `json:"column-number"`
	} `json:"csp-report"`
}

func (s *server) handleCSPReport(w http.ResponseWriter, r *http.Request) {
	// Always respond with 204 No Content so pages cannot observe report handling outcomes.
	defer w.WriteHeader(http.StatusNoContent)
	if r.Method != http.MethodPost {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, cspReportMaxBody))
	if err != nil || len(body) == 0 {
		return
	}
	var env cspReportEnvelope
	if json.Unmarshal(body, &env) != nil {
		return
	}
	rep := env.Report
	directive := rep.EffectiveDirective
	if directive == "" {
		directive = rep.ViolatedDirective
	}
	if rep.BlockedURI == "" && directive == "" {
		return
	}
	// Strip query and fragment components from the document URI so share-url secrets are not logged.
	doc := rep.DocumentURI
	if i := strings.IndexAny(doc, "?#"); i >= 0 {
		doc = doc[:i]
	}
	src := rep.SourceFile
	if src == "" {
		src = "-"
	}
	log.Printf("[CSP] blocked=%q directive=%s doc=%s src=%s:%d:%d",
		rep.BlockedURI, directive, doc, src, rep.LineNumber, rep.ColumnNumber)
}

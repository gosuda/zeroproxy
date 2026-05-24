package swhttp

import (
	"bytes"
	"net/http"
)

// ResponseRecorder is a small server-style ResponseWriter used by runtime API
// handlers that run inside the WASM kernel before they are converted to a JS
// Response. It does not perform target egress.
type ResponseRecorder struct {
	HeaderMap http.Header
	Status    int
	Body      bytes.Buffer
}

func NewResponseRecorder() *ResponseRecorder {
	return &ResponseRecorder{HeaderMap: make(http.Header), Status: http.StatusOK}
}
func (w *ResponseRecorder) Header() http.Header { return w.HeaderMap }
func (w *ResponseRecorder) WriteHeader(status int) {
	if w.Status == http.StatusOK {
		w.Status = status
	}
}
func (w *ResponseRecorder) Write(p []byte) (int, error) { return w.Body.Write(p) }
func (w *ResponseRecorder) Response() *http.Response {
	return &http.Response{StatusCode: w.Status, Status: http.StatusText(w.Status), Header: w.HeaderMap, Body: ioNopCloser{bytes.NewReader(w.Body.Bytes())}, ContentLength: int64(w.Body.Len())}
}

type ioNopCloser struct{ *bytes.Reader }

func (c ioNopCloser) Close() error { return nil }

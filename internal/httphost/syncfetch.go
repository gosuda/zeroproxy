package httphost

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	errNoSyncID       = errors.New("sync: missing result id")
	errQueueFull      = errors.New("sync: queue full")
	errDuplicateJobID = errors.New("duplicate job id")
)

// Synchronous XHR relay hub.
//
// Service Workers cannot intercept synchronous XHR in the browser, and allowing
// the page to dial the target directly would leak the client IP. Instead,
// runtime-prelude rewrites synchronous XHRs to the same-origin
// `/zp/api/sync-fetch` endpoint. The Go server parks each request on a queue,
// the Service Worker polls `/zp/api/sync-fetch/poll` on its own thread and
// executes `transportFetch`, and the Go server returns the result without
// opening a separate direct egress path or TLS/HTTP fingerprint.

const (
	syncFetchWait      = 20 * time.Second // maximum time the page waits for a synchronous response
	syncFetchPollWait  = 25 * time.Second // long-poll timeout before returning 204 to the Service Worker
	syncFetchQueueCap  = 64
	syncFetchPollBatch = 16 // maximum number of queued jobs returned in a single poll response
)

type syncFetchJob struct {
	ID      string     `json:"id"`
	Target  string     `json:"target"`
	Tab     string     `json:"tab"`
	Entry   string     `json:"entry"`
	Method  string     `json:"method"`
	Headers [][]string `json:"headers"`
	// Cors holds the `crossorigin` attribute value (`anonymous` or
	// `use-credentials`; empty for a plain element) from a frame not
	// controlled by the Service Worker.
	Cors string `json:"cors,omitempty"`
	// WithCredentials mirrors XHR `withCredentials` so cross-origin requests
	// include cookies only when requested.
	WithCredentials bool `json:"wc,omitempty"`
	// DocURL and Cookies carry unacknowledged `document.cookie` writes ([id, line]
	// pairs and the document URL) so the Service Worker applies them before
	// executing a synchronous request.
	DocURL  string     `json:"docUrl,omitempty"`
	Cookies [][]string `json:"cookies,omitempty"`
	// Kind selects post-fetch response rewriting in the Service Worker: empty
	// for raw synchronous XHR bytes, or `style` / `script` for subresources
	// fetched on behalf of an uncontrolled child frame.
	Kind string `json:"kind"`

	// Host is the origin host the page used. Each origin has a Service Worker of its own with its own tabs, so only a worker polling
	// the same host may take the job (site frames run at hosts of their own on one relay).
	Host string `json:"-"`

	result chan *syncFetchResult
}

// syncFetchResult holds the response returned by the Service Worker.
// Body contains raw bytes sent as the HTTP POST body while metadata travels in
// request headers, avoiding base64/JSON serialization overhead on the Service
// Worker thread.
type syncFetchResult struct {
	Status     int
	StatusText string
	Headers    [][]string
	V          string
	Body       []byte
	Err        string
}

// syncFetchLegacyResult supports the JSON fallback format for older Service
// Worker instances still active in a tab.
type syncFetchLegacyResult struct {
	ID         string     `json:"id"`
	Status     int        `json:"status"`
	StatusText string     `json:"statusText"`
	Headers    [][]string `json:"headers"`
	V          string     `json:"v"`
	BodyB64    string     `json:"bodyB64"`
	Err        string     `json:"err"`
}

type syncFetchHub struct {
	mu        sync.Mutex
	jobs      map[string]*syncFetchJob
	queues    map[string]chan *syncFetchJob // one queue per origin host
	closed    chan struct{}
	closeOnce sync.Once
}

func newSyncFetchHub() *syncFetchHub {
	return &syncFetchHub{
		jobs:   make(map[string]*syncFetchJob),
		queues: make(map[string]chan *syncFetchJob),
		closed: make(chan struct{}),
	}
}

// queueFor returns the queue of jobs parked by pages of `host`, creating it on first use.
func (h *syncFetchHub) queueFor(host string) chan *syncFetchJob {
	h.mu.Lock()
	defer h.mu.Unlock()
	q, ok := h.queues[host]
	if !ok {
		q = make(chan *syncFetchJob, syncFetchQueueCap)
		h.queues[host] = q
	}
	return q
}

func (h *syncFetchHub) close() {
	if h == nil {
		return
	}
	h.closeOnce.Do(func() {
		close(h.closed)
	})
}

func (h *syncFetchHub) enqueue(j *syncFetchJob) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.closed:
		return errQueueFull
	default:
	}
	if _, exists := h.jobs[j.ID]; exists {
		return errDuplicateJobID
	}
	if len(h.jobs) >= syncFetchQueueCap {
		return errQueueFull
	}
	q, ok := h.queues[j.Host]
	if !ok {
		q = make(chan *syncFetchJob, syncFetchQueueCap)
		h.queues[j.Host] = q
	}
	select {
	case q <- j:
		h.jobs[j.ID] = j
		return nil
	default:
		return errQueueFull
	}
}

// takeFor is take, but only for a job parked by a page of `host`.
func (h *syncFetchHub) takeFor(id, host string) *syncFetchJob {
	h.mu.Lock()
	defer h.mu.Unlock()
	j := h.jobs[id]
	if j == nil || j.Host != host {
		return nil
	}
	delete(h.jobs, id)
	return j
}

func (h *syncFetchHub) take(id string) *syncFetchJob {
	h.mu.Lock()
	defer h.mu.Unlock()
	j := h.jobs[id]
	delete(h.jobs, id)
	return j
}

// sameOriginOnly restricts sync-fetch endpoints to same-origin requests via
// the Sec-Fetch-Site header.
func sameOriginOnly(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	}
	return false
}

// handleSyncFetch parks a synchronous XHR from the page until the Service
// Worker returns the upstream result.
func (s *server) handleSyncFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.safeError(w, r, "SYNC_BAD_METHOD", http.StatusMethodNotAllowed)
		return
	}
	if !sameOriginOnly(r) {
		s.safeError(w, r, "SYNC_BAD_ORIGIN", http.StatusForbidden)
		return
	}
	q := r.URL.Query()
	target := q.Get("u")
	if target == "" {
		s.safeError(w, r, "SYNC_NO_TARGET", http.StatusBadRequest)
		return
	}
	tu, err := url.Parse(target)
	if err != nil || (tu.Scheme != "http" && tu.Scheme != "https") {
		s.safeError(w, r, "SYNC_BAD_SCHEME", http.StatusBadRequest)
		return
	}

	job := &syncFetchJob{
		ID:              q.Get("rid"),
		Target:          target,
		Tab:             q.Get("tab"),
		Entry:           q.Get("entry"),
		Method:          strings.ToUpper(q.Get("m")),
		Kind:            q.Get("kind"),
		DocURL:          q.Get("dv"),
		WithCredentials: q.Get("wc") == "1",
		Cors:            corsMode(q.Get("cors")),
		Host:            r.Host,
		result:          make(chan *syncFetchResult, 1),
	}
	job.Cookies = parsePendingCookies(q["ck"])
	switch job.Kind {
	case "", "style", "script":
	default:
		s.safeError(w, r, "SYNC_BAD_KIND", http.StatusBadRequest)
		return
	}
	if job.ID == "" || job.Method == "" {
		s.safeError(w, r, "SYNC_BAD_ARGS", http.StatusBadRequest)
		return
	}
	for _, h := range q["h"] {
		if k, v, ok := strings.Cut(h, ":"); ok {
			job.Headers = append(job.Headers, []string{k, v})
		}
	}

	if err := s.syncHub.enqueue(job); err != nil {
		if errors.Is(err, errDuplicateJobID) {
			s.safeError(w, r, "SYNC_DUPLICATE_ID", http.StatusConflict)
			return
		}
		s.safeError(w, r, "SYNC_QUEUE_FULL", http.StatusServiceUnavailable)
		return
	}

	select {
	case res := <-job.result:
		w.Header().Set("X-ZP-Sync-Relay", sanitizeHeaderValue(res.V))
		if res.Err != "" {
			// Pass the upstream failure reason in X-ZP-Sync-Err rather than the
			// response body so the page does not consume an error string as
			// payload and the prelude can record it in its diagnostic buffer.
			w.Header().Set("X-ZP-Sync-Err", sanitizeHeaderValue(res.Err))
			s.safeError(w, r, "SYNC_UPSTREAM_FAILED", http.StatusBadGateway)
			return
		}
		for _, kv := range res.Headers {
			if len(kv) == 2 && safeSyncHeader(kv[0]) {
				w.Header().Add(kv[0], kv[1])
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(res.Status)
		if r.Method != http.MethodHead {
			_, _ = w.Write(res.Body)
		}
	case <-time.After(syncFetchWait):
		s.syncHub.take(job.ID)
		s.safeError(w, r, "SYNC_NO_WORKER", http.StatusGatewayTimeout)
	case <-s.syncHub.closed:
		s.syncHub.take(job.ID)
		s.safeError(w, r, "SW_NOT_READY", http.StatusServiceUnavailable)
	case <-r.Context().Done():
		s.syncHub.take(job.ID)
	}
}

// corsMode returns v if it is a valid `crossorigin` attribute mode.
func corsMode(v string) string {
	if v == "anonymous" || v == "use-credentials" {
		return v
	}
	return ""
}

// parsePendingCookies parses `ck` query values (each a JSON [id, line] pair)
// with count and length bounds.
func parsePendingCookies(values []string) [][]string {
	const maxWrites, maxLine = 32, 8192
	var out [][]string
	for _, v := range values {
		if len(out) >= maxWrites {
			break
		}
		var pair []string
		if json.Unmarshal([]byte(v), &pair) != nil || len(pair) != 2 {
			continue
		}
		if pair[0] == "" || len(pair[0]) > 64 || len(pair[1]) > maxLine {
			continue
		}
		out = append(out, pair)
	}
	return out
}

// handleSyncFetchPoll serves the Service Worker long-poll for pending jobs.
func (s *server) handleSyncFetchPoll(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOnly(r) {
		s.safeError(w, r, "SYNC_BAD_ORIGIN", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	queue := s.syncHub.queueFor(r.Host)
	select {
	case job := <-queue:
		// Drain up to syncFetchPollBatch queued jobs in a single poll response to
		// avoid round-trip stalls when multiple subresources arrive concurrently.
		jobs := []*syncFetchJob{job}
	drain:
		for len(jobs) < syncFetchPollBatch {
			select {
			case j := <-queue:
				jobs = append(jobs, j)
			default:
				break drain
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jobs)
	case <-time.After(syncFetchPollWait):
		w.WriteHeader(http.StatusNoContent)
	case <-s.syncHub.closed:
		w.WriteHeader(http.StatusNoContent)
	case <-r.Context().Done():
	}
}

// handleSyncFetchResult receives completed job results from the Service Worker.
func (s *server) handleSyncFetchResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.safeError(w, r, "SYNC_BAD_METHOD", http.StatusMethodNotAllowed)
		return
	}
	if !sameOriginOnly(r) {
		s.safeError(w, r, "SYNC_BAD_ORIGIN", http.StatusForbidden)
		return
	}
	id, res, err := readSyncResult(w, r)
	if err != nil {
		s.safeError(w, r, "SYNC_BAD_RESULT", http.StatusBadRequest)
		return
	}
	job := s.syncHub.takeFor(id, r.Host)
	if job == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	select {
	case job.result <- res:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

// readSyncResult parses a binary result payload (metadata in headers, raw bytes
// in body) or falls back to the JSON envelope format.
func readSyncResult(w http.ResponseWriter, r *http.Request) (string, *syncFetchResult, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		return "", nil, err
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var p syncFetchLegacyResult
		if err := json.Unmarshal(body, &p); err != nil {
			return "", nil, err
		}
		return p.ID, &syncFetchResult{
			Status: p.Status, StatusText: p.StatusText, Headers: p.Headers,
			V: p.V, Body: decodeB64(p.BodyB64), Err: p.Err,
		}, nil
	}
	id := r.Header.Get("X-ZP-Sync-Id")
	if id == "" {
		return "", nil, errNoSyncID
	}
	status, _ := strconv.Atoi(r.Header.Get("X-ZP-Sync-Status"))
	res := &syncFetchResult{
		Status:     status,
		StatusText: r.Header.Get("X-ZP-Sync-Statustext"),
		V:          r.Header.Get("X-ZP-Sync-V"),
		Err:        r.Header.Get("X-ZP-Sync-Error"),
		Body:       body,
	}
	if raw := r.Header.Get("X-ZP-Sync-Headers"); raw != "" {
		var hs [][]string
		if json.Unmarshal(decodeB64(raw), &hs) == nil {
			res.Headers = hs
		}
	}
	return id, res, nil
}

// sanitizeHeaderValue strips CR/LF and truncates v to prevent header injection.
func sanitizeHeaderValue(v string) string {
	v = strings.NewReplacer("\r", " ", "\n", " ").Replace(v)
	if len(v) > 200 {
		v = v[:200]
	}
	return v
}

// decodeB64 decodes a base64 string, returning nil on empty or malformed input.
func decodeB64(s string) []byte {
	if s == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	return b
}

// safeSyncHeader reports whether an upstream response header may be forwarded to
// the page. Set-Cookie is never forwarded because target cookies belong to the
// kernel cookie jar rather than the proxy origin. X-ZP-Cookie-Delta carries
// non-HttpOnly cookie updates serialized by the Service Worker so the prelude
// can update its synchronous document.cookie mirror before XHR.send() returns.
func safeSyncHeader(name string) bool {
	switch strings.ToLower(name) {
	case "content-type", "content-language", "expires", "last-modified", "etag", "x-zp-cookie-delta", "x-zp-sync-visible":
		return true
	}
	return false
}

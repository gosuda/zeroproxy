package main

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

var errNoSyncID = errors.New("sync: missing result id")

// 동기 XHR 지원 — **감옥 안에서**.
//
// 왜 필요한가: Service Worker 는 동기 XHR 을 가로채지 못한다. 실측으로 확정했다 —
// 같은 페이지에서 같은 URL 로 던졌을 때 동기 XHR 은 SW 를 건너뛰고 Go 까지 내려와
// 403(POLICY_BLOCKED)을 받고, 비동기 fetch 는 SW 가 503(SW_NOT_READY)을 낸다.
// 그래서 runtime-prelude 는 동기 XHR 을 정책으로 막아 왔다(막지 않으면 브라우저가
// 타깃으로 직접 나가 실제 IP 가 샌다 — 감옥 탈출).
//
// 그런데 NAVER 캡차는 UI(`rcaptUi`), 문제(`question`), **JS 캡차 토큰 검증**
// (`verifyJs`)을 전부 동기 XHR 로 가져온다. 그래서 답을 맞게 넣어도 서버가
// 유효한 토큰을 못 받아 "틀렸다" 가 나왔다.
//
// 설계의 핵심: **Go 는 타깃으로 직접 나가지 않는다.**
// Go 는 페이지의 동기 요청을 park 해 두고 SW 에 작업을 넘긴 뒤, SW 가 기존
// `transportFetch` 로 가져온 결과를 받아 그대로 돌려준다. 새 egress 경로도,
// 새 TLS/HTTP 지문도 생기지 않는다. 정책 판단도 전부 기존 SW 경로가 한다.
//
// 교착이 아닌 이유: 페이지 메인 스레드가 동기 XHR 로 막혀 있어도 Service Worker 는
// 별도 스레드/프로세스에서 돌기 때문에 작업을 수행할 수 있다.

const (
	syncFetchWait      = 20 * time.Second // 페이지가 기다려 주는 최대 시간
	syncFetchPollWait  = 25 * time.Second // SW long-poll 이 빈손으로 돌아가는 주기
	syncFetchQueueCap  = 64
	syncFetchPollBatch = 16 // 한 번의 폴에 넘기는 최대 잡 수
)

type syncFetchJob struct {
	ID      string     `json:"id"`
	Target  string     `json:"target"`
	Tab     string     `json:"tab"`
	Entry   string     `json:"entry"`
	Method  string     `json:"method"`
	Headers [][]string `json:"headers"`
	// Kind — 응답에 어떤 후처리를 해야 하는지. 동기 XHR 은 원본 바이트를
	// 원하므로 빈 값이다. SW-less 프레임의 서브리소스는 SW 의 `/zp/api/fetch`
	// 핸들러가 해 주던 CSS/스크립트 리라이트를 여기서 받아야 한다 — 릴레이는
	// `transportFetch` 를 직접 부르므로 그 단계를 건너뛰기 때문이다.
	Kind string `json:"kind"`

	result chan *syncFetchResult
}

// syncFetchResult — SW 가 돌려준 결과. Body 는 **원본 바이트**다.
//
// 예전에는 본문을 base64 JSON 으로 실어 날랐다. 동기 XHR 한 건에는 문제가
// 없었지만, SW-less 프레임의 서브리소스를 전부 이 경로로 보내자 무너졌다 —
// 이미지 수십 건을 base64 로 부풀려(33%) 문자열로 만들고 JSON 으로 감싸는
// 비용이 SW 스레드에 몰려, 15초 안에 스타일시트가 못 붙었다(실측: naver
// 19회 중 8회 deadSheets 2~4). 이제 바이트를 그대로 POST 하고 메타데이터만
// 헤더로 넘긴다.
type syncFetchResult struct {
	Status     int
	StatusText string
	Headers    [][]string
	V          string
	Body       []byte
	Err        string
}

// syncFetchLegacyResult — 낡은 SW 가 물려 있을 때를 위한 JSON 경로.
// 브라우저가 이전 버전 SW 를 붙들고 있으면 바이너리 POST 를 안 보내므로,
// 받아는 준다(이게 없으면 그 탭은 전부 타임아웃이다).
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
	mu    sync.Mutex
	jobs  map[string]*syncFetchJob
	queue chan *syncFetchJob
}

func newSyncFetchHub() *syncFetchHub {
	return &syncFetchHub{
		jobs:  make(map[string]*syncFetchJob),
		queue: make(chan *syncFetchJob, syncFetchQueueCap),
	}
}

func (h *syncFetchHub) put(j *syncFetchJob) {
	h.mu.Lock()
	h.jobs[j.ID] = j
	h.mu.Unlock()
}

func (h *syncFetchHub) take(id string) *syncFetchJob {
	h.mu.Lock()
	defer h.mu.Unlock()
	j := h.jobs[id]
	delete(h.jobs, id)
	return j
}

// sameOriginOnly — 이 엔드포인트는 우리 페이지만 부를 수 있어야 한다.
// 동기 XHR 은 same-origin 이므로 Sec-Fetch-Site 가 same-origin 으로 온다.
// 헤더가 없는 클라이언트는 거부한다(브라우저는 항상 보낸다).
func sameOriginOnly(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	}
	return false
}

// handleSyncFetch — 페이지의 동기 XHR 이 도착하는 자리.
// 여기서 응답을 park 하고 SW 가 결과를 돌려줄 때까지 기다린다.
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
		ID:     q.Get("rid"),
		Target: target,
		Tab:    q.Get("tab"),
		Entry:  q.Get("entry"),
		Method: strings.ToUpper(q.Get("m")),
		Kind:   q.Get("kind"),
		result: make(chan *syncFetchResult, 1),
	}
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
	// 페이지가 보낸 헤더 중 안전한 것만 넘긴다. Cookie/Authorization 은
	// 여기서 다루지 않는다 — 쿠키는 기존 경로대로 SW/커널이 붙인다.
	for _, h := range q["h"] {
		if k, v, ok := strings.Cut(h, ":"); ok {
			job.Headers = append(job.Headers, []string{k, v})
		}
	}

	s.syncHub.put(job)
	select {
	case s.syncHub.queue <- job:
	default:
		s.syncHub.take(job.ID)
		s.safeError(w, r, "SYNC_QUEUE_FULL", http.StatusServiceUnavailable)
		return
	}

	select {
	case res := <-job.result:
		w.Header().Set("X-ZP-Sync-Relay", sanitizeHeaderValue(res.V))
		if res.Err != "" {
			// 상류 실패 이유를 헤더로 넘긴다. 본문에 넣으면 페이지가 그대로
			// DOM 에 꽂아 버리고(캡차가 실제로 그랬다), SW 콘솔은 이 환경에서
			// 회수가 안 된다. 헤더면 프렐류드가 진단 버퍼에 남길 수 있다.
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
	case <-r.Context().Done():
		s.syncHub.take(job.ID)
	}
}

// handleSyncFetchPoll — SW 가 여는 long-poll. 작업이 생기면 그때 응답한다.
// 빈손으로 돌아가면 SW 가 즉시 다시 연다.
func (s *server) handleSyncFetchPoll(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOnly(r) {
		s.safeError(w, r, "SYNC_BAD_ORIGIN", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	select {
	case job := <-s.syncHub.queue:
		// ★한 번에 하나만 넘기면 잡 N 개에 왕복 N 번이 든다. 동기 XHR 은 한
		// 번에 한 건이라 티가 안 났지만, SW-less 프레임의 서브리소스가 한꺼번에
		// 몰리면 그 직렬화가 그대로 지연이 된다. 큐에 이미 쌓인 만큼은 같이 보낸다.
		jobs := []*syncFetchJob{job}
	drain:
		for len(jobs) < syncFetchPollBatch {
			select {
			case j := <-s.syncHub.queue:
				jobs = append(jobs, j)
			default:
				break drain
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jobs)
	case <-time.After(syncFetchPollWait):
		w.WriteHeader(http.StatusNoContent)
	case <-r.Context().Done():
	}
}

// handleSyncFetchResult — SW 가 결과를 돌려주는 자리.
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
	job := s.syncHub.take(id)
	if job == nil {
		// 이미 타임아웃됐거나 페이지가 떠난 경우. 조용히 성공 처리한다.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	select {
	case job.result <- res:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

// readSyncResult — 바이너리 경로가 기본, JSON 은 낡은 SW 를 위한 폴백.
// 바이너리에서는 본문이 곧 응답 바이트이고 메타데이터만 헤더로 온다.
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
	// 응답 헤더는 작아서 헤더 한 줄에 JSON 으로 실어도 된다. 실패해도
	// 본문은 살아 있으므로 헤더만 비우고 지나간다.
	if raw := r.Header.Get("X-ZP-Sync-Headers"); raw != "" {
		var hs [][]string
		if json.Unmarshal(decodeB64(raw), &hs) == nil {
			res.Headers = hs
		}
	}
	return id, res, nil
}

// sanitizeHeaderValue — 헤더에 넣어도 안전한 형태로 줄인다.
// 개행이 섞이면 헤더 인젝션이 되므로 제거하고, 길이도 자른다.
func sanitizeHeaderValue(v string) string {
	v = strings.NewReplacer("\r", " ", "\n", " ").Replace(v)
	if len(v) > 200 {
		v = v[:200]
	}
	return v
}

// decodeB64 — 본문은 base64 로 실어 나른다(바이너리 안전).
// 잘못된 입력은 빈 본문으로 떨어뜨린다 — 여기서 에러를 내봐야 페이지는
// 이미 동기로 막혀 있어서 할 수 있는 게 없다.
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

// safeSyncHeader — 응답에 그대로 실어도 되는 헤더만 통과시킨다.
// Set-Cookie 는 절대 통과시키지 않는다: 쿠키는 프록시 origin 이 아니라
// 타깃 origin 의 것이고, 기존 경로대로 커널의 jar 가 관리한다.
func safeSyncHeader(name string) bool {
	switch strings.ToLower(name) {
	case "content-type", "content-language", "expires", "last-modified", "etag":
		return true
	}
	return false
}

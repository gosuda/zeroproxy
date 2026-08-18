package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
)

// CSP 위반 리포트 수집기.
//
// 왜 필요한가: 프록시 문서의 CSP 는 `img-src 'self' blob: data:` 처럼 좁다.
// 우리가 리라이트를 한 군데 놓치면 원본 URL 이 그대로 남고, 브라우저가 그걸
// 막는다 — 즉 **격리는 지켜지지만 아무도 그 사실을 모른다**. SW 의
// `__zp_refusals()` 에는 안 남는다(요청이 SW 까지 오지도 못한다). 실제로
// 2026-08-18 naver 에서 s.pstatic.net 이미지 5건이 이렇게 새다 막혔는데,
// 어느 코드가 그 URL 을 만들었는지 알아내려고 브라우저를 30번 다시 띄우고도
// 못 찾았다. 리포트에는 `source-file`/`line-number` 가 들어 있어 한 번에 끝난다.
//
// 리포트는 CSP 자체의 적용을 받지 않으므로 `connect-src` 와 무관하게 도착한다.
// meta 로 배달된 CSP 에서는 `report-uri` 가 무시되지만 우리 프록시 문서는
// 헤더로도 같은 정책을 받으므로 문제가 없다.
//
// 서버 로그로만 흘린다. 페이지가 읽을 수 있는 엔드포인트를 만들면 감옥 안에
// 새 표면이 하나 생기는데, 진단 하나 때문에 그걸 늘릴 이유가 없다.
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
	// 성공/실패 모두 204 로 답한다. 리포트 전송은 페이지가 관측할 수 없어야
	// 하고(관측되면 그 자체가 신호다), 브라우저도 응답 본문을 쓰지 않는다.
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
	// 문서 URI 는 share URL 이라 길고 비밀값을 담는다 — 경로만 남긴다.
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

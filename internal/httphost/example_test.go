package httphost_test

import (
	"net/http"
	"net/http/httptest"

	"github.com/gosuda/zeroproxy/internal/httphost"
)

// REFACTOR.md §3.4 — 임베딩 계약: 호스트는 NewHandler 로 http.Handler 를
// 얻어 자체 mux/리스너/TLS/미들웨어 스택에 마운트한다. zeroproxy-server
// 바이너리는 이 계약의 얇은 CLI 래퍼일 뿐이다.
func ExampleNewHandler() {
	// 최소 임베딩: 정적 에셋 + internal SOCKS 다이얼(직접 egress).
	handler := httphost.NewHandler(httphost.Config{
		WebDir:    "../../dist/web",
		SocksAddr: "internal",
	})

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// launcher 페이지가 올라와야 한다 (web 자산이 없으면 500 대신 404 도 OK —
	// 여기서는 핸들러가 마운트돼 응답하는 것 자체를 검증).
	resp, err := http.Get(srv.URL + "/zp/")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		panic("handler returned server error")
	}
}

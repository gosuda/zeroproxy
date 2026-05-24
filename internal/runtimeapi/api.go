package runtimeapi

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
)

type CookieSetter struct{ Jar *cookiejar.Jar }

type CookieSetRequest struct {
	TargetURL string `json:"targetUrl"`
	Cookie    string `json:"cookie"`
}

func (h CookieSetter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req CookieSetRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(req.TargetURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	if h.Jar != nil {
		h.Jar.SetDocumentCookie(u, req.Cookie)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

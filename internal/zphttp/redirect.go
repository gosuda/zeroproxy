package zphttp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const MaxRedirects = 10

// Do follows target redirects inside the WASM transport so raw Location headers
// are never exposed to the browser Response constructor.
func (e *Engine) Do(ctx context.Context, req *http.Request, target *url.URL, tab *TabState) (*http.Response, *url.URL, error) {
	cur := cloneURL(target)
	wireReq := req
	for redirects := 0; redirects <= MaxRedirects; redirects++ {
		resp, err := e.RoundTrip(ctx, wireReq, cur, tab)
		if err != nil {
			return nil, cur, err
		}
		if tab != nil && tab.CookieJar != nil {
			tab.CookieJar.SetCookies(cur, resp.Cookies())
		}
		loc := resp.Header.Get("Location")
		if loc == "" || !redirectStatus(resp.StatusCode) {
			return resp, cur, nil
		}
		if redirects == MaxRedirects {
			_ = resp.Body.Close()
			return nil, cur, fmt.Errorf("TARGET_CONNECT_FAILED: too many redirects")
		}
		next, err := cur.Parse(loc)
		_ = resp.Body.Close()
		if err != nil {
			return nil, cur, fmt.Errorf("TARGET_CONNECT_FAILED: malformed redirect")
		}
		if next.Scheme != "http" && next.Scheme != "https" {
			return nil, cur, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
		}
		cur = next
		wireReq = redirectedRequest(wireReq, resp.StatusCode, cur)
	}
	return nil, cur, fmt.Errorf("TARGET_CONNECT_FAILED: redirect loop")
}

func redirectStatus(code int) bool {
	return code == 301 || code == 302 || code == 303 || code == 307 || code == 308
}

func redirectedRequest(req *http.Request, code int, target *url.URL) *http.Request {
	method := req.Method
	body := req.Body
	cl := req.ContentLength
	if code == 303 || ((code == 301 || code == 302) && method != "GET" && method != "HEAD") {
		method = "GET"
		body = io.NopCloser(http.NoBody)
		cl = 0
	}
	n := req.Clone(req.Context())
	n.Method = method
	n.Body = body
	n.ContentLength = cl
	n.URL = cloneURL(target)
	return n
}

func cloneURL(u *url.URL) *url.URL {
	if u == nil {
		return nil
	}
	v := *u
	return &v
}

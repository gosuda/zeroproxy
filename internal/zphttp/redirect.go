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
	policy := policyFromRequest(req)
	for redirects := 0; redirects <= MaxRedirects; redirects++ {
		resp, err := e.RoundTrip(ctx, wireReq, cur, tab)
		if err != nil {
			return nil, cur, err
		}
		recordRedirectCookies(tab, policy, cur, resp)
		loc := resp.Header.Get("Location")
		if !followableRedirect(loc, resp.StatusCode) {
			return resp, cur, nil
		}
		if policy.Redirect == "error" {
			_ = resp.Body.Close()
			return nil, cur, fmt.Errorf("POLICY_BLOCKED: redirect disallowed")
		}
		if policy.Redirect == "manual" {
			return resp, cur, nil
		}
		if redirects == MaxRedirects {
			_ = resp.Body.Close()
			return nil, cur, fmt.Errorf("TARGET_CONNECT_FAILED: too many redirects")
		}
		next, err := resolveRedirectURL(cur, loc)
		_ = resp.Body.Close()
		if err != nil {
			return nil, cur, err
		}
		cur = next
		wireReq, err = redirectedRequest(wireReq, resp.StatusCode, cur)
		if err != nil {
			return nil, cur, err
		}
	}
	return nil, cur, fmt.Errorf("TARGET_CONNECT_FAILED: redirect loop")
}

// recordRedirectCookies persists a hop response's Set-Cookie headers into the
// tab jar when the request policy permits cookies for the current URL.
func recordRedirectCookies(tab *TabState, policy RequestPolicy, cur *url.URL, resp *http.Response) {
	if tab != nil && tab.CookieJar != nil && policyAllowsCookies(policy, cur) {
		tab.CookieJar.SetCookies(cur, resp.Cookies())
	}
}

// resolveRedirectURL resolves a Location value against the current URL and
// enforces the scheme allowlist. It is the fail-closed gate that keeps the
// transport from following a redirect to a non-http(s) scheme.
func resolveRedirectURL(cur *url.URL, loc string) (*url.URL, error) {
	next, err := cur.Parse(loc)
	if err != nil {
		return nil, fmt.Errorf("TARGET_CONNECT_FAILED: malformed redirect")
	}
	if next.Scheme != "http" && next.Scheme != "https" {
		return nil, fmt.Errorf("TARGET_PROTOCOL_BLOCKED")
	}
	return next, nil
}

func redirectStatus(code int) bool {
	return code == 301 || code == 302 || code == 303 || code == 307 || code == 308
}

// followableRedirect reports whether a hop response is a redirect the engine
// should follow: a non-empty Location with a redirect status code.
func followableRedirect(loc string, code int) bool {
	return loc != "" && redirectStatus(code)
}

func redirectedRequest(req *http.Request, code int, target *url.URL) (*http.Request, error) {
	method := req.Method
	body := req.Body
	cl := req.ContentLength
	getBody := req.GetBody
	if code == 303 || ((code == 301 || code == 302) && method != "GET" && method != "HEAD") {
		method = "GET"
		body = io.NopCloser(http.NoBody)
		getBody = nil
		cl = 0
	} else if body != nil && body != http.NoBody {
		if getBody == nil {
			return nil, fmt.Errorf("TARGET_CONNECT_FAILED: non-replayable redirect body")
		}
		nextBody, err := getBody()
		if err != nil {
			return nil, fmt.Errorf("TARGET_CONNECT_FAILED: replay redirect body: %w", err)
		}
		body = nextBody
	}
	n := req.Clone(req.Context())
	n.Method = method
	n.Body = body
	n.GetBody = getBody
	n.ContentLength = cl
	n.URL = cloneURL(target)
	return n, nil
}

func cloneURL(u *url.URL) *url.URL {
	if u == nil {
		return nil
	}
	v := *u
	return &v
}

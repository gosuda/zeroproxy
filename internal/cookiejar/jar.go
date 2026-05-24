package cookiejar

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type SameSite string

const (
	SameSiteLax         SameSite = "Lax"
	SameSiteStrict      SameSite = "Strict"
	SameSiteNone        SameSite = "None"
	SameSiteUnspecified SameSite = "Unspecified"
)

type CookieRecord struct {
	Name           string
	Value          string
	Domain         string
	HostOnly       bool
	Path           string
	Expires        *time.Time
	MaxAge         *int
	Secure         bool
	HTTPOnly       bool
	SameSite       SameSite
	CreationTime   time.Time
	LastAccessTime time.Time
}

type Jar struct {
	mu      sync.Mutex
	records []CookieRecord
	now     func() time.Time
}

func New() *Jar { return &Jar{now: time.Now} }

func (j *Jar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if j == nil || u == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now().UTC()
	for _, c := range cookies {
		if c == nil || c.Name == "" || strings.ContainsAny(c.Name, "=;\r\n") {
			continue
		}
		rec, ok := recordFromCookie(u, c, now)
		if !ok {
			continue
		}
		j.upsertLocked(rec)
	}
}

func (j *Jar) Cookies(u *url.URL, includeHTTPOnly bool) []*http.Cookie {
	if j == nil || u == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now().UTC()
	host := canonicalHost(u.Hostname())
	path := requestPath(u)
	secure := u.Scheme == "https"
	out := make([]CookieRecord, 0, len(j.records))
	kept := j.records[:0]
	for _, r := range j.records {
		if expired(r, now) {
			continue
		}
		if !includeHTTPOnly && r.HTTPOnly {
			kept = append(kept, r)
			continue
		}
		if domainMatch(host, r.Domain, r.HostOnly) && pathMatch(path, r.Path) && (!r.Secure || secure) {
			r.LastAccessTime = now
			out = append(out, r)
		}
		kept = append(kept, r)
	}
	j.records = kept
	sort.SliceStable(out, func(a, b int) bool {
		if len(out[a].Path) != len(out[b].Path) {
			return len(out[a].Path) > len(out[b].Path)
		}
		return out[a].CreationTime.Before(out[b].CreationTime)
	})
	cookies := make([]*http.Cookie, 0, len(out))
	for _, r := range out {
		cookies = append(cookies, &http.Cookie{Name: r.Name, Value: r.Value})
	}
	return cookies
}

func (j *Jar) DocumentCookie(u *url.URL) string {
	cookies := j.Cookies(u, false)
	if len(cookies) == 0 {
		return ""
	}
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

func (j *Jar) SetDocumentCookie(u *url.URL, line string) {
	if strings.TrimSpace(line) == "" || strings.ContainsAny(line, "\r\n") {
		return
	}
	h := http.Header{}
	h.Add("Set-Cookie", line)
	j.SetCookies(u, (&http.Response{Header: h}).Cookies())
}

func recordFromCookie(u *url.URL, c *http.Cookie, now time.Time) (CookieRecord, bool) {
	host := canonicalHost(u.Hostname())
	domain := canonicalHost(c.Domain)
	hostOnly := false
	if domain == "" {
		domain = host
		hostOnly = true
	} else {
		domain = strings.TrimPrefix(domain, ".")
		if !domainMatch(host, domain, false) {
			return CookieRecord{}, false
		}
	}
	path := c.Path
	if path == "" || path[0] != '/' {
		path = defaultPath(u)
	}
	rec := CookieRecord{
		Name: c.Name, Value: c.Value, Domain: domain, HostOnly: hostOnly, Path: path,
		Secure: c.Secure, HTTPOnly: c.HttpOnly, SameSite: convertSameSite(c.SameSite),
		CreationTime: now, LastAccessTime: now,
	}
	if !c.Expires.IsZero() {
		t := c.Expires.UTC()
		rec.Expires = &t
	}
	if c.MaxAge != 0 {
		m := c.MaxAge
		rec.MaxAge = &m
	}
	return rec, true
}

func (j *Jar) upsertLocked(rec CookieRecord) {
	for i, old := range j.records {
		if old.Name == rec.Name && old.Domain == rec.Domain && old.Path == rec.Path {
			rec.CreationTime = old.CreationTime
			if rec.MaxAge != nil && *rec.MaxAge < 0 {
				j.records = append(j.records[:i], j.records[i+1:]...)
				return
			}
			j.records[i] = rec
			return
		}
	}
	if rec.MaxAge != nil && *rec.MaxAge < 0 {
		return
	}
	j.records = append(j.records, rec)
}

func expired(r CookieRecord, now time.Time) bool {
	if r.MaxAge != nil {
		if *r.MaxAge <= 0 {
			return true
		}
		return r.CreationTime.Add(time.Duration(*r.MaxAge) * time.Second).Before(now)
	}
	return r.Expires != nil && r.Expires.Before(now)
}

func convertSameSite(s http.SameSite) SameSite {
	switch s {
	case http.SameSiteLaxMode:
		return SameSiteLax
	case http.SameSiteStrictMode:
		return SameSiteStrict
	case http.SameSiteNoneMode:
		return SameSiteNone
	default:
		return SameSiteUnspecified
	}
}

func canonicalHost(h string) string { return strings.TrimSuffix(strings.ToLower(h), ".") }
func requestPath(u *url.URL) string {
	if u.Path == "" {
		return "/"
	}
	return u.EscapedPath()
}
func defaultPath(u *url.URL) string {
	p := requestPath(u)
	i := strings.LastIndexByte(p, '/')
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

func domainMatch(host, domain string, hostOnly bool) bool {
	if hostOnly {
		return host == domain
	}
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func pathMatch(reqPath, cookiePath string) bool {
	if cookiePath == "" {
		cookiePath = "/"
	}
	if reqPath == cookiePath {
		return true
	}
	if strings.HasPrefix(reqPath, cookiePath) {
		return strings.HasSuffix(cookiePath, "/") || (len(reqPath) > len(cookiePath) && reqPath[len(cookiePath)] == '/')
	}
	return false
}

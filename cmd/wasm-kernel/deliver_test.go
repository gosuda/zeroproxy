//go:build js && wasm

package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"syscall/js"
	"testing"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/zphttp"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/transform"
)

func deliverAwait(p js.Value) (js.Value, bool) {
	type res struct {
		v  js.Value
		ok bool
	}
	ch := make(chan res, 1)
	then := js.FuncOf(func(_ js.Value, a []js.Value) any { ch <- res{a[0], true}; return nil })
	catch := js.FuncOf(func(_ js.Value, _ []js.Value) any { ch <- res{js.Null(), false}; return nil })
	defer then.Release()
	defer catch.Release()
	p.Call("then", then).Call("catch", catch)
	r := <-ch
	return r.v, r.ok
}

type deliverResult struct {
	release   bool
	status    int
	headers   map[string]string
	body      string
	cookieDoc string
}

// runDeliver drives deliverResponse with a constructed (already-fetched) response
// — no engine — and returns the resolved JS Response shape, the ownership flag,
// and the post-call cookie-jar state.
func runDeliver(req *http.Request, resp *http.Response, finalURL *url.URL) deliverResult {
	jar := cookiejar.New()
	tab := &zphttp.TabState{TabID: "t", CookieJar: jar}
	var captured js.Value
	var got bool
	rf := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			captured = args[0]
			got = true
		}
		return nil
	})
	rel := deliverResponse(context.Background(), rf.Value, req, resp, finalURL, tab, func() {})
	out := deliverResult{release: rel, cookieDoc: jar.DocumentCookie(finalURL), headers: map[string]string{}}
	if got {
		out.status = captured.Get("status").Int()
		fe := js.FuncOf(func(_ js.Value, a []js.Value) any {
			out.headers[strings.ToLower(a[1].String())] = a[0].String()
			return nil
		})
		captured.Get("headers").Call("forEach", fe)
		fe.Release()
		if ab, ok := deliverAwait(captured.Call("arrayBuffer")); ok {
			u8 := js.Global().Get("Uint8Array").New(ab)
			b := make([]byte, u8.Get("length").Int())
			js.CopyBytesToGo(b, u8)
			out.body = string(b)
		}
	}
	rf.Release()
	return out
}

func installDeliverTestRewriter(t *testing.T) func() {
	t.Helper()
	rewriter := js.Global().Get("ZPRewriter")
	rewriteHTML := js.FuncOf(func(_ js.Value, args []js.Value) any {
		source := ""
		if len(args) > 0 {
			source = args[0].String()
		}
		return map[string]any{
			"ok":   true,
			"code": source + "<!--rewritten-by-test-rewriter-->",
		}
	})
	js.Global().Set("ZPRewriter", map[string]any{
		"rewriteHTMLDocument": rewriteHTML,
	})
	return func() {
		rewriteHTML.Release()
		js.Global().Set("ZPRewriter", rewriter)
	}
}

func deliverReq(hdr map[string]string, raw string) *http.Request {
	u, _ := url.Parse(raw)
	r := &http.Request{Method: "GET", URL: u, Header: http.Header{}}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func deliverResp(status int, hdr map[string]string, setCookie, body string, hasBody bool) *http.Response {
	h := http.Header{}
	for k, v := range hdr {
		h.Set(k, v)
	}
	if setCookie != "" {
		h.Add("Set-Cookie", setCookie)
	}
	r := &http.Response{StatusCode: status, Header: h}
	if hasBody {
		r.Body = io.NopCloser(strings.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	return r
}

func eucKRString(t *testing.T, text string) string {
	t.Helper()
	encoded, _, err := transform.String(korean.EUCKR.NewEncoder(), text)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// TestDeliverResponseOwnershipAndDelivery pins releaseOnReturn per path (the
// teardown-ownership flag), basic response delivery, document transform, and
// cookie capture / credentials-omit.
func TestDeliverResponseOwnershipAndDelivery(t *testing.T) {
	cleanupRewriter := installDeliverTestRewriter(t)
	defer cleanupRewriter()

	plain := "https://t.test/a.js"

	// Body present -> ownership transfers to the body cancel goroutine -> false.
	withBody := runDeliver(deliverReq(nil, plain), deliverResp(200, map[string]string{"Content-Type": "application/javascript"}, "", "x=1", true), mustURL(t, plain))
	if withBody.release {
		t.Fatal("body-present: releaseOnReturn must be false (body goroutine owns teardown)")
	}
	if withBody.status != 200 || withBody.body != "x=1" {
		t.Fatalf("body-present delivery: status=%d body=%q, want 200/x=1", withBody.status, withBody.body)
	}

	// Nil body -> nothing owns teardown -> the deferred cancel must still fire -> true.
	noBody := runDeliver(deliverReq(nil, plain), deliverResp(204, map[string]string{"Content-Type": "text/plain"}, "", "", false), mustURL(t, plain))
	if !noBody.release {
		t.Fatal("nil-body: releaseOnReturn must stay true (caller's deferred cancel owns teardown)")
	}
	if noBody.status != 204 || noBody.body != "" {
		t.Fatalf("nil-body delivery: status=%d body=%q, want 204/empty (response must still be delivered)", noBody.status, noBody.body)
	}

	// Document + HTML -> transformed to text/html; body is rewritten (not the input).
	doc := runDeliver(deliverReq(map[string]string{"X-Zp-Document-Request": "1"}, "https://t.test/"), deliverResp(200, map[string]string{"Content-Type": "text/html"}, "", "<html><head></head><body>hi</body></html>", true), mustURL(t, "https://t.test/"))
	if !strings.Contains(strings.ToLower(doc.headers["content-type"]), "text/html") {
		t.Fatalf("document transform Content-Type = %q, want text/html", doc.headers["content-type"])
	}
	if doc.body == "<html><head></head><body>hi</body></html>" || !strings.Contains(doc.body, "hi") {
		t.Fatalf("document body not transformed (membrane injection missing): %q", doc.body)
	}

	eucKRDoc := eucKRString(t, `<html><head></head><body>뉴스</body></html>`)
	decodedDoc := runDeliver(deliverReq(map[string]string{"X-Zp-Document-Request": "1"}, "https://news.naver.com/"), deliverResp(200, map[string]string{"Content-Type": "text/html; charset=euc-kr"}, "", eucKRDoc, true), mustURL(t, "https://news.naver.com/"))
	if !strings.Contains(decodedDoc.body, "뉴스") {
		t.Fatalf("document transform must decode euc-kr before rewrite, got body %q", decodedDoc.body)
	}

	// Set-Cookie is captured into the jar; credentials=omit skips capture.
	withCookie := runDeliver(deliverReq(nil, plain), deliverResp(200, map[string]string{"Content-Type": "text/plain"}, "sid=abc; Path=/", "c", true), mustURL(t, plain))
	if !strings.Contains(withCookie.cookieDoc, "sid=abc") {
		t.Fatalf("cookie not captured: DocumentCookie=%q", withCookie.cookieDoc)
	}
	omit := runDeliver(deliverReq(map[string]string{"X-Zp-Fetch-Credentials": "omit"}, plain), deliverResp(200, map[string]string{"Content-Type": "text/plain"}, "sid=zzz; Path=/", "o", true), mustURL(t, plain))
	if strings.Contains(omit.cookieDoc, "sid=zzz") {
		t.Fatalf("credentials=omit must skip cookie capture, got DocumentCookie=%q", omit.cookieDoc)
	}
}

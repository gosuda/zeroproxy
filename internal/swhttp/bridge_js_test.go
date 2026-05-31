//go:build js && wasm

package swhttp

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"syscall/js"
	"testing"
)

func TestResponseToJSUsesNullBodyForNullBodyStatus(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusNoContent,
		Status:     http.StatusText(http.StatusNoContent),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("must not be passed to Response constructor")),
	}
	v, err := ResponseToJS(context.Background(), resp, false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := v.Get("status").Int(); got != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", got, http.StatusNoContent)
	}
	if !v.Get("body").IsNull() {
		t.Fatal("204 Response body must be null")
	}
}

// buildFetchFacade constructs a minimal JS fetch-facade object (url/method/
// headers/body/bodyUsed) the way the Service Worker hands one to RequestFromJS.
// A nil body yields a null .body; a non-nil body becomes a real ReadableStream.
func buildFetchFacade(rawURL, method string, headers [][2]string, body []byte, bodyUsed bool) js.Value {
	o := js.Global().Get("Object").New()
	o.Set("url", rawURL)
	o.Set("method", method)
	hdr := js.Global().Get("Headers").New()
	for _, p := range headers {
		hdr.Call("append", p[0], p[1])
	}
	o.Set("headers", hdr)
	if body == nil {
		o.Set("body", js.Null())
	} else {
		arr := js.Global().Get("Uint8Array").New(len(body))
		js.CopyBytesToJS(arr, body)
		o.Set("body", js.Global().Get("Response").New(arr).Get("body"))
	}
	o.Set("bodyUsed", bodyUsed)
	return o
}

// TestRequestFromJSParsesBodyForms is the permanent characterization of the
// membrane boundary parser: it pins how each fetch-facade body form maps onto the
// *http.Request — no-body, streaming upload (ContentLength -1, no GetBody),
// replayable upload (buffered + a replayable GetBody the redirect path needs), the
// 1 MiB fail-closed replay cap, and bodyUsed. These are the contracts the
// jsHeaders/extractRequestBody decomposition must preserve.
func TestRequestFromJSParsesBodyForms(t *testing.T) {
	ctx := context.Background()

	req, err := RequestFromJS(ctx, buildFetchFacade("https://t.test/p", "GET", [][2]string{{"X-A", "1"}}, nil, false))
	if err != nil {
		t.Fatalf("no-body GET: %v", err)
	}
	if req.Method != "GET" || req.Host != "t.test" {
		t.Fatalf("no-body GET method/host = %s/%s", req.Method, req.Host)
	}
	if req.Header.Get("X-A") != "1" {
		t.Fatalf("header X-A = %q, want 1", req.Header.Get("X-A"))
	}
	if req.ContentLength != 0 || req.GetBody != nil {
		t.Fatalf("no-body GET: contentLength=%d getBody=%v, want 0/nil", req.ContentLength, req.GetBody != nil)
	}
	if b, _ := io.ReadAll(req.Body); len(b) != 0 {
		t.Fatalf("no-body GET carried %d bytes", len(b))
	}

	req, err = RequestFromJS(ctx, buildFetchFacade("https://t.test/up", "POST", nil, []byte("stream-payload"), false))
	if err != nil {
		t.Fatalf("streaming POST: %v", err)
	}
	if req.ContentLength != -1 || req.GetBody != nil {
		t.Fatalf("streaming POST: contentLength=%d getBody=%v, want -1/nil", req.ContentLength, req.GetBody != nil)
	}
	if b, _ := io.ReadAll(req.Body); string(b) != "stream-payload" {
		t.Fatalf("streaming body = %q", b)
	}

	req, err = RequestFromJS(ctx, buildFetchFacade("https://t.test/up", "POST", [][2]string{{"X-ZP-Upload-Replayable", "1"}}, []byte("replay-me"), false))
	if err != nil {
		t.Fatalf("replayable POST: %v", err)
	}
	if req.ContentLength != int64(len("replay-me")) || req.GetBody == nil {
		t.Fatalf("replayable POST: contentLength=%d getBody=%v, want 9/non-nil (redirect replay needs GetBody)", req.ContentLength, req.GetBody != nil)
	}
	if b, _ := io.ReadAll(req.Body); string(b) != "replay-me" {
		t.Fatalf("replayable body = %q", b)
	}
	rc, _ := req.GetBody()
	if b, _ := io.ReadAll(rc); string(b) != "replay-me" {
		t.Fatalf("GetBody replay = %q, want replay-me", b)
	}

	_, err = RequestFromJS(ctx, buildFetchFacade("https://t.test/up", "POST", [][2]string{{"X-ZP-Upload-Replayable", "1"}}, bytes.Repeat([]byte("z"), 1024*1024+1), false))
	if err == nil || !strings.Contains(err.Error(), "exceeds replay buffer") {
		t.Fatalf("oversized replayable err = %v, want 'exceeds replay buffer' (fail closed)", err)
	}

	req, err = RequestFromJS(ctx, buildFetchFacade("https://t.test/", "POST", nil, []byte("ignored"), true))
	if err != nil {
		t.Fatalf("bodyUsed POST: %v", err)
	}
	if req.ContentLength != 0 || req.GetBody != nil {
		t.Fatalf("bodyUsed POST: contentLength=%d getBody=%v, want 0/nil (body skipped)", req.ContentLength, req.GetBody != nil)
	}
}

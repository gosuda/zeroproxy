//go:build js && wasm

package swhttp

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"syscall/js"

	"github.com/gosuda/zeroproxy/internal/headers"
)

func RequestFromJS(ctx context.Context, v js.Value) (*http.Request, error) {
	rawURL := v.Get("url").String()
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	method := v.Get("method").String()
	if method == "" {
		method = "GET"
	}
	h := make(http.Header)
	forEach := js.FuncOf(func(this js.Value, args []js.Value) any {
		value := args[0].String()
		key := args[1].String()
		h.Add(key, value)
		return nil
	})
	v.Get("headers").Call("forEach", forEach)
	forEach.Release()
	var body io.ReadCloser = http.NoBody
	var contentLength int64 = 0
	if method != "GET" && method != "HEAD" && !v.Get("bodyUsed").Bool() {
		ab, err := await(ctx, v.Call("arrayBuffer"))
		if err != nil {
			return nil, err
		}
		arr := js.Global().Get("Uint8Array").New(ab)
		buf := make([]byte, arr.Get("byteLength").Int())
		js.CopyBytesToGo(buf, arr)
		body = io.NopCloser(bytes.NewReader(buf))
		contentLength = int64(len(buf))
	}
	return &http.Request{Method: method, URL: u, Header: h, Body: body, ContentLength: contentLength, Host: u.Host, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}, nil
}

func ResponseToJS(ctx context.Context, resp *http.Response, bodyTransformed, bodyDecoded bool) (js.Value, error) {
	if resp == nil {
		return js.Null(), fmt.Errorf("nil response")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return js.Null(), err
	}
	safe := headers.ConstructorPolicy(resp.Header, bodyTransformed, bodyDecoded)
	jsHeaders := js.Global().Get("Headers").New()
	for name, vals := range safe {
		for _, v := range vals {
			jsHeaders.Call("append", name, v)
		}
	}
	arr := js.Global().Get("Uint8Array").New(len(body))
	js.CopyBytesToJS(arr, body)
	init := map[string]any{"status": resp.StatusCode, "statusText": resp.Status, "headers": jsHeaders}
	return js.Global().Get("Response").New(arr, init), nil
}

func await(ctx context.Context, p js.Value) (js.Value, error) {
	type result struct {
		v   js.Value
		err error
	}
	ch := make(chan result, 1)
	then := js.FuncOf(func(this js.Value, args []js.Value) any { ch <- result{v: args[0]}; return nil })
	catch := js.FuncOf(func(this js.Value, args []js.Value) any { ch <- result{err: fmt.Errorf(args[0].String())}; return nil })
	p.Call("then", then).Call("catch", catch)
	defer then.Release()
	defer catch.Release()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-ctx.Done():
		return js.Null(), ctx.Err()
	}
}

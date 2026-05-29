//go:build js && wasm

package swhttp

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"syscall/js"

	"github.com/gosuda/zeroproxy/internal/headers"
)

func ContextWithAbortSignal(parent context.Context, v js.Value) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	signal := v.Get("signal")
	if !signal.Truthy() || signal.Get("addEventListener").Type() != js.TypeFunction {
		return ctx, cancel
	}
	var once sync.Once
	var listener js.Func
	cleanup := func() {
		once.Do(func() {
			if listener.Truthy() && signal.Get("removeEventListener").Type() == js.TypeFunction {
				signal.Call("removeEventListener", "abort", listener)
			}
			if listener.Truthy() {
				listener.Release()
			}
			cancel()
		})
	}
	listener = js.FuncOf(func(this js.Value, args []js.Value) any {
		cleanup()
		return nil
	})
	if signal.Get("aborted").Bool() {
		cleanup()
		return ctx, cleanup
	}
	signal.Call("addEventListener", "abort", listener, map[string]any{"once": true})
	return ctx, cleanup
}

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
		stream := v.Get("body")
		if stream.Truthy() && stream.Get("getReader").Type() == js.TypeFunction {
			body = newJSReadableStreamReadCloser(ctx, stream.Call("getReader"))
			contentLength = -1
			if h.Get("X-ZP-Upload-Replayable") == "1" {
				buf, err := io.ReadAll(io.LimitReader(body, 1024*1024+1))
				_ = body.Close()
				if err != nil {
					return nil, err
				}
				if len(buf) > 1024*1024 {
					return nil, fmt.Errorf("request body exceeds replay buffer")
				}
				body = io.NopCloser(bytes.NewReader(buf))
				contentLength = int64(len(buf))
				getBody := func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(buf)), nil }
				return &http.Request{Method: method, URL: u, Header: h, Body: body, GetBody: getBody, ContentLength: contentLength, Host: u.Host, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}, nil
			}
		}
	}
	return &http.Request{Method: method, URL: u, Header: h, Body: body, ContentLength: contentLength, Host: u.Host, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}, nil
}

type jsReadableStreamReadCloser struct {
	ctx    context.Context
	reader js.Value
	buf    []byte
	once   sync.Once
	closed bool
}

func newJSReadableStreamReadCloser(ctx context.Context, reader js.Value) *jsReadableStreamReadCloser {
	return &jsReadableStreamReadCloser{ctx: ctx, reader: reader}
}

func (r *jsReadableStreamReadCloser) Read(p []byte) (int, error) {
	if r.closed {
		return 0, io.EOF
	}
	for len(r.buf) == 0 {
		chunk, err := await(r.ctx, r.reader.Call("read"))
		if err != nil {
			return 0, err
		}
		if chunk.Get("done").Bool() {
			r.closed = true
			return 0, io.EOF
		}
		value := chunk.Get("value")
		if value.IsUndefined() || value.IsNull() {
			continue
		}
		var arr js.Value
		if value.InstanceOf(js.Global().Get("ArrayBuffer")) {
			arr = js.Global().Get("Uint8Array").New(value)
		} else if value.Get("buffer").Truthy() {
			arr = js.Global().Get("Uint8Array").New(value.Get("buffer"), value.Get("byteOffset"), value.Get("byteLength"))
		} else {
			continue
		}
		r.buf = make([]byte, arr.Get("byteLength").Int())
		js.CopyBytesToGo(r.buf, arr)
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}

func (r *jsReadableStreamReadCloser) Close() error {
	r.once.Do(func() {
		r.closed = true
		if r.reader.Truthy() {
			if r.reader.Get("cancel").Type() == js.TypeFunction {
				r.reader.Call("cancel")
			}
			if r.reader.Get("releaseLock").Type() == js.TypeFunction {
				r.reader.Call("releaseLock")
			}
		}
	})
	return nil
}

func ResponseToJS(ctx context.Context, resp *http.Response, bodyTransformed, bodyDecoded bool) (js.Value, error) {
	if resp == nil {
		return js.Null(), fmt.Errorf("nil response")
	}
	safe := headers.ConstructorPolicy(resp.Header, bodyTransformed, bodyDecoded)
	jsHeaders := js.Global().Get("Headers").New()
	for name, vals := range safe {
		for _, v := range vals {
			jsHeaders.Call("append", name, v)
		}
	}
	var bodyArg any = js.Null()
	if responseMayHaveBody(resp.StatusCode) && resp.Body != nil {
		bodyArg = readableStreamFrom(ctx, resp.Body)
	} else if resp.Body != nil {
		_ = resp.Body.Close()
	}
	init := map[string]any{"status": resp.StatusCode, "statusText": http.StatusText(resp.StatusCode), "headers": jsHeaders}
	return js.Global().Get("Response").New(bodyArg, init), nil
}

func readableStreamFrom(ctx context.Context, body io.ReadCloser) js.Value {
	source := js.Global().Get("Object").New()
	var start js.Func
	var cancel js.Func
	var closeOnce sync.Once
	var cleanupOnce sync.Once
	cancelled := make(chan struct{})
	closeBody := func() {
		closeOnce.Do(func() {
			close(cancelled)
			_ = body.Close()
		})
	}
	cleanup := func() {
		cleanupOnce.Do(func() {
			start.Release()
			cancel.Release()
		})
	}
	start = js.FuncOf(func(this js.Value, args []js.Value) any {
		controller := args[0]
		go func() {
			defer cleanup()
			defer closeBody()
			buf := make([]byte, 32*1024)
			for {
				select {
				case <-ctx.Done():
					controller.Call("error", js.Global().Get("Error").New(ctx.Err().Error()))
					return
				case <-cancelled:
					return
				default:
				}
				n, err := body.Read(buf)
				if n > 0 {
					arr := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(arr, buf[:n])
					controller.Call("enqueue", arr)
				}
				if err != nil {
					select {
					case <-cancelled:
						return
					default:
					}
					if err == io.EOF {
						controller.Call("close")
					} else {
						controller.Call("error", js.Global().Get("Error").New(err.Error()))
					}
					return
				}
			}
		}()
		return nil
	})
	cancel = js.FuncOf(func(this js.Value, args []js.Value) any {
		closeBody()
		return nil
	})
	source.Set("start", start)
	source.Set("cancel", cancel)
	return js.Global().Get("ReadableStream").New(source)
}

func await(ctx context.Context, p js.Value) (js.Value, error) {
	type result struct {
		v   js.Value
		err error
	}
	ch := make(chan result, 1)
	then := js.FuncOf(func(this js.Value, args []js.Value) any { ch <- result{v: args[0]}; return nil })
	catch := js.FuncOf(func(this js.Value, args []js.Value) any {
		ch <- result{err: fmt.Errorf("%s", args[0].String())}
		return nil
	})
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

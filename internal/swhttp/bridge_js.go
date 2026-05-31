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

// RequestFromJS reconstructs an *http.Request from the JS fetch facade (method,
// headers, body). It is the membrane's boundary parser: header construction and
// body extraction are delegated to jsHeaders and extractRequestBody.
func RequestFromJS(ctx context.Context, v js.Value) (*http.Request, error) {
	u, err := url.Parse(v.Get("url").String())
	if err != nil {
		return nil, err
	}
	method := v.Get("method").String()
	if method == "" {
		method = "GET"
	}
	h := jsHeaders(v.Get("headers"))
	body, contentLength, getBody, err := extractRequestBody(ctx, v, method, h)
	if err != nil {
		return nil, err
	}
	return &http.Request{
		Method: method, URL: u, Header: h,
		Body: body, GetBody: getBody, ContentLength: contentLength,
		Host: u.Host, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
	}, nil
}

// jsHeaders reconstructs an http.Header from the JS fetch facade's Headers
// object, whose forEach callback yields (value, key).
func jsHeaders(headers js.Value) http.Header {
	h := make(http.Header)
	forEach := js.FuncOf(func(this js.Value, args []js.Value) any {
		value := args[0].String()
		key := args[1].String()
		h.Add(key, value)
		return nil
	})
	headers.Call("forEach", forEach)
	forEach.Release()
	return h
}

// extractRequestBody reads the JS fetch facade's body for methods that carry one.
// It returns http.NoBody for body-less requests, a streaming reader (ContentLength
// -1, no GetBody) for a normal upload, or — when the client marks the upload
// replayable — a buffered reader plus a GetBody the redirect path can replay. The
// 1 MiB cap bounds the replay buffer, and the buffering happens here, before the
// first RoundTrip consumes the stream (the redirect replay depends on it).
func extractRequestBody(ctx context.Context, v js.Value, method string, h http.Header) (io.ReadCloser, int64, func() (io.ReadCloser, error), error) {
	if method == "GET" || method == "HEAD" || v.Get("bodyUsed").Bool() {
		return http.NoBody, 0, nil, nil
	}
	stream := v.Get("body")
	if !stream.Truthy() || stream.Get("getReader").Type() != js.TypeFunction {
		return http.NoBody, 0, nil, nil
	}
	body := newJSReadableStreamReadCloser(ctx, stream.Call("getReader"))
	if h.Get("X-ZP-Upload-Replayable") != "1" {
		return body, -1, nil, nil
	}
	buf, err := io.ReadAll(io.LimitReader(body, 1024*1024+1))
	_ = body.Close()
	if err != nil {
		return nil, 0, nil, err
	}
	if len(buf) > 1024*1024 {
		return nil, 0, nil, fmt.Errorf("request body exceeds replay buffer")
	}
	getBody := func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(buf)), nil }
	return io.NopCloser(bytes.NewReader(buf)), int64(len(buf)), getBody, nil
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

func ResponseToJS(ctx context.Context, resp *http.Response, bodyTransformed, bodyDecoded, challengeCompat bool) (js.Value, error) {
	if resp == nil {
		return js.Null(), fmt.Errorf("nil response")
	}
	safe := headers.ConstructorPolicy(resp.Header, bodyTransformed, bodyDecoded, challengeCompat)
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
			pumpBody(ctx, controller, body, cancelled)
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

// pumpBody reads body in 32 KiB chunks and enqueues them on the JS stream
// controller until the context is cancelled, the consumer cancels (cancelled
// closed), or the body ends.
func pumpBody(ctx context.Context, controller js.Value, body io.Reader, cancelled <-chan struct{}) {
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
			enqueueChunk(controller, buf[:n])
		}
		if err != nil {
			finishStream(controller, err, cancelled)
			return
		}
	}
}

// enqueueChunk copies one chunk into a JS Uint8Array and enqueues it on the
// stream controller.
func enqueueChunk(controller js.Value, chunk []byte) {
	arr := js.Global().Get("Uint8Array").New(len(chunk))
	js.CopyBytesToJS(arr, chunk)
	controller.Call("enqueue", arr)
}

// finishStream terminates the JS stream after a read error: a cancel that raced
// the error is honored silently, EOF closes the stream, and any other error
// errors it.
func finishStream(controller js.Value, err error, cancelled <-chan struct{}) {
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

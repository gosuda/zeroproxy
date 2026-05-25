//go:build js && wasm

package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/htmltx"
	"github.com/gosuda/zeroproxy/internal/swhttp"
	"github.com/gosuda/zeroproxy/internal/wsconn"
	"github.com/gosuda/zeroproxy/internal/wsproto"
	"github.com/gosuda/zeroproxy/internal/yamuxconn"
	"github.com/gosuda/zeroproxy/internal/zphttp"
)

type Kernel struct {
	mu     sync.Mutex
	engine *zphttp.Engine
	tabs   map[string]*zphttp.TabState
}

func NewKernel() *Kernel { return &Kernel{tabs: make(map[string]*zphttp.TabState)} }

func main() {
	k := NewKernel()
	js.Global().Set("__go_jshttp", js.FuncOf(k.jsHTTP))
	js.Global().Set("__zp_stream", js.FuncOf(k.jsStream))
	js.Global().Set("__zp_kernel_init", js.FuncOf(k.jsInit))
	js.Global().Set("__zp_cookie_set", js.FuncOf(k.jsCookieSet))
	js.Global().Set("__zp_kernel_ready", true)
	select {}
}

func (k *Kernel) ensure(ctx context.Context) error {
	k.mu.Lock()
	ready := k.engine != nil
	if ready {
		if closable, ok := k.engine.Mux.(interface{ IsClosed() bool }); ok && closable.IsClosed() {
			k.engine = nil
			ready = false
		}
	}
	k.mu.Unlock()
	if ready {
		return nil
	}
	loc := js.Global().Get("self").Get("location")
	proto := "ws:"
	if loc.Get("protocol").String() == "https:" {
		proto = "wss:"
	}
	raw := proto + "//" + loc.Get("host").String() + "/__zp/ws-pipe"
	conn, err := wsconn.Dial(ctx, raw)
	if err != nil {
		return err
	}
	sess, err := yamuxconn.Client(conn)
	if err != nil {
		_ = conn.Close()
		return err
	}
	k.mu.Lock()
	if k.engine == nil {
		k.engine = &zphttp.Engine{Mux: sess}
		sess = nil
	}
	k.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
	}
	return nil
}

func (k *Kernel) jsInit(this js.Value, args []js.Value) any {
	return promise(func(resolve, reject js.Value) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := k.ensure(ctx); err != nil {
			reject.Invoke(jsError("TARGET_CONNECT_FAILED"))
			return
		}
		resolve.Invoke(true)
	})
}

func (k *Kernel) jsCookieSet(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return false
	}
	v := args[0]
	rawURL := v.Get("targetUrl").String()
	cookieLine := v.Get("cookie").String()
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	tab := k.tabFromValues(v.Get("tabId").String(), v.Get("streamIsolationKey").String())
	tab.CookieJar.SetDocumentCookie(u, cookieLine)
	return true
}

func (k *Kernel) jsHTTP(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return rejected("BAD_REQUEST")
	}
	reqv := args[0]
	return promise(func(resolve, reject js.Value) {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		releaseOnReturn := true
		defer func() {
			if releaseOnReturn {
				cancel()
			}
		}()
		if err := k.ensure(ctx); err != nil {
			resolve.Invoke(safeResponse("TARGET_CONNECT_FAILED", http.StatusBadGateway))
			return
		}
		req, err := swhttp.RequestFromJS(ctx, reqv)
		if err != nil {
			resolve.Invoke(safeResponse("MALFORMED_ROUTE", http.StatusBadRequest))
			return
		}
		if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
			resolve.Invoke(safeResponse("TARGET_PROTOCOL_BLOCKED", http.StatusForbidden, req.URL.Host))
			return
		}
		tab := k.tabFor(req)
		resp, finalURL, err := k.engine.Do(ctx, req, req.URL, tab)
		if err != nil {
			resolve.Invoke(safeResponse(classifyErr(err), statusForErr(err), req.URL.Host))
			return
		}
		if tab.CookieJar != nil {
			tab.CookieJar.SetCookies(finalURL, resp.Cookies())
		}
		transformed := false
		decoded := false
		if isDocumentRequest(req) && isHTML(resp.Header.Get("Content-Type")) {
			source := resp.Body
			if source == nil {
				source = http.NoBody
			}
			pr, pw := io.Pipe()
			go func() {
				err := htmltx.TransformTo(pw, source, htmltx.Options{TabID: tab.TabID, EntryID: req.Header.Get("X-Zp-Entry-Id"), TargetURL: finalURL, DocumentCookie: tab.CookieJar.DocumentCookie(finalURL), RuntimeToken: req.Header.Get("X-Zp-Runtime-Token")})
				closeErr := source.Close()
				if err != nil {
					_ = pw.CloseWithError(err)
					return
				}
				if closeErr != nil {
					_ = pw.CloseWithError(closeErr)
					return
				}
				_ = pw.Close()
			}()
			resp.Body = &closeWithSource{ReadCloser: pr, source: source}
			resp.ContentLength = -1
			resp.Header.Del("Content-Length")
			resp.Header.Del("Content-Encoding")
			resp.Header.Set("Content-Type", "text/html; charset=utf-8")
			transformed = true
			decoded = true
		}
		resp.Header = headers.ConstructorPolicy(resp.Header, transformed, decoded)
		if resp.Body != nil {
			resp.Body = &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
			releaseOnReturn = false
		}
		jsResp, err := swhttp.ResponseToJS(ctx, resp, transformed, decoded)
		if err != nil {
			if resp.Body != nil {
				_ = resp.Body.Close()
			}
			releaseOnReturn = true
			resolve.Invoke(safeResponse("TARGET_CONNECT_FAILED", http.StatusBadGateway, finalURL.Host))
			return
		}
		resolve.Invoke(jsResp)
	})
}

func (k *Kernel) jsStream(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return rejected("BAD_REQUEST")
	}
	opts := args[0]
	return promise(func(resolve, reject js.Value) {
		ctx, cancel := context.WithCancel(context.Background())
		if err := k.ensure(ctx); err != nil {
			cancel()
			reject.Invoke(jsError("TARGET_CONNECT_FAILED"))
			return
		}
		rawURL := opts.Get("url").String()
		u, err := url.Parse(rawURL)
		if err != nil {
			cancel()
			reject.Invoke(jsError("MALFORMED_ROUTE"))
			return
		}
		protocols := jsStringArray(opts.Get("protocols"))
		tab := k.tabFromValues(opts.Get("tabId").String(), opts.Get("streamIsolationKey").String())
		conn, resp, err := wsproto.Dial(ctx, k.engine, u, protocols, tab)
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if err != nil {
			cancel()
			reject.Invoke(jsError(classifyErr(err)))
			return
		}
		stream := newJSWebSocketStream(ctx, cancel, conn)
		resolve.Invoke(stream)
	})
}

func (k *Kernel) tabFor(req *http.Request) *zphttp.TabState {
	return k.tabFromValues(req.Header.Get("X-Zp-Tab-Id"), req.Header.Get("X-Zp-Stream-Isolation-Key"))
}

func (k *Kernel) tabFromValues(tabID, keyB64 string) *zphttp.TabState {
	if tabID == "" {
		tabID = "default"
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if t := k.tabs[tabID]; t != nil {
		return t
	}
	key, _ := base64.RawURLEncoding.DecodeString(keyB64)
	if len(key) == 0 {
		key = make([]byte, 32)
		_, _ = rand.Read(key)
	}
	t := &zphttp.TabState{TabID: tabID, CookieJar: cookiejar.New(), StreamIsolationKey: key}
	k.tabs[tabID] = t
	return t
}

func newJSWebSocketStream(ctx context.Context, cancel context.CancelFunc, conn *wsproto.Conn) js.Value {
	handlers := js.Value{}
	obj := js.Global().Get("Object").New()
	obj.Set("setHandlers", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) > 0 {
			handlers = args[0]
		}
		return nil
	}))
	obj.Set("send", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}
		data, binary := jsPayload(args[0])
		op := byte(wsproto.OpText)
		if binary {
			op = wsproto.OpBinary
		}
		if err := conn.WriteFrame(op, data); err != nil && handlers.Truthy() {
			callHandler(handlers, "error", jsError("TARGET_CONNECT_FAILED"))
		}
		return nil
	}))
	obj.Set("close", js.FuncOf(func(this js.Value, args []js.Value) any { cancel(); _ = conn.Close(); return nil }))
	go func() {
		defer cancel()
		defer conn.Close()
		for {
			op, payload, err := conn.ReadFrame(ctx)
			if err != nil {
				if handlers.Truthy() {
					callHandler(handlers, "error", jsError("TARGET_CONNECT_FAILED"))
				}
				return
			}
			if !handlers.Truthy() {
				continue
			}
			if op == wsproto.OpClose {
				callHandler(handlers, "close", js.Null())
				return
			}
			if op == wsproto.OpText {
				callHandler(handlers, "message", string(payload))
				continue
			}
			arr := js.Global().Get("Uint8Array").New(len(payload))
			js.CopyBytesToJS(arr, payload)
			callHandler(handlers, "message", arr.Get("buffer"))
		}
	}()
	return obj
}

func promise(fn func(resolve, reject js.Value)) js.Value {
	return js.Global().Get("Promise").New(js.FuncOf(func(this js.Value, args []js.Value) any { go fn(args[0], args[1]); return nil }))
}
func rejected(msg string) js.Value {
	return promise(func(resolve, reject js.Value) { reject.Invoke(jsError(msg)) })
}
func jsError(msg string) js.Value { return js.Global().Get("Error").New(msg) }
func callHandler(h js.Value, name string, arg any) {
	f := h.Get(name)
	if f.Truthy() {
		f.Invoke(arg)
	}
}

func jsStringArray(v js.Value) []string {
	if !v.Truthy() {
		return nil
	}
	out := make([]string, 0, v.Get("length").Int())
	for i := 0; i < v.Get("length").Int(); i++ {
		out = append(out, v.Index(i).String())
	}
	return out
}
func jsPayload(v js.Value) ([]byte, bool) {
	if v.Type() == js.TypeString {
		return []byte(v.String()), false
	}
	if v.InstanceOf(js.Global().Get("ArrayBuffer")) {
		arr := js.Global().Get("Uint8Array").New(v)
		b := make([]byte, arr.Get("byteLength").Int())
		js.CopyBytesToGo(b, arr)
		return b, true
	}
	if v.Get("buffer").Truthy() {
		arr := js.Global().Get("Uint8Array").New(v.Get("buffer"))
		b := make([]byte, arr.Get("byteLength").Int())
		js.CopyBytesToGo(b, arr)
		return b, true
	}
	return []byte(fmt.Sprint(v)), false
}

func safeResponse(code string, status int, host ...string) js.Value {
	hostText := ""
	if len(host) > 0 && host[0] != "" {
		hostText = `<p>Target host: ` + htmlEscape(host[0]) + `</p>`
	}
	body := `<!doctype html><meta charset="utf-8"><title>ZeroProxy ` + code + `</title><main><h1>ZeroProxy</h1><p>` + code + `</p>` + hostText + `<button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>`
	h := js.Global().Get("Headers").New()
	h.Call("set", "Content-Type", "text/html; charset=utf-8")
	h.Call("set", "Cache-Control", "no-store")
	h.Call("set", "X-Content-Type-Options", "nosniff")
	h.Call("set", "Access-Control-Allow-Origin", "*")
	h.Call("set", "Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
	h.Call("set", "Access-Control-Allow-Headers", "*")
	h.Call("set", "Access-Control-Expose-Headers", "*")
	return js.Global().Get("Response").New(body, map[string]any{"status": status, "headers": h})
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&#34;", "'", "&#39;").Replace(s)
}
func classifyErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
		return "TLS_CERTIFICATE_INVALID"
	case strings.Contains(s, "TARGET_PROTOCOL_BLOCKED"):
		return "TARGET_PROTOCOL_BLOCKED"
	case strings.Contains(s, "TLS_HANDSHAKE_FAILED"):
		return "TLS_HANDSHAKE_FAILED"
	case strings.Contains(s, "MALFORMED_HTML"):
		return "MALFORMED_HTML"
	case strings.Contains(s, "POLICY_BLOCKED"):
		return "POLICY_BLOCKED"
	default:
		return "TARGET_CONNECT_FAILED"
	}
}
func statusForErr(err error) int {
	c := classifyErr(err)
	if c == "TARGET_PROTOCOL_BLOCKED" || c == "POLICY_BLOCKED" {
		return http.StatusForbidden
	}
	return http.StatusBadGateway
}
func isHTML(ct string) bool {
	return strings.Contains(strings.ToLower(ct), "text/html") || strings.Contains(strings.ToLower(ct), "application/xhtml")
}
func isDocumentRequest(req *http.Request) bool { return req.Header.Get("X-Zp-Document-Request") == "1" }

type closeWithSource struct {
	io.ReadCloser
	source io.Closer
}

func (c *closeWithSource) Close() error {
	err := c.ReadCloser.Close()
	cerr := c.source.Close()
	if err != nil {
		return err
	}
	return cerr
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
	once   sync.Once
}

func (c *cancelReadCloser) Close() error {
	err := c.ReadCloser.Close()
	c.once.Do(c.cancel)
	return err
}

//go:build js && wasm

package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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
	mu           sync.Mutex
	engine       *zphttp.Engine
	engineServer string
	tabs         map[string]*zphttp.TabState
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

func (k *Kernel) ensure(ctx context.Context, servers []string) error {
	server := selectedRelayServer(servers)
	k.mu.Lock()
	ready := k.engine != nil && k.engineServer == server
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
	conn, err := wsconn.Dial(ctx, server)
	if err != nil {
		return err
	}
	sess, err := yamuxconn.Client(conn)
	if err != nil {
		_ = conn.Close()
		return err
	}
	k.mu.Lock()
	if k.engine == nil || k.engineServer != server {
		k.engine = &zphttp.Engine{Mux: sess}
		k.engineServer = server
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
		if err := k.ensure(ctx, jsServers(args)); err != nil {
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
		timeoutCtx, timeoutCancel := context.WithTimeout(context.Background(), 90*time.Second)
		ctx, abortCancel := swhttp.ContextWithAbortSignal(timeoutCtx, reqv)
		cancel := func() {
			abortCancel()
			timeoutCancel()
		}
		releaseOnReturn := true
		defer func() {
			if releaseOnReturn {
				cancel()
			}
		}()
		if err := k.ensure(ctx, requestServers(reqv)); err != nil {
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
		dynamicCompileAllowed := targetDynamicCompileAllowed(resp.Header)
		referrerPolicy := targetReferrerPolicy(resp.Header)
		if tab.CookieJar != nil && req.Header.Get("X-Zp-Fetch-Credentials") != "omit" {
			tab.CookieJar.SetCookies(finalURL, resp.Cookies())
			broadcastCookieSync(tab, finalURL)
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
				err := htmltx.TransformTo(pw, source, htmltx.Options{
					TabID:                 tab.TabID,
					EntryID:               req.Header.Get("X-Zp-Entry-Id"),
					TargetURL:             finalURL,
					DocumentCookie:        tab.CookieJar.DocumentCookie(finalURL),
					DocumentReferrer:      req.Header.Get("X-Zp-Document-Referrer"),
					RuntimeToken:          req.Header.Get("X-Zp-Runtime-Token"),
					Servers:               headerServers(req.Header.Get("X-Zp-Relay-Servers")),
					DynamicCompileAllowed: dynamicCompileAllowed,
					ReferrerPolicy:        referrerPolicy,
					ScriptRewriter:        rewriteScriptFromJS,
					CSSRewriter:           rewriteCSSFromJS,
				})
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
		if dynamicCompileAllowed {
			resp.Header.Set("X-ZP-Dynamic-Compile", "1")
		}
		resp.Header = headers.ConstructorPolicy(resp.Header, transformed, decoded)
		resp.Header.Set("X-ZP-Response-URL", finalURL.String())
		if finalURL.String() != req.URL.String() {
			resp.Header.Set("X-ZP-Response-Redirected", "1")
		} else {
			resp.Header.Set("X-ZP-Response-Redirected", "0")
		}
		if resp.Body != nil {
			body := &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
			resp.Body = body
			go func() {
				<-ctx.Done()
				_ = body.Close()
			}()
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

func broadcastCookieSync(tab *zphttp.TabState, targetURL *url.URL) {
	if tab == nil || tab.CookieJar == nil || targetURL == nil {
		return
	}
	fn := js.Global().Get("__zp_cookie_sync")
	if fn.Type() != js.TypeFunction {
		return
	}
	fn.Invoke(map[string]any{
		"tabId":         tab.TabID,
		"targetUrl":     targetURL.String(),
		"cookieString":  tab.CookieJar.DocumentCookie(targetURL),
		"cookieRecords": cookieRecordsForJS(tab.CookieJar.VisibleRecords(targetURL)),
	})
}

func cookieRecordsForJS(records []cookiejar.SnapshotRecord) []any {
	out := make([]any, 0, len(records))
	for _, r := range records {
		rec := map[string]any{
			"name":     r.Name,
			"value":    r.Value,
			"domain":   r.Domain,
			"hostOnly": r.HostOnly,
			"path":     r.Path,
			"secure":   r.Secure,
			"sameSite": r.SameSite,
		}
		if r.ExpiresMS != nil {
			rec["expiresMs"] = *r.ExpiresMS
		}
		out = append(out, rec)
	}
	return out
}

func rewriteScriptFromJS(source, kind, targetURL, controlPrefix string) (string, error) {
	rewriter := js.Global().Get("ZPRewriter")
	if !rewriter.Truthy() || rewriter.Get("rewriteScript").Type() != js.TypeFunction {
		return "", fmt.Errorf("REALM_INJECTION_FAILURE")
	}
	out := rewriter.Call("rewriteScript", source, map[string]any{
		"kind":          kind,
		"targetUrl":     targetURL,
		"controlPrefix": controlPrefix,
		"strict":        true,
	})
	if out.Truthy() && out.Get("ok").Bool() {
		return out.Get("code").String(), nil
	}
	return "", fmt.Errorf("REWRITE_FAILED")
}

func rewriteCSSFromJS(source, baseURL string) (string, error) {
	rewriter := js.Global().Get("ZPRewriter")
	if !rewriter.Truthy() || rewriter.Get("rewriteCSS").Type() != js.TypeFunction {
		return source, nil
	}
	out := rewriter.Call("rewriteCSS", source, map[string]any{
		"baseUrl":       baseURL,
		"controlPrefix": "/zp/",
	})
	if out.Truthy() && out.Get("ok").Bool() {
		return out.Get("code").String(), nil
	}
	return "", fmt.Errorf("CSS_REWRITE_FAILED")
}

func targetDynamicCompileAllowed(h http.Header) bool {
	policies := h.Values("Content-Security-Policy")
	if len(policies) == 0 {
		return true
	}
	for _, policy := range policies {
		if !cspPolicyAllowsEval(policy) {
			return false
		}
	}
	return true
}

func targetReferrerPolicy(h http.Header) string {
	for _, header := range h.Values("Referrer-Policy") {
		for _, part := range strings.Split(header, ",") {
			if policy := normalizeReferrerPolicy(part); policy != "" {
				return policy
			}
		}
	}
	return ""
}

func normalizeReferrerPolicy(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return ""
	}
}

func cspPolicyAllowsEval(policy string) bool {
	directives := parseCSPDirectives(policy)
	sources, ok := directives["script-src"]
	if !ok {
		sources, ok = directives["default-src"]
	}
	if !ok {
		return true
	}
	for _, source := range sources {
		if source == "'unsafe-eval'" || source == "unsafe-eval" {
			return true
		}
	}
	return false
}

func parseCSPDirectives(policy string) map[string][]string {
	out := make(map[string][]string)
	for _, raw := range strings.Split(policy, ";") {
		fields := strings.Fields(strings.TrimSpace(raw))
		if len(fields) == 0 {
			continue
		}
		name := strings.ToLower(fields[0])
		if _, exists := out[name]; exists {
			continue
		}
		values := make([]string, 0, len(fields)-1)
		for _, field := range fields[1:] {
			values = append(values, strings.ToLower(field))
		}
		out[name] = values
	}
	return out
}

func (k *Kernel) jsStream(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return rejected("BAD_REQUEST")
	}
	opts := args[0]
	return promise(func(resolve, reject js.Value) {
		ctx, cancel := context.WithCancel(context.Background())
		if err := k.ensure(ctx, jsServers(args)); err != nil {
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
		conn, resp, err := wsproto.Dial(ctx, k.engine, u, protocols, tab, websocketOrigin(opts.Get("documentUrl").String()))
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if err != nil {
			cancel()
			reject.Invoke(jsError(classifyErr(err)))
			return
		}
		stream := newJSWebSocketStream(ctx, cancel, conn)
		if resp != nil {
			stream.Set("protocol", resp.Header.Get("Sec-Websocket-Protocol"))
			if stream.Get("protocol").String() == "" {
				stream.Set("protocol", resp.Header.Get("Sec-WebSocket-Protocol"))
			}
		}
		resolve.Invoke(stream)
	})
}

func websocketOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func selectedRelayServer(servers []string) string {
	if len(servers) > 0 && servers[0] != "" {
		return servers[0]
	}
	loc := js.Global().Get("self").Get("location")
	proto := "ws:"
	if loc.Get("protocol").String() == "https:" {
		proto = "wss:"
	}
	return proto + "//" + loc.Get("host").String() + "/zp/ws-pipe"
}

func jsServers(args []js.Value) []string {
	if len(args) == 0 {
		return nil
	}
	v := args[0]
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	return jsStringArray(v.Get("servers"))
}

func requestServers(v js.Value) []string {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	headers := v.Get("headers")
	if headers.IsUndefined() || headers.IsNull() || headers.Get("get").Type() != js.TypeFunction {
		return nil
	}
	raw := headers.Call("get", "X-ZP-Relay-Servers")
	if raw.IsUndefined() || raw.IsNull() {
		raw = headers.Call("get", "X-Zp-Relay-Servers")
	}
	if raw.IsUndefined() || raw.IsNull() {
		return nil
	}
	return headerServers(raw.String())
}

func headerServers(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
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
	var start sync.Once
	obj := js.Global().Get("Object").New()
	readLoop := func() {
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
	}
	obj.Set("setHandlers", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) > 0 {
			handlers = args[0]
		}
		start.Do(func() { go readLoop() })
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
		arr := js.Global().Get("Uint8Array").New(v.Get("buffer"), v.Get("byteOffset"), v.Get("byteLength"))
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

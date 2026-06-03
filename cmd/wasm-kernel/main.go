//go:build js && wasm

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/gosuda/zeroproxy/internal/cookiejar"
	"github.com/gosuda/zeroproxy/internal/headers"
	"github.com/gosuda/zeroproxy/internal/htmltx"
	"github.com/gosuda/zeroproxy/internal/randbuf"
	"github.com/gosuda/zeroproxy/internal/smuxconn"
	"github.com/gosuda/zeroproxy/internal/swhttp"
	"github.com/gosuda/zeroproxy/internal/wsconn"
	"github.com/gosuda/zeroproxy/internal/wsproto"
	"github.com/gosuda/zeroproxy/internal/zphttp"
	"golang.org/x/net/html/charset"
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

//nolint:cyclop // TODO(complexity): kernel relay-ensure (cyclop 11); lazily establishes/validates the relay set the wasm kernel routes through. Membrane bootstrap; needs dedicated differential-harness decomposition.
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
	sess, err := smuxconn.Client(conn)
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
		releaseOnReturn = deliverResponse(ctx, resolve, req, resp, finalURL, tab, cancel)
	})
}

// deliverResponse runs the post-fetch half of the bridge on an already-fetched
// response: cookie capture, document transform, policy header shaping,
// body-cancellation ownership, and the final ResponseToJS marshal +
// resolve. It returns the resolved releaseOnReturn ownership flag (false once the
// response body's cancel goroutine owns teardown, true again if ResponseToJS
// fails and the body is closed here). Taking the response as an argument keeps it
// drivable without the engine; it uses no Kernel state.
func deliverResponse(ctx context.Context, resolve js.Value, req *http.Request, resp *http.Response, finalURL *url.URL, tab *zphttp.TabState, cancel func()) bool {
	releaseOnReturn := true
	dynamicCompileAllowed := targetDynamicCompileAllowed(resp.Header)
	referrerPolicy := targetReferrerPolicy(resp.Header)
	if tab.CookieJar != nil && req.Header.Get("X-Zp-Fetch-Credentials") != "omit" {
		tab.CookieJar.SetCookies(finalURL, resp.Cookies())
		broadcastCookieSync(tab, finalURL)
	}
	transformed, decoded := transformDocumentResponse(req, resp, tab, finalURL, dynamicCompileAllowed, referrerPolicy)
	applyResponsePolicy(resp, req, finalURL, dynamicCompileAllowed, transformed, decoded)
	if installBodyCancellation(ctx, resp, cancel) {
		releaseOnReturn = false
	}
	jsResp, err := swhttp.ResponseToJS(ctx, resp, transformed, decoded)
	if err != nil {
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
		releaseOnReturn = true
		resolve.Invoke(safeResponse("TARGET_CONNECT_FAILED", http.StatusBadGateway, finalURL.Host))
		return releaseOnReturn
	}
	resolve.Invoke(jsResp)
	return releaseOnReturn
}

// transformDocumentResponse rewrites an HTML document response through the htmltx
// membrane (streamed via an io.Pipe goroutine), replacing resp.Body and the
// content headers in place. It reports whether the body was transformed and
// decoded; a non-document or non-HTML response is left untouched.
func transformDocumentResponse(req *http.Request, resp *http.Response, tab *zphttp.TabState, finalURL *url.URL, dynamicCompileAllowed bool, referrerPolicy string) (transformed, decoded bool) {
	if !isDocumentRequest(req) || !isHTML(resp.Header.Get("Content-Type")) {
		return false, false
	}
	source := resp.Body
	if source == nil {
		source = http.NoBody
	}
	decodedSource, err := charset.NewReader(source, resp.Header.Get("Content-Type"))
	if err != nil {
		decodedSource = source
	}
	docCharset := responseCharset(resp.Header.Get("Content-Type"))
	pr, pw := io.Pipe()
	go func() {
		err := htmltx.TransformTo(pw, decodedSource, htmltx.Options{
			TabID:                 tab.TabID,
			EntryID:               req.Header.Get("X-Zp-Entry-Id"),
			TargetURL:             finalURL,
			DocumentCookie:        tab.CookieJar.DocumentCookie(finalURL),
			DocumentReferrer:      req.Header.Get("X-Zp-Document-Referrer"),
			RuntimeToken:          req.Header.Get("X-Zp-Runtime-Token"),
			Servers:               headerServers(req.Header.Get("X-Zp-Relay-Servers")),
			DynamicCompileAllowed: dynamicCompileAllowed,
			ReferrerPolicy:        referrerPolicy,
			DocumentCharset:       docCharset,
			DocumentRewriter:      rewriteHTMLDocumentFromJS,
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
	return true, true
}

func responseCharset(contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(params["charset"])
}

// applyResponsePolicy stamps the response-shaping headers after transform: the
// dynamic-compile signal, the ConstructorPolicy strip, and the response-URL /
// redirect markers.
func applyResponsePolicy(resp *http.Response, req *http.Request, finalURL *url.URL, dynamicCompileAllowed, transformed, decoded bool) {
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
}

// installBodyCancellation wraps resp.Body so a context cancellation closes it,
// transferring teardown ownership to the body's lifetime. It reports whether the
// wrap happened (a nil body leaves ownership with the caller's deferred cancel).
func installBodyCancellation(ctx context.Context, resp *http.Response, cancel func()) bool {
	if resp.Body == nil {
		return false
	}
	body := &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
	resp.Body = body
	go func() {
		<-ctx.Done()
		_ = body.Close()
	}()
	return true
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

func rewriteHTMLDocumentFromJS(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers []string) (string, error) {
	rewriter := js.Global().Get("ZPRewriter")
	if !rewriter.Truthy() || rewriter.Get("rewriteHTMLDocument").Type() != js.TypeFunction {
		return "", fmt.Errorf("HTML_DOCUMENT_REWRITE_UNAVAILABLE")
	}
	out := rewriter.Call("rewriteHTMLDocument", source, map[string]any{
		"targetUrl":     targetURL,
		"controlPrefix": controlPrefix,
		"prelude":       runtimePrelude,
		"tabId":         tabID,
		"runtimeToken":  runtimeToken,
		"servers":       stringsForJS(servers),
	})
	if out.Truthy() && out.Get("ok").Bool() {
		return out.Get("code").String(), nil
	}
	return "", fmt.Errorf("HTML_DOCUMENT_REWRITE_FAILED")
}

func stringsForJS(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
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
		_ = randbuf.ReadFull(key)
	}
	t := &zphttp.TabState{TabID: tabID, CookieJar: cookiejar.New(), StreamIsolationKey: key}
	k.tabs[tabID] = t
	return t
}

// dispatchInboundFrame delivers one frame read from the relay to the JS handlers
// and reports whether the read loop should stop. A read error (handlers, when set,
// receive an "error") and an OpClose both terminate; a text frame delivers a
// string and a binary frame an ArrayBuffer, both letting the loop continue.
func dispatchInboundFrame(handlers js.Value, op byte, payload []byte, err error) (stop bool) {
	if err != nil {
		if handlers.Truthy() {
			callHandler(handlers, "error", jsError("TARGET_CONNECT_FAILED"))
		}
		return true
	}
	if op == wsproto.OpClose {
		callHandler(handlers, "close", js.Null())
		return true
	}
	if op == wsproto.OpText {
		callHandler(handlers, "message", string(payload))
		return false
	}
	arr := js.Global().Get("Uint8Array").New(len(payload))
	js.CopyBytesToJS(arr, payload)
	callHandler(handlers, "message", arr.Get("buffer"))
	return false
}

// runReadLoop pumps frames from readFrame, dispatching each to the current JS
// handlers (read live via getHandlers, since the JS side may install them after
// the loop has started) until a frame signals stop.
func runReadLoop(ctx context.Context, getHandlers func() js.Value, readFrame func(context.Context) (byte, []byte, error)) {
	for {
		op, payload, err := readFrame(ctx)
		if dispatchInboundFrame(getHandlers(), op, payload, err) {
			return
		}
	}
}

func newJSWebSocketStream(ctx context.Context, cancel context.CancelFunc, conn *wsproto.Conn) js.Value {
	handlers := js.Value{}
	var start sync.Once
	obj := js.Global().Get("Object").New()
	readLoop := func() {
		defer cancel()
		defer conn.Close()
		runReadLoop(ctx, func() js.Value { return handlers }, conn.ReadFrame)
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

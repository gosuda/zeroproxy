//go:build js && wasm

package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"syscall/js"
	"testing"
)

func jsObject(fields map[string]any) js.Value {
	obj := js.Global().Get("Object").New()
	for k, v := range fields {
		obj.Set(k, v)
	}
	return obj
}

func jsStringList(values ...string) js.Value {
	arr := js.Global().Get("Array").New(len(values))
	for i, v := range values {
		arr.SetIndex(i, v)
	}
	return arr
}

func jsPairs(pairs ...[2]string) js.Value {
	arr := js.Global().Get("Array").New(len(pairs))
	for i, pair := range pairs {
		item := js.Global().Get("Array").New(2)
		item.SetIndex(0, pair[0])
		item.SetIndex(1, pair[1])
		arr.SetIndex(i, item)
	}
	return arr
}

func TestKernelCookieBridgeAndBroadcastShape(t *testing.T) {
	k := NewKernel()
	target, err := url.Parse("https://target.example/app/page.html")
	if err != nil {
		t.Fatal(err)
	}
	key := base64RawURLEncoded(bytes.Repeat([]byte{7}, 32))

	cookieRecord := jsObject(map[string]any{
		"tabId":              "tab-a",
		"targetUrl":          target.String(),
		"cookie":             "sid=abc; Path=/app; SameSite=Lax",
		"streamIsolationKey": key,
	})
	if got := k.jsCookieSet(js.Undefined(), []js.Value{cookieRecord}); got != true {
		t.Fatalf("jsCookieSet(valid) = %v, want true", got)
	}
	if got := k.tabFromValues("tab-a", key).CookieJar.DocumentCookie(target); got != "sid=abc" {
		t.Fatalf("DocumentCookie = %q, want sid=abc", got)
	}

	badRecord := jsObject(map[string]any{"targetUrl": "data:text/plain,x", "cookie": "x=1"})
	if got := k.jsCookieSet(js.Undefined(), []js.Value{badRecord}); got != false {
		t.Fatalf("jsCookieSet(non-http target) = %v, want false", got)
	}
	if got := k.jsCookieSet(js.Undefined(), nil); got != false {
		t.Fatalf("jsCookieSet(no args) = %v, want false", got)
	}

	oldSync := js.Global().Get("__zp_cookie_sync")
	var captured js.Value
	syncFn := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			captured = args[0]
		}
		return nil
	})
	js.Global().Set("__zp_cookie_sync", syncFn)
	defer func() {
		js.Global().Set("__zp_cookie_sync", oldSync)
		syncFn.Release()
	}()

	broadcastCookieSync(k.tabFromValues("tab-a", key), target)
	if captured.IsUndefined() || captured.IsNull() {
		t.Fatal("broadcastCookieSync did not invoke __zp_cookie_sync")
	}
	if got := captured.Get("tabId").String(); got != "tab-a" {
		t.Fatalf("sync tabId = %q, want tab-a", got)
	}
	if got := captured.Get("targetUrl").String(); got != target.String() {
		t.Fatalf("sync targetUrl = %q, want %q", got, target.String())
	}
	if got := captured.Get("cookieString").String(); got != "sid=abc" {
		t.Fatalf("sync cookieString = %q, want sid=abc", got)
	}
	records := captured.Get("cookieRecords")
	if got := records.Get("length").Int(); got != 1 {
		t.Fatalf("sync cookieRecords length = %d, want 1", got)
	}
	rec := records.Index(0)
	if rec.Get("name").String() != "sid" || rec.Get("value").String() != "abc" || rec.Get("sameSite").String() != "Lax" {
		t.Fatalf("sync cookie record = name:%q value:%q sameSite:%q", rec.Get("name").String(), rec.Get("value").String(), rec.Get("sameSite").String())
	}
}

func TestKernelRelayServerParsing(t *testing.T) {
	parsedServers := headerServers(`["wss://relay-a.example/ws","wss://relay-b.example/ws"]`)
	if len(parsedServers) != 2 || parsedServers[0] != "wss://relay-a.example/ws" || parsedServers[1] != "wss://relay-b.example/ws" {
		t.Fatalf("headerServers parsed %v", parsedServers)
	}
	if got := headerServers(`not-json`); got != nil {
		t.Fatalf("headerServers(invalid) = %v, want nil", got)
	}

	req := js.Global().Get("Request").New("https://target.example/", jsObject(map[string]any{
		"headers": jsObject(map[string]any{"X-ZP-Relay-Servers": `["wss://relay.example/ws"]`}),
	}))
	servers := requestServers(req)
	if len(servers) != 1 || servers[0] != "wss://relay.example/ws" {
		t.Fatalf("requestServers = %v, want relay header", servers)
	}

	args := []js.Value{jsObject(map[string]any{"servers": jsStringList("wss://configured.example/ws")})}
	servers = jsServers(args)
	if len(servers) != 1 || servers[0] != "wss://configured.example/ws" {
		t.Fatalf("jsServers = %v, want configured server", servers)
	}
}

func TestKernelSafeResponseAndErrorClasses(t *testing.T) {
	resp := safeResponse("TARGET_PROTOCOL_BLOCKED", http.StatusForbidden, `bad.example/"<&>`)
	if got := resp.Get("status").Int(); got != http.StatusForbidden {
		t.Fatalf("safeResponse status = %d, want %d", got, http.StatusForbidden)
	}
	if got := resp.Get("headers").Call("get", "X-Content-Type-Options").String(); got != "nosniff" {
		t.Fatalf("safeResponse nosniff = %q", got)
	}
	textValue, ok := deliverAwait(resp.Call("text"))
	if !ok {
		t.Fatal("safeResponse text promise rejected")
	}
	text := textValue.String()
	for _, want := range []string{"ZeroProxy TARGET_PROTOCOL_BLOCKED", "Target host: bad.example/&#34;&lt;&amp;&gt;"} {
		if !strings.Contains(text, want) {
			t.Fatalf("safeResponse body missing %q in %q", want, text)
		}
	}

	cases := []struct {
		err        error
		wantClass  string
		wantStatus int
	}{
		{errors.New("x509: certificate signed by unknown authority"), "TLS_CERTIFICATE_INVALID", http.StatusBadGateway},
		{errors.New("TARGET_PROTOCOL_BLOCKED: ftp"), "TARGET_PROTOCOL_BLOCKED", http.StatusForbidden},
		{errors.New("TLS_HANDSHAKE_FAILED: eof"), "TLS_HANDSHAKE_FAILED", http.StatusBadGateway},
		{errors.New("MALFORMED_HTML: bad token"), "MALFORMED_HTML", http.StatusBadGateway},
		{errors.New("POLICY_BLOCKED: denied"), "POLICY_BLOCKED", http.StatusForbidden},
		{errors.New("dial tcp timeout"), "TARGET_CONNECT_FAILED", http.StatusBadGateway},
	}
	for _, tc := range cases {
		if got := classifyErr(tc.err); got != tc.wantClass {
			t.Fatalf("classifyErr(%q) = %q, want %q", tc.err, got, tc.wantClass)
		}
		if got := statusForErr(tc.err); got != tc.wantStatus {
			t.Fatalf("statusForErr(%q) = %d, want %d", tc.err, got, tc.wantStatus)
		}
	}
}

func TestKernelSanitizerBridgeShape(t *testing.T) {
	k := NewKernel()
	out, ok := k.jsSanitizeHTML(js.Undefined(), []js.Value{jsObject(map[string]any{
		"docId":     "doc-bridge",
		"targetUrl": "https://target.example/app/",
		"finalUrl":  "https://target.example/app/",
		"html":      `<link rel="preload" href="/font.woff2"><img src="/img.png"><script>globalThis.ok = true;</script>`,
		"headers":   jsPairs([2]string{"Link", `</hint.css>; rel=preload`}),
	})}).(js.Value)
	if !ok || out.Get("error").Truthy() {
		t.Fatalf("jsSanitizeHTML returned error: %#v", out)
	}
	if got := out.Get("docId").String(); got != "doc-bridge" {
		t.Fatalf("sanitize docId = %q", got)
	}
	if records := out.Get("records"); records.Get("length").Int() == 0 {
		t.Fatal("sanitize records missing")
	}

	cssOut, ok := k.jsSanitizeCSS(js.Undefined(), []js.Value{jsObject(map[string]any{
		"docId":   "doc-bridge",
		"baseUrl": "https://target.example/app/",
		"css":     `body{background:url(bg.png)}`,
	})}).(js.Value)
	if !ok || cssOut.Get("error").Truthy() {
		t.Fatalf("jsSanitizeCSS returned error: %#v", cssOut)
	}
	if !strings.Contains(cssOut.Get("css").String(), "zp-internal://resource/") {
		t.Fatalf("sanitize CSS did not rewrite URL: %q", cssOut.Get("css").String())
	}
}

func base64RawURLEncoded(b []byte) string {
	alphabet := []byte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
	if len(b) == 0 {
		return ""
	}
	out := make([]byte, 0, (len(b)*8+5)/6)
	var acc uint
	var bits uint
	for _, c := range b {
		acc = (acc << 8) | uint(c)
		bits += 8
		for bits >= 6 {
			bits -= 6
			out = append(out, alphabet[(acc>>bits)&0x3f])
		}
	}
	if bits > 0 {
		out = append(out, alphabet[(acc<<(6-bits))&0x3f])
	}
	return string(out)
}

//go:build js && wasm

package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"syscall/js"
	"testing"
	"time"

	"github.com/gosuda/zeroproxy/internal/policy"
	"github.com/gosuda/zeroproxy/internal/relayauth"
	"github.com/gosuda/zeroproxy/internal/socks5"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
	"github.com/gosuda/zeroproxy/internal/zphttp"
)

func TestHTTPParseAndTimeoutOutcomesRemainDistinct(t *testing.T) {
	parse := targetHTTPParseOutcome(context.Background(), errors.New("malformed response"))
	if parse.Code != "HTTP_PARSE" || parse.Stage != "HTTP" || parse.Retryable {
		t.Fatalf("parse outcome=%#v", parse)
	}
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	timeout := targetHTTPParseOutcome(expired, context.DeadlineExceeded)
	if timeout.Code != "HTTP_TIMEOUT" || !timeout.Retryable {
		t.Fatalf("timeout outcome=%#v", timeout)
	}
}

func TestSOCKSReplyOutcomesSeparateDNSAndTCP(t *testing.T) {
	for _, testCase := range []struct {
		reply     byte
		code      string
		retryable bool
	}{
		{3, "TCP_CONNECT", true},
		{4, "DNS_RESOLUTION", true},
		{5, "TCP_CONNECT", true},
		{6, "CONNECT_TIMEOUT", true},
		{2, "SOCKS_POLICY", false},
		{7, "SOCKS_REPLY", true},
	} {
		outcome := targetSOCKSOutcome(context.Background(), &socks5.ReplyError{Code: testCase.reply})
		if outcome.Code != testCase.code || outcome.Stage != "SOCKS" || outcome.Retryable != testCase.retryable {
			t.Fatalf("reply=%d outcome=%#v", testCase.reply, outcome)
		}
	}
}

func TestTargetTLSFailureOutcomesRemainDistinct(t *testing.T) {
	for _, testCase := range []struct {
		kind      utlskernel.FailureKind
		code      string
		stage     string
		retryable bool
	}{
		{utlskernel.FailurePolicy, "TARGET_ADDRESS_POLICY", "POLICY", false},
		{utlskernel.FailureCertificate, "TARGET_CERTIFICATE", "TLS", false},
		{utlskernel.FailureTLSProtocol, "TLS_PROTOCOL", "TLS", false},
		{utlskernel.FailureALPN, "TLS_ALPN", "TLS", false},
		{utlskernel.FailureTimeout, "TLS_TIMEOUT", "TLS", true},
		{utlskernel.FailureAbort, "CLIENT_ABORT", "TLS", false},
	} {
		outcome := targetTLSOutcome(&utlskernel.Failure{Kind: testCase.kind, Err: errors.New("failure")})
		if outcome.Code != testCase.code || outcome.Stage != testCase.stage || outcome.Retryable != testCase.retryable {
			t.Fatalf("kind=%v outcome=%#v", testCase.kind, outcome)
		}
	}
}

func TestTransportHeaderConfusedDeputyChecks(t *testing.T) {
	for _, name := range []string{
		"X-ZP-Route", "Host", "Origin", "Referer", "Cookie", "User-Agent", "Sec-CH-UA",
		"Sec-Fetch-Site", "Priority", "Upgrade-Insecure-Requests", "Accept-Encoding",
		"Accept-Language", "Connection", "Transfer-Encoding", "Content-Length", "Proxy-Authorization",
	} {
		if !forbiddenRequestHeader(name) {
			t.Fatalf("forbidden request header %q was not blocked", name)
		}
	}
	if validHeaderPair("Bad Header", "value") || validHeaderPair("Accept", "value\r\ninjected") {
		t.Fatal("malformed request header pair was accepted")
	}
	request, err := http.NewRequest(http.MethodGet, "https://target.invalid/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := addRequestHeaders(request, [][2]string{{"Cookie", "forged=true"}}); err == nil {
		t.Fatal("page-supplied cookie reached request construction")
	}
	if err := addRequestHeaders(request, [][2]string{{"Accept", "text/plain"}}); err != nil {
		t.Fatalf("ordinary header rejected: %v", err)
	}
	if got := request.Header.Get("Accept"); got != "text/plain" {
		t.Fatalf("ordinary header = %q, want text/plain", got)
	}
}

func TestResponseHeadersRetainPrivateCookiesAndExcludeBrowserControls(t *testing.T) {
	response := &http.Response{Header: http.Header{
		"Content-Type": {"text/plain"},
		"Set-Cookie":   {"secret=value"},
		"Location":     {"https://target.invalid/next"},
		"Alt-Svc":      {"h3=\":443\""},
		"Refresh":      {"0; https://target.invalid/next"},
		"Link":         {"<https://target.invalid>; rel=preconnect"},
	}}
	headers := responseHeaders(response)
	seen := make(map[[2]string]bool, len(headers))
	for _, header := range headers {
		seen[header] = true
	}
	for _, expected := range [][2]string{{"Content-Type", "text/plain"}, {"Set-Cookie", "secret=value"}} {
		if !seen[expected] {
			t.Fatalf("private response headers = %#v, missing %#v", headers, expected)
		}
	}
	if len(headers) != 2 {
		t.Fatalf("private response headers = %#v", headers)
	}
}

func TestNegotiatedStreamLimitsAreBounded(t *testing.T) {
	kernel := &kernel{limits: relayauth.Limits{MaxFrameBytes: 8 << 10, UploadByteBudget: 12 << 10, DownloadByteBudget: 16 << 10}}
	chunk, queueBytes, queueChunks := kernel.streamLimits()
	if chunk != 8<<10 || queueBytes != 12<<10 || queueChunks != defaultQueueChunks {
		t.Fatalf("stream limits = (%d, %d, %d)", chunk, queueBytes, queueChunks)
	}
}

func TestKernelRejectsCrossBindingDimensions(t *testing.T) {
	kernel := &kernel{
		profileID: "profile-a", sessionID: "session-a", tabID: "tab-a", originID: "origin-a",
		policyEpoch: 2, capabilityEpoch: 3, isolationKeyRef: "isolation-a", persona: transportPersona,
		documentBindings: map[kernelDocumentBinding]time.Time{
			{sourceClientID: "client-a", documentID: "document-a", entryID: "entry-a"}: time.Now(),
		},
	}
	base := transportPlan{
		profileID: "profile-a", sessionID: "session-a", tabID: "tab-a", originID: "origin-a",
		entryID: "entry-a", sourceClientID: "client-a", documentID: "document-a",
		policyEpoch: 2, capabilityEpoch: 3, isolationKeyRef: "isolation-a", persona: transportPersona,
	}
	if !kernel.matchesBinding(transactionStart{transportPlan: base}) {
		t.Fatal("matching transport binding was rejected")
	}
	mutations := []func(*transportPlan){
		func(plan *transportPlan) { plan.profileID = "profile-b" },
		func(plan *transportPlan) { plan.sessionID = "session-b" },
		func(plan *transportPlan) { plan.tabID = "tab-b" },
		func(plan *transportPlan) { plan.originID = "origin-b" },
		func(plan *transportPlan) { plan.entryID = "entry-b" },
		func(plan *transportPlan) { plan.sourceClientID = "client-b" },
		func(plan *transportPlan) { plan.documentID = "document-b" },
		func(plan *transportPlan) { plan.policyEpoch++ },
		func(plan *transportPlan) { plan.capabilityEpoch++ },
		func(plan *transportPlan) { plan.isolationKeyRef = "isolation-b" },
		func(plan *transportPlan) { plan.persona = "other-persona" },
	}
	for index, mutate := range mutations {
		candidate := base
		mutate(&candidate)
		if kernel.matchesBinding(transactionStart{transportPlan: candidate}) {
			t.Fatalf("cross-binding mutation %d was accepted", index)
		}
	}
}

func transactionStartTestValue(fetchSiteFloor string) (js.Value, js.Func) {
	callback := js.FuncOf(func(this js.Value, args []js.Value) any { return nil })
	plan := js.Global().Get("Object").New()
	plan.Set("plan_id", "sealed-plan-context-1")
	plan.Set("source_client_id", "client-a")
	plan.Set("document_id", "document-a")
	plan.Set("profile_id", "profile-a")
	plan.Set("session_id", "session-a")
	plan.Set("tab_id", "tab-a")
	plan.Set("origin_id", "origin-a")
	plan.Set("entry_id", "entry-a")
	plan.Set("policy_epoch", 2)
	plan.Set("capability_epoch", 3)
	plan.Set("target_url", "https://api.example.com/resource")
	plan.Set("source_url", "https://app.example.com/document")
	plan.Set("referrer", "https://app.example.com/document")
	plan.Set("fetch_site_floor", fetchSiteFloor)
	plan.Set("fetch_site", "cross-site")
	plan.Set("fetch_mode", "cors")
	plan.Set("fetch_destination", "empty")
	plan.Set("fetch_user", false)
	plan.Set("priority", "u=1")
	plan.Set("upgrade_insecure", false)
	plan.Set("origin", "https://app.example.com")
	plan.Set("credentials", "include")
	plan.Set("cookie_seq", 4)
	plan.Set("cookie_header", "session=trusted")
	plan.Set("isolation_key_ref", "isolation-a")
	plan.Set("persona", transportPersona)
	plan.Set("method", http.MethodGet)
	plan.Set("headers", js.Global().Get("Array").New())
	plan.Set("body_expected", false)
	plan.Set("body_handle", "")
	plan.Set("redirect", "manual")
	input := js.Global().Get("Object").New()
	input.Set("v", 2)
	input.Set("request_id", "request-context-1")
	input.Set("plan", plan)
	input.Set("on_event", callback)
	return input, callback
}

func TestTransactionStartRejectsTopLevelTransportOverrides(t *testing.T) {
	input, callback := transactionStartTestValue("cross-site")
	defer callback.Release()
	for _, field := range []string{"source_url", "fetch_site_floor", "isolation_username", "isolation_password", "profile_id", "tab_id", "origin_id"} {
		input.Set(field, "forged")
		if _, err := parseStart(input); err == nil {
			t.Fatalf("top-level transport override %q was accepted", field)
		}
		input.Delete(field)
	}
}

func TestTransactionStartRequestContextABI(t *testing.T) {
	input, callback := transactionStartTestValue("cross-site")
	defer callback.Release()
	start, err := parseStart(input)
	if err != nil {
		t.Fatalf("parse transaction start: %v", err)
	}
	if start.sourceURL != "https://app.example.com/document" || start.fetchSiteFloor != "cross-site" {
		t.Fatalf("parsed request context = (%q, %q)", start.sourceURL, start.fetchSiteFloor)
	}
	request, err := http.NewRequest(start.method, start.rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Sec-Fetch-Site", "forged")
	requestSite, trusted, contextErr := applyRequestContext(request, start)
	if contextErr != nil {
		t.Fatalf("apply request context: %v", contextErr)
	}
	if requestSite != "cross-site" || request.Header.Values("Sec-Fetch-Site")[0] != "cross-site" || len(request.Header.Values("Sec-Fetch-Site")) != 1 {
		t.Fatalf("derived request site = %q, headers = %#v", requestSite, request.Header.Values("Sec-Fetch-Site"))
	}
	for name, expected := range map[string]string{
		"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Priority": "u=1",
		"Origin": "https://app.example.com", "Referer": "https://app.example.com/document",
		"Cookie": "session=trusted",
	} {
		if got := request.Header.Get(name); got != expected {
			t.Fatalf("trusted %s = %q, want %q", name, got, expected)
		}
	}
	if len(trusted) != 6 {
		t.Fatalf("trusted header order = %#v", trusted)
	}
	message := serializeEvent(streamEvent{
		Kind: streamEventHeaders, RequestID: start.requestID,
		Headers: &responseMetadata{
			RequestSite: requestSite,
			Informational: []informationalResponseMetadata{{
				Status: 103, Headers: [][2]string{{"Cache-Control", "max-age=60"}},
			}},
		},
	})
	if got := message.Get("request_site").String(); got != "cross-site" {
		t.Fatalf("serialized request_site = %q, want cross-site", got)
	}
	informational := message.Get("informational")
	if informational.Length() != 1 || informational.Index(0).Get("status").Int() != 103 {
		t.Fatalf("serialized informational responses = %#v", informational)
	}
}

func TestTransactionStartRejectsInvalidFetchSiteFloor(t *testing.T) {
	input, callback := transactionStartTestValue("same-party")
	defer callback.Release()
	start, err := parseStart(input)
	if err != nil {
		t.Fatalf("parse transaction start: %v", err)
	}
	request, err := http.NewRequest(start.method, start.rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, contextErr := applyRequestContext(request, start); contextErr == nil ||
		contextErr.Code != "REQUEST_CONTEXT_INVALID" || contextErr.Stage != "POLICY" || contextErr.Retryable {
		t.Fatalf("invalid floor error = %#v", contextErr)
	}
}

func TestInvalidRequestContextRejectsBeforeRelay(t *testing.T) {
	const requestID = "request-context-before-relay"
	events := make(chan streamEvent, 1)
	tx := newTransaction(requestID, 1024, 4096, 2, false, func(event streamEvent) {
		events <- event
	})
	kernel := &kernel{requests: map[string]*transaction{requestID: tx}}
	target, err := policy.ParseTarget("https://api.example.com/resource")
	if err != nil {
		t.Fatal(err)
	}
	kernel.runTransaction(tx, transactionStart{
		requestID: requestID,
		transportPlan: transportPlan{
			rawURL: target.URL.String(), sourceURL: "https://app.example.com/document",
			fetchSiteFloor: "same-party", fetchSite: "cross-site", fetchMode: "cors",
			fetchDestination: "empty", priority: "u=1", method: http.MethodGet,
		},
	}, target)
	event := <-events
	if event.Kind != streamEventTerminal || event.Terminal == nil ||
		event.Terminal.Code != "REQUEST_CONTEXT_INVALID" || event.Terminal.Stage != "POLICY" || event.Terminal.Retryable {
		t.Fatalf("pre-relay terminal event = %#v", event)
	}
}

func approvedRelayTestValue(profileID, relayURL string, marker byte, ports []int, maxStreams int) js.Value {
	value := js.Global().Get("Object").New()
	value.Set("relayURL", relayURL)
	value.Set("relayProfileID", profileID)
	value.Set("relayDeploymentID", "deployment-identifier")
	value.Set("capabilityID", "capability-identifier")
	value.Set("capabilityEpoch", 1)
	for _, field := range []string{"relayProfileDigest", "verifierKey", "claimsDigest"} {
		bytes := make([]byte, 32)
		bytes[0] = marker
		array := js.Global().Get("Uint8Array").New(32)
		js.CopyBytesToJS(array, bytes)
		value.Set(field, array)
	}
	allowed := js.Global().Get("Array").New(len(ports))
	for index, port := range ports {
		allowed.SetIndex(index, port)
	}
	value.Set("allowedTargetPorts", allowed)
	limits := js.Global().Get("Object").New()
	limits.Set("max_streams", maxStreams)
	limits.Set("upload_byte_budget", 1<<20)
	limits.Set("download_byte_budget", 2<<20)
	limits.Set("max_frame_bytes", 64<<10)
	limits.Set("max_message_bytes", 1<<20)
	limits.Set("max_frames_per_second", 1000)
	limits.Set("handshake_timeout_ms", 10000)
	limits.Set("idle_timeout_ms", 60000)
	limits.Set("session_deadline_ms", 900000)
	value.Set("profileLimits", limits)
	return value
}

func TestApprovedRelaySetPreservesOrderAndConservativeLimits(t *testing.T) {
	relays := js.Global().Get("Array").New(2)
	relays.SetIndex(0, approvedRelayTestValue("relay-a", "wss://a.example/_zp/carrier", 1, []int{80, 443}, 64))
	relays.SetIndex(1, approvedRelayTestValue("relay-b", "wss://b.example/_zp/carrier", 2, []int{443, 8443}, 32))
	config := js.Global().Get("Object").New()
	config.Set("relays", relays)
	set, err := parseApprovedRelays(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.ordered) != 2 || set.ordered[0].ProfileID != "relay-a" || set.ordered[1].ProfileID != "relay-b" {
		t.Fatalf("relay order = %#v", set.ordered)
	}
	if len(set.allowedPorts) != 1 {
		t.Fatalf("common ports = %#v", set.allowedPorts)
	}
	if _, present := set.allowedPorts[443]; !present {
		t.Fatalf("common ports = %#v, want 443", set.allowedPorts)
	}
	if set.limits.MaxStreams != 32 {
		t.Fatalf("conservative max streams = %d, want 32", set.limits.MaxStreams)
	}
}

func TestApprovedRelaySetRejectsDuplicateIdentity(t *testing.T) {
	relays := js.Global().Get("Array").New(2)
	relays.SetIndex(0, approvedRelayTestValue("relay-a", "wss://a.example/_zp/carrier", 1, []int{443}, 64))
	relays.SetIndex(1, approvedRelayTestValue("relay-a", "wss://b.example/_zp/carrier", 2, []int{443}, 64))
	config := js.Global().Get("Object").New()
	config.Set("relays", relays)
	if _, err := parseApprovedRelays(config); err == nil {
		t.Fatal("duplicate approved relay identity accepted")
	}
}

const concurrentRelayFailures = 32

func TestConcurrentRelayFailuresEmitOnlyUnsafeTerminalOutcome(t *testing.T) {
	cause := &zphttp.UnsafeRequestError{
		Bytes: 1,
		Err:   &pooledRelayLoss{err: errors.New("concurrent carrier loss")},
	}
	events := make(chan streamEvent, concurrentRelayFailures)
	transaction := newTransaction("concurrent-relay-loss", 1024, 4096, 2, false, func(event streamEvent) {
		events <- event
	})
	var group sync.WaitGroup
	for range concurrentRelayFailures {
		group.Add(1)
		go func() {
			defer group.Done()
			transaction.finish(pooledTransportOutcome(context.Background(), cause))
		}()
	}
	group.Wait()
	event := <-events
	if event.Kind != streamEventTerminal || event.Terminal == nil ||
		event.Terminal.Code != "RELAY_LOST_UNSAFE" || event.Terminal.Stage != "RELAY" || event.Terminal.Retryable {
		t.Fatalf("terminal outcome = %#v", event)
	}
	select {
	case duplicate := <-events:
		t.Fatalf("duplicate terminal outcome = %#v", duplicate)
	default:
	}
}

func serializedKeys(value js.Value) string {
	keys := js.Global().Get("Object").Call("keys", value)
	fields := make([]string, keys.Length())
	for index := range keys.Length() {
		fields[index] = keys.Index(index).String()
	}
	return strings.Join(fields, ",")
}

func TestStreamFramesSerializeWithExactFieldsAndArrayBufferChunks(t *testing.T) {
	pull := serializeEvent(streamEvent{Kind: streamEventPull, Seq: 3, DesiredBytes: 1024})
	if keys := serializedKeys(pull); keys != "type,seq,desired_bytes" {
		t.Fatalf("PULL fields = %q", keys)
	}
	chunk := serializeEvent(streamEvent{Kind: streamEventChunk, Seq: 4, Data: []byte{1, 2, 3}})
	if keys := serializedKeys(chunk); keys != "type,seq,chunk" {
		t.Fatalf("CHUNK fields = %q", keys)
	}
	if !chunk.Get("chunk").InstanceOf(js.Global().Get("ArrayBuffer")) {
		t.Fatal("CHUNK payload is not an ArrayBuffer")
	}
	closeFrame := serializeEvent(streamEvent{Kind: streamEventTerminal, Terminal: &terminalOutcome{OK: true, FinalSeq: 5}})
	if keys := serializedKeys(closeFrame); keys != "type,final_seq" {
		t.Fatalf("CLOSE fields = %q", keys)
	}
	requestID := "request_identifier_1234"
	errorFrame := serializeEvent(streamEvent{
		Kind:      streamEventTerminal,
		RequestID: requestID,
		Terminal:  &terminalOutcome{Code: "RESPONSE_BODY", Stage: "BODY", Retryable: true, FinalSeq: 6},
	})
	if keys := serializedKeys(errorFrame); keys != "type,seq,error" {
		t.Fatalf("ERROR fields = %q", keys)
	}
	errorValue := errorFrame.Get("error")
	if keys := serializedKeys(errorValue); keys != "code,stage,retryable,request_id,internal_cause" {
		t.Fatalf("internal error fields = %q", keys)
	}
	if errorValue.Get("code").String() != "RESPONSE_BODY" ||
		errorValue.Get("stage").String() != "BODY" ||
		!errorValue.Get("retryable").Bool() ||
		errorValue.Get("request_id").String() != requestID ||
		errorValue.Get("internal_cause").Type() != js.TypeNull {
		t.Fatalf("internal error = %#v", errorValue)
	}
}

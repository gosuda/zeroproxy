//go:build js && wasm

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/gosuda/zeroproxy/internal/errorauthority"
	"github.com/gosuda/zeroproxy/internal/httppersona"
	"github.com/gosuda/zeroproxy/internal/policy"
	"github.com/gosuda/zeroproxy/internal/relayauth"
	"github.com/gosuda/zeroproxy/internal/relaymanager"
	"github.com/gosuda/zeroproxy/internal/socks5"
	"github.com/gosuda/zeroproxy/internal/utlskernel"
	"github.com/gosuda/zeroproxy/internal/zphttp"
	"github.com/xtaci/smux"
	"golang.org/x/net/http/httpguts"
)

const (
	transportPersona          = "chrome-149-darwin"
	maxKernelDocumentBindings = 256
)

type kernelDocumentBinding struct {
	sourceClientID string
	documentID     string
	entryID        string
}

type kernel struct {
	relays           *relaymanager.Manager
	httpPool         *zphttp.Pool
	limits           relayauth.Limits
	allowedPorts     map[uint16]struct{}
	profileID        string
	sessionID        string
	tabID            string
	originID         string
	documentBindings map[kernelDocumentBinding]time.Time
	policyEpoch      int
	capabilityEpoch  int
	isolationKeyRef  string
	isolationUser    string
	isolationPass    string
	persona          string
	cookieSeq        int

	mu         sync.Mutex
	closed     bool
	requests   map[string]*transaction
	sockets    map[string]*webSocketTransaction
	requestIDs requestIDLedger
	planIDs    requestIDLedger
}

var kernels = struct {
	sync.Mutex
	next  uint64
	items map[uint64]*kernel
}{items: map[uint64]*kernel{}}

func bytesFromJS(value js.Value, size int) ([]byte, error) {
	if value.Get("byteLength").Type() != js.TypeNumber || value.Get("byteLength").Int() != size {
		return nil, errors.New("invalid byte array")
	}
	out := make([]byte, size)
	if js.CopyBytesToGo(out, value) != size {
		return nil, errors.New("short byte array")
	}
	return out, nil
}
func promise(work func() (any, error)) js.Value {
	constructor := js.Global().Get("Promise")
	executor := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			value, err := work()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(value)
		}()
		return nil
	})
	result := constructor.New(executor)
	executor.Release()
	return result
}
func boundedHTTPPoolLimits(carrier relayauth.Limits) zphttp.PoolLimits {
	limits := zphttp.DefaultPoolLimits()
	maxStreams := max(1, int(carrier.MaxStreams))
	limits.MaxOrigins = min(limits.MaxOrigins, maxStreams)
	limits.DocumentScriptActive = min(limits.DocumentScriptActive, maxStreams)
	limits.OrdinaryActive = min(limits.OrdinaryActive, maxStreams)
	limits.LongLivedActive = min(limits.LongLivedActive, maxStreams)
	limits.DocumentScriptH2 = min(limits.DocumentScriptH2, maxStreams)
	limits.OrdinaryH2 = min(limits.OrdinaryH2, maxStreams)
	limits.LongLivedH2 = min(limits.LongLivedH2, maxStreams)
	limits.IdleTimeout = min(limits.IdleTimeout, time.Duration(carrier.IdleTimeoutMS)*time.Millisecond)
	return limits
}

func dialKernel(config js.Value) (uint64, error) {
	relaySet, err := parseApprovedRelays(config)
	if err != nil {
		return 0, err
	}
	profileID, err := requiredString(config.Get("profileID"), 256)
	if err != nil {
		return 0, err
	}
	sessionID, err := requiredString(config.Get("sessionID"), 256)
	if err != nil {
		return 0, err
	}
	tabID, err := requiredString(config.Get("tabID"), 256)
	if err != nil {
		return 0, err
	}
	originID, err := requiredString(config.Get("originID"), 256)
	if err != nil {
		return 0, err
	}
	entryID, err := requiredString(config.Get("entryID"), 256)
	if err != nil {
		return 0, err
	}
	sourceClientID, err := requiredString(config.Get("sourceClientID"), 256)
	if err != nil {
		return 0, err
	}
	documentID, err := requiredString(config.Get("documentID"), 256)
	if err != nil {
		return 0, err
	}
	policyEpoch, err := requiredSafeInteger(config.Get("policyEpoch"), 1, 1<<30)
	if err != nil {
		return 0, err
	}
	capabilityEpoch, err := requiredSafeInteger(config.Get("capabilityEpoch"), 1, 1<<30)
	if err != nil {
		return 0, err
	}
	cookieSeq, err := requiredSafeInteger(config.Get("cookieSequence"), 0, 1<<30)
	if err != nil {
		return 0, err
	}
	isolationKeyRef, err := requiredString(config.Get("isolationKeyRef"), 256)
	if err != nil {
		return 0, err
	}
	isolationUser, err := requiredString(config.Get("isolationUsername"), 1024)
	if err != nil {
		return 0, err
	}
	isolationPass, err := requiredString(config.Get("isolationPassword"), 1024)
	if err != nil {
		return 0, err
	}
	persona, err := requiredString(config.Get("persona"), 64)
	if err != nil || persona != transportPersona {
		return 0, newTransactionError("PERSONA_BINDING", "POLICY", false)
	}
	manager, err := newRelayManager(relaySet)
	if err != nil {
		return 0, err
	}
	warm, err := manager.Acquire(context.Background())
	if err != nil {
		_ = manager.Close()
		return 0, err
	}
	warm.Release()
	httpPool, err := zphttp.NewPool(boundedHTTPPoolLimits(relaySet.limits))
	if err != nil {
		_ = manager.Close()
		return 0, err
	}
	k := &kernel{
		relays: manager, httpPool: httpPool, limits: relaySet.limits, allowedPorts: relaySet.allowedPorts,
		profileID: profileID, sessionID: sessionID, tabID: tabID, originID: originID,
		policyEpoch: policyEpoch, capabilityEpoch: capabilityEpoch, isolationKeyRef: isolationKeyRef,
		isolationUser: isolationUser, isolationPass: isolationPass, persona: persona, cookieSeq: cookieSeq,
		documentBindings: map[kernelDocumentBinding]time.Time{
			{sourceClientID: sourceClientID, documentID: documentID, entryID: entryID}: time.Now(),
		},
		requests: make(map[string]*transaction), sockets: make(map[string]*webSocketTransaction),
	}
	kernels.Lock()
	kernels.next++
	id := kernels.next
	kernels.items[id] = k
	kernels.Unlock()
	return id, nil
}

func lookup(id uint64) (*kernel, error) {
	kernels.Lock()
	defer kernels.Unlock()
	k := kernels.items[id]
	if k == nil {
		return nil, errors.New("unknown kernel")
	}
	return k, nil
}

type transportPlan struct {
	planID           string
	sourceClientID   string
	documentID       string
	profileID        string
	sessionID        string
	tabID            string
	originID         string
	entryID          string
	policyEpoch      int
	capabilityEpoch  int
	rawURL           string
	sourceURL        string
	referrer         string
	fetchSiteFloor   string
	fetchSite        string
	fetchMode        string
	fetchDestination string
	fetchUser        bool
	priority         string
	upgradeInsecure  bool
	originHeader     string
	credentials      string
	cookieSeq        int
	cookieHeader     string
	isolationKeyRef  string
	persona          string
	method           string
	headers          [][2]string
	bodyExpected     bool
	bodyHandle       string
	redirectMode     string
}

type transactionStart struct {
	transportPlan
	requestID string
	onEvent   js.Value
}

func publicError(err error) error {
	var typed *transactionError
	if errors.As(err, &typed) {
		return errors.New(typed.Code)
	}
	return errors.New(string(errorauthority.CodeInternalFailed))
}

func rejectType(message string) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("TypeError").New(message))
}

func objectFields(value js.Value, allowed map[string]struct{}) error {
	if value.Type() != js.TypeObject || value.IsNull() {
		return newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	keys := js.Global().Get("Object").Call("keys", value)
	for i := range keys.Length() {
		key := keys.Index(i).String()
		if _, ok := allowed[key]; !ok {
			return newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
		}
	}
	return nil
}

func requiredString(value js.Value, max int) (string, error) {
	if value.Type() != js.TypeString {
		return "", newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	out := value.String()
	if out == "" || len(out) > max {
		return "", newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	return out, nil
}

func optionalString(value js.Value, max int) (string, error) {
	if value.Type() != js.TypeString {
		return "", newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	out := value.String()
	if len(out) > max {
		return "", newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	return out, nil
}

func requiredBool(value js.Value) (bool, error) {
	if value.Type() != js.TypeBoolean {
		return false, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	return value.Bool(), nil
}
func requiredSafeInteger(value js.Value, minimum, maximum int) (int, error) {
	if value.Type() != js.TypeNumber || !js.Global().Get("Number").Call("isSafeInteger", value).Bool() {
		return 0, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	out := value.Int()
	if out < minimum || out > maximum {
		return 0, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	return out, nil
}

func validHeaderPair(name, value string) bool {
	return httpguts.ValidHeaderFieldName(name) && httpguts.ValidHeaderFieldValue(value)
}

func parseHeaderPairs(value js.Value) ([][2]string, error) {
	if value.Type() != js.TypeObject || !value.InstanceOf(js.Global().Get("Array")) || value.Length() > 128 {
		return nil, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	headers := make([][2]string, 0, value.Length())
	total := 0
	for i := range value.Length() {
		pair := value.Index(i)
		if pair.Type() != js.TypeObject || !pair.InstanceOf(js.Global().Get("Array")) || pair.Length() != 2 {
			return nil, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
		}
		name, err := requiredString(pair.Index(0), 256)
		if err != nil {
			return nil, err
		}
		headerValue, err := requiredString(pair.Index(1), 8<<10)
		if err != nil {
			return nil, err
		}
		if !validHeaderPair(name, headerValue) {
			return nil, newTransactionError("HEADER_INVALID", "HTTP", false)
		}
		total += len(name) + len(headerValue)
		if total > 64<<10 {
			return nil, newTransactionError("HEADER_LIMIT", "HTTP", false)
		}
		headers = append(headers, [2]string{name, headerValue})
	}
	return headers, nil
}

func parseStart(value js.Value) (transactionStart, error) {
	allowed := map[string]struct{}{"v": {}, "request_id": {}, "plan": {}, "on_event": {}}
	if err := objectFields(value, allowed); err != nil {
		return transactionStart{}, err
	}
	if version, err := requiredSafeInteger(value.Get("v"), 2, 2); err != nil || version != 2 {
		return transactionStart{}, newTransactionError("MESSAGE_VERSION", "INTERNAL", false)
	}
	requestID, err := requiredString(value.Get("request_id"), 128)
	if err != nil || !validRequestID(requestID) {
		return transactionStart{}, newTransactionError("REQUEST_ID_INVALID", "INTERNAL", false)
	}
	onEvent := value.Get("on_event")
	if onEvent.Type() != js.TypeFunction {
		return transactionStart{}, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	plan, err := parseTransportPlan(value.Get("plan"), requestID)
	if err != nil {
		return transactionStart{}, err
	}
	return transactionStart{transportPlan: plan, requestID: requestID, onEvent: onEvent}, nil
}

func parseTransportPlan(value js.Value, _ string) (transportPlan, error) {
	allowed := map[string]struct{}{
		"plan_id": {}, "source_client_id": {}, "document_id": {}, "profile_id": {}, "session_id": {},
		"tab_id": {}, "origin_id": {}, "entry_id": {}, "policy_epoch": {}, "capability_epoch": {},
		"target_url": {}, "source_url": {}, "referrer": {}, "fetch_site_floor": {}, "fetch_site": {},
		"fetch_mode": {}, "fetch_destination": {}, "fetch_user": {}, "priority": {}, "upgrade_insecure": {},
		"origin": {}, "credentials": {}, "cookie_seq": {}, "cookie_header": {}, "isolation_key_ref": {},
		"persona": {}, "method": {}, "headers": {}, "body_expected": {}, "body_handle": {}, "redirect": {},
	}
	if err := objectFields(value, allowed); err != nil {
		return transportPlan{}, err
	}
	stringField := func(name string, maximum int, optional bool) (string, error) {
		if optional {
			return optionalString(value.Get(name), maximum)
		}
		return requiredString(value.Get(name), maximum)
	}
	var plan transportPlan
	var err error
	if plan.planID, err = stringField("plan_id", 128, false); err != nil || !validRequestID(plan.planID) {
		return transportPlan{}, newTransactionError("PLAN_ID_INVALID", "POLICY", false)
	}
	if plan.sourceClientID, err = stringField("source_client_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.documentID, err = stringField("document_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.profileID, err = stringField("profile_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.sessionID, err = stringField("session_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.tabID, err = stringField("tab_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.originID, err = stringField("origin_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.entryID, err = stringField("entry_id", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.policyEpoch, err = requiredSafeInteger(value.Get("policy_epoch"), 1, 1<<30); err != nil {
		return transportPlan{}, err
	}
	if plan.capabilityEpoch, err = requiredSafeInteger(value.Get("capability_epoch"), 1, 1<<30); err != nil {
		return transportPlan{}, err
	}
	if plan.rawURL, err = stringField("target_url", 16<<10, false); err != nil {
		return transportPlan{}, err
	}
	if plan.sourceURL, err = stringField("source_url", 16<<10, true); err != nil {
		return transportPlan{}, err
	}
	if plan.referrer, err = stringField("referrer", 16<<10, true); err != nil {
		return transportPlan{}, err
	}
	if plan.fetchSiteFloor, err = stringField("fetch_site_floor", 16, true); err != nil {
		return transportPlan{}, err
	}
	if plan.fetchSite, err = stringField("fetch_site", 16, false); err != nil {
		return transportPlan{}, err
	}
	if plan.fetchMode, err = stringField("fetch_mode", 16, false); err != nil {
		return transportPlan{}, err
	}
	if plan.fetchDestination, err = stringField("fetch_destination", 32, false); err != nil {
		return transportPlan{}, err
	}
	if plan.fetchUser, err = requiredBool(value.Get("fetch_user")); err != nil {
		return transportPlan{}, err
	}
	if plan.priority, err = stringField("priority", 16, false); err != nil {
		return transportPlan{}, err
	}
	if plan.upgradeInsecure, err = requiredBool(value.Get("upgrade_insecure")); err != nil {
		return transportPlan{}, err
	}
	if plan.originHeader, err = stringField("origin", 16<<10, true); err != nil {
		return transportPlan{}, err
	}
	if plan.credentials, err = stringField("credentials", 16, false); err != nil {
		return transportPlan{}, err
	}
	if plan.cookieSeq, err = requiredSafeInteger(value.Get("cookie_seq"), 0, 1<<30); err != nil {
		return transportPlan{}, err
	}
	if plan.cookieHeader, err = stringField("cookie_header", 64<<10, true); err != nil ||
		plan.cookieHeader != "" && !httpguts.ValidHeaderFieldValue(plan.cookieHeader) {
		return transportPlan{}, newTransactionError("COOKIE_CONTEXT_INVALID", "POLICY", false)
	}
	if plan.isolationKeyRef, err = stringField("isolation_key_ref", 256, false); err != nil {
		return transportPlan{}, err
	}
	if plan.persona, err = stringField("persona", 64, false); err != nil {
		return transportPlan{}, err
	}
	if plan.method, err = stringField("method", 32, false); err != nil {
		return transportPlan{}, err
	}
	if plan.headers, err = parseHeaderPairs(value.Get("headers")); err != nil {
		return transportPlan{}, err
	}
	if plan.bodyExpected, err = requiredBool(value.Get("body_expected")); err != nil {
		return transportPlan{}, err
	}
	if plan.bodyHandle, err = stringField("body_handle", 128, true); err != nil {
		return transportPlan{}, err
	}
	if plan.redirectMode, err = stringField("redirect", 16, false); err != nil {
		return transportPlan{}, err
	}
	if plan.bodyExpected != (plan.bodyHandle != "" && validRequestID(plan.bodyHandle)) ||
		(plan.redirectMode != "follow" && plan.redirectMode != "error" && plan.redirectMode != "manual") {
		return transportPlan{}, newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	return plan, nil
}

func (k *kernel) matchesBaseBinding(profileID, sessionID, tabID, originID string, policyEpoch, capabilityEpoch int, isolationKeyRef, persona string) bool {
	return profileID == k.profileID && sessionID == k.sessionID &&
		tabID == k.tabID && originID == k.originID &&
		policyEpoch == k.policyEpoch && capabilityEpoch == k.capabilityEpoch &&
		isolationKeyRef == k.isolationKeyRef && persona == k.persona
}

func (k *kernel) hasDocumentBinding(sourceClientID, documentID, entryID string) bool {
	binding := kernelDocumentBinding{sourceClientID: sourceClientID, documentID: documentID, entryID: entryID}
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, exists := k.documentBindings[binding]; !exists {
		return false
	}
	k.documentBindings[binding] = time.Now()
	return true
}

func (k *kernel) matchesBinding(start transactionStart) bool {
	return k.matchesBaseBinding(
		start.profileID, start.sessionID, start.tabID, start.originID,
		start.policyEpoch, start.capabilityEpoch, start.isolationKeyRef, start.persona,
	) && k.hasDocumentBinding(start.sourceClientID, start.documentID, start.entryID)
}

func (k *kernel) bindDocument(binding kernelDocumentBinding) error {
	if binding.sourceClientID == "" || binding.documentID == "" || binding.entryID == "" {
		return newTransactionError("REQUEST_BINDING", "POLICY", false)
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.closed {
		return newTransactionError("RELAY_UNAVAILABLE", "RELAY", true)
	}
	if k.documentBindings == nil {
		k.documentBindings = make(map[kernelDocumentBinding]time.Time)
	}
	if len(k.documentBindings) >= maxKernelDocumentBindings {
		var oldest kernelDocumentBinding
		var oldestTime time.Time
		for candidate, used := range k.documentBindings {
			if oldestTime.IsZero() || used.Before(oldestTime) {
				oldest, oldestTime = candidate, used
			}
		}
		delete(k.documentBindings, oldest)
	}
	k.documentBindings[binding] = time.Now()
	return nil
}

func canonicalPlanURL(raw string) (policy.Target, error) {
	target, err := policy.ParseTarget(raw)
	if err != nil || target.Fragment != "" || target.URL.String() != raw {
		return policy.Target{}, newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	return target, nil
}

func validateTransportPlan(start transactionStart, target policy.Target) error {
	if target.URL.String() != start.rawURL || !httpguts.ValidHeaderFieldName(start.method) ||
		start.method == http.MethodConnect || start.method == http.MethodTrace {
		return newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	validSite := start.fetchSite == "none" || start.fetchSite == "same-origin" ||
		start.fetchSite == "same-site" || start.fetchSite == "cross-site"
	validFloor := start.fetchSiteFloor == "" || start.fetchSiteFloor == "none" ||
		start.fetchSiteFloor == "same-origin" || start.fetchSiteFloor == "same-site" ||
		start.fetchSiteFloor == "cross-site"
	validMode := start.fetchMode == "navigate" || start.fetchMode == "cors" ||
		start.fetchMode == "no-cors" || start.fetchMode == "same-origin"
	validDestination := false
	for _, destination := range []string{"document", "iframe", "worker", "script", "style", "image", "font", "video", "manifest", "empty"} {
		validDestination = validDestination || start.fetchDestination == destination
	}
	validPriority := start.priority == "u=0, i" || start.priority == "u=0" ||
		start.priority == "u=1" || start.priority == "u=2"
	validCredentials := start.credentials == "omit" || start.credentials == "same-origin" ||
		start.credentials == "include"
	if !validSite || !validFloor || !validMode || !validDestination || !validPriority || !validCredentials ||
		start.fetchUser && start.fetchMode != "navigate" || start.upgradeInsecure && start.fetchMode != "navigate" {
		return newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	var source policy.Target
	var err error
	if start.sourceURL != "" {
		source, err = canonicalPlanURL(start.sourceURL)
		if err != nil {
			return err
		}
	}
	if start.referrer != "" {
		referrer, referrerErr := canonicalPlanURL(start.referrer)
		if referrerErr != nil || start.sourceURL == "" || referrer.Origin != source.Origin {
			return newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
		}
	}
	if start.originHeader != "" {
		origin, originErr := canonicalPlanURL(start.originHeader + "/")
		canonicalOrigin := ""
		if originErr == nil {
			canonicalOrigin = origin.URL.Scheme + "://" + origin.URL.Host
		}
		if originErr != nil || start.sourceURL == "" || canonicalOrigin != start.originHeader ||
			origin.Origin != source.Origin {
			return newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
		}
	}
	sameOrigin := start.sourceURL != "" && source.Origin == target.Origin
	if start.cookieHeader != "" && (start.credentials == "omit" ||
		start.credentials == "same-origin" && !sameOrigin) {
		return newTransactionError("COOKIE_CONTEXT_INVALID", "POLICY", false)
	}
	for _, header := range start.headers {
		if forbiddenRequestHeader(header[0]) {
			return newTransactionError("FORBIDDEN_HEADER", "POLICY", false)
		}
	}
	return nil
}

func (k *kernel) streamLimits() (chunkBytes, queueBytes, queueChunks int) {
	budget := min(k.limits.UploadByteBudget, k.limits.DownloadByteBudget)
	chunkBytes = defaultStreamChunkBytes
	if k.limits.MaxFrameBytes < uint32(chunkBytes) {
		chunkBytes = int(k.limits.MaxFrameBytes)
	}
	if budget < uint64(chunkBytes) {
		chunkBytes = int(budget)
	}
	queueBytes = defaultQueueBytes
	if budget < uint64(queueBytes) {
		queueBytes = int(budget)
	}
	queueChunks = defaultQueueChunks
	return
}
func (k *kernel) startTransaction(input js.Value) (any, error) {
	start, err := parseStart(input)
	if err != nil {
		return nil, err
	}
	if !k.matchesBinding(start) {
		return nil, newTransactionError("REQUEST_BINDING", "POLICY", false)
	}
	target, err := canonicalPlanURL(start.rawURL)
	if err != nil {
		return nil, err
	}
	if err := validateTransportPlan(start, target); err != nil {
		return nil, err
	}
	if _, allowed := k.allowedPorts[target.Origin.Port]; !allowed {
		return nil, newTransactionError("TARGET_PORT_BLOCKED", "POLICY", false)
	}
	chunkBytes, queueBytes, queueChunks := k.streamLimits()
	k.mu.Lock()
	if k.closed {
		k.mu.Unlock()
		return nil, newTransactionError("RELAY_UNAVAILABLE", "RELAY", true)
	}
	if uint32(len(k.requests)) >= k.limits.MaxStreams {
		k.mu.Unlock()
		return nil, newTransactionError("STREAM_LIMIT", "RELAY", true)
	}
	if err := k.planIDs.reserve(start.planID); err != nil {
		k.mu.Unlock()
		return nil, newTransactionError("PLAN_REPLAY", "POLICY", false)
	}
	if err := k.requestIDs.reserve(start.requestID); err != nil {
		k.mu.Unlock()
		return nil, err
	}
	if start.cookieSeq < k.cookieSeq {
		k.mu.Unlock()
		return nil, newTransactionError("COOKIE_SEQUENCE_STALE", "POLICY", false)
	}
	k.cookieSeq = start.cookieSeq
	var transaction *transaction
	emit := func(event streamEvent) {
		defer func() {
			if recover() != nil && transaction != nil {
				transaction.finish(terminalOutcome{Code: "EVENT_DELIVERY", Stage: "BODY", Retryable: false})
			}
		}()
		start.onEvent.Invoke(serializeEvent(event))
	}
	transaction = newTransaction(start.requestID, chunkBytes, queueBytes, queueChunks, start.bodyExpected, emit)
	k.requests[start.requestID] = transaction
	k.mu.Unlock()
	total := min(60*time.Second, time.Duration(k.limits.SessionDeadlineMS)*time.Millisecond)
	idle := min(30*time.Second, time.Duration(k.limits.IdleTimeoutMS)*time.Millisecond)
	idle = min(idle, total)
	transaction.startDeadlines(idle, total)
	go k.runTransaction(transaction, start, target)
	direction := "DOWNLOAD"
	if start.bodyExpected {
		direction = "BIDIRECTIONAL"
	}
	return map[string]any{
		"type": "OPEN", "stream_id": start.requestID, "direction": direction,
		"max_chunk_bytes": chunkBytes, "high_water_mark": queueBytes,
		"deadline_ms": int(total / time.Millisecond),
	}, nil
}

func (k *kernel) releaseTransaction(requestID string, transaction *transaction) {
	k.mu.Lock()
	if k.requests[requestID] == transaction {
		delete(k.requests, requestID)
	}
	k.mu.Unlock()
}

func (k *kernel) requestTransaction(requestID string) (*transaction, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	transaction := k.requests[requestID]
	if transaction == nil {
		return nil, newTransactionError("REQUEST_NOT_ACTIVE", "INTERNAL", false)
	}
	return transaction, nil
}

func forbiddenRequestHeader(name string) bool {
	name = strings.ToLower(name)
	return strings.HasPrefix(name, "x-zp-") || strings.HasPrefix(name, "sec-ch-") ||
		strings.HasPrefix(name, "sec-fetch-") || strings.HasPrefix(name, "proxy-") ||
		name == "host" || name == "origin" || name == "referer" || name == "cookie" ||
		name == "user-agent" || name == "accept-encoding" || name == "accept-language" ||
		name == "priority" || name == "upgrade-insecure-requests" ||
		name == "connection" || name == "keep-alive" || name == "transfer-encoding" ||
		name == "content-length" || name == "trailer" || name == "te" ||
		name == "upgrade" || name == "expect" || name == "via" || name == "forwarded"
}

func addRequestHeaders(request *http.Request, headers [][2]string) error {
	for _, pair := range headers {
		if forbiddenRequestHeader(pair[0]) {
			return newTransactionError("FORBIDDEN_HEADER", "POLICY", false)
		}
		request.Header.Add(pair[0], pair[1])
	}
	return nil
}

func forbiddenResponseHeader(name string) bool {
	name = strings.ToLower(name)
	return strings.HasPrefix(name, "x-zp-") ||
		name == "location" || name == "refresh" || name == "set-cookie2" ||
		name == "link" || name == "connection" || name == "proxy-authenticate" ||
		name == "alt-svc" || name == "report-to" || name == "reporting-endpoints" ||
		name == "nel" || name == "origin-trial" || name == "service-worker-allowed" ||
		name == "clear-site-data" || name == "content-security-policy" ||
		name == "content-security-policy-report-only" || name == "permissions-policy" ||
		name == "cross-origin-opener-policy" || name == "cross-origin-embedder-policy" ||
		name == "cross-origin-resource-policy" || name == "x-frame-options" ||
		name == "sourcemap" || name == "x-sourcemap"
}

func projectResponseHeaders(header http.Header) [][2]string {
	headers := make([][2]string, 0, len(header))
	for name, values := range header {
		if forbiddenResponseHeader(name) {
			continue
		}
		for _, value := range values {
			headers = append(headers, [2]string{name, value})
		}
	}
	return headers
}

func responseHeaders(response *http.Response) [][2]string {
	return projectResponseHeaders(response.Header)
}

func applyRequestContext(request *http.Request, start transactionStart) (string, [][2]string, *transactionError) {
	requestSite, err := httppersona.ApplyFetchSiteHeader(request, start.sourceURL, start.fetchSiteFloor)
	if err != nil || requestSite != start.fetchSite {
		return "", nil, &transactionError{Code: "REQUEST_CONTEXT_INVALID", Stage: "POLICY", Retryable: false}
	}
	trusted := make([][2]string, 0, 9)
	set := func(name, value string) {
		request.Header.Set(name, value)
		trusted = append(trusted, [2]string{name, value})
	}
	set("Sec-Fetch-Mode", start.fetchMode)
	set("Sec-Fetch-Dest", start.fetchDestination)
	if start.fetchUser {
		set("Sec-Fetch-User", "?1")
	}
	set("Priority", start.priority)
	if start.upgradeInsecure {
		set("Upgrade-Insecure-Requests", "1")
	}
	if start.originHeader != "" {
		set("Origin", start.originHeader)
	}
	if start.referrer != "" {
		set("Referer", start.referrer)
	}
	if start.cookieHeader != "" {
		set("Cookie", start.cookieHeader)
	}
	return requestSite, trusted, nil
}

func isRedirect(status int) bool { return status >= 300 && status <= 399 }

func targetSOCKSOutcome(ctx context.Context, err error) terminalOutcome {
	if errors.Is(ctx.Err(), context.Canceled) {
		return terminalOutcome{Code: "CLIENT_ABORT", Stage: "SOCKS", Retryable: false}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return terminalOutcome{Code: "CONNECT_TIMEOUT", Stage: "SOCKS", Retryable: true}
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return terminalOutcome{Code: "CONNECT_TIMEOUT", Stage: "SOCKS", Retryable: true}
	}
	if errors.Is(err, policy.ErrAddressPolicy) {
		return terminalOutcome{Code: "TARGET_ADDRESS_POLICY", Stage: "POLICY", Retryable: false}
	}
	var reply *socks5.ReplyError
	if errors.As(err, &reply) {
		switch reply.Code {
		case 3, 5:
			return terminalOutcome{Code: "TCP_CONNECT", Stage: "SOCKS", Retryable: true}
		case 4:
			return terminalOutcome{Code: "DNS_RESOLUTION", Stage: "SOCKS", Retryable: true}
		case 6:
			return terminalOutcome{Code: "CONNECT_TIMEOUT", Stage: "SOCKS", Retryable: true}
		case 2, 8:
			return terminalOutcome{Code: "SOCKS_POLICY", Stage: "SOCKS", Retryable: false}
		default:
			return terminalOutcome{Code: "SOCKS_REPLY", Stage: "SOCKS", Retryable: true}
		}
	}
	return terminalOutcome{Code: "SOCKS_PROTOCOL", Stage: "SOCKS", Retryable: false}
}

func targetHTTPParseOutcome(ctx context.Context, err error) terminalOutcome {
	if errors.Is(ctx.Err(), context.Canceled) {
		return terminalOutcome{Code: "CLIENT_ABORT", Stage: "HTTP", Retryable: false}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return terminalOutcome{Code: "HTTP_TIMEOUT", Stage: "HTTP", Retryable: true}
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return terminalOutcome{Code: "HTTP_TIMEOUT", Stage: "HTTP", Retryable: true}
	}
	return terminalOutcome{Code: "HTTP_PARSE", Stage: "HTTP", Retryable: false}
}

func targetTLSOutcome(err error) terminalOutcome {
	switch utlskernel.KindOf(err) {
	case utlskernel.FailurePolicy:
		return terminalOutcome{Code: "TARGET_ADDRESS_POLICY", Stage: "POLICY", Retryable: false}
	case utlskernel.FailureCertificate:
		return terminalOutcome{Code: "TARGET_CERTIFICATE", Stage: "TLS", Retryable: false}
	case utlskernel.FailureTLSProtocol:
		return terminalOutcome{Code: "TLS_PROTOCOL", Stage: "TLS", Retryable: false}
	case utlskernel.FailureALPN:
		return terminalOutcome{Code: "TLS_ALPN", Stage: "TLS", Retryable: false}
	case utlskernel.FailureTimeout:
		return terminalOutcome{Code: "TLS_TIMEOUT", Stage: "TLS", Retryable: true}
	case utlskernel.FailureAbort:
		return terminalOutcome{Code: "CLIENT_ABORT", Stage: "TLS", Retryable: false}
	default:
		return terminalOutcome{Code: "TLS_CONNECT", Stage: "TLS", Retryable: false}
	}
}

type pooledRelayLoss struct {
	err error
}

func (failure *pooledRelayLoss) Error() string { return failure.err.Error() }
func (failure *pooledRelayLoss) Unwrap() error { return failure.err }

type pooledSOCKSFailure struct {
	err error
}

func (failure *pooledSOCKSFailure) Error() string { return failure.err.Error() }
func (failure *pooledSOCKSFailure) Unwrap() error { return failure.err }

func requestPoolClass(start transactionStart) zphttp.RequestClass {
	for _, header := range start.headers {
		name := strings.ToLower(header[0])
		value := strings.ToLower(header[1])
		if name == "range" || name == "accept" &&
			(strings.Contains(value, "text/event-stream") || strings.Contains(value, "audio/") ||
				strings.Contains(value, "video/") || strings.Contains(value, "application/octet-stream")) {
			return zphttp.LongLived
		}
		if name == "accept" &&
			(strings.Contains(value, "text/html") || strings.Contains(value, "javascript")) {
			return zphttp.DocumentScript
		}
	}
	return zphttp.Ordinary
}

func httpPoolKey(target policy.Target, credentials socks5.Credentials) string {
	digest := sha256.Sum256([]byte(credentials.Username + "\x00" + credentials.Password))
	return target.Origin.String() + "\x00" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func (k *kernel) dialPooledTarget(ctx context.Context, target policy.Target, credentials socks5.Credentials) (*zphttp.OwnedTarget, error) {
	for {
		stream, lease, err := acquireRelayStream(ctx, k.relays)
		if err != nil {
			return nil, err
		}
		_ = stream.SetDeadline(time.Now().Add(30 * time.Second))
		attemptDone := make(chan struct{})
		go func(candidate *smux.Stream) {
			select {
			case <-ctx.Done():
				_ = candidate.Close()
			case <-attemptDone:
			}
		}(stream)
		if err = socks5.Connect(stream, target.Origin.Host, target.Origin.Port, &credentials); err != nil {
			close(attemptDone)
			_ = stream.Close()
			if relayLeaseLost(lease) {
				_ = lease.Fail(err)
				continue
			}
			lease.Release()
			return nil, &pooledSOCKSFailure{err: err}
		}
		targetConn, err := zphttp.SecureTarget(ctx, stream, target)
		close(attemptDone)
		if err != nil {
			_ = stream.Close()
			if relayLeaseLost(lease) {
				_ = lease.Fail(err)
				continue
			}
			lease.Release()
			return nil, err
		}
		_ = stream.SetDeadline(time.Time{})
		return &zphttp.OwnedTarget{
			Conn: targetConn,
			Done: func(cause error) error {
				if cause != nil && relayLeaseLost(lease) {
					return &pooledRelayLoss{err: lease.Fail(cause)}
				}
				lease.Release()
				return nil
			},
		}, nil
	}
}

func pooledTransportOutcome(ctx context.Context, err error) terminalOutcome {
	var relayLoss *pooledRelayLoss
	if errors.As(err, &relayLoss) {
		var unsafe *zphttp.UnsafeRequestError
		if errors.As(err, &unsafe) {
			return terminalOutcome{Code: "RELAY_LOST_UNSAFE", Stage: "RELAY", Retryable: false}
		}
		return terminalOutcome{Code: "RELAY_LOST", Stage: "RELAY", Retryable: true}
	}
	var unavailable *relaymanager.UnavailableError
	if errors.As(err, &unavailable) {
		return terminalOutcome{Code: "RELAY_UNAVAILABLE", Stage: "RELAY", Retryable: true}
	}
	if utlskernel.KindOf(err) != utlskernel.FailureUnknown {
		return targetTLSOutcome(err)
	}
	var socksFailure *pooledSOCKSFailure
	if errors.As(err, &socksFailure) {
		return targetSOCKSOutcome(ctx, err)
	}
	if errors.Is(err, zphttp.ErrPoolCapacity) || errors.Is(err, zphttp.ErrPoolClosed) {
		return terminalOutcome{Code: "HTTP_POOL_CAPACITY", Stage: "HTTP", Retryable: true}
	}
	return targetHTTPParseOutcome(ctx, err)
}

func (k *kernel) runTransaction(transaction *transaction, start transactionStart, target policy.Target) {
	defer k.releaseTransaction(transaction.id, transaction)
	requestURL := &url.URL{
		Scheme: target.Origin.Scheme, Host: target.Origin.EffectiveHost(),
		Path: target.URL.Path, RawPath: target.URL.RawPath, RawQuery: target.URL.RawQuery,
	}
	var body io.Reader
	if start.bodyExpected {
		body = newUploadReader(transaction)
	}
	request, err := http.NewRequestWithContext(transaction.Context(), start.method, requestURL.String(), body)
	if err != nil {
		transaction.finish(terminalOutcome{Code: "REQUEST_INVALID", Stage: "HTTP", Retryable: false})
		return
	}
	if start.bodyExpected {
		request.ContentLength = -1
	}
	request.Host = target.Origin.EffectiveHost()
	if err := addRequestHeaders(request, start.headers); err != nil {
		transaction.finish(terminalOutcome{Code: "FORBIDDEN_HEADER", Stage: "POLICY", Retryable: false})
		return
	}
	requestSite, trustedHeaders, contextErr := applyRequestContext(request, start)
	if contextErr != nil {
		transaction.finish(terminalOutcome{
			Code: contextErr.Code, Stage: contextErr.Stage, Retryable: contextErr.Retryable,
		})
		return
	}
	wireSeed := make([][2]string, 0, len(start.headers)+len(trustedHeaders))
	wireSeed = append(wireSeed, start.headers...)
	wireSeed = append(wireSeed, trustedHeaders...)
	wireHeaders := httppersona.ApplyChrome149Headers(request, wireSeed)
	credentials := socks5.Credentials{Username: k.isolationUser, Password: k.isolationPass}
	result, err := k.httpPool.RoundTrip(
		transaction.Context(),
		httpPoolKey(target, credentials),
		requestPoolClass(start),
		request,
		wireHeaders,
		func(ctx context.Context) (*zphttp.OwnedTarget, error) {
			return k.dialPooledTarget(ctx, target, credentials)
		},
	)
	if err != nil {
		if transaction.Context().Err() == nil {
			transaction.finish(pooledTransportOutcome(transaction.Context(), err))
		}
		return
	}
	response := result.Response
	if err := httppersona.DecodeResponse(response); err != nil {
		transaction.finish(terminalOutcome{Code: "RESPONSE_DECODE", Stage: "HTTP", Retryable: false})
		return
	}
	defer response.Body.Close()
	redirect := redirectMetadata{
		Mode: start.redirectMode, IsRedirect: isRedirect(response.StatusCode),
		Location: response.Header.Get("Location"),
	}
	if redirect.IsRedirect {
		switch start.redirectMode {
		case "error":
			transaction.finish(terminalOutcome{Code: "REDIRECT_DISALLOWED", Stage: "HTTP", Retryable: false})
			return
		}
	}
	informational := make([]informationalResponseMetadata, 0, len(result.Informational))
	for _, response := range result.Informational {
		informational = append(informational, informationalResponseMetadata{
			Status: response.Status, Headers: projectResponseHeaders(response.Headers),
		})
	}
	metadata := responseMetadata{
		Status: response.StatusCode, StatusText: response.Status, Headers: responseHeaders(response),
		URL: target.URL.String(), Redirected: false, ResponseType: "basic", RequestSite: requestSite,
		Redirect: redirect, Informational: informational,
	}
	if err := transaction.emitHeaders(metadata); err != nil {
		return
	}
	for {
		buffer, demandErr := transaction.nextDownloadBuffer()
		if demandErr != nil {
			return
		}
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if err := transaction.download(buffer[:count]); err != nil {
				return
			}
		}
		if errors.Is(readErr, io.EOF) {
			transaction.finish(terminalOutcome{OK: true})
			return
		}
		if readErr != nil {
			if transaction.Context().Err() == nil {
				outcome := pooledTransportOutcome(transaction.Context(), readErr)
				if outcome.Code == "HTTP_PARSE" {
					outcome = terminalOutcome{Code: "RESPONSE_BODY", Stage: "BODY", Retryable: true}
				}
				transaction.finish(outcome)
			}
			return
		}
	}
}

type webSocketPlan struct {
	planID          string
	sourceClientID  string
	documentID      string
	profileID       string
	sessionID       string
	tabID           string
	originID        string
	entryID         string
	policyEpoch     int
	capabilityEpoch int
	rawURL          string
	sourceURL       string
	origin          string
	protocols       []string
	credentials     string
	cookieSeq       int
	cookie          string
	isolationKeyRef string
	persona         string
}

type webSocketStart struct {
	webSocketPlan
	requestID string
	onEvent   js.Value
}

func validWebSocketProtocol(value string) bool {
	return value != "" && len(value) <= 123 && httpguts.ValidHeaderFieldName(value)
}

func parseWebSocketProtocols(value js.Value) ([]string, error) {
	if value.Type() != js.TypeObject || !value.InstanceOf(js.Global().Get("Array")) || value.Length() > 32 {
		return nil, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	protocols := make([]string, 0, value.Length())
	seen := make(map[string]struct{}, value.Length())
	for i := range value.Length() {
		protocol, err := requiredString(value.Index(i), 123)
		if err != nil || !validWebSocketProtocol(protocol) {
			return nil, newTransactionError("WEBSOCKET_PROTOCOL_INVALID", "HTTP", false)
		}
		if _, duplicate := seen[protocol]; duplicate {
			return nil, newTransactionError("WEBSOCKET_PROTOCOL_INVALID", "HTTP", false)
		}
		seen[protocol] = struct{}{}
		protocols = append(protocols, protocol)
	}
	return protocols, nil
}

func parseWebSocketStart(value js.Value) (webSocketStart, error) {
	allowed := map[string]struct{}{"v": {}, "request_id": {}, "plan": {}, "on_event": {}}
	if err := objectFields(value, allowed); err != nil {
		return webSocketStart{}, err
	}
	if version, err := requiredSafeInteger(value.Get("v"), 2, 2); err != nil || version != 2 {
		return webSocketStart{}, newTransactionError("MESSAGE_VERSION", "INTERNAL", false)
	}
	requestID, err := requiredString(value.Get("request_id"), 128)
	if err != nil || !validRequestID(requestID) {
		return webSocketStart{}, newTransactionError("REQUEST_ID_INVALID", "INTERNAL", false)
	}
	onEvent := value.Get("on_event")
	if onEvent.Type() != js.TypeFunction {
		return webSocketStart{}, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	plan, err := parseWebSocketPlan(value.Get("plan"))
	if err != nil {
		return webSocketStart{}, err
	}
	return webSocketStart{webSocketPlan: plan, requestID: requestID, onEvent: onEvent}, nil
}

func parseWebSocketPlan(value js.Value) (webSocketPlan, error) {
	allowed := map[string]struct{}{
		"plan_id": {}, "source_client_id": {}, "document_id": {}, "profile_id": {}, "session_id": {},
		"tab_id": {}, "origin_id": {}, "entry_id": {}, "policy_epoch": {}, "capability_epoch": {},
		"target_url": {}, "source_url": {}, "origin": {}, "protocols": {}, "credentials": {},
		"cookie_seq": {}, "cookie_header": {}, "isolation_key_ref": {}, "persona": {},
	}
	if err := objectFields(value, allowed); err != nil {
		return webSocketPlan{}, err
	}
	required := func(name string, maximum int) (string, error) {
		return requiredString(value.Get(name), maximum)
	}
	var plan webSocketPlan
	var err error
	if plan.planID, err = required("plan_id", 128); err != nil || !validRequestID(plan.planID) {
		return webSocketPlan{}, newTransactionError("PLAN_ID_INVALID", "POLICY", false)
	}
	if plan.sourceClientID, err = required("source_client_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.documentID, err = required("document_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.profileID, err = required("profile_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.sessionID, err = required("session_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.tabID, err = required("tab_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.originID, err = required("origin_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.entryID, err = required("entry_id", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.policyEpoch, err = requiredSafeInteger(value.Get("policy_epoch"), 1, 1<<30); err != nil {
		return webSocketPlan{}, err
	}
	if plan.capabilityEpoch, err = requiredSafeInteger(value.Get("capability_epoch"), 1, 1<<30); err != nil {
		return webSocketPlan{}, err
	}
	if plan.rawURL, err = required("target_url", 16<<10); err != nil {
		return webSocketPlan{}, err
	}
	if plan.sourceURL, err = required("source_url", 16<<10); err != nil {
		return webSocketPlan{}, err
	}
	if plan.origin, err = required("origin", 16<<10); err != nil {
		return webSocketPlan{}, err
	}
	if plan.protocols, err = parseWebSocketProtocols(value.Get("protocols")); err != nil {
		return webSocketPlan{}, err
	}
	if plan.credentials, err = required("credentials", 16); err != nil ||
		(plan.credentials != "omit" && plan.credentials != "same-origin" && plan.credentials != "include") {
		return webSocketPlan{}, newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	if plan.cookieSeq, err = requiredSafeInteger(value.Get("cookie_seq"), 0, 1<<30); err != nil {
		return webSocketPlan{}, err
	}
	if plan.cookie, err = optionalString(value.Get("cookie_header"), 64<<10); err != nil ||
		plan.cookie != "" && !httpguts.ValidHeaderFieldValue(plan.cookie) {
		return webSocketPlan{}, newTransactionError("COOKIE_CONTEXT_INVALID", "POLICY", false)
	}
	if plan.isolationKeyRef, err = required("isolation_key_ref", 256); err != nil {
		return webSocketPlan{}, err
	}
	if plan.persona, err = required("persona", 64); err != nil {
		return webSocketPlan{}, err
	}
	return plan, nil
}

func parseWebSocketTarget(raw string) (policy.Target, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" {
		return policy.Target{}, newTransactionError("TARGET_URL", "POLICY", false)
	}
	wireScheme := strings.ToLower(parsed.Scheme)
	switch wireScheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return policy.Target{}, newTransactionError("TARGET_URL", "POLICY", false)
	}
	target, err := policy.ParseTarget(parsed.String())
	if err != nil {
		return policy.Target{}, newTransactionError("TARGET_URL", "POLICY", false)
	}
	canonical := target.URL.String()
	if wireScheme == "ws" {
		canonical = "ws" + strings.TrimPrefix(canonical, "http")
	} else {
		canonical = "wss" + strings.TrimPrefix(canonical, "https")
	}
	if raw != canonical {
		return policy.Target{}, newTransactionError("PLAN_CONTEXT_INVALID", "POLICY", false)
	}
	return target, nil
}

func (k *kernel) matchesWebSocketBinding(start webSocketStart) bool {
	return k.matchesBaseBinding(
		start.profileID, start.sessionID, start.tabID, start.originID,
		start.policyEpoch, start.capabilityEpoch, start.isolationKeyRef, start.persona,
	) && k.hasDocumentBinding(start.sourceClientID, start.documentID, start.entryID)
}

func validateWebSocketPlan(start webSocketStart, target policy.Target) error {
	source, err := canonicalPlanURL(start.sourceURL)
	if err != nil {
		return err
	}
	expectedOrigin := source.URL.Scheme + "://" + source.URL.Host
	if start.origin != expectedOrigin {
		return newTransactionError("ORIGIN_INVALID", "POLICY", false)
	}
	sameOrigin := source.Origin == target.Origin
	if start.cookie != "" && (start.credentials == "omit" ||
		start.credentials == "same-origin" && !sameOrigin) {
		return newTransactionError("COOKIE_CONTEXT_INVALID", "POLICY", false)
	}
	return nil
}

func (k *kernel) startWebSocket(input js.Value) (any, error) {
	start, err := parseWebSocketStart(input)
	if err != nil {
		return nil, err
	}
	if !k.matchesWebSocketBinding(start) {
		return nil, newTransactionError("REQUEST_BINDING", "POLICY", false)
	}
	target, err := parseWebSocketTarget(start.rawURL)
	if err != nil {
		return nil, err
	}
	if err := validateWebSocketPlan(start, target); err != nil {
		return nil, err
	}
	if _, allowed := k.allowedPorts[target.Origin.Port]; !allowed {
		return nil, newTransactionError("TARGET_PORT_BLOCKED", "POLICY", false)
	}
	chunkBytes, queueBytes, queueChunks := k.streamLimits()
	k.mu.Lock()
	if k.closed {
		k.mu.Unlock()
		return nil, newTransactionError("RELAY_UNAVAILABLE", "RELAY", true)
	}
	if uint32(len(k.requests)+len(k.sockets)) >= k.limits.MaxStreams {
		k.mu.Unlock()
		return nil, newTransactionError("STREAM_LIMIT", "RELAY", true)
	}
	if err := k.planIDs.reserve(start.planID); err != nil {
		k.mu.Unlock()
		return nil, newTransactionError("PLAN_REPLAY", "POLICY", false)
	}
	if err := k.requestIDs.reserve(start.requestID); err != nil {
		k.mu.Unlock()
		return nil, err
	}
	if start.cookieSeq < k.cookieSeq {
		k.mu.Unlock()
		return nil, newTransactionError("COOKIE_SEQUENCE_STALE", "POLICY", false)
	}
	k.cookieSeq = start.cookieSeq
	var socket *webSocketTransaction
	emit := func(event webSocketEvent) {
		defer func() {
			if recover() != nil && socket != nil {
				socket.finish(1006, "", false, "EVENT_DELIVERY")
			}
		}()
		start.onEvent.Invoke(serializeWebSocketEvent(event))
	}
	socket = newWebSocketTransaction(start.requestID, queueBytes, queueChunks, emit)
	k.sockets[start.requestID] = socket
	k.mu.Unlock()
	go k.runWebSocket(socket, start, target, chunkBytes)
	return map[string]any{
		"v": 2, "request_id": start.requestID, "max_message_bytes": defaultWebSocketMessageBytes,
		"send_high_water_mark": queueBytes,
	}, nil
}

func (k *kernel) releaseWebSocket(requestID string, socket *webSocketTransaction) {
	k.mu.Lock()
	if k.sockets[requestID] == socket {
		delete(k.sockets, requestID)
	}
	k.mu.Unlock()
}

func headerHasToken(header, token string) bool {
	for _, candidate := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(candidate), token) {
			return true
		}
	}
	return false
}

func webSocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func finishWebSocketAfterRelayFailure(socket *webSocketTransaction, lease *relaymanager.Lease, cause error) {
	_ = lease.Fail(cause)
	if lease.ApplicationBytes() != 0 {
		socket.finish(1006, "", false, "RELAY_LOST_UNSAFE")
	} else {
		socket.relayLost()
	}
}

func finishWebSocketRelayLoss(socket *webSocketTransaction, lease *relaymanager.Lease, cause error) bool {
	if !relayLeaseLost(lease) {
		return false
	}
	finishWebSocketAfterRelayFailure(socket, lease, cause)
	return true
}

func (k *kernel) runWebSocket(socket *webSocketTransaction, start webSocketStart, target policy.Target, maxFrame int) {
	defer k.releaseWebSocket(socket.id, socket)
	credentials := &socks5.Credentials{Username: k.isolationUser, Password: k.isolationPass}
	var stream *smux.Stream
	var lease *relaymanager.Lease
	var targetConn *zphttp.TargetConn
	var err error
	for {
		stream, lease, err = acquireRelayStream(socket.Context(), k.relays)
		if err != nil {
			socket.relayLost()
			return
		}
		_ = stream.SetDeadline(time.Now().Add(30 * time.Second))
		attemptDone := make(chan struct{})
		go func(candidate *smux.Stream) {
			select {
			case <-socket.Context().Done():
				_ = candidate.Close()
			case <-attemptDone:
			}
		}(stream)
		if err = socks5.Connect(stream, target.Origin.Host, target.Origin.Port, credentials); err != nil {
			close(attemptDone)
			_ = stream.Close()
			if relayLeaseLost(lease) {
				_ = lease.Fail(err)
				continue
			}
			lease.Release()
			if socket.Context().Err() == nil {
				socket.finish(1006, "", false, targetSOCKSOutcome(socket.Context(), err).Code)
			}
			return
		}
		targetConn, err = zphttp.SecureTarget(socket.Context(), stream, target)
		close(attemptDone)
		if err != nil {
			_ = stream.Close()
			if relayLeaseLost(lease) {
				_ = lease.Fail(err)
				continue
			}
			lease.Release()
			if socket.Context().Err() == nil {
				socket.finish(1006, "", false, targetTLSOutcome(err).Code)
			}
			return
		}
		break
	}
	defer lease.Release()
	defer stream.Close()
	defer targetConn.Close()
	stopClose := make(chan struct{})
	go func() {
		select {
		case <-socket.Context().Done():
			_ = stream.Close()
		case <-stopClose:
		}
	}()
	defer close(stopClose)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		socket.finish(1006, "", false, "HANDSHAKE")
		return
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	requestURL := &url.URL{Scheme: target.Origin.Scheme, Host: target.Origin.EffectiveHost(), Path: target.URL.Path, RawPath: target.URL.RawPath, RawQuery: target.URL.RawQuery}
	request, err := http.NewRequestWithContext(socket.Context(), http.MethodGet, requestURL.String(), nil)
	if err != nil {
		socket.finish(1006, "", false, "HANDSHAKE")
		return
	}
	request.Host = target.Origin.EffectiveHost()
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", key)
	request.Header.Set("Origin", start.origin)
	if start.cookie != "" {
		request.Header.Set("Cookie", start.cookie)
	}
	if len(start.protocols) != 0 {
		request.Header.Set("Sec-WebSocket-Protocol", strings.Join(start.protocols, ", "))
	}
	wireHeaders := httppersona.ApplyChrome149Headers(request, [][2]string{
		{"Connection", "Upgrade"},
		{"Upgrade", "websocket"},
		{"Sec-WebSocket-Version", "13"},
		{"Sec-WebSocket-Key", key},
		{"Origin", start.origin},
	})
	if start.cookie != "" {
		wireHeaders = append(wireHeaders, [2]string{"Cookie", start.cookie})
	}
	if len(start.protocols) != 0 {
		wireHeaders = append(wireHeaders, [2]string{"Sec-WebSocket-Protocol", strings.Join(start.protocols, ", ")})
	}
	lease.MarkApplicationBytes(1)
	if err := httppersona.WriteHTTP1(targetConn, request, wireHeaders); err != nil {
		if finishWebSocketRelayLoss(socket, lease, err) {
			return
		}
		if socket.Context().Err() == nil {
			socket.finish(1006, "", false, "HANDSHAKE")
		}
		return
	}
	targetReader := bufio.NewReader(targetConn)
	response, err := http.ReadResponse(targetReader, request)
	if err != nil {
		if finishWebSocketRelayLoss(socket, lease, err) {
			return
		}
		if socket.Context().Err() == nil {
			socket.finish(1006, "", false, "HANDSHAKE")
		}
		return
	}
	if response.StatusCode != http.StatusSwitchingProtocols ||
		!validWebSocketHandshakeHeaders(response.Header) ||
		!headerHasToken(response.Header.Get("Connection"), "Upgrade") ||
		!headerHasToken(response.Header.Get("Upgrade"), "websocket") ||
		response.Header.Get("Sec-WebSocket-Accept") != webSocketAccept(key) ||
		response.Header.Get("Sec-WebSocket-Extensions") != "" {
		socket.finish(1006, "", false, "HANDSHAKE")
		return
	}
	protocol := response.Header.Get("Sec-WebSocket-Protocol")
	if protocol != "" {
		if !validWebSocketProtocol(protocol) {
			socket.finish(1006, "", false, "HANDSHAKE")
			return
		}
		accepted := false
		for _, offered := range start.protocols {
			if protocol == offered {
				accepted = true
				break
			}
		}
		if !accepted {
			socket.finish(1006, "", false, "HANDSHAKE")
			return
		}
	}
	_ = stream.SetDeadline(time.Time{})
	if err := socket.open(protocol, response.Header.Values("Set-Cookie")); err != nil {
		socket.finish(1006, "", false, "HANDSHAKE")
		return
	}
	wireWriter := &serializedWebSocketWriter{writer: targetConn, maxFrame: maxFrame}
	go func() {
		select {
		case <-socket.CloseStarted():
			if err := beginWebSocketCloseWriteDeadline(targetConn, time.Now()); err != nil {
				socket.finish(1006, "", false, "CLOSE_TIMEOUT")
			}
		case <-socket.Context().Done():
		}
	}()
	writeFrame := wireWriter.frame
	closeSent := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			item, err := socket.outbound.dequeue(socket.Context())
			if err != nil {
				return
			}
			if item.close {
				err = writeFrame(webSocketFrame{fin: true, opcode: webSocketClose, payload: item.payload})
				item.ack <- err
				if err != nil {
					if !finishWebSocketRelayLoss(socket, lease, err) {
						socket.finish(1006, "", false, "WRITE")
					}
				} else {
					close(closeSent)
					if err := targetConn.SetReadDeadline(time.Now().Add(webSocketCloseTimeout)); err != nil {
						socket.finish(1006, "", false, "CLOSE_TIMEOUT")
					}
				}
				return
			}
			err = wireWriter.message(item.opcode, item.payload)
			item.ack <- err
			if err != nil {
				if !finishWebSocketRelayLoss(socket, lease, err) {
					socket.finish(1006, "", false, "WRITE")
				}
				return
			}
		}
	}()
	var fragmented bool
	var messageOpcode byte
	var message []byte
	for socket.Context().Err() == nil {
		frame, err := readWebSocketFrame(targetReader, defaultWebSocketMessageBytes, false)
		if err != nil {
			if finishWebSocketRelayLoss(socket, lease, err) {
				break
			}
			if socket.Context().Err() == nil {
				socket.finish(1006, "", false, "READ")
			}
			break
		}
		switch frame.opcode {
		case webSocketPing:
			if err := writeFrame(webSocketFrame{fin: true, opcode: webSocketPong, payload: frame.payload}); err != nil {
				if !finishWebSocketRelayLoss(socket, lease, err) {
					socket.finish(1006, "", false, "WRITE")
				}
			}
		case webSocketPong:
		case webSocketClose:
			code, reason, closeErr := decodeWebSocketClose(frame.payload)
			if closeErr != nil {
				socket.finish(1006, "", false, "PROTOCOL")
				break
			}
			cleanClose := true
			select {
			case <-closeSent:
			default:
				if err := beginWebSocketCloseWriteDeadline(targetConn, time.Now()); err != nil {
					socket.finish(1006, "", false, "CLOSE_TIMEOUT")
					cleanClose = false
					break
				}
				if err := writeFrame(webSocketFrame{fin: true, opcode: webSocketClose, payload: frame.payload}); err != nil {
					if !finishWebSocketRelayLoss(socket, lease, err) {
						socket.finish(1006, "", false, "WRITE")
					}
					cleanClose = false
				}
			}
			if cleanClose {
				socket.finish(code, reason, true, "")
			}
		case webSocketText, webSocketBinary:
			if fragmented {
				socket.finish(1006, "", false, "PROTOCOL")
				continue
			}
			messageOpcode, message = frame.opcode, append(message[:0], frame.payload...)
			if frame.fin {
				kind := "binary"
				if messageOpcode == webSocketText {
					kind = "text"
				}
				if err := socket.receive(kind, message); err != nil {
					socket.finish(1006, "", false, "RECEIVE")
				}
			} else {
				fragmented = true
			}
		case webSocketContinuation:
			if !fragmented || len(message) > defaultWebSocketMessageBytes-len(frame.payload) {
				socket.finish(1006, "", false, "PROTOCOL")
				continue
			}
			message = append(message, frame.payload...)
			if frame.fin {
				fragmented = false
				kind := "binary"
				if messageOpcode == webSocketText {
					kind = "text"
				}
				if err := socket.receive(kind, message); err != nil {
					socket.finish(1006, "", false, "RECEIVE")
				}
			}
		}
	}
	<-writerDone
}

func serializeWebSocketEvent(event webSocketEvent) js.Value {
	message := js.Global().Get("Object").New()
	message.Set("v", 2)
	message.Set("type", string(event.Kind))
	message.Set("request_id", event.RequestID)
	switch event.Kind {
	case webSocketEventOpen:
		message.Set("protocol", event.Protocol)
		setCookies := js.Global().Get("Array").New()
		for _, value := range event.SetCookies {
			setCookies.Call("push", value)
		}
		message.Set("set_cookies", setCookies)
	case webSocketEventMessage:
		array := js.Global().Get("Uint8Array").New(len(event.Data))
		js.CopyBytesToJS(array, event.Data)
		message.Set("data_kind", event.DataKind)
		message.Set("data", array)
	case webSocketEventError:
		message.Set("error", event.ErrorCode)
	case webSocketEventClose:
		message.Set("code", event.Code)
		message.Set("reason", event.Reason)
		message.Set("was_clean", event.WasClean)
	}
	return message
}

func serializeEvent(event streamEvent) js.Value {
	message := js.Global().Get("Object").New()
	switch event.Kind {
	case streamEventHeaders:
		message.Set("type", string(streamEventHeaders))
		headers := js.Global().Get("Array").New()
		for _, pair := range event.Headers.Headers {
			item := js.Global().Get("Array").New()
			item.Call("push", pair[0], pair[1])
			headers.Call("push", item)
		}
		message.Set("status", event.Headers.Status)
		message.Set("status_text", event.Headers.StatusText)
		message.Set("headers", headers)
		message.Set("url", event.Headers.URL)
		message.Set("redirected", event.Headers.Redirected)
		message.Set("response_type", event.Headers.ResponseType)
		message.Set("request_site", event.Headers.RequestSite)
		message.Set("redirect", map[string]any{
			"mode": event.Headers.Redirect.Mode, "is_redirect": event.Headers.Redirect.IsRedirect,
			"location": event.Headers.Redirect.Location,
		})
		informational := js.Global().Get("Array").New()
		for _, response := range event.Headers.Informational {
			headers := js.Global().Get("Array").New()
			for _, pair := range response.Headers {
				item := js.Global().Get("Array").New()
				item.Call("push", pair[0], pair[1])
				headers.Call("push", item)
			}
			informational.Call("push", map[string]any{"status": response.Status, "headers": headers})
		}
		message.Set("informational", informational)
	case streamEventPull:
		message.Set("type", string(streamEventPull))
		message.Set("seq", event.Seq)
		message.Set("desired_bytes", event.DesiredBytes)
	case streamEventChunk:
		message.Set("type", string(streamEventChunk))
		message.Set("seq", event.Seq)
		array := js.Global().Get("Uint8Array").New(len(event.Data))
		js.CopyBytesToJS(array, event.Data)
		message.Set("chunk", array.Get("buffer"))
	case streamEventTerminal:
		if event.Terminal.OK {
			message.Set("type", "CLOSE")
			message.Set("final_seq", event.Terminal.FinalSeq)
		} else {
			message.Set("type", "ERROR")
			message.Set("seq", event.Terminal.FinalSeq)
			classification := normalizeTransactionError(
				event.Terminal.Code,
				event.Terminal.Stage,
				event.Terminal.Retryable,
			)
			internalError, error := errorauthority.NewInternal(
				errorauthority.ErrorVersion,
				errorauthority.ErrorCode(classification.Code),
				errorauthority.ErrorStage(classification.Stage),
				event.RequestID,
				nil,
			)
			if error != nil {
				internalError, _ = errorauthority.NewInternal(
					errorauthority.ErrorVersion,
					errorauthority.CodeInternalFailed,
					errorauthority.StageInternal,
					event.RequestID,
					nil,
				)
			}
			message.Set("error", map[string]any{
				"code":           string(internalError.Code),
				"stage":          string(internalError.Stage),
				"retryable":      internalError.Retryable,
				"request_id":     internalError.RequestID,
				"internal_cause": internalError.InternalCause,
			})
		}
	}
	return message
}

func parseKernelAndRequest(args []js.Value) (*kernel, string, error) {
	if len(args) < 2 {
		return nil, "", newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	id, err := strconv.ParseUint(args[0].String(), 10, 64)
	if err != nil {
		return nil, "", newTransactionError("KERNEL_ID", "INTERNAL", false)
	}
	requestID, err := requiredString(args[1], 128)
	if err != nil || !validRequestID(requestID) {
		return nil, "", newTransactionError("REQUEST_ID_INVALID", "INTERNAL", false)
	}
	kernel, err := lookup(id)
	if err != nil {
		return nil, "", newTransactionError("KERNEL_ID", "INTERNAL", false)
	}
	return kernel, requestID, nil
}

func createKernel(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return rejectType("configuration required")
	}
	return promise(func() (any, error) {
		id, err := dialKernel(args[0])
		if err != nil {
			return nil, publicError(err)
		}
		return strconv.FormatUint(id, 10), nil
	})
}

func kernelTransactionStart(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return rejectType("kernel id and start required")
	}
	id, err := strconv.ParseUint(args[0].String(), 10, 64)
	if err != nil {
		return rejectType("invalid kernel id")
	}
	return promise(func() (any, error) {
		kernel, err := lookup(id)
		if err != nil {
			return nil, publicError(err)
		}
		result, err := kernel.startTransaction(args[1])
		if err != nil {
			return nil, publicError(err)
		}
		return result, nil
	})
}

func requiredSequence(value js.Value) (uint64, error) {
	if value.Type() != js.TypeNumber {
		return 0, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	number := value.Float()
	sequence := uint64(number)
	if number < 0 || number > 1<<53-1 || number != float64(sequence) {
		return 0, newTransactionError("MESSAGE_SCHEMA", "INTERNAL", false)
	}
	return sequence, nil
}

func validStreamCode(code string) bool {
	if code == "" || len(code) > 64 {
		return false
	}
	for _, character := range code {
		if character != '_' && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}

func kernelTransactionFrame(this js.Value, args []js.Value) any {
	if len(args) != 3 {
		return rejectType("kernel id, stream id, and frame required")
	}
	return promise(func() (any, error) {
		kernel, requestID, err := parseKernelAndRequest(args)
		if err != nil {
			return nil, publicError(err)
		}
		frame := args[2]
		frameType, err := requiredString(frame.Get("type"), 16)
		if err != nil {
			return nil, publicError(err)
		}
		kernel.mu.Lock()
		transaction := kernel.requests[requestID]
		kernel.mu.Unlock()
		if transaction == nil {
			if frameType == "CANCEL" {
				return nil, nil
			}
			return nil, publicError(newTransactionError("REQUEST_NOT_ACTIVE", "INTERNAL", false))
		}
		switch frameType {
		case "PULL":
			if err := objectFields(frame, map[string]struct{}{"type": {}, "seq": {}, "desired_bytes": {}}); err != nil {
				return nil, publicError(err)
			}
			sequence, err := requiredSequence(frame.Get("seq"))
			if err != nil {
				return nil, publicError(err)
			}
			desired, err := requiredSafeUint(frame.Get("desired_bytes"), uint64(transaction.maxChunk))
			if err != nil {
				return nil, publicError(newTransactionError("PULL_LIMIT", "BODY", false))
			}
			if err := transaction.requestDownload(sequence, int(desired)); err != nil {
				return nil, publicError(err)
			}
		case "CHUNK":
			if err := objectFields(frame, map[string]struct{}{"type": {}, "seq": {}, "chunk": {}}); err != nil {
				return nil, publicError(err)
			}
			sequence, err := requiredSequence(frame.Get("seq"))
			if err != nil {
				return nil, publicError(err)
			}
			buffer := frame.Get("chunk")
			if buffer.Type() != js.TypeObject || !buffer.InstanceOf(js.Global().Get("ArrayBuffer")) {
				return nil, publicError(newTransactionError("BODY_CHUNK_INVALID", "BODY", false))
			}
			length := buffer.Get("byteLength").Int()
			if length < 1 || length > transaction.maxChunk {
				return nil, publicError(newTransactionError("BODY_CHUNK_LIMIT", "BODY", false))
			}
			chunk := make([]byte, length)
			if js.CopyBytesToGo(chunk, js.Global().Get("Uint8Array").New(buffer)) != length {
				return nil, publicError(newTransactionError("BODY_CHUNK_INVALID", "BODY", false))
			}
			ack, err := transaction.acceptUpload(sequence, chunk)
			if err != nil {
				return nil, publicError(err)
			}
			select {
			case err := <-ack:
				if err != nil {
					return nil, publicError(err)
				}
			case <-transaction.Context().Done():
				return nil, errors.New("CANCELED")
			}
		case "CLOSE":
			if err := objectFields(frame, map[string]struct{}{"type": {}, "final_seq": {}}); err != nil {
				return nil, publicError(err)
			}
			sequence, err := requiredSequence(frame.Get("final_seq"))
			if err != nil {
				return nil, publicError(err)
			}
			if err := transaction.endUpload(sequence); err != nil {
				return nil, publicError(err)
			}
		case "ERROR":
			if err := objectFields(frame, map[string]struct{}{"type": {}, "seq": {}, "code": {}}); err != nil {
				return nil, publicError(err)
			}
			sequence, err := requiredSequence(frame.Get("seq"))
			if err != nil {
				return nil, publicError(err)
			}
			code, err := requiredString(frame.Get("code"), 64)
			if err != nil || !validStreamCode(code) {
				return nil, publicError(newTransactionError("ERROR_CODE", "BODY", false))
			}
			if err := transaction.errorFrame(sequence, code); err != nil {
				return nil, publicError(err)
			}
		case "CANCEL":
			if err := objectFields(frame, map[string]struct{}{"type": {}, "seq": {}, "code": {}}); err != nil {
				return nil, publicError(err)
			}
			sequence, err := requiredSequence(frame.Get("seq"))
			if err != nil {
				return nil, publicError(err)
			}
			code, err := requiredString(frame.Get("code"), 64)
			if err != nil || !validStreamCode(code) {
				return nil, publicError(newTransactionError("CANCEL_CODE", "BODY", false))
			}
			if err := transaction.cancelFrame(sequence, code); err != nil {
				return nil, publicError(err)
			}
		default:
			return nil, publicError(newTransactionError("FRAME_TYPE", "BODY", false))
		}
		return nil, nil
	})
}

func kernelWebSocketStart(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return rejectType("kernel id and websocket start required")
	}
	id, err := strconv.ParseUint(args[0].String(), 10, 64)
	if err != nil {
		return rejectType("invalid kernel id")
	}
	return promise(func() (any, error) {
		kernel, err := lookup(id)
		if err != nil {
			return nil, publicError(err)
		}
		result, err := kernel.startWebSocket(args[1])
		if err != nil {
			return nil, publicError(err)
		}
		return result, nil
	})
}

func kernelWebSocketSend(this js.Value, args []js.Value) any {
	if len(args) != 5 || args[2].Type() != js.TypeNumber || args[3].Type() != js.TypeString {
		return rejectType("kernel id, request id, sequence, kind, and payload required")
	}
	sequence := args[2].Int()
	if sequence < 0 || float64(sequence) != args[2].Float() {
		return rejectType("invalid sequence")
	}
	size := args[4].Get("byteLength")
	if size.Type() != js.TypeNumber || size.Int() < 0 || float64(size.Int()) != size.Float() || size.Int() > defaultWebSocketMessageBytes {
		return rejectType("invalid payload")
	}
	payload, err := bytesFromJS(args[4], size.Int())
	if err != nil {
		return rejectType("invalid payload")
	}
	kind := args[3].String()
	return promise(func() (any, error) {
		kernel, requestID, err := parseKernelAndRequest(args)
		if err != nil {
			return nil, publicError(err)
		}
		kernel.mu.Lock()
		socket := kernel.sockets[requestID]
		kernel.mu.Unlock()
		if socket == nil {
			return nil, publicError(newTransactionError("REQUEST_NOT_ACTIVE", "INTERNAL", false))
		}
		ack, err := socket.send(uint64(sequence), kind, payload)
		if err != nil {
			return nil, publicError(err)
		}
		select {
		case err := <-ack:
			if err != nil {
				return nil, publicError(err)
			}
			return map[string]any{"v": 2, "request_id": requestID, "seq": sequence, "acknowledged": true}, nil
		case <-socket.Context().Done():
			return nil, errors.New("CANCELED")
		}
	})
}

func kernelWebSocketClose(this js.Value, args []js.Value) any {
	if len(args) != 4 || args[2].Type() != js.TypeNumber || args[3].Type() != js.TypeString {
		return rejectType("kernel id, request id, close code, and reason required")
	}
	code := args[2].Int()
	if code < 0 || code > 65535 || float64(code) != args[2].Float() || len(args[3].String()) > 123 {
		return rejectType("invalid close")
	}
	reason := args[3].String()
	return promise(func() (any, error) {
		kernel, requestID, err := parseKernelAndRequest(args)
		if err != nil {
			return nil, publicError(err)
		}
		kernel.mu.Lock()
		socket := kernel.sockets[requestID]
		kernel.mu.Unlock()
		if socket == nil {
			return nil, publicError(newTransactionError("REQUEST_NOT_ACTIVE", "INTERNAL", false))
		}
		ack, err := socket.close(uint16(code), reason)
		if err != nil {
			return nil, publicError(err)
		}
		select {
		case err := <-ack:
			if err != nil {
				return nil, publicError(err)
			}
			return map[string]any{"v": 2, "request_id": requestID, "code": code, "closed": true}, nil
		case <-socket.Context().Done():
			return nil, errors.New("CANCELED")
		}
	})
}

func kernelWebSocketCancel(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return rejectType("kernel id and request id required")
	}
	return promise(func() (any, error) {
		kernel, requestID, err := parseKernelAndRequest(args)
		if err != nil {
			return nil, publicError(err)
		}
		kernel.mu.Lock()
		socket := kernel.sockets[requestID]
		kernel.mu.Unlock()
		if socket == nil {
			return map[string]any{"v": 2, "request_id": requestID, "canceled": false}, nil
		}
		socket.cancelSocket()
		return map[string]any{"v": 2, "request_id": requestID, "canceled": true}, nil
	})
}

func (k *kernel) close() {
	k.mu.Lock()
	if k.closed {
		k.mu.Unlock()
		return
	}
	k.closed = true
	requests := make([]*transaction, 0, len(k.requests))
	for _, request := range k.requests {
		requests = append(requests, request)
	}
	sockets := make([]*webSocketTransaction, 0, len(k.sockets))
	for _, socket := range k.sockets {
		sockets = append(sockets, socket)
	}
	k.mu.Unlock()
	for _, request := range requests {
		request.cancelTransaction()
	}
	for _, socket := range sockets {
		socket.cancelSocket()
	}
	if k.httpPool != nil {
		_ = k.httpPool.Close()
	}
	if k.relays != nil {
		_ = k.relays.Close()
	}
}

func kernelBindDocument(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		return rejectType("kernel id and document binding required")
	}
	id, err := strconv.ParseUint(args[0].String(), 10, 64)
	if err != nil {
		return rejectType("invalid kernel id")
	}
	return promise(func() (any, error) {
		kernel, err := lookup(id)
		if err != nil {
			return nil, publicError(err)
		}
		value := args[1]
		allowed := map[string]struct{}{
			"profile_id": {}, "session_id": {}, "tab_id": {}, "origin_id": {},
			"policy_epoch": {}, "capability_epoch": {}, "isolation_key_ref": {}, "persona": {},
			"source_client_id": {}, "document_id": {}, "entry_id": {},
		}
		if err := objectFields(value, allowed); err != nil {
			return nil, publicError(err)
		}
		profileID, err := requiredString(value.Get("profile_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		sessionID, err := requiredString(value.Get("session_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		tabID, err := requiredString(value.Get("tab_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		originID, err := requiredString(value.Get("origin_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		policyEpoch, err := requiredSafeInteger(value.Get("policy_epoch"), 1, 1<<30)
		if err != nil {
			return nil, publicError(err)
		}
		capabilityEpoch, err := requiredSafeInteger(value.Get("capability_epoch"), 1, 1<<30)
		if err != nil {
			return nil, publicError(err)
		}
		isolationKeyRef, err := requiredString(value.Get("isolation_key_ref"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		persona, err := requiredString(value.Get("persona"), 64)
		if err != nil || !kernel.matchesBaseBinding(profileID, sessionID, tabID, originID, policyEpoch, capabilityEpoch, isolationKeyRef, persona) {
			return nil, publicError(newTransactionError("REQUEST_BINDING", "POLICY", false))
		}
		sourceClientID, err := requiredString(value.Get("source_client_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		documentID, err := requiredString(value.Get("document_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		entryID, err := requiredString(value.Get("entry_id"), 256)
		if err != nil {
			return nil, publicError(err)
		}
		binding := kernelDocumentBinding{sourceClientID: sourceClientID, documentID: documentID, entryID: entryID}
		if err := kernel.bindDocument(binding); err != nil {
			return nil, publicError(err)
		}
		return map[string]any{"v": 2, "bound": true}, nil
	})
}

func kernelClose(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		return nil
	}
	id, _ := strconv.ParseUint(args[0].String(), 10, 64)
	kernels.Lock()
	kernel := kernels.items[id]
	delete(kernels.items, id)
	kernels.Unlock()
	if kernel != nil {
		kernel.close()
	}
	return nil
}

func main() {
	js.Global().Set("__zeroproxyKernelCreateV2", js.FuncOf(createKernel))
	js.Global().Set("__zeroproxyKernelBindDocumentV2", js.FuncOf(kernelBindDocument))
	js.Global().Set("__zeroproxyKernelTransactionStartV2", js.FuncOf(kernelTransactionStart))
	js.Global().Set("__zeroproxyKernelTransactionFrameV2", js.FuncOf(kernelTransactionFrame))
	js.Global().Set("__zeroproxyKernelWebSocketStartV2", js.FuncOf(kernelWebSocketStart))
	js.Global().Set("__zeroproxyKernelWebSocketSendV2", js.FuncOf(kernelWebSocketSend))
	js.Global().Set("__zeroproxyKernelWebSocketCloseV2", js.FuncOf(kernelWebSocketClose))
	js.Global().Set("__zeroproxyKernelWebSocketCancelV2", js.FuncOf(kernelWebSocketCancel))
	js.Global().Set("__zeroproxyKernelCloseV2", js.FuncOf(kernelClose))
	select {}
}

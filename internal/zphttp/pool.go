package zphttp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gosuda/zeroproxy/internal/httppersona"
)

var ErrPoolClosed = errors.New("HTTP connection pool closed")
var ErrPoolCapacity = errors.New("HTTP connection pool capacity exhausted")

type UnsafeRequestError struct {
	Bytes int64
	Err   error
}

func (err *UnsafeRequestError) Error() string {
	return "HTTP request failed after application bytes were written"
}

func (err *UnsafeRequestError) Unwrap() error {
	return err.Err
}

type RequestClass uint8

const (
	DocumentScript RequestClass = iota
	Ordinary
	LongLived
	requestClassCount
)

type PoolLimits struct {
	MaxOrigins           int
	MaxIdlePerClass      int
	DocumentScriptActive int
	OrdinaryActive       int
	LongLivedActive      int
	DocumentScriptH2     int
	OrdinaryH2           int
	LongLivedH2          int
	IdleTimeout          time.Duration
}

func DefaultPoolLimits() PoolLimits {
	return PoolLimits{
		MaxOrigins: 32, MaxIdlePerClass: 2,
		DocumentScriptActive: 6, OrdinaryActive: 6, LongLivedActive: 2,
		DocumentScriptH2: 32, OrdinaryH2: 64, LongLivedH2: 8,
		IdleTimeout: 90 * time.Second,
	}
}

func (limits PoolLimits) valid() bool {
	return limits.MaxOrigins > 0 && limits.MaxIdlePerClass >= 0 &&
		limits.DocumentScriptActive > 0 && limits.OrdinaryActive > 0 && limits.LongLivedActive > 0 &&
		limits.DocumentScriptH2 > 0 && limits.OrdinaryH2 > 0 && limits.LongLivedH2 > 0 &&
		limits.IdleTimeout > 0
}

func (limits PoolLimits) activeLimit(class RequestClass) int {
	switch class {
	case DocumentScript:
		return limits.DocumentScriptActive
	case Ordinary:
		return limits.OrdinaryActive
	case LongLived:
		return limits.LongLivedActive
	default:
		return 0
	}
}

func (limits PoolLimits) h2Limit(class RequestClass) int {
	switch class {
	case DocumentScript:
		return limits.DocumentScriptH2
	case Ordinary:
		return limits.OrdinaryH2
	case LongLived:
		return limits.LongLivedH2
	default:
		return 0
	}
}

type OwnedTarget struct {
	Conn *TargetConn
	Done func(error) error

	closeOnce sync.Once
	closeErr  error
}

func (target *OwnedTarget) close(cause error) error {
	if target == nil {
		return nil
	}
	target.closeOnce.Do(func() {
		if target.Conn != nil {
			target.closeErr = target.Conn.Close()
		}
		if target.Done != nil {
			target.closeErr = errors.Join(target.closeErr, target.Done(cause))
		}
	})
	return target.closeErr
}

type DialTarget func(context.Context) (*OwnedTarget, error)

type InformationalResponse struct {
	Status  int
	Headers http.Header
}

type RoundTripResult struct {
	Response      *http.Response
	Informational []InformationalResponse
}

type idleHTTP1 struct {
	target    *OwnedTarget
	idleSince time.Time
}

type http2State struct {
	target    *OwnedTarget
	client    *httppersona.HTTP2Client
	inFlight  int
	idleSince time.Time
}

type classPool struct {
	idle    []*idleHTTP1
	active  int
	dialing bool
	h2      *http2State
	changed chan struct{}
}

type originPool struct {
	classes  [requestClassCount]classPool
	lastUsed time.Time
}

type Pool struct {
	mu      sync.Mutex
	limits  PoolLimits
	origins map[string]*originPool
	owned   map[*OwnedTarget]struct{}
	closed  bool
	stop    chan struct{}
}

func NewPool(limits PoolLimits) (*Pool, error) {
	if !limits.valid() {
		return nil, errors.New("invalid HTTP pool limits")
	}
	pool := &Pool{
		limits: limits, origins: make(map[string]*originPool),
		owned: make(map[*OwnedTarget]struct{}), stop: make(chan struct{}),
	}
	go pool.reapLoop()
	return pool, nil
}

func newOriginPool(now time.Time) *originPool {
	origin := &originPool{lastUsed: now}
	for index := range origin.classes {
		origin.classes[index].changed = make(chan struct{})
	}
	return origin
}

func notify(pool *classPool) {
	close(pool.changed)
	pool.changed = make(chan struct{})
}

func (pool *Pool) RoundTrip(ctx context.Context, key string, class RequestClass, request *http.Request, headerOrder [][2]string, dial DialTarget) (RoundTripResult, error) {
	if key == "" || class >= requestClassCount || request == nil || dial == nil {
		return RoundTripResult{}, errors.New("invalid HTTP pool request")
	}
	for {
		now := time.Now()
		pool.mu.Lock()
		if pool.closed {
			pool.mu.Unlock()
			return RoundTripResult{}, ErrPoolClosed
		}
		origin, closures, err := pool.originLocked(key, now)
		if len(closures) != 0 {
			pool.mu.Unlock()
			closeTargets(closures, nil)
			continue
		}
		if err != nil {
			pool.mu.Unlock()
			return RoundTripResult{}, err
		}
		state := &origin.classes[class]
		origin.lastUsed = now
		if state.h2 != nil {
			h2 := state.h2
			if h2.client.CanTakeNewRequest() && h2.inFlight < pool.limits.h2Limit(class) {
				h2.inFlight++
				h2.idleSince = time.Time{}
				pool.mu.Unlock()
				return pool.roundTripHTTP2(key, class, h2, request, headerOrder)
			}
			if !h2.client.CanTakeNewRequest() && h2.inFlight == 0 {
				state.h2 = nil
				delete(pool.owned, h2.target)
				notify(state)
				pool.mu.Unlock()
				_ = h2.client.Close()
				_ = h2.target.close(errors.New("stale HTTP/2 connection"))
				continue
			}
			changed := state.changed
			pool.mu.Unlock()
			select {
			case <-ctx.Done():
				return RoundTripResult{}, ctx.Err()
			case <-changed:
				continue
			}
		}
		if count := len(state.idle); count != 0 {
			idle := state.idle[count-1]
			state.idle = state.idle[:count-1]
			state.active++
			pool.mu.Unlock()
			result, retry, err := pool.roundTripHTTP1(ctx, key, class, idle.target, request, headerOrder, true)
			if retry {
				continue
			}
			return result, err
		}
		if !state.dialing && state.active < pool.limits.activeLimit(class) {
			state.dialing = true
			pool.mu.Unlock()
			target, dialErr := dial(ctx)
			var h2Client *httppersona.HTTP2Client
			if dialErr == nil && target != nil && target.Conn != nil && target.Conn.Protocol == "h2" {
				h2Client, dialErr = httppersona.NewHTTP2Client(target.Conn)
			}
			pool.mu.Lock()
			origin = pool.origins[key]
			if origin == nil {
				pool.mu.Unlock()
				if target != nil {
					_ = target.close(ErrPoolClosed)
				}
				return RoundTripResult{}, ErrPoolClosed
			}
			state = &origin.classes[class]
			state.dialing = false
			notify(state)
			if dialErr != nil {
				pool.mu.Unlock()
				if target != nil {
					_ = target.close(dialErr)
				}
				return RoundTripResult{}, dialErr
			}
			if target == nil || target.Conn == nil {
				pool.mu.Unlock()
				return RoundTripResult{}, errors.New("HTTP pool dial returned no connection")
			}
			if pool.closed {
				pool.mu.Unlock()
				_ = target.close(ErrPoolClosed)
				return RoundTripResult{}, ErrPoolClosed
			}
			pool.owned[target] = struct{}{}
			if target.Conn.Protocol == "h2" {
				if state.h2 != nil {
					delete(pool.owned, target)
					pool.mu.Unlock()
					_ = h2Client.Close()
					_ = target.close(nil)
					continue
				}
				state.h2 = &http2State{target: target, client: h2Client, inFlight: 1}
				h2 := state.h2
				pool.mu.Unlock()
				return pool.roundTripHTTP2(key, class, h2, request, headerOrder)
			}
			if target.Conn.Protocol != "http/1.1" {
				delete(pool.owned, target)
				pool.mu.Unlock()
				err := errors.New("unsupported pooled HTTP protocol")
				_ = target.close(err)
				return RoundTripResult{}, err
			}
			state.active++
			pool.mu.Unlock()
			result, _, err := pool.roundTripHTTP1(ctx, key, class, target, request, headerOrder, false)
			return result, err
		}
		changed := state.changed
		pool.mu.Unlock()
		select {
		case <-ctx.Done():
			return RoundTripResult{}, ctx.Err()
		case <-changed:
		}
	}
}

func (pool *Pool) originLocked(key string, now time.Time) (*originPool, []*OwnedTarget, error) {
	if origin := pool.origins[key]; origin != nil {
		return origin, nil, nil
	}
	if len(pool.origins) < pool.limits.MaxOrigins {
		origin := newOriginPool(now)
		pool.origins[key] = origin
		return origin, nil, nil
	}
	var oldestKey string
	var oldest *originPool
	for candidateKey, candidate := range pool.origins {
		if !originIdle(candidate) || oldest != nil && !candidate.lastUsed.Before(oldest.lastUsed) {
			continue
		}
		oldestKey, oldest = candidateKey, candidate
	}
	if oldest == nil {
		return nil, nil, ErrPoolCapacity
	}
	closures := pool.removeOriginLocked(oldestKey, oldest)
	return nil, closures, nil
}

func originIdle(origin *originPool) bool {
	for index := range origin.classes {
		state := &origin.classes[index]
		if state.active != 0 || state.dialing || state.h2 != nil && state.h2.inFlight != 0 {
			return false
		}
	}
	return true
}

func (pool *Pool) removeOriginLocked(key string, origin *originPool) []*OwnedTarget {
	delete(pool.origins, key)
	closures := make([]*OwnedTarget, 0)
	for index := range origin.classes {
		state := &origin.classes[index]
		for _, idle := range state.idle {
			delete(pool.owned, idle.target)
			closures = append(closures, idle.target)
		}
		state.idle = nil
		if state.h2 != nil {
			delete(pool.owned, state.h2.target)
			closures = append(closures, state.h2.target)
			state.h2 = nil
		}
		notify(state)
	}
	return closures
}

type countingWriter struct {
	io.Writer
	written atomic.Int64
}

func (writer *countingWriter) Write(buffer []byte) (int, error) {
	count, err := writer.Writer.Write(buffer)
	writer.written.Add(int64(count))
	return count, err
}
func settleHTTP1Writer(request *http.Request, target *OwnedTarget, writeDone <-chan error) (error, bool) {
	select {
	case err := <-writeDone:
		return err, true
	default:
	}
	var bodyErr error
	if request.Body != nil {
		bodyErr = request.Body.Close()
	}
	closeErr := target.Conn.Close()
	select {
	case err := <-writeDone:
		return errors.Join(bodyErr, closeErr, err), true
	default:
		return errors.Join(bodyErr, closeErr, errors.New("HTTP response completed before request write")), false
	}
}

func (pool *Pool) roundTripHTTP1(ctx context.Context, key string, class RequestClass, target *OwnedTarget, request *http.Request, headerOrder [][2]string, reused bool) (RoundTripResult, bool, error) {
	counter := &countingWriter{Writer: target.Conn}
	writeDone := make(chan error, 1)
	stopWatch := make(chan struct{})
	go func() { writeDone <- httppersona.WriteHTTP1(counter, request, headerOrder) }()
	go func() {
		select {
		case <-ctx.Done():
			_ = target.Conn.Close()
		case <-stopWatch:
		}
	}()
	response, informational, err := readFinalResponse(bufio.NewReader(target.Conn), request)
	if err != nil {
		close(stopWatch)
		writeErr, writeComplete := settleHTTP1Writer(request, target, writeDone)
		cause := errors.Join(err, writeErr)
		written := counter.written.Load()
		if written != 0 {
			cause = &UnsafeRequestError{Bytes: written, Err: cause}
		}
		closeErr := pool.discardHTTP1(key, class, target, cause)
		cause = errors.Join(cause, closeErr)
		if reused && writeComplete && written == 0 && replayableRequest(request) {
			if resetErr := resetRequestBody(request); resetErr == nil {
				return RoundTripResult{}, true, nil
			}
		}
		return RoundTripResult{}, false, cause
	}
	response.Body = &pooledBody{
		ReadCloser: response.Body,
		finish: func(complete bool, bodyErr error) error {
			close(stopWatch)
			writeErr, writeComplete := settleHTTP1Writer(request, target, writeDone)
			cause := errors.Join(bodyErr, writeErr)
			if bodyErr != nil {
				cause = &UnsafeRequestError{Bytes: 1, Err: cause}
			}
			reusable := complete && writeComplete && bodyErr == nil && writeErr == nil && !request.Close && !response.Close
			return pool.releaseHTTP1(key, class, target, reusable, cause)
		},
	}
	return RoundTripResult{Response: response, Informational: informational}, false, nil
}

func readFinalResponse(reader *bufio.Reader, request *http.Request) (*http.Response, []InformationalResponse, error) {
	informational := make([]InformationalResponse, 0, 2)
	for len(informational) <= 16 {
		response, err := http.ReadResponse(reader, request)
		if err != nil {
			return nil, informational, err
		}
		if response.StatusCode < 100 || response.StatusCode >= 200 || response.StatusCode == http.StatusSwitchingProtocols {
			return response, informational, nil
		}
		informational = append(informational, InformationalResponse{Status: response.StatusCode, Headers: response.Header.Clone()})
		_ = response.Body.Close()
	}
	return nil, informational, errors.New("too many informational HTTP responses")
}

func replayableRequest(request *http.Request) bool {
	return request.Body == nil || request.Body == http.NoBody ||
		request.GetBody != nil && request.ContentLength >= 0 && request.ContentLength <= 256<<10
}

func resetRequestBody(request *http.Request) error {
	if request.Body == nil || request.Body == http.NoBody {
		return nil
	}
	if request.GetBody == nil || request.ContentLength < 0 || request.ContentLength > 256<<10 {
		return errors.New("request body is not replayable")
	}
	body, err := request.GetBody()
	if err != nil {
		return err
	}
	request.Body = body
	return nil
}

func (pool *Pool) discardHTTP1(key string, class RequestClass, target *OwnedTarget, cause error) error {
	pool.mu.Lock()
	if origin := pool.origins[key]; origin != nil {
		state := &origin.classes[class]
		if state.active > 0 {
			state.active--
		}
		notify(state)
	}
	delete(pool.owned, target)
	pool.mu.Unlock()
	return target.close(cause)
}

func (pool *Pool) releaseHTTP1(key string, class RequestClass, target *OwnedTarget, reusable bool, cause error) error {
	pool.mu.Lock()
	origin := pool.origins[key]
	if origin == nil || pool.closed {
		reusable = false
		delete(pool.owned, target)
	} else {
		state := &origin.classes[class]
		if state.active > 0 {
			state.active--
		}
		if reusable && len(state.idle) < pool.limits.MaxIdlePerClass {
			state.idle = append(state.idle, &idleHTTP1{target: target, idleSince: time.Now()})
			origin.lastUsed = time.Now()
		} else {
			reusable = false
			delete(pool.owned, target)
		}
		notify(state)
	}
	pool.mu.Unlock()
	if !reusable {
		return target.close(cause)
	}
	return nil
}

func (pool *Pool) roundTripHTTP2(key string, class RequestClass, h2 *http2State, request *http.Request, headerOrder [][2]string) (RoundTripResult, error) {
	response, err := h2.client.RoundTrip(request, headerOrder)
	if err != nil {
		cause := &UnsafeRequestError{Bytes: 1, Err: err}
		closeErr := pool.discardHTTP2(key, class, h2, cause)
		return RoundTripResult{}, errors.Join(cause, closeErr)
	}
	response.Body = &pooledBody{
		ReadCloser: response.Body,
		finish: func(_ bool, bodyErr error) error {
			return pool.releaseHTTP2(key, class, h2, bodyErr)
		},
	}
	return RoundTripResult{Response: response}, nil
}

func (pool *Pool) discardHTTP2(key string, class RequestClass, h2 *http2State, cause error) error {
	pool.mu.Lock()
	if origin := pool.origins[key]; origin != nil {
		state := &origin.classes[class]
		if state.h2 == h2 {
			state.h2 = nil
			delete(pool.owned, h2.target)
			notify(state)
		}
	}
	pool.mu.Unlock()
	_ = h2.client.Close()
	return h2.target.close(cause)
}

func (pool *Pool) releaseHTTP2(key string, class RequestClass, h2 *http2State, bodyErr error) error {
	if bodyErr != nil && !h2.client.CanTakeNewRequest() {
		cause := &UnsafeRequestError{Bytes: 1, Err: bodyErr}
		return pool.discardHTTP2(key, class, h2, cause)
	}
	pool.mu.Lock()
	if origin := pool.origins[key]; origin != nil {
		state := &origin.classes[class]
		if state.h2 == h2 {
			if h2.inFlight > 0 {
				h2.inFlight--
			}
			if h2.inFlight == 0 {
				h2.idleSince = time.Now()
			}
			notify(state)
		}
	}
	pool.mu.Unlock()
	return nil
}

type pooledBody struct {
	io.ReadCloser
	finish    func(bool, error) error
	once      sync.Once
	eof       bool
	finishErr error
}

func (body *pooledBody) finalize(complete bool, cause error) error {
	body.once.Do(func() { body.finishErr = body.finish(complete, cause) })
	return body.finishErr
}

func (body *pooledBody) Read(buffer []byte) (int, error) {
	count, err := body.ReadCloser.Read(buffer)
	if errors.Is(err, io.EOF) {
		body.eof = true
		_ = body.finalize(true, nil)
	} else if err != nil {
		err = errors.Join(err, body.finalize(false, err))
	}
	return count, err
}

func (body *pooledBody) Close() error {
	err := body.ReadCloser.Close()
	return errors.Join(err, body.finalize(body.eof, err))
}

func (pool *Pool) reapLoop() {
	interval := pool.limits.IdleTimeout / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			pool.reap(now)
		case <-pool.stop:
			return
		}
	}
}

func (pool *Pool) reap(now time.Time) {
	pool.mu.Lock()
	closures := make([]*OwnedTarget, 0)
	for key, origin := range pool.origins {
		for index := range origin.classes {
			state := &origin.classes[index]
			kept := state.idle[:0]
			for _, idle := range state.idle {
				if now.Sub(idle.idleSince) >= pool.limits.IdleTimeout {
					delete(pool.owned, idle.target)
					closures = append(closures, idle.target)
				} else {
					kept = append(kept, idle)
				}
			}
			state.idle = kept
			if state.h2 != nil && state.h2.inFlight == 0 && !state.h2.idleSince.IsZero() && now.Sub(state.h2.idleSince) >= pool.limits.IdleTimeout {
				delete(pool.owned, state.h2.target)
				closures = append(closures, state.h2.target)
				state.h2 = nil
			}
			notify(state)
		}
		if originEmpty(origin) {
			delete(pool.origins, key)
		}
	}
	pool.mu.Unlock()
	closeTargets(closures, nil)
}

func originEmpty(origin *originPool) bool {
	for index := range origin.classes {
		state := &origin.classes[index]
		if state.active != 0 || state.dialing || len(state.idle) != 0 || state.h2 != nil {
			return false
		}
	}
	return true
}

func closeTargets(targets []*OwnedTarget, cause error) {
	for _, target := range targets {
		_ = target.close(cause)
	}
}

func (pool *Pool) Close() error {
	pool.mu.Lock()
	if pool.closed {
		pool.mu.Unlock()
		return nil
	}
	pool.closed = true
	close(pool.stop)
	targets := make([]*OwnedTarget, 0, len(pool.owned))
	for target := range pool.owned {
		targets = append(targets, target)
	}
	pool.origins = make(map[string]*originPool)
	pool.owned = make(map[*OwnedTarget]struct{})
	pool.mu.Unlock()
	var closeErr error
	for _, target := range targets {
		closeErr = errors.Join(closeErr, target.close(ErrPoolClosed))
	}
	return closeErr
}

package relaymanager

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const defaultMaxCandidates = 8

var ErrClosed = errors.New("relay manager closed")

// Candidate is the immutable identity of one member of an ordered, verified
// relay-profile set. Credentials remain in the dialer rather than in manager
// health state.
type Candidate struct {
	ProfileID string
	Digest    [32]byte
}

// Engine owns one authenticated carrier and all transport state layered on it.
type Engine interface {
	Close() error
}

// Dialer establishes and authenticates a carrier for candidate.
type Dialer func(context.Context, Candidate) (Engine, error)

// Config bounds manager state and carrier lifetime.
type Config struct {
	MaxCandidates int
	MaxHotIdle    int
	IdleTimeout   time.Duration
	BackoffBase   time.Duration
	BackoffMax    time.Duration
	Now           func() time.Time
	Jitter        func(time.Duration) time.Duration
}

// TerminalRelayLoss means a relay failed after application bytes crossed the
// carrier. Retrying on another relay could duplicate an unsafe request.
type TerminalRelayLoss struct {
	Candidate Candidate
	Bytes     uint64
	Cause     error
}

func (e *TerminalRelayLoss) Error() string {
	return fmt.Sprintf("terminal relay loss after %d application bytes on %q: %v", e.Bytes, e.Candidate.ProfileID, e.Cause)
}

func (e *TerminalRelayLoss) Unwrap() error { return e.Cause }

// UnavailableError reports that every approved candidate is cooling down or
// failed to dial. RetryAt is zero when no cooldown deadline is known.
type UnavailableError struct {
	RetryAt time.Time
}

func (e *UnavailableError) Error() string { return "no approved relay available" }

type entry struct {
	candidate    Candidate
	engine       Engine
	generation   uint64
	refs         int
	lastIdle     time.Time
	failures     uint32
	cooldownTill time.Time
	dialing      chan struct{}
	idleTimer    *time.Timer
}

// Health is a bounded snapshot with one record per configured candidate.
type Health struct {
	Candidate     Candidate
	Hot           bool
	ActiveLeases  int
	Failures      uint32
	CooldownUntil time.Time
}

type Manager struct {
	mu         sync.Mutex
	entries    []entry
	dial       Dialer
	maxHotIdle int
	idle       time.Duration
	base       time.Duration
	cap        time.Duration
	now        func() time.Time
	jitter     func(time.Duration) time.Duration
	closed     bool
	closeCh    chan struct{}
}

func New(candidates []Candidate, dial Dialer, config Config) (*Manager, error) {
	if dial == nil {
		return nil, errors.New("relay dialer required")
	}
	maxCandidates := config.MaxCandidates
	if maxCandidates == 0 {
		maxCandidates = defaultMaxCandidates
	}
	if maxCandidates < 1 || len(candidates) < 1 || len(candidates) > maxCandidates {
		return nil, errors.New("invalid approved relay candidate count")
	}
	seenIDs := make(map[string]struct{}, len(candidates))
	seenDigests := make(map[[32]byte]struct{}, len(candidates))
	entries := make([]entry, len(candidates))
	for i, candidate := range candidates {
		if candidate.ProfileID == "" || candidate.Digest == ([32]byte{}) {
			return nil, errors.New("invalid approved relay candidate")
		}
		if _, duplicate := seenIDs[candidate.ProfileID]; duplicate {
			return nil, errors.New("duplicate approved relay profile ID")
		}
		if _, duplicate := seenDigests[candidate.Digest]; duplicate {
			return nil, errors.New("duplicate approved relay profile digest")
		}
		seenIDs[candidate.ProfileID] = struct{}{}
		seenDigests[candidate.Digest] = struct{}{}
		entries[i].candidate = candidate
	}
	if config.MaxHotIdle < 0 || config.IdleTimeout < 0 || config.BackoffBase < 0 || config.BackoffMax < 0 {
		return nil, errors.New("invalid relay manager limits")
	}
	maxHotIdle := config.MaxHotIdle
	if maxHotIdle == 0 {
		maxHotIdle = 2
	}
	idle := config.IdleTimeout
	if idle == 0 {
		idle = 30 * time.Second
	}
	base := config.BackoffBase
	if base == 0 {
		base = 250 * time.Millisecond
	}
	cap := config.BackoffMax
	if cap == 0 {
		cap = 30 * time.Second
	}
	if cap < base {
		return nil, errors.New("relay backoff cap below base")
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	jitter := config.Jitter
	if jitter == nil {
		jitter = cryptoJitter
	}
	return &Manager{
		entries: entries, dial: dial, maxHotIdle: maxHotIdle, idle: idle,
		base: base, cap: cap, now: now, jitter: jitter, closeCh: make(chan struct{}),
	}, nil
}

func cryptoJitter(maximum time.Duration) time.Duration {
	if maximum <= 0 {
		return 0
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return 0
	}
	return time.Duration(binary.LittleEndian.Uint64(bytes[:]) % uint64(maximum+1))
}

// Lease pins one engine and candidate for a single request or stream.
type Lease struct {
	manager    *Manager
	index      int
	generation uint64
	candidate  Candidate
	engine     Engine
	bytes      atomic.Uint64
	mu         sync.Mutex
	settled    bool
	failure    error
}

func (l *Lease) Candidate() Candidate { return l.candidate }
func (l *Lease) Engine() Engine       { return l.engine }

func (l *Lease) MarkApplicationBytes(count int) {
	if count > 0 {
		l.bytes.Add(uint64(count))
	}
}

func (l *Lease) ApplicationBytes() uint64 { return l.bytes.Load() }

// Fail retires the failed engine. A pre-application failure is retryable by
// acquiring another lease; a post-application failure is terminal.
func (l *Lease) Fail(cause error) error {
	if cause == nil {
		cause = errors.New("relay failed")
	}
	l.mu.Lock()
	if l.settled {
		failure := l.failure
		l.mu.Unlock()
		if failure != nil {
			return failure
		}
		return cause
	}
	l.settled = true
	failure := cause
	if count := l.bytes.Load(); count != 0 {
		failure = &TerminalRelayLoss{Candidate: l.candidate, Bytes: count, Cause: cause}
	}
	l.failure = failure
	l.mu.Unlock()
	l.manager.settle(l, cause)
	return failure
}

func (l *Lease) Release() {
	l.mu.Lock()
	if l.settled {
		l.mu.Unlock()
		return
	}
	l.settled = true
	l.mu.Unlock()
	l.manager.settle(l, nil)
}

// Acquire follows the configured order. Concurrent callers share each in-flight
// dial, while cooldown state prevents a failed candidate from being hammered.
func (m *Manager) Acquire(ctx context.Context) (*Lease, error) {
	for {
		var retryAt time.Time
		waited := false
		for index := range m.entries {
			m.mu.Lock()
			if m.closed {
				m.mu.Unlock()
				return nil, ErrClosed
			}
			entry := &m.entries[index]
			now := m.now()
			if entry.engine != nil {
				entry.refs++
				if entry.idleTimer != nil {
					entry.idleTimer.Stop()
					entry.idleTimer = nil
				}
				lease := m.leaseLocked(index, entry)
				m.mu.Unlock()
				return lease, nil
			}
			if now.Before(entry.cooldownTill) {
				if retryAt.IsZero() || entry.cooldownTill.Before(retryAt) {
					retryAt = entry.cooldownTill
				}
				m.mu.Unlock()
				continue
			}
			if entry.dialing != nil {
				ready := entry.dialing
				m.mu.Unlock()
				select {
				case <-ready:
					waited = true
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-m.closeCh:
					return nil, ErrClosed
				}
				break
			}
			entry.dialing = make(chan struct{})
			ready := entry.dialing
			candidate := entry.candidate
			m.mu.Unlock()

			engine, err := m.dial(ctx, candidate)
			m.mu.Lock()
			entry = &m.entries[index]
			entry.dialing = nil
			close(ready)
			if m.closed {
				m.mu.Unlock()
				if engine != nil {
					_ = engine.Close()
				}
				return nil, ErrClosed
			}
			if err != nil || engine == nil {
				m.recordFailureLocked(entry)
				if retryAt.IsZero() || entry.cooldownTill.Before(retryAt) {
					retryAt = entry.cooldownTill
				}
				m.mu.Unlock()
				continue
			}
			entry.engine = engine
			entry.generation++
			entry.failures = 0
			entry.cooldownTill = time.Time{}
			entry.refs = 1
			lease := m.leaseLocked(index, entry)
			m.mu.Unlock()
			return lease, nil
		}
		if waited {
			continue
		}
		return nil, &UnavailableError{RetryAt: retryAt}
	}
}

func (m *Manager) leaseLocked(index int, entry *entry) *Lease {
	return &Lease{
		manager: m, index: index, generation: entry.generation,
		candidate: entry.candidate, engine: entry.engine,
	}
}

func (m *Manager) recordFailureLocked(entry *entry) {
	entry.failures++
	delay := m.base
	for step := uint32(1); step < entry.failures && delay < m.cap; step++ {
		if delay > m.cap/2 {
			delay = m.cap
			break
		}
		delay *= 2
	}
	jitterMaximum := delay / 4
	jitter := m.jitter(jitterMaximum)
	if jitter < 0 || jitter > jitterMaximum {
		jitter = 0
	}
	if delay > m.cap-jitter {
		delay = m.cap
	} else {
		delay += jitter
	}
	entry.cooldownTill = m.now().Add(delay)
}

func (m *Manager) settle(lease *Lease, cause error) {
	var closeEngines []Engine
	m.mu.Lock()
	if lease.index >= 0 && lease.index < len(m.entries) {
		entry := &m.entries[lease.index]
		if entry.generation == lease.generation && entry.engine == lease.engine {
			if entry.refs > 0 {
				entry.refs--
			}
			if cause != nil {
				closeEngines = append(closeEngines, entry.engine)
				entry.engine = nil
				if entry.idleTimer != nil {
					entry.idleTimer.Stop()
					entry.idleTimer = nil
				}
				m.recordFailureLocked(entry)
			} else if entry.refs == 0 {
				entry.lastIdle = m.now()
				m.scheduleIdleLocked(lease.index, entry)
			}
		}
	}
	closeEngines = append(closeEngines, m.enforceHotIdleLocked()...)
	m.mu.Unlock()
	closeAll(closeEngines)
}

func (m *Manager) scheduleIdleLocked(index int, entry *entry) {
	if entry.idleTimer != nil {
		entry.idleTimer.Stop()
	}
	generation := entry.generation
	entry.idleTimer = time.AfterFunc(m.idle, func() {
		m.closeIdle(index, generation)
	})
}

func (m *Manager) closeIdle(index int, generation uint64) {
	var engine Engine
	m.mu.Lock()
	if !m.closed && index >= 0 && index < len(m.entries) {
		entry := &m.entries[index]
		if entry.engine != nil && entry.generation == generation && entry.refs == 0 && !m.now().Before(entry.lastIdle.Add(m.idle)) {
			engine = entry.engine
			entry.engine = nil
			entry.idleTimer = nil
		}
	}
	m.mu.Unlock()
	if engine != nil {
		_ = engine.Close()
	}
}

func (m *Manager) enforceHotIdleLocked() []Engine {
	idleCount := 0
	for i := range m.entries {
		if m.entries[i].engine != nil && m.entries[i].refs == 0 {
			idleCount++
		}
	}
	var closed []Engine
	for idleCount > m.maxHotIdle {
		oldest := -1
		for i := range m.entries {
			entry := &m.entries[i]
			if entry.engine == nil || entry.refs != 0 {
				continue
			}
			if oldest == -1 || entry.lastIdle.Before(m.entries[oldest].lastIdle) {
				oldest = i
			}
		}
		if oldest == -1 {
			break
		}
		entry := &m.entries[oldest]
		closed = append(closed, entry.engine)
		entry.engine = nil
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
			entry.idleTimer = nil
		}
		idleCount--
	}
	return closed
}

// Sweep applies idle expiry using the configured clock. It is useful for
// deterministic embedding clocks; runtime expiry is also timer-driven.
func (m *Manager) Sweep() {
	var closed []Engine
	m.mu.Lock()
	now := m.now()
	for i := range m.entries {
		entry := &m.entries[i]
		if entry.engine != nil && entry.refs == 0 && !now.Before(entry.lastIdle.Add(m.idle)) {
			closed = append(closed, entry.engine)
			entry.engine = nil
			if entry.idleTimer != nil {
				entry.idleTimer.Stop()
				entry.idleTimer = nil
			}
		}
	}
	m.mu.Unlock()
	closeAll(closed)
}

func (m *Manager) Health() []Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	health := make([]Health, len(m.entries))
	for i := range m.entries {
		entry := &m.entries[i]
		health[i] = Health{
			Candidate: entry.candidate, Hot: entry.engine != nil, ActiveLeases: entry.refs,
			Failures: entry.failures, CooldownUntil: entry.cooldownTill,
		}
	}
	return health
}

func (m *Manager) Close() error {
	var closed []Engine
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	close(m.closeCh)
	for i := range m.entries {
		entry := &m.entries[i]
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
			entry.idleTimer = nil
		}
		if entry.engine != nil {
			closed = append(closed, entry.engine)
			entry.engine = nil
		}
	}
	m.mu.Unlock()
	closeAll(closed)
	return nil
}

func closeAll(engines []Engine) {
	for _, engine := range engines {
		if engine != nil {
			_ = engine.Close()
		}
	}
}

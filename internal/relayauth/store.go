package relayauth

import (
	"crypto/sha256"
	"errors"
	"net/url"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type claimsDigestWire struct {
	CapabilityID         string   `cbor:"1,keyasint"`
	DeploymentID         string   `cbor:"2,keyasint"`
	SessionBindingDigest [32]byte `cbor:"3,keyasint"`
	Epoch                uint64   `cbor:"4,keyasint"`
	RelayProfileDigest   [32]byte `cbor:"5,keyasint"`
	ExpiresUnix          int64    `cbor:"6,keyasint"`
	AllowedOrigins       []string `cbor:"7,keyasint"`
	MaxSessions          uint32   `cbor:"8,keyasint"`
	Limits               Limits   `cbor:"9,keyasint"`
	FeatureBits          uint64   `cbor:"10,keyasint"`
}

func cloneClaims(claims Claims) Claims {
	clone := claims
	clone.AllowedOrigins = append([]string(nil), claims.AllowedOrigins...)
	return clone
}

func digestCapability(claims Claims) ([32]byte, error) {
	wire := claimsDigestWire{
		CapabilityID:         claims.CapabilityID,
		DeploymentID:         claims.DeploymentID,
		SessionBindingDigest: claims.SessionBindingDigest,
		Epoch:                claims.Epoch,
		RelayProfileDigest:   claims.RelayProfileDigest,
		ExpiresUnix:          claims.ExpiresAt.Unix(),
		AllowedOrigins:       claims.AllowedOrigins,
		MaxSessions:          claims.MaxSessions,
		Limits:               claims.Limits,
		FeatureBits:          claims.FeatureBits,
	}
	encoded, err := encMode.Marshal(wire)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func validBrowsingOrigin(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil &&
		parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}

func normalizeClaims(claims Claims) (Claims, error) {
	if claims.CapabilityID == "" || len(claims.CapabilityID) > 256 ||
		claims.DeploymentID == "" || len(claims.DeploymentID) > 256 ||
		claims.SessionBindingDigest == [32]byte{} || claims.VerifierKey == [32]byte{} ||
		claims.RelayProfileDigest == [32]byte{} || claims.Epoch == 0 || claims.MaxSessions == 0 ||
		claims.MaxSessions > 4096 || len(claims.AllowedOrigins) == 0 || len(claims.AllowedOrigins) > 256 ||
		!validLimits(claims.Limits) || claims.ExpiresAt.IsZero() {
		return Claims{}, errors.New("invalid capability")
	}
	normalized := cloneClaims(claims)
	sort.Strings(normalized.AllowedOrigins)
	for index, origin := range normalized.AllowedOrigins {
		if !validBrowsingOrigin(origin) || index > 0 && origin == normalized.AllowedOrigins[index-1] {
			return Claims{}, errors.New("invalid capability")
		}
	}
	digest, err := digestCapability(normalized)
	if err != nil {
		return Claims{}, err
	}
	normalized.Digest = digest
	return normalized, nil
}

type capabilityState struct {
	claims       Claims
	reservations uint32
	active       map[*capabilityReservation]struct{}
}

type MemoryCapabilityStore struct {
	mu           sync.Mutex
	capabilities map[string]*capabilityState
	ledger       ReplayLedger
}

func NewCapabilityStore(ledger ReplayLedger) *MemoryCapabilityStore {
	if ledger == nil {
		panic("relayauth: replay ledger is required")
	}
	return &MemoryCapabilityStore{capabilities: make(map[string]*capabilityState), ledger: ledger}
}

func NewMemoryCapabilityStore() *MemoryCapabilityStore {
	return NewCapabilityStore(NewMemoryReplayLedger())
}

func (s *MemoryCapabilityStore) Install(claims Claims) error {
	_, err := s.InstallAndGet(claims)
	return err
}

func (s *MemoryCapabilityStore) InstallAndGet(claims Claims) (Claims, error) {
	normalized, err := normalizeClaims(claims)
	if err != nil {
		return Claims{}, err
	}
	s.mu.Lock()
	current := s.capabilities[normalized.CapabilityID]
	if current != nil && normalized.Epoch <= current.claims.Epoch {
		s.mu.Unlock()
		return Claims{}, errors.New("duplicate or stale capability")
	}
	stale := make([]*capabilityReservation, 0)
	if current != nil {
		stale = make([]*capabilityReservation, 0, len(current.active))
		for reservation := range current.active {
			reservation.invalidated.Store(true)
			stale = append(stale, reservation)
		}
		current.reservations = 0
		current.active = make(map[*capabilityReservation]struct{})
	}
	s.capabilities[normalized.CapabilityID] = &capabilityState{claims: normalized, active: make(map[*capabilityReservation]struct{})}
	s.mu.Unlock()
	for _, reservation := range stale {
		reservation.Release()
	}
	return cloneClaims(normalized), nil
}

func containsOrigin(origins []string, wanted string) bool {
	index := sort.SearchStrings(origins, wanted)
	return index < len(origins) && origins[index] == wanted
}

type capabilityReservation struct {
	store         *MemoryCapabilityStore
	state         *capabilityState
	replayKey     ReplayKey
	claims        Claims
	releaseOnce   sync.Once
	challengeOnce sync.Once
	challengeErr  error
	invalidated   atomic.Bool
}

func (r *capabilityReservation) Claims() Claims { return cloneClaims(r.claims) }

func (r *capabilityReservation) Validate(now time.Time) error {
	if r.invalidated.Load() {
		return ErrAuth
	}
	if !now.Before(r.claims.ExpiresAt) {
		return ErrExpired
	}
	return nil
}

func (r *capabilityReservation) BindChallenge(challenge [24]byte) error {
	r.challengeOnce.Do(func() {
		if challenge == [24]byte{} {
			r.challengeErr = ErrProtocol
			return
		}
		if r.invalidated.Load() {
			r.challengeErr = ErrAuth
			return
		}
		r.challengeErr = r.store.ledger.BindChallenge(r.replayKey, challenge)
	})
	return r.challengeErr
}

func (r *capabilityReservation) Release() {
	r.releaseOnce.Do(func() {
		r.store.mu.Lock()
		defer r.store.mu.Unlock()
		if r.state.reservations > 0 {
			r.state.reservations--
		}
		delete(r.state.active, r)
	})
}

func (s *MemoryCapabilityStore) ReserveCapability(id, browserOrigin string, clientNonce [32]byte, now time.Time) (Reservation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.capabilities[id]
	if !ok || !now.Before(state.claims.ExpiresAt) || !containsOrigin(state.claims.AllowedOrigins, browserOrigin) ||
		state.reservations >= state.claims.MaxSessions {
		return nil, ErrAuth
	}
	key := ReplayKey{CapabilityID: id, Epoch: state.claims.Epoch, ClientNonce: clientNonce}
	if err := s.ledger.Reserve(key, state.claims.ExpiresAt, now); err != nil {
		return nil, ErrAuth
	}
	state.reservations++
	reservation := &capabilityReservation{store: s, state: state, replayKey: key, claims: cloneClaims(state.claims)}
	state.active[reservation] = struct{}{}
	return reservation, nil
}

func (s *MemoryCapabilityStore) ActiveReservations(id string) uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if state := s.capabilities[id]; state != nil {
		return state.reservations
	}
	return 0
}

package relayauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/fxamacker/cbor/v2"
)

const (
	Protocol               = "zeroproxy.carrier.v2"
	Version                = uint16(2)
	MaxHandshakeFrameBytes = 4096
)

var (
	ErrProtocol = errors.New("carrier protocol violation")
	ErrAuth     = errors.New("carrier authentication failed")
	ErrExpired  = errors.New("carrier capability expired")
)

type Limits struct {
	MaxStreams         uint32 `cbor:"1,keyasint"`
	UploadByteBudget   uint64 `cbor:"2,keyasint"`
	DownloadByteBudget uint64 `cbor:"3,keyasint"`
	MaxFrameBytes      uint32 `cbor:"4,keyasint"`
	MaxMessageBytes    uint32 `cbor:"5,keyasint"`
	MaxFramesPerSecond uint32 `cbor:"6,keyasint"`
	HandshakeTimeoutMS uint32 `cbor:"7,keyasint"`
	IdleTimeoutMS      uint32 `cbor:"8,keyasint"`
	SessionDeadlineMS  uint32 `cbor:"9,keyasint"`
}

type ClientInit struct {
	CapabilityID string   `cbor:"1,keyasint"`
	Versions     []uint16 `cbor:"2,keyasint"`
	FeatureBits  uint64   `cbor:"3,keyasint"`
	ClientNonce  [32]byte `cbor:"4,keyasint"`
}

type ServerChallenge struct {
	ServerNonce            [32]byte `cbor:"1,keyasint"`
	SelectedVersion        uint16   `cbor:"2,keyasint"`
	SelectedFeatures       uint64   `cbor:"3,keyasint"`
	SelectedLimits         Limits   `cbor:"4,keyasint"`
	CapabilityClaimsDigest [32]byte `cbor:"5,keyasint"`
	ChallengeID            [24]byte `cbor:"6,keyasint"`
}

type ClientAuth struct {
	ChallengeID [24]byte `cbor:"1,keyasint"`
	Proof       [32]byte `cbor:"2,keyasint"`
}
type ServerAccept struct {
	CarrierID        [24]byte `cbor:"1,keyasint"`
	NegotiatedLimits Limits   `cbor:"2,keyasint"`
	CapabilityEpoch  uint64   `cbor:"3,keyasint"`
	ServerProof      [32]byte `cbor:"4,keyasint"`
}

type Claims struct {
	CapabilityID         string
	DeploymentID         string
	SessionBindingDigest [32]byte
	VerifierKey          [32]byte
	ExpiresAt            time.Time
	Epoch                uint64
	Limits               Limits
	FeatureBits          uint64
	RelayProfileDigest   [32]byte
	AllowedOrigins       []string
	MaxSessions          uint32
	Digest               [32]byte
}

type Reservation interface {
	Claims() Claims
	BindChallenge([24]byte) error
	Validate(time.Time) error
	Release()
}

type Resolver interface {
	ReserveCapability(id, browserOrigin string, clientNonce [32]byte, now time.Time) (Reservation, error)
}

type State uint8

const (
	New State = iota
	Challenged
	Accepted
	Closed
)

type Session struct {
	mu              sync.Mutex
	state           State
	resolver        Resolver
	reservation     Reservation
	origin          string
	now             func() time.Time
	entropy         io.Reader
	deadline        time.Time
	carrierDeadline time.Time
	claims          Claims
	init            ClientInit
	challenge       ServerChallenge
	transcript      [32]byte
}

var encMode cbor.EncMode
var decMode cbor.DecMode

func init() {
	encMode, _ = cbor.CanonicalEncOptions().EncMode()
	decMode, _ = cbor.DecOptions{DupMapKey: cbor.DupMapKeyEnforcedAPF, IndefLength: cbor.IndefLengthForbidden, TagsMd: cbor.TagsForbidden, ExtraReturnErrors: cbor.ExtraDecErrorUnknownField, MaxArrayElements: 64, MaxMapPairs: 32}.DecMode()
}

func NewSession(origin string, resolver Resolver) *Session {
	if resolver == nil {
		panic("relayauth: resolver is required")
	}
	return &Session{state: New, resolver: resolver, origin: origin, now: time.Now, entropy: rand.Reader}
}
func (s *Session) CarrierDeadline() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.carrierDeadline
}
func (s *Session) HandshakeDeadline() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deadline
}
func (s *Session) State() State { s.mu.Lock(); defer s.mu.Unlock(); return s.state }

func containsVersion(versions []uint16, wanted uint16) bool {
	for _, v := range versions {
		if v == wanted {
			return true
		}
	}
	return false
}
func validVersions(versions []uint16) bool {
	if len(versions) == 0 || len(versions) > 8 {
		return false
	}
	seen := make(map[uint16]struct{}, len(versions))
	for _, version := range versions {
		if version == 0 {
			return false
		}
		if _, exists := seen[version]; exists {
			return false
		}
		seen[version] = struct{}{}
	}
	return true
}
func validLimits(limits Limits) bool {
	return limits.MaxStreams > 0 && limits.MaxStreams <= 4096 &&
		limits.UploadByteBudget > 0 && limits.DownloadByteBudget > 0 &&
		limits.MaxFrameBytes > 0 && limits.MaxFrameBytes <= 64<<10 &&
		limits.MaxMessageBytes >= limits.MaxFrameBytes && limits.MaxMessageBytes <= 4<<20 &&
		limits.MaxFramesPerSecond > 0 && limits.MaxFramesPerSecond <= 10000 &&
		limits.HandshakeTimeoutMS >= 1000 && limits.HandshakeTimeoutMS <= 60000 &&
		limits.IdleTimeoutMS >= 1000 && limits.IdleTimeoutMS <= 3600000 &&
		limits.SessionDeadlineMS >= limits.IdleTimeoutMS && limits.SessionDeadlineMS <= 86400000
}
func validClientInit(init ClientInit) bool {
	var zeroNonce [32]byte
	return len(init.CapabilityID) > 0 && len(init.CapabilityID) <= 256 &&
		validVersions(init.Versions) && containsVersion(init.Versions, Version) &&
		init.ClientNonce != zeroNonce
}
func ValidateChallenge(init ClientInit, challenge ServerChallenge) error {
	if !validClientInit(init) ||
		challenge.SelectedVersion != Version ||
		!containsVersion(init.Versions, challenge.SelectedVersion) ||
		challenge.SelectedFeatures&^init.FeatureBits != 0 ||
		!validLimits(challenge.SelectedLimits) {
		return ErrProtocol
	}
	return nil
}

func transcriptHash(init ClientInit, challenge ServerChallenge) ([32]byte, error) {
	left, err := encMode.Marshal(init)
	if err != nil {
		return [32]byte{}, err
	}
	right, err := encMode.Marshal(challenge)
	if err != nil {
		return [32]byte{}, err
	}
	buf := make([]byte, 8+len(left)+len(right))
	binary.BigEndian.PutUint32(buf, uint32(len(left)))
	copy(buf[4:], left)
	off := 4 + len(left)
	binary.BigEndian.PutUint32(buf[off:], uint32(len(right)))
	copy(buf[off+4:], right)
	return sha256.Sum256(buf), nil
}

func (s *Session) closeLocked() {
	s.state = Closed
	if s.reservation != nil {
		s.reservation.Release()
		s.reservation = nil
	}
}

func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *Session) Begin(init ClientInit) (ServerChallenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != New || !validClientInit(init) {
		s.closeLocked()
		return ServerChallenge{}, ErrProtocol
	}
	reservation, err := s.resolver.ReserveCapability(init.CapabilityID, s.origin, init.ClientNonce, s.now())
	if err != nil {
		s.closeLocked()
		return ServerChallenge{}, ErrAuth
	}
	s.reservation = reservation
	claims := reservation.Claims()
	if err := reservation.Validate(s.now()); err != nil {
		s.closeLocked()
		return ServerChallenge{}, err
	}
	if claims.CapabilityID != init.CapabilityID || claims.DeploymentID == "" ||
		claims.SessionBindingDigest == [32]byte{} || claims.RelayProfileDigest == [32]byte{} ||
		claims.Epoch == 0 || claims.MaxSessions == 0 || !validLimits(claims.Limits) {
		s.closeLocked()
		return ServerChallenge{}, ErrAuth
	}
	challenge := ServerChallenge{SelectedVersion: Version, SelectedFeatures: init.FeatureBits & claims.FeatureBits, SelectedLimits: claims.Limits, CapabilityClaimsDigest: claims.Digest}
	if _, err := io.ReadFull(s.entropy, challenge.ServerNonce[:]); err != nil {
		s.closeLocked()
		return ServerChallenge{}, err
	}
	if _, err := io.ReadFull(s.entropy, challenge.ChallengeID[:]); err != nil {
		s.closeLocked()
		return ServerChallenge{}, err
	}
	if err := reservation.BindChallenge(challenge.ChallengeID); err != nil {
		s.closeLocked()
		return ServerChallenge{}, ErrAuth
	}
	transcript, err := transcriptHash(init, challenge)
	if err != nil {
		s.closeLocked()
		return ServerChallenge{}, err
	}
	s.claims, s.init, s.challenge, s.transcript = claims, init, challenge, transcript
	s.deadline = s.now().Add(time.Duration(claims.Limits.HandshakeTimeoutMS) * time.Millisecond)
	if claims.ExpiresAt.Before(s.deadline) {
		s.deadline = claims.ExpiresAt
	}
	s.state = Challenged
	return challenge, nil
}

func (s *Session) Finish(auth ClientAuth) (ServerAccept, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != Challenged || auth.ChallengeID != s.challenge.ChallengeID {
		s.closeLocked()
		return ServerAccept{}, ErrProtocol
	}
	if err := s.reservation.Validate(s.now()); err != nil {
		s.closeLocked()
		return ServerAccept{}, err
	}
	if !s.now().Before(s.deadline) {
		s.closeLocked()
		return ServerAccept{}, ErrProtocol
	}
	proof := hmac.New(sha256.New, s.claims.VerifierKey[:])
	proof.Write(s.transcript[:])
	if !hmac.Equal(auth.Proof[:], proof.Sum(nil)) {
		s.closeLocked()
		return ServerAccept{}, ErrAuth
	}
	accept := ServerAccept{NegotiatedLimits: s.claims.Limits, CapabilityEpoch: s.claims.Epoch}
	if _, err := io.ReadFull(s.entropy, accept.CarrierID[:]); err != nil {
		s.closeLocked()
		return ServerAccept{}, err
	}
	server := hmac.New(sha256.New, s.claims.VerifierKey[:])
	server.Write([]byte("server"))
	server.Write(s.transcript[:])
	copy(accept.ServerProof[:], server.Sum(nil))
	s.carrierDeadline = s.now().Add(time.Duration(s.claims.Limits.SessionDeadlineMS) * time.Millisecond)
	if s.claims.ExpiresAt.Before(s.carrierDeadline) {
		s.carrierDeadline = s.claims.ExpiresAt
	}
	s.state = Accepted
	return accept, nil
}

func ClientProof(key [32]byte, init ClientInit, challenge ServerChallenge) (ClientAuth, error) {
	if err := ValidateChallenge(init, challenge); err != nil {
		return ClientAuth{}, err
	}
	hash, err := transcriptHash(init, challenge)
	if err != nil {
		return ClientAuth{}, err
	}
	mac := hmac.New(sha256.New, key[:])
	mac.Write(hash[:])
	var proof [32]byte
	copy(proof[:], mac.Sum(nil))
	return ClientAuth{ChallengeID: challenge.ChallengeID, Proof: proof}, nil
}

func ValidateAccept(challenge ServerChallenge, accept ServerAccept) error {
	if accept.CarrierID == [24]byte{} ||
		accept.NegotiatedLimits != challenge.SelectedLimits ||
		accept.CapabilityEpoch == 0 {
		return ErrProtocol
	}
	return nil
}

func VerifyServerProof(key [32]byte, init ClientInit, challenge ServerChallenge, accept ServerAccept) error {
	if err := ValidateChallenge(init, challenge); err != nil {
		return err
	}
	if err := ValidateAccept(challenge, accept); err != nil {
		return err
	}
	hash, err := transcriptHash(init, challenge)
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, key[:])
	mac.Write([]byte("server"))
	mac.Write(hash[:])
	if !hmac.Equal(accept.ServerProof[:], mac.Sum(nil)) {
		return ErrAuth
	}
	return nil
}
func Marshal(v any) ([]byte, error) { return encMode.Marshal(v) }
func Unmarshal(data []byte, v any) error {
	if len(data) == 0 || len(data) > MaxHandshakeFrameBytes {
		return ErrProtocol
	}
	if err := decMode.Unmarshal(data, v); err != nil {
		return err
	}
	canonical, err := encMode.Marshal(v)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, canonical) {
		return ErrProtocol
	}
	return nil
}

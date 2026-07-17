//go:build js && wasm

package main

import (
	"context"
	"crypto/rand"
	"errors"
	"net/url"
	"syscall/js"
	"time"

	"github.com/gosuda/zeroproxy/internal/relayauth"
	"github.com/gosuda/zeroproxy/internal/relaymanager"
	"github.com/gosuda/zeroproxy/internal/wsconn"
	"github.com/xtaci/smux"
)

const maxApprovedRelays = 8

type relayCredential struct {
	candidate       relaymanager.Candidate
	relayURL        string
	deploymentID    string
	capabilityID    string
	verifierKey     [32]byte
	claimsDigest    [32]byte
	capabilityEpoch uint64
	allowedPorts    map[uint16]struct{}
	profileLimits   relayauth.Limits
}

type approvedRelaySet struct {
	ordered      []relaymanager.Candidate
	credentials  map[string]relayCredential
	allowedPorts map[uint16]struct{}
	limits       relayauth.Limits
}

type carrierEngine struct {
	carrier *wsconn.BrowserConn
	mux     *smux.Session
	limits  relayauth.Limits
}

func (e *carrierEngine) Close() error {
	if e.mux != nil {
		_ = e.mux.Close()
	}
	if e.carrier != nil {
		return e.carrier.Close()
	}
	return nil
}

func (e *carrierEngine) openStream() (*smux.Stream, error) {
	return e.mux.OpenStream()
}

func requiredSafeUint(value js.Value, maximum uint64) (uint64, error) {
	if value.Type() != js.TypeNumber {
		return 0, errors.New("integer required")
	}
	number := value.Float()
	integer := uint64(number)
	if number < 1 || number != float64(integer) || integer > maximum {
		return 0, errors.New("invalid integer")
	}
	return integer, nil
}

func parseProfileLimits(value js.Value) (relayauth.Limits, error) {
	if value.Type() != js.TypeObject || value.IsNull() {
		return relayauth.Limits{}, errors.New("relay profile limits required")
	}
	maxStreams, err := requiredSafeUint(value.Get("max_streams"), 4096)
	if err != nil {
		return relayauth.Limits{}, err
	}
	upload, err := requiredSafeUint(value.Get("upload_byte_budget"), ^uint64(0))
	if err != nil {
		return relayauth.Limits{}, err
	}
	download, err := requiredSafeUint(value.Get("download_byte_budget"), ^uint64(0))
	if err != nil {
		return relayauth.Limits{}, err
	}
	maxFrame, err := requiredSafeUint(value.Get("max_frame_bytes"), 64<<10)
	if err != nil {
		return relayauth.Limits{}, err
	}
	maxMessage, err := requiredSafeUint(value.Get("max_message_bytes"), 4<<20)
	if err != nil || maxMessage < maxFrame {
		return relayauth.Limits{}, errors.New("invalid relay message limit")
	}
	frameRate, err := requiredSafeUint(value.Get("max_frames_per_second"), 10000)
	if err != nil {
		return relayauth.Limits{}, err
	}
	handshake, err := requiredSafeUint(value.Get("handshake_timeout_ms"), 60000)
	if err != nil || handshake < 1000 {
		return relayauth.Limits{}, errors.New("invalid relay handshake timeout")
	}
	idle, err := requiredSafeUint(value.Get("idle_timeout_ms"), 3600000)
	if err != nil || idle < 1000 {
		return relayauth.Limits{}, errors.New("invalid relay idle timeout")
	}
	deadline, err := requiredSafeUint(value.Get("session_deadline_ms"), 86400000)
	if err != nil || deadline < idle {
		return relayauth.Limits{}, errors.New("invalid relay session deadline")
	}
	return relayauth.Limits{
		MaxStreams: uint32(maxStreams), UploadByteBudget: upload, DownloadByteBudget: download,
		MaxFrameBytes: uint32(maxFrame), MaxMessageBytes: uint32(maxMessage),
		MaxFramesPerSecond: uint32(frameRate), HandshakeTimeoutMS: uint32(handshake),
		IdleTimeoutMS: uint32(idle), SessionDeadlineMS: uint32(deadline),
	}, nil
}

func parseAllowedPorts(value js.Value) (map[uint16]struct{}, error) {
	if value.Type() != js.TypeObject || !js.Global().Get("Array").Call("isArray", value).Bool() || value.Length() < 1 || value.Length() > 256 {
		return nil, errors.New("allowed target ports required")
	}
	ports := make(map[uint16]struct{}, value.Length())
	var previous uint64
	for index := range value.Length() {
		port, err := requiredSafeUint(value.Index(index), 65535)
		if err != nil || port <= previous {
			return nil, errors.New("invalid allowed target port")
		}
		previous = port
		ports[uint16(port)] = struct{}{}
	}
	return ports, nil
}

func parseRelayCredential(value js.Value) (relayCredential, error) {
	if value.Type() != js.TypeObject || value.IsNull() {
		return relayCredential{}, errors.New("invalid approved relay")
	}
	relayURL, err := requiredString(value.Get("relayURL"), 16<<10)
	if err != nil {
		return relayCredential{}, err
	}
	relay, err := url.Parse(relayURL)
	if err != nil || relay.Scheme != "wss" || relay.User != nil || relay.Path != "/_zp/carrier" || relay.RawQuery != "" || relay.Fragment != "" {
		return relayCredential{}, errors.New("invalid relay profile URL")
	}
	profileID, err := requiredString(value.Get("relayProfileID"), 128)
	if err != nil {
		return relayCredential{}, err
	}
	deploymentID, err := requiredString(value.Get("relayDeploymentID"), 128)
	if err != nil {
		return relayCredential{}, err
	}
	profileDigestBytes, err := bytesFromJS(value.Get("relayProfileDigest"), 32)
	if err != nil {
		return relayCredential{}, err
	}
	capabilityID, err := requiredString(value.Get("capabilityID"), 1024)
	if err != nil {
		return relayCredential{}, err
	}
	keyBytes, err := bytesFromJS(value.Get("verifierKey"), 32)
	if err != nil {
		return relayCredential{}, err
	}
	claimsDigestBytes, err := bytesFromJS(value.Get("claimsDigest"), 32)
	if err != nil {
		return relayCredential{}, err
	}
	epoch, err := requiredSafeUint(value.Get("capabilityEpoch"), 1<<53-1)
	if err != nil {
		return relayCredential{}, errors.New("invalid capability epoch")
	}
	ports, err := parseAllowedPorts(value.Get("allowedTargetPorts"))
	if err != nil {
		return relayCredential{}, err
	}
	limits, err := parseProfileLimits(value.Get("profileLimits"))
	if err != nil {
		return relayCredential{}, err
	}
	credential := relayCredential{
		relayURL: relayURL, deploymentID: deploymentID, capabilityID: capabilityID,
		capabilityEpoch: epoch, allowedPorts: ports, profileLimits: limits,
	}
	credential.candidate.ProfileID = profileID
	copy(credential.candidate.Digest[:], profileDigestBytes)
	copy(credential.verifierKey[:], keyBytes)
	copy(credential.claimsDigest[:], claimsDigestBytes)
	return credential, nil
}

func parseApprovedRelays(config js.Value) (approvedRelaySet, error) {
	value := config.Get("relays")
	if value.Type() != js.TypeObject || !js.Global().Get("Array").Call("isArray", value).Bool() || value.Length() < 1 || value.Length() > maxApprovedRelays {
		return approvedRelaySet{}, errors.New("ordered approved relay set required")
	}
	set := approvedRelaySet{
		ordered:     make([]relaymanager.Candidate, 0, value.Length()),
		credentials: make(map[string]relayCredential, value.Length()),
	}
	for index := range value.Length() {
		credential, err := parseRelayCredential(value.Index(index))
		if err != nil {
			return approvedRelaySet{}, err
		}
		if _, duplicate := set.credentials[credential.candidate.ProfileID]; duplicate {
			return approvedRelaySet{}, errors.New("duplicate approved relay profile")
		}
		set.ordered = append(set.ordered, credential.candidate)
		set.credentials[credential.candidate.ProfileID] = credential
		if index == 0 {
			set.allowedPorts = clonePorts(credential.allowedPorts)
			set.limits = credential.profileLimits
		} else {
			intersectPorts(set.allowedPorts, credential.allowedPorts)
			set.limits = minimumLimits(set.limits, credential.profileLimits)
		}
	}
	if len(set.allowedPorts) == 0 {
		return approvedRelaySet{}, errors.New("approved relays have no common target port")
	}
	return set, nil
}

func clonePorts(source map[uint16]struct{}) map[uint16]struct{} {
	clone := make(map[uint16]struct{}, len(source))
	for port := range source {
		clone[port] = struct{}{}
	}
	return clone
}

func intersectPorts(left, right map[uint16]struct{}) {
	for port := range left {
		if _, present := right[port]; !present {
			delete(left, port)
		}
	}
}

func minimumLimits(left, right relayauth.Limits) relayauth.Limits {
	return relayauth.Limits{
		MaxStreams:         min(left.MaxStreams, right.MaxStreams),
		UploadByteBudget:   min(left.UploadByteBudget, right.UploadByteBudget),
		DownloadByteBudget: min(left.DownloadByteBudget, right.DownloadByteBudget),
		MaxFrameBytes:      min(left.MaxFrameBytes, right.MaxFrameBytes),
		MaxMessageBytes:    min(left.MaxMessageBytes, right.MaxMessageBytes),
		MaxFramesPerSecond: min(left.MaxFramesPerSecond, right.MaxFramesPerSecond),
		HandshakeTimeoutMS: min(left.HandshakeTimeoutMS, right.HandshakeTimeoutMS),
		IdleTimeoutMS:      min(left.IdleTimeoutMS, right.IdleTimeoutMS),
		SessionDeadlineMS:  min(left.SessionDeadlineMS, right.SessionDeadlineMS),
	}
}

func limitsWithin(actual, maximum relayauth.Limits) bool {
	return actual.MaxStreams <= maximum.MaxStreams &&
		actual.UploadByteBudget <= maximum.UploadByteBudget &&
		actual.DownloadByteBudget <= maximum.DownloadByteBudget &&
		actual.MaxFrameBytes <= maximum.MaxFrameBytes &&
		actual.MaxMessageBytes <= maximum.MaxMessageBytes &&
		actual.MaxFramesPerSecond <= maximum.MaxFramesPerSecond &&
		actual.HandshakeTimeoutMS <= maximum.HandshakeTimeoutMS &&
		actual.IdleTimeoutMS <= maximum.IdleTimeoutMS &&
		actual.SessionDeadlineMS <= maximum.SessionDeadlineMS
}

func dialCarrier(_ context.Context, credential relayCredential) (*carrierEngine, error) {
	carrier, err := wsconn.DialBrowser(credential.relayURL, relayauth.Protocol, 4<<20)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = carrier.Close()
		}
	}()
	if err := carrier.SetDeadline(time.Now().Add(time.Duration(credential.profileLimits.HandshakeTimeoutMS) * time.Millisecond)); err != nil {
		return nil, err
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	init := relayauth.ClientInit{CapabilityID: credential.capabilityID, Versions: []uint16{2}, ClientNonce: nonce}
	encoded, _ := relayauth.Marshal(init)
	if err := carrier.WriteFrame(encoded); err != nil {
		return nil, err
	}
	frame, err := carrier.ReadFrame()
	if err != nil {
		return nil, err
	}
	var challenge relayauth.ServerChallenge
	if err := relayauth.Unmarshal(frame, &challenge); err != nil {
		return nil, err
	}
	if challenge.CapabilityClaimsDigest != credential.claimsDigest || !limitsWithin(challenge.SelectedLimits, credential.profileLimits) {
		return nil, errors.New("relay capability claims mismatch")
	}
	auth, err := relayauth.ClientProof(credential.verifierKey, init, challenge)
	if err != nil {
		return nil, err
	}
	encoded, _ = relayauth.Marshal(auth)
	if err := carrier.WriteFrame(encoded); err != nil {
		return nil, err
	}
	frame, err = carrier.ReadFrame()
	if err != nil {
		return nil, err
	}
	var accept relayauth.ServerAccept
	if err := relayauth.Unmarshal(frame, &accept); err != nil {
		return nil, err
	}
	if accept.CapabilityEpoch != credential.capabilityEpoch || !limitsWithin(accept.NegotiatedLimits, credential.profileLimits) {
		return nil, errors.New("relay capability acceptance mismatch")
	}
	if err := relayauth.VerifyServerProof(credential.verifierKey, init, challenge, accept); err != nil {
		return nil, err
	}
	if err := carrier.SetNegotiatedLimits(
		int(accept.NegotiatedLimits.MaxMessageBytes),
		accept.NegotiatedLimits.DownloadByteBudget,
		accept.NegotiatedLimits.UploadByteBudget,
		accept.NegotiatedLimits.MaxFramesPerSecond,
		time.Duration(accept.NegotiatedLimits.IdleTimeoutMS)*time.Millisecond,
		time.Duration(accept.NegotiatedLimits.SessionDeadlineMS)*time.Millisecond,
	); err != nil {
		return nil, err
	}
	mux, err := smux.Client(carrier, smux.DefaultConfig())
	if err != nil {
		return nil, err
	}
	failed = false
	return &carrierEngine{carrier: carrier, mux: mux, limits: accept.NegotiatedLimits}, nil
}

func newRelayManager(set approvedRelaySet) (*relaymanager.Manager, error) {
	return relaymanager.New(set.ordered, func(ctx context.Context, candidate relaymanager.Candidate) (relaymanager.Engine, error) {
		credential, present := set.credentials[candidate.ProfileID]
		if !present || credential.candidate.Digest != candidate.Digest {
			return nil, errors.New("approved relay identity changed")
		}
		return dialCarrier(ctx, credential)
	}, relaymanager.Config{
		MaxCandidates: maxApprovedRelays,
		MaxHotIdle:    2,
		IdleTimeout:   min(30*time.Second, time.Duration(set.limits.IdleTimeoutMS)*time.Millisecond),
		BackoffBase:   250 * time.Millisecond,
		BackoffMax:    30 * time.Second,
	})
}

func acquireRelayStream(ctx context.Context, manager *relaymanager.Manager) (*smux.Stream, *relaymanager.Lease, error) {
	for {
		lease, err := manager.Acquire(ctx)
		if err != nil {
			return nil, nil, err
		}
		engine, ok := lease.Engine().(*carrierEngine)
		if !ok {
			return nil, nil, lease.Fail(errors.New("invalid relay engine"))
		}
		stream, err := engine.openStream()
		if err == nil {
			return stream, lease, nil
		}
		if failure := lease.Fail(err); failure != nil {
			var terminal *relaymanager.TerminalRelayLoss
			if errors.As(failure, &terminal) {
				return nil, nil, terminal
			}
		}
	}
}

func relayLeaseLost(lease *relaymanager.Lease) bool {
	engine, ok := lease.Engine().(*carrierEngine)
	return !ok || engine.mux.IsClosed()
}

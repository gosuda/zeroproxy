package relayauth

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func replayClaims() Claims {
	var verifier, binding, relay [32]byte
	verifier[0], binding[0], relay[0] = 1, 2, 3
	return Claims{
		CapabilityID:         "replay-capability",
		DeploymentID:         "deployment-a",
		SessionBindingDigest: binding,
		VerifierKey:          verifier,
		ExpiresAt:            time.Now().Add(time.Hour),
		Epoch:                7,
		Limits:               testLimits(),
		RelayProfileDigest:   relay,
		AllowedOrigins:       []string{"https://o-id.browse.example"},
		MaxSessions:          1,
	}
}

func replayInit(nonce byte) ClientInit {
	var clientNonce [32]byte
	clientNonce[0] = nonce
	return ClientInit{CapabilityID: "replay-capability", Versions: []uint16{Version}, ClientNonce: clientNonce}
}

func TestFileReplayLedgerSurvivesRestartWithBoundChallenge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replay.json")
	ledger, err := NewFileReplayLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	claims := replayClaims()
	store := NewCapabilityStore(ledger)
	if err := store.Install(claims); err != nil {
		t.Fatal(err)
	}
	first := NewSession("https://o-id.browse.example", store)
	if _, err := first.Begin(replayInit(1)); err != nil {
		t.Fatal(err)
	}
	first.Close()
	if got := store.ActiveReservations(claims.CapabilityID); got != 0 {
		t.Fatalf("active reservations = %d", got)
	}

	reopened, err := NewFileReplayLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	restartedStore := NewCapabilityStore(reopened)
	if err := restartedStore.Install(claims); err != nil {
		t.Fatal(err)
	}
	replay := NewSession("https://o-id.browse.example", restartedStore)
	if _, err := replay.Begin(replayInit(1)); !errors.Is(err, ErrAuth) {
		t.Fatalf("durable replay accepted: %v", err)
	}
}

func TestInvalidProofsDisconnectsAndAcceptedCloseReleaseExactlyOnce(t *testing.T) {
	claims := replayClaims()
	store := NewMemoryCapabilityStore()
	if err := store.Install(claims); err != nil {
		t.Fatal(err)
	}
	for nonce := byte(1); nonce <= 16; nonce++ {
		session := NewSession("https://o-id.browse.example", store)
		challenge, err := session.Begin(replayInit(nonce))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := session.Finish(ClientAuth{ChallengeID: challenge.ChallengeID}); !errors.Is(err, ErrAuth) {
			t.Fatalf("invalid proof %d: %v", nonce, err)
		}
		session.Close()
		if got := store.ActiveReservations(claims.CapabilityID); got != 0 {
			t.Fatalf("invalid proof %d leaked %d reservations", nonce, got)
		}
	}

	disconnected := NewSession("https://o-id.browse.example", store)
	if _, err := disconnected.Begin(replayInit(17)); err != nil {
		t.Fatal(err)
	}
	disconnected.Close()
	disconnected.Close()
	if got := store.ActiveReservations(claims.CapabilityID); got != 0 {
		t.Fatalf("disconnect leaked %d reservations", got)
	}

	accepted := NewSession("https://o-id.browse.example", store)
	init := replayInit(18)
	challenge, err := accepted.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := ClientProof(claims.VerifierKey, init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := accepted.Finish(auth); err != nil {
		t.Fatal(err)
	}
	if got := store.ActiveReservations(claims.CapabilityID); got != 1 {
		t.Fatalf("accepted reservation = %d", got)
	}
	accepted.Close()
	accepted.Close()
	if got := store.ActiveReservations(claims.CapabilityID); got != 0 {
		t.Fatalf("accepted close leaked %d reservations", got)
	}
}

func TestClaimsDigestSeparatesDeploymentSessionAndEpoch(t *testing.T) {
	base := replayClaims()
	first, err := digestCapability(base)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []func(*Claims){
		func(claims *Claims) { claims.DeploymentID = "deployment-b" },
		func(claims *Claims) { claims.SessionBindingDigest[0]++ },
		func(claims *Claims) { claims.Epoch++ },
	}
	for index, mutate := range mutations {
		changed := cloneClaims(base)
		mutate(&changed)
		digest, err := digestCapability(changed)
		if err != nil {
			t.Fatal(err)
		}
		if digest == first {
			t.Fatalf("binding mutation %d preserved claims digest", index)
		}
	}
}

func TestFileReplayLedgerFailsClosedOnCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replay.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":1,"records":[{"unknown":true}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileReplayLedger(path); !errors.Is(err, ErrReplay) {
		t.Fatalf("corrupt replay ledger accepted: %v", err)
	}
}

func TestFileReplayLedgerDetectsLossAfterInitialization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replay.json")
	if _, err := NewFileReplayLedger(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileReplayLedger(path); !errors.Is(err, ErrReplay) {
		t.Fatalf("lost replay ledger recreated without epoch rotation: %v", err)
	}
}

func TestProofReplayFailsAcrossDeploymentSessionAndEpochBindings(t *testing.T) {
	base := replayClaims()
	init := replayInit(42)
	newBoundSession := func(t *testing.T, claims Claims) (*Session, ServerChallenge, *MemoryCapabilityStore) {
		t.Helper()
		store := NewMemoryCapabilityStore()
		if err := store.Install(claims); err != nil {
			t.Fatal(err)
		}
		session := NewSession("https://o-id.browse.example", store)
		session.entropy = bytes.NewReader(bytes.Repeat([]byte{7}, 80))
		challenge, err := session.Begin(init)
		if err != nil {
			t.Fatal(err)
		}
		return session, challenge, store
	}
	original, originalChallenge, _ := newBoundSession(t, base)
	originalProof, err := ClientProof(base.VerifierKey, init, originalChallenge)
	if err != nil {
		t.Fatal(err)
	}
	original.Close()

	mutations := []func(*Claims){
		func(claims *Claims) { claims.DeploymentID = "deployment-b" },
		func(claims *Claims) { claims.SessionBindingDigest[0]++ },
		func(claims *Claims) { claims.Epoch++ },
	}
	for index, mutate := range mutations {
		changed := cloneClaims(base)
		mutate(&changed)
		session, challenge, store := newBoundSession(t, changed)
		if challenge.CapabilityClaimsDigest == originalChallenge.CapabilityClaimsDigest {
			t.Fatalf("binding mutation %d preserved challenged digest", index)
		}
		if _, err := session.Finish(originalProof); !errors.Is(err, ErrAuth) {
			t.Fatalf("binding mutation %d replay result: %v", index, err)
		}
		if got := store.ActiveReservations(changed.CapabilityID); got != 0 {
			t.Fatalf("binding mutation %d leaked %d reservations", index, got)
		}
	}
}

func TestCapabilityEpochRotationInvalidatesAndReleasesChallenge(t *testing.T) {
	claims := replayClaims()
	store := NewMemoryCapabilityStore()
	if err := store.Install(claims); err != nil {
		t.Fatal(err)
	}
	session := NewSession("https://o-id.browse.example", store)
	init := replayInit(61)
	challenge, err := session.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := ClientProof(claims.VerifierKey, init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	reservation := session.reservation.(*capabilityReservation)
	rotated := cloneClaims(claims)
	rotated.Epoch++
	if err := store.Install(rotated); err != nil {
		t.Fatal(err)
	}
	if reservation.state.reservations != 0 {
		t.Fatalf("rotation retained %d stale reservations", reservation.state.reservations)
	}
	if _, err := session.Finish(proof); !errors.Is(err, ErrAuth) {
		t.Fatalf("old epoch proof after rotation: %v", err)
	}
	session.Close()
	if reservation.state.reservations != 0 {
		t.Fatalf("duplicate close changed released reservation count to %d", reservation.state.reservations)
	}
}

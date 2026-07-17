package relayauth

import (
	"bytes"
	"errors"
	"sort"
	"testing"
	"time"
)

func testLimits() Limits {
	return Limits{
		MaxStreams:         8,
		UploadByteBudget:   1 << 20,
		DownloadByteBudget: 1 << 20,
		MaxFrameBytes:      64 << 10,
		MaxMessageBytes:    1 << 20,
		MaxFramesPerSecond: 1000,
		HandshakeTimeoutMS: 10000,
		IdleTimeoutMS:      60000,
		SessionDeadlineMS:  900000,
	}
}

func fixture(t *testing.T) (*Session, ClientInit, [32]byte, *MemoryCapabilityStore) {
	t.Helper()
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 1)
	}
	var sessionBinding, relayDigest [32]byte
	sessionBinding[0], relayDigest[0] = 1, 1
	claims := Claims{CapabilityID: "cap-1", DeploymentID: "deployment-1", SessionBindingDigest: sessionBinding, VerifierKey: key, ExpiresAt: time.Now().Add(time.Hour), Epoch: 7, Limits: testLimits(), FeatureBits: 3, RelayProfileDigest: relayDigest, AllowedOrigins: []string{"https://o-id.browse.example"}, MaxSessions: 2}
	store := NewMemoryCapabilityStore()
	if err := store.Install(claims); err != nil {
		t.Fatal(err)
	}
	session := NewSession("https://o-id.browse.example", store)
	var nonce [32]byte
	nonce[0] = 1
	return session, ClientInit{CapabilityID: "cap-1", Versions: []uint16{2}, FeatureBits: 7, ClientNonce: nonce}, key, store
}

func TestHandshakeAuthenticatesTranscript(t *testing.T) {
	session, init, key, _ := fixture(t)
	challenge, err := session.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	if challenge.SelectedVersion != 2 || challenge.SelectedFeatures != 3 {
		t.Fatalf("challenge %#v", challenge)
	}
	auth, err := ClientProof(key, init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	accept, err := session.Finish(auth)
	if err != nil {
		t.Fatal(err)
	}
	if session.State() != Accepted || accept.CapabilityEpoch != 7 || accept.ServerProof == [32]byte{} {
		t.Fatal("accept mismatch")
	}
	if _, err := session.Finish(auth); !errors.Is(err, ErrProtocol) {
		t.Fatalf("duplicate auth: %v", err)
	}
}

func TestHandshakeRejectsWrongProofAndOrder(t *testing.T) {
	session, _, _, _ := fixture(t)
	if _, err := session.Finish(ClientAuth{}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("auth before init: %v", err)
	}
	session, init, _, _ := fixture(t)
	challenge, err := session.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Finish(ClientAuth{ChallengeID: challenge.ChallengeID}); !errors.Is(err, ErrAuth) {
		t.Fatalf("wrong proof: %v", err)
	}
}

func TestHandshakeRejectsReplayAcrossConnections(t *testing.T) {
	first, init, _, store := fixture(t)
	if _, err := first.Begin(init); err != nil {
		t.Fatal(err)
	}
	second := NewSession("https://o-id.browse.example", store)
	if _, err := second.Begin(init); !errors.Is(err, ErrAuth) {
		t.Fatalf("replay accepted: %v", err)
	}
}

func TestCBORRejectsUnknownDuplicateAndOversize(t *testing.T) {
	var init ClientInit
	if err := Unmarshal(make([]byte, 64<<10+1), &init); !errors.Is(err, ErrProtocol) {
		t.Fatalf("oversize: %v", err)
	}
	unknown := []byte{0xa1, 0x09, 0x01}
	if err := Unmarshal(unknown, &init); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestHandshakeRejectsZeroNonce(t *testing.T) {
	session, init, _, _ := fixture(t)
	init.ClientNonce = [32]byte{}
	if _, err := session.Begin(init); !errors.Is(err, ErrProtocol) {
		t.Fatalf("zero nonce accepted: %v", err)
	}
}

func TestCBORRejectsNoncanonicalInteger(t *testing.T) {
	var limits Limits
	noncanonical := []byte{0xa3, 0x01, 0x18, 0x01, 0x02, 0x00, 0x03, 0x00}
	if err := Unmarshal(noncanonical, &limits); !errors.Is(err, ErrProtocol) {
		t.Fatalf("noncanonical CBOR accepted: %v", err)
	}
}

func TestClaimsDigestBindsOriginsLimitsEpochAndRelay(t *testing.T) {
	var sessionBinding, verifier, relayDigest [32]byte
	sessionBinding[0], verifier[0], relayDigest[0] = 1, 1, 1
	base := Claims{CapabilityID: "cap", DeploymentID: "deployment", SessionBindingDigest: sessionBinding, VerifierKey: verifier, ExpiresAt: time.Unix(1000, 0), Epoch: 1, Limits: testLimits(), RelayProfileDigest: relayDigest, AllowedOrigins: []string{"https://a.example"}, MaxSessions: 1}
	first, err := digestCapability(base)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []func(*Claims){func(c *Claims) { c.Epoch++ }, func(c *Claims) { c.Limits.MaxStreams++ }, func(c *Claims) { c.MaxSessions++ }, func(c *Claims) { c.AllowedOrigins = append(c.AllowedOrigins, "https://b.example") }, func(c *Claims) { c.RelayProfileDigest[0]++ }, func(c *Claims) { c.DeploymentID += "-other" }, func(c *Claims) { c.SessionBindingDigest[0]++ }}
	for index, mutate := range mutations {
		copy := cloneClaims(base)
		mutate(&copy)
		sort.Strings(copy.AllowedOrigins)
		digest, err := digestCapability(copy)
		if err != nil {
			t.Fatal(err)
		}
		if digest == first {
			t.Fatalf("mutation %d did not change claims digest", index)
		}
	}
}

func TestDeterministicHandshakeWireLab(t *testing.T) {
	session, init, key, _ := fixture(t)
	entropy := make([]byte, 80)
	for i := range entropy {
		entropy[i] = byte(i + 1)
	}
	session.entropy = bytes.NewReader(entropy)
	current := time.Now()
	session.now = func() time.Time { return current }
	challenge, err := session.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ServerChallenge
	if err := Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != challenge || challenge.ServerNonce[0] != 1 || challenge.ChallengeID[0] != 33 {
		t.Fatalf("deterministic challenge mismatch: %#v", challenge)
	}
	auth, err := ClientProof(key, init, decoded)
	if err != nil {
		t.Fatal(err)
	}
	accept, err := session.Finish(auth)
	if err != nil {
		t.Fatal(err)
	}
	if accept.CarrierID[0] != 57 || VerifyServerProof(key, init, challenge, accept) != nil {
		t.Fatal("server authentication vector mismatch")
	}
	tampered := accept
	tampered.ServerProof[0] ^= 1
	if !errors.Is(VerifyServerProof(key, init, challenge, tampered), ErrAuth) {
		t.Fatal("tampered server proof accepted")
	}
}

func TestHandshakeDeadlineClosesSession(t *testing.T) {
	session, init, key, store := fixture(t)
	session.entropy = bytes.NewReader(bytes.Repeat([]byte{1}, 56))
	current := time.Now()
	session.now = func() time.Time { return current }
	challenge, err := session.Begin(init)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := ClientProof(key, init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	current = current.Add(11 * time.Second)
	if _, err := session.Finish(auth); !errors.Is(err, ErrProtocol) || session.State() != Closed {
		t.Fatalf("expired handshake result: state=%v err=%v", session.State(), err)
	}
	if got := store.ActiveReservations(init.CapabilityID); got != 0 {
		t.Fatalf("expired handshake leaked %d reservations", got)
	}
}

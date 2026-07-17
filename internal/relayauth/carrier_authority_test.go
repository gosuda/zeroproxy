package relayauth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type carrierFixtureFrame struct {
	CanonicalCBORHex string `json:"canonical_cbor_hex"`
}

type carrierFixtureClaims struct {
	CanonicalCBORHex string `json:"canonical_cbor_hex"`
	DigestHex        string `json:"digest_hex"`
}

type carrierFixtures struct {
	SchemaVersion              int                            `json:"schema_version"`
	Subprotocol                string                         `json:"subprotocol"`
	AuthKeyHex                 string                         `json:"auth_key_hex"`
	CapabilityClaims           carrierFixtureClaims           `json:"capability_claims"`
	Frames                     map[string]carrierFixtureFrame `json:"frames"`
	CanonicalTranscriptHashHex string                         `json:"canonical_transcript_hash_hex"`
	ClientProofHex             string                         `json:"client_proof_hex"`
	ServerProofHex             string                         `json:"server_proof_hex"`
}

func fixtureBytes(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func fixed32(start byte) [32]byte {
	var value [32]byte
	for index := range value {
		value[index] = start + byte(index)
	}
	return value
}

func fixed24(start byte) [24]byte {
	var value [24]byte
	for index := range value {
		value[index] = start + byte(index)
	}
	return value
}

func TestCarrierAuthorityCanonicalFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../protocol/carrier.fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures carrierFixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if fixtures.SchemaVersion != 1 || fixtures.Subprotocol != Protocol || len(fixtures.Frames) != 4 {
		t.Fatalf("fixture authority mismatch: %#v", fixtures)
	}

	limits := Limits{MaxStreams: 64, UploadByteBudget: 1 << 20, DownloadByteBudget: 2 << 20, MaxFrameBytes: 64 << 10, MaxMessageBytes: 1 << 20, MaxFramesPerSecond: 1000, HandshakeTimeoutMS: 10000, IdleTimeoutMS: 60000, SessionDeadlineMS: 900000}
	claimsWire := claimsDigestWire{
		CapabilityID: "capability-fixture-v2", DeploymentID: "deployment-fixture",
		SessionBindingDigest: fixed32(0x80), Epoch: 7, RelayProfileDigest: fixed32(0x40),
		ExpiresUnix: 4102444800, AllowedOrigins: []string{"https://o-abcdefghijklmnopqrstuvwxyz234567.browse.example"},
		MaxSessions: 2, Limits: limits, FeatureBits: 5,
	}
	encodedClaims, err := Marshal(claimsWire)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(encodedClaims); got != fixtures.CapabilityClaims.CanonicalCBORHex {
		t.Fatalf("capability claims canonical CBOR = %s", got)
	}
	if got := sha256.Sum256(encodedClaims); hex.EncodeToString(got[:]) != fixtures.CapabilityClaims.DigestHex {
		t.Fatalf("capability claims digest = %x", got)
	}
	init := ClientInit{
		CapabilityID: "capability-fixture-v2",
		Versions:     []uint16{2, 3},
		FeatureBits:  5,
		ClientNonce:  fixed32(0),
	}
	var claimsDigest [32]byte
	copy(claimsDigest[:], fixtureBytes(t, fixtures.CapabilityClaims.DigestHex))
	challenge := ServerChallenge{
		ServerNonce:            fixed32(0x20),
		SelectedVersion:        Version,
		SelectedFeatures:       5,
		SelectedLimits:         limits,
		CapabilityClaimsDigest: claimsDigest,
		ChallengeID:            fixed24(0x60),
	}

	keyBytes := fixtureBytes(t, fixtures.AuthKeyHex)
	if len(keyBytes) != 32 {
		t.Fatalf("auth key length = %d", len(keyBytes))
	}
	var key [32]byte
	copy(key[:], keyBytes)
	auth, err := ClientProof(key, init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	accept := ServerAccept{
		CarrierID:        fixed24(0xc0),
		NegotiatedLimits: limits,
		CapabilityEpoch:  7,
	}
	serverProof := fixtureBytes(t, fixtures.ServerProofHex)
	copy(accept.ServerProof[:], serverProof)

	messages := map[string]any{
		"CLIENT_INIT":      init,
		"SERVER_CHALLENGE": challenge,
		"CLIENT_AUTH":      auth,
		"SERVER_ACCEPT":    accept,
	}
	for name, message := range messages {
		encoded, err := Marshal(message)
		if err != nil {
			t.Fatalf("%s marshal: %v", name, err)
		}
		if got, want := hex.EncodeToString(encoded), fixtures.Frames[name].CanonicalCBORHex; got != want {
			t.Fatalf("%s canonical CBOR\ngot  %s\nwant %s", name, got, want)
		}
	}

	transcript, err := transcriptHash(init, challenge)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(transcript[:]); got != fixtures.CanonicalTranscriptHashHex {
		t.Fatalf("transcript hash = %s", got)
	}
	if got := hex.EncodeToString(auth.Proof[:]); got != fixtures.ClientProofHex {
		t.Fatalf("client proof = %s", got)
	}
	if err := VerifyServerProof(key, init, challenge, accept); err != nil {
		t.Fatal(err)
	}
}

func TestCarrierAuthorityRejectsInvalidOffersAndSelections(t *testing.T) {
	session, init, _, _ := fixture(t)
	init.Versions = []uint16{2, 2}
	if _, err := session.Begin(init); err != ErrProtocol {
		t.Fatalf("duplicate versions: %v", err)
	}

	_, validInit, key, _ := fixture(t)
	challenge := ServerChallenge{
		ServerNonce:            fixed32(1),
		SelectedVersion:        Version,
		SelectedLimits:         Limits{MaxStreams: 1, UploadByteBudget: 1, DownloadByteBudget: 1, MaxFrameBytes: 1, MaxMessageBytes: 1, MaxFramesPerSecond: 1, HandshakeTimeoutMS: 1000, IdleTimeoutMS: 1000, SessionDeadlineMS: 1000},
		CapabilityClaimsDigest: fixed32(2),
		ChallengeID:            fixed24(3),
	}
	challenge.SelectedFeatures = validInit.FeatureBits | 1<<63
	if _, err := ClientProof(key, validInit, challenge); err != ErrProtocol {
		t.Fatalf("unoffered feature selection: %v", err)
	}
	challenge.SelectedFeatures = 0
	challenge.SelectedLimits.MaxFrameBytes = 64<<10 + 1
	if _, err := ClientProof(key, validInit, challenge); err != ErrProtocol {
		t.Fatalf("oversized selected frame: %v", err)
	}
}

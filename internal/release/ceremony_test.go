package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testSigningKey struct {
	key     Key
	private ed25519.PrivateKey
}

func newTestSigningKey(t *testing.T, id, role, owner string) testSigningKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return testSigningKey{
		key: Key{
			ID:         id,
			Role:       role,
			Owner:      owner,
			PublicKey:  base64.RawURLEncoding.EncodeToString(public),
			ValidFrom:  "2026-01-01T00:00:00Z",
			ValidUntil: "2030-01-01T00:00:00Z",
		},
		private: private,
	}
}

func writeTestJSON(t *testing.T, path string, value any) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return raw
}

func copyProtocolSchemas(t *testing.T, directory string) {
	t.Helper()
	for _, name := range []string{"release-signing-keys.schema.json", "release-signature.schema.json", "release-signing-request.schema.json", "key-transition.schema.json"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func testKeySet(epoch uint64, development bool, keys ...testSigningKey) KeySet {
	public := make([]Key, len(keys))
	for index, key := range keys {
		public[index] = key.key
	}
	return KeySet{SchemaVersion: 1, KeyEpoch: epoch, Threshold: 2, DevelopmentOnly: development, Keys: public}
}

func signTestDocument(t *testing.T, document []byte, keySet KeySet, keys ...testSigningKey) SignatureSet {
	t.Helper()
	canonical, err := CanonicalJSON(document)
	if err != nil {
		t.Fatal(err)
	}
	signatures := make([]Signature, len(keys))
	for index, key := range keys {
		signatures[index] = Signature{KeyID: key.key.ID, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key.private, canonical))}
	}
	return SignatureSet{Algorithm: "Ed25519", Canonicalization: "RFC8785", KeyEpoch: keySet.KeyEpoch, DevelopmentOnly: keySet.DevelopmentOnly, Signatures: signatures}
}

func writePayloadSchema(t *testing.T, path string) {
	t.Helper()
	writeTestJSON(t, path, map[string]any{
		"$schema":              "https://json-schema.org/draft/2020-12/schema",
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"approved"},
		"properties":           map[string]any{"approved": map[string]any{"type": "boolean"}},
	})
}

func TestProductionCeremonyIsSchemaFirstAndOwnerThresholded(t *testing.T) {
	dir := t.TempDir()
	copyProtocolSchemas(t, dir)
	documentPath := filepath.Join(dir, "decision.json")
	schemaPath := filepath.Join(dir, "decision.schema.json")
	keysPath := filepath.Join(dir, "release-signing-keys.json")
	signaturesPath := filepath.Join(dir, "decision.sig")
	writePayloadSchema(t, schemaPath)
	document := writeTestJSON(t, documentPath, map[string]any{"approved": true})
	releaseOwner := newTestSigningKey(t, "release-owner", "release", "release-owner@example.invalid")
	securityOwner := newTestSigningKey(t, "security-owner", "security", "security-owner@example.invalid")
	keySet := testKeySet(7, false, releaseOwner, securityOwner)
	writeTestJSON(t, keysPath, keySet)
	writeTestJSON(t, signaturesPath, signTestDocument(t, document, keySet, releaseOwner, securityOwner))
	at := time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)
	if err := verifyFilesAt(documentPath, keysPath, signaturesPath, false, at); err != nil {
		t.Fatal(err)
	}

	invalidDocument := writeTestJSON(t, documentPath, map[string]any{"approved": "yes"})
	writeTestJSON(t, signaturesPath, signTestDocument(t, invalidDocument, keySet, releaseOwner, securityOwner))
	if err := verifyFilesAt(documentPath, keysPath, signaturesPath, false, at); err == nil || !strings.Contains(err.Error(), "schema validation") {
		t.Fatalf("schema-invalid signed payload was not rejected first: %v", err)
	}

	document = writeTestJSON(t, documentPath, map[string]any{"approved": true})
	securityOwner.key.Owner = releaseOwner.key.Owner
	keySet = testKeySet(7, false, releaseOwner, securityOwner)
	writeTestJSON(t, keysPath, keySet)
	writeTestJSON(t, signaturesPath, signTestDocument(t, document, keySet, releaseOwner, securityOwner))
	if err := verifyFilesAt(documentPath, keysPath, signaturesPath, false, at); err == nil || !strings.Contains(err.Error(), "threshold") {
		t.Fatalf("same-owner threshold was accepted: %v", err)
	}
}

func TestPrepareSigningRequestEmitsCanonicalNonProductionArtifact(t *testing.T) {
	dir := t.TempDir()
	copyProtocolSchemas(t, dir)
	documentPath := filepath.Join(dir, "decision.json")
	schemaPath := filepath.Join(dir, "decision.schema.json")
	keysPath := filepath.Join(dir, "release-signing-keys.json")
	writePayloadSchema(t, schemaPath)
	document := []byte("{\n  \"approved\": true\n}\n")
	if err := os.WriteFile(documentPath, document, 0o600); err != nil {
		t.Fatal(err)
	}
	releaseOwner := newTestSigningKey(t, "release-owner", "release", "release-owner@example.invalid")
	securityOwner := newTestSigningKey(t, "security-owner", "security", "security-owner@example.invalid")
	writeTestJSON(t, keysPath, testKeySet(3, false, releaseOwner, securityOwner))
	at := time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)
	canonical, requestRaw, err := PrepareSigningRequest(documentPath, schemaPath, keysPath, filepath.Join(dir, "release-signing-keys.schema.json"), filepath.Join(dir, "release-signing-request.schema.json"), at)
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != `{"approved":true}` {
		t.Fatalf("canonical payload %q", canonical)
	}
	var request SigningRequest
	if err := decodeStrict(requestRaw, &request); err != nil {
		t.Fatal(err)
	}
	if request.ProductionEligible || request.CanonicalSHA256 != sha256Hex(canonical) || request.DocumentSHA256 != sha256Hex(document) || request.KeyEpoch != 3 || request.Threshold != 2 {
		t.Fatalf("invalid signing request: %+v", request)
	}
	canonicalAgain, requestAgain, err := PrepareSigningRequest(documentPath, schemaPath, keysPath, filepath.Join(dir, "release-signing-keys.schema.json"), filepath.Join(dir, "release-signing-request.schema.json"), at)
	if err != nil {
		t.Fatal(err)
	}
	if string(canonicalAgain) != string(canonical) || string(requestAgain) != string(requestRaw) {
		t.Fatal("signing request generation is not deterministic")
	}
}

func TestKeyTransitionAndPinnedGenesisChain(t *testing.T) {
	dir := t.TempDir()
	protocolDir := filepath.Join(dir, "protocol")
	keysetsDir := filepath.Join(dir, "keysets")
	transitionsDir := filepath.Join(dir, "transitions")
	for _, path := range []string{protocolDir, keysetsDir, transitionsDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	copyProtocolSchemas(t, protocolDir)
	releaseOne := newTestSigningKey(t, "release-one", "release", "release-one@example.invalid")
	securityOne := newTestSigningKey(t, "security-one", "security", "security-one@example.invalid")
	releaseTwo := newTestSigningKey(t, "release-two", "release", "release-two@example.invalid")
	securityTwo := newTestSigningKey(t, "security-two", "security", "security-two@example.invalid")
	previous := testKeySet(1, false, releaseOne, securityOne)
	next := testKeySet(2, false, releaseTwo, securityTwo)
	previousRaw := writeTestJSON(t, filepath.Join(keysetsDir, "1.json"), previous)
	nextRaw := writeTestJSON(t, filepath.Join(keysetsDir, "2.json"), next)
	previousCanonical, err := CanonicalJSON(previousRaw)
	if err != nil {
		t.Fatal(err)
	}
	nextCanonical, err := CanonicalJSON(nextRaw)
	if err != nil {
		t.Fatal(err)
	}
	transition := KeyTransition{
		FromEpoch: 1, ToEpoch: 2,
		PreviousKeysetSHA256: sha256Hex(previousCanonical), NextKeysetSHA256: sha256Hex(nextCanonical),
		Reason: "scheduled release-owner rotation", CreatedAt: "2026-07-16T00:00:00Z", RevokedKeyIDs: []string{},
	}
	transitionRaw := writeTestJSON(t, filepath.Join(transitionsDir, "1-2.json"), transition)
	writeTestJSON(t, filepath.Join(transitionsDir, "1-2.sig"), signTestDocument(t, transitionRaw, previous, releaseOne, securityOne))
	at := time.Date(2026, time.July, 17, 0, 0, 0, 0, time.UTC)
	if err := VerifyKeyChain(KeyChainOptions{
		GenesisDigest: sha256Hex(previousCanonical), GenesisEpoch: 1, CurrentEpoch: 2,
		KeysetsDir: keysetsDir, TransitionsDir: transitionsDir, ProtocolDir: protocolDir, VerificationTime: at,
	}); err != nil {
		t.Fatal(err)
	}
	if err := VerifyKeyChain(KeyChainOptions{
		GenesisDigest: strings.Repeat("0", 64), GenesisEpoch: 1, CurrentEpoch: 2,
		KeysetsDir: keysetsDir, TransitionsDir: transitionsDir, ProtocolDir: protocolDir, VerificationTime: at,
	}); err == nil || !strings.Contains(err.Error(), "genesis") {
		t.Fatalf("untrusted genesis was accepted: %v", err)
	}
}

func TestRevocationRequiresNextThresholdSignedManifest(t *testing.T) {
	dir := t.TempDir()
	copyProtocolSchemas(t, dir)
	releaseOne := newTestSigningKey(t, "release-one", "release", "release-one@example.invalid")
	securityOne := newTestSigningKey(t, "security-one", "security", "security-one@example.invalid")
	revoked := newTestSigningKey(t, "revoked-one", "release", "revoked@example.invalid")
	releaseTwo := newTestSigningKey(t, "release-two", "release", "release-two@example.invalid")
	securityTwo := newTestSigningKey(t, "security-two", "security", "security-two@example.invalid")
	previous := testKeySet(4, false, releaseOne, securityOne, revoked)
	next := testKeySet(5, false, releaseTwo, securityTwo)
	previousPath := filepath.Join(dir, "previous.json")
	nextPath := filepath.Join(dir, "next.json")
	previousRaw := writeTestJSON(t, previousPath, previous)
	nextRaw := writeTestJSON(t, nextPath, next)
	previousCanonical, _ := CanonicalJSON(previousRaw)
	nextCanonical, _ := CanonicalJSON(nextRaw)
	transition := KeyTransition{
		FromEpoch: 4, ToEpoch: 5,
		PreviousKeysetSHA256: sha256Hex(previousCanonical), NextKeysetSHA256: sha256Hex(nextCanonical),
		Reason: "revoke externally compromised release key", CreatedAt: "2026-07-16T00:00:00Z", RevokedKeyIDs: []string{revoked.key.ID},
	}
	transitionPath := filepath.Join(dir, "4-5.json")
	transitionSignaturesPath := filepath.Join(dir, "4-5.sig")
	transitionRaw := writeTestJSON(t, transitionPath, transition)
	writeTestJSON(t, transitionSignaturesPath, signTestDocument(t, transitionRaw, previous, releaseOne, securityOne))
	at := time.Date(2026, time.July, 17, 0, 0, 0, 0, time.UTC)
	options := KeyTransitionOptions{
		PreviousKeysPath: previousPath, NextKeysPath: nextPath, TransitionPath: transitionPath,
		SignaturesPath: transitionSignaturesPath, ProtocolDir: dir, VerificationTime: at,
	}
	if err := VerifyKeyTransition(options); err == nil || !strings.Contains(err.Error(), "newly signed release manifest") {
		t.Fatalf("revocation without release manifest was accepted: %v", err)
	}

	transitionCanonical, _ := CanonicalJSON(transitionRaw)
	manifestPath := filepath.Join(dir, "release.json")
	manifestSchemaPath := filepath.Join(dir, "release.schema.json")
	manifestSignaturesPath := filepath.Join(dir, "release.sig")
	manifest := writeTestJSON(t, manifestPath, map[string]any{"key_transition_sha256": sha256Hex(transitionCanonical), "release_id": "2.0.0"})
	writeTestJSON(t, manifestSchemaPath, map[string]any{
		"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "additionalProperties": false,
		"required": []string{"key_transition_sha256", "release_id"},
		"properties": map[string]any{
			"key_transition_sha256": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"},
			"release_id":            map[string]any{"type": "string", "minLength": 1},
		},
	})
	writeTestJSON(t, manifestSignaturesPath, signTestDocument(t, manifest, next, releaseTwo, securityTwo))
	options.RevocationProof = &RevocationProof{ManifestPath: manifestPath, ManifestSchemaPath: manifestSchemaPath, SignaturesPath: manifestSignaturesPath}
	if err := VerifyKeyTransition(options); err != nil {
		t.Fatal(err)
	}
}

package relayprofile

import (
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fixtureDigest = "e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24"

func fixturePaths() Paths {
	root := filepath.Join("..", "..", "protocol")
	return Paths{
		Profile:                 filepath.Join(root, "relay-profiles", fixtureDigest+".json"),
		Schema:                  filepath.Join(root, "relay-profile.schema.json"),
		Keys:                    filepath.Join(root, "release-signing-keys.json"),
		KeysSchema:              filepath.Join(root, "release-signing-keys.schema.json"),
		Signatures:              filepath.Join(root, "relay-profiles", fixtureDigest+".sig"),
		SignatureSchema:         filepath.Join(root, "release-signature.schema.json"),
		AddressPolicy:           filepath.Join(root, "address-policy.json"),
		AddressPolicySchema:     filepath.Join(root, "address-policy.schema.json"),
		AddressPolicySignatures: filepath.Join(root, "address-policy.sig"),
	}
}

func TestLoadVerifiesSignedContentAddressedRelayProfile(t *testing.T) {
	verified, err := Load(fixturePaths(), true, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(verified.Digest[:]) != fixtureDigest || verified.DigestBase64URL() != "5GZyhBGAXqPJfJugRrDYjW4Ed8BoMHjEQYVLzmWAHiQ" {
		t.Fatalf("profile digest mismatch: %x %s", verified.Digest, verified.DigestBase64URL())
	}
	if verified.RelayURL() != "wss://relay.example.test/_zp/carrier" || verified.Profile.DeploymentID == "" {
		t.Fatalf("verified profile mismatch: %#v", verified.Profile)
	}
	if _, err := Load(fixturePaths(), false, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)); err == nil || !strings.Contains(err.Error(), "development") {
		t.Fatalf("development profile accepted for production: %v", err)
	}
}

func TestLoadRejectsContentAddressMismatch(t *testing.T) {
	paths := fixturePaths()
	raw, err := os.ReadFile(paths.Profile)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	paths.Profile = filepath.Join(directory, strings.Repeat("0", 64)+".json")
	if err := os.WriteFile(paths.Profile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	paths.Signatures = fixturePaths().Signatures
	if _, err := Load(paths, true, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)); err == nil || !strings.Contains(err.Error(), "content address") {
		t.Fatalf("wrong content address accepted: %v", err)
	}
}

func TestLoadRejectsTamperedAddressPolicy(t *testing.T) {
	paths := fixturePaths()
	raw, err := os.ReadFile(paths.AddressPolicy)
	if err != nil {
		t.Fatal(err)
	}
	paths.AddressPolicy = filepath.Join(t.TempDir(), "address-policy.json")
	raw = append([]byte(nil), raw...)
	raw[len(raw)-2] ^= 1
	if err := os.WriteFile(paths.AddressPolicy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(paths, true, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("tampered address policy accepted")
	}
}

func TestValidateRejectsExpiryRevocationAndLimitMismatch(t *testing.T) {
	verified, err := Load(fixturePaths(), true, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	profile := verified.Profile
	if err := Validate(profile, time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("expired relay profile accepted")
	}
	profile = verified.Profile
	revoked := "2026-07-15T00:00:00Z"
	profile.RevokedAt = &revoked
	if err := Validate(profile, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("revoked relay profile accepted")
	}
	profile = verified.Profile
	profile.Limits.MaxMessageBytes = profile.Limits.MaxFrameBytes - 1
	if err := Validate(profile, time.Date(2026, time.July, 16, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("incoherent relay limits accepted")
	}
}

func TestDecodeStrictRejectsUnknownProfileFields(t *testing.T) {
	var profile Profile
	if err := decodeStrict([]byte(`{"schema_version":1,"unknown":true}`), &profile); err == nil || errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unknown profile field accepted: %v", err)
	}
}

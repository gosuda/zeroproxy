package relayprofile

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gosuda/zeroproxy/internal/release"
)

const PrivacyDisclosure = "The relay sees the client IP, target hostname and port, timing and volume, and plaintext HTTP, but not verified HTTPS plaintext."

type Limits struct {
	MaxSessions        uint32 `json:"max_sessions"`
	MaxStreams         uint32 `json:"max_streams"`
	UploadByteBudget   uint64 `json:"upload_byte_budget"`
	DownloadByteBudget uint64 `json:"download_byte_budget"`
	MaxFrameBytes      uint32 `json:"max_frame_bytes"`
	MaxMessageBytes    uint32 `json:"max_message_bytes"`
	MaxFramesPerSecond uint32 `json:"max_frames_per_second"`
	HandshakeTimeoutMS uint32 `json:"handshake_timeout_ms"`
	IdleTimeoutMS      uint32 `json:"idle_timeout_ms"`
	SessionDeadlineMS  uint32 `json:"session_deadline_ms"`
}

type Profile struct {
	SchemaVersion        uint64   `json:"schema_version"`
	ProfileID            string   `json:"profile_id"`
	DisplayName          string   `json:"display_name"`
	DeploymentID         string   `json:"deployment_id"`
	RelayWSSOrigin       string   `json:"relay_wss_origin"`
	CarrierPath          string   `json:"carrier_path"`
	AllowedBrowseDomain  string   `json:"allowed_browse_domain"`
	AllowedTargetSchemes []string `json:"allowed_target_schemes"`
	AllowedTargetPorts   []uint16 `json:"allowed_target_ports"`
	AddressPolicyDigest  string   `json:"address_policy_digest"`
	TorMode              string   `json:"tor_mode"`
	Limits               Limits   `json:"limits"`
	PrivacyDisclosure    string   `json:"privacy_disclosure"`
	IssuedAt             string   `json:"issued_at"`
	ExpiresAt            string   `json:"expires_at"`
	KeyEpoch             uint64   `json:"key_epoch"`
	RevokedAt            *string  `json:"revoked_at,omitempty"`
}

type Paths struct {
	Profile                 string
	Schema                  string
	Keys                    string
	KeysSchema              string
	Signatures              string
	SignatureSchema         string
	AddressPolicy           string
	AddressPolicySchema     string
	AddressPolicySignatures string
}

type Verified struct {
	Profile                 Profile
	Digest                  [32]byte
	Canonical               json.RawMessage
	Keys                    release.KeySet
	Signatures              release.SignatureSet
	AddressPolicy           json.RawMessage
	AddressPolicySignatures release.SignatureSet
}

func decodeStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}

func validDomain(value string) bool {
	if value == "" || len(value) > 253 || value != strings.ToLower(value) || net.ParseIP(value) != nil {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func validRelayOrigin(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery {
		return false
	}
	if net.ParseIP(parsed.Hostname()) != nil || !validDomain(parsed.Hostname()) {
		return false
	}
	if port := parsed.Port(); port != "" {
		value, err := net.LookupPort("tcp", port)
		if err != nil || value == 0 {
			return false
		}
	}
	return parsed.String() == value
}

func parseCanonicalTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil || parsed.Format(time.RFC3339) != value || parsed.Location() != time.UTC {
		return time.Time{}, errors.New("non-canonical UTC timestamp")
	}
	return parsed, nil
}

func validateLimits(limits Limits) bool {
	return limits.MaxSessions > 0 && limits.MaxSessions <= 4096 &&
		limits.MaxStreams > 0 && limits.MaxStreams <= 4096 &&
		limits.UploadByteBudget > 0 && limits.DownloadByteBudget > 0 &&
		limits.MaxFrameBytes > 0 && limits.MaxFrameBytes <= 64<<10 &&
		limits.MaxMessageBytes >= limits.MaxFrameBytes && limits.MaxMessageBytes <= 4<<20 &&
		limits.MaxFramesPerSecond > 0 && limits.MaxFramesPerSecond <= 10000 &&
		limits.HandshakeTimeoutMS >= 1000 && limits.HandshakeTimeoutMS <= 60000 &&
		limits.IdleTimeoutMS >= 1000 && limits.IdleTimeoutMS <= 3600000 &&
		limits.SessionDeadlineMS >= limits.IdleTimeoutMS && limits.SessionDeadlineMS <= 86400000
}

func Validate(profile Profile, at time.Time) error {
	if profile.SchemaVersion != 1 || profile.ProfileID == "" || len(profile.ProfileID) > 128 ||
		profile.DisplayName == "" || len(profile.DisplayName) > 128 || profile.DeploymentID == "" ||
		len(profile.DeploymentID) > 128 || !validRelayOrigin(profile.RelayWSSOrigin) ||
		profile.CarrierPath != "/_zp/carrier" || !validDomain(profile.AllowedBrowseDomain) ||
		profile.AddressPolicyDigest == "" || profile.TorMode != "SOCKS5_DOMAIN_RFC1929" ||
		profile.PrivacyDisclosure != PrivacyDisclosure || profile.KeyEpoch == 0 || !validateLimits(profile.Limits) {
		return errors.New("invalid relay profile")
	}
	if decoded, err := hex.DecodeString(profile.AddressPolicyDigest); err != nil || len(decoded) != sha256.Size || profile.AddressPolicyDigest != strings.ToLower(profile.AddressPolicyDigest) {
		return errors.New("invalid relay address policy digest")
	}
	if len(profile.AllowedTargetSchemes) == 0 || len(profile.AllowedTargetSchemes) > 2 || !sort.StringsAreSorted(profile.AllowedTargetSchemes) {
		return errors.New("invalid relay target schemes")
	}
	for index, scheme := range profile.AllowedTargetSchemes {
		if scheme != "http" && scheme != "https" || index > 0 && scheme == profile.AllowedTargetSchemes[index-1] {
			return errors.New("invalid relay target schemes")
		}
	}
	if len(profile.AllowedTargetPorts) == 0 || len(profile.AllowedTargetPorts) > 256 {
		return errors.New("invalid relay target ports")
	}
	for index, port := range profile.AllowedTargetPorts {
		if port == 0 || index > 0 && port <= profile.AllowedTargetPorts[index-1] {
			return errors.New("invalid relay target ports")
		}
	}
	issuedAt, err := parseCanonicalTime(profile.IssuedAt)
	if err != nil {
		return err
	}
	expiresAt, err := parseCanonicalTime(profile.ExpiresAt)
	if err != nil {
		return err
	}
	if !issuedAt.Before(expiresAt) || at.Before(issuedAt) || !at.Before(expiresAt) {
		return errors.New("relay profile is not currently valid")
	}
	if profile.RevokedAt != nil {
		if _, err := parseCanonicalTime(*profile.RevokedAt); err != nil {
			return err
		}
		return errors.New("relay profile is revoked")
	}
	return nil
}

func Load(paths Paths, allowDevelopment bool, at time.Time) (Verified, error) {
	verify := release.VerifyProductionFilesWithSchemas
	if allowDevelopment {
		verify = release.VerifyDevelopmentFilesWithSchemas
	}
	if err := verify(paths.Profile, paths.Schema, paths.Keys, paths.KeysSchema, paths.Signatures, paths.SignatureSchema); err != nil {
		return Verified{}, fmt.Errorf("verify relay profile signature: %w", err)
	}
	if err := verify(
		paths.AddressPolicy,
		paths.AddressPolicySchema,
		paths.Keys,
		paths.KeysSchema,
		paths.AddressPolicySignatures,
		paths.SignatureSchema,
	); err != nil {
		return Verified{}, fmt.Errorf("verify address policy signature: %w", err)
	}
	profileRaw, err := os.ReadFile(paths.Profile)
	if err != nil {
		return Verified{}, err
	}
	canonical, err := release.CanonicalJSON(profileRaw)
	if err != nil {
		return Verified{}, err
	}
	if !bytes.Equal(profileRaw, canonical) {
		return Verified{}, errors.New("relay profile file is not RFC 8785 canonical")
	}
	digest := sha256.Sum256(canonical)
	expectedBase := hex.EncodeToString(digest[:])
	if filepath.Base(paths.Profile) != expectedBase+".json" || filepath.Base(paths.Signatures) != expectedBase+".sig" {
		return Verified{}, errors.New("relay profile content address mismatch")
	}
	var profile Profile
	if err := decodeStrict(profileRaw, &profile); err != nil {
		return Verified{}, err
	}
	if err := Validate(profile, at.UTC()); err != nil {
		return Verified{}, err
	}
	addressPolicyRaw, err := os.ReadFile(paths.AddressPolicy)
	if err != nil {
		return Verified{}, err
	}
	canonicalAddressPolicy, err := release.CanonicalJSON(addressPolicyRaw)
	if err != nil {
		return Verified{}, err
	}
	addressPolicyDigest := sha256.Sum256(canonicalAddressPolicy)
	if hex.EncodeToString(addressPolicyDigest[:]) != profile.AddressPolicyDigest {
		return Verified{}, errors.New("relay profile address policy digest mismatch")
	}
	keysRaw, err := os.ReadFile(paths.Keys)
	if err != nil {
		return Verified{}, err
	}
	signaturesRaw, err := os.ReadFile(paths.Signatures)
	if err != nil {
		return Verified{}, err
	}
	addressPolicySignaturesRaw, err := os.ReadFile(paths.AddressPolicySignatures)
	if err != nil {
		return Verified{}, err
	}
	var keys release.KeySet
	var signatures release.SignatureSet
	var addressPolicySignatures release.SignatureSet
	if err := decodeStrict(keysRaw, &keys); err != nil {
		return Verified{}, err
	}
	if err := decodeStrict(signaturesRaw, &signatures); err != nil {
		return Verified{}, err
	}
	if err := decodeStrict(addressPolicySignaturesRaw, &addressPolicySignatures); err != nil {
		return Verified{}, err
	}
	if profile.KeyEpoch != keys.KeyEpoch || profile.KeyEpoch != signatures.KeyEpoch ||
		profile.KeyEpoch != addressPolicySignatures.KeyEpoch {
		return Verified{}, errors.New("relay profile key epoch mismatch")
	}
	return Verified{
		Profile: profile, Digest: digest, Canonical: canonical, Keys: keys, Signatures: signatures,
		AddressPolicy: canonicalAddressPolicy, AddressPolicySignatures: addressPolicySignatures,
	}, nil
}

func (verified Verified) DigestBase64URL() string {
	return base64.RawURLEncoding.EncodeToString(verified.Digest[:])
}

func (verified Verified) RelayURL() string {
	return verified.Profile.RelayWSSOrigin + verified.Profile.CarrierPath
}

package release

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gowebpki/jcs"
)

type Key struct {
	ID         string `json:"id"`
	Role       string `json:"role"`
	Owner      string `json:"owner"`
	PublicKey  string `json:"public_key"`
	ValidFrom  string `json:"valid_from"`
	ValidUntil string `json:"valid_until"`
}

type KeySet struct {
	SchemaVersion   uint64 `json:"schema_version"`
	KeyEpoch        uint64 `json:"key_epoch"`
	Threshold       int    `json:"threshold"`
	DevelopmentOnly bool   `json:"development_only"`
	Keys            []Key  `json:"keys"`
}

type Signature struct {
	KeyID     string `json:"key_id"`
	Signature string `json:"signature"`
}

type SignatureSet struct {
	Algorithm        string      `json:"algorithm"`
	Canonicalization string      `json:"canonicalization"`
	KeyEpoch         uint64      `json:"key_epoch"`
	DevelopmentOnly  bool        `json:"development_only"`
	Signatures       []Signature `json:"signatures"`
}

func validateValue(dec *json.Decoder, token json.Token) error {
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		return validateJSONObject(dec)
	case '[':
		return validateJSONArray(dec)
	default:
		return errors.New("unexpected JSON delimiter")
	}
}

func validateJSONObject(dec *json.Decoder) error {
	seen := map[string]struct{}{}
	for dec.More() {
		key, err := nextJSONObjectKey(dec)
		if err != nil {
			return err
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("duplicate JSON key %q", key)
		}
		seen[key] = struct{}{}
		value, err := dec.Token()
		if err != nil {
			return err
		}
		if err := validateValue(dec, value); err != nil {
			return fmt.Errorf("JSON key %q: %w", key, err)
		}
	}
	return validateClosingDelimiter(dec, '}')
}

func nextJSONObjectKey(dec *json.Decoder) (string, error) {
	token, err := dec.Token()
	if err != nil {
		return "", err
	}
	key, ok := token.(string)
	if !ok {
		return "", errors.New("object key is not a string")
	}
	return key, nil
}

func validateJSONArray(dec *json.Decoder) error {
	for dec.More() {
		value, err := dec.Token()
		if err != nil {
			return err
		}
		if err := validateValue(dec, value); err != nil {
			return err
		}
	}
	return validateClosingDelimiter(dec, ']')
}

func validateClosingDelimiter(dec *json.Decoder, expected json.Delim) error {
	end, err := dec.Token()
	if err != nil {
		return fmt.Errorf("unterminated JSON %s: %w", expected, err)
	}
	if end != expected {
		return fmt.Errorf("mismatched JSON delimiter: got %q, want %q", end, expected)
	}
	return nil
}

func validateJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	root, err := dec.Token()
	if err != nil {
		return err
	}
	if err := validateValue(dec, root); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

func decodeStrict(data []byte, dst any) error {
	if err := validateJSON(data); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func CanonicalJSON(data []byte) ([]byte, error) {
	if err := validateJSON(data); err != nil {
		return nil, err
	}
	return jcs.Transform(data)
}

func verifyFiles(documentPath, keysPath, signaturesPath string, allowDevelopment bool) error {
	return verifyFilesAt(documentPath, keysPath, signaturesPath, allowDevelopment, time.Now().UTC())
}

func verifyFilesAt(documentPath, keysPath, signaturesPath string, allowDevelopment bool, at time.Time) error {
	documentSchema, err := adjacentDocumentSchema(documentPath)
	if err != nil {
		return err
	}
	schemaDir := filepath.Dir(keysPath)
	return verifyFilesWithSchemasAt(
		documentPath,
		documentSchema,
		keysPath,
		filepath.Join(schemaDir, "release-signing-keys.schema.json"),
		signaturesPath,
		filepath.Join(schemaDir, "release-signature.schema.json"),
		allowDevelopment,
		at,
	)
}

func verifyFilesWithSchemasAt(documentPath, documentSchema, keysPath, keysSchema, signaturesPath, signaturesSchema string, allowDevelopment bool, at time.Time) error {
	document, keysRaw, sigsRaw, err := readReleaseFiles(documentPath, keysPath, signaturesPath)
	if err != nil {
		return err
	}
	for _, pair := range []struct {
		name, schema, document string
	}{
		{"payload", documentSchema, documentPath},
		{"keys", keysSchema, keysPath},
		{"signatures", signaturesSchema, signaturesPath},
	} {
		if err := ValidateJSONFile(pair.schema, pair.document); err != nil {
			return fmt.Errorf("%s: %w", pair.name, err)
		}
	}
	keys, sigs, err := decodeReleaseMetadata(keysRaw, sigsRaw)
	if err != nil {
		return err
	}
	if err := validateSignatureMetadata(keys, sigs, allowDevelopment, at); err != nil {
		return err
	}
	canonicalDocument, err := CanonicalJSON(document)
	if err != nil {
		return err
	}
	keyByID, err := indexReleaseKeys(keys.Keys)
	if err != nil {
		return err
	}
	return verifyReleaseSignatures(sigs.Signatures, keyByID, canonicalDocument, keys.Threshold)
}

func adjacentDocumentSchema(documentPath string) (string, error) {
	if !strings.HasSuffix(documentPath, ".json") {
		return "", errors.New("signed payload path must end in .json")
	}
	return strings.TrimSuffix(documentPath, ".json") + ".schema.json", nil
}

func readReleaseFiles(documentPath, keysPath, signaturesPath string) ([]byte, []byte, []byte, error) {
	document, err := os.ReadFile(documentPath)
	if err != nil {
		return nil, nil, nil, err
	}
	keys, err := os.ReadFile(keysPath)
	if err != nil {
		return nil, nil, nil, err
	}
	signatures, err := os.ReadFile(signaturesPath)
	if err != nil {
		return nil, nil, nil, err
	}
	return document, keys, signatures, nil
}

func decodeReleaseMetadata(keysRaw, sigsRaw []byte) (KeySet, SignatureSet, error) {
	var keys KeySet
	if err := decodeStrict(keysRaw, &keys); err != nil {
		return KeySet{}, SignatureSet{}, fmt.Errorf("keys: %w", err)
	}
	var sigs SignatureSet
	if err := decodeStrict(sigsRaw, &sigs); err != nil {
		return KeySet{}, SignatureSet{}, fmt.Errorf("signatures: %w", err)
	}
	return keys, sigs, nil
}

func validateSignatureMetadata(keys KeySet, sigs SignatureSet, allowDevelopment bool, at time.Time) error {
	if keys.SchemaVersion != 1 || keys.KeyEpoch == 0 || keys.Threshold != 2 || sigs.Algorithm != "Ed25519" || sigs.Canonicalization != "RFC8785" || sigs.KeyEpoch != keys.KeyEpoch || sigs.DevelopmentOnly != keys.DevelopmentOnly {
		return errors.New("signature metadata mismatch")
	}
	if !allowDevelopment && keys.DevelopmentOnly {
		return errors.New("development signing material is forbidden in production")
	}
	if err := validateKeySet(keys, at); err != nil {
		return err
	}
	return nil
}

func validateKeySet(keys KeySet, at time.Time) error {
	if len(keys.Keys) < keys.Threshold {
		return errors.New("release key threshold exceeds key count")
	}
	hasSecurity := false
	publicKeys := make(map[string]struct{}, len(keys.Keys))
	for _, key := range keys.Keys {
		if key.Role != "release" && key.Role != "security" {
			return fmt.Errorf("invalid role for key %q", key.ID)
		}
		hasSecurity = hasSecurity || key.Role == "security"
		if key.Owner == "" {
			return fmt.Errorf("missing owner for key %q", key.ID)
		}
		if _, duplicate := publicKeys[key.PublicKey]; duplicate {
			return errors.New("duplicate release public key")
		}
		publicKeys[key.PublicKey] = struct{}{}
		validFrom, err := time.Parse(time.RFC3339, key.ValidFrom)
		if err != nil {
			return fmt.Errorf("key %q valid_from: %w", key.ID, err)
		}
		validUntil, err := time.Parse(time.RFC3339, key.ValidUntil)
		if err != nil {
			return fmt.Errorf("key %q valid_until: %w", key.ID, err)
		}
		if !validFrom.Before(validUntil) || at.Before(validFrom) || !at.Before(validUntil) {
			return fmt.Errorf("key %q is not valid at verification time", key.ID)
		}
	}
	if !hasSecurity {
		return errors.New("release key set has no security owner")
	}
	return nil
}

func indexReleaseKeys(keys []Key) (map[string]Key, error) {
	keyByID := make(map[string]Key, len(keys))
	for _, key := range keys {
		if _, duplicate := keyByID[key.ID]; duplicate {
			return nil, errors.New("duplicate key id")
		}
		keyByID[key.ID] = key
	}
	return keyByID, nil
}

func verifyReleaseSignatures(signatures []Signature, keyByID map[string]Key, document []byte, threshold int) error {
	result := releaseVerification{seen: make(map[string]bool), owners: make(map[string]bool)}
	for _, signature := range signatures {
		if err := result.add(signature, keyByID, document); err != nil {
			return err
		}
	}
	if result.valid < threshold || len(result.owners) < threshold || !result.security {
		return errors.New("release signature threshold not met")
	}
	return nil
}

type releaseVerification struct {
	seen     map[string]bool
	owners   map[string]bool
	valid    int
	security bool
}

func (result *releaseVerification) add(signature Signature, keyByID map[string]Key, document []byte) error {
	if result.seen[signature.KeyID] {
		return errors.New("duplicate signature")
	}
	result.seen[signature.KeyID] = true
	key, ok := keyByID[signature.KeyID]
	if !ok {
		return fmt.Errorf("signature references unknown key %q", signature.KeyID)
	}
	verified, err := verifyReleaseSignature(key, signature.Signature, document)
	if err != nil {
		return err
	}
	if !verified {
		return fmt.Errorf("invalid signature from key %q", signature.KeyID)
	}
	result.valid++
	result.owners[key.Owner] = true
	result.security = result.security || key.Role == "security"
	return nil
}

func verifyReleaseSignature(key Key, encodedSignature string, document []byte) (bool, error) {
	publicKey, err := base64.RawURLEncoding.DecodeString(key.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return false, errors.New("invalid public key")
	}
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil {
		return false, nil
	}
	return ed25519.Verify(publicKey, document, signature), nil
}

func VerifyDevelopmentFiles(documentPath, keysPath, signaturesPath string) error {
	return verifyFiles(documentPath, keysPath, signaturesPath, true)
}

func VerifyProductionFiles(documentPath, keysPath, signaturesPath string) error {
	return verifyFiles(documentPath, keysPath, signaturesPath, false)
}

func VerifyDevelopmentFilesWithSchemas(documentPath, documentSchema, keysPath, keysSchema, signaturesPath, signaturesSchema string) error {
	return verifyFilesWithSchemasAt(documentPath, documentSchema, keysPath, keysSchema, signaturesPath, signaturesSchema, true, time.Now().UTC())
}

func VerifyProductionFilesWithSchemas(documentPath, documentSchema, keysPath, keysSchema, signaturesPath, signaturesSchema string) error {
	return verifyFilesWithSchemasAt(documentPath, documentSchema, keysPath, keysSchema, signaturesPath, signaturesSchema, false, time.Now().UTC())
}

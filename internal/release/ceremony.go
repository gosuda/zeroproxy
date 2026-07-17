package release

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type SigningRequest struct {
	SchemaVersion      uint64   `json:"schema_version"`
	RequestType        string   `json:"request_type"`
	ProductionEligible bool     `json:"production_eligible"`
	DocumentSHA256     string   `json:"document_sha256"`
	CanonicalSHA256    string   `json:"canonical_sha256"`
	SchemaSHA256       string   `json:"schema_sha256"`
	KeysetSHA256       string   `json:"keyset_sha256"`
	KeyEpoch           uint64   `json:"key_epoch"`
	Threshold          int      `json:"threshold"`
	RequiredRoles      []string `json:"required_roles"`
}

type KeyTransition struct {
	FromEpoch            uint64   `json:"from_epoch"`
	ToEpoch              uint64   `json:"to_epoch"`
	PreviousKeysetSHA256 string   `json:"previous_keyset_sha256"`
	NextKeysetSHA256     string   `json:"next_keyset_sha256"`
	Reason               string   `json:"reason"`
	CreatedAt            string   `json:"created_at"`
	RevokedKeyIDs        []string `json:"revoked_key_ids"`
}

type RevocationProof struct {
	ManifestPath       string
	ManifestSchemaPath string
	SignaturesPath     string
}

type KeyTransitionOptions struct {
	PreviousKeysPath string
	NextKeysPath     string
	TransitionPath   string
	SignaturesPath   string
	ProtocolDir      string
	AllowDevelopment bool
	VerificationTime time.Time
	RevocationProof  *RevocationProof
}

type KeyChainOptions struct {
	GenesisDigest    string
	GenesisEpoch     uint64
	CurrentEpoch     uint64
	KeysetsDir       string
	TransitionsDir   string
	ProtocolDir      string
	AllowDevelopment bool
	VerificationTime time.Time
	RevocationProofs map[string]RevocationProof
}

func PrepareSigningRequest(documentPath, documentSchemaPath, keysPath, keysSchemaPath, requestSchemaPath string, at time.Time) ([]byte, []byte, error) {
	document, err := os.ReadFile(documentPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read document: %w", err)
	}
	schemaRaw, err := os.ReadFile(documentSchemaPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read document schema: %w", err)
	}
	keysRaw, err := os.ReadFile(keysPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read release keys: %w", err)
	}
	if err := ValidateJSON(documentSchemaPath, schemaRaw, document); err != nil {
		return nil, nil, fmt.Errorf("payload: %w", err)
	}
	if err := ValidateJSONFile(keysSchemaPath, keysPath); err != nil {
		return nil, nil, fmt.Errorf("keys: %w", err)
	}
	var keys KeySet
	if err := decodeStrict(keysRaw, &keys); err != nil {
		return nil, nil, fmt.Errorf("keys: %w", err)
	}
	if err := validateKeySet(keys, at); err != nil {
		return nil, nil, err
	}
	canonicalDocument, err := CanonicalJSON(document)
	if err != nil {
		return nil, nil, err
	}
	canonicalKeys, err := CanonicalJSON(keysRaw)
	if err != nil {
		return nil, nil, err
	}
	request := SigningRequest{
		SchemaVersion:      1,
		RequestType:        "detached-ed25519-rfc8785",
		ProductionEligible: false,
		DocumentSHA256:     sha256Hex(document),
		CanonicalSHA256:    sha256Hex(canonicalDocument),
		SchemaSHA256:       sha256Hex(schemaRaw),
		KeysetSHA256:       sha256Hex(canonicalKeys),
		KeyEpoch:           keys.KeyEpoch,
		Threshold:          keys.Threshold,
		RequiredRoles:      []string{"security"},
	}
	requestRaw, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	requestRaw = append(requestRaw, '\n')
	if err := ValidateJSONFileBytes(requestSchemaPath, requestRaw); err != nil {
		return nil, nil, fmt.Errorf("signing request: %w", err)
	}
	return canonicalDocument, requestRaw, nil
}

func ValidateJSONFileBytes(schemaPath string, document []byte) error {
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("read schema: %w", err)
	}
	return ValidateJSON(schemaPath, schemaRaw, document)
}

func VerifyKeyTransition(options KeyTransitionOptions) error {
	if options.VerificationTime.IsZero() {
		options.VerificationTime = time.Now().UTC()
	}
	keySchema := filepath.Join(options.ProtocolDir, "release-signing-keys.schema.json")
	transitionSchema := filepath.Join(options.ProtocolDir, "key-transition.schema.json")
	signatureSchema := filepath.Join(options.ProtocolDir, "release-signature.schema.json")
	for _, path := range []string{options.PreviousKeysPath, options.NextKeysPath} {
		if err := ValidateJSONFile(keySchema, path); err != nil {
			return fmt.Errorf("key set %q: %w", path, err)
		}
	}
	if err := ValidateJSONFile(transitionSchema, options.TransitionPath); err != nil {
		return fmt.Errorf("transition: %w", err)
	}
	if err := ValidateJSONFile(signatureSchema, options.SignaturesPath); err != nil {
		return fmt.Errorf("transition signatures: %w", err)
	}
	previousRaw, err := os.ReadFile(options.PreviousKeysPath)
	if err != nil {
		return err
	}
	nextRaw, err := os.ReadFile(options.NextKeysPath)
	if err != nil {
		return err
	}
	transitionRaw, err := os.ReadFile(options.TransitionPath)
	if err != nil {
		return err
	}
	signaturesRaw, err := os.ReadFile(options.SignaturesPath)
	if err != nil {
		return err
	}
	var previous, next KeySet
	var transition KeyTransition
	var signatures SignatureSet
	if err := decodeStrict(previousRaw, &previous); err != nil {
		return fmt.Errorf("previous keys: %w", err)
	}
	if err := decodeStrict(nextRaw, &next); err != nil {
		return fmt.Errorf("next keys: %w", err)
	}
	if err := decodeStrict(transitionRaw, &transition); err != nil {
		return fmt.Errorf("transition: %w", err)
	}
	if err := decodeStrict(signaturesRaw, &signatures); err != nil {
		return fmt.Errorf("transition signatures: %w", err)
	}
	createdAt, err := time.Parse(time.RFC3339, transition.CreatedAt)
	if err != nil {
		return fmt.Errorf("transition created_at: %w", err)
	}
	if createdAt.After(options.VerificationTime) {
		return errors.New("key transition is from the future")
	}
	if err := validateKeySet(previous, createdAt); err != nil {
		return fmt.Errorf("previous keys: %w", err)
	}
	if err := validateKeySet(next, createdAt); err != nil {
		return fmt.Errorf("next keys: %w", err)
	}
	if !options.AllowDevelopment && (previous.DevelopmentOnly || next.DevelopmentOnly) {
		return errors.New("development key transition is forbidden in production")
	}
	if transition.FromEpoch != previous.KeyEpoch || transition.ToEpoch != next.KeyEpoch || transition.ToEpoch != transition.FromEpoch+1 {
		return errors.New("non-contiguous key transition epoch")
	}
	previousCanonical, err := CanonicalJSON(previousRaw)
	if err != nil {
		return err
	}
	nextCanonical, err := CanonicalJSON(nextRaw)
	if err != nil {
		return err
	}
	if transition.PreviousKeysetSHA256 != sha256Hex(previousCanonical) || transition.NextKeysetSHA256 != sha256Hex(nextCanonical) {
		return errors.New("key transition digest mismatch")
	}
	if err := validateRevocations(transition.RevokedKeyIDs, previous.Keys, next.Keys); err != nil {
		return err
	}
	if err := validateSignatureMetadata(previous, signatures, options.AllowDevelopment, createdAt); err != nil {
		return err
	}
	transitionCanonical, err := CanonicalJSON(transitionRaw)
	if err != nil {
		return err
	}
	previousByID, err := indexReleaseKeys(previous.Keys)
	if err != nil {
		return err
	}
	if err := verifyReleaseSignatures(signatures.Signatures, previousByID, transitionCanonical, previous.Threshold); err != nil {
		return fmt.Errorf("transition threshold: %w", err)
	}
	if len(transition.RevokedKeyIDs) > 0 {
		if options.RevocationProof == nil {
			return errors.New("revocation requires a newly signed release manifest")
		}
		proof := options.RevocationProof
		manifestRaw, err := os.ReadFile(proof.ManifestPath)
		if err != nil {
			return fmt.Errorf("revocation manifest: %w", err)
		}
		var manifest map[string]any
		if err := decodeStrict(manifestRaw, &manifest); err != nil {
			return fmt.Errorf("revocation manifest: %w", err)
		}
		if manifest["key_transition_sha256"] != sha256Hex(transitionCanonical) {
			return errors.New("release manifest does not bind the revoking transition")
		}
		if err := verifyFilesWithSchemasAt(proof.ManifestPath, proof.ManifestSchemaPath, options.NextKeysPath, keySchema, proof.SignaturesPath, signatureSchema, options.AllowDevelopment, options.VerificationTime); err != nil {
			return fmt.Errorf("revocation release manifest: %w", err)
		}
	}
	return nil
}

func VerifyKeyChain(options KeyChainOptions) error {
	if options.VerificationTime.IsZero() {
		options.VerificationTime = time.Now().UTC()
	}
	if options.GenesisEpoch == 0 || options.CurrentEpoch < options.GenesisEpoch {
		return errors.New("invalid key chain epoch range")
	}
	if len(options.GenesisDigest) != sha256.Size*2 {
		return errors.New("invalid pinned genesis digest")
	}
	genesisPath := filepath.Join(options.KeysetsDir, strconv.FormatUint(options.GenesisEpoch, 10)+".json")
	genesisRaw, err := os.ReadFile(genesisPath)
	if err != nil {
		return fmt.Errorf("read genesis key set: %w", err)
	}
	keySchema := filepath.Join(options.ProtocolDir, "release-signing-keys.schema.json")
	if err := ValidateJSONFile(keySchema, genesisPath); err != nil {
		return fmt.Errorf("genesis key set: %w", err)
	}
	var genesis KeySet
	if err := decodeStrict(genesisRaw, &genesis); err != nil {
		return fmt.Errorf("genesis key set: %w", err)
	}
	if genesis.KeyEpoch != options.GenesisEpoch {
		return errors.New("genesis key epoch mismatch")
	}
	if !options.AllowDevelopment && genesis.DevelopmentOnly {
		return errors.New("development genesis is forbidden in production")
	}
	if err := validateKeySet(genesis, options.VerificationTime); err != nil {
		return fmt.Errorf("genesis key set: %w", err)
	}
	canonicalGenesis, err := CanonicalJSON(genesisRaw)
	if err != nil {
		return err
	}
	if sha256Hex(canonicalGenesis) != options.GenesisDigest {
		return errors.New("pinned genesis key digest mismatch")
	}
	for epoch := options.GenesisEpoch; epoch < options.CurrentEpoch; epoch++ {
		name := fmt.Sprintf("%d-%d", epoch, epoch+1)
		var proof *RevocationProof
		if value, ok := options.RevocationProofs[name]; ok {
			copy := value
			proof = &copy
		}
		if err := VerifyKeyTransition(KeyTransitionOptions{
			PreviousKeysPath: filepath.Join(options.KeysetsDir, fmt.Sprintf("%d.json", epoch)),
			NextKeysPath:     filepath.Join(options.KeysetsDir, fmt.Sprintf("%d.json", epoch+1)),
			TransitionPath:   filepath.Join(options.TransitionsDir, name+".json"),
			SignaturesPath:   filepath.Join(options.TransitionsDir, name+".sig"),
			ProtocolDir:      options.ProtocolDir,
			AllowDevelopment: options.AllowDevelopment,
			VerificationTime: options.VerificationTime,
			RevocationProof:  proof,
		}); err != nil {
			return fmt.Errorf("key transition %s: %w", name, err)
		}
	}
	return nil
}

func validateRevocations(revoked []string, previous, next []Key) error {
	previousIDs := make(map[string]bool, len(previous))
	nextIDs := make(map[string]bool, len(next))
	for _, key := range previous {
		previousIDs[key.ID] = true
	}
	for _, key := range next {
		nextIDs[key.ID] = true
	}
	for _, id := range revoked {
		if !previousIDs[id] {
			return fmt.Errorf("revocation references unknown previous key %q", id)
		}
		if nextIDs[id] {
			return fmt.Errorf("revoked key %q remains in the next key set", id)
		}
	}
	return nil
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

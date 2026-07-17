package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gosuda/zeroproxy/internal/release"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("command required: canonicalize, prepare, verify, verify-transition, or verify-chain")
	}
	switch args[0] {
	case "canonicalize":
		return canonicalize(args[1:])
	case "prepare":
		return prepare(args[1:])
	case "verify":
		return verify(args[1:])
	case "verify-transition":
		return verifyTransition(args[1:])
	case "verify-chain":
		return verifyChain(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func canonicalize(args []string) error {
	flags := flag.NewFlagSet("canonicalize", flag.ContinueOnError)
	document := flags.String("document", "", "schema-valid JSON document")
	schema := flags.String("schema", "", "JSON Schema")
	output := flags.String("out", "", "canonical RFC 8785 output")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *document == "" || *schema == "" || *output == "" {
		return errors.New("-document, -schema, and -out are required")
	}
	raw, err := os.ReadFile(*document)
	if err != nil {
		return err
	}
	canonical, err := release.CanonicalJSONWithSchema(*schema, raw)
	if err != nil {
		return err
	}
	if err := writeOutput(*output, canonical); err != nil {
		return err
	}
	return printResult(map[string]any{"canonical_bytes": len(canonical), "production_eligible": false})
}

func prepare(args []string) error {
	flags := flag.NewFlagSet("prepare", flag.ContinueOnError)
	document := flags.String("document", "", "JSON document")
	schema := flags.String("schema", "", "document JSON Schema")
	keys := flags.String("keys", "", "release key set")
	protocolDir := flags.String("protocol-dir", "protocol", "protocol schema directory")
	canonicalOut := flags.String("canonical-out", "", "canonical payload output")
	requestOut := flags.String("request-out", "", "unsigned signing request output")
	atValue := flags.String("at", "", "RFC 3339 verification time")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *document == "" || *schema == "" || *keys == "" || *canonicalOut == "" || *requestOut == "" {
		return errors.New("-document, -schema, -keys, -canonical-out, and -request-out are required")
	}
	at, err := parseTime(*atValue)
	if err != nil {
		return err
	}
	canonical, request, err := release.PrepareSigningRequest(
		*document,
		*schema,
		*keys,
		filepath.Join(*protocolDir, "release-signing-keys.schema.json"),
		filepath.Join(*protocolDir, "release-signing-request.schema.json"),
		at,
	)
	if err != nil {
		return err
	}
	if err := writeOutput(*canonicalOut, canonical); err != nil {
		return err
	}
	if err := writeOutput(*requestOut, request); err != nil {
		return err
	}
	return printResult(map[string]any{"canonical_out": *canonicalOut, "production_eligible": false, "request_out": *requestOut})
}

func verify(args []string) error {
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	document := flags.String("document", "", "signed JSON document")
	keys := flags.String("keys", "", "release key set")
	signatures := flags.String("signatures", "", "detached signature envelope")
	development := flags.Bool("development", false, "allow explicitly development-only keys")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *document == "" || *keys == "" || *signatures == "" {
		return errors.New("-document, -keys, and -signatures are required")
	}
	var err error
	if *development {
		err = release.VerifyDevelopmentFiles(*document, *keys, *signatures)
	} else {
		err = release.VerifyProductionFiles(*document, *keys, *signatures)
	}
	if err != nil {
		return err
	}
	return printResult(map[string]any{"development": *development, "signature_valid": true})
}

func verifyTransition(args []string) error {
	flags := flag.NewFlagSet("verify-transition", flag.ContinueOnError)
	previousKeys := flags.String("previous-keys", "", "previous key set")
	nextKeys := flags.String("next-keys", "", "next key set")
	transition := flags.String("transition", "", "key transition document")
	signatures := flags.String("signatures", "", "previous-threshold signatures")
	protocolDir := flags.String("protocol-dir", "protocol", "protocol schema directory")
	development := flags.Bool("development", false, "allow development key material")
	atValue := flags.String("at", "", "RFC 3339 verification time")
	revocationManifest := flags.String("revocation-manifest", "", "new release manifest required for revocation")
	revocationSchema := flags.String("revocation-manifest-schema", "", "release manifest schema")
	revocationSignatures := flags.String("revocation-manifest-signatures", "", "next-threshold release manifest signatures")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *previousKeys == "" || *nextKeys == "" || *transition == "" || *signatures == "" {
		return errors.New("-previous-keys, -next-keys, -transition, and -signatures are required")
	}
	at, err := parseTime(*atValue)
	if err != nil {
		return err
	}
	var proof *release.RevocationProof
	if *revocationManifest != "" || *revocationSchema != "" || *revocationSignatures != "" {
		if *revocationManifest == "" || *revocationSchema == "" || *revocationSignatures == "" {
			return errors.New("all revocation manifest flags are required together")
		}
		proof = &release.RevocationProof{ManifestPath: *revocationManifest, ManifestSchemaPath: *revocationSchema, SignaturesPath: *revocationSignatures}
	}
	if err := release.VerifyKeyTransition(release.KeyTransitionOptions{
		PreviousKeysPath: *previousKeys,
		NextKeysPath:     *nextKeys,
		TransitionPath:   *transition,
		SignaturesPath:   *signatures,
		ProtocolDir:      *protocolDir,
		AllowDevelopment: *development,
		VerificationTime: at,
		RevocationProof:  proof,
	}); err != nil {
		return err
	}
	return printResult(map[string]any{"key_transition_valid": true})
}

func verifyChain(args []string) error {
	flags := flag.NewFlagSet("verify-chain", flag.ContinueOnError)
	genesisDigest := flags.String("genesis-digest", "", "pinned canonical genesis key-set SHA-256")
	genesisEpoch := flags.Uint64("genesis-epoch", 1, "genesis key epoch")
	currentEpoch := flags.Uint64("current-epoch", 0, "current key epoch")
	keysetsDir := flags.String("keysets-dir", "", "directory containing <epoch>.json key sets")
	transitionsDir := flags.String("transitions-dir", "", "directory containing <from>-<to>.json and .sig")
	protocolDir := flags.String("protocol-dir", "protocol", "protocol schema directory")
	development := flags.Bool("development", false, "allow development key material")
	atValue := flags.String("at", "", "RFC 3339 verification time")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *genesisDigest == "" || *currentEpoch == 0 || *keysetsDir == "" || *transitionsDir == "" {
		return errors.New("-genesis-digest, -current-epoch, -keysets-dir, and -transitions-dir are required")
	}
	at, err := parseTime(*atValue)
	if err != nil {
		return err
	}
	if err := release.VerifyKeyChain(release.KeyChainOptions{
		GenesisDigest:    *genesisDigest,
		GenesisEpoch:     *genesisEpoch,
		CurrentEpoch:     *currentEpoch,
		KeysetsDir:       *keysetsDir,
		TransitionsDir:   *transitionsDir,
		ProtocolDir:      *protocolDir,
		AllowDevelopment: *development,
		VerificationTime: at,
	}); err != nil {
		return err
	}
	return printResult(map[string]any{"current_epoch": *currentEpoch, "key_chain_valid": true})
}

func parseTime(value string) (time.Time, error) {
	if value == "" {
		return time.Now().UTC(), nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid -at value %q: %w", value, err)
	}
	return parsed, nil
}

func writeOutput(path string, data []byte) error {
	if path == "-" {
		_, err := os.Stdout.Write(data)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary := path + ".tmp." + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(temporary, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func printResult(value map[string]any) error {
	return json.NewEncoder(os.Stdout).Encode(value)
}

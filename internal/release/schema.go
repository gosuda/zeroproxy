package release

import (
	"bytes"
	"fmt"
	"os"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func ValidateJSONFile(schemaPath, documentPath string) error {
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("read schema: %w", err)
	}
	document, err := os.ReadFile(documentPath)
	if err != nil {
		return fmt.Errorf("read document: %w", err)
	}
	return ValidateJSON(schemaPath, schemaRaw, document)
}

func ValidateJSON(schemaPath string, schemaRaw, document []byte) error {
	if err := validateJSON(schemaRaw); err != nil {
		return fmt.Errorf("invalid schema JSON: %w", err)
	}
	if err := validateJSON(document); err != nil {
		return fmt.Errorf("invalid document JSON: %w", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	schema, err := compiler.Compile(schemaPath)
	if err != nil {
		return fmt.Errorf("compile schema: %w", err)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(document))
	if err != nil {
		return fmt.Errorf("decode document: %w", err)
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("schema validation: %w", err)
	}
	return nil
}

func CanonicalJSONWithSchema(schemaPath string, data []byte) ([]byte, error) {
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		return nil, fmt.Errorf("read schema: %w", err)
	}
	if err := ValidateJSON(schemaPath, schemaRaw, data); err != nil {
		return nil, err
	}
	return CanonicalJSON(data)
}

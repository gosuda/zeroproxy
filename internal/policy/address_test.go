package policy

import (
	"encoding/json"
	"os"
	"testing"
)

type addressPolicyVectors struct {
	SchemaVersion int `json:"schema_version"`
	Vectors       []struct {
		Input     string  `json:"input"`
		Canonical *string `json:"canonical"`
		Allowed   bool    `json:"allowed"`
	} `json:"vectors"`
}

func TestCanonicalEgressHostSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../protocol/address-policy-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture addressPolicyVectors
	if err := json.Unmarshal(raw, &fixture); err != nil || fixture.SchemaVersion != 1 || len(fixture.Vectors) == 0 {
		t.Fatalf("invalid address policy vectors: %v", err)
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Input, func(t *testing.T) {
			canonical, err := CanonicalEgressHost(vector.Input)
			if vector.Allowed {
				if err != nil || vector.Canonical == nil || canonical != *vector.Canonical {
					t.Fatalf("canonical host = %q, %v; want %q", canonical, err, *vector.Canonical)
				}
				return
			}
			if err == nil || canonical != "" || vector.Canonical != nil {
				t.Fatalf("rejected host = %q, %v", canonical, err)
			}
		})
	}
}

package release

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationDispositionSignatures(t *testing.T) {
	if err := VerifyDevelopmentFiles("../../protocol/v1-migration-disposition.json", "../../protocol/release-signing-keys.json", "../../protocol/v1-migration-disposition.sig"); err != nil {
		t.Fatal(err)
	}
}

func TestProductionRejectsDevelopmentSigningMaterial(t *testing.T) {
	if err := VerifyProductionFiles("../../protocol/v1-migration-disposition.json", "../../protocol/release-signing-keys.json", "../../protocol/v1-migration-disposition.sig"); err == nil {
		t.Fatal("production accepted development signing material")
	}
}

func TestCanonicalJSONRejectsDuplicateAndTrailingValues(t *testing.T) {
	for _, input := range []string{`{"a":1,"a":2}`, `{"a":1} {"b":2}`, `{"a":1} trailing`} {
		if _, err := CanonicalJSON([]byte(input)); err == nil {
			t.Fatalf("accepted ambiguous JSON %q", input)
		}
	}
}

func TestCanonicalJSONRFC8785NumbersAndEscaping(t *testing.T) {
	input := []byte(`{"numbers":[333333333.33333329,1E30,4.50,2e-3],"string":"€$\u000f\nA'B\"\\\"/"}`)
	got, err := CanonicalJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"numbers":[333333333.3333333,1e+30,4.5,0.002],"string":"€$\u000f\nA'B\"\\\"/"}`
	if string(got) != want {
		t.Fatalf("canonical mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestSignatureTamperFails(t *testing.T) {
	dir := t.TempDir()
	document, err := os.ReadFile("../../protocol/v1-migration-disposition.json")
	if err != nil {
		t.Fatal(err)
	}
	document[len(document)-2] ^= 1
	docPath := filepath.Join(dir, "document.json")
	if err := os.WriteFile(docPath, document, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyDevelopmentFiles(docPath, "../../protocol/release-signing-keys.json", "../../protocol/v1-migration-disposition.sig"); err == nil {
		t.Fatal("tampered document passed signature verification")
	}
}

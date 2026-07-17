package errorauthority

import (
	"encoding/json"
	"strings"
	"testing"
)

const testRequestID = "request_identifier_1234"

func TestInternalErrorPublicizesWithoutCause(t *testing.T) {
	internal, err := NewInternal(ErrorVersion, CodeStaleOperation, StageCoordinator, testRequestID, map[string]any{"source": "private source text"})
	if err != nil {
		t.Fatal(err)
	}
	publicError, err := internal.Public(ErrorVersion)
	if err != nil {
		t.Fatal(err)
	}
	if publicError.RequestID != testRequestID || publicError.MessageKey != "stale_operation" || !publicError.Retryable {
		t.Fatalf("unexpected public error: %#v", publicError)
	}
	encoded, err := json.Marshal(publicError)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private source text") || strings.Contains(string(encoded), "internal_cause") {
		t.Fatalf("public error leaked internal cause: %s", encoded)
	}
}

func TestErrorAuthorityRejectsUnknownAndDriftedValues(t *testing.T) {
	cases := []struct {
		name string
		run  func() error
	}{
		{"version", func() error {
			_, err := NewInternal(ErrorVersion+1, CodeStaleOperation, StageCoordinator, testRequestID, nil)
			return err
		}},
		{"code", func() error {
			_, err := NewInternal(ErrorVersion, ErrorCode("UNKNOWN"), StageInternal, testRequestID, nil)
			return err
		}},
		{"stage", func() error {
			_, err := NewInternal(ErrorVersion, CodeStaleOperation, StageBody, testRequestID, nil)
			return err
		}},
		{"request", func() error {
			_, err := NewInternal(ErrorVersion, CodeStaleOperation, StageCoordinator, "short", nil)
			return err
		}},
		{"retryable", func() error {
			return (InternalError{Code: CodeStaleOperation, Stage: StageCoordinator, Retryable: false, RequestID: testRequestID}).Validate(ErrorVersion)
		}},
		{"message", func() error {
			return (PublicError{Code: CodeStaleOperation, Stage: StageCoordinator, Retryable: true, RequestID: testRequestID, MessageKey: "drifted"}).Validate(ErrorVersion)
		}},
		{"unknown field", func() error {
			_, err := DecodePublic(ErrorVersion, []byte(`{"code":"STALE_OPERATION","stage":"COORDINATOR","retryable":true,"request_id":"request_identifier_1234","message_key":"stale_operation","extra":true}`))
			return err
		}},
		{"trailing data", func() error { _, err := DecodePublic(ErrorVersion, []byte(`{} {}`)); return err }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if err := testCase.run(); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

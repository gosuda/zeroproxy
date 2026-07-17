package diagnostics

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/gosuda/zeroproxy/internal/errorauthority"
)

func testLogger(output *bytes.Buffer) *Logger {
	handler := slog.NewJSONHandler(output, &slog.HandlerOptions{Level: slog.LevelDebug})
	return NewLogger(slog.New(handler))
}

func assertSecretsAbsent(t *testing.T, output string) {
	t.Helper()
	for _, secret := range []string{
		"target.example/private?token=url-secret",
		"authorization-secret",
		"body-secret",
		"source-secret",
		"cookie-secret",
		"cbor-share-secret",
		"capability-secret",
		"socks-user:socks-password",
		"certificate for target.example",
	} {
		if strings.Contains(output, secret) {
			t.Fatalf("log contains %q: %s", secret, output)
		}
	}
}

func TestFailureDropsTLSOCKSAndCapabilityCauses(t *testing.T) {
	var output bytes.Buffer
	logger := testLogger(&output)
	cause := errors.New("https://target.example/private?token=url-secret authorization-secret body-secret source-secret cookie-secret cbor-share-secret capability-secret socks-user:socks-password certificate for target.example")
	logger.Failure(context.Background(), slog.LevelError, "carrier_failure", errorauthority.CodeServerCloseFailed, errorauthority.StageSocks, cause)
	encoded := output.String()
	assertSecretsAbsent(t, encoded)
	for _, expected := range []string{`"event":"carrier_failure"`, `"code":"SERVER_CLOSE_FAILED"`, `"stage":"SOCKS"`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("log missing %s: %s", expected, encoded)
		}
	}
}

func TestHTTPErrorLogDropsTLSHandshakeText(t *testing.T) {
	var output bytes.Buffer
	logger := testLogger(&output)
	logger.HTTPErrorLog().Print("http: TLS handshake error from target.example: certificate for target.example capability-secret")
	encoded := output.String()
	assertSecretsAbsent(t, encoded)
	for _, expected := range []string{`"event":"http_server_error"`, `"code":"SERVER_HTTP_ERROR"`, `"stage":"INTERNAL"`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("log missing %s: %s", expected, encoded)
		}
	}
}

func TestUntrustedEventAndClassificationFailClosed(t *testing.T) {
	var output bytes.Buffer
	logger := testLogger(&output)
	logger.ErrorFailure("target.example/private?token=url-secret", errorauthority.ErrorCode("PRIVATE"), errorauthority.StageTls, errors.New("capability-secret"))
	encoded := output.String()
	assertSecretsAbsent(t, encoded)
	for _, expected := range []string{`"event":"redacted_failure"`, `"code":"INTERNAL_FAILED"`, `"stage":"INTERNAL"`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("log missing %s: %s", expected, encoded)
		}
	}
}

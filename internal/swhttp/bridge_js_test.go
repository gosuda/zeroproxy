//go:build js && wasm

package swhttp

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResponseToJSUsesNullBodyForNullBodyStatus(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusNoContent,
		Status:     http.StatusText(http.StatusNoContent),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("must not be passed to Response constructor")),
	}
	v, err := ResponseToJS(context.Background(), resp, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := v.Get("status").Int(); got != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", got, http.StatusNoContent)
	}
	if !v.Get("body").IsNull() {
		t.Fatal("204 Response body must be null")
	}
}

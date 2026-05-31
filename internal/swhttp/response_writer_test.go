package swhttp

import (
	"net/http"
	"testing"
)

func TestResponseMayHaveBodyMatchesFetchNullBodyStatuses(t *testing.T) {
	for _, status := range []int{
		http.StatusContinue, http.StatusSwitchingProtocols, http.StatusProcessing, http.StatusEarlyHints,
		http.StatusNoContent, http.StatusResetContent, http.StatusNotModified,
	} {
		if responseMayHaveBody(status) {
			t.Fatalf("status %d must be constructed with a null JS Response body", status)
		}
	}
	for _, status := range []int{http.StatusOK, http.StatusCreated, http.StatusBadRequest, http.StatusInternalServerError} {
		if !responseMayHaveBody(status) {
			t.Fatalf("status %d should allow a JS Response body", status)
		}
	}
}

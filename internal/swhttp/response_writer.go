package swhttp

import "net/http"

func responseMayHaveBody(status int) bool {
	// 1xx informational and 204/205/304 carry no message body (RFC 9110 6.4.1);
	// attaching one makes the JS Response constructor throw in the WASM kernel.
	switch {
	case status >= 100 && status < 200,
		status == http.StatusNoContent,
		status == http.StatusResetContent,
		status == http.StatusNotModified:
		return false
	default:
		return true
	}
}

//go:build !js || !wasm

package swhttp

import (
	"context"
	"errors"
	"net/http"
)

var ErrWASMOnly = errors.New("swhttp: JS bridge is only available in js/wasm")

type JSValue struct{}

func RequestFromJS(ctx context.Context, v any) (*http.Request, error) { return nil, ErrWASMOnly }
func ResponseToJS(ctx context.Context, resp *http.Response, bodyTransformed, bodyDecoded, challengeCompat bool) (any, error) {
	return nil, ErrWASMOnly
}

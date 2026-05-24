//go:build !js || !wasm

package wsconn

import (
	"context"
	"errors"
	"net"
)

var ErrWASMOnly = errors.New("wsconn: browser WebSocket dialer is only available in js/wasm")

func Dial(ctx context.Context, rawURL string) (net.Conn, error) { return nil, ErrWASMOnly }

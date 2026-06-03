//go:build js && wasm

package main

import (
	"context"
	"fmt"
	"io"
	"syscall/js"
	"testing"

	"github.com/gosuda/zeroproxy/internal/wsproto"
)

// recordWSHandlers returns a JS handlers object whose message/close/error
// callbacks append a description of each call to *trace, so a test can assert
// exactly what the read loop delivered and in what order.
func recordWSHandlers(trace *[]string) js.Value {
	h := js.Global().Get("Object").New()
	h.Set("message", js.FuncOf(func(_ js.Value, args []js.Value) any {
		a := args[0]
		if a.Type() == js.TypeString {
			*trace = append(*trace, "message:text:"+a.String())
			return nil
		}
		u8 := js.Global().Get("Uint8Array").New(a)
		b := make([]byte, u8.Get("length").Int())
		js.CopyBytesToGo(b, u8)
		*trace = append(*trace, fmt.Sprintf("message:bin:%x", b))
		return nil
	}))
	h.Set("close", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		*trace = append(*trace, "close")
		return nil
	}))
	h.Set("error", js.FuncOf(func(_ js.Value, args []js.Value) any {
		*trace = append(*trace, "error:"+args[0].Get("message").String())
		return nil
	}))
	return h
}

type wsScript struct {
	op      byte
	payload []byte
	err     error
}

// runWSLoop drives runReadLoop over a scripted frame source and returns how many
// times readFrame was called — so a test can assert the loop STOPPED at its
// terminating frame instead of reading past it.
func runWSLoop(handlers js.Value, frames []wsScript) (calls int) {
	read := func(context.Context) (byte, []byte, error) {
		if calls >= len(frames) {
			calls++
			return 0, nil, io.EOF
		}
		f := frames[calls]
		calls++
		return f.op, f.payload, f.err
	}
	runReadLoop(context.Background(), func() js.Value { return handlers }, read)
	return calls
}

// TestRunReadLoopDeliversFramesAndStops pins the WebSocket read-loop contract the
// newJSWebSocketStream decomposition must preserve: text frames surface as string
// messages and binary/non-data frames as ArrayBuffer messages; an OpClose and a
// read error each deliver their handler and STOP the loop (fail closed — no spin
// past the terminating frame); message ordering is preserved.
func TestRunReadLoopDeliversFramesAndStops(t *testing.T) {
	cases := []struct {
		name      string
		frames    []wsScript
		wantTrace []string
		wantCalls int
	}{
		{"text then close", []wsScript{{op: wsproto.OpText, payload: []byte("hi")}, {op: wsproto.OpClose}}, []string{"message:text:hi", "close"}, 2},
		{"binary then close", []wsScript{{op: wsproto.OpBinary, payload: []byte{1, 2, 3}}, {op: wsproto.OpClose}}, []string{"message:bin:010203", "close"}, 2},
		{"close stops before later frames", []wsScript{{op: wsproto.OpClose}, {op: wsproto.OpText, payload: []byte("never")}}, []string{"close"}, 1},
		{"read error delivers error and stops", []wsScript{{err: io.ErrUnexpectedEOF}, {op: wsproto.OpText, payload: []byte("never")}}, []string{"error:TARGET_CONNECT_FAILED"}, 1},
		{"ordering preserved", []wsScript{{op: wsproto.OpText, payload: []byte("a")}, {op: wsproto.OpText, payload: []byte("b")}, {op: wsproto.OpClose}}, []string{"message:text:a", "message:text:b", "close"}, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var trace []string
			calls := runWSLoop(recordWSHandlers(&trace), tc.frames)
			if calls != tc.wantCalls {
				t.Fatalf("readFrame calls = %d, want %d (loop must stop at the terminating frame)", calls, tc.wantCalls)
			}
			if len(trace) != len(tc.wantTrace) {
				t.Fatalf("trace = %v, want %v", trace, tc.wantTrace)
			}
			for i := range trace {
				if trace[i] != tc.wantTrace[i] {
					t.Fatalf("trace[%d] = %q, want %q", i, trace[i], tc.wantTrace[i])
				}
			}
		})
	}

	// A read error with NO handler installed must still STOP the loop (fail closed),
	// not spin reading a dead connection forever.
	t.Run("error with falsy handlers stops without calling", func(t *testing.T) {
		calls := runWSLoop(js.Value{}, []wsScript{{err: io.ErrUnexpectedEOF}})
		if calls != 1 {
			t.Fatalf("readFrame calls = %d, want 1 (error must stop even with no handler)", calls)
		}
	})

	// The JS side may install a PARTIAL handlers object. A frame whose callback is
	// absent must fail soft (no-op, no panic) and the loop must still advance and
	// stop at close — pinning that dispatch goes through callHandler's guard.
	t.Run("frame with missing handler is a no-op, loop still completes", func(t *testing.T) {
		var trace []string
		h := js.Global().Get("Object").New()
		h.Set("close", js.FuncOf(func(_ js.Value, _ []js.Value) any { trace = append(trace, "close"); return nil }))
		calls := runWSLoop(h, []wsScript{
			{op: wsproto.OpText, payload: []byte("x")},
			{op: wsproto.OpBinary, payload: []byte{1}},
			{op: wsproto.OpClose},
		})
		if calls != 3 {
			t.Fatalf("readFrame calls = %d, want 3 (loop must read text+binary+close)", calls)
		}
		if len(trace) != 1 || trace[0] != "close" {
			t.Fatalf("trace = %v, want [close] (message frames with no handler are dropped, not panicking)", trace)
		}
	})
}

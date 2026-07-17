//go:build js && wasm

package wsconn

import (
	"bytes"
	"errors"
	"io"
	"syscall/js"
	"testing"
	"time"
)

const fakeWebSocketSource = `
globalThis.WebSocket = class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.requestedProtocols = protocols;
    this.protocol = globalThis.__selectedWebSocketProtocol;
    this.bufferedAmount = 0;
    this.closed = false;
    globalThis.__lastWebSocket = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  send(value) {
    this.lastSent = value;
  }
};
`

func installFakeWebSocket(t *testing.T, selectedProtocol string) {
	t.Helper()
	js.Global().Set("__selectedWebSocketProtocol", selectedProtocol)
	js.Global().Call("eval", fakeWebSocketSource)
	t.Cleanup(func() {
		js.Global().Delete("WebSocket")
		js.Global().Delete("__lastWebSocket")
		js.Global().Delete("__selectedWebSocketProtocol")
	})
}

func TestDialBrowserRejectsOmittedNegotiatedSubprotocol(t *testing.T) {
	installFakeWebSocket(t, "")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if connection != nil || err == nil {
		t.Fatalf("dial result connection=%v err=%v", connection, err)
	}
	websocket := js.Global().Get("__lastWebSocket")
	if got := websocket.Get("closeCode").Int(); got != 1002 {
		t.Fatalf("close code = %d", got)
	}
}

func TestDialBrowserClosesTextHandshakeFrame(t *testing.T) {
	installFakeWebSocket(t, "zeroproxy.carrier.v2")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	event := js.Global().Get("Object").New()
	event.Set("data", "not a binary frame")
	connection.ws.Get("onmessage").Invoke(event)
	if _, err := connection.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("text frame read error = %v", err)
	}
	if got := connection.ws.Get("closeCode").Int(); got != 1002 {
		t.Fatalf("close code = %d", got)
	}
}

func TestDialBrowserQueuesArrayBufferFrame(t *testing.T) {
	installFakeWebSocket(t, "zeroproxy.carrier.v2")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	want := []byte{0xa1, 0x01, 0x02}
	array := js.Global().Get("Uint8Array").New(len(want))
	js.CopyBytesToJS(array, want)
	event := js.Global().Get("Object").New()
	event.Set("data", array.Get("buffer"))
	connection.ws.Get("onmessage").Invoke(event)
	got, err := connection.ReadFrame()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("frame = %x", got)
	}
}

func TestDialBrowserAccountsNegotiatedDirectionalBudgets(t *testing.T) {
	installFakeWebSocket(t, "zeroproxy.carrier.v2")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetNegotiatedLimits(4, 4, 1, 1000, time.Minute, time.Hour); !errors.Is(err, ErrByteBudget) {
		t.Fatalf("pre-negotiation upload accounting: %v", err)
	}
	if err := connection.SetNegotiatedLimits(2, 2, 2, 1000, time.Minute, time.Hour); err != nil {
		t.Fatal(err)
	}
	array := js.Global().Get("Uint8Array").New(3)
	event := js.Global().Get("Object").New()
	event.Set("data", array.Get("buffer"))
	connection.ws.Get("onmessage").Invoke(event)
	if got := connection.ws.Get("closeCode").Int(); got != 1009 {
		t.Fatalf("download budget close code = %d", got)
	}
}

func TestDialBrowserEnforcesNegotiatedFrameRate(t *testing.T) {
	installFakeWebSocket(t, "zeroproxy.carrier.v2")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetNegotiatedLimits(2, 4, 4, 1, time.Minute, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Write([]byte{2}); !errors.Is(err, ErrFrameRate) {
		t.Fatalf("second frame error = %v", err)
	}
}

func TestDialBrowserFailsClosedAtOuterHighWaterWithoutPolling(t *testing.T) {
	installFakeWebSocket(t, "zeroproxy.carrier.v2")
	connection, err := DialBrowser("wss://relay.example/_zp/carrier", "zeroproxy.carrier.v2", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.ws.Set("bufferedAmount", 256<<10)
	started := time.Now()
	if _, err := connection.Write([]byte{1}); !errors.Is(err, ErrBufferedAmount) {
		t.Fatalf("high-water write error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("high-water write polled for %v", elapsed)
	}
	if connection.ws.Get("lastSent").Type() != js.TypeUndefined {
		t.Fatal("high-water frame reached browser WebSocket")
	}
}

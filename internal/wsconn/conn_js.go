//go:build js && wasm

package wsconn

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

type Conn struct {
	ws     js.Value
	reads  chan []byte
	closed chan struct{}
	mu     sync.Mutex
	buf    []byte
	onMsg  js.Func
	onErr  js.Func
	onCl   js.Func
}

func Dial(ctx context.Context, rawURL string) (net.Conn, error) {
	ws := js.Global().Get("WebSocket").New(rawURL)
	ws.Set("binaryType", "arraybuffer")
	c := &Conn{ws: ws, reads: make(chan []byte, 64), closed: make(chan struct{})}
	done := make(chan error, 1)
	var onOpen js.Func
	onOpen = js.FuncOf(func(this js.Value, args []js.Value) any {
		onOpen.Release()
		done <- nil
		return nil
	})
	c.onErr = js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case done <- errors.New("websocket open failed"):
		default:
		}
		c.Close()
		return nil
	})
	c.onCl = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.closeLocal()
		return nil
	})
	c.onMsg = js.FuncOf(func(this js.Value, args []js.Value) any {
		data := args[0].Get("data")
		uint8Array := js.Global().Get("Uint8Array").New(data)
		buf := make([]byte, uint8Array.Get("byteLength").Int())
		js.CopyBytesToGo(buf, uint8Array)
		select {
		case c.reads <- buf:
		case <-c.closed:
		}
		return nil
	})
	ws.Call("addEventListener", "open", onOpen)
	ws.Call("addEventListener", "message", c.onMsg)
	ws.Call("addEventListener", "error", c.onErr)
	ws.Call("addEventListener", "close", c.onCl)
	select {
	case err := <-done:
		return c, err
	case <-ctx.Done():
		c.Close()
		return nil, ctx.Err()
	}
}

func (c *Conn) Read(p []byte) (int, error) {
	c.mu.Lock()
	if len(c.buf) > 0 {
		n := copy(p, c.buf)
		c.buf = c.buf[n:]
		c.mu.Unlock()
		return n, nil
	}
	c.mu.Unlock()
	select {
	case b := <-c.reads:
		n := copy(p, b)
		if n < len(b) {
			c.mu.Lock()
			c.buf = append(c.buf, b[n:]...)
			c.mu.Unlock()
		}
		return n, nil
	case <-c.closed:
		return 0, io.EOF
	}
}

func (c *Conn) Write(p []byte) (int, error) {
	select {
	case <-c.closed:
		return 0, io.ErrClosedPipe
	default:
	}
	buf := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(buf, p)
	c.ws.Call("send", buf)
	return len(p), nil
}

func (c *Conn) Close() error {
	select {
	case <-c.closed:
		return nil
	default:
	}
	c.ws.Call("close")
	c.closeLocal()
	return nil
}

func (c *Conn) closeLocal() {
	select {
	case <-c.closed:
		return
	default:
		close(c.closed)
	}
	if c.onMsg.Truthy() {
		c.onMsg.Release()
	}
	if c.onErr.Truthy() {
		c.onErr.Release()
	}
	if c.onCl.Truthy() {
		c.onCl.Release()
	}
}

type addr string

func (a addr) Network() string                     { return "websocket" }
func (a addr) String() string                      { return string(a) }
func (c *Conn) LocalAddr() net.Addr                { return addr("browser") }
func (c *Conn) RemoteAddr() net.Addr               { return addr(c.ws.Get("url").String()) }
func (c *Conn) SetDeadline(t time.Time) error      { return nil }
func (c *Conn) SetReadDeadline(t time.Time) error  { return nil }
func (c *Conn) SetWriteDeadline(t time.Time) error { return nil }

//go:build js && wasm

package wsconn

import (
	"errors"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

type jsAddr string

func (a jsAddr) Network() string { return "websocket" }
func (a jsAddr) String() string  { return string(a) }

type BrowserConn struct {
	ws                          js.Value
	mu                          sync.Mutex
	writeMu                     sync.Mutex
	queue                       [][]byte
	queuedBytes, maxQueued      int
	current                     []byte
	notify                      chan struct{}
	closed                      chan struct{}
	closedOnce, callbackOnce    sync.Once
	readDeadline, writeDeadline time.Time
	callbacks                   []js.Func
	limitsSet                   bool
	maxMessage                  int
	readBytes, writeBytes       uint64
	readBudget, writeBudget     uint64
	maxFramesPerSecond          uint32
	rateWindow                  time.Time
	rateCount                   uint32
	idleTimeout                 time.Duration
	sessionDeadline             time.Time
}

func DialBrowser(url, protocol string, maxQueued int) (*BrowserConn, error) {
	c := &BrowserConn{notify: make(chan struct{}, 1), closed: make(chan struct{}), maxQueued: maxQueued}
	opened := make(chan struct{}, 1)
	failed := make(chan struct{}, 1)
	c.ws = js.Global().Get("WebSocket").New(url, js.ValueOf([]any{protocol}))
	c.ws.Set("binaryType", "arraybuffer")
	onOpen := js.FuncOf(func(this js.Value, args []js.Value) any {
		if c.ws.Get("protocol").String() != protocol {
			c.ws.Call("close", 1002, "subprotocol mismatch")
			select {
			case failed <- struct{}{}:
			default:
			}
			return nil
		}
		select {
		case opened <- struct{}{}:
		default:
		}
		return nil
	})
	onError := js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case failed <- struct{}{}:
		default:
		}
		return nil
	})
	onClose := js.FuncOf(func(this js.Value, args []js.Value) any {
		c.markClosed()
		go c.releaseCallbacks()
		return nil
	})
	onMessage := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}
		data := args[0].Get("data")
		if data.Type() != js.TypeObject || !data.InstanceOf(js.Global().Get("ArrayBuffer")) {
			c.ws.Call("close", 1002, "binary frame required")
			return nil
		}
		bytes := make([]byte, data.Get("byteLength").Int())
		if js.CopyBytesToGo(bytes, js.Global().Get("Uint8Array").New(data)) != len(bytes) {
			c.ws.Call("close", 1002, "binary frame invalid")
			return nil
		}
		c.mu.Lock()
		if c.limitsSet {
			now := time.Now()
			if !now.Before(c.sessionDeadline) {
				c.mu.Unlock()
				c.ws.Call("close", 1008, "carrier deadline")
				return nil
			}
			if err := c.admitFrameLocked(now); err != nil {
				c.mu.Unlock()
				c.ws.Call("close", 1008, "carrier rate")
				return nil
			}
			if len(bytes) > c.maxMessage || c.readBytes+uint64(len(bytes)) > c.readBudget {
				c.mu.Unlock()
				c.ws.Call("close", 1009, "carrier limit")
				return nil
			}
			c.readDeadline = c.activityDeadlineLocked(now)
		}
		if c.queuedBytes+len(bytes) > c.maxQueued {
			c.mu.Unlock()
			c.ws.Call("close", 1009, "queue limit")
			return nil
		}
		c.readBytes += uint64(len(bytes))
		c.queue = append(c.queue, bytes)
		c.queuedBytes += len(bytes)
		c.mu.Unlock()
		c.signal()
		return nil
	})
	c.callbacks = []js.Func{onOpen, onError, onClose, onMessage}
	c.ws.Set("onopen", onOpen)
	c.ws.Set("onerror", onError)
	c.ws.Set("onclose", onClose)
	c.ws.Set("onmessage", onMessage)
	select {
	case <-opened:
		return c, nil
	case <-failed:
		c.Close()
		return nil, errors.New("websocket dial failed")
	case <-time.After(10 * time.Second):
		c.Close()
		return nil, errors.New("websocket dial timeout")
	}
}
func (c *BrowserConn) signal() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}
func (c *BrowserConn) ReadFrame() ([]byte, error) {
	for {
		c.mu.Lock()
		if len(c.current) > 0 {
			c.mu.Unlock()
			return nil, errors.New("stream read already started")
		}
		if len(c.queue) > 0 {
			frame := c.queue[0]
			c.queue = c.queue[1:]
			c.queuedBytes -= len(frame)
			c.mu.Unlock()
			return frame, nil
		}
		deadline := c.readDeadline
		c.mu.Unlock()
		var timer <-chan time.Time
		if !deadline.IsZero() {
			timer = time.After(time.Until(deadline))
		}
		select {
		case <-c.notify:
		case <-c.closed:
			return nil, io.EOF
		case <-timer:
			return nil, errors.New("read timeout")
		}
	}
}
func (c *BrowserConn) WriteFrame(p []byte) error {
	n, err := c.Write(p)
	if err != nil {
		return err
	}
	if n != len(p) {
		return io.ErrShortWrite
	}
	return nil
}
func (c *BrowserConn) Read(p []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.current) == 0 && len(c.queue) > 0 {
			c.current = c.queue[0]
			c.queue = c.queue[1:]
			c.queuedBytes -= len(c.current)
		}
		if len(c.current) > 0 {
			n := copy(p, c.current)
			c.current = c.current[n:]
			c.mu.Unlock()
			return n, nil
		}
		deadline := c.readDeadline
		c.mu.Unlock()
		var timer <-chan time.Time
		if !deadline.IsZero() {
			timer = time.After(time.Until(deadline))
		}
		select {
		case <-c.notify:
		case <-c.closed:
			return 0, io.EOF
		case <-timer:
			return 0, errors.New("read timeout")
		}
	}
}
func (c *BrowserConn) SetNegotiatedLimits(maxMessage int, readBudget, writeBudget uint64, maxFramesPerSecond uint32, idleTimeout, sessionDeadline time.Duration) error {
	if maxMessage <= 0 || readBudget == 0 || writeBudget == 0 || maxFramesPerSecond == 0 || idleTimeout <= 0 || sessionDeadline < idleTimeout {
		return errors.New("invalid carrier limits")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.readBytes > readBudget || c.writeBytes > writeBudget {
		return ErrByteBudget
	}
	now := time.Now()
	c.maxMessage = maxMessage
	c.readBudget = readBudget
	c.writeBudget = writeBudget
	c.maxFramesPerSecond = maxFramesPerSecond
	c.rateWindow = now
	c.rateCount = 0
	c.idleTimeout = idleTimeout
	c.sessionDeadline = now.Add(sessionDeadline)
	c.readDeadline = c.activityDeadlineLocked(now)
	c.writeDeadline = c.readDeadline
	c.limitsSet = true
	return nil
}

func (c *BrowserConn) admitFrameLocked(now time.Time) error {
	if now.Sub(c.rateWindow) >= time.Second {
		c.rateWindow, c.rateCount = now, 0
	}
	if c.rateCount >= c.maxFramesPerSecond {
		return ErrFrameRate
	}
	c.rateCount++
	return nil
}

func (c *BrowserConn) activityDeadlineLocked(now time.Time) time.Time {
	deadline := now.Add(c.idleTimeout)
	if c.sessionDeadline.Before(deadline) {
		return c.sessionDeadline
	}
	return deadline
}

func (c *BrowserConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	const maxBufferedAmount = 256 << 10
	buffered := c.ws.Get("bufferedAmount").Int()
	if buffered < 0 || len(p) > maxBufferedAmount || buffered > maxBufferedAmount-len(p) {
		return 0, ErrBufferedAmount
	}
	c.mu.Lock()
	if c.limitsSet {
		now := time.Now()
		if !now.Before(c.sessionDeadline) {
			c.mu.Unlock()
			return 0, errors.New("carrier session deadline")
		}
		if err := c.admitFrameLocked(now); err != nil {
			c.mu.Unlock()
			return 0, err
		}
		if len(p) > c.maxMessage || c.writeBytes+uint64(len(p)) > c.writeBudget {
			c.mu.Unlock()
			return 0, ErrByteBudget
		}
		c.writeDeadline = c.activityDeadlineLocked(now)
	}
	c.writeBytes += uint64(len(p))
	c.mu.Unlock()
	array := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(array, p)
	c.ws.Call("send", array)
	return len(p), nil
}
func (c *BrowserConn) markClosed() {
	c.closedOnce.Do(func() { close(c.closed) })
	c.signal()
}
func (c *BrowserConn) releaseCallbacks() {
	c.callbackOnce.Do(func() {
		if c.ws.Truthy() {
			c.ws.Set("onopen", js.Null())
			c.ws.Set("onerror", js.Null())
			c.ws.Set("onclose", js.Null())
			c.ws.Set("onmessage", js.Null())
		}
		for _, callback := range c.callbacks {
			callback.Release()
		}
	})
}

func (c *BrowserConn) Close() error {
	if c.ws.Truthy() {
		c.ws.Call("close", 1000, "closed")
	}
	c.markClosed()
	c.releaseCallbacks()
	return nil
}
func (c *BrowserConn) LocalAddr() net.Addr  { return jsAddr("browser") }
func (c *BrowserConn) RemoteAddr() net.Addr { return jsAddr(c.ws.Get("url").String()) }
func (c *BrowserConn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.writeDeadline = t
	c.mu.Unlock()
	return nil
}
func (c *BrowserConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.mu.Unlock()
	return nil
}
func (c *BrowserConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return nil
}

package wsconn

import (
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var ErrByteBudget = errors.New("carrier byte budget exhausted")
var ErrFrameRate = errors.New("carrier frame rate exhausted")
var ErrBufferedAmount = errors.New("carrier browser buffer full")

type Conn struct {
	ws                            *websocket.Conn
	readMu                        sync.Mutex
	writeMu                       sync.Mutex
	rateMu                        sync.Mutex
	reader                        io.Reader
	local, remote                 net.Addr
	maxMessage                    int64
	readRemaining, writeRemaining uint64
	maxFramesPerSecond            uint32
	rateWindow                    time.Time
	rateCount                     uint32
	idleTimeout                   time.Duration
	sessionDeadline               time.Time
}

func New(ws *websocket.Conn, maxMessage int64, readBudget, writeBudget uint64, maxFramesPerSecond uint32, idleTimeout time.Duration, sessionDeadline time.Time) *Conn {
	ws.SetReadLimit(maxMessage)
	return &Conn{ws: ws, local: ws.LocalAddr(), remote: ws.RemoteAddr(), maxMessage: maxMessage, readRemaining: readBudget, writeRemaining: writeBudget, maxFramesPerSecond: maxFramesPerSecond, rateWindow: time.Now(), idleTimeout: idleTimeout, sessionDeadline: sessionDeadline}
}

func (c *Conn) operationDeadline() (time.Time, error) {
	now := time.Now()
	if !now.Before(c.sessionDeadline) {
		return time.Time{}, os.ErrDeadlineExceeded
	}
	deadline := now.Add(c.idleTimeout)
	if c.sessionDeadline.Before(deadline) {
		deadline = c.sessionDeadline
	}
	return deadline, nil
}

func (c *Conn) admitFrame() error {
	c.rateMu.Lock()
	defer c.rateMu.Unlock()
	now := time.Now()
	if now.Sub(c.rateWindow) >= time.Second {
		c.rateWindow, c.rateCount = now, 0
	}
	if c.rateCount >= c.maxFramesPerSecond {
		return ErrFrameRate
	}
	c.rateCount++
	return nil
}

func (c *Conn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for {
		if c.reader != nil {
			if c.readRemaining == 0 {
				return 0, ErrByteBudget
			}
			readBuffer := p
			if uint64(len(readBuffer)) > c.readRemaining {
				readBuffer = readBuffer[:c.readRemaining]
			}
			n, err := c.reader.Read(readBuffer)
			c.readRemaining -= uint64(n)
			if errors.Is(err, io.EOF) {
				c.reader = nil
				if n > 0 {
					return n, nil
				}
				continue
			}
			return n, err
		}
		deadline, err := c.operationDeadline()
		if err != nil {
			return 0, err
		}
		if err := c.ws.SetReadDeadline(deadline); err != nil {
			return 0, err
		}
		kind, reader, err := c.ws.NextReader()
		if err != nil {
			return 0, err
		}
		if err := c.admitFrame(); err != nil {
			return 0, err
		}
		if kind != websocket.BinaryMessage {
			return 0, errors.New("non-binary carrier frame")
		}
		c.reader = io.LimitReader(reader, c.maxMessage+1)
	}
}

func (c *Conn) Write(p []byte) (int, error) {
	if int64(len(p)) > c.maxMessage {
		return 0, errors.New("carrier frame too large")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if uint64(len(p)) > c.writeRemaining {
		return 0, ErrByteBudget
	}
	deadline, err := c.operationDeadline()
	if err != nil {
		return 0, err
	}
	if err := c.ws.SetWriteDeadline(deadline); err != nil {
		return 0, err
	}
	if err := c.admitFrame(); err != nil {
		return 0, err
	}
	writer, err := c.ws.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return 0, err
	}
	n, writeErr := writer.Write(p)
	c.writeRemaining -= uint64(n)
	closeErr := writer.Close()
	if writeErr != nil {
		return n, writeErr
	}
	if closeErr != nil {
		return n, closeErr
	}
	if n != len(p) {
		return n, io.ErrShortWrite
	}
	return n, nil
}
func (c *Conn) Close() error         { return c.ws.Close() }
func (c *Conn) LocalAddr() net.Addr  { return c.local }
func (c *Conn) RemoteAddr() net.Addr { return c.remote }
func (c *Conn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}
func (c *Conn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

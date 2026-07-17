package transportlab

import (
	"sync"
	"time"
)

// Capture records bounded transport lifecycle evidence without retaining payloads.
type Capture struct {
	mu     sync.Mutex
	limit  int
	events []CaptureEvent
}

type CaptureEvent struct {
	At      time.Time
	Layer   string
	Action  string
	Success bool
}

func NewCapture(limit int) *Capture {
	if limit < 1 {
		limit = 1
	}
	return &Capture{limit: limit}
}

func (c *Capture) Record(layer, action string, success bool) {
	if len(layer) == 0 || len(layer) > 32 || len(action) == 0 || len(action) > 64 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.events) == c.limit {
		copy(c.events, c.events[1:])
		c.events = c.events[:c.limit-1]
	}
	c.events = append(c.events, CaptureEvent{At: time.Now().UTC(), Layer: layer, Action: action, Success: success})
}

func (c *Capture) Events() []CaptureEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]CaptureEvent, len(c.events))
	copy(result, c.events)
	return result
}

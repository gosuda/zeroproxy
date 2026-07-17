package route

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/gosuda/zeroproxy/internal/policy"
)

type Kind string

const (
	Document Kind = "document"
	Resource Kind = "resource"
	Script   Kind = "script"
	Module   Kind = "module"
	Style    Kind = "style"
	Worker   Kind = "worker"
	Download Kind = "download"
	API      Kind = "api"
)

type Binding struct {
	ID         string
	ProfileID  string
	TabID      string
	DocumentID string
	OriginID   string
	Target     string
	Fragment   string
	Kind       Kind
	ExpiresAt  time.Time
	Consumed   bool
}

type Table struct {
	mu     sync.Mutex
	routes map[string]Binding
	now    func() time.Time
}

func NewTable() *Table { return &Table{routes: map[string]Binding{}, now: time.Now} }

func (t *Table) Register(b Binding, ttl time.Duration) (Binding, error) {
	if b.ProfileID == "" || b.TabID == "" || b.DocumentID == "" || b.OriginID == "" || ttl <= 0 {
		return Binding{}, errors.New("incomplete route binding")
	}
	target, err := policy.ParseTarget(b.Target)
	if err != nil {
		return Binding{}, err
	}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return Binding{}, err
	}
	b.ID = base64.RawURLEncoding.EncodeToString(raw[:])
	b.Target, b.Fragment, b.ExpiresAt = target.URL.String(), target.Fragment, t.now().Add(ttl)
	t.mu.Lock()
	t.routes[b.ID] = b
	t.mu.Unlock()
	return b, nil
}

func (t *Table) Consume(id, profileID, tabID, documentID, originID string) (Binding, error) {
	if strings.ContainsAny(id, "/?#") {
		return Binding{}, errors.New("invalid route id")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	b, ok := t.routes[id]
	if !ok || b.Consumed || !t.now().Before(b.ExpiresAt) {
		delete(t.routes, id)
		return Binding{}, errors.New("route unavailable")
	}
	if b.ProfileID != profileID || b.TabID != tabID || b.DocumentID != documentID || b.OriginID != originID {
		return Binding{}, errors.New("route capability mismatch")
	}
	b.Consumed = true
	delete(t.routes, id)
	return b, nil
}


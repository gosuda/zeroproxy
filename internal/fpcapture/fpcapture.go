// Package fpcapture extracts the user's browser TLS ClientHello
// fingerprint at server-side TLS handshake time and stores it so the
// WASM kernel can replay the same shape on upstream handshakes.
//
// The capture path is `crypto/tls.Config.GetConfigForClient`, which the
// Go runtime calls with a parsed `ClientHelloInfo` before the handshake
// completes. Since Go 1.21 `ClientHelloInfo.Extensions` exposes the raw
// extension type list in the order the client sent them — that's the
// piece JA3 hashes and the piece browser fingerprints actually diverge
// on. Combined with `CipherSuites`, `SupportedCurves`, `SupportedPoints`,
// `SupportedVersions`, and `SignatureSchemes` we have everything needed
// to drive rustls's ClientHello emission so it byte-equivalents
// (modulo GREASE values, which JA3 strips) the user's real browser.
//
// Per-connection state lives in `Store` keyed by `RemoteAddr().String()`.
// HTTP handlers later read the caller's `r.RemoteAddr` to look up their
// own fingerprint and ship it to the page. Entries auto-expire after
// 10 minutes to bound memory; in practice a browser navigation reuses
// a single TCP connection for many requests so the entry exists for
// the whole tab session.
package fpcapture

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"
)

// Spec is the JSON shape the kernel consumes. Mirrors the JA3 hash
// inputs (version + ciphers + extensions + curves + ec_point_formats)
// plus signature schemes and ALPN protocols for non-JA3 fidelity.
//
// Field names are camelCase because the SW (JS) sees them. uint16 is
// the on-wire representation of every TLS code point we expose; the
// Rust kernel re-narrows to enum types as needed.
type Spec struct {
	SupportedVersions []uint16 `json:"supportedVersions"`
	CipherSuites      []uint16 `json:"cipherSuites"`
	Extensions        []uint16 `json:"extensions"`
	SupportedCurves   []uint16 `json:"supportedCurves"`
	SupportedPoints   []uint8  `json:"supportedPoints"`
	SignatureSchemes  []uint16 `json:"signatureSchemes"`
	ALPNProtocols     []string `json:"alpnProtocols"`
	ServerName        string   `json:"serverName"`
	CapturedAtMs      int64    `json:"capturedAtMs"`
}

// FromClientHello converts a `tls.ClientHelloInfo` (Go's parsed view)
// into a Spec. Caller invariant: chi must be the value Go passes to
// `GetConfigForClient` — at that point Extensions / CipherSuites / etc.
// reflect what the wire said.
func FromClientHello(chi *tls.ClientHelloInfo) Spec {
	return Spec{
		SupportedVersions: chi.SupportedVersions,
		CipherSuites:      chi.CipherSuites,
		Extensions:        chi.Extensions,
		SupportedCurves:   curvesToUint(chi.SupportedCurves),
		SupportedPoints:   chi.SupportedPoints,
		SignatureSchemes:  schemesToUint(chi.SignatureSchemes),
		ALPNProtocols:     chi.SupportedProtos,
		ServerName:        chi.ServerName,
		CapturedAtMs:      time.Now().UnixMilli(),
	}
}

// EncodeBase64 packs the spec as base64-encoded JSON so it survives an
// HTML attribute or HTTP header round trip without escaping concerns.
// SW decodes on the other side.
func (s Spec) EncodeBase64() string {
	b, _ := json.Marshal(s)
	return base64.StdEncoding.EncodeToString(b)
}

// Store maps remote-address → most recent Spec captured from that peer.
// Concurrent-safe (handshakes and HTTP lookups can race).
//
// Entries silently expire after `TTL`; we don't proactively GC, just
// drop on read. The expected access pattern is: capture once at the
// start of a tab, look up many times during that tab, never look up
// after the tab closes.
type Store struct {
	mu    sync.RWMutex
	specs map[string]record
	ttl   time.Duration
}

type record struct {
	spec      Spec
	createdAt time.Time
}

// TTL is how long a captured spec stays useful. Browsers reuse a single
// TCP connection for the duration of a page load (and beyond, via
// keep-alive); 10 minutes covers an interactive tab session without
// growing unbounded if peers disconnect and we never see them again.
const TTL = 10 * time.Minute

// NewStore returns an empty store with the default TTL.
func NewStore() *Store {
	return &Store{
		specs: make(map[string]record),
		ttl:   TTL,
	}
}

// Set records `spec` for `remoteAddr`. Last write wins — every new
// handshake from the same client refreshes the entry.
func (s *Store) Set(remoteAddr string, spec Spec) {
	s.mu.Lock()
	s.specs[remoteAddr] = record{spec: spec, createdAt: time.Now()}
	s.mu.Unlock()
}

// Get returns the most recent Spec for `remoteAddr`, or false if there
// isn't one or it has expired. Expired entries are dropped lazily.
func (s *Store) Get(remoteAddr string) (Spec, bool) {
	s.mu.RLock()
	rec, ok := s.specs[remoteAddr]
	s.mu.RUnlock()
	if !ok {
		return Spec{}, false
	}
	if time.Since(rec.createdAt) > s.ttl {
		s.mu.Lock()
		// Re-check under the write lock — another goroutine may have
		// refreshed it between our read and our delete.
		if cur, ok := s.specs[remoteAddr]; ok && time.Since(cur.createdAt) > s.ttl {
			delete(s.specs, remoteAddr)
		}
		s.mu.Unlock()
		return Spec{}, false
	}
	return rec.spec, true
}

func curvesToUint(in []tls.CurveID) []uint16 {
	out := make([]uint16, len(in))
	for i, v := range in {
		out[i] = uint16(v)
	}
	return out
}

func schemesToUint(in []tls.SignatureScheme) []uint16 {
	out := make([]uint16, len(in))
	for i, v := range in {
		out[i] = uint16(v)
	}
	return out
}

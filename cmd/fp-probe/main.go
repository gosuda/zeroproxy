// fp-probe is a one-off TLS fingerprint capture probe.
//
// Purpose: see what `tls.ClientHelloInfo` exposes when a real browser
// connects, so we can decide whether to wire it into ZeroProxy server
// for per-user JA3 replay (phase 4 of the JA3 work; currently rustls
// fork in third_party-rustls-fork/ hardcodes a Chrome 134 shape).
//
// Run:
//   go run ./cmd/fp-probe
//   # accept self-signed cert in browser at https://localhost:4433
//   # tee logs to /tmp/fp.log for diffing across browsers
//
// What we want to confirm:
//   * Extensions []uint16 actually populated (Go 1.21+ feature; pkg
//     docs say it is, but I want to see the live data including GREASE
//     positions and exact order)
//   * CipherSuites / SupportedCurves / SupportedPoints round-trip
//     identically to what tls.peet.ws sees from the same browser
//     (sanity check — if Go's parser drops anything we'd not have
//     enough to replay)
//   * Per-tab repeatability — does the browser send the same fingerprint
//     on every fresh connection, or does GREASE randomness churn the
//     extension list order? (JA3 strips GREASE, so the answer matters
//     for JA4 / direct replay but not for JA3 hash.)
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"sync"
	"time"
)

// captured is the JSON shape we'd hand off to the WASM kernel. Mirrors
// the JA3 hash inputs (TLS version, ciphers, extensions, curves,
// EC point formats) plus a few signals we'd reuse on the upstream side
// (ALPN choice, signature schemes).
type captured struct {
	RemoteAddr        string   `json:"remoteAddr"`
	ServerName        string   `json:"serverName"`
	SupportedVersions []uint16 `json:"supportedVersions"`
	CipherSuites      []uint16 `json:"cipherSuites"`
	Extensions        []uint16 `json:"extensions"`
	SupportedCurves   []uint16 `json:"supportedCurves"`
	SupportedPoints   []uint8  `json:"supportedPoints"`
	SignatureSchemes  []uint16 `json:"signatureSchemes"`
	SupportedProtos   []string `json:"supportedProtos"`
	CapturedAt        string   `json:"capturedAt"`
}

var (
	mu      sync.Mutex
	lastFps = make(map[string]captured) // keyed by remoteAddr
)

func main() {
	cert := mustSelfSign()

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		// GetConfigForClient is called per ClientHello with the parsed
		// info. Returning (nil, nil) keeps the listener's config.
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			c := captured{
				RemoteAddr:        chi.Conn.RemoteAddr().String(),
				ServerName:        chi.ServerName,
				SupportedVersions: chi.SupportedVersions,
				CipherSuites:      chi.CipherSuites,
				Extensions:        chi.Extensions,
				SupportedCurves:   curvesToUint(chi.SupportedCurves),
				SupportedPoints:   chi.SupportedPoints,
				SignatureSchemes:  schemesToUint(chi.SignatureSchemes),
				SupportedProtos:   chi.SupportedProtos,
				CapturedAt:        time.Now().Format(time.RFC3339Nano),
			}
			mu.Lock()
			lastFps[c.RemoteAddr] = c
			mu.Unlock()
			log.Printf("captured fingerprint from %s sni=%q exts=%d ciphers=%d",
				c.RemoteAddr, c.ServerName, len(c.Extensions), len(c.CipherSuites))
			return nil, nil
		},
		NextProtos: []string{"h2", "http/1.1"},
	}

	mux := http.NewServeMux()
	// Browser lands here after accepting the cert. Echoes back the
	// captured fingerprint so you can copy it out of the page text.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		c, ok := lastFps[r.RemoteAddr]
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no fingerprint captured for this peer"}`))
			return
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(c)
	})
	// `/raw` is a plain text dump for grep / diff comparisons across
	// browsers (Chrome / Edge / Firefox / Safari).
	mux.HandleFunc("/raw", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for addr, c := range lastFps {
			fmt.Fprintf(w, "peer=%s\n", addr)
			fmt.Fprintf(w, "  sni=%q\n", c.ServerName)
			fmt.Fprintf(w, "  versions=%v\n", c.SupportedVersions)
			fmt.Fprintf(w, "  ciphers=%v\n", c.CipherSuites)
			fmt.Fprintf(w, "  exts=%v\n", c.Extensions)
			fmt.Fprintf(w, "  curves=%v\n", c.SupportedCurves)
			fmt.Fprintf(w, "  points=%v\n", c.SupportedPoints)
			fmt.Fprintf(w, "  sig_schemes=%v\n", c.SignatureSchemes)
			fmt.Fprintf(w, "  alpns=%v\n", c.SupportedProtos)
			fmt.Fprintf(w, "  at=%s\n\n", c.CapturedAt)
		}
	})

	listener, err := tls.Listen("tcp", ":4433", tlsConfig)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("fp-probe listening on https://localhost:4433")
	log.Printf("  open in browser; accept self-signed cert; see /raw for dump")
	srv := &http.Server{Handler: mux}
	if err := srv.Serve(listener); err != nil {
		log.Fatal(err)
	}
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

// mustSelfSign generates a fresh in-memory self-signed cert valid for
// localhost. Browser will show a security warning — that's fine for
// this probe.
func mustSelfSign() tls.Certificate {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatalf("genkey: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "fp-probe"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		log.Fatalf("certgen: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		log.Fatalf("keymarshal: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		log.Fatalf("x509keypair: %v", err)
	}
	return cert
}

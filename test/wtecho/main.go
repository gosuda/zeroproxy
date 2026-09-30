// wtecho is a WebTransport echo target for browser tests of the D4 gateway.
//
// It listens on a random 127.0.0.1 UDP port with a self-signed ECDSA P-256
// certificate valid for 13 days — the only kind a browser accepts through
// `serverCertificateHashes` — and prints one JSON line
// `{"addr":"127.0.0.1:port","certHash":"<base64url SHA-256>"}` so a test can
// pin it. Bidirectional streams and datagrams are echoed back verbatim.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

func main() {
	cert, hash, err := pinnableCert()
	if err != nil {
		log.Fatal(err)
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	srv := &webtransport.Server{H3: &http3.Server{
		Handler:   mux,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{http3.NextProtoH3}},
	}}
	webtransport.ConfigureHTTP3Server(srv.H3)
	// Browsers send an Origin; this fixture serves any page.
	srv.CheckOrigin = func(*http.Request) bool { return true }
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		s, err := srv.Upgrade(w, r)
		if err != nil {
			return
		}
		go func() {
			for {
				str, err := s.AcceptStream(context.Background())
				if err != nil {
					return
				}
				go func() { _, _ = io.Copy(str, str); _ = str.Close() }()
			}
		}()
		go func() {
			for {
				d, err := s.ReceiveDatagram(context.Background())
				if err != nil {
					return
				}
				_ = s.SendDatagram(d)
			}
		}()
	})
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"addr": conn.LocalAddr().String(), "certHash": hash})
	log.Fatal(srv.Serve(conn))
}

func pinnableCert() (tls.Certificate, string, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(13 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	sum := sha256.Sum256(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

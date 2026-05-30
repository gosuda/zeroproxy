package shareurl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"strings"

	"golang.org/x/crypto/hkdf"
)

var (
	shareInfoEnc   = []byte("zp-url-cbc-enc")
	shareInfoMAC   = []byte("zp-url-cbc-mac")
	shareMACPrefix = []byte("ZP-CBC-URL-V1")
	base64RawURL   = base64.RawURLEncoding
)

const (
	ControlPrefix       = "/zp/"
	maxRelayServers     = 8
	maxRelayServerBytes = 2048
)

// New returns a /zp/p/<encrypted>#k=<key> path for target using the same
// AES-256-CBC + HMAC-SHA256 envelope as web/zp-core.js. Use NewWithServers
// when the share URL must carry explicit relay server parameters.
func New(target string) (string, error) { return NewWithRand(rand.Reader, target) }

func NewWithServers(target string, servers []string) (string, error) {
	return NewWithRandAndServers(rand.Reader, target, servers)
}

func NewWithRand(random io.Reader, target string) (string, error) {
	return NewWithRandAndServers(random, target, nil)
}

func NewWithRandAndServers(random io.Reader, target string, servers []string) (string, error) {
	u, err := url.Parse(target)
	if err != nil || u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("shareurl: unsupported target URL")
	}
	target = u.String()
	var seed [64]byte
	var iv [aes.BlockSize]byte
	if _, err := io.ReadFull(random, seed[:]); err != nil {
		return "", err
	}
	if _, err := io.ReadFull(random, iv[:]); err != nil {
		return "", err
	}
	encKey, err := derive(seed[:], shareInfoEnc)
	if err != nil {
		return "", err
	}
	macKey, err := derive(seed[:], shareInfoMAC)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return "", err
	}
	plain := pkcs7Pad([]byte(target), aes.BlockSize)
	ciphertext := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, iv[:]).CryptBlocks(ciphertext, plain)

	mac := hmac.New(sha256.New, macKey)
	_, _ = mac.Write(shareMACPrefix)
	_, _ = mac.Write(iv[:])
	_, _ = mac.Write(ciphertext)
	tag := mac.Sum(nil)

	blob := make([]byte, 0, len(iv)+len(ciphertext)+len(tag))
	blob = append(blob, iv[:]...)
	blob = append(blob, ciphertext...)
	blob = append(blob, tag...)
	encrypted := base64RawURL.EncodeToString(blob)
	fragment, err := shareFragment(base64RawURL.EncodeToString(seed[:]), servers)
	if err != nil {
		return "", err
	}
	return ControlPrefix + "p/" + encrypted + fragment, nil
}

func shareFragment(key string, servers []string) (string, error) {
	params := url.Values{}
	params.Set("k", key)
	normalized, err := NormalizeRelayServers(servers)
	if err != nil {
		return "", err
	}
	for _, server := range normalized {
		params.Add("server", server)
	}
	return "#" + params.Encode(), nil
}

func NormalizeRelayServers(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	total := 0
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if len(out) >= maxRelayServers {
			return nil, fmt.Errorf("shareurl: too many relay servers")
		}
		u, err := url.Parse(value)
		if err != nil || u == nil || u.Host == "" {
			return nil, fmt.Errorf("shareurl: malformed relay server")
		}
		if u.User != nil || u.Fragment != "" {
			return nil, fmt.Errorf("shareurl: malformed relay server")
		}
		switch u.Scheme {
		case "wss":
		case "ws":
			if !isLoopbackHost(u.Hostname()) {
				return nil, fmt.Errorf("shareurl: insecure relay server")
			}
		default:
			return nil, fmt.Errorf("shareurl: unsupported relay server")
		}
		host := strings.ToLower(u.Hostname())
		port := u.Port()
		if u.Scheme == "wss" && port == "443" || u.Scheme == "ws" && port == "80" {
			port = ""
		}
		u.User = nil
		u.Fragment = ""
		u.Host = canonicalHostPort(host, port)
		if u.Path == "" {
			u.Path = "/"
		}
		normalized := u.String()
		total += len(normalized)
		if total > maxRelayServerBytes {
			return nil, fmt.Errorf("shareurl: relay server list too large")
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out, nil
}

func canonicalHostPort(host, port string) string {
	if port != "" {
		return net.JoinHostPort(host, port)
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func isLoopbackHost(host string) bool {
	h := strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	addr, err := netip.ParseAddr(h)
	return err == nil && addr.IsLoopback()
}

func derive(seed, info []byte) ([]byte, error) {
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, seed, nil, info), key); err != nil {
		return nil, err
	}
	return key, nil
}

func pkcs7Pad(in []byte, blockSize int) []byte {
	pad := blockSize - len(in)%blockSize
	out := make([]byte, len(in)+pad)
	copy(out, in)
	for i := len(in); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

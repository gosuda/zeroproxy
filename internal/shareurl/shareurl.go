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
	"net/url"

	"golang.org/x/crypto/hkdf"
)

var (
	shareInfoEnc   = []byte("zp-url-cbc-enc")
	shareInfoMAC   = []byte("zp-url-cbc-mac")
	shareMACPrefix = []byte("ZP-CBC-URL-V1")
	base64RawURL   = base64.RawURLEncoding
)

// New returns a /p/<encrypted>#k=<key> path for target using the same
// AES-256-CBC + HMAC-SHA256 envelope as web/zp-core.js.
func New(target string) (string, error) { return NewWithRand(rand.Reader, target) }

func NewWithRand(random io.Reader, target string) (string, error) {
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
	return "/p/" + base64RawURL.EncodeToString(blob) + "#k=" + base64RawURL.EncodeToString(seed[:]), nil
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

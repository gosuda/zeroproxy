package shareurl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"strings"
	"testing"

	"golang.org/x/crypto/hkdf"
)

func TestNewWithRandRoundTripsEnvelope(t *testing.T) {
	const target = "https://example.com/path?q=1#frag"
	random := strings.NewReader(strings.Repeat("x", 80))
	path, err := NewWithRand(random, target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, "/p/") || !strings.Contains(path, "#k=") {
		t.Fatalf("unexpected share path %q", path)
	}
	parts := strings.Split(strings.TrimPrefix(path, "/p/"), "#k=")
	if len(parts) != 2 {
		t.Fatalf("malformed share path %q", path)
	}
	got := decryptForTest(t, parts[0], parts[1])
	if got != target {
		t.Fatalf("got %q want %q", got, target)
	}
}

func decryptForTest(t *testing.T, encrypted, key string) string {
	t.Helper()
	seed, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := base64.RawURLEncoding.DecodeString(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if len(seed) != 64 || len(blob) < aes.BlockSize+sha256.Size || (len(blob)-aes.BlockSize-sha256.Size)%aes.BlockSize != 0 {
		t.Fatalf("bad envelope lengths seed=%d blob=%d", len(seed), len(blob))
	}
	iv := blob[:aes.BlockSize]
	ciphertext := blob[aes.BlockSize : len(blob)-sha256.Size]
	tag := blob[len(blob)-sha256.Size:]
	macKey := deriveForTest(t, seed, shareInfoMAC)
	mac := hmac.New(sha256.New, macKey)
	_, _ = mac.Write(shareMACPrefix)
	_, _ = mac.Write(iv)
	_, _ = mac.Write(ciphertext)
	if !hmac.Equal(tag, mac.Sum(nil)) {
		t.Fatal("bad hmac")
	}
	block, err := aes.NewCipher(deriveForTest(t, seed, shareInfoEnc))
	if err != nil {
		t.Fatal(err)
	}
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ciphertext)
	pad := int(plain[len(plain)-1])
	if pad == 0 || pad > aes.BlockSize || pad > len(plain) {
		t.Fatalf("bad padding %d", pad)
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			t.Fatalf("bad padding byte %d want %d", b, pad)
		}
	}
	return string(plain[:len(plain)-pad])
}

func deriveForTest(t *testing.T, seed, info []byte) []byte {
	t.Helper()
	out := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, seed, nil, info), out); err != nil {
		t.Fatal(err)
	}
	return out
}

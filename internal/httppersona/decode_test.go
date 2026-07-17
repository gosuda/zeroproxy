package httppersona

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func TestDecodeResponseStreamsChromeContentCodings(t *testing.T) {
	plaintext := []byte("decoded representation across chunk boundaries")
	tests := []struct {
		name     string
		encoding []string
		encoded  []byte
	}{
		{name: "gzip", encoding: []string{"gzip"}, encoded: encodeGzip(t, plaintext)},
		{name: "zlib deflate", encoding: []string{"deflate"}, encoded: encodeZlib(t, plaintext)},
		{name: "raw deflate", encoding: []string{"deflate"}, encoded: encodeFlate(t, plaintext)},
		{name: "brotli", encoding: []string{"br"}, encoded: encodeBrotli(t, plaintext)},
		{name: "zstandard", encoding: []string{"zstd"}, encoded: encodeZstd(t, plaintext)},
		{name: "stacked comma list", encoding: []string{"gzip, br"}, encoded: encodeBrotli(t, encodeGzip(t, plaintext))},
		{name: "stacked field lines", encoding: []string{"gzip", "br"}, encoded: encodeBrotli(t, encodeGzip(t, plaintext))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := &http.Response{
				Header: http.Header{"Content-Encoding": test.encoding, "Content-Length": {"999"}},
				Body:   io.NopCloser(bytes.NewReader(test.encoded)), ContentLength: int64(len(test.encoded)),
			}
			if err := DecodeResponse(response); err != nil {
				t.Fatal(err)
			}
			decoded, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(decoded, plaintext) {
				t.Fatalf("decoded body = %q, want %q", decoded, plaintext)
			}
			if response.Header.Get("Content-Encoding") != "" || response.Header.Get("Content-Length") != "" || response.ContentLength != -1 || !response.Uncompressed {
				t.Fatalf("decoded metadata was not normalized: headers=%v length=%d uncompressed=%v", response.Header, response.ContentLength, response.Uncompressed)
			}
		})
	}
}

func TestDecodeResponsePreservesBodylessRepresentationMetadata(t *testing.T) {
	tests := []struct {
		name   string
		method string
		status int
	}{
		{name: "HEAD", method: http.MethodHead, status: http.StatusOK},
		{name: "no content", method: http.MethodGet, status: http.StatusNoContent},
		{name: "not modified", method: http.MethodGet, status: http.StatusNotModified},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := &http.Response{
				StatusCode:    test.status,
				Request:       &http.Request{Method: test.method},
				Header:        http.Header{"Content-Encoding": {"gzip"}, "Content-Length": {"123"}},
				Body:          io.NopCloser(bytes.NewReader(nil)),
				ContentLength: 123,
			}
			if err := DecodeResponse(response); err != nil {
				t.Fatal(err)
			}
			if response.Header.Get("Content-Encoding") != "gzip" || response.Header.Get("Content-Length") != "123" || response.ContentLength != 123 || response.Uncompressed {
				t.Fatalf("bodyless metadata changed: headers=%v length=%d uncompressed=%v", response.Header, response.ContentLength, response.Uncompressed)
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDecodeResponseRejectsUnknownCodingAndClosesBody(t *testing.T) {
	body := &trackedReadCloser{Reader: stringsReader("opaque")}
	response := &http.Response{Header: http.Header{"Content-Encoding": {"compress"}}, Body: body}
	if err := DecodeResponse(response); err == nil {
		t.Fatal("unknown content coding was accepted")
	}
	if !body.closed {
		t.Fatal("body was not closed after decoder initialization failed")
	}
}

type trackedReadCloser struct {
	io.Reader
	closed bool
}

func (body *trackedReadCloser) Close() error {
	body.closed = true
	return nil
}

func stringsReader(value string) io.Reader { return bytes.NewBufferString(value) }

func encodeGzip(t *testing.T, value []byte) []byte {
	t.Helper()
	return encodeWithCloser(t, value, func(buffer *bytes.Buffer) (io.WriteCloser, error) { return gzip.NewWriter(buffer), nil })
}

func encodeZlib(t *testing.T, value []byte) []byte {
	t.Helper()
	return encodeWithCloser(t, value, func(buffer *bytes.Buffer) (io.WriteCloser, error) { return zlib.NewWriter(buffer), nil })
}

func encodeFlate(t *testing.T, value []byte) []byte {
	t.Helper()
	return encodeWithCloser(t, value, func(buffer *bytes.Buffer) (io.WriteCloser, error) {
		return flate.NewWriter(buffer, flate.DefaultCompression)
	})
}

func encodeBrotli(t *testing.T, value []byte) []byte {
	t.Helper()
	return encodeWithCloser(t, value, func(buffer *bytes.Buffer) (io.WriteCloser, error) { return brotli.NewWriter(buffer), nil })
}

func encodeZstd(t *testing.T, value []byte) []byte {
	t.Helper()
	return encodeWithCloser(t, value, func(buffer *bytes.Buffer) (io.WriteCloser, error) {
		return zstd.NewWriter(buffer, zstd.WithEncoderConcurrency(1))
	})
}

func encodeWithCloser(t *testing.T, value []byte, constructor func(*bytes.Buffer) (io.WriteCloser, error)) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer, err := constructor(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(value); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

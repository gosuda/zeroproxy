package httppersona

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

type decodedBody struct {
	io.Reader
	base    io.Closer
	closers []func() error
}

func (body *decodedBody) Close() error {
	closeErrors := make([]error, 0, len(body.closers)+1)
	for index := len(body.closers) - 1; index >= 0; index-- {
		closeErrors = append(closeErrors, body.closers[index]())
	}
	closeErrors = append(closeErrors, body.base.Close())
	return errors.Join(closeErrors...)
}

// DecodeResponse streams every advertised content coding in reverse order and
// removes representation metadata that no longer describes the decoded body.
func DecodeResponse(response *http.Response) error {
	if responseHasNoBody(response) {
		return nil
	}
	encodings := contentEncodings(response.Header.Values("Content-Encoding"))
	if len(encodings) == 0 {
		return nil
	}
	body := &decodedBody{Reader: response.Body, base: response.Body}
	for index := len(encodings) - 1; index >= 0; index-- {
		if err := body.addDecoder(encodings[index]); err != nil {
			return errors.Join(err, body.Close())
		}
	}
	response.Body = body
	response.Header.Del("Content-Encoding")
	response.Header.Del("Content-Length")
	response.ContentLength = -1
	response.Uncompressed = true
	return nil
}

func responseHasNoBody(response *http.Response) bool {
	return response.Request != nil && response.Request.Method == http.MethodHead ||
		response.StatusCode >= 100 && response.StatusCode <= 199 ||
		response.StatusCode == http.StatusNoContent ||
		response.StatusCode == http.StatusNotModified
}

func contentEncodings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	encodings := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			encoding := strings.ToLower(strings.TrimSpace(part))
			if encoding != "" && encoding != "identity" {
				encodings = append(encodings, encoding)
			}
		}
	}
	return encodings
}

func (body *decodedBody) addDecoder(encoding string) error {
	switch encoding {
	case "gzip":
		decoder, err := gzip.NewReader(body.Reader)
		if err != nil {
			return fmt.Errorf("initialize gzip decoder: %w", err)
		}
		body.Reader = decoder
		body.closers = append(body.closers, decoder.Close)
	case "deflate":
		return body.addDeflateDecoder()
	case "br":
		body.Reader = brotli.NewReader(body.Reader)
	case "zstd":
		decoder, err := zstd.NewReader(body.Reader, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return fmt.Errorf("initialize zstd decoder: %w", err)
		}
		body.Reader = decoder
		body.closers = append(body.closers, func() error { decoder.Close(); return nil })
	default:
		return fmt.Errorf("unsupported content encoding %q", encoding)
	}
	return nil
}

func (body *decodedBody) addDeflateDecoder() error {
	buffered := bufio.NewReader(body.Reader)
	header, err := buffered.Peek(2)
	if err != nil {
		return fmt.Errorf("inspect deflate header: %w", err)
	}
	if header[0]&0x0f == 8 && (uint16(header[0])<<8|uint16(header[1]))%31 == 0 {
		decoder, decodeErr := zlib.NewReader(buffered)
		if decodeErr != nil {
			return fmt.Errorf("initialize zlib decoder: %w", decodeErr)
		}
		body.Reader = decoder
		body.closers = append(body.closers, decoder.Close)
		return nil
	}
	decoder := flate.NewReader(buffered)
	body.Reader = decoder
	body.closers = append(body.closers, decoder.Close)
	return nil
}

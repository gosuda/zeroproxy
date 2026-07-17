package httppersona

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/hpack"
)

type wireObservation struct {
	preface       string
	settings      []http2.Setting
	flow          uint32
	pseudoHeader  []string
	regularHeader []string
}

func TestRoundTripMatchesChrome149HTTP2WireProfile(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()

	observations := make(chan wireObservation, 1)
	serverErrors := make(chan error, 1)
	go func() {
		serverConn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErrors <- acceptErr
			return
		}
		defer func() { _ = serverConn.Close() }()
		serveOneResponse(serverConn, observations, serverErrors)
	}()

	clientConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = clientConn.Close() }()

	request, err := http.NewRequest(http.MethodGet, "https://example.test/path?q=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "example.test"
	headers := [][2]string{
		{"X-Third", "3"},
		{"Accept", "text/html"},
		{"User-Agent", "Chrome/149"},
		{"Accept-Encoding", "gzip, deflate, br, zstd"},
		{"X-First", "1"},
	}
	for _, header := range headers {
		request.Header.Add(header[0], header[1])
	}
	response, err := RoundTrip(clientConn, request, headers)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent || response.Header.Get("X-Wire-Oracle") != "passed" {
		t.Fatalf("unexpected response: status=%d headers=%v", response.StatusCode, response.Header)
	}
	if response.Request != request {
		t.Fatal("response request identity was not preserved")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-serverErrors:
		t.Fatal(err)
	case observation := <-observations:
		assertChrome149Observation(t, observation)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for HTTP/2 wire observation")
	}
}

func TestHTTP2CompressionIsDecodedExactlyOnce(t *testing.T) {
	plaintext := []byte("compressed target response")
	compressed := encodeBrotli(t, plaintext)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	done := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer func() { _ = conn.Close() }()
		done <- serveCompressedResponse(conn, compressed)
	}()
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	request, err := http.NewRequest(http.MethodGet, "https://example.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	headers := ApplyChrome149Headers(request, [][2]string{{"Accept", "text/html"}})
	request.Header.Set("Accept", "text/html")
	response, err := RoundTrip(conn, request, headers)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Content-Encoding") != "br" {
		t.Fatalf("transport decoded or discarded content encoding before kernel policy: %v", response.Header)
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
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func serveCompressedResponse(conn net.Conn, compressed []byte) error {
	_, streamID, err := observeRequest(conn)
	if err != nil {
		return err
	}
	framer := http2.NewFramer(conn, conn)
	if err := framer.WriteSettings(); err != nil {
		return err
	}
	if err := framer.WriteSettingsAck(); err != nil {
		return err
	}
	var block bytes.Buffer
	encoder := hpack.NewEncoder(&block)
	fields := []hpack.HeaderField{
		{Name: ":status", Value: "200"},
		{Name: "content-encoding", Value: "br"},
		{Name: "content-length", Value: fmt.Sprint(len(compressed))},
	}
	for _, field := range fields {
		if err := encoder.WriteField(field); err != nil {
			return err
		}
	}
	if err := framer.WriteHeaders(http2.HeadersFrameParam{StreamID: streamID, BlockFragment: block.Bytes(), EndHeaders: true}); err != nil {
		return err
	}
	return framer.WriteData(streamID, true, compressed)
}

func serveOneResponse(conn net.Conn, observations chan<- wireObservation, errors chan<- error) {
	observation, streamID, err := observeRequest(conn)
	if err != nil {
		errors <- err
		return
	}
	framer := http2.NewFramer(conn, conn)
	if err := framer.WriteSettings(); err != nil {
		errors <- err
		return
	}
	if err := framer.WriteSettingsAck(); err != nil {
		errors <- err
		return
	}
	var block bytes.Buffer
	encoder := hpack.NewEncoder(&block)
	for _, field := range []hpack.HeaderField{{Name: ":status", Value: "204"}, {Name: "x-wire-oracle", Value: "passed"}} {
		if err := encoder.WriteField(field); err != nil {
			errors <- err
			return
		}
	}
	if err := framer.WriteHeaders(http2.HeadersFrameParam{StreamID: streamID, BlockFragment: block.Bytes(), EndHeaders: true, EndStream: true}); err != nil {
		errors <- err
		return
	}
	observations <- observation
}

func observeRequest(conn net.Conn) (wireObservation, uint32, error) {
	preface := make([]byte, len(http2.ClientPreface))
	if _, err := io.ReadFull(conn, preface); err != nil {
		return wireObservation{}, 0, err
	}
	observation := wireObservation{preface: string(preface)}
	framer := http2.NewFramer(conn, conn)
	for {
		frame, err := framer.ReadFrame()
		if err != nil {
			return wireObservation{}, 0, err
		}
		switch frame := frame.(type) {
		case *http2.SettingsFrame:
			if err := frame.ForeachSetting(func(setting http2.Setting) error {
				observation.settings = append(observation.settings, setting)
				return nil
			}); err != nil {
				return wireObservation{}, 0, err
			}
		case *http2.WindowUpdateFrame:
			if frame.StreamID == 0 {
				observation.flow = frame.Increment
			}
		case *http2.HeadersFrame:
			decoder := hpack.NewDecoder(4096, func(field hpack.HeaderField) {
				if len(field.Name) > 0 && field.Name[0] == ':' {
					observation.pseudoHeader = append(observation.pseudoHeader, field.Name)
					return
				}
				observation.regularHeader = append(observation.regularHeader, field.Name)
			})
			if _, err := decoder.Write(frame.HeaderBlockFragment()); err != nil {
				return wireObservation{}, 0, err
			}
			return observation, frame.StreamID, nil
		}
	}
}

func assertChrome149Observation(t *testing.T, observation wireObservation) {
	t.Helper()
	if observation.preface != http2.ClientPreface {
		t.Fatalf("unexpected client preface %q", observation.preface)
	}
	wantSettings := []http2.Setting{
		{ID: http2.SettingHeaderTableSize, Val: chromeHeaderTableSize},
		{ID: http2.SettingEnablePush, Val: 0},
		{ID: http2.SettingInitialWindowSize, Val: chromeInitialWindowSize},
		{ID: http2.SettingMaxHeaderListSize, Val: chromeMaxHeaderListSize},
	}
	if !reflect.DeepEqual(observation.settings, wantSettings) {
		t.Fatalf("unexpected SETTINGS: got %v want %v", observation.settings, wantSettings)
	}
	if observation.flow != chromeConnectionFlow {
		t.Fatalf("unexpected connection WINDOW_UPDATE: got %d want %d", observation.flow, chromeConnectionFlow)
	}
	wantPseudoHeaders := []string{":method", ":authority", ":scheme", ":path"}
	if !reflect.DeepEqual(observation.pseudoHeader, wantPseudoHeaders) {
		t.Fatalf("unexpected pseudo-header order: got %v want %v", observation.pseudoHeader, wantPseudoHeaders)
	}
	wantRegularHeaders := []string{"user-agent", "accept", "accept-encoding", "x-third", "x-first"}
	if !reflect.DeepEqual(observation.regularHeader, wantRegularHeaders) {
		t.Fatalf("unexpected regular-header order: got %v want %v", observation.regularHeader, wantRegularHeaders)
	}
}

func TestWriteHTTP1UsesChromeHeaderOrderWithoutConnectionClose(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://example.test/path?q=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	headers := [][2]string{
		{"X-Third", "3"},
		{"Accept", "text/html"},
		{"User-Agent", "forged"},
		{"Accept-Encoding", "gzip, deflate, br, zstd"},
		{"X-First", "1"},
	}
	for _, header := range headers {
		request.Header.Add(header[0], header[1])
	}
	wireHeaders := ApplyChrome149Headers(request, headers)
	var wire bytes.Buffer
	if err := WriteHTTP1(&wire, request, wireHeaders); err != nil {
		t.Fatal(err)
	}
	payload := wire.String()
	if strings.Contains(strings.ToLower(payload), "\r\nconnection: close\r\n") {
		t.Fatalf("HTTP/1.1 persona leaked single-use connection policy: %q", payload)
	}
	orderedLines := []string{
		"\r\nSec-Ch-Ua: " + chrome149SecCHUA + "\r\n",
		"\r\nSec-Ch-Ua-Mobile: " + chrome149SecCHMobile + "\r\n",
		"\r\nSec-Ch-Ua-Platform: " + chrome149SecCHPlatform + "\r\n",
		"\r\nUser-Agent: " + chrome149UserAgent + "\r\n",
		"\r\nAccept: text/html\r\n",
		"\r\nAccept-Encoding: gzip, deflate, br, zstd\r\n",
		"\r\nAccept-Language: " + chrome149AcceptLanguage + "\r\n",
		"\r\nX-Third: 3\r\n",
		"\r\nX-First: 1\r\n",
	}
	previous := -1
	for _, line := range orderedLines {
		index := strings.Index(payload, line)
		if index <= previous {
			t.Fatalf("unexpected HTTP/1.1 header order in %q", payload)
		}
		previous = index
	}
}

func TestWriteHTTP1OrdersKernelOwnedFetchSiteWhenInputIsOmittedOrForged(t *testing.T) {
	for _, test := range []struct {
		name    string
		headers [][2]string
	}{
		{name: "omitted", headers: [][2]string{{"Accept", "text/html"}, {"Accept-Encoding", "forged"}}},
		{name: "forged", headers: [][2]string{{"Accept", "text/html"}, {"Sec-Fetch-Site", "forged"}, {"Accept-Encoding", "forged"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, "https://example.test/resource", nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, header := range test.headers {
				request.Header.Add(header[0], header[1])
			}
			if _, err := ApplyFetchSiteHeader(request, "https://source.test/document", ""); err != nil {
				t.Fatal(err)
			}
			wireHeaders := ApplyChrome149Headers(request, test.headers)
			var wire bytes.Buffer
			if err := WriteHTTP1(&wire, request, wireHeaders); err != nil {
				t.Fatal(err)
			}
			payload := wire.String()
			fetchSiteLine := "\r\nSec-Fetch-Site: cross-site\r\n"
			if strings.Count(payload, fetchSiteLine) != 1 || strings.Contains(payload, "Sec-Fetch-Site: forged") {
				t.Fatalf("kernel-owned Fetch Site header was not replaced exactly once: %q", payload)
			}
			acceptIndex := strings.Index(payload, "\r\nAccept: text/html\r\n")
			fetchSiteIndex := strings.Index(payload, fetchSiteLine)
			encodingIndex := strings.Index(payload, "\r\nAccept-Encoding: "+chrome149AcceptEncoding+"\r\n")
			if acceptIndex < 0 || acceptIndex >= fetchSiteIndex || fetchSiteIndex >= encodingIndex {
				t.Fatalf("unexpected Fetch Site header order in %q", payload)
			}
		})
	}
}

func TestRangeRequestUsesIdentityEncoding(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://example.test/archive", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=10-19")
	headers := ApplyChrome149Headers(request, [][2]string{{"Range", "bytes=10-19"}})
	var wire bytes.Buffer
	if err := WriteHTTP1(&wire, request, headers); err != nil {
		t.Fatal(err)
	}
	if payload := wire.String(); !strings.Contains(payload, "\r\nAccept-Encoding: identity\r\n") ||
		strings.Contains(payload, "\r\nAccept-Encoding: "+chrome149AcceptEncoding+"\r\n") {
		t.Fatalf("range request encoding = %q", payload)
	}
}

func TestForkRequestPreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://example.test/", bytes.NewReader([]byte("body")))
	if err != nil {
		t.Fatal(err)
	}
	forkRequest := toForkRequest(request, nil)
	cancel()
	select {
	case <-forkRequest.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("fork request did not preserve cancellation")
	}
}

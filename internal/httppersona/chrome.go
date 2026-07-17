package httppersona

import (
	"io"
	"net"
	"net/http"
	"slices"
	"strings"

	fhttp "github.com/bogdanfinn/fhttp"
	fhttp2 "github.com/bogdanfinn/fhttp/http2"
)

const (
	chromeHeaderTableSize   = 65536
	chromeInitialWindowSize = 6291456
	chromeMaxHeaderListSize = 262144
	chromeConnectionFlow    = 15663105
)

const (
	chrome149UserAgent      = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
	chrome149AcceptEncoding = "gzip, deflate, br, zstd"
	chrome149AcceptLanguage = "en-US,en;q=0.9"
	chrome149SecCHUA        = `"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"`
	chrome149SecCHMobile    = "?0"
	chrome149SecCHPlatform  = `"macOS"`
)

var chromeNavigationHeaderOrder = []string{
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"upgrade-insecure-requests",
	"user-agent",
	"accept",
	"sec-fetch-site",
	"sec-fetch-mode",
	"sec-fetch-user",
	"sec-fetch-dest",
	"accept-encoding",
	"accept-language",
	"priority",
}

// ApplyChrome149Headers replaces network-stack-owned fields and returns the
// complete ordering input for the wire serializer.
func ApplyChrome149Headers(request *http.Request, source [][2]string) [][2]string {
	ordered := make([][2]string, 0, len(source)+7)
	ordered = append(ordered, source...)
	if requestSite := request.Header.Get("Sec-Fetch-Site"); requestSite != "" {
		ordered = append(ordered, [2]string{"Sec-Fetch-Site", requestSite})
	}
	ordered = setPersonaHeader(request, ordered, "User-Agent", chrome149UserAgent)
	if request.URL.Scheme == "https" {
		ordered = setPersonaHeader(request, ordered, "Sec-CH-UA", chrome149SecCHUA)
		ordered = setPersonaHeader(request, ordered, "Sec-CH-UA-Mobile", chrome149SecCHMobile)
		ordered = setPersonaHeader(request, ordered, "Sec-CH-UA-Platform", chrome149SecCHPlatform)
	}
	acceptEncoding := chrome149AcceptEncoding
	if request.Header.Get("Range") != "" {
		acceptEncoding = "identity"
	}
	ordered = setPersonaHeader(request, ordered, "Accept-Encoding", acceptEncoding)
	ordered = setPersonaHeader(request, ordered, "Accept-Language", chrome149AcceptLanguage)
	return ordered
}

func setPersonaHeader(request *http.Request, ordered [][2]string, name, value string) [][2]string {
	request.Header.Set(name, value)
	return append(ordered, [2]string{name, value})
}

// WriteHTTP1 serializes request with deterministic Chrome header ordering.
func WriteHTTP1(writer io.Writer, request *http.Request, headerOrder [][2]string) error {
	return toForkRequest(request, headerOrder).Write(writer)
}

type HTTP2Client struct {
	conn *fhttp2.ClientConn
}

func NewHTTP2Client(conn net.Conn) (*HTTP2Client, error) {
	client, err := chromeTransport().NewClientConn(conn)
	if err != nil {
		return nil, err
	}
	return &HTTP2Client{conn: client}, nil
}

func (client *HTTP2Client) RoundTrip(request *http.Request, headerOrder [][2]string) (*http.Response, error) {
	response, err := client.conn.RoundTrip(toForkRequest(request, headerOrder))
	if err != nil {
		return nil, err
	}
	return toStandardResponse(response, request), nil
}

func (client *HTTP2Client) CanTakeNewRequest() bool {
	return client.conn.CanTakeNewRequest()
}

func (client *HTTP2Client) Close() error {
	return client.conn.Close()
}

// RoundTrip sends request over an already-negotiated HTTP/2 connection using
// the HTTP/2 wire profile emitted by the supported Chrome 149 client.
func RoundTrip(conn net.Conn, request *http.Request, headerOrder [][2]string) (*http.Response, error) {
	client, err := NewHTTP2Client(conn)
	if err != nil {
		return nil, err
	}
	return client.RoundTrip(request, headerOrder)
}

func chromeTransport() *fhttp2.Transport {
	return &fhttp2.Transport{
		ConnectionFlow:     chromeConnectionFlow,
		DisableCompression: true,
		Settings: map[fhttp2.SettingID]uint32{
			fhttp2.SettingHeaderTableSize:   chromeHeaderTableSize,
			fhttp2.SettingEnablePush:        0,
			fhttp2.SettingInitialWindowSize: chromeInitialWindowSize,
			fhttp2.SettingMaxHeaderListSize: chromeMaxHeaderListSize,
		},
		SettingsOrder: []fhttp2.SettingID{
			fhttp2.SettingHeaderTableSize,
			fhttp2.SettingEnablePush,
			fhttp2.SettingInitialWindowSize,
			fhttp2.SettingMaxHeaderListSize,
		},
		PseudoHeaderOrder: []string{
			":method",
			":authority",
			":scheme",
			":path",
		},
	}
}

func toForkRequest(request *http.Request, headers [][2]string) *fhttp.Request {
	forkHeader := fhttp.Header(request.Header.Clone())
	forkHeader[fhttp.HeaderOrderKey] = orderedHeaderNames(headers)
	forkRequest := &fhttp.Request{
		Method:           request.Method,
		URL:              request.URL,
		Header:           forkHeader,
		Body:             request.Body,
		GetBody:          request.GetBody,
		ContentLength:    request.ContentLength,
		TransferEncoding: append([]string(nil), request.TransferEncoding...),
		Close:            request.Close,
		Host:             request.Host,
		Trailer:          fhttp.Header(request.Trailer.Clone()),
	}
	return forkRequest.WithContext(request.Context())
}

func orderedHeaderNames(headers [][2]string) []string {
	names := make([]string, 0, len(headers))
	for _, preferred := range chromeNavigationHeaderOrder {
		for _, header := range headers {
			if strings.EqualFold(header[0], preferred) {
				names = append(names, preferred)
				break
			}
		}
	}
	for _, header := range headers {
		name := strings.ToLower(header[0])
		if !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	return names
}

func toStandardResponse(response *fhttp.Response, request *http.Request) *http.Response {
	return &http.Response{
		Status:           response.Status,
		StatusCode:       response.StatusCode,
		Proto:            response.Proto,
		ProtoMajor:       response.ProtoMajor,
		ProtoMinor:       response.ProtoMinor,
		Header:           http.Header(response.Header),
		Body:             response.Body,
		ContentLength:    response.ContentLength,
		TransferEncoding: response.TransferEncoding,
		Close:            response.Close,
		Uncompressed:     response.Uncompressed,
		Trailer:          http.Header(response.Trailer),
		Request:          request,
	}
}

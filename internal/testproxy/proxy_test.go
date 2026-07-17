package testproxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRecorderForwardsAllowedHTTPWithoutProxyCredentials(t *testing.T) {
	t.Parallel()
	seenProxyAuthorization := ""
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seenProxyAuthorization = request.Header.Get("Proxy-Authorization")
		response.Header().Set("Content-Type", "text/plain")
		_, _ = response.Write([]byte("allowed"))
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	allowedEndpoint := "control.localhost:" + upstreamURL.Port()

	var evidence bytes.Buffer
	recorder, err := New([]string{allowedEndpoint}, &evidence)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.CloseIdleConnections()
	proxy := httptest.NewServer(recorder)
	defer proxy.Close()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	request, err := http.NewRequest(http.MethodGet, "http://"+allowedEndpoint+"/private/path?secret=not-recorded", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Proxy-Authorization", "Basic secret")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if response.StatusCode != http.StatusOK || string(body) != "allowed" || seenProxyAuthorization != "" {
		t.Fatalf("unexpected forwarded response status=%d body=%q proxy-auth=%q", response.StatusCode, body, seenProxyAuthorization)
	}
	var event Event
	if err := json.NewDecoder(&evidence).Decode(&event); err != nil {
		t.Fatal(err)
	}
	if event.Method != http.MethodGet || !event.Allowed || event.Destination == "" {
		t.Fatalf("unexpected event: %+v", event)
	}
	if bytes.Contains(evidence.Bytes(), []byte("private")) || bytes.Contains(evidence.Bytes(), []byte("secret")) {
		t.Fatalf("event evidence leaked request details: %s", evidence.Bytes())
	}
}

func TestRecorderTunnelsAllowedTLSAndDeniesUnknownHost(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte("tunneled"))
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	allowedEndpoint := "relay.localhost:" + upstreamURL.Port()

	var evidence bytes.Buffer
	recorder, err := New([]string{allowedEndpoint}, &evidence)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.CloseIdleConnections()
	proxy := httptest.NewServer(recorder)
	defer proxy.Close()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := upstream.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	transport.Proxy = http.ProxyURL(proxyURL)
	client := &http.Client{Transport: transport}
	response, err := client.Get("https://" + allowedEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || string(body) != "tunneled" {
		t.Fatalf("unexpected tunnel body=%q read_error=%v close_error=%v", body, err, closeErr)
	}

	alternatePort := httptest.NewRequest(http.MethodConnect, "http://proxy.invalid/", nil)
	alternatePort.Host = "127.0.0.1:1"
	alternateResponse := httptest.NewRecorder()
	recorder.ServeHTTP(alternateResponse, alternatePort)
	if alternateResponse.Code != http.StatusForbidden {
		t.Fatalf("alternate port status=%d", alternateResponse.Code)
	}

	denied, err := client.Get("http://blocked.invalid/")
	if err != nil {
		t.Fatal(err)
	}
	if err := denied.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("denied status=%d", denied.StatusCode)
	}

	scanner := bufio.NewScanner(&evidence)
	var events []Event
	for scanner.Scan() {
		var event Event
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Method != http.MethodConnect || !events[0].Allowed ||
		events[1].Allowed || events[1].Destination != "127.0.0.1:1" ||
		events[2].Allowed || events[2].Destination != "blocked.invalid:80" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestNewRejectsInvalidAllowlist(t *testing.T) {
	t.Parallel()
	for _, endpoint := range []string{"", "127.0.0.1", "user@example.com:443", "bad/host:443", "bad\nheader:443", "example.com:0", "example.com:65536"} {
		if _, err := New([]string{endpoint}, io.Discard); err == nil {
			t.Fatalf("accepted invalid endpoint %q", endpoint)
		}
	}
}

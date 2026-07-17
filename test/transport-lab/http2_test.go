package transportlab

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestHTTP2LabScriptsChunkedResponse(t *testing.T) {
	lab := NewHTTP2(HTTP2Scenario{
		RequirePath: "/chunks",
		Status:      http.StatusCreated,
		Headers:     http.Header{"X-Transport-Lab": {"http2"}},
		BodyChunks:  [][]byte{[]byte("one"), []byte("-two"), []byte("-three")},
		ChunkDelay:  time.Millisecond,
	})
	if err := lab.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lab.Close(context.Background()) })

	response, err := lab.Client().Get(lab.URL() + "/chunks")
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if response.ProtoMajor != 2 {
		t.Fatalf("response protocol = %q, want HTTP/2", response.Proto)
	}
	if response.StatusCode != http.StatusCreated || response.Header.Get("X-Transport-Lab") != "http2" || string(body) != "one-two-three" {
		t.Fatalf("response = status:%d header:%q body:%q", response.StatusCode, response.Header.Get("X-Transport-Lab"), body)
	}
	requests := lab.Requests()
	if len(requests) != 1 || requests[0].URL.Path != "/chunks" || requests[0].Body != nil {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestHTTP2LabStreamsSSEAndObservesCancellation(t *testing.T) {
	lab := NewHTTP2(HTTP2Scenario{
		RequirePath: "/events",
		SSEEvents: []SSEEvent{
			{ID: "7", Event: "update", Data: "first\nsecond", Retry: 1500 * time.Millisecond},
			{Data: "complete"},
		},
		ObserveCancellation: true,
	})
	if err := lab.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lab.Close(context.Background()) })

	request, err := http.NewRequest(http.MethodGet, lab.URL()+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := lab.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.ProtoMajor != 2 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("SSE response = protocol:%q content-type:%q", response.Proto, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "id: 7\n" {
		t.Fatalf("first SSE field = (%q, %v)", line, err)
	}
	_ = response.Body.Close()

	wait, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := lab.WaitForCancellation(wait); err != nil {
		t.Fatalf("cancellation not observed: %v", err)
	}
	if lab.Cancellations() != 1 {
		t.Fatalf("cancellations = %d, want 1", lab.Cancellations())
	}
}

func TestHTTP2LabRejectsUnboundedScenario(t *testing.T) {
	chunks := make([][]byte, MaxHTTP2Chunks+1)
	lab := NewHTTP2(HTTP2Scenario{BodyChunks: chunks})
	if err := lab.Start(); err == nil {
		t.Fatal("Start accepted an over-limit response")
	}
}

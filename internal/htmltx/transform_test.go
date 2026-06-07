package htmltx

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestTransformDelegatesWholeDocumentToRustHook(t *testing.T) {
	target, err := url.Parse("https://example.com/app/")
	if err != nil {
		t.Fatal(err)
	}
	called := false
	out, err := Transform(strings.NewReader(`<html><body>raw</body></html>`), Options{
		TabID:        "tab-1",
		EntryID:      "entry-1",
		TargetURL:    target,
		RuntimeToken: "rt-1",
		Servers:      []string{"wss://relay.example/ws"},
		DocumentRewriter: func(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers []string) (string, error) {
			called = true
			if source != `<html><body>raw</body></html>` {
				t.Fatalf("unexpected source: %q", source)
			}
			if targetURL != "https://example.com/app/" {
				t.Fatalf("unexpected target URL: %q", targetURL)
			}
			if controlPrefix != "/zp/" {
				t.Fatalf("unexpected control prefix: %q", controlPrefix)
			}
			if !strings.Contains(runtimePrelude, "runtime-prelude.js") {
				t.Fatalf("runtime prelude was not passed: %q", runtimePrelude)
			}
			if tabID != "tab-1" || runtimeToken != "rt-1" {
				t.Fatalf("unexpected runtime context tab=%q rt=%q", tabID, runtimeToken)
			}
			if len(servers) != 1 || servers[0] != "wss://relay.example/ws" {
				t.Fatalf("unexpected servers: %#v", servers)
			}
			return `<html><body>rust</body></html>`, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("document rewriter hook was not called")
	}
	if string(out) != `<html><body>rust</body></html>` {
		t.Fatalf("unexpected delegated output: %s", out)
	}
}

type scriptedStreamRewriter struct {
	writes int
}

func (s *scriptedStreamRewriter) WriteChunk(chunk []byte) ([]byte, error) {
	s.writes++
	if s.writes == 1 && len(chunk) > 0 {
		return []byte("first-byte:"), nil
	}
	return nil, nil
}

func (s *scriptedStreamRewriter) End() ([]byte, error) {
	return []byte("end"), nil
}

func TestTransformStreamFlushesBeforeInputEOF(t *testing.T) {
	target, err := url.Parse("https://example.com/app/")
	if err != nil {
		t.Fatal(err)
	}
	inputR, inputW := io.Pipe()
	outputR, outputW := io.Pipe()
	errs := make(chan error, 1)
	go func() {
		errs <- TransformTo(outputW, inputR, Options{
			TargetURL: target,
			DocumentStreamRewriter: func(targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers []string) (DocumentStreamRewriter, error) {
				if targetURL != "https://example.com/app/" || controlPrefix != "/zp/" {
					return nil, fmt.Errorf("unexpected stream context target=%q prefix=%q", targetURL, controlPrefix)
				}
				if !strings.Contains(runtimePrelude, "runtime-prelude.js") {
					return nil, fmt.Errorf("runtime prelude was not passed: %q", runtimePrelude)
				}
				return &scriptedStreamRewriter{}, nil
			},
		})
		_ = outputW.Close()
	}()
	first := make(chan string, 1)
	go func() {
		buf := make([]byte, len("first-byte:"))
		n, _ := io.ReadFull(outputR, buf)
		first <- string(buf[:n])
	}()
	if _, err := inputW.Write([]byte("<html><body>")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-first:
		if got != "first-byte:" {
			t.Fatalf("first output = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("streaming transform did not flush before input EOF")
	}
	_ = inputW.Close()
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, outputR)
		close(drained)
	}()
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	<-drained
}

func TestTransformRequiresRustDocumentRewriter(t *testing.T) {
	target, err := url.Parse("https://example.com/app/")
	if err != nil {
		t.Fatal(err)
	}
	_, err = Transform(strings.NewReader(`<body>raw</body>`), Options{TargetURL: target})
	if !errors.Is(err, ErrMalformedHTML) {
		t.Fatalf("Transform error = %v, want ErrMalformedHTML", err)
	}
}

func TestRuntimePreludeIsSingleRuntimeAsset(t *testing.T) {
	target, err := url.Parse(`https://example.com/path?q="</script><script>evil()</script>&x=1`)
	if err != nil {
		t.Fatal(err)
	}
	prelude := runtimePrelude(Options{
		TabID:          `tab"</script><script>evil()</script>`,
		EntryID:        "entry",
		TargetURL:      target,
		DocumentCookie: `a="</script>`,
		RuntimeToken:   "rt",
	})
	if !strings.Contains(prelude, "runtime-prelude.js") {
		t.Fatalf("missing runtime prelude asset: %s", prelude)
	}
	if strings.Contains(prelude, "zp-core.js") || strings.Contains(prelude, "http-rewriter.js") {
		t.Fatalf("unexpected multi-asset injection: %s", prelude)
	}
	if strings.Contains(prelude, `</script><script>evil()`) {
		t.Fatalf("boot JSON was not script-safe: %s", prelude)
	}
}

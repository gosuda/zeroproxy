package htmltx

import (
	"bytes"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"
)

type firstWriteTimer struct {
	w     io.Writer
	start time.Time
	first time.Duration
}

func (w *firstWriteTimer) Write(p []byte) (int, error) {
	if len(p) > 0 && w.first == 0 {
		w.first = time.Since(w.start)
	}
	return w.w.Write(p)
}

func TestTransformLatencyStaysWithinCoarseBudgets(t *testing.T) {
	target, _ := url.Parse("https://example.com/app/page.html")
	cases := []struct {
		name        string
		rows        int
		firstBudget time.Duration
		totalBudget time.Duration
	}{
		{name: "small", rows: 8, firstBudget: 250 * time.Millisecond, totalBudget: 500 * time.Millisecond},
		{name: "medium", rows: 128, firstBudget: 500 * time.Millisecond, totalBudget: time.Second},
		{name: "large", rows: 512, firstBudget: 750 * time.Millisecond, totalBudget: 2 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			writer := &firstWriteTimer{w: &out, start: time.Now()}
			start := writer.start
			err := TransformTo(writer, strings.NewReader(generatedHTMLTransformSource(tc.rows)), Options{
				TabID:     "tab",
				EntryID:   "entry",
				TargetURL: target,
				ScriptRewriter: func(source, kind, targetURL, controlPrefix string) (string, error) {
					return source, nil
				},
				CSSRewriter: func(source, baseURL string) (string, error) {
					return source, nil
				},
				ImportMapRewriter: func(source, baseURL, tabID, runtimeToken, controlPrefix string) (string, error) {
					return source, nil
				},
			})
			total := time.Since(start)
			if err != nil {
				t.Fatal(err)
			}
			if writer.first == 0 {
				t.Fatal("TransformTo did not write output")
			}
			assertHTMLTransformWithinBudget(t, "first-write", writer.first, tc.firstBudget)
			assertHTMLTransformWithinBudget(t, "total", total, tc.totalBudget)
		})
	}
}

func generatedHTMLTransformSource(rows int) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><base href="/base/"><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><link rel="preconnect" href="https://cdn.example"><style>body{background:url('/bg.png')}</style><script type="importmap">{"imports":{"app":"/app.js"}}</script></head><body onload="location.href='/boot'">`)
	for i := 0; i < rows; i++ {
		b.WriteString(`<a href="/next?i=`)
		b.WriteString(string(rune('0' + (i % 10))))
		b.WriteString(`" ping="https://ping.example/p">n</a><img src="/img.png" srcset="/img-small.png 1x, /img-large.png 2x"><form action="/submit"><button formaction="/alt" onclick="return location.href">go</button></form><iframe src="/child" srcdoc="<script>location.href='/srcdoc'</script>"></iframe><script>window.location.href='/inline'</script><script type="module">import('/mod.js')</script>`)
	}
	b.WriteString(`</body></html>`)
	return b.String()
}

func assertHTMLTransformWithinBudget(t *testing.T, name string, elapsed, budget time.Duration) {
	t.Helper()
	if elapsed > budget {
		t.Fatalf("%s transform latency %s exceeded budget %s", name, elapsed, budget)
	}
}

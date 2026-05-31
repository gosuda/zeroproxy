package htmltx

import (
	"bytes"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"
)

// errAfterReader yields the wrapped reader's bytes, then turns the terminal EOF
// into a non-EOF error -- modeling a target server dropping the connection
// mid-stream (the realistic source of a tokenizer non-EOF error, since
// x/net/html recovers from malformed markup at the token level).
type errAfterReader struct{ r io.Reader }

func (e *errAfterReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err == io.EOF {
		return n, errors.New("simulated mid-stream connection drop")
	}
	return n, err
}

// TestTransformToPartialFlushNeverLeaksRawActiveContent pins the fail-degraded
// (NOT fail-open) contract of the streaming transform. TransformTo writes
// through a 4096-byte bufio.Writer, so on a document larger than the buffer the
// writer auto-flushes partial output to w BEFORE a mid-stream tokenizer error
// returns ErrMalformedHTML (the final Flush is skipped on that path). That
// partial flush is safe ONLY because rewriting is synchronous per token: a token
// is rewritten before it is ever written, so raw target script can never reach w
// un-rewritten -- truncation drops the tail, it never leaks active content.
//
// A regression that buffered raw tokens, or wrote-then-rewrote, would let a
// malicious target stream active script and cut the connection to surface it
// past the membrane. This test is the net for that.
func TestTransformToPartialFlushNeverLeaksRawActiveContent(t *testing.T) {
	u, _ := url.Parse("https://target.example/")
	const marker = "__ZP_RAW_ACTIVE_MARKER__"
	var b strings.Builder
	b.WriteString("<html><head></head><body>")
	// >4096 bytes of padding so the bufio.Writer auto-flushes before the error.
	b.WriteString(strings.Repeat("<p>padding padding padding padding</p>", 200))
	b.WriteString("<script>window." + marker + "=1</script>")
	b.WriteString(strings.Repeat("<p>tail</p>", 50))

	var w bytes.Buffer
	err := TransformTo(&w, &errAfterReader{r: strings.NewReader(b.String())}, Options{TargetURL: u})

	// The mid-stream error must surface as a fail-closed MALFORMED_HTML.
	if !errors.Is(err, ErrMalformedHTML) {
		t.Fatalf("mid-stream reader error must return ErrMalformedHTML, got %v", err)
	}
	// Partial content reaches w (this is the precondition the safety rests on; if
	// it ever stops being true the test is still valid, just trivially).
	out := w.String()
	if w.Len() == 0 {
		t.Skip("no partial flush observed; invariant holds trivially")
	}
	// THE INVARIANT: the raw inline script body must never appear in the output,
	// truncated or not -- it is neutralized by the token-level rewrite.
	if strings.Contains(out, marker) {
		t.Fatalf("raw active script leaked into partial transform output (membrane escape on truncation): %q", out)
	}
	// Any <script> the transform DOES emit must be the membrane's own nonce-gated
	// prelude (CSP allows only 'nonce-zp'); a bare <script> without the nonce would
	// be an un-gated injection point.
	for rest := out; ; {
		i := strings.Index(rest, "<script")
		if i < 0 {
			break
		}
		tagEnd := strings.IndexByte(rest[i:], '>')
		if tagEnd < 0 {
			break
		}
		// The rewriter emits the nonce both quoted (nonce="zp") and unquoted
		// (nonce=zp); normalize quotes before checking presence.
		tag := strings.ReplaceAll(rest[i:i+tagEnd], `"`, "")
		if !strings.Contains(tag, "nonce=zp") {
			t.Fatalf("emitted a <script> without the membrane nonce (un-gated): %q", tag)
		}
		rest = rest[i+tagEnd:]
	}
}

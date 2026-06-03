package randbuf

import (
	"bufio"
	"crypto/rand"
	"io"
	"sync"
)

const defaultBufferSize = 32 * 1024

// Reader amortizes small crypto/rand reads, such as WebSocket frame masks, while
// preserving an io.Reader seam for deterministic tests that inject their own RNG.
var Reader io.Reader = &lockedReader{r: bufio.NewReaderSize(rand.Reader, defaultBufferSize)}

func ReadFull(p []byte) error {
	_, err := io.ReadFull(Reader, p)
	return err
}

type lockedReader struct {
	mu sync.Mutex
	r  *bufio.Reader
}

func (r *lockedReader) Read(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.r.Read(p)
}

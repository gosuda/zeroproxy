package transportlab

import (
	"context"
	"io"
	"testing"
	"time"
)

const smuxFixtureTimeout = time.Second

func startSMUXFixture(t *testing.T) *SMUXLab {
	t.Helper()
	lab := NewSMUX()
	t.Cleanup(func() {
		if err := lab.Close(); err != nil {
			t.Error(err)
		}
	})
	return lab
}

func waitSMUXIdle(t *testing.T, lab *SMUXLab) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), smuxFixtureTimeout)
	defer cancel()
	if err := lab.WaitForIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if err := lab.AssertNoLeaks(); err != nil {
		t.Fatal(err)
	}
}

func TestSMUXLoopbackEchoAndCleanup(t *testing.T) {
	lab := startSMUXFixture(t)
	client, err := lab.OpenClient()
	if err != nil {
		t.Fatal(err)
	}

	stream, err := client.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("smux loopback")
	if _, err := stream.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(stream, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo = %q, want %q", got, payload)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	waitSMUXIdle(t, lab)
	stats := lab.Stats()
	if stats.OpenedSessions != 1 || stats.ClosedSessions != 1 || stats.OpenedStreams != 1 || stats.ClosedStreams != 1 {
		t.Fatalf("smux accounting = %#v", stats)
	}
}

func TestSMUXRejectsMalformedAndTruncatedPeers(t *testing.T) {
	tests := []struct {
		name  string
		frame []byte
	}{
		{name: "malformed-version", frame: []byte{2, 0, 0, 0, 0, 0, 0, 0}},
		{name: "truncated-header", frame: []byte{1, 0, 0}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			lab := startSMUXFixture(t)
			peer, err := lab.OpenRawPeer()
			if err != nil {
				t.Fatal(err)
			}
			if err := peer.SetDeadline(time.Now().Add(smuxFixtureTimeout)); err != nil {
				t.Fatal(err)
			}
			if _, err := peer.Write(test.frame); err != nil {
				t.Fatal(err)
			}
			if err := peer.Close(); err != nil {
				t.Fatal(err)
			}

			waitSMUXIdle(t, lab)
			stats := lab.Stats()
			if stats.TerminalErrors != 1 || stats.ClosedSessions != 1 {
				t.Fatalf("peer rejection accounting = %#v", stats)
			}
		})
	}
}

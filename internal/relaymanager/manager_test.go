package relaymanager

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeEngine struct {
	closed atomic.Int32
}

func (e *fakeEngine) Close() error {
	e.closed.Add(1)
	return nil
}

func candidate(id string, marker byte) Candidate {
	var digest [32]byte
	digest[0] = marker
	return Candidate{ProfileID: id, Digest: digest}
}

func deterministicConfig(now *time.Time) Config {
	return Config{
		MaxCandidates: 8,
		MaxHotIdle:    2,
		IdleTimeout:   time.Hour,
		BackoffBase:   time.Second,
		BackoffMax:    8 * time.Second,
		Now:           func() time.Time { return *now },
		Jitter:        func(maximum time.Duration) time.Duration { return maximum },
	}
}

func TestConcurrentAcquireSingleflightsDial(t *testing.T) {
	now := time.Unix(100, 0)
	engine := &fakeEngine{}
	started := make(chan struct{})
	unblock := make(chan struct{})
	var calls atomic.Int32
	manager, err := New([]Candidate{candidate("a", 1)}, func(context.Context, Candidate) (Engine, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-unblock
		return engine, nil
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	const count = 16
	leases := make(chan *Lease, count)
	errorsSeen := make(chan error, count)
	var group sync.WaitGroup
	for range count {
		group.Add(1)
		go func() {
			defer group.Done()
			lease, acquireErr := manager.Acquire(context.Background())
			if acquireErr != nil {
				errorsSeen <- acquireErr
				return
			}
			leases <- lease
		}()
	}
	<-started
	close(unblock)
	group.Wait()
	close(errorsSeen)
	for acquireErr := range errorsSeen {
		t.Fatalf("Acquire: %v", acquireErr)
	}
	if calls.Load() != 1 {
		t.Fatalf("dial calls = %d, want 1", calls.Load())
	}
	close(leases)
	for lease := range leases {
		if lease.Engine() != engine || lease.Candidate().ProfileID != "a" {
			t.Fatal("lease changed candidate or engine")
		}
		lease.Release()
	}
}

func TestOrderedFailoverOnlyBeforeApplicationBytes(t *testing.T) {
	now := time.Unix(100, 0)
	engineB := &fakeEngine{}
	var order []string
	manager, err := New([]Candidate{candidate("a", 1), candidate("b", 2)}, func(_ context.Context, item Candidate) (Engine, error) {
		order = append(order, item.ProfileID)
		if item.ProfileID == "a" {
			return nil, errors.New("a unavailable")
		}
		return engineB, nil
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	lease, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if lease.Candidate().ProfileID != "b" {
		t.Fatalf("candidate = %q, want b", lease.Candidate().ProfileID)
	}
	if len(order) != 2 || order[0] != "a" || order[1] != "b" {
		t.Fatalf("dial order = %v", order)
	}
	lease.Release()
}

func TestUnsafeFailureIsTypedAndNeverDialsAnotherRelay(t *testing.T) {
	now := time.Unix(100, 0)
	engineA := &fakeEngine{}
	var calls atomic.Int32
	manager, err := New([]Candidate{candidate("a", 1), candidate("b", 2)}, func(_ context.Context, _ Candidate) (Engine, error) {
		calls.Add(1)
		return engineA, nil
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	lease, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	lease.MarkApplicationBytes(17)
	failure := lease.Fail(errors.New("carrier lost"))
	var terminal *TerminalRelayLoss
	if !errors.As(failure, &terminal) || terminal.Bytes != 17 || terminal.Candidate.ProfileID != "a" {
		t.Fatalf("failure = %#v", failure)
	}
	if calls.Load() != 1 {
		t.Fatalf("unexpected failover dial count %d", calls.Load())
	}
	if engineA.closed.Load() != 1 {
		t.Fatalf("failed engine closes = %d", engineA.closed.Load())
	}
}

func TestConcurrentUnsafeFailuresRemainTerminal(t *testing.T) {
	now := time.Unix(100, 0)
	engine := &fakeEngine{}
	manager, err := New([]Candidate{candidate("a", 1)}, func(context.Context, Candidate) (Engine, error) {
		return engine, nil
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })
	lease, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	lease.MarkApplicationBytes(23)

	const failures = 32
	results := make(chan error, failures)
	var group sync.WaitGroup
	for range failures {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- lease.Fail(errors.New("concurrent carrier loss"))
		}()
	}
	group.Wait()
	close(results)
	for failure := range results {
		var terminal *TerminalRelayLoss
		if !errors.As(failure, &terminal) || terminal.Bytes != 23 || terminal.Candidate.ProfileID != "a" {
			t.Fatalf("concurrent failure %T = %v", failure, failure)
		}
	}
	if engine.closed.Load() != 1 {
		t.Fatalf("failed engine closes = %d, want 1", engine.closed.Load())
	}
}

func TestCooldownUsesBoundedExponentialBackoffAndJitter(t *testing.T) {
	now := time.Unix(100, 0)
	manager, err := New([]Candidate{candidate("a", 1)}, func(context.Context, Candidate) (Engine, error) {
		return nil, errors.New("dial failed")
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	_, err = manager.Acquire(context.Background())
	var unavailable *UnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("first failure = %v", err)
	}
	if got, want := unavailable.RetryAt.Sub(now), 1250*time.Millisecond; got != want {
		t.Fatalf("first cooldown = %v, want %v", got, want)
	}
	now = unavailable.RetryAt
	_, err = manager.Acquire(context.Background())
	if !errors.As(err, &unavailable) {
		t.Fatalf("second failure = %v", err)
	}
	if got, want := unavailable.RetryAt.Sub(now), 2500*time.Millisecond; got != want {
		t.Fatalf("second cooldown = %v, want %v", got, want)
	}
}

func TestFailedEngineIsClosedAndReplacedAfterCooldown(t *testing.T) {
	now := time.Unix(100, 0)
	first := &fakeEngine{}
	second := &fakeEngine{}
	engines := []Engine{first, second}
	manager, err := New([]Candidate{candidate("a", 1)}, func(context.Context, Candidate) (Engine, error) {
		engine := engines[0]
		engines = engines[1:]
		return engine, nil
	}, deterministicConfig(&now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	lease, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := lease.Fail(errors.New("open stream failed")); got == nil {
		t.Fatal("pre-application failure must be returned")
	}
	if first.closed.Load() != 1 {
		t.Fatalf("replaced engine closes = %d", first.closed.Load())
	}
	now = manager.Health()[0].CooldownUntil
	replacement, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if replacement.Engine() != second {
		t.Fatal("replacement engine not leased")
	}
	replacement.Release()
}

func TestHotIdleCapAndIdleExpiryCloseCarriers(t *testing.T) {
	now := time.Unix(100, 0)
	engineA := &fakeEngine{}
	engineB := &fakeEngine{}
	callsA := 0
	config := deterministicConfig(&now)
	config.MaxHotIdle = 1
	manager, err := New([]Candidate{candidate("a", 1), candidate("b", 2)}, func(_ context.Context, item Candidate) (Engine, error) {
		if item.ProfileID == "a" {
			callsA++
			if callsA == 1 {
				return nil, errors.New("first a dial fails")
			}
			return engineA, nil
		}
		return engineB, nil
	}, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })

	leaseB, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	leaseB.Release()
	now = now.Add(2 * time.Second)
	leaseA, err := manager.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	leaseA.Release()
	if engineB.closed.Load() != 1 {
		t.Fatalf("oldest idle engine closes = %d", engineB.closed.Load())
	}
	if engineA.closed.Load() != 0 {
		t.Fatal("newest idle engine closed too early")
	}
	now = now.Add(time.Hour)
	manager.Sweep()
	if engineA.closed.Load() != 1 {
		t.Fatalf("expired idle engine closes = %d", engineA.closed.Load())
	}
}

func TestCandidateSetValidationIsExactAndBounded(t *testing.T) {
	now := time.Unix(100, 0)
	dial := func(context.Context, Candidate) (Engine, error) { return &fakeEngine{}, nil }
	cases := [][]Candidate{
		nil,
		{{ProfileID: "a"}},
		{candidate("a", 1), candidate("a", 2)},
		{candidate("a", 1), candidate("b", 1)},
	}
	for _, candidates := range cases {
		if manager, err := New(candidates, dial, deterministicConfig(&now)); err == nil {
			_ = manager.Close()
			t.Fatalf("accepted invalid candidates: %#v", candidates)
		}
	}
	tooMany := make([]Candidate, 9)
	for index := range tooMany {
		tooMany[index] = candidate(string(rune('a'+index)), byte(index+1))
	}
	if manager, err := New(tooMany, dial, deterministicConfig(&now)); err == nil {
		_ = manager.Close()
		t.Fatal("accepted candidate set above bound")
	}
}

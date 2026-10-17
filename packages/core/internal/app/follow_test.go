package app

import (
	"context"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// recordingClock records every poll interval; onSleep(n) runs before the n-th sleep (1-based).
type recordingClock struct {
	*fakes.ManualClock

	mu      sync.Mutex
	slept   []int64
	onSleep func(n int)
}

func (c *recordingClock) Sleep(ctx context.Context, ms int64) error {
	c.mu.Lock()
	c.slept = append(c.slept, ms)
	n := len(c.slept)
	onSleep := c.onSleep
	c.mu.Unlock()
	if onSleep != nil {
		onSleep(n)
	}
	return c.ManualClock.Sleep(ctx, ms)
}

// slept is every interval the clock was asked to wait.
func (c *recordingClock) sleptList() []int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int64{}, c.slept...)
}

// recordSleeps wires a clock that records each poll's interval into deps.
func recordSleeps(deps *Deps, onSleep func(n int)) *recordingClock {
	clock := &recordingClock{ManualClock: deps.Clock.(*fakes.ManualClock), onSleep: onSleep}
	deps.Clock = clock
	return clock
}

func TestFollowJob(t *testing.T) {
	never := context.Background()

	t.Run("polls with backoff while a live driver works the job and returns the job once it lands", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		job := w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", int64(os.Getpid()))
		clock := recordSleeps(&deps, func(n int) {
			if n == 5 {
				landed := job
				landed.State = domain.JobStateAwaitingReview
				w.store.Put(landed)
			}
		})

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedLanded || followed.Job.State != domain.JobStateAwaitingReview {
			t.Errorf("followed = %+v, want the landed job", followed)
		}
		if intervals := clock.sleptList(); !reflect.DeepEqual(intervals, []int64{1000, 2000, 4000, 5000, 5000}) {
			t.Errorf("slept = %v, want the doubling backoff capped at 5 s", intervals)
		}
	})

	t.Run("a decided job lands at once, without a single poll", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateAccepted
		}))
		clock := recordSleeps(&deps, nil)

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedLanded {
			t.Errorf("followed = %+v, want landed", followed)
		}
		if intervals := clock.sleptList(); len(intervals) != 0 {
			t.Errorf("slept = %v, want no poll", intervals)
		}
	})

	t.Run("a running job whose driver died is stale", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", 99_999)

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedStale || followed.Job.ID != "j1" || followed.Job.State != domain.JobStateRunning {
			t.Errorf("followed = %+v, want the stale running job", followed)
		}
	})

	t.Run("the driver dying mid-job turns the follow stale on the next poll", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", 4242)
		w.process.MarkAlive(4242)
		recordSleeps(&deps, func(n int) {
			if n == 2 {
				w.process.MarkDead(4242)
			}
		})

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedStale {
			t.Errorf("followed = %+v, want stale", followed)
		}
	})

	t.Run("a queued job waits for its driver to claim it, and is stale once nobody has for the grace period", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateQueued
		}))
		recordSleeps(&deps, nil)

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedStale {
			t.Errorf("followed = %+v, want stale", followed)
		}
		elapsed := w.clock.Now() - fakes.T0
		if elapsed < domain.UnclaimedGraceMs || elapsed >= domain.UnclaimedGraceMs+domain.MaxPollMs {
			t.Errorf("elapsed = %d ms, want the stale call inside the grace period + one poll", elapsed)
		}
	})

	t.Run("a queued job claimed by a driver within the grace period is followed to review", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		job := w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateQueued
		}))
		recordSleeps(&deps, func(n int) {
			if n == 3 {
				w.store.HoldLock("j1", int64(os.Getpid()))
			}
			if n == 12 {
				landed := job
				landed.State = domain.JobStateAwaitingReview
				w.store.Put(landed)
			}
		})

		followed, err := FollowJob(never, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedLanded {
			t.Errorf("followed = %+v, want landed", followed)
		}
	})

	t.Run("an aborted follow detaches and leaves the job alone", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		job := w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", int64(os.Getpid()))
		ctx, cancel := context.WithCancel(never)
		recordSleeps(&deps, func(n int) {
			if n == 2 {
				cancel()
			}
		})

		followed, err := FollowJob(ctx, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedDetached || followed.Job.ID != "j1" || followed.Job.State != domain.JobStateRunning {
			t.Errorf("followed = %+v, want the detached running job", followed)
		}
		if stored, err := w.store.Get(never, "j1"); err != nil || !reflect.DeepEqual(stored, job) {
			t.Errorf("the job was touched: %+v (%v)", stored, err)
		}
		if terminated := w.process.Terminated(); len(terminated) != 0 {
			t.Errorf("terminated = %v, want nothing", terminated)
		}
	})

	t.Run("an abort before the first poll still reads the job once and detaches", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", int64(os.Getpid()))
		ctx, cancel := context.WithCancel(never)
		cancel()

		followed, err := FollowJob(ctx, deps, "j1")

		if err != nil {
			t.Fatal(err)
		}
		if followed.Kind != FollowedDetached {
			t.Errorf("followed = %+v, want detached", followed)
		}
	})

	t.Run("an unknown id is a store not_found error; a failing sleep that was not an abort propagates", func(t *testing.T) {
		deps, _ := newWorld(t, nil)

		_, err := FollowJob(never, deps, "nope")
		want := &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorNotFound, ID: "nope",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Errorf("error = %+v, want not_found nope", err)
		}

		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		w.store.HoldLock("j1", int64(os.Getpid()))
		deps.Clock = brokenClock{w.clock}

		if _, err := FollowJob(never, deps, "j1"); err == nil || err.Error() != "clock broke" {
			t.Errorf("error = %v, want the sleep failure to propagate", err)
		}
	})
}

// brokenClock is a clock whose every sleep fails.
type brokenClock struct{ *fakes.ManualClock }

func (c brokenClock) Sleep(context.Context, int64) error { return errors.New("clock broke") }

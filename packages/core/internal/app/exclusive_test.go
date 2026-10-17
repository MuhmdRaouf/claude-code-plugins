package app

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strconv"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// Direct tests for the job lock, which the decide paths also exercise.

func TestWithJobLock(t *testing.T) {
	ctx := context.Background()

	t.Run("runs fn holding the job's lock, and releases it after", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())

		got, err := WithJobLock(ctx, deps, "j1", func(ctx context.Context) (string, error) {
			// Another driver cannot take the job while fn runs.
			if _, err := w.store.Lock(ctx, "j1", 999); !isLockHeld(err, int64(os.Getpid())) {
				t.Errorf("a second lock inside fn = %v, want it held by this process", err)
			}
			return "done", nil
		})

		if err != nil || got != "done" {
			t.Fatalf("WithJobLock() = (%q, %v), want fn's own answer", got, err)
		}
		if _, err := w.store.Lock(ctx, "j1", int64(os.Getpid())); err != nil {
			t.Errorf("the lock should be free again: %v", err)
		}
	})
	t.Run("a job the store does not know is a store error", func(t *testing.T) {
		deps, _ := newWorld(t, nil)

		_, err := WithJobLock(ctx, deps, "nope", func(context.Context) (string, error) {
			t.Error("fn should not run")
			return "", nil
		})

		want := &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorNotFound, ID: "nope",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Errorf("error = %+v, want not_found nope", err)
		}
	})
	t.Run("fn's failure is returned and the lock still released", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())
		failure := errors.New("landing failed")

		_, err := WithJobLock(ctx, deps, "j1", func(context.Context) (string, error) {
			return "", failure
		})

		if !errors.Is(err, failure) {
			t.Errorf("error = %v, want fn's own failure", err)
		}
		if _, lockErr := w.store.Lock(ctx, "j1", int64(os.Getpid())); lockErr != nil {
			t.Errorf("the lock should be free again: %v", lockErr)
		}
	})
}

func TestWithDriverStopped(t *testing.T) {
	ctx := context.Background()

	t.Run("reaps the job's engine once the lock is its own", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())
		paths := w.store.Paths("j1")
		if err := os.WriteFile(paths.EnginePid, []byte(strconv.FormatInt(61234, 10)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		w.process.MarkAlive(61234)

		got, err := WithDriverStopped(ctx, deps, "j1", func(context.Context) (string, error) {
			return "decided", nil
		})

		if err != nil || got != "decided" {
			t.Fatalf("WithDriverStopped() = (%q, %v), want fn's own answer", got, err)
		}
		if terminated := w.process.Terminated(); !reflect.DeepEqual(terminated, []int64{61234}) {
			t.Errorf("terminated = %v, want the engine group", terminated)
		}
		if _, recorded := w.files.EnginePid(paths); recorded {
			t.Error("the engine pid was not forgotten")
		}
	})
	t.Run("asks a live holder to stop, then terminates it when it does not let go", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())
		w.store.HoldLock("j1", 4242)
		w.process.MarkAlive(4242)
		paths := w.store.Paths("j1")

		_, err := WithDriverStopped(ctx, deps, "j1", func(context.Context) (string, error) {
			t.Error("fn should not run while the holder never lets go")
			return "", nil
		})

		if !w.files.StopRequested(ctx, paths) {
			t.Error("the holder was never asked to stop")
		}
		if terminated := w.process.Terminated(); !reflect.DeepEqual(terminated, []int64{4242}) {
			t.Errorf("terminated = %v, want the holder after the grace", terminated)
		}
		if len(w.process.gracesOf()) != 1 || w.process.gracesOf()[0] != deps.Config.StopGraceMs {
			t.Errorf("the holder was not terminated with the configured grace: %v", w.process.gracesOf())
		}
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore ||
			appErr.StoreError == nil || appErr.StoreError.Kind != ports.StoreErrorLocked ||
			appErr.StoreError.HolderPid != 4242 {
			t.Errorf("error = %+v, want the lock still held by 4242", err)
		}
	})
	t.Run("a stop request that cannot be written fails the section", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())
		w.store.HoldLock("j1", 4242)
		w.process.MarkAlive(4242)
		deps.Files = stopRefusingFiles{w.files}

		_, err := WithDriverStopped(ctx, deps, "j1", func(context.Context) (string, error) {
			t.Error("fn should not run")
			return "", nil
		})

		if err == nil || err.Error() != "no stop file" {
			t.Errorf("error = %v, want the stop request's own failure", err)
		}
	})
	t.Run("a clock that fails while waiting for the holder is a store error", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		w.store.Put(testkit.AJob())
		w.store.HoldLock("j1", 4242)
		w.process.MarkAlive(4242)
		deps.Clock = brokenClock{w.clock}

		_, err := WithDriverStopped(ctx, deps, "j1", func(context.Context) (string, error) {
			t.Error("fn should not run")
			return "", nil
		})

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore || appErr.StoreError != nil {
			t.Errorf("error = %+v, want a store error without detail", err)
		}
	})
}

// stopRefusingFiles is the test files with a stop request that cannot be written.
type stopRefusingFiles struct{ *testFiles }

func (f stopRefusingFiles) RequestStop(ctx context.Context, paths domain.JobPaths) error {
	return errors.New("no stop file")
}

// isLockHeld says the store's answer is a lock held by pid.
func isLockHeld(err error, pid int64) bool {
	var storeErr *ports.StoreError
	return errors.As(err, &storeErr) &&
		storeErr.Kind == ports.StoreErrorLocked && storeErr.HolderPid == pid
}

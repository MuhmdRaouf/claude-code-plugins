package app

import (
	"context"
	"errors"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The job's exclusive sections: the driver lock a driver or a decision holds while it works, so no
// two of them ever touch one job.

// driverStopMs is how long a driver gets to honour a stop request, on top of the worker's stop
// grace, before it is terminated.
const driverStopMs int64 = 15_000

// lockPollMs is how often a waiting taker retries the lock.
const lockPollMs int64 = 250

// WithJobLock runs fn holding the job's driver lock, so no driver runs the job meanwhile.
func WithJobLock[T any](ctx context.Context, deps Deps, id string, fn func(context.Context) (T, error)) (T, error) {
	lock, err := deps.Store.Lock(ctx, id, int64(os.Getpid()))
	return holding(ctx, lock, err, fn)
}

// WithDriverStopped is like WithJobLock, but a live driver is first asked to stop and given time
// to land the job; one that does not let go in time is terminated.
func WithDriverStopped[T any](ctx context.Context, deps Deps, id string, fn func(context.Context) (T, error)) (T, error) {
	lock, err := deps.Store.Lock(ctx, id, int64(os.Getpid()))
	if isLocked(err) {
		if stopErr := deps.Files.RequestStop(ctx, deps.Store.Paths(id)); stopErr != nil {
			var zero T
			return zero, stopErr
		}
		lock, err = lockWithin(ctx, deps, id, deps.Config.StopGraceMs+driverStopMs)
	}
	if isLocked(err) {
		var storeErr *ports.StoreError
		if errors.As(err, &storeErr) {
			// The stop grace is already spent waiting; the termination gets it again as its
			// SIGTERM-to-SIGKILL window.
			_ = deps.Process.TerminateGroup(ctx, storeErr.HolderPid, deps.Config.StopGraceMs)
		}
		lock, err = deps.Store.Lock(ctx, id, int64(os.Getpid()))
	}
	if err == nil {
		// The engine runs in its own process group: a driver that was killed (or had died) could
		// not stop it.
		ReapEngine(ctx, deps, id)
	}
	return holding(ctx, lock, err, fn)
}

// lockWithin retries the lock every lockPollMs until ms has passed, giving up on the last locked
// answer.
func lockWithin(ctx context.Context, deps Deps, id string, ms int64) (func(), error) {
	deadline := deps.Clock.Now() + ms
	for {
		if err := deps.Clock.Sleep(ctx, lockPollMs); err != nil {
			return nil, err
		}
		lock, err := deps.Store.Lock(ctx, id, int64(os.Getpid()))
		if err == nil || !isLocked(err) || deps.Clock.Now() >= deadline {
			return lock, err
		}
	}
}

// holding runs fn under a taken lock and releases it after; a lock that could not be taken is the
// store's own error.
func holding[T any](ctx context.Context, release func(), lockErr error, fn func(context.Context) (T, error)) (T, error) {
	if lockErr != nil {
		var zero T
		return zero, &AppError{Kind: AppErrorStore, StoreError: asStoreError(lockErr)}
	}
	defer release()
	return fn(ctx)
}

// isLocked says the store's answer is that another live driver holds the lock.
func isLocked(err error) bool {
	var storeErr *ports.StoreError
	return errors.As(err, &storeErr) && storeErr.Kind == ports.StoreErrorLocked
}

package app

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// pollMs is how often a driver looks for a `stop` request.
const pollMs = 1_000

// StopWatch is the signal a driver waits on. Ctx ends once a stop is requested: the job's stop file
// appeared, or the caller's external context aborted.
type StopWatch struct {
	Ctx    context.Context
	cancel context.CancelFunc
	// watchDone ends the poll loop and detaches the external context.
	watchDone func()
	detached  atomic.Bool
	closeOnce sync.Once
}

// WatchStop watches the job's stop file until a stop is requested, the external context aborts or
// Close runs. The clock the deps carry paces the polling, so tests move it.
func WatchStop(external context.Context, deps Deps, paths domain.JobPaths) *StopWatch {
	ctx, cancel := context.WithCancel(context.WithoutCancel(external))
	watching, stopWatching := context.WithCancel(context.Background())
	watch := &StopWatch{Ctx: ctx, cancel: cancel, watchDone: stopWatching}
	// The external abort ends the stop signal only until Close detaches it.
	go func() {
		select {
		case <-external.Done():
			if !watch.detached.Load() {
				cancel()
			}
		case <-watching.Done():
		}
	}()
	go func() {
		for ctx.Err() == nil {
			if deps.Files.StopRequested(ctx, paths) {
				cancel()
				return
			}
			// A sleep that gives up (Close) ends the watch without firing the signal.
			if deps.Clock.Sleep(watching, pollMs) != nil {
				return
			}
		}
	}()
	return watch
}

// Close stops watching without firing the signal, and detaches the external context: a later
// external abort no longer ends Ctx.
func (w *StopWatch) Close() {
	w.closeOnce.Do(func() {
		w.detached.Store(true)
		w.watchDone()
	})
}

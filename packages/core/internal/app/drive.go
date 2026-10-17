package app

import (
	"context"
	"fmt"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Drive one job from `queued` (or a review-returned job) to `awaiting_review`:
// lock the job → acquire a slot (semaphore capacity from the limiter) → run an attempt → verify →
// decide via AfterVerification (auto_fix / infra_retry loop back without releasing the lock;
// await_review ends) → release. Per attempt: build the prompt (initial | autoFix | reviewFix |
// selfContained when resume fails), start the worker with a new or resumed session, fold the
// stream (progress persisted at most every 2 s, every 429 api_retry reported to the limiter),
// finalize, then verification: gates (only when the worker completed), change set + scope check,
// report check, verdict. Every step persists the job (optimistic version) so `board`/`show` see
// live state. A stop request (job's stop flag file or the caller's context) terminates the worker
// and records verdict `stopped`.
func Drive(external context.Context, base Deps, jobID string) (domain.Job, error) {
	found, err := base.Store.Find(external, jobID)
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(err)}
	}
	// From here on the worker is the job's engine; nothing below knows which one it is.
	deps := DepsForJob(base, found)
	id := found.ID
	if found.State != domain.JobStateQueued {
		return domain.Job{}, notQueued(found)
	}
	release, err := deps.Store.Lock(external, id, int64(os.Getpid()))
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(err)}
	}
	// Everything the driver does after a stop request still runs; only the stop signal follows the
	// caller's context.
	ctx := context.WithoutCancel(external)
	paths := deps.Store.Paths(id)
	stop := WatchStop(external, deps, paths)
	defer stop.Close()
	defer func() {
		// A dispose failure is reported but never replaces the run's result, and the lock is
		// released either way.
		if disposeErr := deps.Worker.Dispose(ctx); disposeErr != nil {
			deps.Out.Error(fmt.Sprintf("%s: job %s finished, but its worker could not be disposed: %s",
				deps.Provider.Name, id, disposeErr.Error()))
		}
		release()
	}()
	driven, err := driveLocked(ctx, deps, id, stop)
	if err != nil {
		return driven, err
	}
	// A stop request is consumed by the run that honoured it, whether the watcher or the decision
	// point saw it.
	if stop.Ctx.Err() != nil || deps.Files.StopRequested(ctx, paths) {
		if clearErr := deps.Files.ClearStop(ctx, paths); clearErr != nil {
			return driven, clearErr
		}
	}
	return driven, nil
}

// notQueued is the wrong-state refusal of a job that is not queued.
func notQueued(job domain.Job) *AppError {
	return &AppError{
		Kind:    AppErrorWrongState,
		ID:      job.ID,
		State:   job.State,
		Allowed: []domain.JobState{domain.JobStateQueued},
	}
}

// driveLocked runs the job under the driver lock: re-read it, wait for a slot, then run to review.
func driveLocked(ctx context.Context, deps Deps, id string, stop *StopWatch) (domain.Job, error) {
	// Re-read under the lock: the job may have moved since it was found.
	current, err := deps.Store.Get(ctx, id)
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(err)}
	}
	if current.State != domain.JobStateQueued {
		return domain.Job{}, notQueued(current)
	}
	release, err := deps.Semaphore.Acquire(stop.Ctx, ports.SemaphoreHolder{
		JobID: id, Pid: int64(os.Getpid()), Priority: priorityOf(current),
	})
	if err != nil {
		// An acquire that gives up for any other reason than the stop signal is the semaphore's
		// own failure.
		if stop.Ctx.Err() == nil {
			return domain.Job{}, err
		}
		return Persist(ctx, deps, current, func(job domain.Job) (domain.Job, error) {
			return StopJob(deps, job)
		})
	}
	defer release()
	return runToReview(ctx, deps, current, stop)
}

// priorityOf is the job's slot-queue priority, normal when the brief names none.
func priorityOf(job domain.Job) domain.Priority {
	if job.Brief.Priority != nil {
		return *job.Brief.Priority
	}
	return domain.PriorityNormal
}

// runToReview moves the job to running, then loops one attempt at a time until one ends the drive.
func runToReview(ctx context.Context, deps Deps, queuedJob domain.Job, stop *StopWatch) (domain.Job, error) {
	running, err := Persist(ctx, deps, queuedJob, func(job domain.Job) (domain.Job, error) {
		return StartJob(deps, job)
	})
	for err == nil {
		var done bool
		var next domain.Job
		done, next, err = runOnce(ctx, deps, running, stop)
		if done {
			return next, err
		}
		running = next
	}
	return domain.Job{}, err
}

// runOnce is one attempt: run, verify, then either land the job in awaiting_review (done) or queue
// the next attempt (done false, the job to continue from).
func runOnce(ctx context.Context, deps Deps, job domain.Job, stop *StopWatch) (bool, domain.Job, error) {
	pending := PendingAttempt(job)
	if pending == nil {
		return true, job, notQueued(job)
	}
	before, err := RepositoryFingerprint(ctx, deps, job)
	if err != nil {
		return true, domain.Job{}, err
	}
	ran, err := RunAttempt(ctx, deps, job, *pending, stop)
	if err != nil {
		return true, domain.Job{}, err
	}
	// A rate limit that killed the attempt lowers the cap on its own; the folded retries only add
	// to the quorum. An empty balance answered with a 429 (Z.ai's 1113) is no sign of load: the cap
	// stays.
	if terminalRateLimit(ran.Outcome) {
		if err := deps.Limiter.RateLimited(ctx, deps.Clock.Now(), ports.RateLimitOptions{EndedAttempt: true}); err != nil {
			return true, domain.Job{}, err
		}
	}
	exited, err := Persist(ctx, deps, job, func(stored domain.Job) (domain.Job, error) {
		return Move(WithLastAttempt(stored, ran.Attempt), domain.JobEvent{Type: domain.EventWorkerExited})
	})
	if err != nil {
		return true, domain.Job{}, err
	}
	verification, err := VerifyAttempt(ctx, deps, exited, ran.Attempt, before)
	if err != nil {
		return true, domain.Job{}, err
	}
	verdict := domain.DeriveVerdict(domain.VerdictInput{
		Outcome: ran.Outcome,
		Gates:   verification.Gates,
		Scope:   verification.Scope,
		Report:  verification.Report,
	})
	verified := ran.Attempt
	verified.Verification = &verification
	verified.Verdict = &verdict
	// The watcher polls the stop file once a second; ask the file too, so a stop requested any time
	// before this decision lands the verdict instead of starting a retry.
	stopped := stop.Ctx.Err() != nil || deps.Files.StopRequested(ctx, deps.Store.Paths(job.ID))
	next := domain.AfterVerificationAwaitReview
	if ran.Failure == nil && !stopped {
		next = domain.AfterVerification(WithLastAttempt(exited, verified), verdict)
	}
	if next != domain.AfterVerificationAwaitReview {
		kind := domain.AttemptKindAutoFix
		if next == domain.AfterVerificationInfraRetry {
			kind = domain.AttemptKindInfraRetry
		}
		retried, err := Persist(ctx, deps, exited, func(stored domain.Job) (domain.Job, error) {
			return RetryJob(deps, WithLastAttempt(stored, verified), kind)
		})
		if err != nil {
			return true, domain.Job{}, err
		}
		return false, retried, nil
	}
	landed, err := Persist(ctx, deps, exited, func(stored domain.Job) (domain.Job, error) {
		return Move(WithLastAttempt(stored, verified), domain.JobEvent{Type: domain.EventVerified})
	})
	if err != nil {
		return true, domain.Job{}, err
	}
	if ran.Failure != nil {
		return true, landed, ran.Failure
	}
	return true, landed, nil
}

// terminalRateLimit says an api_error ended the attempt on a 429 that is not an empty balance: a
// rate limit that killed the run.
func terminalRateLimit(outcome domain.WorkerOutcome) bool {
	if outcome.Kind != domain.WorkerOutcomeAPIError || outcome.Status == nil || *outcome.Status != 429 {
		return false
	}
	return outcome.Quota == nil || !*outcome.Quota
}

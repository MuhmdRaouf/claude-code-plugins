package app

import (
	"context"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The review decisions — accept (with landing), return with feedback, discard and stop.

// inReview is the states a review decision needs; undecided the ones discard may still take, and
// stoppable the ones a stop request can reach.
var inReview = []domain.JobState{domain.JobStateAwaitingReview}

var undecided = []domain.JobState{
	domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying, domain.JobStateAwaitingReview,
}

var stoppable = []domain.JobState{domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying}

// Accept is awaiting_review → accepted. Edit: commit the change set on the job branch (message:
// title, report summary, and the `Worked-by` trailer unless the repository sets
// `<provider>.trailer: none`), rebase onto the repo's branch tip when it moved, regenerate the
// brief's generated files, verify the exact commit in a fresh detached checkout, then
// fast-forward the repo's branch onto it (or apply to the working tree for no_commit); conflict or
// failed verification → error, nothing applied, job unchanged. exec/readonly: nothing to land.
// Then remove the worktree. Accepting a non-pass verdict is allowed only with force (the reviewer
// owns that call). The repository's commit hooks run unless verify is false; a failing hook leaves
// the job awaiting review.
func Accept(ctx context.Context, deps Deps, id string, opts AcceptOptions) (domain.Job, error) {
	return decideOn(ctx, deps, id, inReview, WithJobLock[domain.Job], func(job domain.Job) (domain.Job, error) {
		var verdict *domain.Verdict
		if len(job.Attempts) > 0 {
			verdict = job.Attempts[len(job.Attempts)-1].Verdict
		}
		if (verdict == nil || *verdict != domain.VerdictPass) && !opts.Force {
			return domain.Job{}, &AppError{Kind: AppErrorNotPass, ID: job.ID, Verdict: verdict}
		}
		commit, err := Land(ctx, deps, job, LandOptions{Mode: opts.Mode, Verify: opts.Verify})
		if err != nil {
			return domain.Job{}, err
		}
		accepted, err := decided(ctx, deps, job, domain.JobEvent{Type: domain.EventAccepted}, domain.Decision{
			Kind: domain.DecisionAccepted, At: deps.Clock.Iso(), Commit: commit,
		})
		if err != nil {
			return domain.Job{}, err
		}
		RemoveWorkspace(ctx, deps, accepted)
		return accepted, nil
	})
}

// ReturnForFix is awaiting_review → queued with a pending review_fix carrying the feedback
// (non-empty); the caller then drives it.
func ReturnForFix(ctx context.Context, deps Deps, id string, feedback string) (domain.Job, error) {
	text := strings.TrimSpace(feedback)
	if text == "" {
		return domain.Job{}, &AppError{Kind: AppErrorEmptyFeedback}
	}
	return decideOn(ctx, deps, id, inReview, WithJobLock[domain.Job], func(job domain.Job) (domain.Job, error) {
		returned, err := Persist(ctx, deps, job, func(stored domain.Job) (domain.Job, error) {
			moved, err := Move(stored, domain.JobEvent{Type: domain.EventReturned, Feedback: text})
			if err != nil {
				return domain.Job{}, err
			}
			var last *domain.Attempt
			if len(stored.Attempts) > 0 {
				previous := stored.Attempts[len(stored.Attempts)-1]
				last = &previous
			}
			prompt := text
			sessionID := deps.Ids.SessionID()
			if last != nil {
				prompt = domain.ReviewFixPrompt(stored.Brief, *last, text, deps.Config.Prompt)
				sessionID = last.SessionID
			}
			return appendAttempt(moved, domain.Attempt{
				N:         int64(len(stored.Attempts)) + 1,
				Kind:      domain.AttemptKindReviewFix,
				Feedback:  &text,
				Prompt:    prompt,
				SessionID: sessionID,
				StartedAt: deps.Clock.Iso(),
			}), nil
		})
		// A stale request must not stop the run the reviewer just asked for.
		if err == nil {
			err = deps.Files.ClearStop(ctx, deps.Store.Paths(job.ID))
		}
		return returned, err
	})
}

// Discard is any undecided state → discarded: stop a running worker first, remove the worktree,
// keep logs.
func Discard(ctx context.Context, deps Deps, id string, reason *string) (domain.Job, error) {
	return decideOn(ctx, deps, id, undecided, WithDriverStopped[domain.Job], func(job domain.Job) (domain.Job, error) {
		discarded, err := decided(ctx, deps, job, domain.JobEvent{Type: domain.EventDiscarded}, domain.Decision{
			Kind: domain.DecisionDiscarded, At: deps.Clock.Iso(), Reason: reason,
		})
		if err == nil {
			RemoveWorkspace(ctx, deps, discarded)
			err = deps.Files.ClearStop(ctx, deps.Store.Paths(job.ID))
		}
		return discarded, err
	})
}

// Stop requests a stop: running/verifying/queued drivers end with verdict `stopped` and the job
// awaits review. A job with no live driver is stopped here and now.
func Stop(ctx context.Context, deps Deps, id string) (domain.Job, error) {
	found, err := located(ctx, deps, id, stoppable)
	if err != nil {
		return domain.Job{}, err
	}
	paths := deps.Store.Paths(found.ID)
	if err := deps.Files.RequestStop(ctx, paths); err != nil {
		return domain.Job{}, err
	}
	release, lockErr := deps.Store.Lock(ctx, found.ID, int64(os.Getpid()))
	if lockErr != nil {
		// A live driver holds the job: it honours the stop request itself and lands the verdict.
		if isLocked(lockErr) {
			return found, nil
		}
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(lockErr)}
	}
	defer release()
	// No live driver holds the job, so nobody else will stop its engine.
	ReapEngine(ctx, deps, found.ID)
	stopped, stopErr := func() (domain.Job, error) {
		current, err := located(ctx, deps, found.ID, stoppable)
		if err != nil {
			return domain.Job{}, err
		}
		return Persist(ctx, deps, current, func(job domain.Job) (domain.Job, error) {
			return StopJob(deps, job)
		})
	}()
	if clearErr := deps.Files.ClearStop(ctx, paths); clearErr != nil {
		return domain.Job{}, clearErr
	}
	return stopped, stopErr
}

// decisionLocking is how a decision takes the job's lock before it decides.
type decisionLocking func(ctx context.Context, deps Deps, id string, fn func(context.Context) (domain.Job, error)) (domain.Job, error)

// decideOn finds the job, takes its lock the given way, re-reads it under the lock and runs fn
// while it is in an allowed state.
func decideOn(ctx context.Context, deps Deps, id string, allowed []domain.JobState, locking decisionLocking, fn func(domain.Job) (domain.Job, error)) (domain.Job, error) {
	found, err := located(ctx, deps, id, allowed)
	if err != nil {
		return domain.Job{}, err
	}
	return locking(ctx, deps, found.ID, func(context.Context) (domain.Job, error) {
		current, err := located(ctx, deps, found.ID, allowed)
		if err != nil {
			return domain.Job{}, err
		}
		return fn(current)
	})
}

// located is the job when it is in one of the allowed states, else the state it is in and the ones
// the step needed.
func located(ctx context.Context, deps Deps, id string, allowed []domain.JobState) (domain.Job, error) {
	found, err := deps.Store.Find(ctx, id)
	if err != nil {
		return domain.Job{}, storeLookupError(err)
	}
	for _, state := range allowed {
		if found.State == state {
			return found, nil
		}
	}
	return domain.Job{}, &AppError{
		Kind: AppErrorWrongState, ID: found.ID, State: found.State, Allowed: allowed,
	}
}

// decided is the job moved through the lifecycle by event with the decision recorded.
func decided(ctx context.Context, deps Deps, job domain.Job, event domain.JobEvent, decision domain.Decision) (domain.Job, error) {
	return Persist(ctx, deps, job, func(stored domain.Job) (domain.Job, error) {
		moved, err := Move(stored, event)
		if err != nil {
			return domain.Job{}, err
		}
		moved.Decision = &decision
		return moved, nil
	})
}

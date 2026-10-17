package app

import (
	"slices"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Fix attempts continue the worker's own session; the others start a fresh one.
func ResumesSession(attempt domain.Attempt) bool {
	return attempt.Kind == domain.AttemptKindAutoFix || attempt.Kind == domain.AttemptKindReviewFix
}

// PendingAttempt is the attempt that has not run yet (or is running): the last one, while it has
// no outcome.
func PendingAttempt(job domain.Job) *domain.Attempt {
	if len(job.Attempts) == 0 {
		return nil
	}
	last := job.Attempts[len(job.Attempts)-1]
	if last.Outcome != nil {
		return nil
	}
	return &last
}

// WithLastAttempt is the job with its last attempt replaced.
func WithLastAttempt(job domain.Job, attempt domain.Attempt) domain.Job {
	next := job
	next.Attempts = append(slices.Clone(job.Attempts[:len(job.Attempts)-1]), attempt)
	return next
}

// appendAttempt is the job with attempt added.
func appendAttempt(job domain.Job, attempt domain.Attempt) domain.Job {
	next := job
	next.Attempts = append(slices.Clone(job.Attempts), attempt)
	return next
}

// StartJob is queued → running with the attempt to run: the pending one (a review_fix the
// reviewer queued) or the first.
func StartJob(deps Deps, job domain.Job) (domain.Job, error) {
	moved, err := Move(job, domain.JobEvent{Type: domain.EventSlotAcquired})
	if err != nil {
		return domain.Job{}, err
	}
	if pending := PendingAttempt(moved); pending != nil {
		stamped := *pending
		stamped.StartedAt = deps.Clock.Iso()
		return WithLastAttempt(moved, stamped), nil
	}
	return appendAttempt(moved, newAttempt(deps, moved, domain.AttemptKindInitial,
		domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider))), nil
}

// RetryJob is verifying → running with the next attempt of kind appended.
func RetryJob(deps Deps, job domain.Job, kind domain.AttemptKind) (domain.Job, error) {
	moved, err := Move(job, domain.JobEvent{Type: domain.EventRetry, RetryKind: kind})
	if err != nil {
		return domain.Job{}, err
	}
	return appendAttempt(moved, retryAttempt(deps, moved, kind)), nil
}

// retryAttempt is the next attempt of kind: an auto_fix resumes the failed attempt's session.
func retryAttempt(deps Deps, job domain.Job, kind domain.AttemptKind) domain.Attempt {
	var last *domain.Attempt
	if len(job.Attempts) > 0 {
		previous := job.Attempts[len(job.Attempts)-1]
		last = &previous
	}
	if kind == domain.AttemptKindAutoFix && last != nil {
		attempt := newAttempt(deps, job, kind, domain.AutoFixPrompt(job.Brief, *last, deps.Config.Prompt))
		attempt.SessionID = last.SessionID
		return attempt
	}
	return newAttempt(deps, job, kind, freshSessionPrompt(deps, job, job.Attempts))
}

// freshSessionPrompt is the prompt for a new session after history: the initial prompt while
// nothing but initial runs happened, else the brief made self-contained, asked to carry out the
// last real instruction (a fix or the reviewer's feedback) again.
func freshSessionPrompt(deps Deps, job domain.Job, history []domain.Attempt) string {
	var instruction *string
	for i := len(history) - 1; i >= 0; i-- {
		if ResumesSession(history[i]) {
			prompt := history[i].Prompt
			instruction = &prompt
			break
		}
	}
	if instruction == nil {
		return domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider)
	}
	return domain.SelfContainedPrompt(job.Brief, history, *instruction, job.Workspace.ArtifactsDir, deps.Provider)
}

// newAttempt is the first record of a run: its number, its kind, its prompt and a fresh session.
func newAttempt(deps Deps, job domain.Job, kind domain.AttemptKind, prompt string) domain.Attempt {
	return domain.Attempt{
		N:         int64(len(job.Attempts)) + 1,
		Kind:      kind,
		Prompt:    prompt,
		SessionID: deps.Ids.SessionID(),
		StartedAt: deps.Clock.Iso(),
	}
}

// StopJob is queued/running/verifying → awaiting_review with verdict stopped. The attempt in
// flight (or the one that never got to start) keeps what it has and is closed as stopped; a job
// that never had an attempt gets its first, closed at once.
func StopJob(deps Deps, job domain.Job) (domain.Job, error) {
	moved, err := Move(job, domain.JobEvent{Type: domain.EventStopped})
	if err != nil {
		return domain.Job{}, err
	}
	// Unlike a pending attempt, the one a stop closes may already carry its outcome (a verifying
	// job); only a verdict means nothing is left to close.
	var closing domain.Attempt
	open := false
	if len(moved.Attempts) > 0 && moved.Attempts[len(moved.Attempts)-1].Verdict == nil {
		closing = moved.Attempts[len(moved.Attempts)-1]
		open = true
	}
	if !open {
		closing = newAttempt(deps, moved, domain.AttemptKindInitial,
			domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider))
	}
	closed := closing
	if closed.EndedAt == nil {
		endedAt := deps.Clock.Iso()
		closed.EndedAt = &endedAt
	}
	if closed.Outcome == nil {
		outcome := domain.WorkerOutcome{Kind: domain.WorkerOutcomeStopped}
		closed.Outcome = &outcome
	}
	verdict := domain.VerdictStopped
	closed.Verdict = &verdict
	if open {
		return WithLastAttempt(moved, closed), nil
	}
	return appendAttempt(moved, closed), nil
}

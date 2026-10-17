package domain

import (
	"errors"
	"testing"
)

var jobStates = []JobState{
	JobStateQueued,
	JobStateRunning,
	JobStateVerifying,
	JobStateAwaitingReview,
	JobStateAccepted,
	JobStateDiscarded,
}

var jobEvents = []JobEvent{
	{Type: EventSlotAcquired},
	{Type: EventWorkerExited},
	{Type: EventVerified},
	{Type: EventRetry, RetryKind: AttemptKindAutoFix},
	{Type: EventRetry, RetryKind: AttemptKindInfraRetry},
	{Type: EventReturned, Feedback: "Also update the docs."},
	{Type: EventAccepted},
	{Type: EventDiscarded},
	{Type: EventStopped},
}

// legalMoves is written out independently of the implementation's table.
var legalMoves = []struct {
	from  JobState
	event JobEventType
	to    JobState
}{
	{JobStateQueued, EventSlotAcquired, JobStateRunning},
	{JobStateRunning, EventWorkerExited, JobStateVerifying},
	{JobStateVerifying, EventVerified, JobStateAwaitingReview},
	{JobStateVerifying, EventRetry, JobStateRunning},
	{JobStateAwaitingReview, EventReturned, JobStateQueued},
	{JobStateAwaitingReview, EventAccepted, JobStateAccepted},
	{JobStateQueued, EventDiscarded, JobStateDiscarded},
	{JobStateRunning, EventDiscarded, JobStateDiscarded},
	{JobStateVerifying, EventDiscarded, JobStateDiscarded},
	{JobStateAwaitingReview, EventDiscarded, JobStateDiscarded},
	{JobStateQueued, EventStopped, JobStateAwaitingReview},
	{JobStateRunning, EventStopped, JobStateAwaitingReview},
	{JobStateVerifying, EventStopped, JobStateAwaitingReview},
}

func isLegalMove(from JobState, event JobEvent) bool {
	for _, move := range legalMoves {
		if move.from == from && move.event == event.Type {
			return true
		}
	}
	return false
}

// anAttempt builds an attempt with sensible defaults and shallow overrides.
func anAttempt(overrides ...func(*Attempt)) Attempt {
	attempt := Attempt{
		N:         1,
		Kind:      AttemptKindInitial,
		Prompt:    "Rename `foo` to `bar` everywhere.",
		SessionID: "00000000-0000-4000-8000-000000000001",
		StartedAt: "2026-10-06T00:00:00.000Z",
	}
	for _, override := range overrides {
		override(&attempt)
	}
	return attempt
}

// aJob builds a job with sensible defaults and shallow overrides.
func aJob(overrides ...func(*Job)) Job {
	job := Job{
		ID:    "j1",
		Brief: aBrief(),
		State: JobStateQueued,
		Workspace: Workspace{
			RepoRoot:     "/repo",
			BaseSha:      "0000000000000000000000000000000000000000",
			Worktree:     strPtr("/state/worktrees/j1"),
			Branch:       strPtr("zai/j1"),
			ArtifactsDir: "/state/jobs/j1/artifacts",
		},
		Attempts:  []Attempt{},
		CreatedAt: "2026-10-06T00:00:00.000Z",
		UpdatedAt: "2026-10-06T00:00:00.000Z",
		Version:   0,
	}
	for _, override := range overrides {
		override(&job)
	}
	return job
}

// jobWithAttempts is a job in verifying whose attempts have these kinds, in order (the last one is
// the attempt just verified).
func jobWithAttempts(kinds []AttemptKind, retries Retries) Job {
	attempts := make([]Attempt, 0, len(kinds))
	for i, kind := range kinds {
		n := int64(i + 1)
		attempts = append(attempts, anAttempt(func(a *Attempt) { a.N = n; a.Kind = kind }))
	}
	return aJob(func(j *Job) {
		j.State = JobStateVerifying
		j.Brief = aBrief(func(b *Brief) { b.Retries = retries })
		j.Attempts = attempts
	})
}

func TestNextState(t *testing.T) {
	assertNext := func(t *testing.T, from JobState, event JobEvent, want JobState) {
		t.Helper()
		got, err := NextState(from, event)
		if err != nil {
			t.Fatalf("%s --%s-->: unexpected error %v", from, event.Type, err)
		}
		if got != want {
			t.Errorf("%s --%s--> = %s, want %s", from, event.Type, got, want)
		}
	}

	t.Run("queued --slot_acquired--> running", func(t *testing.T) {
		assertNext(t, JobStateQueued, JobEvent{Type: EventSlotAcquired}, JobStateRunning)
	})

	t.Run("running --worker_exited--> verifying", func(t *testing.T) {
		assertNext(t, JobStateRunning, JobEvent{Type: EventWorkerExited}, JobStateVerifying)
	})

	t.Run("verifying --verified--> awaiting_review", func(t *testing.T) {
		assertNext(t, JobStateVerifying, JobEvent{Type: EventVerified}, JobStateAwaitingReview)
	})

	t.Run("verifying --retry(auto_fix|infra_retry)--> running", func(t *testing.T) {
		assertNext(t, JobStateVerifying, JobEvent{Type: EventRetry, RetryKind: AttemptKindAutoFix}, JobStateRunning)
		assertNext(t, JobStateVerifying, JobEvent{Type: EventRetry, RetryKind: AttemptKindInfraRetry}, JobStateRunning)
	})

	t.Run("awaiting_review --returned--> queued", func(t *testing.T) {
		event := JobEvent{Type: EventReturned, Feedback: "Also update the docs."}
		assertNext(t, JobStateAwaitingReview, event, JobStateQueued)
	})

	t.Run("awaiting_review --accepted--> accepted", func(t *testing.T) {
		assertNext(t, JobStateAwaitingReview, JobEvent{Type: EventAccepted}, JobStateAccepted)
	})

	t.Run("queued|running|verifying|awaiting_review --discarded--> discarded", func(t *testing.T) {
		for _, from := range []JobState{JobStateQueued, JobStateRunning, JobStateVerifying, JobStateAwaitingReview} {
			assertNext(t, from, JobEvent{Type: EventDiscarded}, JobStateDiscarded)
		}
	})

	t.Run("queued|running|verifying --stopped--> awaiting_review", func(t *testing.T) {
		for _, from := range []JobState{JobStateQueued, JobStateRunning, JobStateVerifying} {
			assertNext(t, from, JobEvent{Type: EventStopped}, JobStateAwaitingReview)
		}
	})

	t.Run("is total: every (state × event) pair not listed above is illegal_transition naming from and event (table-driven)", func(t *testing.T) {
		for _, from := range jobStates {
			for _, event := range jobEvents {
				if isLegalMove(from, event) {
					continue
				}
				got, err := NextState(from, event)
				if err == nil {
					t.Errorf("%s --%s--> = %s, want illegal_transition", from, event.Type, got)
					continue
				}
				var lifecycleErr LifecycleError
				if !errors.As(err, &lifecycleErr) {
					t.Errorf("%s --%s-->: error %v is not a LifecycleError", from, event.Type, err)
					continue
				}
				want := LifecycleError{Kind: IllegalTransition, From: from, Event: event.Type}
				if lifecycleErr != want {
					t.Errorf("%s --%s-->: error %+v, want %+v", from, event.Type, lifecycleErr, want)
				}
				if err.Error() != "illegal_transition" {
					t.Errorf("%s --%s-->: error text %q, want illegal_transition", from, event.Type, err.Error())
				}
			}
		}
	})

	t.Run("terminal states accept no event", func(t *testing.T) {
		for _, from := range []JobState{JobStateAccepted, JobStateDiscarded} {
			if !IsTerminal(from) {
				t.Errorf("IsTerminal(%s) = false, want true", from)
			}
			for _, event := range jobEvents {
				got, err := NextState(from, event)
				if err == nil {
					t.Fatalf("%s --%s--> = %s, want illegal_transition", from, event.Type, got)
				}
				var lifecycleErr LifecycleError
				if !errors.As(err, &lifecycleErr) {
					t.Fatalf("%s --%s-->: error %v is not a LifecycleError", from, event.Type, err)
				}
				want := LifecycleError{Kind: IllegalTransition, From: from, Event: event.Type}
				if lifecycleErr != want {
					t.Errorf("%s --%s-->: error %+v, want %+v", from, event.Type, lifecycleErr, want)
				}
			}
		}
		for _, state := range []JobState{JobStateQueued, JobStateRunning, JobStateVerifying, JobStateAwaitingReview} {
			if IsTerminal(state) {
				t.Errorf("IsTerminal(%s) = true, want false", state)
			}
		}
	})
}

func TestAfterVerification(t *testing.T) {
	t.Run("pass → await_review", func(t *testing.T) {
		verdict := VerdictPass
		job := aJob(func(j *Job) {
			j.State = JobStateVerifying
			j.Attempts = []Attempt{anAttempt(func(a *Attempt) { a.Verdict = &verdict })}
		})
		if got := AfterVerification(job, VerdictPass); got != AfterVerificationAwaitReview {
			t.Errorf("AfterVerification(pass) = %q, want await_review", got)
		}
	})

	t.Run("quota → await_review with infra budget left: no retry succeeds before a top-up", func(t *testing.T) {
		job := jobWithAttempts([]AttemptKind{AttemptKindInitial}, Retries{Fix: 2, Infra: 2})
		if got := AfterVerification(job, VerdictQuota); got != AfterVerificationAwaitReview {
			t.Errorf("AfterVerification(quota) = %q, want await_review", got)
		}
	})

	t.Run("gate_fail, scope_violation, report_invalid → auto_fix while fix budget remains", func(t *testing.T) {
		for _, verdict := range []Verdict{VerdictGateFail, VerdictScopeViolation, VerdictReportInvalid} {
			job := jobWithAttempts([]AttemptKind{AttemptKindInitial, AttemptKindAutoFix}, Retries{Fix: 2, Infra: 2})
			if got := AfterVerification(job, verdict); got != AfterVerificationAutoFix {
				t.Errorf("AfterVerification(%s) = %q, want auto_fix", verdict, got)
			}
		}
	})

	t.Run("→ await_review once the fix budget is spent", func(t *testing.T) {
		for _, verdict := range []Verdict{VerdictGateFail, VerdictScopeViolation, VerdictReportInvalid} {
			kinds := []AttemptKind{AttemptKindInitial, AttemptKindAutoFix, AttemptKindAutoFix}
			job := jobWithAttempts(kinds, Retries{Fix: 2, Infra: 2})
			if got := AfterVerification(job, verdict); got != AfterVerificationAwaitReview {
				t.Errorf("AfterVerification(%s) = %q, want await_review", verdict, got)
			}
		}
	})

	t.Run("worker_error and timeout → infra_retry while infra budget remains, then await_review", func(t *testing.T) {
		budget := Retries{Fix: 1, Infra: 2}
		oneInfra := []AttemptKind{AttemptKindInitial, AttemptKindInfraRetry}
		twoInfra := []AttemptKind{AttemptKindInitial, AttemptKindInfraRetry, AttemptKindInfraRetry}
		for _, verdict := range []Verdict{VerdictWorkerError, VerdictTimeout} {
			if got := AfterVerification(jobWithAttempts([]AttemptKind{AttemptKindInitial}, budget), verdict); got != AfterVerificationInfraRetry {
				t.Errorf("AfterVerification(%s), one used = %q, want infra_retry", verdict, got)
			}
			if got := AfterVerification(jobWithAttempts(oneInfra, budget), verdict); got != AfterVerificationInfraRetry {
				t.Errorf("AfterVerification(%s), two used = %q, want infra_retry", verdict, got)
			}
			if got := AfterVerification(jobWithAttempts(twoInfra, budget), verdict); got != AfterVerificationAwaitReview {
				t.Errorf("AfterVerification(%s), three used = %q, want await_review", verdict, got)
			}
		}
	})

	t.Run("stopped → await_review regardless of budget", func(t *testing.T) {
		job := jobWithAttempts([]AttemptKind{AttemptKindInitial}, Retries{Fix: 5, Infra: 5})
		if got := AfterVerification(job, VerdictStopped); got != AfterVerificationAwaitReview {
			t.Errorf("AfterVerification(stopped) = %q, want await_review", got)
		}
	})

	t.Run("a review_fix attempt resets both budgets (only attempts after the last review_fix count)", func(t *testing.T) {
		budget := Retries{Fix: 1, Infra: 1}
		spentThenReturned := jobWithAttempts(
			[]AttemptKind{AttemptKindInitial, AttemptKindAutoFix, AttemptKindInfraRetry, AttemptKindReviewFix}, budget)
		if got := AfterVerification(spentThenReturned, VerdictGateFail); got != AfterVerificationAutoFix {
			t.Errorf("AfterVerification(gate_fail) after a return = %q, want auto_fix", got)
		}
		if got := AfterVerification(spentThenReturned, VerdictWorkerError); got != AfterVerificationInfraRetry {
			t.Errorf("AfterVerification(worker_error) after a return = %q, want infra_retry", got)
		}

		spentAgain := jobWithAttempts(
			[]AttemptKind{AttemptKindInitial, AttemptKindAutoFix, AttemptKindReviewFix, AttemptKindAutoFix}, budget)
		if got := AfterVerification(spentAgain, VerdictGateFail); got != AfterVerificationAwaitReview {
			t.Errorf("AfterVerification(gate_fail) after spending the fresh budget = %q, want await_review", got)
		}
	})

	t.Run("retries {fix: 0} never auto-fixes", func(t *testing.T) {
		for _, verdict := range []Verdict{VerdictGateFail, VerdictScopeViolation, VerdictReportInvalid} {
			job := jobWithAttempts([]AttemptKind{AttemptKindInitial}, Retries{Fix: 0, Infra: 2})
			if got := AfterVerification(job, verdict); got != AfterVerificationAwaitReview {
				t.Errorf("AfterVerification(%s) = %q, want await_review", verdict, got)
			}
		}
	})
}

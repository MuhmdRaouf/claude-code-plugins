package app

import (
	"errors"
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// Direct tests for the attempt helpers, which the drive and decide paths also exercise.

func TestResumesSession(t *testing.T) {
	tests := []struct {
		kind domain.AttemptKind
		want bool
	}{
		{domain.AttemptKindInitial, false},
		{domain.AttemptKindAutoFix, true},
		{domain.AttemptKindReviewFix, true},
		{domain.AttemptKindInfraRetry, false},
	}
	for _, test := range tests {
		if got := ResumesSession(domain.Attempt{Kind: test.kind}); got != test.want {
			t.Errorf("ResumesSession(%s) = %v, want %v", test.kind, got, test.want)
		}
	}
}

func TestPendingAttempt(t *testing.T) {
	t.Run("the last attempt without an outcome is pending", func(t *testing.T) {
		pending := testkit.AnAttempt()
		job := testkit.AJob(func(j *domain.Job) { j.Attempts = []domain.Attempt{pending} })
		if got := PendingAttempt(job); !reflect.DeepEqual(got, &pending) {
			t.Errorf("PendingAttempt() = %+v, want the open attempt", got)
		}
	})
	t.Run("a decided last attempt leaves nothing pending", func(t *testing.T) {
		job := testkit.AJob(func(j *domain.Job) {
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Outcome = &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
			})}
		})
		if got := PendingAttempt(job); got != nil {
			t.Errorf("PendingAttempt() = %+v, want none", got)
		}
	})
	t.Run("a job without attempts has none pending", func(t *testing.T) {
		if got := PendingAttempt(testkit.AJob()); got != nil {
			t.Errorf("PendingAttempt() = %+v, want none", got)
		}
	})
}

func TestStartJob(t *testing.T) {
	deps, _ := newWorld(t, nil)

	t.Run("queued with no attempts appends the initial attempt", func(t *testing.T) {
		job := testkit.AJob()

		started, err := StartJob(deps, job)

		if err != nil {
			t.Fatal(err)
		}
		if started.State != domain.JobStateRunning || len(started.Attempts) != 1 {
			t.Fatalf("started = (%s, %d attempts), want running with one", started.State, len(started.Attempts))
		}
		attempt := started.Attempts[0]
		want := domain.Attempt{
			N:         1,
			Kind:      domain.AttemptKindInitial,
			Prompt:    domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider),
			SessionID: "00000000-0000-4000-8000-000000000001",
			StartedAt: deps.Clock.Iso(),
		}
		if !reflect.DeepEqual(attempt, want) {
			t.Errorf("attempt = %+v, want %+v", attempt, want)
		}
	})
	t.Run("the pending attempt a reviewer queued is kept and stamped", func(t *testing.T) {
		pending := testkit.AnAttempt(func(a *domain.Attempt) {
			a.Kind = domain.AttemptKindReviewFix
			a.Feedback = strPtr("Fix the test.")
			a.StartedAt = ""
		})
		job := testkit.AJob(func(j *domain.Job) { j.Attempts = []domain.Attempt{pending} })

		started, err := StartJob(deps, job)

		if err != nil {
			t.Fatal(err)
		}
		if started.State != domain.JobStateRunning || len(started.Attempts) != 1 {
			t.Fatalf("started = (%s, %d attempts), want the one attempt", started.State, len(started.Attempts))
		}
		stamped := pending
		stamped.StartedAt = deps.Clock.Iso()
		if !reflect.DeepEqual(started.Attempts[0], stamped) {
			t.Errorf("attempt = %+v, want the pending one stamped %+v", started.Attempts[0], stamped)
		}
	})
	t.Run("a job past queued refuses the move", func(t *testing.T) {
		_, err := StartJob(deps, testkit.AJob(func(j *domain.Job) { j.State = domain.JobStateAccepted }))
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorLifecycle {
			t.Fatalf("StartJob() error = %v, want a lifecycle AppError", err)
		}
	})
}

func TestRetryJob(t *testing.T) {
	verifying := func(history ...domain.Attempt) domain.Job {
		return testkit.AJob(func(j *domain.Job) {
			j.State = domain.JobStateVerifying
			j.Attempts = history
		})
	}
	failed := testkit.AnAttempt(func(a *domain.Attempt) {
		verdict := domain.VerdictGateFail
		a.Verdict = &verdict
		a.Outcome = &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	})

	t.Run("auto_fix resumes the failed attempt's session", func(t *testing.T) {
		deps, _ := newWorld(t, nil)
		job := verifying(failed)

		retried, err := RetryJob(deps, job, domain.AttemptKindAutoFix)

		if err != nil {
			t.Fatal(err)
		}
		if retried.State != domain.JobStateRunning || len(retried.Attempts) != 2 {
			t.Fatalf("retried = (%s, %d attempts), want running with the fix appended", retried.State, len(retried.Attempts))
		}
		want := domain.Attempt{
			N:         2,
			Kind:      domain.AttemptKindAutoFix,
			Prompt:    domain.AutoFixPrompt(job.Brief, failed, deps.Config.Prompt),
			SessionID: failed.SessionID,
			StartedAt: deps.Clock.Iso(),
		}
		if !reflect.DeepEqual(retried.Attempts[1], want) {
			t.Errorf("attempt = %+v, want the resumed fix %+v", retried.Attempts[1], want)
		}
	})
	t.Run("infra_retry starts a fresh session with the initial prompt while only initial runs happened", func(t *testing.T) {
		deps, _ := newWorld(t, nil)
		job := verifying(failed)

		retried, err := RetryJob(deps, job, domain.AttemptKindInfraRetry)

		if err != nil {
			t.Fatal(err)
		}
		want := domain.Attempt{
			N:         2,
			Kind:      domain.AttemptKindInfraRetry,
			Prompt:    domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider),
			SessionID: "00000000-0000-4000-8000-000000000001",
			StartedAt: deps.Clock.Iso(),
		}
		if !reflect.DeepEqual(retried.Attempts[1], want) {
			t.Errorf("attempt = %+v, want the fresh initial prompt %+v", retried.Attempts[1], want)
		}
	})
	t.Run("a fresh session after a fix carries the last instruction, self-contained", func(t *testing.T) {
		fix := testkit.AnAttempt(func(a *domain.Attempt) {
			a.N = 2
			a.Kind = domain.AttemptKindAutoFix
			a.Prompt = "Fix the failing gate."
			a.SessionID = "00000000-0000-4000-8000-000000000009"
		})
		deps, _ := newWorld(t, nil)
		history := []domain.Attempt{failed, fix}
		job := verifying(history...)

		retried, err := RetryJob(deps, job, domain.AttemptKindInfraRetry)

		if err != nil {
			t.Fatal(err)
		}
		wantPrompt := domain.SelfContainedPrompt(job.Brief, history, fix.Prompt, job.Workspace.ArtifactsDir, deps.Provider)
		attempt := retried.Attempts[len(retried.Attempts)-1]
		if attempt.Prompt != wantPrompt {
			t.Errorf("prompt = %q, want the self-contained one", attempt.Prompt)
		}
	})
	t.Run("a job not in verifying refuses the move", func(t *testing.T) {
		deps, _ := newWorld(t, nil)
		_, err := RetryJob(deps, testkit.AJob(), domain.AttemptKindAutoFix)
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorLifecycle {
			t.Fatalf("RetryJob() error = %v, want a lifecycle AppError", err)
		}
	})
}

func TestStopJob(t *testing.T) {
	deps, _ := newWorld(t, nil)

	t.Run("a job that never started gets its first attempt, closed at once", func(t *testing.T) {
		job := testkit.AJob()

		stopped, err := StopJob(deps, job)

		if err != nil {
			t.Fatal(err)
		}
		if stopped.State != domain.JobStateAwaitingReview || len(stopped.Attempts) != 1 {
			t.Fatalf("stopped = (%s, %d attempts), want awaiting review with one", stopped.State, len(stopped.Attempts))
		}
		want := domain.Attempt{
			N:         1,
			Kind:      domain.AttemptKindInitial,
			Prompt:    domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider),
			SessionID: "00000000-0000-4000-8000-000000000001",
			StartedAt: deps.Clock.Iso(),
			EndedAt:   strPtr(deps.Clock.Iso()),
			Outcome:   &domain.WorkerOutcome{Kind: domain.WorkerOutcomeStopped},
			Verdict:   strPtr(domain.VerdictStopped),
		}
		if !reflect.DeepEqual(stopped.Attempts[0], want) {
			t.Errorf("attempt = %+v, want the closed first attempt %+v", stopped.Attempts[0], want)
		}
	})
	t.Run("the attempt in flight is closed in place, keeping what it has", func(t *testing.T) {
		running := testkit.AJob(func(j *domain.Job) {
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		})

		stopped, err := StopJob(deps, running)

		if err != nil {
			t.Fatal(err)
		}
		if stopped.State != domain.JobStateAwaitingReview || len(stopped.Attempts) != 1 {
			t.Fatalf("stopped = (%s, %d attempts), want the one attempt closed", stopped.State, len(stopped.Attempts))
		}
		attempt := stopped.Attempts[0]
		if attempt.N != 1 || attempt.Kind != domain.AttemptKindInitial ||
			attempt.SessionID != running.Attempts[0].SessionID || attempt.Prompt != running.Attempts[0].Prompt {
			t.Errorf("attempt = %+v, want the in-flight one kept", attempt)
		}
		if attempt.EndedAt == nil || *attempt.EndedAt != deps.Clock.Iso() {
			t.Errorf("endedAt = %v, want the clock's now", attempt.EndedAt)
		}
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeStopped {
			t.Errorf("outcome = %+v, want stopped", attempt.Outcome)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictStopped {
			t.Errorf("verdict = %v, want stopped", attempt.Verdict)
		}
	})
	t.Run("a decided job refuses the move", func(t *testing.T) {
		_, err := StopJob(deps, testkit.AJob(func(j *domain.Job) { j.State = domain.JobStateAccepted }))
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorLifecycle {
			t.Fatalf("StopJob() error = %v, want a lifecycle AppError", err)
		}
	})
}

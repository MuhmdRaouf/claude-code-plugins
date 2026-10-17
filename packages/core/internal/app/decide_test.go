package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The decide suite: accept, returnForFix, discard and stop over the shared fakes.

const decideID = "261006-decide"

var decideCommit = AcceptOptions{Mode: AcceptModeCommit, Force: false, Verify: true}

// decideWorld is newWorld plus the gates the land checks and regenerate rules run through.
type decideWorld struct {
	*appWorld
	gates *fakes.FakeGates
}

func newDecideWorld(t *testing.T) (Deps, *decideWorld) {
	t.Helper()
	deps, base := newWorld(t, nil)
	world := &decideWorld{appWorld: base, gates: fakes.NewFakeGates()}
	deps.Gates = world.gates
	base.deps = deps
	return deps, world
}

// reviewedAttempt is the finished pass attempt an awaiting_review job carries.
func reviewedAttempt(overrides ...func(*domain.Attempt)) domain.Attempt {
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	verification := testkit.AVerification(func(v *domain.Verification) {
		v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
	})
	pass := domain.VerdictPass
	endedAt := "2026-10-06T00:10:00.000Z"
	return testkit.AnAttempt(append([]func(*domain.Attempt){func(a *domain.Attempt) {
		a.SessionID = "s-1"
		a.EndedAt = &endedAt
		a.Outcome = &completed
		a.Report = fakes.VALID_CHANGE_REPORT
		a.Verification = &verification
		a.Verdict = &pass
	}}, overrides...)...)
}

// storedReview is the awaiting_review job the decisions run on: an edit job on the fake
// repository unless the brief names another mode, carrying one reviewed attempt.
func storedReview(w *decideWorld, briefOver func(*domain.Brief), overrides ...func(*domain.Job)) domain.Job {
	paths := w.store.Paths(decideID)
	brief := testkit.ABrief()
	if briefOver != nil {
		briefOver(&brief)
	}
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = decideID
		j.Brief = brief
		j.State = domain.JobStateAwaitingReview
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      fakes.BASE_SHA,
			ArtifactsDir: paths.Artifacts,
		}
		if brief.Mode == domain.ModeEdit {
			worktree, branch := paths.Worktree, "zai/"+decideID
			j.Workspace.Worktree, j.Workspace.Branch = &worktree, &branch
		}
		j.Attempts = []domain.Attempt{reviewedAttempt()}
	})
	for _, override := range overrides {
		override(&job)
	}
	return w.store.Put(job)
}

// currentReview is the job as stored.
func currentReview(t *testing.T, w *decideWorld) domain.Job {
	t.Helper()
	job, err := w.store.Get(context.Background(), decideID)
	if err != nil {
		t.Fatalf("job not stored: %v", err)
	}
	return job
}

// wantAppErr fails unless err is exactly the wanted AppError.
func wantAppErr(t *testing.T, err error, want *AppError) {
	t.Helper()
	var appErr *AppError
	if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
		t.Fatalf("error = %+v, want %+v", err, want)
	}
}

func TestAccept(t *testing.T) {
	ctx := context.Background()

	t.Run("edit + pass: commits on the job branch with title, summary and Worked-by trailer, fast-forwards the repository, removes worktree, state accepted with commit sha", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		job := storedReview(w, nil)

		result, err := Accept(ctx, deps, "261006-dec", decideCommit)

		if err != nil {
			t.Fatal(err)
		}
		worktree := w.store.Paths(decideID).Worktree
		if calls := w.git.Called("commitAll"); !reflect.DeepEqual(calls, [][]any{
			{worktree, "Rename the helper\n\nRenamed foo to bar\n\nWorked-by: glm-5.3 via zai\n", ports.CommitOptions{Verify: true}},
		}) {
			t.Errorf("commitAll calls = %v, want the one commit with the trailer", calls)
		}
		if calls := w.git.Called("fastForward"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", fakes.COMMIT_SHA, fakes.BASE_SHA},
		}) {
			t.Errorf("fastForward calls = %v, want the merge onto the base tip", calls)
		}
		if calls := w.git.Called("removeWorktree"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", worktree, "zai/" + decideID},
		}) {
			t.Errorf("removeWorktree calls = %v, want the decided job's workspace", calls)
		}
		if !reflect.DeepEqual(result, currentReview(t, w)) {
			t.Errorf("result = %+v, want the stored job %+v", result, currentReview(t, w))
		}
		current := currentReview(t, w)
		if current.State != domain.JobStateAccepted {
			t.Errorf("state = %s, want accepted", current.State)
		}
		wantDecision := &domain.Decision{
			Kind: domain.DecisionAccepted, At: "2026-10-06T00:00:00.000Z", Commit: strPtr(fakes.COMMIT_SHA),
		}
		if !reflect.DeepEqual(current.Decision, wantDecision) {
			t.Errorf("decision = %+v, want %+v", current.Decision, wantDecision)
		}
		if current.Version != job.Version+1 {
			t.Errorf("version = %d, want %d", current.Version, job.Version+1)
		}
	})

	t.Run("no_commit mode applies to the working tree and records no commit", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, AcceptOptions{Mode: AcceptModeNoCommit, Force: false, Verify: true})

		if err != nil {
			t.Fatal(err)
		}
		if calls := w.git.Called("applyToWorkingTree"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", w.store.Paths(decideID).Worktree, fakes.BASE_SHA},
		}) {
			t.Errorf("applyToWorkingTree calls = %v, want the one apply", calls)
		}
		if calls := w.git.Called("commitAll"); len(calls) != 0 {
			t.Errorf("commitAll calls = %v, want none", calls)
		}
		wantDecision := &domain.Decision{Kind: domain.DecisionAccepted, At: "2026-10-06T00:00:00.000Z"}
		if !reflect.DeepEqual(currentReview(t, w).Decision, wantDecision) {
			t.Errorf("decision = %+v, want the commitless acceptance", currentReview(t, w).Decision)
		}
	})

	t.Run("land conflict → land_conflict error, job still awaiting_review, worktree kept", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		w.git.Ancestor = false
		w.git.RebaseErr = &ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"src/a.ts"}}
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorLandConflict, Paths: []string{"src/a.ts"}})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
		if calls := w.git.Called("removeWorktree"); len(calls) != 0 {
			t.Errorf("removeWorktree calls = %v, want none", calls)
		}
		release, lockErr := w.store.Lock(ctx, decideID, int64(os.Getpid()))
		if lockErr != nil {
			t.Errorf("the lock should be free again: %v", lockErr)
		}
		release()
	})

	t.Run("a retried accept after a conflict lands the commit already on the job branch instead of committing again", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.WorktreeHead = fakes.COMMIT_SHA
		storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		if err != nil {
			t.Fatal(err)
		}
		if calls := w.git.Called("commitAll"); len(calls) != 0 {
			t.Errorf("commitAll calls = %v, want none", calls)
		}
		if calls := w.git.Called("fastForward"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", fakes.COMMIT_SHA, fakes.BASE_SHA},
		}) {
			t.Errorf("fastForward calls = %v, want the commit already on the branch", calls)
		}
		if currentReview(t, w).State != domain.JobStateAccepted {
			t.Errorf("state = %s, want accepted", currentReview(t, w).State)
		}
	})

	t.Run("a failing commit hook fails accept cleanly: job stays awaiting_review, the hook output is in the error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		hook := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git commit", Stderr: "lint: 2 problems"}
		w.git.CommitErr = hook
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)
		_, skipped := Accept(ctx, deps, decideID, AcceptOptions{Mode: AcceptModeCommit, Force: false, Verify: false})

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: hook})
		if calls := w.git.Called("fastForward"); len(calls) != 0 {
			t.Errorf("fastForward calls = %v, want none", calls)
		}
		var verifies []any
		for _, call := range w.git.Called("commitAll") {
			verifies = append(verifies, call[2])
		}
		if !reflect.DeepEqual(verifies, []any{ports.CommitOptions{Verify: true}, ports.CommitOptions{Verify: false}}) {
			t.Errorf("commitAll options = %v, want the hook first honoured then skipped", verifies)
		}
		if skipped == nil {
			t.Error("the hook-skipped accept should fail too")
		}
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
	})

	t.Run("no_commit: an apply failure is a git error, the job stays in review", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		failure := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git apply", Stderr: "patch does not apply"}
		w.git.ApplyErr = failure
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, AcceptOptions{Mode: AcceptModeNoCommit, Force: false, Verify: true})

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: failure})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
		if calls := w.git.Called("removeWorktree"); len(calls) != 0 {
			t.Errorf("removeWorktree calls = %v, want none", calls)
		}
	})

	t.Run("a trailer setting that cannot be read fails before anything is committed", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		failure := &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git config --get zai.trailer", Stderr: "bad config",
		}
		w.git.TrailerErr = failure
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: failure})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
		if calls := w.git.Called("commitAll"); len(calls) != 0 {
			t.Errorf("commitAll calls = %v, want none", calls)
		}
	})

	t.Run("a rebase failure that is not a conflict is a git error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		w.git.Ancestor = false
		failure := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git rebase", Stderr: "cannot rebase"}
		w.git.RebaseErr = failure
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: failure})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
	})

	t.Run("a regenerate command whose amend fails lands nothing", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/gen.ts"} })
		failure := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git commit --amend", Stderr: "hook refused"}
		w.git.AmendErr = failure
		brief := testkit.ABrief()
		if err := json.Unmarshal([]byte(`{"regenerate":[{"paths":["src/gen.ts"],"run":"npm run gen"}]}`), &brief); err != nil {
			t.Fatal(err)
		}
		job := storedReview(w, func(b *domain.Brief) { *b = brief })

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: failure})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
		if calls := w.git.Called("fastForward"); len(calls) != 0 {
			t.Errorf("fastForward calls = %v, want none", calls)
		}
	})

	t.Run("a temporary checkout that cannot be added fails the landing", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		failure := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git worktree add", Stderr: "bad sha"}
		w.git.AddDetachedErr = failure
		job := storedReview(w, func(b *domain.Brief) {
			b.Gates = []domain.Gate{{Run: "npm test", TimeoutMs: 600_000}}
		})

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: failure})
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
		// There is nothing to remove yet, so nothing is reported either.
		if calls := w.git.Called("removeDetachedWorktree"); len(calls) != 0 {
			t.Errorf("removeDetachedWorktree calls = %v, want none", calls)
		}
	})

	t.Run("a temporary checkout that cannot be removed is reported, the landing stands", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		w.git.RemoveDetachedErr = &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git worktree remove", Stderr: "busy",
		}
		storedReview(w, func(b *domain.Brief) {
			b.Gates = []domain.Gate{{Run: "npm test", TimeoutMs: 600_000}}
		})

		_, err := Accept(ctx, deps, decideID, decideCommit)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(w.out.Errors, []string{
			"zai: job " + decideID + ": its temporary checkout could not be removed: git worktree remove: busy",
		}) {
			t.Errorf("errors = %v, want the checkout reported", w.out.Errors)
		}
	})

	t.Run("a tip that moves three times while landing gives up as a git error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		w.git.Landing = ports.FastForwardMoved
		job := storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: &ports.GitError{
			Kind:    ports.GitErrorGitFailed,
			Command: "git merge --ff-only",
			Stderr:  "the branch tip moved 3 times while landing; try again",
		}})
		if calls := w.git.Called("fastForward"); len(calls) != 3 {
			t.Errorf("fastForward calls = %d, want three rounds", len(calls))
		}
		if !reflect.DeepEqual(currentReview(t, w), job) {
			t.Errorf("stored job = %+v, want it unchanged %+v", currentReview(t, w), job)
		}
	})

	t.Run("an edit job that changed nothing is accepted without a commit", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		if err != nil {
			t.Fatal(err)
		}
		if calls := w.git.Called("commitAll"); len(calls) != 0 {
			t.Errorf("commitAll calls = %v, want none", calls)
		}
		if calls := w.git.Called("fastForward"); len(calls) != 0 {
			t.Errorf("fastForward calls = %v, want none", calls)
		}
		wantDecision := &domain.Decision{Kind: domain.DecisionAccepted, At: "2026-10-06T00:00:00.000Z"}
		if !reflect.DeepEqual(currentReview(t, w).Decision, wantDecision) {
			t.Errorf("decision = %+v, want the commitless acceptance", currentReview(t, w).Decision)
		}
	})

	t.Run("non-pass verdict requires force", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		gateFail := domain.VerdictGateFail
		storedReview(w, nil, func(j *domain.Job) {
			j.Attempts = []domain.Attempt{reviewedAttempt(func(a *domain.Attempt) { a.Verdict = &gateFail })}
		})

		_, refused := Accept(ctx, deps, decideID, decideCommit)
		forced, err := Accept(ctx, deps, decideID, AcceptOptions{Mode: AcceptModeCommit, Force: true, Verify: true})

		wantAppErr(t, refused, &AppError{Kind: AppErrorNotPass, ID: decideID, Verdict: &gateFail})
		if err != nil || forced.State != domain.JobStateAccepted {
			t.Errorf("forced accept = (%s, %v), want accepted", forced.State, err)
		}
	})

	t.Run("exec/readonly: accepted without git operations", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, func(b *domain.Brief) { b.Mode = domain.ModeExec; b.Scope = []string{} })

		result, err := Accept(ctx, deps, decideID, decideCommit)

		if err != nil || result.State != domain.JobStateAccepted {
			t.Errorf("accept = (%s, %v), want accepted", result.State, err)
		}
		if len(w.git.Calls) != 0 {
			t.Errorf("git calls = %v, want none", w.git.Calls)
		}
	})

	t.Run("wrong state → wrong_state naming allowed states", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateRunning })

		_, err := Accept(ctx, deps, decideID, decideCommit)
		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateRunning,
			Allowed: []domain.JobState{domain.JobStateAwaitingReview},
		})

		_, err = Accept(ctx, deps, "nope", decideCommit)
		wantAppErr(t, err, &AppError{
			Kind: AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: "nope"},
		})
	})

	t.Run("a worktree that cannot be removed is reported, the acceptance stands", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		w.git.RemoveWorktreeErr = &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git worktree remove", Stderr: "busy",
		}
		storedReview(w, nil)

		_, err := Accept(ctx, deps, decideID, decideCommit)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(w.out.Errors, []string{
			"zai: job " + decideID + " is accepted, but its worktree could not be removed: git worktree remove: busy",
		}) {
			t.Errorf("errors = %v, want the worktree reported", w.out.Errors)
		}
	})
}

func TestReturnForFix(t *testing.T) {
	ctx := context.Background()

	t.Run("awaiting_review → queued with the feedback recorded for the next review_fix attempt", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		job := storedReview(w, nil)
		paths := w.store.Paths(decideID)
		if err := os.WriteFile(paths.Stop, nil, 0o644); err != nil {
			t.Fatal(err)
		}

		result, err := ReturnForFix(ctx, deps, decideID, "  Also rename the tests.  ")

		if err != nil {
			t.Fatal(err)
		}
		last := job.Attempts[0]
		if !reflect.DeepEqual(result, currentReview(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		current := currentReview(t, w)
		if current.State != domain.JobStateQueued {
			t.Errorf("state = %s, want queued", current.State)
		}
		wantAttempt := domain.Attempt{
			N:         2,
			Kind:      domain.AttemptKindReviewFix,
			Feedback:  strPtr("Also rename the tests."),
			Prompt:    domain.ReviewFixPrompt(job.Brief, last, "Also rename the tests."),
			SessionID: "s-1",
			StartedAt: "2026-10-06T00:00:00.000Z",
		}
		if len(current.Attempts) != 2 || !reflect.DeepEqual(current.Attempts[1], wantAttempt) {
			t.Errorf("attempt 2 = %+v, want %+v", current.Attempts, wantAttempt)
		}
		if w.files.StopRequested(ctx, paths) {
			t.Error("a stale stop request should not stop the run the reviewer just asked for")
		}
	})

	t.Run("empty or whitespace feedback → empty_feedback", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)

		_, err := ReturnForFix(ctx, deps, decideID, "")
		wantAppErr(t, err, &AppError{Kind: AppErrorEmptyFeedback})
		_, err = ReturnForFix(ctx, deps, decideID, " \n\t")
		wantAppErr(t, err, &AppError{Kind: AppErrorEmptyFeedback})
		if currentReview(t, w).State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", currentReview(t, w).State)
		}
	})

	t.Run("only an awaiting_review job can be returned", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateAccepted })

		_, err := ReturnForFix(ctx, deps, decideID, "more")
		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateAccepted,
			Allowed: []domain.JobState{domain.JobStateAwaitingReview},
		})
	})
}

func TestDiscardAndStop(t *testing.T) {
	ctx := context.Background()

	t.Run("discard stops a live driver, removes the worktree, keeps logs, state discarded with reason", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) {
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		})
		paths := w.store.Paths(decideID)
		if err := os.WriteFile(paths.AttemptLog(1), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		release, err := w.store.Lock(ctx, decideID, 4242)
		if err != nil {
			t.Fatal(err)
		}
		w.process.MarkAlive(4242)
		// A long grace, so the simulated driver below always answers in time on a loaded machine.
		patient := deps
		patient.Config.StopGraceMs = 600_000

		type discardOutcome struct {
			job domain.Job
			err error
		}
		done := make(chan discardOutcome, 1)
		go func() {
			reason := "wrong approach"
			job, err := Discard(ctx, patient, decideID, &reason)
			done <- discardOutcome{job: job, err: err}
		}()
		// The driver honours the stop request: lands the job in awaiting_review and lets go of its lock.
		if err := testkit.Until(t, func() bool { return w.files.StopRequested(ctx, paths) },
			testkit.UntilOptions{Message: "the stop request never appeared"}); err != nil {
			t.Fatal(err)
		}
		landed := currentReview(t, w)
		landed.State = domain.JobStateAwaitingReview
		w.store.Put(landed)
		release()
		result := <-done

		if result.err != nil {
			t.Fatal(result.err)
		}
		if !reflect.DeepEqual(result.job, currentReview(t, w)) {
			t.Errorf("result = %+v, want the stored job %+v", result.job, currentReview(t, w))
		}
		current := currentReview(t, w)
		if current.State != domain.JobStateDiscarded {
			t.Errorf("state = %s, want discarded", current.State)
		}
		// The clock moved while the stop grace ran out its polling, so only the decision's shape is
		// pinned here.
		if current.Decision == nil || current.Decision.Kind != domain.DecisionDiscarded ||
			current.Decision.Reason == nil || *current.Decision.Reason != "wrong approach" {
			t.Errorf("decision = %+v, want the discard with its reason", current.Decision)
		}
		if calls := w.git.Called("removeWorktree"); !reflect.DeepEqual(calls, [][]any{
			{"/repo", paths.Worktree, "zai/" + decideID},
		}) {
			t.Errorf("removeWorktree calls = %v, want the decided job's workspace", calls)
		}
		if _, err := os.Stat(paths.AttemptLog(1)); err != nil {
			t.Errorf("the attempt log should be kept: %v", err)
		}
		if terminated := w.process.Terminated(); len(terminated) != 0 {
			t.Errorf("terminated = %v, want none: the driver answered", terminated)
		}
	})

	t.Run("discard of a job whose driver died needs no stop; without a reason none is recorded", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, func(b *domain.Brief) { b.Mode = domain.ModeReadonly; b.Scope = []string{} },
			func(j *domain.Job) { j.State = domain.JobStateVerifying })

		result, err := Discard(ctx, deps, decideID, nil)

		if err != nil {
			t.Fatal(err)
		}
		wantDecision := &domain.Decision{Kind: domain.DecisionDiscarded, At: "2026-10-06T00:00:00.000Z"}
		if !reflect.DeepEqual(result.Decision, wantDecision) {
			t.Errorf("decision = %+v, want the reasonless discard", result.Decision)
		}
		if len(w.git.Calls) != 0 {
			t.Errorf("git calls = %v, want none", w.git.Calls)
		}
	})

	t.Run("a driver that ignores the stop request is terminated; still holding the lock is an error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) {
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		})
		release, err := w.store.Lock(ctx, decideID, 4242)
		if err != nil {
			t.Fatal(err)
		}
		defer release()

		reason := "stuck"
		_, err = Discard(ctx, deps, decideID, &reason)

		if terminated := w.process.Terminated(); !reflect.DeepEqual(terminated, []int64{4242}) {
			t.Errorf("terminated = %v, want the holder", terminated)
		}
		wantAppErr(t, err, &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorLocked, ID: decideID, HolderPid: 4242,
		}})
		if currentReview(t, w).State != domain.JobStateRunning {
			t.Errorf("state = %s, want running", currentReview(t, w).State)
		}
	})

	t.Run("decided jobs cannot be discarded", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateDiscarded })

		_, err := Discard(ctx, deps, decideID, nil)
		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateDiscarded,
			Allowed: []domain.JobState{
				domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying, domain.JobStateAwaitingReview,
			},
		})
	})

	t.Run("stop writes the stop request; a queued job goes straight to awaiting_review with verdict stopped", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		running := storedReview(w, nil, func(j *domain.Job) {
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		})
		release, err := w.store.Lock(ctx, decideID, 4242)
		if err != nil {
			t.Fatal(err)
		}

		requested, err := Stop(ctx, deps, decideID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(requested, running) {
			t.Errorf("result = %+v, want the job as found %+v", requested, running)
		}
		paths := w.store.Paths(decideID)
		if !w.files.StopRequested(ctx, paths) {
			t.Error("the stop request should be written for the live driver")
		}
		release()

		idleDeps, idle := newDecideWorld(t)
		storedReview(idle, nil, func(j *domain.Job) {
			j.State = domain.JobStateQueued
			j.Attempts = []domain.Attempt{}
		})

		stopped, err := Stop(ctx, idleDeps, decideID)

		if err != nil {
			t.Fatal(err)
		}
		if stopped.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stopped.State)
		}
		wantAttempt := domain.Attempt{
			N:         1,
			Kind:      domain.AttemptKindInitial,
			Prompt:    domain.InitialPrompt(stopped.Brief, stopped.Workspace.ArtifactsDir, idleDeps.Provider),
			SessionID: "00000000-0000-4000-8000-000000000001",
			StartedAt: "2026-10-06T00:00:00.000Z",
			EndedAt:   strPtr("2026-10-06T00:00:00.000Z"),
			Outcome:   &domain.WorkerOutcome{Kind: domain.WorkerOutcomeStopped},
			Verdict:   strPtr(domain.VerdictStopped),
		}
		if len(stopped.Attempts) != 1 || !reflect.DeepEqual(stopped.Attempts[0], wantAttempt) {
			t.Errorf("attempts = %+v, want the stopped first attempt %+v", stopped.Attempts, wantAttempt)
		}
		if idle.files.StopRequested(ctx, idle.store.Paths(decideID)) {
			t.Error("the stop request should be consumed")
		}
	})

	t.Run("stop of a running job whose driver died closes the attempt in flight as stopped", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) {
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) { a.Prompt = "do it" })}
		})

		result, err := Stop(ctx, deps, decideID)

		if err != nil {
			t.Fatal(err)
		}
		wantAttempt := testkit.AnAttempt(
			func(a *domain.Attempt) { a.Prompt = "do it" },
			func(a *domain.Attempt) { a.EndedAt = strPtr("2026-10-06T00:00:00.000Z") },
			func(a *domain.Attempt) { a.Outcome = &domain.WorkerOutcome{Kind: domain.WorkerOutcomeStopped} },
			func(a *domain.Attempt) { a.Verdict = strPtr(domain.VerdictStopped) },
		)
		if len(result.Attempts) != 1 || !reflect.DeepEqual(result.Attempts[0], wantAttempt) {
			t.Errorf("attempts = %+v, want the closed attempt %+v", result.Attempts, wantAttempt)
		}
	})

	t.Run("only queued, running or verifying jobs can be stopped", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)

		_, err := Stop(ctx, deps, decideID)
		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateAwaitingReview,
			Allowed: []domain.JobState{domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying},
		})
		if w.files.StopRequested(ctx, w.store.Paths(decideID)) {
			t.Error("no stop request should be written")
		}
	})
}

// The failure paths the happy cases leave to the layers below: a store or a job's files refusing,
// a job that moves under a decision, and a repository that breaks mid-landing. They hold the same
// behaviour directly, as the attempts tests do.

// breakingGit is the fake git whose Resolve or Changes fails from its nth call (1-based; 0 never),
// as a repository breaking mid-accept does.
type breakingGit struct {
	*fakes.FakeGit
	failResolve, failChanges   int
	resolveCalls, changesCalls int
	failure                    *ports.GitError
}

func (g *breakingGit) Resolve(ctx context.Context, repo string, ref string) (string, error) {
	g.resolveCalls++
	if g.failResolve != 0 && g.resolveCalls >= g.failResolve {
		return "", g.failure
	}
	return g.FakeGit.Resolve(ctx, repo, ref)
}

func (g *breakingGit) Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error) {
	g.changesCalls++
	if g.failChanges != 0 && g.changesCalls >= g.failChanges {
		return domain.ChangeSet{}, g.failure
	}
	return g.FakeGit.Changes(ctx, dir, baseSha)
}

// movedAgainStore answers the second Find with the job moved elsewhere, as a driver that moved the
// job between a decision's two reads does.
type movedAgainStore struct {
	*fakes.MemoryStore
	moved func(job domain.Job) domain.Job
	calls int
}

func (s *movedAgainStore) Find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	s.calls++
	job, err := s.MemoryStore.Find(ctx, idOrPrefix)
	if err != nil || s.calls < 2 {
		return job, err
	}
	return s.moved(job), nil
}

// lockRefusingStore is the memory store whose Lock fails with the store's own error.
type lockRefusingStore struct {
	*fakes.MemoryStore
}

func (s *lockRefusingStore) Lock(ctx context.Context, id string, pid int64) (func(), error) {
	return nil, &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}
}

// failingUpdateStore is the memory store whose next Update fails.
type failingUpdateStore struct {
	*fakes.MemoryStore
	failure *ports.StoreError
}

func (s *failingUpdateStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	if s.failure != nil {
		failure := s.failure
		s.failure = nil
		return domain.Job{}, failure
	}
	return s.MemoryStore.Update(ctx, job)
}

// clearRefusingFiles is the test files with a stop request that cannot be cleared.
type clearRefusingFiles struct{ *testFiles }

func (f clearRefusingFiles) ClearStop(ctx context.Context, paths domain.JobPaths) error {
	return errors.New("no clear")
}

func TestDecideFailurePaths(t *testing.T) {
	ctx := context.Background()

	t.Run("a job that moves between a decision's two reads is a wrong_state error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)
		deps.Store = &movedAgainStore{MemoryStore: w.store, moved: func(job domain.Job) domain.Job {
			job.State = domain.JobStateAccepted
			return job
		}}

		_, err := Accept(ctx, deps, decideID, decideCommit)

		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateAccepted,
			Allowed: []domain.JobState{domain.JobStateAwaitingReview},
		})
	})

	t.Run("a returned job whose stop file cannot be cleared fails the return", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)
		deps.Files = clearRefusingFiles{w.files}

		_, err := ReturnForFix(ctx, deps, decideID, "again")

		if err == nil || err.Error() != "no clear" {
			t.Errorf("error = %v, want the clear's own failure", err)
		}
		if state := currentReview(t, w).State; state != domain.JobStateQueued {
			t.Errorf("state = %s, want the return recorded", state)
		}
	})

	t.Run("a job with no attempt returns with a fresh session and the feedback as its prompt", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.Attempts = []domain.Attempt{} })

		returned, err := ReturnForFix(ctx, deps, decideID, "start over")

		if err != nil {
			t.Fatal(err)
		}
		if returned.State != domain.JobStateQueued || len(returned.Attempts) != 1 {
			t.Fatalf("job = (%s, %d attempts), want the queued review_fix", returned.State, len(returned.Attempts))
		}
		attempt := returned.Attempts[0]
		if attempt.Prompt != "start over" || attempt.SessionID != "00000000-0000-4000-8000-000000000001" {
			t.Errorf("attempt = (%q, %s), want the feedback as the prompt in a fresh session", attempt.Prompt, attempt.SessionID)
		}
	})

	t.Run("a discard whose decision cannot be stored fails without removing the worktree", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateRunning })
		deps.Store = &failingUpdateStore{MemoryStore: w.store, failure: &ports.StoreError{
			Kind: ports.StoreErrorIO, Message: "disk full",
		}}

		_, err := Discard(ctx, deps, decideID, strPtr("wrong approach"))

		wantAppErr(t, err, &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorIO, Message: "disk full",
		}})
		if calls := w.git.Called("removeWorktree"); len(calls) != 0 {
			t.Errorf("removeWorktree calls = %v, want none", calls)
		}
	})

	t.Run("a discard whose stop file cannot be cleared fails after the decision", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil)
		deps.Files = clearRefusingFiles{w.files}

		_, err := Discard(ctx, deps, decideID, nil)

		if err == nil || err.Error() != "no clear" {
			t.Errorf("error = %v, want the clear's own failure", err)
		}
		if state := currentReview(t, w).State; state != domain.JobStateDiscarded {
			t.Errorf("state = %s, want the discard recorded", state)
		}
	})

	t.Run("a stop whose request cannot be written fails before anything is stopped", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateRunning })
		deps.Files = stopRefusingFiles{w.files}

		_, err := Stop(ctx, deps, decideID)

		if err == nil || err.Error() != "no stop file" {
			t.Errorf("error = %v, want the request's own failure", err)
		}
	})

	t.Run("a stop whose lock fails outside a live holder is a store error", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateRunning })
		deps.Store = &lockRefusingStore{MemoryStore: w.store}

		_, err := Stop(ctx, deps, decideID)

		wantAppErr(t, err, &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorIO, Message: "disk full",
		}})
	})

	t.Run("a stop of a job that reached review on its own reports the state it found", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateRunning })
		deps.Store = &movedAgainStore{MemoryStore: w.store, moved: func(job domain.Job) domain.Job {
			job.State = domain.JobStateAwaitingReview
			return job
		}}

		_, err := Stop(ctx, deps, decideID)

		wantAppErr(t, err, &AppError{
			Kind: AppErrorWrongState, ID: decideID, State: domain.JobStateAwaitingReview,
			Allowed: []domain.JobState{domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying},
		})
		if w.files.StopRequested(ctx, w.store.Paths(decideID)) {
			t.Error("the stop request should be cleared through the error path")
		}
	})

	t.Run("an event the stored state does not accept fails the decision", func(t *testing.T) {
		deps, w := newDecideWorld(t)
		job := storedReview(w, nil, func(j *domain.Job) { j.State = domain.JobStateQueued })

		_, err := decided(ctx, deps, job, domain.JobEvent{Type: domain.EventAccepted}, domain.Decision{})

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorLifecycle {
			t.Fatalf("error = %+v, want a lifecycle error", err)
		}
		if state := currentReview(t, w).State; state != domain.JobStateQueued {
			t.Errorf("state = %s, want the job untouched", state)
		}
	})

	t.Run("a repository that breaks mid-landing fails the accept with its git error", func(t *testing.T) {
		breaks := []struct {
			name        string
			failResolve int
			failChanges int
		}{
			{"the worktree's head cannot be resolved", 1, 0},
			{"the pending change set cannot be read", 0, 1},
			{"the branch head cannot be re-read before the round", 2, 0},
			{"the repository's tip cannot be resolved", 3, 0},
			{"the amended head cannot be resolved", 4, 0},
			{"the regenerated change set cannot be read", 0, 2},
		}
		for _, breakPoint := range breaks {
			t.Run(breakPoint.name, func(t *testing.T) {
				deps, w := newDecideWorld(t)
				w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
				w.git.Ancestor = false
				storedReview(w, nil)
				broken := &breakingGit{
					FakeGit: w.git, failResolve: breakPoint.failResolve, failChanges: breakPoint.failChanges,
					failure: &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git rev-parse", Stderr: "broken"},
				}
				deps.Git = broken

				_, err := Accept(ctx, deps, decideID, decideCommit)

				wantAppErr(t, err, &AppError{Kind: AppErrorGit, GitError: broken.failure})
				if state := currentReview(t, w).State; state != domain.JobStateAwaitingReview {
					t.Errorf("state = %s, want the job still in review", state)
				}
			})
		}
	})
}

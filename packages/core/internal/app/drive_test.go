package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The drive suite (core's and zai's): the drive loop over the reference worker, on the shared
// fakes.

const driveID = "261006-drive1"

// gated is the brief the gate tests run: one npm test gate.
func gated(b *domain.Brief) {
	b.Gates = []domain.Gate{{Run: "npm test", TimeoutMs: 60_000}}
}

// driveWorld is newWorld's, plus the gates and semaphore the drive tests read.
type driveWorld struct {
	*appWorld
	gates     *fakes.FakeGates
	semaphore *fakes.FakeSemaphore
}

// workerWorld is what a drive test swaps in: the provider and the worker's dialect.
type workerWorld struct {
	provider *domain.Provider
	dialect  *fakes.WorkerDialect
}

// newDriveWorld builds the drive world: newWorld with the worker playing scripts (the last
// repeats; none means the one completed run), over the provider and the dialect a world names.
func newDriveWorld(t *testing.T, scripts []fakes.WorkerScript, env map[string]string, world workerWorld) (Deps, *driveWorld) {
	t.Helper()
	deps, base := newWorld(t, env)
	if len(scripts) == 0 {
		scripts = []fakes.WorkerScript{fakes.Completes()}
	}
	if world.dialect != nil {
		base.worker = fakes.NewScriptedWorkerInDialect(*world.dialect, t, base.process.FakeProcess, scripts...)
	} else {
		base.worker = fakes.NewScriptedWorker(t, base.process.FakeProcess, scripts...)
	}
	w := &driveWorld{appWorld: base, gates: fakes.NewFakeGates(), semaphore: fakes.NewFakeSemaphore()}
	deps.Worker = base.worker
	deps.Gates = w.gates
	deps.Semaphore = w.semaphore
	if world.provider != nil {
		deps.Provider = *world.provider
	}
	base.deps = deps
	// The fake git always reports the one modified file.
	base.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
	return deps, w
}

// queuedDriveJob is a queued job in the fake store, its artifacts dir under the fake state root.
func queuedDriveJob(w *driveWorld, brief func(*domain.Brief), overrides ...func(*domain.Job)) domain.Job {
	paths := w.store.Paths(driveID)
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = driveID
		j.Brief = testkit.ABrief()
		if brief != nil {
			brief(&j.Brief)
		}
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      strings.Repeat("b", 40),
			ArtifactsDir: paths.Artifacts,
		}
		if j.Brief.Mode == domain.ModeEdit {
			worktree, branch := paths.Worktree, "zai/"+driveID
			j.Workspace.Worktree, j.Workspace.Branch = &worktree, &branch
		}
	})
	for _, override := range overrides {
		override(&job)
	}
	return w.store.Put(job)
}

// storedDrive is the job as stored.
func storedDrive(t *testing.T, w *driveWorld) domain.Job {
	t.Helper()
	job, err := w.store.Get(context.Background(), driveID)
	if err != nil {
		t.Fatalf("job not stored: %v", err)
	}
	return job
}

// driveAttempt is attempt n as stored.
func driveAttempt(t *testing.T, w *driveWorld, n int) domain.Attempt {
	t.Helper()
	job := storedDrive(t, w)
	if n < 1 || n > len(job.Attempts) {
		t.Fatalf("no attempt %d", n)
	}
	return job.Attempts[n-1]
}

// driveResult is a background drive's outcome, reported when its run ends.
type driveResult struct {
	job domain.Job
	err error
}

// driveInBackground starts Drive on the job and reports when it ends; cancelling ends its stop
// signal only.
func driveInBackground(deps Deps, id string) (chan driveResult, context.CancelFunc) {
	external, cancel := context.WithCancel(context.Background())
	done := make(chan driveResult, 1)
	go func() {
		job, err := Drive(external, deps, id)
		done <- driveResult{job: job, err: err}
	}()
	return done, cancel
}

// driveVerdicts is every attempt's kind and verdict, one pair per attempt.
func driveVerdicts(t *testing.T, job domain.Job) [][2]any {
	t.Helper()
	pairs := make([][2]any, 0, len(job.Attempts))
	for _, attempt := range job.Attempts {
		verdict := any(nil)
		if attempt.Verdict != nil {
			verdict = *attempt.Verdict
		}
		pairs = append(pairs, [2]any{attempt.Kind, verdict})
	}
	return pairs
}

func TestDrive(t *testing.T) {
	t.Run("happy path: queued → running → verifying → awaiting_review with verdict pass, one attempt persisted", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		job := queuedDriveJob(w, gated)
		paths := w.store.Paths(driveID)

		result, err := Drive(context.Background(), deps, driveID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result, storedDrive(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		stored := storedDrive(t, w)
		if stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		if len(stored.Attempts) != 1 {
			t.Fatalf("attempts = %d, want one", len(stored.Attempts))
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.N != 1 || attempt.Kind != domain.AttemptKindInitial {
			t.Errorf("attempt = (%d, %s), want (1, initial)", attempt.N, attempt.Kind)
		}
		if want := domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider); attempt.Prompt != want {
			t.Errorf("prompt = %q, want the initial prompt", attempt.Prompt)
		}
		if attempt.SessionID != "00000000-0000-4000-8000-000000000001" {
			t.Errorf("sessionId = %s, want the first fake session", attempt.SessionID)
		}
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeCompleted {
			t.Errorf("outcome = %+v, want completed", attempt.Outcome)
		}
		wantUsage := domain.Usage{
			Turns: 2, InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10,
			CostUSD: 0.01, RateLimitRetries: 0, DurationMs: 1500,
		}
		if attempt.Usage == nil || !reflect.DeepEqual(*attempt.Usage, wantUsage) {
			t.Errorf("usage = %+v, want %+v", attempt.Usage, wantUsage)
		}
		var summary struct {
			Summary string `json:"summary"`
		}
		if err := json.Unmarshal(attempt.Report, &summary); err != nil || summary.Summary != "Renamed foo to bar" {
			t.Errorf("report = %s (%v), want the change report", attempt.Report, err)
		}
		if attempt.Verification == nil {
			t.Fatal("no verification")
		}
		verification := attempt.Verification
		exitZero := int64(0)
		if len(verification.Gates) != 1 || verification.Gates[0].Run != "npm test" ||
			verification.Gates[0].ExitCode == nil || *verification.Gates[0].ExitCode != exitZero {
			t.Errorf("gates = %+v, want npm test passing", verification.Gates)
		}
		wantChanges := testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		if !reflect.DeepEqual(verification.Changes, wantChanges) {
			t.Errorf("changes = %+v, want %+v", verification.Changes, wantChanges)
		}
		if !reflect.DeepEqual(verification.Scope, testkit.AScopeCheck()) {
			t.Errorf("scope = %+v, want the unchanged check", verification.Scope)
		}
		if !reflect.DeepEqual(verification.Report, testkit.AReportCheck()) {
			t.Errorf("report check = %+v, want the valid one", verification.Report)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictPass {
			t.Errorf("verdict = %v, want pass", attempt.Verdict)
		}
		if attempt.EndedAt == nil {
			t.Error("endedAt should be set")
		}
		spec := w.worker.Specs()[0]
		if spec.Cwd != *job.Workspace.Worktree {
			t.Errorf("cwd = %s, want the worktree", spec.Cwd)
		}
		if spec.Model.Tier != domain.ModelTierMain || spec.Model.ID != "glm-5.3" {
			t.Errorf("model = %+v, want the catalog's main tier", spec.Model)
		}
		if spec.Access != ports.AccessWrite {
			t.Errorf("access = %s, want write", spec.Access)
		}
		if spec.Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000001"}) {
			t.Errorf("session = %+v, want a new one under the attempt's key", spec.Session)
		}
		if spec.LogPath != paths.AttemptLog(1) {
			t.Errorf("logPath = %s, want %s", spec.LogPath, paths.AttemptLog(1))
		}
		if spec.TimeoutMs != job.Brief.TimeoutMs {
			t.Errorf("timeoutMs = %d, want the brief's", spec.TimeoutMs)
		}
		wantEnv := map[string]string{"ZAI_ARTIFACTS": job.Workspace.ArtifactsDir}
		wantCall := fakes.GateCall{Cwd: *job.Workspace.Worktree, Run: "npm test",
			PassEnv: wantEnv, LogPath: paths.GateLog(1, 0)}
		if !reflect.DeepEqual(w.gates.Calls, []fakes.GateCall{wantCall}) {
			t.Errorf("gate calls = %+v, want %+v", w.gates.Calls, wantCall)
		}
	})

	t.Run("persists state transitions in order (store sees running before verifying before awaiting_review)", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, gated)
		// Every successful write's version, in write order (the incoming job's + 1, as the store
		// writes it).
		var versions []int64
		w.store.BeforeUpdate = func(job domain.Job) { versions = append(versions, job.Version+1) }

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if want := []string{"running", "verifying", "awaiting_review"}; !reflect.DeepEqual(w.store.States(driveID), want) {
			t.Errorf("states = %v, want %v", w.store.States(driveID), want)
		}
		if want := []int64{1, 2, 3}; !reflect.DeepEqual(versions, want) {
			t.Errorf("write versions = %v, want %v", versions, want)
		}
	})

	t.Run("gate failure with fix budget → second attempt kind auto_fix resuming the same session with autoFixPrompt", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{fakes.Completes(), fakes.Completes()}, nil, workerWorld{})
		w.gates.FailOnce("npm test", "expected 2, got 1")
		job := queuedDriveJob(w, gated)

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		specs := w.worker.Specs()
		if len(specs) != 2 {
			t.Fatalf("specs = %d, want two", len(specs))
		}
		wantVerdicts := [][2]any{
			{domain.AttemptKindInitial, domain.Verdict(domain.VerdictGateFail)},
			{domain.AttemptKindAutoFix, domain.Verdict(domain.VerdictPass)},
		}
		if got := driveVerdicts(t, storedDrive(t, w)); !reflect.DeepEqual(got, wantVerdicts) {
			t.Errorf("attempts = %v, want %v", got, wantVerdicts)
		}
		if specs[1].Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: specs[0].Session.Key}) {
			t.Errorf("fix session = %+v, want a resume of the first", specs[1].Session)
		}
		wantPrompt := domain.AutoFixPrompt(job.Brief, driveAttempt(t, w, 1), domain.DefaultLimits)
		if specs[1].Prompt != wantPrompt {
			t.Errorf("fix prompt = %q, want the auto-fix prompt", specs[1].Prompt)
		}
		if !strings.Contains(specs[1].Prompt, "expected 2, got 1") {
			t.Errorf("fix prompt = %q, want the gate's tail in it", specs[1].Prompt)
		}
		wantStates := []string{"running", "verifying", "running", "verifying", "awaiting_review"}
		if !reflect.DeepEqual(w.store.States(driveID), wantStates) {
			t.Errorf("states = %v, want %v", w.store.States(driveID), wantStates)
		}
	})

	t.Run("fix budget exhausted → awaiting_review with gate_fail", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		failed := int64(1)
		w.gates.Results["npm test"] = []fakes.GateAnswer{{ExitCode: &failed, Tail: "still failing"}}
		queuedDriveJob(w, func(b *domain.Brief) {
			gated(b)
			b.Retries = domain.Retries{Fix: 1, Infra: 2}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		stored := storedDrive(t, w)
		if stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		wantVerdicts := [][2]any{
			{domain.AttemptKindInitial, domain.Verdict(domain.VerdictGateFail)},
			{domain.AttemptKindAutoFix, domain.Verdict(domain.VerdictGateFail)},
		}
		if got := driveVerdicts(t, stored); !reflect.DeepEqual(got, wantVerdicts) {
			t.Errorf("attempts = %v, want %v", got, wantVerdicts)
		}
	})

	t.Run("api_error (429 exhausted) → infra_retry with a NEW session and the initial prompt, then pass", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Fixture: "rate-limited-429.jsonl", Exit: &ports.WorkerExit{Code: strPtr(int64(1))}},
			fakes.Completes(),
		}, nil, workerWorld{})
		job := queuedDriveJob(w, nil)

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		specs := w.worker.Specs()
		first := driveAttempt(t, w, 1)
		if first.Kind != domain.AttemptKindInitial || first.Verdict == nil || *first.Verdict != domain.VerdictWorkerError {
			t.Errorf("attempt 1 = (%s, %v), want (initial, worker_error)", first.Kind, first.Verdict)
		}
		if first.Outcome == nil || first.Outcome.Kind != domain.WorkerOutcomeAPIError ||
			first.Outcome.Status == nil || *first.Outcome.Status != 429 {
			t.Errorf("attempt 1 outcome = %+v, want api_error 429", first.Outcome)
		}
		second := driveAttempt(t, w, 2)
		if second.Kind != domain.AttemptKindInfraRetry || second.Verdict == nil || *second.Verdict != domain.VerdictPass {
			t.Errorf("attempt 2 = (%s, %v), want (infra_retry, pass)", second.Kind, second.Verdict)
		}
		if specs[1].Session.Kind != ports.SessionKindNew {
			t.Errorf("retry session kind = %s, want new", specs[1].Session.Kind)
		}
		if specs[1].Session.Key == specs[0].Session.Key {
			t.Error("the retry should start a new session")
		}
		if want := domain.InitialPrompt(job.Brief, job.Workspace.ArtifactsDir, deps.Provider); specs[1].Prompt != want {
			t.Errorf("retry prompt = %q, want the initial prompt", specs[1].Prompt)
		}
	})

	t.Run("hands the worker the brief's report contract and releases the worker when the driver is done", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, nil)

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		contract := w.worker.Specs()[0].Report
		if contract.Name != "change" {
			t.Errorf("report name = %s, want change", contract.Name)
		}
		var schema struct {
			Required []string `json:"required"`
		}
		if err := json.Unmarshal(contract.JSONSchema, &schema); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"summary", "files"} {
			if !contains(schema.Required, field) {
				t.Errorf("required = %v, want %s in it", schema.Required, field)
			}
		}
		if check := contract.Validate(json.RawMessage(`{}`)); !check.Present || check.Valid {
			t.Errorf("validate({}) = %+v, want present and invalid", check)
		}
		if check := contract.Validate(fakes.VALID_CHANGE_REPORT); !reflect.DeepEqual(check, testkit.AReportCheck()) {
			t.Errorf("validate(report) = %+v, want present, valid, no problems", check)
		}
		if w.worker.Disposed() != 1 {
			t.Errorf("disposed = %d, want one", w.worker.Disposed())
		}
	})

	t.Run("every 429 api_retry event is reported to the limiter", func(t *testing.T) {
		fourTwentyNine, fiveTwentyNine := int64(429), int64(529)
		deps, w := newDriveWorld(t, []fakes.WorkerScript{{Lines: []string{
			fakes.Wire.Retry(&fourTwentyNine, 1),
			fakes.Wire.Retry(&fiveTwentyNine, 2),
			fakes.Wire.Retry(&fourTwentyNine, 3),
			fakes.Wire.Result(fakes.ResultFields{Report: json.RawMessage(`{}`)}),
		}}}, nil, workerWorld{})
		queuedDriveJob(w, func(b *domain.Brief) { b.Retries = domain.Retries{Fix: 0, Infra: 0} })

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if notices := w.limiter.RateLimitedAt(); len(notices) != 2 {
			t.Errorf("limiter notices = %d, want the two 429s", len(notices))
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Usage == nil || attempt.Usage.RateLimitRetries != 2 {
			t.Errorf("rateLimitRetries = %+v, want 2", attempt.Usage)
		}
	})

	t.Run("skips gates when the worker did not complete", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{fakes.Wire.Text("thinking")}, Exit: &ports.WorkerExit{Code: strPtr(int64(1)), StderrTail: "boom"}},
		}, nil, workerWorld{})
		queuedDriveJob(w, func(b *domain.Brief) {
			gated(b)
			b.Retries = domain.Retries{Fix: 1, Infra: 0}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if calls := w.gates.Calls; len(calls) != 0 {
			t.Errorf("gate calls = %+v, want none", calls)
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeCrashed ||
			attempt.Outcome.ExitCode == nil || *attempt.Outcome.ExitCode != 1 ||
			attempt.Outcome.StderrTail != "boom" {
			t.Errorf("outcome = %+v, want crashed with the exit and stderr", attempt.Outcome)
		}
		if attempt.Verification == nil || len(attempt.Verification.Gates) != 0 {
			t.Errorf("verification gates = %+v, want none", attempt.Verification)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictWorkerError {
			t.Errorf("verdict = %v, want worker_error", attempt.Verdict)
		}
	})

	t.Run("exec mode: repository fingerprint change → scope_violation", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		w.git.Fingerprints = []string{"fp-before", "fp-after"}
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"README.md"} })
		job := queuedDriveJob(w, func(b *domain.Brief) {
			b.Mode = domain.ModeExec
			b.Scope = []string{}
			b.Retries = domain.Retries{Fix: 0, Infra: 0}
			b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if calls := w.git.Called("statusFingerprint"); !reflect.DeepEqual(calls, [][]any{{"/repo"}, {"/repo"}}) {
			t.Errorf("statusFingerprint calls = %v, want the repository twice", calls)
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Verification == nil {
			t.Fatal("no verification")
		}
		wantChanges := testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"README.md"} })
		if !reflect.DeepEqual(attempt.Verification.Changes, wantChanges) {
			t.Errorf("changes = %+v, want %+v", attempt.Verification.Changes, wantChanges)
		}
		wantScope := testkit.AScopeCheck(func(s *domain.ScopeCheck) { s.RepoChanged = true })
		if !reflect.DeepEqual(attempt.Verification.Scope, wantScope) {
			t.Errorf("scope = %+v, want repoChanged", attempt.Verification.Scope)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictScopeViolation {
			t.Errorf("verdict = %v, want scope_violation", attempt.Verdict)
		}
		spec := w.worker.Specs()[0]
		if spec.Cwd != "/repo" || spec.Access != ports.AccessExec {
			t.Errorf("spec = (%s, %s), want the repository in exec mode", spec.Cwd, spec.Access)
		}
		if want := []string{job.Workspace.ArtifactsDir}; !reflect.DeepEqual(spec.AddDirs, want) {
			t.Errorf("addDirs = %v, want %v", spec.AddDirs, want)
		}
		wantEnv := map[string]string{"ZAI_ARTIFACTS": job.Workspace.ArtifactsDir}
		if !reflect.DeepEqual(spec.PassEnv, wantEnv) {
			t.Errorf("passEnv = %v, want %v", spec.PassEnv, wantEnv)
		}
	})

	t.Run("readonly mode: an unchanged repository passes; the worker runs in plan mode", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			fakes.Completes(json.RawMessage(`{"summary":"found it","findings":[],"open_items":[]}`)),
		}, nil, workerWorld{})
		w.git.Fingerprints = []string{"fp-same"}
		queuedDriveJob(w, func(b *domain.Brief) {
			b.Mode = domain.ModeReadonly
			b.Scope = []string{}
			b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportNotes}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if access := w.worker.Specs()[0].Access; access != ports.AccessReadonly {
			t.Errorf("access = %s, want readonly", access)
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Verification == nil {
			t.Fatal("no verification")
		}
		if !reflect.DeepEqual(attempt.Verification.Changes, testkit.AChangeSet()) {
			t.Errorf("changes = %+v, want none", attempt.Verification.Changes)
		}
		if attempt.Verification.Scope.RepoChanged {
			t.Errorf("scope = %+v, want the repository unchanged", attempt.Verification.Scope)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictPass {
			t.Errorf("verdict = %v, want pass", attempt.Verdict)
		}
		if calls := w.git.Called("changes"); len(calls) != 0 {
			t.Errorf("changes calls = %v, want none", calls)
		}
	})

	t.Run("a returned job runs a review_fix attempt with reviewFixPrompt and the reviewer's feedback", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		paths := w.store.Paths(driveID)
		brief := testkit.ABrief(gated)
		verification := testkit.AVerification()
		pass := domain.VerdictPass
		reviewed := testkit.AnAttempt(func(a *domain.Attempt) {
			a.SessionID = "s-earlier"
			a.Verification = &verification
			a.Verdict = &pass
		})
		feedback := "Also rename the test file."
		pending := testkit.AnAttempt(func(a *domain.Attempt) {
			a.N = 2
			a.Kind = domain.AttemptKindReviewFix
			a.Feedback = strPtr(feedback)
			a.Prompt = domain.ReviewFixPrompt(brief, reviewed, feedback)
			a.SessionID = "s-earlier"
		})
		queuedDriveJob(w, gated, func(j *domain.Job) {
			j.Brief = brief
			j.Attempts = []domain.Attempt{reviewed, pending}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		spec := w.worker.Specs()[0]
		if spec.Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: "s-earlier"}) {
			t.Errorf("session = %+v, want a resume of the reviewed attempt's", spec.Session)
		}
		if spec.Prompt != pending.Prompt {
			t.Errorf("prompt = %q, want the review-fix prompt", spec.Prompt)
		}
		if spec.LogPath != paths.AttemptLog(2) {
			t.Errorf("logPath = %s, want %s", spec.LogPath, paths.AttemptLog(2))
		}
		stored := storedDrive(t, w)
		if len(stored.Attempts) != 2 {
			t.Fatalf("attempts = %d, want the two", len(stored.Attempts))
		}
		second := driveAttempt(t, w, 2)
		if second.Kind != domain.AttemptKindReviewFix || second.Feedback == nil || *second.Feedback != feedback {
			t.Errorf("attempt 2 = (%s, %v), want the review_fix with its feedback", second.Kind, second.Feedback)
		}
		if second.Verdict == nil || *second.Verdict != domain.VerdictPass {
			t.Errorf("attempt 2 verdict = %v, want pass", second.Verdict)
		}
	})

	t.Run("stop signal mid-run terminates the worker and ends with verdict stopped", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{fakes.Wire.Text("working")}, Hang: true},
		}, nil, workerWorld{})
		queuedDriveJob(w, func(b *domain.Brief) { b.Retries = domain.Retries{Fix: 1, Infra: 2} })
		done, cancel := driveInBackground(deps, driveID)

		if err := testkit.Until(t, func() bool { return len(w.worker.Specs()) == 1 },
			testkit.UntilOptions{Message: "worker never started"}); err != nil {
			t.Fatal(err)
		}
		cancel()
		result := <-done

		if result.err != nil {
			t.Fatal(result.err)
		}
		if terminated := w.process.Terminated(); !reflect.DeepEqual(terminated, []int64{50_000}) {
			t.Errorf("terminated = %v, want the worker's group", terminated)
		}
		stored := storedDrive(t, w)
		if stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		if len(stored.Attempts) != 1 {
			t.Fatalf("attempts = %d, want one", len(stored.Attempts))
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeStopped {
			t.Errorf("outcome = %+v, want stopped", attempt.Outcome)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictStopped {
			t.Errorf("verdict = %v, want stopped", attempt.Verdict)
		}
	})

	t.Run("a stop file (zai stop) ends the run the same way and is consumed", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{fakes.Wire.Text("working")}, Hang: true},
		}, nil, workerWorld{})
		queuedDriveJob(w, nil)
		paths := w.store.Paths(driveID)
		done, _ := driveInBackground(deps, driveID)

		if err := testkit.Until(t, func() bool { return len(w.worker.Specs()) == 1 },
			testkit.UntilOptions{Message: "worker never started"}); err != nil {
			t.Fatal(err)
		}
		if err := deps.Files.RequestStop(context.Background(), paths); err != nil {
			t.Fatal(err)
		}
		result := <-done

		if result.err != nil {
			t.Fatal(result.err)
		}
		if attempt := driveAttempt(t, w, 1); attempt.Verdict == nil || *attempt.Verdict != domain.VerdictStopped {
			t.Errorf("verdict = %v, want stopped", attempt.Verdict)
		}
		if _, err := os.Stat(paths.Stop); !os.IsNotExist(err) {
			t.Errorf("the stop file should be consumed (%v)", err)
		}
	})

	t.Run("a stop while waiting for a slot ends in awaiting_review with verdict stopped, no worker started", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		w.semaphore.SetBlocked(true)
		queuedDriveJob(w, nil)
		done, cancel := driveInBackground(deps, driveID)

		if err := testkit.Until(t, func() bool { return w.semaphore.Waiting() > 0 },
			testkit.UntilOptions{Message: "the driver never reached the slot queue"}); err != nil {
			t.Fatal(err)
		}
		cancel()
		result := <-done

		if result.err != nil {
			t.Fatal(result.err)
		}
		if specs := w.worker.Specs(); len(specs) != 0 {
			t.Errorf("specs = %d, want none", len(specs))
		}
		if want := []string{"awaiting_review"}; !reflect.DeepEqual(w.store.States(driveID), want) {
			t.Errorf("states = %v, want %v", w.store.States(driveID), want)
		}
		stored := storedDrive(t, w)
		if len(stored.Attempts) != 1 {
			t.Fatalf("attempts = %d, want the closed first one", len(stored.Attempts))
		}
		attempt := stored.Attempts[0]
		if attempt.N != 1 || attempt.Kind != domain.AttemptKindInitial ||
			attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeStopped {
			t.Errorf("attempt = %+v, want the initial one closed as stopped", attempt)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictStopped {
			t.Errorf("verdict = %v, want stopped", attempt.Verdict)
		}
	})

	t.Run("a stop requested during verification lands the verdict without starting a retry", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{fakes.Completes(), fakes.Completes()}, nil, workerWorld{})
		paths := w.store.Paths(driveID)
		queuedDriveJob(w, gated)
		// No grace period: the driver must see a stop requested any time before it decides, not
		// only once its watcher polls.
		deps.Gates = stoppingGates{FakeGates: w.gates, files: deps.Files, paths: paths}

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if specs := w.worker.Specs(); len(specs) != 1 {
			t.Errorf("specs = %d, want one (no retry)", len(specs))
		}
		if stored := storedDrive(t, w); stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		if attempt := driveAttempt(t, w, 1); attempt.Verdict == nil || *attempt.Verdict != domain.VerdictGateFail {
			t.Errorf("verdict = %v, want gate_fail", attempt.Verdict)
		}
		// The honoured request is consumed, so a later return is not stopped on arrival.
		if deps.Files.StopRequested(context.Background(), paths) {
			t.Error("the stop request should be consumed")
		}
	})

	t.Run("refuses a job that another live driver holds (locked)", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, nil)
		w.store.HoldLock(driveID, 4242)

		_, err := Drive(context.Background(), deps, driveID)

		want := &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorLocked, ID: driveID, HolderPid: 4242,
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("error = %+v, want the locked store error", err)
		}
		if specs := w.worker.Specs(); len(specs) != 0 {
			t.Errorf("specs = %d, want none", len(specs))
		}
		if acquired := w.semaphore.Acquired(); len(acquired) != 0 {
			t.Errorf("acquired = %v, want none", acquired)
		}
	})

	t.Run("releases the semaphore slot and the lock on every exit path, including errors", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, gated)
		deps.Gates = explodingGates{w.gates}

		// A broken gate runner explodes mid-drive; the panic unwinds through the driver's own
		// cleanups.
		panicked := make(chan any, 1)
		go func() {
			defer func() { panicked <- recover() }()
			_, _ = Drive(context.Background(), deps, driveID)
		}()
		if message := <-panicked; message != "gate runner exploded" {
			t.Fatalf("panic = %v, want the gate runner's", message)
		}

		if released := w.semaphore.Released(); !reflect.DeepEqual(released, []string{driveID}) {
			t.Errorf("released = %v, want the job's slot", released)
		}
		if w.files.Exists(w.store.Paths(driveID).DriverLock) {
			t.Error("the driver lock should be released")
		}
		okDeps, okWorld := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(okWorld, nil)
		if _, err := Drive(context.Background(), okDeps, driveID); err != nil {
			t.Fatal(err)
		}
		if released := okWorld.semaphore.Released(); !reflect.DeepEqual(released, []string{driveID}) {
			t.Errorf("released = %v, want the job's slot", released)
		}
		if okWorld.files.Exists(okWorld.store.Paths(driveID).DriverLock) {
			t.Error("the driver lock should be released")
		}
	})

	t.Run("a failing dispose is reported and still releases the lock; the run's result stands", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, gated)
		deps.Worker = disposingWorker{w.worker}

		result, err := Drive(context.Background(), deps, driveID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result, storedDrive(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		if stored := storedDrive(t, w); stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		if w.files.Exists(w.store.Paths(driveID).DriverLock) {
			t.Error("the driver lock should be released")
		}
		want := []string{
			"zai: job " + driveID + " finished, but its worker could not be disposed: pool drained mid-shutdown",
		}
		if !reflect.DeepEqual(w.out.Errors, want) {
			t.Errorf("errors = %v, want %v", w.out.Errors, want)
		}
	})

	t.Run("resolves brief env names from deps.env into passEnv for worker and gates; never writes values to the job", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, map[string]string{"NPM_TOKEN": "s3cret-token", "OTHER": "unrelated"}, workerWorld{})
		job := queuedDriveJob(w, func(b *domain.Brief) {
			gated(b)
			b.Env = []string{"NPM_TOKEN"}
		})
		var written strings.Builder
		w.store.BeforeUpdate = func(job domain.Job) {
			data, _ := json.Marshal(job)
			written.Write(data)
		}

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		wantEnv := map[string]string{"NPM_TOKEN": "s3cret-token", "ZAI_ARTIFACTS": job.Workspace.ArtifactsDir}
		if passEnv := w.worker.Specs()[0].PassEnv; !reflect.DeepEqual(passEnv, wantEnv) {
			t.Errorf("worker passEnv = %v, want %v", passEnv, wantEnv)
		}
		if passEnv := w.gates.Calls[0].PassEnv; !reflect.DeepEqual(passEnv, wantEnv) {
			t.Errorf("gate passEnv = %v, want %v", passEnv, wantEnv)
		}
		if strings.Contains(written.String(), "s3cret-token") {
			t.Error("the env value should never be written to the job")
		}
	})

	t.Run("a worker that cannot start (no key) lands the job in awaiting_review with worker_error, no retry", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{{
			StartError: &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"},
		}}, nil, workerWorld{})
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		want := &AppError{Kind: AppErrorWorker, WorkerError: &ports.WorkerError{
			Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("error = %+v, want the worker failure", err)
		}
		stored := storedDrive(t, w)
		if stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
		if len(stored.Attempts) != 1 {
			t.Fatalf("attempts = %d, want one", len(stored.Attempts))
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeCrashed ||
			attempt.Outcome.ExitCode != nil || attempt.Outcome.Signal != nil ||
			attempt.Outcome.StderrTail != "no Z.ai key: export ZAI_API_KEY" {
			t.Errorf("outcome = %+v, want crashed with the message on stderr", attempt.Outcome)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictWorkerError {
			t.Errorf("verdict = %v, want worker_error", attempt.Verdict)
		}
	})

	t.Run("only a queued job can be driven", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		queuedDriveJob(w, nil, func(j *domain.Job) { j.State = domain.JobStateAwaitingReview })

		_, err := Drive(context.Background(), deps, driveID)

		wantState := &AppError{Kind: AppErrorWrongState, ID: driveID,
			State: domain.JobStateAwaitingReview, Allowed: []domain.JobState{domain.JobStateQueued}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, wantState) {
			t.Fatalf("error = %+v, want wrong_state awaiting_review", err)
		}
		_, notFound := Drive(context.Background(), deps, "261006-nope")
		wantMissing := &AppError{Kind: AppErrorStore,
			StoreError: &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: "261006-nope"}}
		if !errors.As(notFound, &appErr) || !reflect.DeepEqual(appErr, wantMissing) {
			t.Fatalf("error = %+v, want not_found", notFound)
		}
	})

	t.Run("persists a progress snapshot of the running attempt", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{{Lines: []string{
			fakes.Wire.Tool("Bash", fakes.ToolArg{Key: "command", Value: "npm test"}),
			fakes.Wire.Result(fakes.ResultFields{Report: json.RawMessage(`{}`)}),
		}}}, nil, workerWorld{})
		queuedDriveJob(w, func(b *domain.Brief) { b.Retries = domain.Retries{Fix: 0, Infra: 0} })

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		raw, err := os.ReadFile(w.store.Paths(driveID).Progress)
		if err != nil {
			t.Fatal(err)
		}
		var snapshot struct {
			Attempt  int64           `json:"attempt"`
			Progress domain.Progress `json:"progress"`
		}
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Attempt != 1 {
			t.Errorf("attempt = %d, want 1", snapshot.Attempt)
		}
		progress := snapshot.Progress
		if progress.Phase != domain.ProgressPhaseDone || progress.Turns != 2 ||
			progress.LastTool == nil || *progress.LastTool != "Bash npm test" ||
			progress.ToolCalls != 1 {
			t.Errorf("progress = %+v, want the folded run", progress)
		}
	})

	t.Run("a version conflict re-applies the step while the job is still in the expected state, else stops", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		racer := &racingStore{MemoryStore: w.store}
		deps.Store = racer
		queuedDriveJob(w, nil)
		raced := false
		racer.onUpdate = func(store *fakes.MemoryStore, incoming domain.Job) {
			if raced || incoming.State != domain.JobStateRunning {
				return
			}
			raced = true
			current, _ := store.Get(context.Background(), driveID)
			bumped := current
			bumped.Version = current.Version + 1
			store.Put(bumped)
		}

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}
		if stored := storedDrive(t, w); stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}

		movedDeps, movedWorld := newDriveWorld(t, nil, nil, workerWorld{})
		movedRacer := &racingStore{MemoryStore: movedWorld.store}
		movedDeps.Store = movedRacer
		queuedDriveJob(movedWorld, nil)
		movedRacer.onUpdate = func(store *fakes.MemoryStore, incoming domain.Job) {
			if incoming.State != domain.JobStateVerifying {
				return
			}
			current, _ := store.Get(context.Background(), driveID)
			if current.State != domain.JobStateRunning {
				return
			}
			moved := current
			moved.State = domain.JobStateDiscarded
			moved.Version = current.Version + 1
			store.Put(moved)
		}

		_, err := Drive(context.Background(), movedDeps, driveID)

		want := &AppError{Kind: AppErrorWrongState, ID: driveID,
			State: domain.JobStateDiscarded, Allowed: []domain.JobState{domain.JobStateRunning}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("error = %+v, want wrong_state discarded", err)
		}
	})
}

// The claude worker's own missing-session rule, as the zai plugin's fakes carry it: a resume that
// says on stderr Claude Code has no such conversation.
var claudeNoConversation = regexp.MustCompile(`(?i)no conversation found`)

var claudeDialect = fakes.WorkerDialect{
	Caps:      testkit.ReferenceCaps,
	ParseLine: fakes.ParseEventLine,
	Init:      func(sessionKey, modelID string) string { return fakes.Wire.Init(sessionKey, modelID) },
	SessionMissing: func(session ports.WorkerSession, stderrTail string) bool {
		return session.Kind == ports.SessionKindResume && claudeNoConversation.MatchString(stderrTail)
	},
	Fixtures: fakes.EVENT_FIXTURES,
}

// Core's drive suite runs on the reference worker; the one case that hangs on the claude worker's
// own signal (what Claude Code prints for an unknown session) runs here, on the claude dialect.
func TestDriveOnTheClaudeWorker(t *testing.T) {
	t.Run("resume failure (worker reports no such session) → falls back to selfContainedPrompt in a new session", func(t *testing.T) {
		noSession := fakes.WorkerScript{
			Bare: true,
			Exit: &ports.WorkerExit{Code: strPtr(int64(1)),
				StderrTail: "No conversation found with session ID: 00000000-0000-4000-8000-000000000001"},
		}
		deps, w := newDriveWorld(t, []fakes.WorkerScript{fakes.Completes(), noSession, fakes.Completes()},
			nil, workerWorld{dialect: &claudeDialect})
		w.gates.FailOnce("npm test")
		job := queuedDriveJob(w, gated)

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		specs := w.worker.Specs()
		if len(specs) != 3 {
			t.Fatalf("specs = %d, want three", len(specs))
		}
		first, resumed, fresh := specs[0], specs[1], specs[2]
		if resumed.Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: first.Session.Key}) {
			t.Errorf("resumed session = %+v, want the first's key", resumed.Session)
		}
		if fresh.Session.Kind != ports.SessionKindNew {
			t.Errorf("fresh session kind = %s, want new", fresh.Session.Kind)
		}
		if fresh.Session.Key == first.Session.Key {
			t.Error("the fresh session should be a new key")
		}
		followUp := domain.AutoFixPrompt(job.Brief, driveAttempt(t, w, 1))
		want := domain.SelfContainedPrompt(job.Brief, []domain.Attempt{driveAttempt(t, w, 1)},
			followUp, job.Workspace.ArtifactsDir, testkit.ReferenceProvider)
		if fresh.Prompt != want {
			t.Errorf("fresh prompt = %q, want the self-contained one", fresh.Prompt)
		}
		stored := storedDrive(t, w)
		if len(stored.Attempts) != 2 {
			t.Fatalf("attempts = %d, want two", len(stored.Attempts))
		}
		second := driveAttempt(t, w, 2)
		if second.Kind != domain.AttemptKindAutoFix || second.SessionID != fresh.Session.Key ||
			second.Prompt != fresh.Prompt {
			t.Errorf("attempt 2 = (%s, %s), want the fresh auto_fix", second.Kind, second.SessionID)
		}
		if second.Verdict == nil || *second.Verdict != domain.VerdictPass {
			t.Errorf("attempt 2 verdict = %v, want pass", second.Verdict)
		}
	})
}

// ── the drive test's own stand-ins ────────────────────────────────────────────────────────────

// stoppingGates requests a stop as its gate runs, then fails it.
type stoppingGates struct {
	*fakes.FakeGates
	files ports.JobFiles
	paths domain.JobPaths
}

func (g stoppingGates) Run(ctx context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult {
	if err := g.files.RequestStop(ctx, g.paths); err != nil {
		panic(err)
	}
	failed := int64(1)
	return testkit.AGateResult(func(r *domain.GateResult) {
		r.Run = gate.Run
		r.ExitCode = &failed
		r.TimedOut = false
		r.DurationMs = 1
		r.Tail = cwd
	})
}

// explodingGates is a gate runner that explodes, as a broken adapter would.
type explodingGates struct{ *fakes.FakeGates }

func (explodingGates) Run(context.Context, string, domain.Gate, map[string]string, string) domain.GateResult {
	panic("gate runner exploded")
}

// disposingWorker is the scripted worker whose dispose always fails.
type disposingWorker struct{ *fakes.ScriptedWorker }

func (disposingWorker) Dispose(context.Context) error {
	return errors.New("pool drained mid-shutdown")
}

// racingStore wraps the memory store to race a concurrent writer into it before an update lands;
// the wrapper runs while the store is unlocked, so it may read and write it.
type racingStore struct {
	*fakes.MemoryStore
	onUpdate func(store *fakes.MemoryStore, incoming domain.Job)
}

func (s *racingStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	if s.onUpdate != nil {
		s.onUpdate(s.MemoryStore, job)
	}
	return s.MemoryStore.Update(ctx, job)
}

// contains reports whether the list has the value.
func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// ── direct tests of the parts the whole-loop cases reach only together ────────────────────────

// mustContract is the job's report contract, as the driver hands it to the worker.
func mustContract(t *testing.T, deps Deps, job domain.Job) ports.ReportContract {
	t.Helper()
	contract, err := ReportContract(context.Background(), deps.Files, job.Brief.Report)
	if err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestWorkerSpec(t *testing.T) {
	t.Run("carries the brief's model, access, session, report and limits", func(t *testing.T) {
		deps, _ := newDriveWorld(t, nil, nil, workerWorld{})
		effort, budget := "high", 5.0
		job := testkit.AJob(func(j *domain.Job) {
			j.Brief.Effort = &effort
			j.Brief.BudgetUSD = &budget
		})
		attempt := testkit.AnAttempt()

		spec := workerSpec(deps, job, attempt, mustContract(t, deps, job), true)

		if spec.Model.Tier != domain.ModelTierMain || spec.Model.ID != "glm-5.3" {
			t.Errorf("model = %+v, want the catalog's main tier", spec.Model)
		}
		if spec.Access != ports.AccessWrite {
			t.Errorf("access = %s, want write", spec.Access)
		}
		if spec.Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: attempt.SessionID}) {
			t.Errorf("session = %+v, want the attempt's resumed one", spec.Session)
		}
		if spec.Effort == nil || *spec.Effort != effort {
			t.Errorf("effort = %v, want the brief's", spec.Effort)
		}
		if spec.BudgetUSD == nil || *spec.BudgetUSD != budget {
			t.Errorf("budget = %v, want the brief's", spec.BudgetUSD)
		}
		if spec.Prompt != attempt.Prompt {
			t.Errorf("prompt = %q, want the attempt's", spec.Prompt)
		}
		if spec.TimeoutMs != job.Brief.TimeoutMs {
			t.Errorf("timeoutMs = %d, want the brief's", spec.TimeoutMs)
		}
		if spec.LogPath != deps.Store.Paths(job.ID).AttemptLog(1) {
			t.Errorf("logPath = %s, want the attempt's log", spec.LogPath)
		}
		wantEnv := map[string]string{"ZAI_ARTIFACTS": job.Workspace.ArtifactsDir}
		if !reflect.DeepEqual(spec.PassEnv, wantEnv) {
			t.Errorf("passEnv = %v, want %v", spec.PassEnv, wantEnv)
		}
	})
	t.Run("an effortless brief leaves the effort absent; exec adds the artifacts dir to addDirs", func(t *testing.T) {
		deps, _ := newDriveWorld(t, nil, nil, workerWorld{})
		job := testkit.AJob(func(j *domain.Job) {
			j.Brief.Mode = domain.ModeExec
			j.Brief.AddDirs = []string{"../shared"}
			// An exec job runs in the repository itself: it has no worktree.
			j.Workspace.Worktree = nil
		})

		spec := workerSpec(deps, job, testkit.AnAttempt(), mustContract(t, deps, job), false)

		if spec.Effort != nil {
			t.Errorf("effort = %v, want absent", spec.Effort)
		}
		if spec.Access != ports.AccessExec {
			t.Errorf("access = %s, want exec", spec.Access)
		}
		if spec.Cwd != job.Workspace.RepoRoot {
			t.Errorf("cwd = %s, want the repository", spec.Cwd)
		}
		wantDirs := []string{"../shared", job.Workspace.ArtifactsDir}
		if !reflect.DeepEqual(spec.AddDirs, wantDirs) {
			t.Errorf("addDirs = %v, want %v", spec.AddDirs, wantDirs)
		}
	})
}

func TestPassEnv(t *testing.T) {
	deps, _ := newDriveWorld(t, nil, map[string]string{"NPM_TOKEN": "secret"}, workerWorld{})
	job := testkit.AJob(func(j *domain.Job) { j.Brief.Env = []string{"NPM_TOKEN", "GH_TOKEN"} })

	passEnv := PassEnv(deps, job)

	// GH_TOKEN is not in the orchestrator's environment, so it stays out; the provider's artifacts
	// variable is always there.
	want := map[string]string{"NPM_TOKEN": "secret", "ZAI_ARTIFACTS": job.Workspace.ArtifactsDir}
	if !reflect.DeepEqual(passEnv, want) {
		t.Errorf("passEnv = %v, want %v", passEnv, want)
	}
}

func TestRunSetupAndGates(t *testing.T) {
	t.Run("the setup commands run in order, then the gates, all through the gate runner", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		setup := []string{"npm ci", "npm run build"}
		job := testkit.AJob(func(j *domain.Job) {
			j.Brief.Setup = &setup
			j.Brief.Gates = []domain.Gate{{Run: "npm test", TimeoutMs: 60_000}}
		})
		wantEnv := PassEnv(deps, job)

		results := RunSetupAndGates(context.Background(), deps, job, "/repo",
			func(i int) string { return "log-" + string(rune('0'+i)) })

		wantCalls := []fakes.GateCall{
			{Cwd: "/repo", Run: "npm ci", PassEnv: wantEnv, LogPath: "log-0"},
			{Cwd: "/repo", Run: "npm run build", PassEnv: wantEnv, LogPath: "log-1"},
			{Cwd: "/repo", Run: "npm test", PassEnv: wantEnv, LogPath: "log-2"},
		}
		if !reflect.DeepEqual(w.gates.Calls, wantCalls) {
			t.Errorf("calls = %+v, want %+v", w.gates.Calls, wantCalls)
		}
		if len(results) != 3 {
			t.Errorf("results = %d, want the three", len(results))
		}
	})
	t.Run("the first failed setup stops there: the gates would run against a workspace never prepared", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		failed := int64(1)
		w.gates.Results["npm ci"] = []fakes.GateAnswer{{ExitCode: &failed}}
		setup := []string{"npm ci", "npm run build"}
		job := testkit.AJob(func(j *domain.Job) {
			j.Brief.Setup = &setup
			j.Brief.Gates = []domain.Gate{{Run: "npm test", TimeoutMs: 60_000}}
		})

		results := RunSetupAndGates(context.Background(), deps, job, "/repo",
			func(i int) string { return "log-" + string(rune('0'+i)) })

		if runs := []string{w.gates.Calls[0].Run, w.gates.Calls[len(w.gates.Calls)-1].Run}; !reflect.DeepEqual(runs, []string{"npm ci", "npm ci"}) {
			t.Errorf("calls = %+v, want only the failing setup", w.gates.Calls)
		}
		if len(results) != 1 || results[0].ExitCode == nil || *results[0].ExitCode != failed {
			t.Errorf("results = %+v, want only the failed setup", results)
		}
	})
}

func TestRunAttemptDirect(t *testing.T) {
	t.Run("a report contract that cannot be read fails the attempt before the worker starts", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		job := testkit.AJob(func(j *domain.Job) {
			j.Brief.Report = domain.Report{Kind: domain.ReportKindFile, Path: filepath.Join(w.root, "nope.json")}
		})
		attempt := testkit.AnAttempt()
		stop := WatchStop(context.Background(), deps, w.store.Paths(job.ID))
		defer stop.Close()

		ran, err := RunAttempt(context.Background(), deps, job, attempt, stop)

		if err != nil {
			t.Fatal(err)
		}
		if ran.Failure == nil || ran.Failure.Kind != AppErrorBrief ||
			len(ran.Failure.BriefErrors) != 1 || ran.Failure.BriefErrors[0].Field != "report" {
			t.Errorf("failure = %+v, want a brief report field error", ran.Failure)
		}
		if ran.Outcome.Kind != domain.WorkerOutcomeCrashed {
			t.Errorf("outcome = %+v, want crashed", ran.Outcome)
		}
		if specs := w.worker.Specs(); len(specs) != 0 {
			t.Errorf("specs = %d, want none", len(specs))
		}
	})
	t.Run("a stop that already fired interrupts the run it starts", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{fakes.Wire.Text("working")}, Hang: true},
		}, nil, workerWorld{})
		job := testkit.AJob()
		external, cancel := context.WithCancel(context.Background())
		cancel()
		stop := WatchStop(external, deps, w.store.Paths(job.ID))
		defer stop.Close()
		if err := testkit.Until(t, func() bool { return stop.Ctx.Err() != nil },
			testkit.UntilOptions{Message: "the stop signal never fired"}); err != nil {
			t.Fatal(err)
		}

		ran, err := RunAttempt(context.Background(), deps, job, testkit.AnAttempt(), stop)

		if err != nil {
			t.Fatal(err)
		}
		if ran.Outcome.Kind != domain.WorkerOutcomeStopped {
			t.Errorf("outcome = %+v, want stopped", ran.Outcome)
		}
	})
}

// ── the failure paths the happy runs never take ───────────────────────────────────────────────

// failingStore is the memory store with one scripted failure, rewrite or race per operation, as a
// broken or racing store would.
type failingStore struct {
	*fakes.MemoryStore
	failGet      error
	failUpdateOn int
	updates      int
	rewrite      func(job domain.Job) domain.Job
	swapOnLock   func(store *fakes.MemoryStore, id string)
}

func (s *failingStore) Get(ctx context.Context, id string) (domain.Job, error) {
	if s.failGet != nil {
		err := s.failGet
		s.failGet = nil
		return domain.Job{}, err
	}
	return s.MemoryStore.Get(ctx, id)
}

func (s *failingStore) Lock(ctx context.Context, id string, pid int64) (func(), error) {
	release, err := s.MemoryStore.Lock(ctx, id, pid)
	if err == nil && s.swapOnLock != nil {
		s.swapOnLock(s.MemoryStore, id)
	}
	return release, err
}

func (s *failingStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	s.updates++
	if s.failUpdateOn != 0 && s.updates == s.failUpdateOn {
		return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}
	}
	if s.rewrite != nil {
		job = s.rewrite(job)
	}
	return s.MemoryStore.Update(ctx, job)
}

// failingSemaphore refuses every acquire, as a broken slot file would.
type failingSemaphore struct{ *fakes.FakeSemaphore }

func (failingSemaphore) Acquire(context.Context, ports.SemaphoreHolder) (func(), error) {
	return nil, errors.New("slots: read-only file system")
}

// failingLimiter refuses notices as a locked limiter file would: every one, or only the ones that
// end an attempt.
type failingLimiter struct {
	*fakes.FakeLimiter
	endedOnly bool
}

func (f failingLimiter) RateLimited(ctx context.Context, now int64, options ports.RateLimitOptions) error {
	if !f.endedOnly || options.EndedAttempt {
		return errors.New("limiter: locked")
	}
	return f.FakeLimiter.RateLimited(ctx, now, options)
}

// failingFiles fails selected job-file writes, as a full or read-only disk would.
type failingFiles struct {
	ports.JobFiles
	// failProgressFrom is the 1-based WriteProgress call that starts failing (0: never).
	failProgressFrom int
	failClear        bool
	writes           int
}

func (f *failingFiles) WriteProgress(ctx context.Context, paths domain.JobPaths, attempt int64, progress domain.Progress) error {
	f.writes++
	if f.failProgressFrom != 0 && f.writes >= f.failProgressFrom {
		return errors.New("progress: disk full")
	}
	return f.JobFiles.WriteProgress(ctx, paths, attempt, progress)
}

func (f *failingFiles) ClearStop(ctx context.Context, paths domain.JobPaths) error {
	if f.failClear {
		return errors.New("stop: read-only file system")
	}
	return f.JobFiles.ClearStop(ctx, paths)
}

// failingGit fails the fingerprint or change-set reads, as a broken git would; failStatusFrom is
// the 1-based statusFingerprint call that starts failing.
type failingGit struct {
	*fakes.FakeGit
	failStatusFrom int
	statuses       int
	failChanges    error
}

func (g *failingGit) StatusFingerprint(ctx context.Context, dir string) (string, error) {
	g.statuses++
	if g.failStatusFrom != 0 && g.statuses >= g.failStatusFrom {
		return "", &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git status", Stderr: "broken"}
	}
	return g.FakeGit.StatusFingerprint(ctx, dir)
}

func (g *failingGit) Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error) {
	if g.failChanges != nil {
		return domain.ChangeSet{}, g.failChanges
	}
	return g.FakeGit.Changes(ctx, dir, baseSha)
}

// unstartableWorker fails its starts with an error that is not a WorkerError.
type unstartableWorker struct{ *fakes.ScriptedWorker }

func (unstartableWorker) Start(context.Context, ports.WorkerSpec) (ports.WorkerRun, error) {
	return nil, errors.New("spawn: no such file or directory")
}

func TestDriveFailures(t *testing.T) {
	t.Run("a store that cannot be read under the lock fails the drive", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Store = &failingStore{MemoryStore: w.store,
			failGet: &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore ||
			appErr.StoreError == nil || appErr.StoreError.Kind != ports.StoreErrorIO {
			t.Fatalf("error = %+v, want the store's own failure", err)
		}
	})

	t.Run("a job that moved under the lock is refused, not driven", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Store = &failingStore{MemoryStore: w.store,
			swapOnLock: func(store *fakes.MemoryStore, id string) {
				job, _ := store.Get(context.Background(), id)
				moved := job
				moved.State = domain.JobStateDiscarded
				store.Put(moved)
			}}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		want := &AppError{Kind: AppErrorWrongState, ID: driveID,
			State: domain.JobStateDiscarded, Allowed: []domain.JobState{domain.JobStateQueued}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("error = %+v, want wrong_state discarded", err)
		}
		if specs := w.worker.Specs(); len(specs) != 0 {
			t.Errorf("specs = %d, want none", len(specs))
		}
	})

	t.Run("a semaphore that fails its acquire ends the drive with its own error", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Semaphore = failingSemaphore{w.semaphore}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "read-only") {
			t.Fatalf("error = %v, want the semaphore's failure", err)
		}
	})

	t.Run("the brief's named slot priority reaches the semaphore", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		high := domain.PriorityHigh
		queuedDriveJob(w, func(b *domain.Brief) { b.Priority = &high })

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		holders := w.semaphore.Holders()
		if len(holders) != 1 || holders[0].Priority != domain.PriorityHigh {
			t.Errorf("holders = %+v, want the high-priority one", holders)
		}
	})

	t.Run("a store write that fails on the first step fails the drive", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Store = &failingStore{MemoryStore: w.store, failUpdateOn: 1}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore {
			t.Fatalf("error = %+v, want the store's failure", err)
		}
	})

	t.Run("a store write that fails on the retry step stops the drive", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{fakes.Completes(), fakes.Completes()}, nil, workerWorld{})
		w.gates.FailOnce("npm test")
		deps.Store = &failingStore{MemoryStore: w.store, failUpdateOn: 3}
		queuedDriveJob(w, gated)

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore {
			t.Fatalf("error = %+v, want the store's failure", err)
		}
		// The retry write is what queues the fix attempt, so its failure leaves the one run.
		if specs := w.worker.Specs(); len(specs) != 1 {
			t.Errorf("specs = %d, want the one run", len(specs))
		}
	})

	t.Run("a store write that fails on the landing step fails the drive", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Store = &failingStore{MemoryStore: w.store, failUpdateOn: 3}
		queuedDriveJob(w, gated)

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore {
			t.Fatalf("error = %+v, want the store's failure", err)
		}
	})

	t.Run("a stored attempt that gained an outcome meanwhile stops the loop", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{fakes.Completes(), fakes.Completes()}, nil, workerWorld{})
		w.gates.FailOnce("npm test")
		completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
		deps.Store = &failingStore{MemoryStore: w.store, rewrite: func(job domain.Job) domain.Job {
			if job.State != domain.JobStateRunning || len(job.Attempts) != 2 {
				return job
			}
			rewritten := job
			last := rewritten.Attempts[1]
			last.Outcome = &completed
			rewritten.Attempts = []domain.Attempt{rewritten.Attempts[0], last}
			return rewritten
		}}
		queuedDriveJob(w, gated)

		_, err := Drive(context.Background(), deps, driveID)

		want := &AppError{Kind: AppErrorWrongState, ID: driveID,
			State: domain.JobStateRunning, Allowed: []domain.JobState{domain.JobStateQueued}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Fatalf("error = %+v, want wrong_state running", err)
		}
	})

	t.Run("a stop file that cannot be cleared still returns the run, with its error", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{fakes.Wire.Text("working")}, Hang: true},
		}, nil, workerWorld{})
		deps.Files = &failingFiles{JobFiles: deps.Files, failClear: true}
		queuedDriveJob(w, nil)
		paths := w.store.Paths(driveID)
		done, _ := driveInBackground(deps, driveID)

		if err := testkit.Until(t, func() bool { return len(w.worker.Specs()) == 1 },
			testkit.UntilOptions{Message: "worker never started"}); err != nil {
			t.Fatal(err)
		}
		if err := deps.Files.RequestStop(context.Background(), paths); err != nil {
			t.Fatal(err)
		}
		result := <-done

		if result.err == nil || !strings.Contains(result.err.Error(), "read-only") {
			t.Fatalf("error = %v, want the clear failure", result.err)
		}
		if result.job.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", result.job.State)
		}
	})

	t.Run("a progress write that fails fails the attempt", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Files = &failingFiles{JobFiles: deps.Files, failProgressFrom: 1}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "disk full") {
			t.Fatalf("error = %v, want the progress failure", err)
		}
	})

	t.Run("the final progress write fails the attempt too", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Files = &failingFiles{JobFiles: deps.Files, failProgressFrom: 2}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "disk full") {
			t.Fatalf("error = %v, want the progress failure", err)
		}
	})

	t.Run("a limiter that fails on a folded 429 fails the attempt", func(t *testing.T) {
		fourTwentyNine := int64(429)
		deps, w := newDriveWorld(t, []fakes.WorkerScript{{Lines: []string{
			fakes.Wire.Retry(&fourTwentyNine),
			fakes.Wire.Result(fakes.ResultFields{Report: json.RawMessage(`{}`)}),
		}}}, nil, workerWorld{})
		deps.Limiter = failingLimiter{FakeLimiter: w.limiter}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "locked") {
			t.Fatalf("error = %v, want the limiter failure", err)
		}
	})

	t.Run("a limiter that fails on the terminal 429 fails the drive", func(t *testing.T) {
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Fixture: "rate-limited-429.jsonl", Exit: &ports.WorkerExit{Code: strPtr(int64(1))}},
		}, nil, workerWorld{})
		deps.Limiter = failingLimiter{FakeLimiter: w.limiter, endedOnly: true}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "locked") {
			t.Fatalf("error = %v, want the limiter failure", err)
		}
	})

	t.Run("a sessionless fix whose fresh session fails reports the error", func(t *testing.T) {
		// The plain wire on a sessionless worker: the fix runs as a fresh session whose 429 the
		// limiter refuses to hear.
		noneDialect := plainDialect
		noneDialect.Caps.SessionKey = ports.SessionKeyNone
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			{Lines: []string{`DONE {"summary":"done"}`}},
			{Lines: []string{"THROTTLED 429", `DONE {"summary":"done"}`}},
		}, nil, workerWorld{dialect: &noneDialect})
		deps.Limiter = failingLimiter{FakeLimiter: w.limiter}
		w.gates.FailOnce("npm test")
		queuedDriveJob(w, gated)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "locked") {
			t.Fatalf("error = %v, want the fresh session's failure", err)
		}
		if specs := w.worker.Specs(); len(specs) != 2 {
			t.Errorf("specs = %d, want the initial and the fresh fix", len(specs))
		}
	})

	t.Run("a re-run in a fresh session that fails reports the error", func(t *testing.T) {
		fourTwentyNine := int64(429)
		noSession := fakes.WorkerScript{
			Bare: true,
			Exit: &ports.WorkerExit{Code: strPtr(int64(1)),
				StderrTail: "No conversation found with session ID: 00000000-0000-4000-8000-000000000001"},
		}
		deps, w := newDriveWorld(t, []fakes.WorkerScript{
			fakes.Completes(),
			noSession,
			{Lines: []string{
				fakes.Wire.Retry(&fourTwentyNine),
				fakes.Wire.Result(fakes.ResultFields{Report: json.RawMessage(`{}`)}),
			}},
		}, nil, workerWorld{dialect: &claudeDialect})
		deps.Limiter = failingLimiter{FakeLimiter: w.limiter}
		w.gates.FailOnce("npm test")
		queuedDriveJob(w, gated)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "locked") {
			t.Fatalf("error = %v, want the re-run's failure", err)
		}
		if specs := w.worker.Specs(); len(specs) != 3 {
			t.Errorf("specs = %d, want the three runs", len(specs))
		}
	})

	t.Run("a fingerprint that cannot be read fails the attempt before the worker runs", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Git = &failingGit{FakeGit: w.git, failStatusFrom: 1}
		queuedDriveJob(w, func(b *domain.Brief) { b.Mode = domain.ModeExec })

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorGit {
			t.Fatalf("error = %+v, want the git failure", err)
		}
		if specs := w.worker.Specs(); len(specs) != 0 {
			t.Errorf("specs = %d, want none", len(specs))
		}
	})

	t.Run("a fingerprint that cannot be re-read fails the verification", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Git = &failingGit{FakeGit: w.git, failStatusFrom: 2}
		queuedDriveJob(w, func(b *domain.Brief) { b.Mode = domain.ModeExec })

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorGit {
			t.Fatalf("error = %+v, want the git failure", err)
		}
		if specs := w.worker.Specs(); len(specs) != 1 {
			t.Errorf("specs = %d, want the one run", len(specs))
		}
	})

	t.Run("a change set that cannot be read fails the verification", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Git = &failingGit{FakeGit: w.git,
			failChanges: &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git diff", Stderr: "broken"}}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorGit {
			t.Fatalf("error = %+v, want the git failure", err)
		}
	})

	t.Run("an exec job's changed repository whose change set cannot be read fails the verification", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		w.git.Fingerprints = []string{"fp-before", "fp-after"}
		deps.Git = &failingGit{FakeGit: w.git,
			failChanges: &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git diff", Stderr: "broken"}}
		queuedDriveJob(w, func(b *domain.Brief) { b.Mode = domain.ModeExec })

		_, err := Drive(context.Background(), deps, driveID)

		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorGit {
			t.Fatalf("error = %+v, want the git failure", err)
		}
	})

	t.Run("a brief report schema file is checked as a file contract", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		schema := filepath.Join(w.root, "schema.json")
		if err := os.WriteFile(schema, []byte(`{"type":"object","required":["summary"]}`), 0o644); err != nil {
			t.Fatal(err)
		}
		queuedDriveJob(w, func(b *domain.Brief) {
			b.Report = domain.Report{Kind: domain.ReportKindFile, Path: schema}
		})

		if _, err := Drive(context.Background(), deps, driveID); err != nil {
			t.Fatal(err)
		}

		if name := w.worker.Specs()[0].Report.Name; name != schema {
			t.Errorf("report name = %s, want the schema path", name)
		}
		attempt := driveAttempt(t, w, 1)
		if attempt.Verification == nil || !reflect.DeepEqual(attempt.Verification.Report, testkit.AReportCheck()) {
			t.Errorf("report check = %+v, want the object check to pass", attempt.Verification)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictPass {
			t.Errorf("verdict = %v, want pass", attempt.Verdict)
		}
	})

	t.Run("a worker that fails to start without a worker error fails the attempt", func(t *testing.T) {
		deps, w := newDriveWorld(t, nil, nil, workerWorld{})
		deps.Worker = unstartableWorker{w.worker}
		queuedDriveJob(w, nil)

		_, err := Drive(context.Background(), deps, driveID)

		if err == nil || !strings.Contains(err.Error(), "no such file or directory") {
			t.Fatalf("error = %v, want the spawn failure", err)
		}
	})
}

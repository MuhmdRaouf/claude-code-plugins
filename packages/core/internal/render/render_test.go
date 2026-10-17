package render

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The fixtures the suite builds. The goldens are the recorded answers on these same inputs; the
// direct tests below spell out what each case checks.

var renderNow = time.Date(2026, time.October, 6, 12, 0, 0, 0, time.UTC).UnixMilli()

// isoAgo is new Date(NOW - ms).toISOString().
func isoAgo(ms int64) string {
	return time.UnixMilli(renderNow - ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

var renderUsageOf = domain.Usage{
	Turns:            3,
	InputTokens:      4200,
	OutputTokens:     310,
	CacheReadTokens:  2800,
	CacheWriteTokens: 900,
	CostUSD:          0.0123,
	RateLimitRetries: 0,
	DurationMs:       42_130,
}

var renderReport = json.RawMessage(`{"summary":"Renamed foo to bar in 3 files",` +
	`"files":[{"path":"src/a.ts","why":"rename"}],"tests_added":["test/a.test.ts"],` +
	`"open_items":["docs still say foo"]}`)

// passedAttempt is a completed attempt with a clean verification.
func passedAttempt(overrides ...func(*domain.Attempt)) domain.Attempt {
	attempt := testkit.AnAttempt(func(a *domain.Attempt) {
		ended := isoAgo(5 * minute)
		completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
		pass := domain.VerdictPass
		a.EndedAt = &ended
		a.Outcome = &completed
		a.Usage = &renderUsageOf
		a.Report = renderReport
		verification := testkit.AVerification(func(v *domain.Verification) {
			v.Gates = []domain.GateResult{
				testkit.AGateResult(func(g *domain.GateResult) { g.DurationMs = 1200 }),
				testkit.AGateResult(func(g *domain.GateResult) { g.Run = "npm run lint"; g.DurationMs = 400 }),
			}
			v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) {
				c.Added = []string{"src/b.ts"}
				c.Modified = []string{"src/a.ts"}
				c.Deleted = []string{"old.ts"}
				c.Untracked = []string{"notes.md"}
			})
		})
		a.Verification = &verification
		a.Verdict = &pass
	})
	for _, override := range overrides {
		override(&attempt)
	}
	return attempt
}

// gateFailedAttempt is a completed attempt with the npm test gate failing.
func gateFailedAttempt(n ...int64) domain.Attempt {
	number := int64(1)
	if len(n) > 0 {
		number = n[0]
	}
	return passedAttempt(func(a *domain.Attempt) {
		gateFail := domain.VerdictGateFail
		exitCode := int64(1)
		a.N = number
		verification := testkit.AVerification(func(v *domain.Verification) {
			v.Gates = []domain.GateResult{
				testkit.AGateResult(func(g *domain.GateResult) {
					g.ExitCode = &exitCode
					g.DurationMs = 2300
					g.Tail = "FAIL test/a.test.ts\nexpected 2, got 1\n"
				}),
				testkit.AGateResult(func(g *domain.GateResult) { g.Run = "npm run lint"; g.DurationMs = 400 }),
			}
			v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		})
		a.Verification = &verification
		a.Verdict = &gateFail
	})
}

// reviewJob is the awaiting-review edit job.
func reviewJob(attempts []domain.Attempt, overrides ...func(*domain.Job)) domain.Job {
	job := testkit.AJob(func(j *domain.Job) {
		worktree := "/state/worktrees/261006-abc123"
		branch := "zai/261006-abc123"
		j.ID = "261006-abc123"
		j.State = domain.JobStateAwaitingReview
		j.CreatedAt = isoAgo(20 * minute)
		j.UpdatedAt = isoAgo(5 * minute)
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      "0123456789abcdef0123456789abcdef01234567",
			Worktree:     &worktree,
			Branch:       &branch,
			ArtifactsDir: "/state/jobs/261006-abc123/artifacts",
		}
		j.Attempts = attempts
	})
	for _, override := range overrides {
		override(&job)
	}
	return job
}

// renderBoard: one table of subagents, sessions and jobs, active first, stale jobs flagged; an
// empty board says so and where activity will appear.
func TestRenderBoardGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "board") {
		input := inputOf[struct {
			Provider string            `json:"provider"`
			Rows     []app.ActivityRow `json:"rows"`
			Now      int64             `json:"now"`
		}](t, row)
		checkString(t, i, RenderBoard(providerOf(t, input.Provider), input.Rows, input.Now), row.Output)
	}
}

// renderReview: header, report summary and open items, gate table with failing tails, scope,
// changes, usage, next actions; the pass and gate_fail golden snapshots.
func TestRenderReviewGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "review") {
		input := inputOf[struct {
			Provider string           `json:"provider"`
			Packet   app.ReviewPacket `json:"packet"`
		}](t, row)
		checkString(t, i, RenderReview(providerOf(t, input.Provider), input.Packet), row.Output)
	}
}

// `review --summary` keeps the verdict and what failed, without the diff or the change list
// (reviewSummary; the golden keeps the output byte-identical).
func TestRenderReviewSummaryGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "reviewsummary") {
		input := inputOf[struct {
			Provider string           `json:"provider"`
			Packet   app.ReviewPacket `json:"packet"`
		}](t, row)
		checkString(t, i, RenderReviewSummary(providerOf(t, input.Provider), input.Packet), row.Output)
	}
}

// renderReview: scope violations, an invalid report and a worker error are spelled out.
func TestRenderReviewSpellsOutViolations(t *testing.T) {
	status := int64(429)
	apiError := domain.WorkerOutcome{
		Kind:    domain.WorkerOutcomeAPIError,
		Message: "API Error: Request rejected (429)",
		Status:  &status,
	}
	withRetries := renderUsageOf
	withRetries.RateLimitRetries = 10
	workerError := domain.VerdictWorkerError
	execAttempt := passedAttempt(func(a *domain.Attempt) {
		a.Outcome = &apiError
		a.Usage = &withRetries
		a.Report = nil
		verification := testkit.AVerification(func(v *domain.Verification) {
			v.Scope = testkit.AScopeCheck(func(s *domain.ScopeCheck) {
				s.OutOfScope = []string{"package.json"}
				s.Forbidden = []string{".env"}
			})
			v.Report = testkit.AReportCheck(func(r *domain.ReportCheck) {
				r.Present = false
				r.Valid = false
				r.Problems = []string{"no structured report"}
			})
			v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) {
				c.Modified = []string{"package.json", ".env"}
			})
		})
		a.Verification = &verification
		a.Verdict = &workerError
	})
	exec := reviewJob([]domain.Attempt{execAttempt}, func(j *domain.Job) {
		j.Brief = testkit.ABrief(func(b *domain.Brief) { b.Mode = domain.ModeExec; b.Scope = []string{} })
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      "0000000000000000000000000000000000000000",
			ArtifactsDir: "/state/jobs/x/artifacts",
		}
	})
	scopeViolation := domain.VerdictScopeViolation
	changed := passedAttempt(func(a *domain.Attempt) {
		a.Report = json.RawMessage(`{"summary":"x","open_items":[]}`)
		verification := testkit.AVerification(func(v *domain.Verification) {
			v.Scope = testkit.AScopeCheck(func(s *domain.ScopeCheck) { s.RepoChanged = true })
			v.Report = testkit.AReportCheck(func(r *domain.ReportCheck) {
				r.Valid = false
				r.Problems = []string{"items: Invalid input"}
			})
		})
		a.Verification = &verification
		a.Verdict = &scopeViolation
	})
	changedJob := reviewJob([]domain.Attempt{changed}, func(j *domain.Job) { j.State = domain.JobStateRunning })

	execText := RenderReview(testkit.ReferenceProvider, app.ReviewPacket{Job: exec})
	for _, want := range []string{
		"repository /repo (must stay unchanged), artifacts /state/jobs/x/artifacts",
		"Worker: API error (429): API Error: Request rejected (429)",
		"Report: missing (the worker ended without a structured report)",
		"Scope: VIOLATED, out of scope: package.json; forbidden: .env",
		"10 rate-limit retries",
	} {
		if !strings.Contains(execText, want) {
			t.Errorf("exec review misses %q:\n%s", want, execText)
		}
	}
	changedText := RenderReview(testkit.ReferenceProvider, app.ReviewPacket{Job: changedJob})
	for _, want := range []string{
		"Invalid against its contract:\n  - items: Invalid input",
		"Scope: VIOLATED, the repository changed (this job must leave it unchanged)",
		"Changes: none",
		"it is running; /zai:board shows it until it awaits review.",
	} {
		if !strings.Contains(changedText, want) {
			t.Errorf("changed-repo review misses %q:\n%s", want, changedText)
		}
	}
}

// renderUsage: per-model windows with a total each, priced from the table, then the job ledger
// (golden snapshots, both the full and the empty report).
func TestRenderUsageGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "usage") {
		input := inputOf[struct {
			Provider string      `json:"provider"`
			Report   UsageReport `json:"report"`
		}](t, row)
		checkString(t, i, RenderUsage(providerOf(t, input.Provider), input.Report), row.Output)
	}
}

// `review --summary` lists only the sweep items that did not pass: a clean sweep, or an attempt
// without sweep items, says nothing.
func TestReviewSummarySweepFailuresOnly(t *testing.T) {
	sweepBrief := testkit.ABrief(func(b *domain.Brief) {
		b.Mode = domain.ModeExec
		b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep}
		b.Title = "Sweep call sites"
	})
	clean := reviewJob([]domain.Attempt{passedAttempt(func(a *domain.Attempt) {
		a.Report = json.RawMessage(`{"summary":"clean","items":[{"id":"src/a.ts","status":"ok","detail":"done"}],` +
			`"open_items":[]}`)
	})}, func(j *domain.Job) { j.Brief = sweepBrief })
	if text := RenderReviewSummary(testkit.ReferenceProvider, app.ReviewPacket{Job: clean}); strings.Contains(text, "Sweep (") {
		t.Errorf("clean sweep listed a section:\n%s", text)
	}
	noItems := reviewJob([]domain.Attempt{passedAttempt(func(a *domain.Attempt) { a.Report = nil })},
		func(j *domain.Job) { j.Brief = sweepBrief })
	if text := RenderReviewSummary(testkit.ReferenceProvider, app.ReviewPacket{Job: noItems}); strings.Contains(text, "Sweep (") {
		t.Errorf("an attempt without items listed a section:\n%s", text)
	}
}

// renderStarted, renderHook and renderJob: the one-liners and the job view. The job view's own
// goldens are TestJobViewGoldens and TestJobViewFlagsStaleDrivers in job_test.go.
func TestRenderStartedAndHookOneLiners(t *testing.T) {
	for i, row := range goldenRows(t, "started") {
		input := inputOf[jobInput](t, row)
		checkString(t, i, RenderStarted(providerOf(t, input.Provider), input.Job), row.Output)
	}
	for i, row := range goldenRows(t, "hook") {
		input := inputOf[struct {
			Provider string            `json:"provider"`
			Rows     []app.ActivityRow `json:"rows"`
		}](t, row)
		checkString(t, i, RenderHook(providerOf(t, input.Provider), input.Rows), row.Output)
	}
	running := testkit.AJob(func(j *domain.Job) {
		j.ID = "261006-run001"
		j.State = domain.JobStateRunning
		j.CreatedAt = isoAgo(3 * minute)
		j.UpdatedAt = isoAgo(minute)
		j.Attempts = []domain.Attempt{gateFailedAttempt(), testkit.AnAttempt(func(a *domain.Attempt) {
			a.N = 2
			a.Kind = domain.AttemptKindAutoFix
		})}
	})
	review := reviewJob([]domain.Attempt{passedAttempt()})
	rows := app.JobRows(testkit.ReferenceProvider, []app.BoardRow{
		{Job: running, Live: true},
		{Job: review, Live: false},
		{Job: running, Live: true},
	})
	if got := RenderHook(testkit.ReferenceProvider, rows); got !=
		"zai: 1 job awaits review (/zai:review 261006-abc123); 2 jobs queued or running. /zai:board lists them." {
		t.Errorf("hook line: %q", got)
	}
	accepted := app.ActivityRow{Kind: app.ActivityKindJob, ID: "j-done", State: "accepted", At: isoAgo(0)}
	if got := RenderHook(testkit.ReferenceProvider, []app.ActivityRow{accepted}); got != "" {
		t.Errorf("hook with nothing to say: %q", got)
	}
}

// renderWaitLine and renderWaitTotals: one compact line per landed job, then the totals.
func TestRenderWaitLineAndTotals(t *testing.T) {
	for i, row := range goldenRows(t, "waitline") {
		input := inputOf[struct {
			Provider string     `json:"provider"`
			Job      domain.Job `json:"job"`
			Landed   bool       `json:"landed"`
		}](t, row)
		checkString(t, i, RenderWaitLine(providerOf(t, input.Provider), input.Job, input.Landed), row.Output)
	}
	for i, row := range goldenRows(t, "waittotals") {
		input := inputOf[struct {
			Provider string       `json:"provider"`
			Jobs     []domain.Job `json:"jobs"`
		}](t, row)
		checkString(t, i, RenderWaitTotals(providerOf(t, input.Provider), input.Jobs), row.Output)
	}
}

// No ANSI escape codes in any output.
func TestNoAnsiEscapeCodesInAnyOutput(t *testing.T) {
	job := reviewJob([]domain.Attempt{gateFailedAttempt(), func() domain.Attempt {
		attempt := passedAttempt()
		attempt.N = 2
		attempt.Kind = domain.AttemptKindAutoFix
		return attempt
	}()})
	tier := float64(1)
	outputs := []string{
		RenderBoard(testkit.ReferenceProvider, app.JobRows(testkit.ReferenceProvider,
			[]app.BoardRow{{Job: job, Live: true}}), renderNow),
		RenderReview(testkit.ReferenceProvider, app.ReviewPacket{
			Job: job,
			Diff: func() *string {
				diff := "+x\n"
				return &diff
			}(),
			DiffStat: func() *string {
				stat := " a | 1 +\n"
				return &stat
			}(),
		}),
		RenderSummary(testkit.ReferenceProvider, job),
		RenderJob(testkit.ReferenceProvider, app.BoardRow{Job: job, Live: true}, renderNow),
		RenderWaitLine(testkit.ReferenceProvider, job, true),
		RenderWaitTotals(testkit.ReferenceProvider, []domain.Job{job}),
		RenderUsage(testkit.ReferenceProvider, UsageReport{
			Windows: []app.UsageWindow{},
			Jobs: []domain.TierUsage{{
				Tier:                 domain.ModelTierMain,
				Jobs:                 1,
				Decided:              1,
				Accepted:             1,
				FirstTryPassRate:     &tier,
				AcceptRate:           &tier,
				MeanAttemptsToAccept: &tier,
				InputTokens:          1,
				OutputTokens:         1,
				CacheReadTokens:      1,
				CostUSD:              1,
				RateLimitRetries:     0,
				DurationMs:           1,
			}},
			Engines: []domain.EngineUsage{},
			AllJobs: []domain.Job{job},
			Now:     renderNow,
		}),
	}
	for i, output := range outputs {
		if strings.Contains(output, "\x1b") {
			t.Errorf("output %d carries an ANSI escape:\n%s", i, output)
		}
	}
}

// The advisor speaks only with enough runs, enough light ones and a priced saving; it prices both
// models at list price.
func TestAdvisorSavingAndAdviceWorthShowing(t *testing.T) {
	for i, row := range goldenRows(t, "advisorsaving") {
		input := inputOf[struct {
			Advice app.FlashAdvice `json:"advice"`
		}](t, row)
		got := AdvisorSaving(input.Advice)
		want := outputOf[*float64](t, row.Output)
		switch {
		case got == nil && want == nil:
		case got == nil || want == nil:
			t.Errorf("row %d: got %v, want %v", i, got, want)
		default:
			if *got != *want {
				t.Errorf("row %d: got %v, want %v", i, *got, *want)
			}
		}
	}
	for i, row := range goldenRows(t, "adviceworthshowing") {
		input := inputOf[struct {
			Advice *app.FlashAdvice `json:"advice"`
		}](t, row)
		if got := AdviceWorthShowing(input.Advice); got != outputOf[bool](t, row.Output) {
			t.Errorf("row %d: got %v", i, got)
		}
	}
	base := app.FlashAdvice{
		MainModel:   "glm-5.3",
		FlashModel:  "glm-5.3-flash",
		Runs:        10,
		LightJobs:   2,
		LightAgents: 1,
		Tokens:      app.TokenTotals{InputTokens: 1_000_000},
	}
	saving := AdvisorSaving(base)
	if saving == nil || *saving < 1.25-0.005 || *saving > 1.25+0.005 {
		t.Errorf("advisorSaving(base) = %v, want about 1.25", saving)
	}
	if !AdviceWorthShowing(&base) {
		t.Error("the base advice is worth showing")
	}
	if AdviceWorthShowing(nil) {
		t.Error("no advice is not worth showing")
	}
	fewerRuns := base
	fewerRuns.Runs = 9
	if AdviceWorthShowing(&fewerRuns) {
		t.Error("9 runs is not enough")
	}
	oneLight := base
	oneLight.LightJobs = 1
	if AdviceWorthShowing(&oneLight) {
		t.Error("2 light runs is not enough")
	}
	cheap := base
	cheap.Tokens = app.TokenTotals{InputTokens: 1000}
	if AdviceWorthShowing(&cheap) {
		t.Error("a saving under a cent is not worth showing")
	}
	unpricedMain := base
	unpricedMain.MainModel = "custom-model"
	if AdvisorSaving(unpricedMain) != nil {
		t.Error("an unpriced main model has no saving")
	}
	unpricedFlash := base
	unpricedFlash.FlashModel = "custom-flash"
	if AdviceWorthShowing(&unpricedFlash) {
		t.Error("an unpriced flash model is not worth showing")
	}
}

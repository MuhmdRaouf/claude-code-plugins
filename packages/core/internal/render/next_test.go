package render

import (
	"math"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestNextStepGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "nextstep") {
		input := inputOf[jobInput](t, row)
		checkString(t, i, NextStep(providerOf(t, input.Provider), input.Job), row.Output)
	}
}

func TestConflictStepGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "conflictstep") {
		input := inputOf[struct {
			Provider string `json:"provider"`
		}](t, row)
		checkString(t, i, ConflictStep(providerOf(t, input.Provider)), row.Output)
	}
}

// landedJob is an awaiting-review job with one attempt of that verdict.
func landedJob(verdict domain.Verdict, outcome *domain.WorkerOutcome, mode domain.Mode) domain.Job {
	return testkit.AJob(func(job *domain.Job) {
		job.ID = "261006-next01"
		job.State = domain.JobStateAwaitingReview
		job.Brief.Mode = mode
		job.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
			v := verdict
			attempt.Verdict = &v
			attempt.Outcome = outcome
		})}
	})
}

func crashedOutcome() *domain.WorkerOutcome {
	exitCode := int64(1)
	return &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCrashed, ExitCode: &exitCode, StderrTail: "boom"}
}

// Pass on a readonly or exec job never says accept: there is nothing to merge.
func TestNextStepPassOnNonEditNeverSaysAccept(t *testing.T) {
	for _, mode := range []domain.Mode{domain.ModeReadonly, domain.ModeExec} {
		text := NextStep(testkit.ReferenceProvider, landedJob(domain.VerdictPass, nil, mode))
		if !strings.Contains(text, "nothing to merge") {
			t.Errorf("%s: %q does not say there is nothing to merge", mode, text)
		}
		if strings.Contains(text, "accept") {
			t.Errorf("%s: %q says accept", mode, text)
		}
	}
}

// A worker that never finished leaves nothing to accept, whatever the outcome says.
func TestNextStepWorkerNeverFinished(t *testing.T) {
	for _, verdict := range []domain.Verdict{domain.VerdictWorkerError, domain.VerdictTimeout} {
		for _, outcome := range []*domain.WorkerOutcome{nil, crashedOutcome()} {
			text := NextStep(testkit.ReferenceProvider, landedJob(verdict, outcome, domain.ModeEdit))
			why := strings.Replace(string(verdict), "_", " ", 1)
			if outcome != nil {
				why = OutcomeText(*outcome)
			}
			if !strings.Contains(text, "the worker never finished ("+why+")") {
				t.Errorf("%s: %q does not spell out why", verdict, text)
			}
			if !strings.Contains(text, "nothing to accept") {
				t.Errorf("%s: %q does not say there is nothing to accept", verdict, text)
			}
			if strings.Contains(text, "--force") || strings.Contains(text, "accept it") {
				t.Errorf("%s: %q offers a force accept", verdict, text)
			}
		}
	}
}

// The gate failures return the failing output as feedback, never a force accept.
func TestNextStepGateFailuresReturnWithFeedback(t *testing.T) {
	for _, verdict := range []domain.Verdict{domain.VerdictGateFail, domain.VerdictScopeViolation, domain.VerdictReportInvalid} {
		text := NextStep(testkit.ReferenceProvider, landedJob(verdict, nil, domain.ModeEdit))
		want := "/zai:review 261006-next01 to return it with the failing output as feedback, or discard it."
		if text != want {
			t.Errorf("%s:\ngot  %q\nwant %q", verdict, text, want)
		}
	}
}

// Quota names the provider's billing page first; nothing was retried.
func TestNextStepQuotaNamesTheBillingPage(t *testing.T) {
	text := NextStep(testkit.ReferenceProvider, landedJob(domain.VerdictQuota, nil, domain.ModeEdit))
	want := "Z.ai GLM says the account has no balance or quota left, so it was not retried: top up at " +
		"https://z.ai/manage-apikey/billing, then /zai:review 261006-next01 to return it to try again, or discard it."
	if text != want {
		t.Errorf("\ngot  %q\nwant %q", text, want)
	}
}

// Stopped jobs go back with feedback or get discarded.
func TestNextStepStoppedReturnsOrDiscards(t *testing.T) {
	text := NextStep(testkit.ReferenceProvider, landedJob(domain.VerdictStopped, nil, domain.ModeEdit))
	if !strings.Contains(text, "return it with feedback, or discard it") {
		t.Errorf("%q", text)
	}
}

// A job that is not awaiting review points at the board; a decided one has nothing left.
func TestNextStepOutsideReviewPointsAtTheBoard(t *testing.T) {
	verifying := testkit.AJob(func(job *domain.Job) { job.State = domain.JobStateVerifying })
	if got := NextStep(testkit.ReferenceProvider, verifying); got != "it is verifying; /zai:board shows it until it awaits review." {
		t.Errorf("verifying: %q", got)
	}
	accepted := testkit.AJob(func(job *domain.Job) { job.State = domain.JobStateAccepted })
	if got := NextStep(testkit.ReferenceProvider, accepted); got != "nothing left to do: the job was accepted." {
		t.Errorf("accepted: %q", got)
	}
}

// No CLI name anywhere: every step names a slash command.
func TestNextStepNamesSlashCommandsNotCLI(t *testing.T) {
	cliName := regexp.MustCompile(`(?m)(^|\s)zai (accept|return|discard|review)`)
	for _, verdict := range []domain.Verdict{
		domain.VerdictPass, domain.VerdictGateFail, domain.VerdictWorkerError, domain.VerdictStopped, domain.VerdictTimeout,
	} {
		if text := Summary(testkit.ReferenceProvider, landedJob(verdict, nil, domain.ModeEdit)); cliName.MatchString(text) {
			t.Errorf("%s: summary names a CLI verb: %q", verdict, text)
		}
	}
}

// A merge conflict says discard and run again: the worker may not rebase.
func TestConflictStepSaysDiscardAndRunAgain(t *testing.T) {
	text := ConflictStep(testkit.ReferenceProvider)
	if !strings.Contains(text, "cannot rebase") {
		t.Errorf("no rebase note: %q", text)
	}
	if !strings.Contains(text, "run the brief again on the current branch") {
		t.Errorf("no rerun note: %q", text)
	}
	if regexp.MustCompile(`ask(ing)? the worker to rebase`).MatchString(text) {
		t.Errorf("asks the worker to rebase: %q", text)
	}
}

// The SessionStart review line names at most three jobs, then how many more.
func TestRenderHookNamesAtMostThreeJobs(t *testing.T) {
	var views []app.BoardRow
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		jobID := "261006-" + id
		pass := domain.VerdictPass
		views = append(views, app.BoardRow{Job: testkit.AJob(func(job *domain.Job) {
			job.ID = jobID
			job.State = domain.JobStateAwaitingReview
			job.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
				attempt.Verdict = &pass
			})}
		})})
	}
	got := RenderHook(testkit.ReferenceProvider, app.JobRows(testkit.ReferenceProvider, views))
	want := "zai: 5 jobs await review (/zai:review 261006-a, /zai:review 261006-b, /zai:review 261006-c" +
		" and 2 more). /zai:board lists them."
	if got != want {
		t.Errorf("\ngot  %q\nwant %q", got, want)
	}
}

// nextUsage is the suite's usage fixture: the worker's own figure (9.99) is deliberately wrong.
var nextUsage = domain.Usage{
	Turns:        2,
	InputTokens:  1_000_000,
	OutputTokens: 100_000,
	CostUSD:      9.99,
	DurationMs:   1000,
}

func costJob() domain.Job {
	started := "2026-10-06T10:00:00.000Z"
	ended := "2026-10-06T10:05:00.000Z"
	usage := nextUsage
	return testkit.AJob(func(job *domain.Job) {
		job.ID = "261006-cost01"
		job.State = domain.JobStateAccepted
		job.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
			attempt.StartedAt = started
			attempt.EndedAt = &ended
			attempt.Usage = &usage
		})}
	})
}

func costOldJob() domain.Job {
	started := "2026-09-20T10:00:00.000Z"
	ended := "2026-09-20T10:05:00.000Z"
	usage := nextUsage
	return testkit.AJob(func(job *domain.Job) {
		job.ID = "261006-cost02"
		job.State = domain.JobStateAccepted
		job.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
			attempt.StartedAt = started
			attempt.EndedAt = &ended
			attempt.Usage = &usage
		})}
	})
}

func costWindows() []app.UsageWindow {
	row := app.ModelUsage{Model: "glm-5.3", Requests: 4, InputTokens: 1_000_000}
	return []app.UsageWindow{
		{Label: "Today", Days: 1, Rows: []app.ModelUsage{row}},
		{Label: "Last 7 days", Days: 7, Rows: []app.ModelUsage{row}},
		{Label: "Last 30 days", Days: 30, Rows: []app.ModelUsage{row}},
	}
}

// Job attempts are priced from the table, never the worker's own figure.
func TestJobCostUsdPricesFromTheTable(t *testing.T) {
	for i, row := range goldenRows(t, "jobcostusd") {
		input := inputOf[jobInput](t, row)
		got := JobCostUsd(providerOf(t, input.Provider), input.Job)
		want := outputOf[float64](t, row.Output)
		if got != want {
			t.Errorf("row %d: got %v, want %v", i, got, want)
		}
	}
	// 1M in and 100k out at glm-5.3's list price, not the worker's 9.99.
	got := JobCostUsd(testkit.ReferenceProvider, costJob())
	if math.Abs(got-(1.4+0.44)) > 0.005 {
		t.Errorf("JobCostUsd = %v, want about %v", got, 1.4+0.44)
	}
}

// Each window adds the router's requests and the jobs that ended in it.
func TestWindowCostsAddRouterAndJobs(t *testing.T) {
	costs := WindowCosts(testkit.ReferenceProvider, costWindows(),
		[]domain.Job{costJob(), costOldJob()}, renderNow)
	want := []struct {
		label  string
		router float64
		jobs   string
	}{
		{"Today", 1.4, "1.8400"},
		{"Last 7 days", 1.4, "1.8400"},
		{"Last 30 days", 1.4, "3.6800"},
	}
	if len(costs) != len(want) {
		t.Fatalf("%d windows, want %d", len(costs), len(want))
	}
	for i, expected := range want {
		if costs[i].Label != expected.label || costs[i].Router != expected.router ||
			jsToFixed(costs[i].Jobs, 4) != expected.jobs {
			t.Errorf("window %d: got (%q, %v, %s), want (%q, %v, %s)", i,
				costs[i].Label, costs[i].Router, jsToFixed(costs[i].Jobs, 4),
				expected.label, expected.router, expected.jobs)
		}
	}
}

// The first lines are the totals and what the estimate rests on.
func TestUsageFirstLinesAreTheTotals(t *testing.T) {
	text := RenderUsage(testkit.ReferenceProvider, UsageReport{
		Windows: costWindows(),
		Jobs:    []domain.TierUsage{},
		Engines: []domain.EngineUsage{},
		AllJobs: []domain.Job{costJob(), costOldJob()},
		Now:     renderNow,
	})
	lines := strings.Split(text, "\n")
	want := []string{
		"Z.ai GLM usage",
		"Est. cost: today $3.24 · 7 days $3.24 · 30 days $5.08 (30 days: agents and /model $1.40, jobs $3.68)",
		"Estimated from Z.ai GLM list prices read " + PricesRetrieved +
			"; your bill is the provider's. Token counts are exact.",
	}
	if len(lines) < 3 {
		t.Fatalf("usage has %d lines:\n%s", len(lines), text)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d:\ngot  %q\nwant %q", i, lines[i], want[i])
		}
	}
}

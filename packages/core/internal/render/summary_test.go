package render

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// reportLine names a missing, invalid or summarised report.
func TestReportLine(t *testing.T) {
	missing := domain.ReportCheck{Present: false}
	if got := reportLine(nil, missing); got != "Report: missing" {
		t.Errorf("missing: %q", got)
	}
	invalid := domain.ReportCheck{Present: true, Valid: false, Problems: []string{"a", "b"}}
	if got := reportLine(nil, invalid); got != "Report: invalid (2 problems)" {
		t.Errorf("invalid: %q", got)
	}
	report := json.RawMessage(`{"summary":"done","open_items":["x"]}`)
	valid := domain.ReportCheck{Present: true, Valid: true}
	if got := reportLine(report, valid); got != "Report: done (1 open item)" {
		t.Errorf("valid: %q", got)
	}
}

func TestSummaryGoldens(t *testing.T) {
	for i, row := range goldenRows(t, "summary") {
		input := inputOf[jobInput](t, row)
		checkString(t, i, Summary(providerOf(t, input.Provider), input.Job), row.Output)
	}
}

// The summary is a compact one-screen answer: under 25 lines whatever the job did.
func TestSummaryStaysUnder25Lines(t *testing.T) {
	for i, row := range goldenRows(t, "summary") {
		input := inputOf[jobInput](t, row)
		text := Summary(providerOf(t, input.Provider), input.Job)
		if lines := strings.Split(text, "\n"); len(lines) >= 25 {
			t.Errorf("row %d: %d lines:\n%s", i, len(lines), text)
		}
	}
}

// The summary takes every name from the provider it renders: with acme's, none of zai's appears.
func TestSummaryNamesComeFromTheProvider(t *testing.T) {
	verdict := domain.VerdictGateFail
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	verification := testkit.AVerification()
	job := testkit.AJob(func(job *domain.Job) {
		job.ID = "261006-acme01"
		job.State = domain.JobStateAwaitingReview
		job.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
			attempt.Verdict = &verdict
			attempt.Outcome = &completed
			attempt.Verification = &verification
		})}
	})
	text := Summary(testkit.AcmeProvider, job)
	if lines := strings.Split(text, "\n"); lines[0] != "acme job 261006-acme01: verdict gate_fail (awaiting review)" {
		t.Errorf("first line: %q", lines[0])
	}
	if !strings.Contains(text, "Next: /acme:review 261006-acme01 to return it") {
		t.Errorf("next step: %q", text)
	}
	if testkit.ZaiNames.MatchString(text) {
		t.Errorf("summary names zai: %q", text)
	}
}

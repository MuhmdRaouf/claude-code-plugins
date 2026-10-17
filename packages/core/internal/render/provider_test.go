package render

import (
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// Every renderer, fed a second provider, takes every name from it — the CLI name, slash prefix,
// agent prefix and catalog ids — and none of zai's.
func TestRenderersTakeEveryNameFromTheProvider(t *testing.T) {
	gateFail := domain.VerdictGateFail
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	failedAttempt := testkit.AnAttempt(func(attempt *domain.Attempt) {
		verification := testkit.AVerification()
		attempt.Outcome = &completed
		attempt.Verification = &verification
		attempt.Verdict = &gateFail
	})
	pass := providerTestJob()
	failed := providerTestJob(func(job *domain.Job) { job.Attempts = []domain.Attempt{failedAttempt} })
	running := providerTestJob(func(job *domain.Job) {
		job.State = domain.JobStateRunning
		job.Attempts = []domain.Attempt{testkit.AnAttempt()}
	})
	stale := app.BoardRow{Job: running, Live: false}
	rows := app.JobRows(testkit.AcmeProvider, []app.BoardRow{stale, {Job: pass, Live: false}})
	outputs := map[string]string{
		"started":       RenderStarted(testkit.AcmeProvider, running),
		"emptyBoard":    RenderBoard(testkit.AcmeProvider, nil, renderNow),
		"board":         RenderBoard(testkit.AcmeProvider, rows, renderNow),
		"hook":          RenderHook(testkit.AcmeProvider, rows),
		"show":          RenderJob(testkit.AcmeProvider, stale, renderNow),
		"reviewPass":    RenderReview(testkit.AcmeProvider, app.ReviewPacket{Job: pass}),
		"reviewFail":    RenderReview(testkit.AcmeProvider, app.ReviewPacket{Job: failed}),
		"reviewRunning": RenderReview(testkit.AcmeProvider, app.ReviewPacket{Job: running}),
		"summaryPass":   RenderSummary(testkit.AcmeProvider, pass),
		"summaryFail":   RenderSummary(testkit.AcmeProvider, failed),
		"emptyUsage": RenderUsage(testkit.AcmeProvider, UsageReport{
			Windows: []app.UsageWindow{},
			Jobs:    []domain.TierUsage{},
			Engines: []domain.EngineUsage{},
			AllJobs: []domain.Job{},
			Now:     renderNow,
		}),
		"usage": RenderUsage(testkit.AcmeProvider, UsageReport{
			Windows: []app.UsageWindow{},
			Jobs:    []domain.TierUsage{providerFlashTier()},
			Engines: []domain.EngineUsage{},
			AllJobs: []domain.Job{pass, failed},
			Now:     renderNow,
		}),
	}
	for name, text := range outputs {
		if testkit.ZaiNames.MatchString(text) {
			t.Errorf("%s names nothing of zai's: %q", name, text)
		}
	}
	if outputs["started"] != "acme job 261006-acme01 started: Rename the helper (big-model-9, edit)" {
		t.Errorf("started: %q", outputs["started"])
	}
	if outputs["emptyBoard"] !=
		"No Acme Models activity yet. After /acme:setup, the sessions and subagents on its models appear here." {
		t.Errorf("emptyBoard: %q", outputs["emptyBoard"])
	}
	if !strings.Contains(outputs["board"],
		"stopping one here moves it to review, where /acme:review <id> discards it.") {
		t.Errorf("board: %q", outputs["board"])
	}
	if outputs["hook"] !=
		"acme: 1 job awaits review (/acme:review 261006-acme01); 1 job queued or running. /acme:board lists them." {
		t.Errorf("hook: %q", outputs["hook"])
	}
	showLines := strings.Split(outputs["show"], "\n")
	if len(showLines) < 2 || showLines[0] != "acme job 261006-acme01: Rename the helper" || showLines[1] !=
		"running (stale: no live driver; /acme:board stops it, /acme:review 261006-acme01 then discards it) · "+
			"big-model-9 · edit · created just now · updated just now" {
		t.Errorf("show: %q", outputs["show"])
	}
	reviewLines := strings.Split(outputs["reviewPass"], "\n")
	if len(reviewLines) < 2 || reviewLines[len(reviewLines)-2] != "Next" || reviewLines[len(reviewLines)-1] !=
		"  /acme:review 261006-acme01 to read the diff and accept it, or return it with feedback." {
		t.Errorf("reviewPass tail: %q", outputs["reviewPass"])
	}
	if !strings.Contains(outputs["reviewFail"],
		"/acme:review 261006-acme01 to return it with the failing output as feedback, or discard it.") {
		t.Errorf("reviewFail: %q", outputs["reviewFail"])
	}
	if strings.Contains(outputs["reviewFail"], "--force") {
		t.Errorf("reviewFail offers --force: %q", outputs["reviewFail"])
	}
	if !strings.Contains(outputs["reviewRunning"], "it is running; /acme:board shows it until it awaits review.") {
		t.Errorf("reviewRunning: %q", outputs["reviewRunning"])
	}
	if first := strings.Split(outputs["summaryFail"], "\n")[0]; first !=
		"acme job 261006-acme01: verdict gate_fail (awaiting review)" {
		t.Errorf("summaryFail first line: %q", first)
	}
	if !strings.Contains(outputs["summaryFail"], "Next: /acme:review 261006-acme01 to return it") {
		t.Errorf("summaryFail next step: %q", outputs["summaryFail"])
	}
	if !strings.Contains(outputs["emptyUsage"], "Acme Models usage") ||
		!strings.Contains(outputs["emptyUsage"], "No acme jobs in this repository yet.") {
		t.Errorf("emptyUsage: %q", outputs["emptyUsage"])
	}
	usageLines := strings.Split(outputs["usage"], "\n")
	if last := usageLines[len(usageLines)-1]; !regexp.MustCompile(`^small-model-9  `).MatchString(last) {
		t.Errorf("usage last line: %q", last)
	}
}

// providerTestJob is the suite's job: acme's names in a job's own fields.
func providerTestJob(overrides ...func(*domain.Job)) domain.Job {
	at := isoAgo(0)
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	pass := domain.VerdictPass
	worktree := "/state/worktrees/261006-acme01"
	branch := "acme-jobs/261006-acme01"
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = "261006-acme01"
		j.State = domain.JobStateAwaitingReview
		j.CreatedAt = at
		j.UpdatedAt = at
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(attempt *domain.Attempt) {
			verification := testkit.AVerification()
			attempt.Outcome = &completed
			attempt.Verification = &verification
			attempt.Verdict = &pass
		})}
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      strings.Repeat("b", 40),
			Worktree:     &worktree,
			Branch:       &branch,
			ArtifactsDir: "/state/jobs/261006-acme01/artifacts",
		}
	})
	for _, override := range overrides {
		override(&job)
	}
	return job
}

// providerFlashTier is the suite's flash tier: one flash job, nothing decided.
func providerFlashTier() domain.TierUsage {
	return domain.TierUsage{
		Tier:            domain.ModelTierFlash,
		Jobs:            1,
		InputTokens:     1,
		OutputTokens:    1,
		CacheReadTokens: 1,
		DurationMs:      1,
	}
}

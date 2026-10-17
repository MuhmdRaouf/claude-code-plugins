// Package testkit holds the fakes, builders and helpers every test shares.
package testkit

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Typed test builders: sensible defaults, shallow overrides.

// ABrief returns a Brief with the shared defaults, then applies each override.
func ABrief(overrides ...func(*domain.Brief)) domain.Brief {
	brief := domain.Brief{
		Title:     "Rename the helper",
		Body:      "Rename `foo` to `bar` everywhere.",
		Model:     domain.ModelTierMain,
		Mode:      domain.ModeEdit,
		Cwd:       "/repo",
		Base:      "HEAD",
		Scope:     []string{"**"},
		Forbid:    []string{},
		Gates:     []domain.Gate{},
		TimeoutMs: 2 * 60 * 60 * 1000,
		Retries:   domain.Retries{Fix: 1, Infra: 2},
		Report:    domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportChange},
		AddDirs:   []string{},
		Env:       []string{},
		Tags:      []string{},
	}
	for _, override := range overrides {
		override(&brief)
	}
	return brief
}

// AChangeSet returns a ChangeSet with the shared defaults, then applies each override.
func AChangeSet(overrides ...func(*domain.ChangeSet)) domain.ChangeSet {
	changes := domain.ChangeSet{
		Added:     []string{},
		Modified:  []string{},
		Deleted:   []string{},
		Untracked: []string{},
	}
	for _, override := range overrides {
		override(&changes)
	}
	return changes
}

// AGateResult returns a GateResult with the shared defaults, then applies each override.
func AGateResult(overrides ...func(*domain.GateResult)) domain.GateResult {
	exitCode := int64(0)
	gate := domain.GateResult{
		Run:        "npm test",
		ExitCode:   &exitCode,
		TimedOut:   false,
		DurationMs: 1000,
		Tail:       "",
	}
	for _, override := range overrides {
		override(&gate)
	}
	return gate
}

// AScopeCheck returns a ScopeCheck with the shared defaults, then applies each override.
func AScopeCheck(overrides ...func(*domain.ScopeCheck)) domain.ScopeCheck {
	scope := domain.ScopeCheck{
		OutOfScope:  []string{},
		Forbidden:   []string{},
		RepoChanged: false,
	}
	for _, override := range overrides {
		override(&scope)
	}
	return scope
}

// AReportCheck returns a ReportCheck with the shared defaults, then applies each override.
func AReportCheck(overrides ...func(*domain.ReportCheck)) domain.ReportCheck {
	report := domain.ReportCheck{
		Present:  true,
		Valid:    true,
		Problems: []string{},
	}
	for _, override := range overrides {
		override(&report)
	}
	return report
}

// AVerification returns a Verification with the shared defaults, then applies each override.
func AVerification(overrides ...func(*domain.Verification)) domain.Verification {
	verification := domain.Verification{
		Gates:   []domain.GateResult{},
		Changes: AChangeSet(),
		Scope:   AScopeCheck(),
		Report:  AReportCheck(),
	}
	for _, override := range overrides {
		override(&verification)
	}
	return verification
}

// AnAttempt returns an Attempt with the shared defaults, then applies each override.
func AnAttempt(overrides ...func(*domain.Attempt)) domain.Attempt {
	attempt := domain.Attempt{
		N:         1,
		Kind:      domain.AttemptKindInitial,
		Prompt:    "Rename `foo` to `bar` everywhere.",
		SessionID: "00000000-0000-4000-8000-000000000001",
		StartedAt: "2026-10-06T00:00:00.000Z",
	}
	for _, override := range overrides {
		override(&attempt)
	}
	return attempt
}

// AJob returns a Job with the shared defaults, then applies each override.
func AJob(overrides ...func(*domain.Job)) domain.Job {
	worktree := "/state/worktrees/j1"
	branch := "zai/j1"
	job := domain.Job{
		ID:    "j1",
		Brief: ABrief(),
		State: domain.JobStateQueued,
		Workspace: domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      "0000000000000000000000000000000000000000",
			Worktree:     &worktree,
			Branch:       &branch,
			ArtifactsDir: "/state/jobs/j1/artifacts",
		},
		Attempts:  []domain.Attempt{},
		CreatedAt: "2026-10-06T00:00:00.000Z",
		UpdatedAt: "2026-10-06T00:00:00.000Z",
		Version:   0,
	}
	for _, override := range overrides {
		override(&job)
	}
	return job
}

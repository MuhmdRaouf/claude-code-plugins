package app

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// SubmitInput is one brief to submit: its text and where it came from (for relative
// cwd/addDirs/report paths), plus the CLI's overrides.
type SubmitInput struct {
	Text       string
	SourcePath *string
	Cwd        string
	// Overrides are the CLI's --flash/--mode/--engine, applied after parsing, before the
	// mode-dependent defaults.
	Overrides *BriefOverrides
	// DefaultPriority is the queue priority a brief without its own `priority` field gets (run:
	// high, batch: normal).
	DefaultPriority *domain.Priority
}

// Submit parses and validates the brief, checks every `env` name is set in deps.Env (values are
// not stored), resolves repo root and base sha, creates the artifacts dir and (edit mode) the
// worktree on branch <branchPrefix><id>, and persists the job as queued. Any failure after the
// worktree exists removes it again (no orphans).
func Submit(ctx context.Context, deps Deps, input SubmitInput) (domain.Job, error) {
	brief, err := ValidBrief(ctx, deps, input)
	if err != nil {
		return domain.Job{}, err
	}
	repoRoot, err := deps.Git.Root(ctx, brief.Cwd)
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	baseSha, err := deps.Git.Resolve(ctx, repoRoot, brief.Base)
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}

	id := deps.Ids.JobID()
	paths := deps.Store.Paths(id)
	workspace := domain.Workspace{
		RepoRoot:     repoRoot,
		BaseSha:      baseSha,
		ArtifactsDir: paths.Artifacts,
	}
	if brief.Mode == domain.ModeEdit {
		worktree := paths.Worktree
		branch := deps.Provider.BranchPrefix + id
		workspace.Worktree = &worktree
		workspace.Branch = &branch
	}
	if workspace.Worktree != nil && workspace.Branch != nil {
		if err := deps.Git.AddWorktree(ctx, workspace.RepoRoot, *workspace.Worktree, *workspace.Branch, baseSha); err != nil {
			return domain.Job{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
		}
	}
	created, err := deps.Store.Create(ctx, queuedJob(deps, id, brief, workspace, deps.Clock.Iso()))
	if err != nil {
		if workspace.Worktree != nil && workspace.Branch != nil {
			_ = deps.Git.RemoveWorktree(ctx, workspace.RepoRoot, *workspace.Worktree, *workspace.Branch)
		}
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(err)}
	}
	if err := deps.Files.WriteBrief(ctx, paths, input.Text); err != nil {
		return domain.Job{}, err
	}
	// Every submission refreshes the ceiling the drivers grow towards (`${envPrefix}_MAX_CONCURRENCY`,
	// default 16).
	if err := deps.Limiter.SaveMax(ctx,
		domain.MaxFromEnv(deps.Env[deps.Provider.EnvPrefix+"_MAX_CONCURRENCY"], deps.Config.Limiter),
		deps.Clock.Now()); err != nil {
		return domain.Job{}, err
	}
	return created, nil
}

// queuedJob is the job submit persists: Origin names the Claude Code session that ran the command,
// when the environment carries one (Radar shows the job inside that session).
func queuedJob(deps Deps, id string, brief domain.Brief, workspace domain.Workspace, now string) domain.Job {
	return domain.Job{
		ID:        id,
		Brief:     brief,
		State:     domain.JobStateQueued,
		Workspace: workspace,
		Attempts:  []domain.Attempt{},
		CreatedAt: now,
		UpdatedAt: now,
		Origin:    domain.JobOrigin(deps.Env["CLAUDE_CODE_SESSION_ID"]),
		Version:   0,
	}
}

// ValidBrief is the brief as the job will run it: parsed against the current git root, overrides
// applied, report schema file readable, every env name set. `brief lint` checks exactly this.
func ValidBrief(ctx context.Context, deps Deps, input SubmitInput) (domain.Brief, error) {
	root, rootErr := deps.Git.Root(ctx, input.Cwd)
	defaultCwd := input.Cwd
	if rootErr == nil {
		defaultCwd = root
	}
	var requested *domain.Engine
	if input.Overrides != nil {
		requested = input.Overrides.Engine
	}
	engine, err := ResolveEngine(deps, requested, input.Text)
	if err != nil {
		return domain.Brief{}, err
	}
	// The brief is checked against the terms (efforts, budget) of the engine that will run it; an
	// engine the brief does not name already (the --engine flag, the configured default) is
	// written into it like any other override.
	named := domain.EngineClaude
	if brief := BriefEngine(input.Text); brief != nil {
		named = *brief
	}
	overrides := BriefOverrides{}
	if input.Overrides != nil {
		overrides = *input.Overrides
	}
	if engine != named {
		resolved := engine
		overrides.Engine = &resolved
	}
	worker := WorkerOf(deps, engine)
	if worker == nil {
		worker = deps.Worker
	}
	parsed, briefErrors := domain.ParseBrief(WithOverrides(input.Text, overrides, deps.Provider),
		domain.BriefContext{
			DefaultCwd: defaultCwd,
			Provider:   deps.Provider,
			Worker:     worker.Caps().WorkerTerms,
		})
	if len(briefErrors) > 0 {
		return domain.Brief{}, &AppError{Kind: AppErrorBrief, BriefErrors: briefErrors}
	}
	if parsed.Priority == nil && input.DefaultPriority != nil {
		parsed.DefaultPriorityTo(*input.DefaultPriority)
	}
	if _, err := ReportSchema(ctx, deps.Files, parsed.Report); err != nil {
		return domain.Brief{}, &AppError{Kind: AppErrorBrief, BriefErrors: []domain.BriefError{{
			Kind:    domain.BriefErrorField,
			Field:   "report",
			Message: err.Error(),
		}}}
	}
	missing := []string{}
	for _, name := range parsed.Env {
		if _, set := deps.Env[name]; !set {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return domain.Brief{}, &AppError{Kind: AppErrorMissingEnv, Names: missing}
	}
	return parsed, nil
}

package app

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// noChanges is the change set of a repository left exactly as it was found.
var noChanges = domain.ChangeSet{
	Added: []string{}, Modified: []string{}, Deleted: []string{}, Untracked: []string{},
}

// RepositoryFingerprint is the repository's status fingerprint before the worker runs; nil for an
// edit job, whose worktree is allowed to change. exec/readonly jobs must leave the repository as
// they found it.
func RepositoryFingerprint(ctx context.Context, deps Deps, job domain.Job) (*string, error) {
	if job.Brief.Mode == domain.ModeEdit {
		return nil, nil
	}
	fingerprint, err := deps.Git.StatusFingerprint(ctx, job.Workspace.RepoRoot)
	if err != nil {
		return nil, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	return &fingerprint, nil
}

// VerifyAttempt is gates (only when the worker completed), the change set against scope, and the
// report against its contract.
func VerifyAttempt(ctx context.Context, deps Deps, job domain.Job, attempt domain.Attempt, before *string) (domain.Verification, error) {
	paths := deps.Store.Paths(job.ID)
	gates := []domain.GateResult{}
	if attempt.Outcome != nil && attempt.Outcome.Kind == domain.WorkerOutcomeCompleted {
		gates = RunSetupAndGates(ctx, deps, job, WorkspaceDir(job), func(i int) string {
			return paths.GateLog(int(attempt.N), i)
		})
	}
	changes, scope, err := changeCheck(ctx, deps, job, before)
	if err != nil {
		return domain.Verification{}, err
	}
	return domain.Verification{
		Gates:   gates,
		Changes: changes,
		Scope:   scope,
		Report:  domain.CheckReport(attempt.Report, reportContractOf(job.Brief.Report)),
	}, nil
}

// reportContractOf is the brief's report as the domain's check takes it: a builtin by name, or the
// kind alone for a custom schema the worker itself already enforced.
func reportContractOf(report domain.Report) domain.ReportContract {
	if report.Kind == domain.ReportKindBuiltin {
		return domain.ReportContract{Kind: domain.ReportContractBuiltin, Name: report.Name}
	}
	return domain.ReportContract{Kind: domain.ReportContractFile}
}

// RunSetupAndGates is the brief's setup commands in order, then its gates, all through the gate
// runner. The first failed setup stops there: the gates would run against a workspace that was
// never prepared.
func RunSetupAndGates(ctx context.Context, deps Deps, job domain.Job, cwd string, logAt func(int) string) []domain.GateResult {
	env := PassEnv(deps, job)
	setup := []string{}
	if job.Brief.Setup != nil {
		setup = *job.Brief.Setup
	}
	results := []domain.GateResult{}
	for i, run := range setup {
		result := deps.Gates.Run(ctx, cwd, domain.Gate{Run: run, TimeoutMs: domain.DefaultGateTimeoutMs}, env, logAt(i))
		results = append(results, result)
		if domain.GateFailed(result) {
			return results
		}
	}
	for i, gate := range job.Brief.Gates {
		results = append(results, deps.Gates.Run(ctx, cwd, gate, env, logAt(len(setup)+i)))
	}
	return results
}

// changeCheck is the change set and its scope check: the worktree's for an edit job, the
// repository's against its before-fingerprint otherwise.
func changeCheck(ctx context.Context, deps Deps, job domain.Job, before *string) (domain.ChangeSet, domain.ScopeCheck, error) {
	if before == nil {
		return editChanges(ctx, deps, job)
	}
	return repositoryChanges(ctx, deps, job, *before)
}

// editChanges is the worktree's change set checked against the brief's scope and forbid globs.
func editChanges(ctx context.Context, deps Deps, job domain.Job) (domain.ChangeSet, domain.ScopeCheck, error) {
	changes, err := deps.Git.Changes(ctx, WorkspaceDir(job), job.Workspace.BaseSha)
	if err != nil {
		return domain.ChangeSet{}, domain.ScopeCheck{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	scope := domain.CheckScope(changes, domain.ScopeRules{
		Mode: job.Brief.Mode, Scope: job.Brief.Scope, Forbid: job.Brief.Forbid,
	})
	return changes, scope, nil
}

// repositoryChanges checks the repository against its before-fingerprint. Any fingerprint change is
// a violation; the change set (against the base) is listed only then.
func repositoryChanges(ctx context.Context, deps Deps, job domain.Job, before string) (domain.ChangeSet, domain.ScopeCheck, error) {
	after, err := RepositoryFingerprint(ctx, deps, job)
	if err != nil {
		return domain.ChangeSet{}, domain.ScopeCheck{}, err
	}
	unchanged := domain.ScopeCheck{OutOfScope: []string{}, Forbidden: []string{}, RepoChanged: false}
	if after != nil && *after == before {
		return noChanges, unchanged, nil
	}
	changes, err := deps.Git.Changes(ctx, job.Workspace.RepoRoot, job.Workspace.BaseSha)
	if err != nil {
		return domain.ChangeSet{}, domain.ScopeCheck{}, &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
	}
	return changes, domain.ScopeCheck{OutOfScope: []string{}, Forbidden: []string{}, RepoChanged: true}, nil
}

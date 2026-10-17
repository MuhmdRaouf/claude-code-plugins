package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Landing an edit job's change set in its repository.

// AcceptMode is how an accept lands an edit job's change set.
type AcceptMode string

const (
	// AcceptModeCommit commits the change set on the job branch and lands the commit.
	AcceptModeCommit AcceptMode = "commit"
	// AcceptModeNoCommit applies the change set to the working tree without committing.
	AcceptModeNoCommit AcceptMode = "no_commit"
)

// LandOptions shapes a landing.
type LandOptions struct {
	Mode   AcceptMode
	Verify bool
}

// maxTipRounds: the branch tip moving between verification and landing is rare; a third try is not
// worth waiting for.
const maxTipRounds = 3

// AcceptOptions shapes an accept.
type AcceptOptions struct {
	Mode   AcceptMode
	Force  bool
	Verify bool
}

// landGitError is a git failure the landing reports as its own git error.
func landGitError(err error) error {
	return &AppError{Kind: AppErrorGit, GitError: asGitError(err)}
}

// Land lands an edit job's change set in its repository; it returns the commit landed (commit
// mode) if one was made.
//
// Commit mode commits whatever is not yet committed on the job branch, then — while the
// repository's branch tip has moved past the job's base — rebases the job branch onto it
// (regenerate paths settled by taking the tip's side), runs the regenerate commands and amends
// what they change, verifies the exact commit (setup, then gates) in a fresh detached checkout,
// and fast-forwards the repository's branch onto it; the tip moving meanwhile restarts the round.
// No-commit mode applies the change set to the working tree. exec/readonly jobs have nothing to
// land.
func Land(ctx context.Context, deps Deps, job domain.Job, opts LandOptions) (*string, error) {
	worktree := job.Workspace.Worktree
	if worktree == nil {
		return nil, nil
	}
	if opts.Mode == AcceptModeNoCommit {
		if err := deps.Git.ApplyToWorkingTree(ctx, job.Workspace.RepoRoot, *worktree, job.Workspace.BaseSha); err != nil {
			return nil, landGitError(err)
		}
		return nil, nil
	}
	trailer, err := deps.Git.Trailer(ctx, job.Workspace.RepoRoot)
	if err != nil {
		return nil, landGitError(err)
	}
	if err := commitPending(ctx, deps, job, *worktree, opts.Verify, trailer); err != nil {
		return nil, err
	}
	for round := 0; round < maxTipRounds; round++ {
		landed, retry, err := landRound(ctx, deps, job, *worktree, opts)
		if err != nil {
			return nil, err
		}
		if !retry {
			return landed, nil
		}
	}
	return nil, &AppError{Kind: AppErrorGit, GitError: &ports.GitError{
		Kind:    ports.GitErrorGitFailed,
		Command: "git merge --ff-only",
		Stderr: fmt.Sprintf("the branch tip moved %d times while landing; try again",
			maxTipRounds),
	}}
}

// landRound is one round of the tip loop: bring the job branch onto the tip if it moved,
// regenerate, verify the exact commit in a fresh checkout, then fast-forward the branch onto it; a
// tip that moved meanwhile asks for another round.
func landRound(ctx context.Context, deps Deps, job domain.Job, worktree string, opts LandOptions) (*string, bool, error) {
	head, err := headToLand(ctx, deps, job, worktree)
	if err != nil {
		return nil, false, err
	}
	if head.settled {
		return head.commit, false, nil
	}
	regenerated, err := regenerate(ctx, deps, job, worktree, head.toLand, opts.Verify)
	if err != nil {
		return nil, false, err
	}
	if err := verifyCommit(ctx, deps, job, regenerated); err != nil {
		return nil, false, err
	}
	merged, err := deps.Git.FastForward(ctx, job.Workspace.RepoRoot, regenerated, head.tip)
	if err != nil {
		return nil, false, landGitError(err)
	}
	// The branch tip moved while the commit was being verified: the next round rebases onto the
	// new tip instead.
	if merged == ports.FastForwardMoved {
		return nil, true, nil
	}
	return &regenerated, false, nil
}

// headOutcome is where the job branch stands against the repository tip: the commit this round
// would land (with the tip it saw), or a settled outcome — no commit when the change set is empty,
// or the branch's own head when a previous accept already landed it and only failed to record
// that.
type headOutcome struct {
	settled bool
	// settled: the branch's head, nil when nothing changed.
	commit *string
	toLand string
	tip    string
}

// headToLand brings the job branch onto the repository's tip when it moved past the job's base:
// the rebase settles regenerate paths by taking the tip's side; any other conflict is the
// landing's own refusal.
func headToLand(ctx context.Context, deps Deps, job domain.Job, worktree string) (headOutcome, error) {
	head, err := deps.Git.Resolve(ctx, worktree, "HEAD")
	if err != nil {
		return headOutcome{}, landGitError(err)
	}
	if head == job.Workspace.BaseSha {
		return headOutcome{settled: true}, nil
	}
	tip, err := deps.Git.Resolve(ctx, job.Workspace.RepoRoot, "HEAD")
	if err != nil {
		return headOutcome{}, landGitError(err)
	}
	if head == tip {
		return headOutcome{settled: true, commit: &head}, nil
	}
	ahead, err := deps.Git.IsAncestor(ctx, worktree, tip, head)
	if err != nil {
		return headOutcome{}, landGitError(err)
	}
	if ahead {
		return headOutcome{toLand: head, tip: tip}, nil
	}
	if err := deps.Git.RebaseJobBranch(ctx, worktree, tip, regeneratePaths(job)); err != nil {
		var gitErr *ports.GitError
		if errors.As(err, &gitErr) && gitErr.Kind == ports.GitErrorConflict {
			return headOutcome{}, &AppError{Kind: AppErrorLandConflict, Paths: gitErr.Paths}
		}
		return headOutcome{}, landGitError(err)
	}
	after, err := deps.Git.Resolve(ctx, worktree, "HEAD")
	if err != nil {
		return headOutcome{}, landGitError(err)
	}
	return headOutcome{toLand: after, tip: tip}, nil
}

// regeneratePaths is every regenerate rule's paths, the globs a rebase settles by taking the tip's
// side.
func regeneratePaths(job domain.Job) []string {
	var paths []string
	if job.Brief.Regenerate != nil {
		for _, rule := range *job.Brief.Regenerate {
			paths = append(paths, rule.Paths...)
		}
	}
	return paths
}

// commitPending commits whatever is not yet committed on the job branch.
func commitPending(ctx context.Context, deps Deps, job domain.Job, worktree string, verify bool, trailer ports.TrailerSetting) error {
	head, err := deps.Git.Resolve(ctx, worktree, "HEAD")
	if err != nil {
		return landGitError(err)
	}
	pending, err := deps.Git.Changes(ctx, worktree, head)
	if err != nil {
		return landGitError(err)
	}
	if len(domain.ChangedPaths(pending)) == 0 {
		return nil
	}
	if _, err := deps.Git.CommitAll(ctx, worktree, commitMessage(deps.Provider, job, trailer), ports.CommitOptions{Verify: verify}); err != nil {
		return landGitError(err)
	}
	return nil
}

// regenerate runs every regenerate rule in the worktree and amends what changed into the job's
// last commit.
func regenerate(ctx context.Context, deps Deps, job domain.Job, worktree, commit string, verify bool) (string, error) {
	paths := deps.Store.Paths(job.ID)
	env := PassEnv(deps, job)
	if job.Brief.Regenerate != nil {
		for i, rule := range *job.Brief.Regenerate {
			result := deps.Gates.Run(ctx, worktree, domain.Gate{
				Run: rule.Run, TimeoutMs: domain.DefaultGateTimeoutMs,
			}, env, paths.RegenerateLog(i))
			if domain.GateFailed(result) {
				return "", &AppError{Kind: AppErrorLandVerifyFailed, Command: result.Run, Tail: result.Tail}
			}
		}
	}
	changed, err := deps.Git.Changes(ctx, worktree, commit)
	if err != nil {
		return "", landGitError(err)
	}
	if len(domain.ChangedPaths(changed)) == 0 {
		return commit, nil
	}
	amended, err := deps.Git.AmendAll(ctx, worktree, ports.CommitOptions{Verify: verify})
	if err != nil {
		return "", landGitError(err)
	}
	return amended, nil
}

// verifyCommit verifies the exact commit to land in a fresh detached checkout: the brief's setup,
// then every gate. A checkout that is not this commit's could pass for other reasons, so only this
// one is trusted; either way it is removed.
func verifyCommit(ctx context.Context, deps Deps, job domain.Job, commit string) error {
	setup := []string{}
	if job.Brief.Setup != nil {
		setup = *job.Brief.Setup
	}
	if len(setup) == 0 && len(job.Brief.Gates) == 0 {
		return nil
	}
	paths := deps.Store.Paths(job.ID)
	deps.Files.RemoveTree(paths.Checkout)
	if err := deps.Git.AddDetachedWorktree(ctx, job.Workspace.RepoRoot, paths.Checkout, commit); err != nil {
		return landGitError(err)
	}
	// Always: a leftover checkout is exactly the kind of state a clean repository should not carry.
	defer func() {
		if removedErr := deps.Git.RemoveDetachedWorktree(ctx, job.Workspace.RepoRoot, paths.Checkout); removedErr != nil {
			deps.Out.Error(fmt.Sprintf("%s: job %s: its temporary checkout could not be removed: %s",
				deps.Provider.Name, job.ID, DescribeGitError(*asGitError(removedErr))))
		}
	}()
	results := RunSetupAndGates(ctx, deps, job, paths.Checkout, func(i int) string {
		return paths.LandCheckLog(i)
	})
	for _, result := range results {
		if domain.GateFailed(result) {
			return &AppError{Kind: AppErrorLandVerifyFailed, Command: result.Run, Tail: result.Tail}
		}
	}
	return nil
}

// commitMessage is title, the report's summary, and — unless the repository sets
// `<provider>.trailer: none` — the trailer naming the model that did the work and the harness it
// ran in.
func commitMessage(provider domain.Provider, job domain.Job, trailer ports.TrailerSetting) string {
	var lastReport json.RawMessage
	if len(job.Attempts) > 0 {
		lastReport = job.Attempts[len(job.Attempts)-1].Report
	}
	summary := ReportFacts(lastReport).Summary
	parts := []string{job.Brief.Title}
	if summary != nil {
		parts = append(parts, *summary)
	}
	if trailer != ports.TrailerSettingNone {
		parts = append(parts, "Worked-by: "+provider.Catalog[job.Brief.Model].ID+" via "+provider.Harness)
	}
	return strings.Join(parts, "\n\n") + "\n"
}

// RemoveWorkspace removes an edit job's worktree and branch once decided; a failure is reported,
// the decision stands.
func RemoveWorkspace(ctx context.Context, deps Deps, job domain.Job) {
	worktree, branch := job.Workspace.Worktree, job.Workspace.Branch
	if worktree == nil || branch == nil {
		return
	}
	if err := deps.Git.RemoveWorktree(ctx, job.Workspace.RepoRoot, *worktree, *branch); err != nil {
		deps.Out.Error(fmt.Sprintf("%s: job %s is %s, but its worktree could not be removed: %s",
			deps.Provider.Name, job.ID, job.State, DescribeGitError(*asGitError(err))))
	}
}

package app

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// terminalStates is the set a decision ended.
var terminalStates = map[domain.JobState]bool{
	domain.JobStateAccepted:  true,
	domain.JobStateDiscarded: true,
}

// CleanupWorkspace removes what a previous run left behind: the worktrees and branches of decided
// jobs whose removal failed, the temporary checkouts of interrupted accepts, and engine processes
// whose driver died. Best effort and silent — a failed cleanup never blocks the command — and it
// touches only the plugin's own directories (its state root) and branch prefix, never anything of
// the user's. The first failure ends the pass quietly.
func CleanupWorkspace(ctx context.Context, deps Deps) {
	// Nothing cleanup reports is worth a failing command; a panic from a broken store is just as
	// silent.
	defer func() { _ = recover() }()
	jobs := deps.Store.List(ctx, ports.ListFilter{})
	for _, job := range jobs {
		if !terminalStates[job.State] {
			continue
		}
		if err := removeWorkspaceIfLeft(ctx, deps, job); err != nil {
			return
		}
	}
	if err := removeLeftoverCheckouts(ctx, deps); err != nil {
		return
	}
	ReapOrphanEngines(ctx, deps, jobs)
}

// removeWorkspaceIfLeft removes a decided job's worktree: normally gone with the decision itself,
// this catches the one that outlived it.
func removeWorkspaceIfLeft(ctx context.Context, deps Deps, job domain.Job) error {
	worktree, branch := job.Workspace.Worktree, job.Workspace.Branch
	if worktree == nil || branch == nil || !deps.Files.Exists(*worktree) {
		return nil
	}
	if absPath(*worktree) != domain.NewStateLayout(deps.Host.StateRoot).Job(job.ID).Worktree {
		return nil
	}
	if !strings.HasPrefix(*branch, deps.Provider.BranchPrefix) {
		return nil
	}
	return deps.Git.RemoveWorktree(ctx, job.Workspace.RepoRoot, *worktree, *branch)
}

// removeLeftoverCheckouts removes the accepts' leftover checkouts. Checkout directories are named
// by job id, and one only exists while an accept holds the job's lock. So the lock settles each:
// held means an accept may be in flight (skip), acquirable or a job that no longer exists means
// the checkout is a leftover nobody is coming back for.
func removeLeftoverCheckouts(ctx context.Context, deps Deps) error {
	for _, id := range deps.Files.CheckoutIds() {
		checkout := deps.Store.Paths(id).Checkout
		if !deps.Files.Exists(checkout) {
			continue
		}
		release, err := deps.Store.Lock(ctx, id, int64(os.Getpid()))
		if err == nil {
			removeErr := removeCheckout(ctx, deps, checkout)
			release()
			if removeErr != nil {
				return removeErr
			}
			continue
		}
		var storeErr *ports.StoreError
		if errors.As(err, &storeErr) && storeErr.Kind == ports.StoreErrorNotFound {
			if err := removeCheckout(ctx, deps, checkout); err != nil {
				return err
			}
		}
	}
	return nil
}

// removeCheckout removes one leftover checkout: its worktree registration, when the repository
// that holds it can still be found, then whatever is left on disk.
func removeCheckout(ctx context.Context, deps Deps, checkout string) error {
	if repoRoot, ok := deps.Files.CheckoutRepo(checkout); ok {
		if err := deps.Git.RemoveDetachedWorktree(ctx, repoRoot, checkout); err != nil {
			return err
		}
	}
	deps.Files.RemoveTree(checkout)
	return nil
}

// absPath makes a path absolute and clean, as Node's path.resolve does (no symlink resolution):
// a relative path joins onto the working directory.
func absPath(path string) string {
	wd, _ := os.Getwd()
	return domain.ResolvePath(wd, path)
}

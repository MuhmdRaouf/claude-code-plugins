package adapters

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Landing a job branch — the trailer setting, ancestry, the rebase onto the tip, amending and
// the ff-only merge.

// landMaxRebaseRounds bounds the rebase: one that keeps stopping has gone wrong; the job branch is
// not that long.
const landMaxRebaseRounds = 50

// ReadTrailer is the repository's `<provider>.trailer`: worked-by unless set to none (an unknown
// value is an error, not a guess).
func ReadTrailer(ctx context.Context, provider, repo string) (ports.TrailerSetting, error) {
	args := []string{"config", "--get", provider + ".trailer"}
	run := RunGit(ctx, repo, args, GitRunOptions{})
	if run.Ok {
		value := strings.TrimSpace(string(run.Stdout))
		if value == "" || value == "worked-by" {
			return ports.TrailerSettingWorkedBy, nil
		}
		if value == "none" {
			return ports.TrailerSettingNone, nil
		}
		return "", &ports.GitError{
			Kind:    ports.GitErrorGitFailed,
			Command: "git " + strings.Join(args, " "),
			Stderr:  `"` + value + `" is not worked-by or none`,
		}
	}
	// An unset key is git's quiet exit 1; anything else is a real failure.
	if run.Code != nil && *run.Code == 1 {
		return ports.TrailerSettingWorkedBy, nil
	}
	return "", GitError(repo, args, run)
}

// IsAncestor reports whether ancestor is contained in descendant's history.
func IsAncestor(ctx context.Context, repo, ancestor, descendant string) (bool, error) {
	args := []string{"merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant}
	run := RunGit(ctx, repo, args, GitRunOptions{})
	if run.Ok {
		return true, nil
	}
	// "Not an ancestor" is git's quiet exit 1; a bad ref or a broken repo exits 128 with a message.
	if run.Code != nil && *run.Code == 1 {
		return false, nil
	}
	return false, GitError(repo, args, run)
}

// landRebaseInProgress reports a stopped rebase: it leaves `rebase-merge` (merge backend) or
// `rebase-apply` (apply backend) in the git dir.
func landRebaseInProgress(ctx context.Context, worktree string) (bool, *ports.GitError) {
	for _, state := range []string{"rebase-merge", "rebase-apply"} {
		path, err := GitValue(ctx, worktree, []string{"rev-parse", "--git-path", state}, GitRunOptions{})
		if err != nil {
			return false, err
		}
		if _, statErr := os.Stat(gitResolveWithin(worktree, path)); statErr == nil {
			return true, nil
		}
	}
	return false, nil
}

// landAbortRebase aborts a stopped rebase: the job branch goes back where it was, nothing applied.
func landAbortRebase(ctx context.Context, worktree string) *ports.GitError {
	return GitVoid(ctx, worktree, []string{"rebase", "--abort"}, GitRunOptions{})
}

// landRebaseStep is how one rebase round ended: finished, or stopped again on the next job commit.
type landRebaseStep string

const (
	landRebaseFinished     landRebaseStep = "finished"
	landRebaseStoppedAgain landRebaseStep = "stopped-again"
)

// RebaseJobBranch rebases the job branch checked out in worktree onto onto. A conflict outside the
// regenerate globs aborts the rebase and reports every unmerged path; conflicts inside them take
// onto's side (ours, mid-rebase) and carry on, since the file is regenerated before landing anyway.
func RebaseJobBranch(ctx context.Context, worktree, onto string, regenerate []string) error {
	args := []string{"rebase", "--quiet", "--end-of-options", onto}
	isRegenerated := func(path string) bool { return domain.AnyGlob(regenerate, path) }
	for round := 0; round < landMaxRebaseRounds; round++ {
		// Running the rebase again while it is stopped fails harmlessly; the round then continues it.
		step, err := landAdvanceRebase(ctx, worktree, args, isRegenerated)
		if err != nil {
			return err
		}
		if step == landRebaseFinished {
			return nil
		}
	}
	return &ports.GitError{
		Kind:    ports.GitErrorGitFailed,
		Command: "git " + strings.Join(args, " "),
		Stderr:  fmt.Sprintf("still reporting conflicts after %d commits", landMaxRebaseRounds),
	}
}

// landAdvanceRebase runs one round: the rebase and, when it stops on conflicts, settling the stop
// and continuing it. An error ends the rebase for good — except a continue that stopped again,
// which asks for one more round.
func landAdvanceRebase(ctx context.Context, worktree string, args []string, isRegenerated func(string) bool) (landRebaseStep, *ports.GitError) {
	rebase := RunGit(ctx, worktree, args, GitRunOptions{})
	if rebase.Ok {
		return landRebaseFinished, nil
	}
	stopped, err := landRebaseInProgress(ctx, worktree)
	if err != nil {
		return "", err
	}
	if !stopped {
		return "", GitError(worktree, args, rebase)
	}
	failWith, err := landResolveConflicts(ctx, worktree, isRegenerated)
	if err != nil {
		return "", err
	}
	if failWith != nil {
		return "", failWith
	}
	// Continuing may stop again on the next job commit; the caller classifies each stop the same way.
	continued := RunGit(ctx, worktree, []string{"rebase", "--continue"}, GitRunOptions{})
	if continued.Ok {
		return landRebaseFinished, nil
	}
	return landRebaseStoppedAgain, nil
}

// landResolveConflicts settles one stopped rebase: the error to fail with, or none when it resolved
// cleanly and the rebase continues. worktree's branch is back where it was by the time an error
// leaves here.
func landResolveConflicts(ctx context.Context, worktree string, isRegenerated func(string) bool) (*ports.GitError, *ports.GitError) {
	unmerged, err := GitText(ctx, worktree, []string{"diff", "--name-only", "--diff-filter=U", "-z"}, GitRunOptions{})
	if err != nil {
		return nil, err
	}
	paths := SplitNul(unmerged)
	outsideRegenerate := false
	for _, path := range paths {
		if !isRegenerated(path) {
			outsideRegenerate = true
			break
		}
	}
	if outsideRegenerate {
		if aborted := landAbortRebase(ctx, worktree); aborted != nil {
			return nil, aborted
		}
		return &ports.GitError{Kind: ports.GitErrorConflict, Paths: paths}, nil
	}
	for _, path := range paths {
		failWith, err := landSettleRegenerated(ctx, worktree, path)
		if err != nil {
			return nil, err
		}
		if failWith != nil {
			return failWith, nil
		}
	}
	return nil, nil
}

// landSettleRegenerated takes the tip's side (ours, mid-rebase) for one regenerated path and stages
// it; the error to fail with, the rebase already aborted unless the abort itself failed.
func landSettleRegenerated(ctx context.Context, worktree, path string) (*ports.GitError, *ports.GitError) {
	failure := landTakeTipSide(ctx, worktree, path)
	if failure == nil {
		return nil, nil
	}
	if aborted := landAbortRebase(ctx, worktree); aborted != nil {
		return nil, aborted
	}
	return failure, nil
}

// landTakeTipSide is the error that stopped this path, or none when its conflict was settled and
// staged.
func landTakeTipSide(ctx context.Context, worktree, path string) *ports.GitError {
	args := []string{"checkout", "--ours", "--", path}
	taken := RunGit(ctx, worktree, args, GitRunOptions{})
	if !taken.Ok {
		return GitError(worktree, args, taken)
	}
	return GitVoid(ctx, worktree, []string{"add", "--", path}, GitRunOptions{})
}

// AmendAll stages everything in dir and amends it into HEAD; it returns the amended commit's sha.
func AmendAll(ctx context.Context, dir string, opts ports.CommitOptions) (string, error) {
	if err := gitCliVoidError(ctx, dir, []string{"add", "-A"}, GitRunOptions{}); err != nil {
		return "", err
	}
	args := []string{"commit", "--quiet"}
	if !opts.Verify {
		args = append(args, "--no-verify")
	}
	args = append(args, "--amend", "--no-edit", "--cleanup=whitespace")
	if err := gitCliVoidError(ctx, dir, args, GitRunOptions{}); err != nil {
		return "", err
	}
	sha, err := landHeadSha(ctx, dir)
	if err != nil {
		return "", err
	}
	return sha, nil
}

// landHeadSha is the sha HEAD points at.
func landHeadSha(ctx context.Context, dir string) (string, *ports.GitError) {
	return GitValue(ctx, dir, []string{"rev-parse", "--verify", "HEAD"}, GitRunOptions{})
}

// AddDetachedWorktree makes a detached temporary checkout of sha at path, for verifying a commit
// exactly as it lands.
func AddDetachedWorktree(ctx context.Context, repo, path, sha string) error {
	// Registrations of removed checkouts would make git refuse the path.
	if err := gitCliVoidError(ctx, repo, []string{"worktree", "prune"}, GitRunOptions{}); err != nil {
		return err
	}
	return gitCliVoidError(ctx, repo, []string{"worktree", "add", "--quiet", "--detach", "--", path, sha}, GitRunOptions{})
}

// RemoveDetachedWorktree removes a detached checkout and its registration.
func RemoveDetachedWorktree(ctx context.Context, repo, path string) error {
	removed := GitVoid(ctx, repo, []string{"worktree", "remove", "--force", "--force", "--", path}, GitRunOptions{})
	// Already gone on disk: only the stale registration is left to prune.
	if removed != nil {
		if _, statErr := os.Stat(path); statErr == nil {
			return removed
		}
	}
	return gitCliVoidError(ctx, repo, []string{"worktree", "prune"}, GitRunOptions{})
}

// FastForward fast-forwards repo's current branch to sha, but only onto the tip the caller last saw
// as expectedTip: the tip moving meanwhile is "moved", not a failure. Refuses up front (dirty) when
// uncommitted files overlap the change set, since git would refuse too, less precisely.
func FastForward(ctx context.Context, repo, sha, expectedTip string) (ports.FastForwardOutcome, error) {
	tip, err := landHeadSha(ctx, repo)
	if err != nil {
		return "", err
	}
	if tip != expectedTip {
		return ports.FastForwardMoved, nil
	}
	touchedArgs := []string{"diff", "--name-only", "-z", "--no-renames", "--end-of-options", expectedTip, sha, "--"}
	touched, err := GitText(ctx, repo, touchedArgs, GitRunOptions{})
	if err != nil {
		return "", err
	}
	blocked, err := BlockingPaths(ctx, repo, SplitNul(touched), BlockingOptions{StagedAnywhere: false})
	if err != nil {
		return "", err
	}
	if len(blocked) > 0 {
		return "", &ports.GitError{Kind: ports.GitErrorDirty, Paths: blocked}
	}

	args := []string{"merge", "--quiet", "--ff-only", "--end-of-options", sha}
	merged := RunGit(ctx, repo, args, GitRunOptions{})
	if merged.Ok {
		return ports.FastForwardLanded, nil
	}
	// The merge raced with a commit that moved the tip; anything else is a real failure.
	after, afterErr := landHeadSha(ctx, repo)
	if afterErr == nil && after != expectedTip {
		return ports.FastForwardMoved, nil
	}
	return "", GitError(repo, args, merged)
}

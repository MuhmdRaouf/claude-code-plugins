package adapters

import (
	"context"
	"os"
	"sort"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The Git adapter over the git CLI. `git` runs through the tool runner (no shell) with
// `-c core.quotepath=off` and NUL-separated outputs; provider names its temp index dirs.

// GitCli is ports.Git implemented over the git CLI.
type GitCli struct {
	provider string
}

// CreateGitCli builds the Git adapter for provider.
func CreateGitCli(provider string) ports.Git {
	return &GitCli{provider: provider}
}

// gitCliHeadSha is the sha HEAD points at.
func gitCliHeadSha(ctx context.Context, dir string) (string, *ports.GitError) {
	return GitValue(ctx, dir, []string{"rev-parse", "--verify", "HEAD"}, GitRunOptions{})
}

// gitCliVoidError runs git and reports only its failure: GitVoid's concrete error handed to the
// error interface without a typed nil.
func gitCliVoidError(ctx context.Context, cwd string, args []string, options GitRunOptions) error {
	if err := GitVoid(ctx, cwd, args, options); err != nil {
		return err
	}
	return nil
}

// Root resolves the repository's top level from anywhere inside it.
func (g *GitCli) Root(ctx context.Context, cwd string) (string, error) {
	top, err := GitValue(ctx, cwd, []string{"rev-parse", "--show-toplevel"}, GitRunOptions{})
	if err != nil {
		return "", &ports.GitError{Kind: ports.GitErrorNotARepo, Path: cwd}
	}
	return top, nil
}

// Resolve turns a ref into its commit sha.
func (g *GitCli) Resolve(ctx context.Context, repo string, ref string) (string, error) {
	args := []string{"rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}"}
	sha, err := GitValue(ctx, repo, args, GitRunOptions{})
	if err == nil {
		return sha, nil
	}
	if err.Kind == ports.GitErrorNotARepo {
		return "", err
	}
	return "", &ports.GitError{Kind: ports.GitErrorBadRef, Ref: ref}
}

// CurrentBranch names the branch checked out in repo.
func (g *GitCli) CurrentBranch(ctx context.Context, repo string) (string, error) {
	args := []string{"symbolic-ref", "--quiet", "--short", "HEAD"}
	branch, err := GitValue(ctx, repo, args, GitRunOptions{})
	if err == nil {
		return branch, nil
	}
	if err.Kind != ports.GitErrorGitFailed {
		return "", err
	}
	return "", &ports.GitError{Kind: ports.GitErrorGitFailed, Command: err.Command, Stderr: "HEAD is detached"}
}

// AddWorktree checks out a new branch at baseSha in a linked worktree at path.
func (g *GitCli) AddWorktree(ctx context.Context, repo, path, branch, baseSha string) error {
	return gitCliVoidError(ctx, repo, []string{"worktree", "add", "--quiet", "-b", branch, "--", path, baseSha}, GitRunOptions{})
}

// RemoveWorktree removes a linked worktree and its branch.
func (g *GitCli) RemoveWorktree(ctx context.Context, repo, path, branch string) error {
	removed := GitVoid(ctx, repo, []string{"worktree", "remove", "--force", "--force", "--", path}, GitRunOptions{})
	// Already gone (a retried discard, or deleted by hand): only the stale registration is left to prune.
	if removed != nil {
		if _, statErr := os.Stat(path); statErr == nil {
			return removed
		}
	}
	if err := gitCliVoidError(ctx, repo, []string{"worktree", "prune"}, GitRunOptions{}); err != nil {
		return err
	}
	exists := RunGit(ctx, repo, []string{"rev-parse", "--verify", "--quiet", "refs/heads/" + branch}, GitRunOptions{})
	if exists.Ok {
		return gitCliVoidError(ctx, repo, []string{"branch", "-D", "--", branch}, GitRunOptions{})
	}
	return nil
}

// Changes lists the changes in dir against baseSha, untracked files included.
func (g *GitCli) Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error) {
	// ls-files first: outside a repository `git diff` silently falls back to --no-index and fails
	// confusingly.
	untracked, err := GitText(ctx, dir, []string{"ls-files", "--others", "--exclude-standard", "-z"}, GitRunOptions{})
	if err != nil {
		return domain.ChangeSet{}, err
	}
	tracked, err := GitText(ctx, dir, []string{"diff", "--name-status", "-z", "--no-renames", "--end-of-options", baseSha, "--"}, GitRunOptions{})
	if err != nil {
		return domain.ChangeSet{}, err
	}
	changes := ParseNameStatus(tracked)
	changes.Untracked = SplitNul(untracked)
	sort.Strings(changes.Untracked)
	return changes, nil
}

// StatusFingerprint fingerprints dir's working state: the HEAD state, the porcelain status and the
// content of every path it lists.
func (g *GitCli) StatusFingerprint(ctx context.Context, dir string) (string, error) {
	status, err := GitText(ctx, dir, StatusArgs, GitRunOptions{})
	if err != nil {
		return "", err
	}
	sha := RunGit(ctx, dir, []string{"rev-parse", "--verify", "--quiet", "HEAD"}, GitRunOptions{})
	ref := RunGit(ctx, dir, []string{"symbolic-ref", "--quiet", "HEAD"}, GitRunOptions{})
	head := "unborn"
	if sha.Ok {
		head = string(sha.Stdout)
	}
	refText := "detached"
	if ref.Ok {
		refText = string(ref.Stdout)
	}
	head += "\x00" + refText
	entries := ParseStatus(status)
	paths := make([]string, len(entries))
	for i, entry := range entries {
		paths[i] = entry.Path
	}
	return Fingerprint(ctx, dir, head, status, paths), nil
}

// Diff diffs dir's working state (untracked included, from a private snapshot) against baseSha.
func (g *GitCli) Diff(ctx context.Context, dir string, baseSha string, opts ports.DiffOptions) (string, error) {
	tree, err := SnapshotTree(ctx, dir, g.provider)
	if err != nil {
		return "", err
	}
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if opts.Stat {
		args = append(args, "--stat=200")
	}
	args = append(args, "--end-of-options", baseSha, tree, "--")
	text, err := GitText(ctx, dir, args, GitRunOptions{})
	if err != nil {
		return "", err
	}
	return text, nil
}

// CommitAll stages everything in dir and commits it; it returns the commit's sha.
func (g *GitCli) CommitAll(ctx context.Context, dir, message string, opts ports.CommitOptions) (string, error) {
	if err := gitCliVoidError(ctx, dir, []string{"add", "-A"}, GitRunOptions{}); err != nil {
		return "", err
	}
	// The repository's hooks run unless the caller opts out; a failing hook fails the commit with its
	// output. --cleanup=whitespace keeps `#` lines (markdown headings) in the message.
	args := []string{"commit", "--quiet"}
	if !opts.Verify {
		args = append(args, "--no-verify")
	}
	args = append(args, "--cleanup=whitespace", "--file=-")
	if err := gitCliVoidError(ctx, dir, args, GitRunOptions{Stdin: &message}); err != nil {
		return "", err
	}
	sha, err := gitCliHeadSha(ctx, dir)
	if err != nil {
		return "", err
	}
	return sha, nil
}

// Trailer is the repository's <provider>.trailer setting.
func (g *GitCli) Trailer(ctx context.Context, repo string) (ports.TrailerSetting, error) {
	return ReadTrailer(ctx, g.provider, repo)
}

// IsAncestor reports whether ancestor is contained in descendant's history.
func (g *GitCli) IsAncestor(ctx context.Context, repo, ancestor, descendant string) (bool, error) {
	return IsAncestor(ctx, repo, ancestor, descendant)
}

// RebaseJobBranch rebases the job branch checked out in worktree onto onto.
func (g *GitCli) RebaseJobBranch(ctx context.Context, worktree, onto string, regenerate []string) error {
	return RebaseJobBranch(ctx, worktree, onto, regenerate)
}

// AmendAll stages everything in dir and amends it into HEAD; it returns the amended commit's sha.
func (g *GitCli) AmendAll(ctx context.Context, dir string, opts ports.CommitOptions) (string, error) {
	return AmendAll(ctx, dir, opts)
}

// AddDetachedWorktree checks sha out at path with no branch.
func (g *GitCli) AddDetachedWorktree(ctx context.Context, repo, path, sha string) error {
	return AddDetachedWorktree(ctx, repo, path, sha)
}

// RemoveDetachedWorktree removes a detached checkout and its registration.
func (g *GitCli) RemoveDetachedWorktree(ctx context.Context, repo, path string) error {
	return RemoveDetachedWorktree(ctx, repo, path)
}

// FastForward lands sha onto the tip the caller last saw.
func (g *GitCli) FastForward(ctx context.Context, repo, sha, expectedTip string) (ports.FastForwardOutcome, error) {
	return FastForward(ctx, repo, sha, expectedTip)
}

// ApplyToWorkingTree applies the worktree's change set to repo's working tree without committing
// (3-way).
func (g *GitCli) ApplyToWorkingTree(ctx context.Context, repo, worktree, baseSha string) error {
	if err := ApplyToWorkingTree(ctx, repo, worktree, baseSha, g.provider); err != nil {
		return err
	}
	return nil
}

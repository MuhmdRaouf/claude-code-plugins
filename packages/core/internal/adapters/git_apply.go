package adapters

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Applying one worktree's change set to another working tree.

// gitRemoveFile removes a deleted file and the directories it leaves empty, as git would.
func gitRemoveFile(ctx context.Context, repo, path string) {
	_ = os.Remove(filepath.Join(repo, path))
	for dir := filepath.Dir(path); dir != "."; dir = filepath.Dir(dir) {
		if err := os.Remove(filepath.Join(repo, dir)); err != nil {
			return
		}
	}
}

// gitMergeIntoIndex 3-way applies the patch to the (private) index in env; conflicts come back with
// their paths.
func gitMergeIntoIndex(ctx context.Context, repo string, patch string, env map[string]string) *ports.GitError {
	args := []string{"apply", "--cached", "--3way", "--whitespace=nowarn"}
	applied := RunGit(ctx, repo, args, GitRunOptions{Stdin: &patch, Env: env})
	if applied.Ok {
		return nil
	}
	unmerged, err := GitText(ctx, repo, []string{"ls-files", "--unmerged", "-z"}, GitRunOptions{Env: env})
	paths := []string{}
	if err == nil {
		paths = UnmergedPaths(unmerged)
	}
	if len(paths) > 0 {
		return &ports.GitError{Kind: ports.GitErrorConflict, Paths: paths}
	}
	return GitError(repo, args, applied)
}

// gitWriteMerged writes the merged files from the index in env to repo's working tree, and removes
// the deleted ones.
func gitWriteMerged(ctx context.Context, repo string, written, deleted []string, env map[string]string) *ports.GitError {
	if len(written) > 0 {
		input := strings.Join(written, "\x00") + "\x00"
		if err := GitVoid(ctx, repo, []string{"checkout-index", "--force", "-z", "--stdin"}, GitRunOptions{Stdin: &input, Env: env}); err != nil {
			return err
		}
	}
	for _, path := range deleted {
		gitRemoveFile(ctx, repo, path)
	}
	return nil
}

// ApplyToWorkingTree applies the worktree's change set (everything `add -A` would see, against
// baseSha) to repo's working tree only. The 3-way merge runs first in a private copy of repo's
// index, so a conflict leaves repo untouched; the merged files are then written with
// `checkout-index` from that copy, so repo's own index (what the user has staged) never changes.
func ApplyToWorkingTree(ctx context.Context, repo, worktree, baseSha, provider string) *ports.GitError {
	tree, err := SnapshotTree(ctx, worktree, provider)
	if err != nil {
		return err
	}
	gitRange := []string{"--no-renames", "--end-of-options", baseSha, tree, "--"}
	// Diffs run in the worktree (proven a repository by the snapshot; objects are shared with repo):
	// outside a repository `git diff` would fall back to --no-index.
	listed, err := GitText(ctx, worktree, append([]string{"diff", "--name-status", "-z"}, gitRange...), GitRunOptions{})
	if err != nil {
		return err
	}
	changes := ParseNameStatus(listed)
	written := append(append([]string{}, changes.Added...), changes.Modified...)
	if len(written)+len(changes.Deleted) == 0 {
		return nil
	}

	blocking, err := BlockingPaths(ctx, repo, append(append([]string{}, written...), changes.Deleted...), BlockingOptions{})
	if err != nil {
		return err
	}
	if len(blocking) > 0 {
		return &ports.GitError{Kind: ports.GitErrorDirty, Paths: blocking}
	}

	patchArgs := append([]string{"diff", "--binary", "--full-index", "--no-color", "--no-ext-diff"}, gitRange...)
	patch := RunGit(ctx, worktree, patchArgs, GitRunOptions{})
	if !patch.Ok {
		return GitError(worktree, patchArgs, patch)
	}

	_, mergeErr := WithTempIndex(ctx, repo, provider, func(env map[string]string) (struct{}, *ports.GitError) {
		if err := gitMergeIntoIndex(ctx, repo, string(patch.Stdout), env); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, gitWriteMerged(ctx, repo, written, changes.Deleted, env)
	})
	return mergeErr
}

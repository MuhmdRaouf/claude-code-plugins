package adapters

import (
	"context"
	"os"
	"path/filepath"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Trees of a working state, staged in a private copy of the index.

// WithTempIndex runs fn with a private copy of dir's index (GIT_INDEX_FILE), so staging there never
// touches the real index. The copy lives in a temp dir named after the provider
// (`<provider>-index-…`).
func WithTempIndex[T any](ctx context.Context, dir, provider string, fn func(env map[string]string) (T, *ports.GitError)) (T, *ports.GitError) {
	var zero T
	located, err := GitValue(ctx, dir, []string{"rev-parse", "--git-path", "index"}, GitRunOptions{})
	if err != nil {
		return zero, err
	}
	scratch, mkErr := os.MkdirTemp("", provider+"-index-")
	if mkErr != nil {
		// A temp dir that cannot be made comes back as a git failure like any other.
		return zero, &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "mkdtemp", Stderr: mkErr.Error()}
	}
	defer os.RemoveAll(scratch)
	index := filepath.Join(scratch, "index")
	// No readable index: start empty. The tree is the same, `add -A` just hashes every file.
	_ = gitCopyIndex(ctx, gitResolveWithin(dir, located), index)
	return fn(map[string]string{"GIT_INDEX_FILE": index})
}

// gitResolveWithin joins a path git printed relative to the cwd it ran in; an absolute one stands
// on its own (inside a linked worktree --git-path prints an absolute path), like Node's resolve.
func gitResolveWithin(dir, located string) string {
	if filepath.IsAbs(located) {
		return located
	}
	return filepath.Join(dir, located)
}

// gitCopyIndex copies the index keeping its timestamps: git re-reads an entry whose mtime is not
// older than the index file (a "racily clean" entry), and a newer copy would make a same-size edit
// made in that window look unchanged.
func gitCopyIndex(ctx context.Context, from, to string) error {
	info, err := os.Stat(from)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err := os.WriteFile(to, data, 0o644); err != nil {
		return err
	}
	return os.Chtimes(to, info.ModTime(), info.ModTime())
}

// SnapshotTree is the tree of dir's working state as `git add -A` sees it (tracked + untracked,
// minus ignored), without changing the real index. It starts from a copy of the real index so
// force-added files stay and unchanged files are not rehashed.
func SnapshotTree(ctx context.Context, dir, provider string) (string, *ports.GitError) {
	return WithTempIndex(ctx, dir, provider, func(env map[string]string) (string, *ports.GitError) {
		if err := GitVoid(ctx, dir, []string{"add", "-A"}, GitRunOptions{Env: env}); err != nil {
			return "", err
		}
		return GitValue(ctx, dir, []string{"write-tree"}, GitRunOptions{Env: env})
	})
}

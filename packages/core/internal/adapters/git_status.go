package adapters

import (
	"context"
	"sort"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Which paths in a repository stand in an operation's way.

// StatusArgs is the porcelain status every dirty check reads.
var StatusArgs = []string{"status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"}

// BlockingOptions shapes BlockingPaths.
type BlockingOptions struct {
	// StagedAnywhere: the operation commits (like cherry-pick), so any staged change blocks.
	StagedAnywhere bool
}

// BlockingPaths returns the paths in repo that block writing touched: dirty or untracked ones among
// them, plus (when the operation commits) any staged change at all. Sorted.
func BlockingPaths(ctx context.Context, repo string, touched []string, opts BlockingOptions) ([]string, *ports.GitError) {
	status, err := GitText(ctx, repo, StatusArgs, GitRunOptions{})
	if err != nil {
		return nil, err
	}
	wanted := make(map[string]bool, len(touched))
	for _, path := range touched {
		wanted[path] = true
	}
	blocking := make([]string, 0)
	for _, entry := range ParseStatus(status) {
		if wanted[entry.Path] || (opts.StagedAnywhere && entry.Staged) {
			blocking = append(blocking, entry.Path)
		}
	}
	sort.Strings(blocking)
	return blocking, nil
}

package cli

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
)

// RepoOf is the repository of cwd, so board/usage/stop --all default to it; false outside a
// repository.
func RepoOf(ctx context.Context, deps app.Deps, cwd string) (string, bool) {
	root, err := deps.Git.Root(ctx, cwd)
	if err != nil {
		return "", false
	}
	return root, true
}

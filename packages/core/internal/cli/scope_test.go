package cli_test

import (
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

func TestRepoOf(t *testing.T) {
	fakes := fakedeps.FakeDeps(t)

	t.Run("the repository of a directory inside one", func(t *testing.T) {
		root, ok := cli.RepoOf(t.Context(), fakes.Deps, "/repo/sub")
		if !ok {
			t.Fatal("ok = false, want true")
		}
		if root != "/repo" {
			t.Fatalf("root = %q, want /repo", root)
		}
	})

	t.Run("outside a repository", func(t *testing.T) {
		root, ok := cli.RepoOf(t.Context(), fakes.Deps, "/elsewhere")
		if ok {
			t.Fatal("ok = true, want false")
		}
		if root != "" {
			t.Fatalf("root = %q, want empty", root)
		}
	})
}

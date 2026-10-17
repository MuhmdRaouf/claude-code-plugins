package adapters

import (
	"path/filepath"
	"regexp"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The adapters name what they leave behind after the provider they serve.
func TestAdaptersTakeTheProvidersName(t *testing.T) {
	for _, name := range []string{"zai", "acme"} {
		t.Run("the temp index dir is <provider>-index-… ("+name+")", func(t *testing.T) {
			testkit.IsolateGitConfig(t)
			repo := testkit.MakeRepo(t)
			var index string

			WithTempIndex(t.Context(), repo.Dir, name, func(env map[string]string) (string, *ports.GitError) {
				index = env["GIT_INDEX_FILE"]
				return "", nil
			})

			if base := filepath.Base(filepath.Dir(index)); !regexp.MustCompile(`^` + name + `-index-`).MatchString(base) {
				t.Fatalf("temp index dir = %q, want the %s-index- prefix", base, name)
			}
		})

		t.Run("a gate that cannot start says so as <provider>: … ("+name+")", func(t *testing.T) {
			result := CreateShellGates(name).Run(t.Context(),
				filepath.Join(testkit.TempDir(t, "gone-"), "missing"),
				domain.Gate{Run: "true", TimeoutMs: 1000},
				map[string]string{},
				filepath.Join(testkit.TempDir(t, "log-"), "g.log"))

			if !regexp.MustCompile(`^` + name + `: could not start gate: `).MatchString(result.Tail) {
				t.Fatalf("tail = %q, want it to start with %q", result.Tail, name+": could not start gate: ")
			}
		})
	}
}

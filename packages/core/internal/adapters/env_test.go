package adapters

import (
	"maps"
	"slices"
	"strings"
	"testing"
)

// The allowlist runs through claude_headless_test.go and shell_gates_test.go too; these are
// the direct tests of env.go.

func TestEnvAllowlist(t *testing.T) {
	t.Run("carries no CLAUDE_* name", func(t *testing.T) {
		// All a gate process inherits from the parent; a CLAUDE_* name here would route or
		// configure the worker from the orchestrator's own session.
		for _, name := range ENV_ALLOWLIST {
			if strings.HasPrefix(name, "CLAUDE") {
				t.Fatalf("ENV_ALLOWLIST carries %q", name)
			}
		}
	})

	t.Run("lists the basics a worker starts from", func(t *testing.T) {
		want := []string{"PATH", "HOME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "USER", "LOGNAME"}
		if !slices.Equal(ENV_ALLOWLIST, want) {
			t.Fatalf("ENV_ALLOWLIST = %v, want %v", ENV_ALLOWLIST, want)
		}
	})
}

func TestPickAllowlisted(t *testing.T) {
	t.Run("copies only the allowlisted names the parent sets", func(t *testing.T) {
		parent := map[string]string{
			"PATH":               "/usr/bin",
			"HOME":               "/h",
			"LANG":               "",
			"TERM":               "xterm-256color",
			"ANTHROPIC_BASE_URL": "https://anthropic.test",
			"ANTHROPIC_API_KEY":  "sk-test",
			"CLAUDE_PLUGIN_DATA": "/data",
			"ZAI_API_KEY":        "k",
		}
		// A present empty value stands, an absent name is not added, credentials never cross.
		want := map[string]string{"PATH": "/usr/bin", "HOME": "/h", "LANG": "", "TERM": "xterm-256color"}
		if got := PickAllowlisted(parent); !maps.Equal(got, want) {
			t.Fatalf("pickAllowlisted = %v, want %v", got, want)
		}
	})
}

func TestWithoutReserved(t *testing.T) {
	t.Run("drops the names the predicate reserves and keeps the rest", func(t *testing.T) {
		passEnv := map[string]string{"PWD": "/w", "ZAI_ARTIFACTS": "/a", "ANTHROPIC_API_KEY": "k"}
		reserved := func(name string) bool {
			return strings.HasPrefix(name, "ANTHROPIC_") || strings.HasPrefix(name, "ZAI_")
		}
		want := map[string]string{"PWD": "/w"}
		if got := WithoutReserved(passEnv, reserved); !maps.Equal(got, want) {
			t.Fatalf("withoutReserved = %v, want %v", got, want)
		}
	})

	t.Run("keeps everything when nothing is reserved", func(t *testing.T) {
		passEnv := map[string]string{"A": "1", "B": "2"}
		if got := WithoutReserved(passEnv, func(string) bool { return false }); !maps.Equal(got, passEnv) {
			t.Fatalf("withoutReserved = %v, want %v", got, passEnv)
		}
	})
}

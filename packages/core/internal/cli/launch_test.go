package cli_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestOrphanLaunch(t *testing.T) {
	// The launcher SpawnOrphan re-runs the binary as; the wired spawnDriver tests exercise the
	// whole dance, this pins the entry's own contract.
	t.Run("starts the command with its output on the log", func(t *testing.T) {
		t.Setenv(engineChildEnv, "driver")
		log := filepath.Join(testkit.TempDir(t, "core-launch-"), "jobs", "driver.log")

		if code := cli.OrphanLaunch([]string{log, engineFakeBin(t)}); code != 0 {
			t.Fatalf("exit = %d, want 0", code)
		}

		if err := testkit.Until(t, func() bool {
			log, err := os.ReadFile(log)
			return err == nil && strings.TrimSpace(string(log)) == "driver up"
		}, testkit.UntilOptions{TimeoutMs: 20_000, Message: "the log never said the driver was up"}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("an argv without a command is a usage error, a log it cannot open a failure", func(t *testing.T) {
		if code := cli.OrphanLaunch(nil); code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
		blocked := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(blocked, []byte(""), 0o644); err != nil {
			t.Fatal(err)
		}
		if code := cli.OrphanLaunch([]string{filepath.Join(blocked, "out.log"), "/bin/true"}); code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
	})
}

package cli_test

import (
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
)

// The exit codes are the CLI's contract with the plugins that call it.
func TestExitCodes(t *testing.T) {
	codes := []struct {
		code cli.ExitCode
		want int
	}{
		{cli.ExitOK, 0},
		{cli.ExitUnexpected, 1},
		{cli.ExitUsage, 2},
		{cli.ExitNotPass, 3},
		{cli.ExitNotFound, 4},
		{cli.ExitConflict, 5},
		{cli.ExitNotReady, 6},
		{cli.ExitInterrupted, 130},
	}
	for _, tc := range codes {
		if int(tc.code) != tc.want {
			t.Fatalf("exit code = %d, want %d", tc.code, tc.want)
		}
	}
}

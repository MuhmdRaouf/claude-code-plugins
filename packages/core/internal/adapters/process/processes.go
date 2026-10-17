// The machine's process list, for the retired router's exit check: `ps -axo pid=,lstart=,args=` on
// macOS and Linux, under LC_ALL=C so the start times parse. Unknown when it cannot be read (no ps,
// a failure).
package process

import (
	"context"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// ToolRun is the injected tool runner; RunTool when nil.
type ToolRun func(ctx context.Context, command string, args []string, options ToolOptions) ToolResult

// ProcessList is this machine's running processes, or unknown when the list cannot be read.
func ProcessList(ctx context.Context, run ToolRun) ([]domain.ProcessStart, bool) {
	if run == nil {
		run = RunTool
	}
	timeoutMs := int64(10_000)
	ps := run(ctx, "ps", []string{"-axo", "pid=,lstart=,args="}, ToolOptions{
		Env:       withLcAllC(),
		TimeoutMs: &timeoutMs,
	})
	if !Succeeded(ps) {
		return nil, false
	}
	return domain.ParseProcessList(string(ps.Stdout)), true
}

// withLcAllC is the caller's environment with LC_ALL overridden: the override replaces any key
// already there, so the last value wins.
func withLcAllC() []string {
	environ := os.Environ()
	env := make([]string, 0, len(environ)+1)
	for _, entry := range environ {
		if !strings.HasPrefix(entry, "LC_ALL=") {
			env = append(env, entry)
		}
	}
	return append(env, "LC_ALL=C")
}

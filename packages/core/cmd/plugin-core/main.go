// plugin-core is the single binary behind every provider plugin's dist/run:
// plugin-core <provider> <entry> [args...].
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
)

// version is "dev" unless the build sets it with -ldflags "-X main.version=<VERSION>".
var version = "dev"

const usageLine = "usage: plugin-core <zai|kimi|deepseek|minimax|qwen> <cli|router|passthrough|ensure> [args...]"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	noteStart()
	if len(args) > 0 && args[0] == "--version" {
		fmt.Fprintf(stdout, "plugin-core %s\n", version)
		return 0
	}
	// The orphan launcher SpawnOrphan re-runs this binary as: a plumbing mode, before the
	// provider table (see internal/adapters/process/launch.go).
	if len(args) > 0 && args[0] == "--orphan-launch" {
		return cli.OrphanLaunch(args[1:])
	}
	if len(args) < 2 || !contains(providers, args[0]) || !contains(entryNames, args[1]) {
		// A hook must never fail Claude Code, whatever the arguments look like.
		if contains(args, "--hook") {
			return 0
		}
		fmt.Fprintln(stderr, usageLine)
		return 2
	}
	entryStderr = stderr
	return entries[args[1]](args[0], args[2:])
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// noteStart appends one "plugin-core <pid>" line to $PLUGIN_CORE_STARTED_FILE: the shared plugin
// suites' proof that dist/run exec'd this binary and nothing else stood in (the PLUGIN_CORE_* pins
// are test env production never sets). A write that fails is ignored: a test aid never changes a
// run.
func noteStart() {
	path := os.Getenv("PLUGIN_CORE_STARTED_FILE")
	if path == "" {
		return
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "plugin-core %d\n", os.Getpid())
}

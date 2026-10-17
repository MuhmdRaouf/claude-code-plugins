package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	providerdata "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
)

// providers are the five sibling plugins this binary serves.
var providers = []string{"zai", "kimi", "deepseek", "minimax", "qwen"}

// entryNames are the entry points dist/run maps bundles onto.
var entryNames = []string{"cli", "router", "passthrough", "ensure"}

// entries dispatches a valid (provider, entry) pair.
var entries = map[string]func(provider string, args []string) int{
	"cli":         cliEntry,
	"router":      routerEntry,
	"passthrough": passthroughEntry,
	"ensure":      ensureEntry,
}

// entryStderr receives the entries' output; run points it at the caller's
// stderr because the table signature has no writer parameters.
var entryStderr io.Writer = os.Stderr

func stubEntry(entry string) func(provider string, args []string) int {
	return func(_ string, args []string) int {
		// A hook must never fail Claude Code.
		if contains(args, "--hook") {
			return 0
		}
		fmt.Fprintf(entryStderr, "plugin-core: %s is not built yet\n", entry)
		return 1
	}
}

// cliEntry is the CLI bundle's entry: the wired deps behind runCli, with the plugin's quiet-exit
// rules — a closed pipe on stdout ends the CLI with 0 and nothing said, and on a --hook path any
// failure (a read-only home, a missing file) is silence and 0, never a failed session. Writes go
// straight to the process's files, so the pipes are flushed by the time the process exits.
func cliEntry(name string, args []string) (code int) {
	provider, ok := providerOf(name)
	if !ok {
		fmt.Fprintf(entryStderr, "plugin-core: unknown provider %s\n", name)
		return 2
	}
	hook := contains(args, "--hook")
	// A write to a closed stdout must surface as an error, not the default SIGPIPE death, so the
	// quiet exit below can happen.
	ignoreSigpipe()
	var out interface {
		Line(text string)
		Error(text string)
	} = &processOutput{}
	// The golden transcript's driver children frame their own log (see framedDriverOutput).
	framedDriver := os.Getenv("PLUGIN_CORE_FRAMED_DRIVERS") == "1" && len(args) > 0 && args[0] == "drive"
	if framedDriver {
		out = &framedDriverOutput{}
	}
	bundle := ""
	if root := os.Getenv("CLAUDE_PLUGIN_ROOT"); root != "" {
		bundle = filepath.Join(root, "dist", name+".js")
	}
	code = 0
	func() {
		defer func() {
			if problem := recover(); problem != nil {
				if hook {
					code = 0
					return
				}
				fmt.Fprintf(entryStderr, "plugin-core: %v\n", problem)
				code = 1
			}
		}()
		deps := cli.Wire(context.Background(), cli.WireOptions{
			Provider:   provider,
			Env:        environLookup(),
			Executable: executablePath(),
			BundlePath: bundle,
			Out:        out,
		})
		code = int(cli.RunCli(context.Background(), args, deps, cwd()))
	}()
	if framedDriver {
		out.(*framedDriverOutput).exitLine(code)
	}
	return code
}

// framedDriverOutput is the golden transcript's driver framing. The detached driver's stdout and
// stderr both end up in driver.log, and the transcript that reads the log needs stderr lines
// marked and the exit code said. Only a driver child of a session pinned with
// PLUGIN_CORE_FRAMED_DRIVERS runs under it.
type framedDriverOutput struct{}

func (o *framedDriverOutput) Line(text string) {
	_, _ = os.Stdout.WriteString(text + "\n")
}

func (o *framedDriverOutput) Error(text string) {
	_, _ = os.Stdout.WriteString("stderr| " + text + "\n")
}

// exitLine says how the driver ended.
func (o *framedDriverOutput) exitLine(code int) {
	_, _ = os.Stdout.WriteString(fmt.Sprintf("[exit %d]\n", code))
}

// processOutput writes the CLI's lines to the process's own stdout and stderr, exiting 0 the
// moment stdout is a closed pipe (`plugin-core zai cli run --bg | head -1`).
type processOutput struct{}

func (o *processOutput) Line(text string) {
	if _, err := os.Stdout.WriteString(text + "\n"); err != nil && isClosedPipe(err) {
		os.Exit(0)
	}
}

func (o *processOutput) Error(text string) {
	// stderr's EPIPE is nobody's business either, but it never ends the run.
	_, _ = os.Stderr.WriteString(text + "\n")
}

// isClosedPipe says whether err is the broken pipe a closed stdout reports.
func isClosedPipe(err error) bool {
	return errors.Is(err, syscallEPIPE)
}

// cwd is the working directory the CLI resolves brief paths against, "." when even that failed.
func cwd() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	return dir
}

// environLookup is the process environment as the entries read it.
func environLookup() domain.EnvLookup {
	env := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	return env
}

// providerOf is the provider data a name names; the usage check in run already
// refused anything else, so a miss (a renamed provider mid-release) is a usage error.
func providerOf(name string) (domain.Provider, bool) {
	return providerdata.ByName(name)
}

// routerEntry is the router bundle's entry: run | worker | start | stop | status. Its usage
// error goes to entryStderr (the caller's stderr); its command output is the process's own
// stdout.
func routerEntry(name string, args []string) int {
	// A hook must never fail Claude Code, whatever the arguments look like.
	if contains(args, "--hook") {
		return 0
	}
	provider, ok := providerOf(name)
	if !ok {
		fmt.Fprintf(entryStderr, "plugin-core: unknown provider %s\n", name)
		return 2
	}
	return router.RouterService(router.RouterServiceOptions{
		Provider: provider,
		Script:   executablePath(),
		Env:      environLookup(),
		Argv:     args,
		Err:      entryStderr,
	})
}

// passthroughEntry is the emergency passthrough bundle's entry: serve until
// handed over (or told to go).
func passthroughEntry(name string, args []string) int {
	if contains(args, "--hook") {
		return 0
	}
	provider, ok := providerOf(name)
	if !ok {
		fmt.Fprintf(entryStderr, "plugin-core: unknown provider %s\n", name)
		return 2
	}
	env := environLookup()
	resolved := domain.ResolveProvider(provider, env)
	err := router.RunEmergency(
		router.EmergencyProvider{
			Name:       resolved.Name,
			Display:    resolved.Display,
			EnvPrefix:  resolved.EnvPrefix,
			HealthPath: resolved.Router.HealthPath,
			Port:       resolved.Router.Port,
			Claim:      resolved.ModelClaim(),
		},
		env,
		nil,
	)
	if err != nil {
		fmt.Fprintf(entryStderr, "plugin-core: %s passthrough failed: %s\n", name, err.Error())
		return 1
	}
	return 0
}

// ensureEntry is the UserPromptSubmit and SubagentStart hook's check that the
// router is still there. It never prints and always exits 0.
func ensureEntry(name string, _ []string) int {
	if provider, ok := providerOf(name); ok {
		router.EnsureEntry(provider, environLookup())
	}
	return 0
}

// executablePath is this binary, the script the router forks and copies; "" when even that fails
// (the entries say so in their own words).
func executablePath() string {
	if self, err := os.Executable(); err == nil {
		return self
	}
	return ""
}

// A tool run to completion: git, the OS secret store's command, `<engine> --version`, ps. No shell,
// stdin always closed (written first when given), output collected, a timeout, and nothing thrown: a
// tool that cannot start is a value like any other outcome.
package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
)

// maxToolBuffer is the default output budget: past this many bytes of stdout or stderr the tool is
// killed.
const maxToolBuffer = 512 * 1024 * 1024

// ToolOptions are the options of RunTool.
type ToolOptions struct {
	Cwd string
	// Env is the tool's whole environment; the caller's own when nil.
	Env []string
	// Stdin is written to the tool's stdin before it is closed; stdin is closed either way, so the tool
	// never waits on it.
	Stdin *string
	// TimeoutMs: SIGTERM after this long; the result then has Signal set.
	TimeoutMs *int64
	// MaxBuffer: past this many bytes of stdout or stderr the tool is killed (default 512 MiB).
	MaxBuffer *int64
}

// ToolResultKind is how a tool run ended.
type ToolResultKind string

const (
	ToolExited  ToolResultKind = "exited"
	ToolMissing ToolResultKind = "missing"
)

// ToolResult is a tool run's outcome: exited with its streams, or missing when the tool did not start
// (not on PATH, not executable, a bad cwd).
type ToolResult struct {
	Kind    ToolResultKind
	Code    *int
	Signal  string
	Stdout  []byte
	Stderr  []byte
	Message string
}

// RunTool runs `command args` to completion, collecting its output. It blocks until the tool and its
// pipes are done; a timeout SIGTERMs the tool and an output budget past its limit SIGKILLs it.
func RunTool(ctx context.Context, command string, args []string, options ToolOptions) ToolResult {
	runCtx := ctx
	var cancel context.CancelFunc
	if options.TimeoutMs != nil {
		runCtx, cancel = context.WithTimeout(ctx, time.Duration(*options.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	child := exec.CommandContext(runCtx, command, args...)
	child.Dir = options.Cwd
	child.Env = options.Env
	// killed names the stop of ours that ended the tool (1 SIGTERM, 2 SIGKILL): the exit reads
	// it where the wait status cannot say which signal a terminate carried.
	var killed atomic.Int32
	// Node's timeout kills with SIGTERM; the default Go cancel is a SIGKILL.
	child.Cancel = func() error {
		err := termProcess(child)
		if err == nil {
			killed.Store(1)
		}
		return err
	}
	stdin := ""
	if options.Stdin != nil {
		stdin = *options.Stdin
	}
	child.Stdin = strings.NewReader(stdin)
	limit := int64(maxToolBuffer)
	if options.MaxBuffer != nil {
		limit = *options.MaxBuffer
	}
	collector := &outputCollector{limit: limit}
	child.Stdout = streamSink{collector: collector, into: &collector.stdout}
	child.Stderr = streamSink{collector: collector, into: &collector.stderr}
	if err := child.Start(); err != nil {
		return ToolResult{Kind: ToolMissing, Message: spawnError(command, err).Error()}
	}
	collector.arm(func() error {
		err := child.Process.Kill()
		if err == nil {
			killed.Store(2)
		}
		return err
	})
	_ = child.Wait()
	code, signal := exitResult(child.ProcessState)
	code, signal = applyKilled(killName(killed.Load()), code, signal)
	return ToolResult{
		Kind:   ToolExited,
		Code:   code,
		Signal: signal,
		Stdout: collector.stdout.Bytes(),
		Stderr: collector.stderr.Bytes(),
	}
}

// RunToolSync is RunTool for the callers that read like sync calls (the router starter's
// service commands, ps); a Go run blocks anyway.
func RunToolSync(ctx context.Context, command string, args []string, options ToolOptions) ToolResult {
	return RunTool(ctx, command, args, options)
}

// Succeeded reports whether the tool ran and exited 0.
func Succeeded(result ToolResult) bool {
	return result.Kind == ToolExited && result.Code != nil && *result.Code == 0
}

// versionTimeoutMs bounds a --version that hangs (a tool waiting on a first-run prompt).
const versionTimeoutMs = 10_000

// ToolVersion is the first line `<bin> --version` prints, or why there is none.
func ToolVersion(ctx context.Context, bin string, prefixArgs []string) (string, error) {
	args := append(append([]string{}, prefixArgs...), "--version")
	timeoutMs := int64(versionTimeoutMs)
	run := RunTool(ctx, bin, args, ToolOptions{TimeoutMs: &timeoutMs})
	if run.Kind == ToolMissing {
		return "", errors.New(run.Message)
	}
	if run.Code == nil || *run.Code != 0 {
		return "", fmt.Errorf("Command failed: %s --version", bin)
	}
	text := strings.TrimSpace(string(run.Stdout))
	first := text
	if i := strings.IndexByte(text, '\n'); i >= 0 {
		first = text[:i]
	}
	if first == "" {
		return "", errors.New("printed no version")
	}
	return first, nil
}

// spawnError names a start failure the way Node does ("spawn <command> ENOENT"), so callers and
// reports read the same on both runtimes. A binary the lookup cannot find is Node's ENOENT on
// every platform, while the open of a bad absolute path reports its own errno.
func spawnError(command string, err error) error {
	if code := fsutil.ErrnoCode(err); code != "" {
		return fmt.Errorf("spawn %s %s", command, code)
	}
	if errors.Is(err, exec.ErrNotFound) {
		return fmt.Errorf("spawn %s ENOENT", command)
	}
	return err
}

// killName is the recorded stop's signal (RunTool's atomic spelling of recordKilled).
func killName(killed int32) string {
	switch killed {
	case 1:
		return "SIGTERM"
	case 2:
		return "SIGKILL"
	default:
		return ""
	}
}

// exitResult decodes a waited process's exit: the code when it has one, the signal's name when it was
// signalled.
func exitResult(state *os.ProcessState) (*int, string) {
	code := state.ExitCode()
	if code >= 0 {
		return &code, ""
	}
	return nil, exitSignalName(state)
}

// outputCollector is the shared byte budget of a tool's stdout and stderr: past the limit the tool is
// killed and the chunk that crossed is dropped.
type outputCollector struct {
	mu     sync.Mutex
	stdout bytes.Buffer
	stderr bytes.Buffer
	bytes  int64
	limit  int64
	kill   func() error
}

type streamSink struct {
	collector *outputCollector
	into      *bytes.Buffer
}

func (s streamSink) Write(p []byte) (int, error) {
	return s.collector.write(s.into, p)
}

func (c *outputCollector) write(into *bytes.Buffer, p []byte) (int, error) {
	c.mu.Lock()
	c.bytes += int64(len(p))
	if c.bytes > c.limit {
		kill := c.kill
		c.mu.Unlock()
		if kill != nil {
			_ = kill()
		}
		return 0, nil
	}
	into.Write(p)
	c.mu.Unlock()
	return len(p), nil
}

// arm sets the kill the over-limit path calls; the copy goroutines can start before Start returns, so
// the field is guarded like the rest.
func (c *outputCollector) arm(kill func() error) {
	c.mu.Lock()
	c.kill = kill
	c.mu.Unlock()
}

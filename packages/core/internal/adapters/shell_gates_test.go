package adapters

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The shell gates. The gate runs `sh -c <run>`, and the gate commands are sh syntax (the regenerate commands,
// the POSIX predicates).
func TestHostGateShell(t *testing.T) {
	command, args := hostGateShell("rm -rf out && make build")
	if command != "sh" || !reflect.DeepEqual(args, []string{"-c", "rm -rf out && make build"}) {
		t.Fatalf("hostGateShell = %q %q, want sh -c <run>", command, args)
	}
}

func TestShellGates(t *testing.T) {
	t.Run("runs the command in cwd with sh -c and records exit code and duration", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		logPath := filepath.Join(testkit.TempDir(t, "logs-"), "logs", "gate-1-0.log")
		gates := CreateShellGates(testkit.ReferenceProvider.Name)

		passed := gates.Run(context.Background(), cwd,
			domain.Gate{Run: `pwd && sleep 0.2 && test -n "$0"`, TimeoutMs: 5000},
			map[string]string{}, logPath)
		failed := gates.Run(context.Background(), cwd,
			domain.Gate{Run: "echo boom >&2; exit 3", TimeoutMs: 5000},
			map[string]string{}, logPath)

		if passed.ExitCode == nil || *passed.ExitCode != 0 || passed.TimedOut || passed.Tail != cwd+"\n" {
			t.Fatalf("passed = %+v, want exit 0, no timeout, tail %q", passed, cwd+"\n")
		}
		if passed.DurationMs < 200 || passed.DurationMs >= 10_000 {
			t.Fatalf("passed.DurationMs = %d, want it within 200..10000", passed.DurationMs)
		}
		if failed.Run != "echo boom >&2; exit 3" || failed.ExitCode == nil || *failed.ExitCode != 3 ||
			failed.TimedOut || failed.Tail != "boom\n" {
			t.Fatalf("failed = %+v, want exit 3, no timeout, tail boom\\n", failed)
		}
		if log, err := os.ReadFile(logPath); err != nil || string(log) != "boom\n" {
			t.Fatalf("gate log = %q, %v; want boom\\n", log, err)
		}
	})

	t.Run("keeps the last 60 lines / 8000 chars as tail and the full output in the log file", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		logPath := filepath.Join(cwd, "gate.log")
		gates := CreateShellGates(testkit.ReferenceProvider.Name)
		manyLines := `i=1; while [ $i -le 5000 ]; do echo "line $i"; i=$((i+1)); done`
		longLines := `for i in 1 2 3; do printf '%0200d\n' $i; done; ` + strings.Repeat(`printf '%0300d\n' 7; `, 40)

		lines := gates.Run(context.Background(), cwd, domain.Gate{Run: manyLines, TimeoutMs: 10_000},
			map[string]string{}, logPath)
		fullLog, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read gate log: %v", err)
		}
		chars := gates.Run(context.Background(), cwd, domain.Gate{Run: longLines, TimeoutMs: 10_000},
			map[string]string{}, logPath)

		want := strings.Builder{}
		for i := 4941; i <= 5000; i++ {
			fmt.Fprintf(&want, "line %d\n", i)
		}
		if lines.Tail != want.String() {
			t.Fatalf("many-line tail starts %q, want %q", hostPrefix(lines.Tail, 40), hostPrefix(want.String(), 40))
		}
		if got := len(strings.Split(string(fullLog), "\n")); got != 5001 {
			t.Fatalf("full log has %d newline-split parts, want 5001", got)
		}
		if !strings.HasPrefix(string(fullLog), "line 1\nline 2\n") {
			t.Fatalf("full log starts %q, want line 1 and line 2", hostPrefix(string(fullLog), 20))
		}
		if len(chars.Tail) != 8000 {
			t.Fatalf("long-line tail is %d chars, want 8000", len(chars.Tail))
		}
		second, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read gate log: %v", err)
		}
		if !strings.HasSuffix(string(second), chars.Tail) {
			t.Fatal("the gate log does not end with the kept tail")
		}
		if len(second) != 3*201+40*301 {
			t.Fatalf("gate log is %d bytes, want %d", len(second), 3*201+40*301)
		}
	})

	t.Run("lastLines counts a trailing newline as the end of the last line", func(t *testing.T) {
		cases := []struct {
			text  string
			count int
			want  string
		}{
			{"a\nb\nc\n", 2, "b\nc\n"},
			{"a\nb\nc", 2, "b\nc"},
			{"a\nb\n", 5, "a\nb\n"},
			{"\n\n", 5, "\n\n"},
			{"", 3, ""},
		}
		for _, c := range cases {
			if got := LastLines(c.text, c.count); got != c.want {
				t.Errorf("lastLines(%q, %d) = %q, want %q", c.text, c.count, got, c.want)
			}
		}
	})

	t.Run("lastLines counts UTF-16 code units, keeping surrogate pairs whole", func(t *testing.T) {
		if got := LastLines("😀😀\n😀\n", 1); got != "😀\n" {
			t.Fatalf("lastLines(emoji, 1) = %q, want the last emoji line", got)
		}
		// The tail window cuts with JS slice semantics: a cut between a pair's halves leaves a
		// lone surrogate, which utf16.Decode turns into U+FFFD — what Node writes for it.
		var tail hostGateTail
		tail.push(strings.Repeat("a", hostTailChars-1) + "😀" + strings.Repeat("a", hostTailChars-1))
		if got, want := tail.value(), "�"+strings.Repeat("a", hostTailChars-1); got != want {
			t.Fatalf("tail window = %q…, want the replacement char then %d a's", hostPrefix(got, 3), hostTailChars-1)
		}
	})

	t.Run("the reader holds back the bytes of a rune split across reads", func(t *testing.T) {
		complete, rest := hostCompleteRunes([]byte("ab\xf0\x9f\x98"))
		if string(complete) != "ab" || len(rest) != 3 {
			t.Fatalf("complete = %q, rest = %v, want ab and the 3 lead bytes of an emoji", complete, rest)
		}
		complete, rest = hostCompleteRunes(append(rest, '\x80'))
		if string(complete) != "😀" || len(rest) != 0 {
			t.Fatalf("complete = %q, rest = %v, want the whole emoji and nothing held back", complete, rest)
		}
	})

	t.Run("kills the process group on timeout: timedOut true, exitCode null", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		// The timeout starts at spawn: 1.5 s leaves the shell time to start its background job and
		// write bg.pid first.
		gate := domain.Gate{Run: "sleep 30 & echo $! > bg.pid; echo started; sleep 30", TimeoutMs: 1500}

		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd, gate,
			map[string]string{}, filepath.Join(cwd, "gate.log"))

		// The shell may still report its killed background job before it dies itself.
		if result.ExitCode != nil || !result.TimedOut || !strings.HasPrefix(result.Tail, "started\n") {
			t.Fatalf("result = %+v, want a timeout with a null exit code and tail starting started\\n", result)
		}
		if result.DurationMs < 1500 || result.DurationMs >= 10_000 {
			t.Fatalf("result.DurationMs = %d, want it within 1500..10000", result.DurationMs)
		}
		background := hostReadPid(t, filepath.Join(cwd, "bg.pid"))
		if err := testkit.UntilGone(t, background, testkit.UntilOptions{TimeoutMs: 5000}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("SIGKILLs a group that ignores SIGTERM after the grace period", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		// 1 s for the shell to install its trap before the SIGTERM comes; a TERM before the trap
		// would end it at once. The ignored disposition is inherited by the background sleep, so
		// the whole group survives the TERM and only the SIGKILL ends it.
		gate := domain.Gate{Run: "trap '' TERM; sleep 30 & echo $! > bg.pid; wait; wait", TimeoutMs: 1000}

		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd, gate,
			map[string]string{}, filepath.Join(cwd, "gate.log"))

		if result.ExitCode != nil || !result.TimedOut {
			t.Fatalf("result = %+v, want a timeout with a null exit code", result)
		}
		if result.DurationMs < 3000 || result.DurationMs >= 15_000 {
			t.Fatalf("result.DurationMs = %d, want it within 3000..15000", result.DurationMs)
		}
		background := hostReadPid(t, filepath.Join(cwd, "bg.pid"))
		if err := testkit.UntilGone(t, background, testkit.UntilOptions{TimeoutMs: 5000}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("kills background leftovers when the gate itself exits", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		gate := domain.Gate{Run: "sleep 30 > /dev/null 2>&1 & echo $! > bg.pid; echo done", TimeoutMs: 5000}

		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd, gate,
			map[string]string{}, filepath.Join(cwd, "gate.log"))

		if result.ExitCode == nil || *result.ExitCode != 0 || result.TimedOut || result.Tail != "done\n" {
			t.Fatalf("result = %+v, want exit 0, no timeout, tail done\\n", result)
		}
		background := hostReadPid(t, filepath.Join(cwd, "bg.pid"))
		if err := testkit.UntilGone(t, background, testkit.UntilOptions{TimeoutMs: 5000}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("does not wait for a detached holder of the output pipe beyond a short drain", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		// bash -m puts the background sleep in its own process group: it escapes the group kill and
		// keeps stdout open. Without a terminal (CI) bash -m warns about job control on stderr, so
		// its own stderr is discarded.
		t.Cleanup(func() {
			if data, err := os.ReadFile(filepath.Join(cwd, "holder.pid")); err == nil {
				if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
					// Only while the pid still runs the sleep this gate started: a reused pid is
					// not signalled.
					if testkit.PidMatches(int64(pid), "sleep 30", 0) {
						process.SignalGroup(int64(pid), 9)
					}
				}
			}
		})
		run := `/bin/bash -m -c 'sleep 30 & echo $! > holder.pid' 2>/dev/null; echo out`

		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd,
			domain.Gate{Run: run, TimeoutMs: 10_000}, map[string]string{}, filepath.Join(cwd, "g.log"))

		if result.ExitCode == nil || *result.ExitCode != 0 || result.TimedOut || result.Tail != "out\n" {
			t.Fatalf("result = %+v, want exit 0, no timeout, tail out\\n", result)
		}
		if result.DurationMs >= 10_000 {
			t.Fatalf("result.DurationMs = %d, the holder held the gate open", result.DurationMs)
		}
		holder := hostReadPid(t, filepath.Join(cwd, "holder.pid"))
		// The same ownership check as the cleanup above: the holder's pid is only signalled while
		// it still runs the sleep the gate started.
		if testkit.PidMatches(int64(holder), "sleep 30", 0) {
			process.SignalGroup(int64(holder), 9)
		}
	})

	t.Run("a gate that cannot start fails with the reason in the tail", func(t *testing.T) {
		cwd := filepath.Join(testkit.TempDir(t, "gone-"), "missing")
		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd,
			domain.Gate{Run: "true", TimeoutMs: 1000}, map[string]string{},
			filepath.Join(testkit.TempDir(t, "log-"), "g.log"))
		if result.ExitCode != nil || result.TimedOut || !strings.Contains(result.Tail, "could not start gate") {
			t.Fatalf("result = %+v, want a null exit code, no timeout, the reason in the tail", result)
		}
	})

	t.Run("passes allowlisted env plus passEnv only", func(t *testing.T) {
		cwd := testkit.TempDir(t, "gate-")
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "orchestrator-secret")
		t.Setenv("ZAI_API_KEY", "zai-secret")
		t.Setenv("LANG", "C.UTF-8")

		result := CreateShellGates(testkit.ReferenceProvider.Name).Run(context.Background(), cwd,
			domain.Gate{Run: "env | LC_ALL=C sort", TimeoutMs: 5000},
			map[string]string{"ZAI_ARTIFACTS": "/tmp/artifacts", "PATH": "/custom/bin:/usr/bin:/bin"},
			filepath.Join(cwd, "env.log"))

		allowed := make(map[string]bool)
		for _, name := range append(ENV_ALLOWLIST, "ZAI_ARTIFACTS", "PWD", "SHLVL", "_", "OLDPWD") {
			allowed[name] = true
		}
		for _, line := range strings.Split(result.Tail, "\n") {
			if line == "" {
				continue
			}
			name, _, _ := strings.Cut(line, "=")
			if !allowed[name] {
				t.Fatalf("the gate env leaked %s", name)
			}
		}
		for _, want := range []string{
			"ZAI_ARTIFACTS=/tmp/artifacts\n",
			"PATH=/custom/bin:/usr/bin:/bin\n",
			"LANG=C.UTF-8\n",
		} {
			if !strings.Contains(result.Tail, want) {
				t.Fatalf("tail %q lacks %q", result.Tail, want)
			}
		}
		if strings.Contains(result.Tail, "secret") {
			t.Fatalf("tail leaked a secret: %q", result.Tail)
		}
	})
}

// hostReadPid reads a file holding one pid.
func hostReadPid(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("%s holds %q, not a pid: %v", path, data, err)
	}
	return pid
}

// hostPrefix is the first n bytes of text, for failure messages about long tails.
func hostPrefix(text string, n int) string {
	if len(text) > n {
		return text[:n] + "…"
	}
	return text
}

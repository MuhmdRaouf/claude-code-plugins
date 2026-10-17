package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const wantUsage = "usage: plugin-core <zai|kimi|deepseek|minimax|qwen> <cli|router|passthrough|ensure> [args...]"

var allProviders = []string{"zai", "kimi", "deepseek", "minimax", "qwen"}
var allEntries = []string{"cli", "router", "passthrough", "ensure"}

func TestRunVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if got := stdout.String(); got != "plugin-core dev\n" {
		t.Errorf("stdout = %q, want %q", got, "plugin-core dev\n")
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestNoteStart(t *testing.T) {
	t.Run("appends the binary's pid once per run", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "started.log")
		t.Setenv("PLUGIN_CORE_STARTED_FILE", path)
		var stdout, stderr bytes.Buffer
		if code := run([]string{"--version"}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit = %d, want 0", code)
		}
		want := fmt.Sprintf("plugin-core %d\n", os.Getpid())
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Errorf("started file = %q, %v; want %q", got, err, want)
		}
	})

	t.Run("a path that cannot be written changes nothing", func(t *testing.T) {
		t.Setenv("PLUGIN_CORE_STARTED_FILE", filepath.Join(t.TempDir(), "no-such-dir", "started.log"))
		var stdout, stderr bytes.Buffer
		if code := run([]string{"--version"}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit = %d, want 0", code)
		}
		if stdout.String() != "plugin-core dev\n" {
			t.Errorf("stdout = %q, want %q", stdout.String(), "plugin-core dev\n")
		}
	})
}

func TestRunUsageErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"no args", nil},
		{"provider only", []string{"zai"}},
		{"unknown provider", []string{"glm", "cli"}},
		{"unknown entry", []string{"zai", "shell"}},
		{"empty provider", []string{"", "cli"}},
		{"dashdash is not a provider", []string{"--provider", "cli"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tt.args, &stdout, &stderr)
			if code != 2 {
				t.Fatalf("exit = %d, want 2", code)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
			if got := stderr.String(); got != wantUsage+"\n" {
				t.Errorf("stderr = %q, want %q", got, wantUsage+"\n")
			}
		})
	}
}

func TestRunHookIsSilent(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"hook alone", []string{"--hook"}},
		{"hook with unknown provider", []string{"glm", "cli", "--hook"}},
		{"hook with unknown entry", []string{"zai", "shell", "--hook"}},
		{"hook in place of the entry", []string{"zai", "--hook"}},
		// The cli entry runs its own hook commands (usage --hook, setup --hook); a bare --hook
		// as the command name is a usage error there, so the always-silent pair this case pins
		// is ensure's.
		{"hook with a valid pair", []string{"zai", "ensure", "--hook"}},
		{"hook after entry args", []string{"zai", "router", "watch", "--hook"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tt.args, &stdout, &stderr)
			if code != 0 {
				t.Fatalf("exit = %d, want 0", code)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
			if stderr.Len() != 0 {
				t.Errorf("stderr = %q, want empty", stderr.String())
			}
		})
	}
}

func TestRunCliEntry(t *testing.T) {
	// A sandbox home and state root: the entry wires real adapters, so nothing may reach the
	// developer's own.
	sandbox := func(t *testing.T) string {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("ZAI_STATE_DIR", filepath.Join(home, "state"))
		t.Setenv("PROVIDER_ROUTERS_HOME", filepath.Join(home, "routers"))
		t.Setenv("RADAR_HOME", filepath.Join(home, "radar"))
		t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "claude"))
		os.Unsetenv("CLAUDE_PLUGIN_ROOT")
		os.Unsetenv("ANTHROPIC_BASE_URL")
		return home
	}

	t.Run("help prints the command synopsis", func(t *testing.T) {
		sandbox(t)
		// The cli entry writes to the process's own stdout, which the run signature does not
		// carry; borrow it for the call.
		printed := captureStdout(t, func() int {
			var stdout, stderr bytes.Buffer
			return run([]string{"zai", "cli", "--help"}, &stdout, &stderr)
		})
		if !strings.HasPrefix(printed, "usage: <command> [--json]") {
			t.Errorf("stdout = %q", printed)
		}
	})

	t.Run("the hook path stays silent and exits 0", func(t *testing.T) {
		sandbox(t)
		printed := captureStdout(t, func() int {
			var stdout, stderr bytes.Buffer
			return run([]string{"zai", "cli", "usage", "--hook"}, &stdout, &stderr)
		})
		if printed != "" {
			t.Errorf("stdout = %q, want empty", printed)
		}
	})
}

// captureStdoutCode is captureStdout for calls whose exit code is not 0: it returns both.
func captureStdoutCode(t *testing.T, call func() int) (string, int) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = file
	defer func() {
		os.Stdout = previous
	}()
	code := call()
	file.Close()
	text, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(text), code
}

// captureStdout runs call with the process stdout borrowed into a file, returning what it wrote.
func captureStdout(t *testing.T, call func() int) string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = file
	defer func() {
		os.Stdout = previous
	}()
	code := call()
	file.Close()
	text, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	if code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	return string(text)
}

func TestRunRouterUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"zai", "router", "explode"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
	if want := "usage: zai-router run | start | stop | status\n"; stderr.String() != want {
		t.Errorf("stderr = %q, want %q", stderr.String(), want)
	}
}

func TestRunDispatchesThroughTable(t *testing.T) {
	old := entries
	t.Cleanup(func() { entries = old })

	type call struct {
		entry    string
		provider string
		args     []string
	}
	var got []call
	swapped := map[string]func(provider string, args []string) int{}
	for _, entry := range allEntries {
		swapped[entry] = func(provider string, args []string) int {
			got = append(got, call{entry: entry, provider: provider, args: args})
			return 0
		}
	}
	entries = swapped

	var stdout, stderr bytes.Buffer
	for _, provider := range allProviders {
		for _, entry := range allEntries {
			code := run([]string{provider, entry, "a", "b"}, &stdout, &stderr)
			if code != 0 {
				t.Fatalf("run(%s %s) exit = %d, want 0", provider, entry, code)
			}
		}
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
	if len(got) != len(allProviders)*len(allEntries) {
		t.Fatalf("dispatched %d calls, want %d", len(got), len(allProviders)*len(allEntries))
	}
	seen := map[string]bool{}
	for _, c := range got {
		if c.args == nil || len(c.args) != 2 || c.args[0] != "a" || c.args[1] != "b" {
			t.Errorf("run(%s %s) forwarded args %v, want [a b]", c.provider, c.entry, c.args)
		}
		key := c.provider + " " + c.entry
		if seen[key] {
			t.Errorf("run dispatched (%s %s) more than once", c.provider, c.entry)
		}
		seen[key] = true
	}
	for _, provider := range allProviders {
		for _, entry := range allEntries {
			if !seen[provider+" "+entry] {
				t.Errorf("run never dispatched (%s %s)", provider, entry)
			}
		}
	}
}

func TestFramedDriverOutput(t *testing.T) {
	t.Run("the drive command marks its stderr lines and says its exit code", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("ZAI_STATE_DIR", filepath.Join(home, "state"))
		t.Setenv("PLUGIN_CORE_FRAMED_DRIVERS", "1")
		os.Unsetenv("CLAUDE_PLUGIN_ROOT")

		printed, code := captureStdoutCode(t, func() int {
			var stdout, stderr bytes.Buffer
			return run([]string{"zai", "cli", "drive", "261006-nope"}, &stdout, &stderr)
		})

		if code != 4 {
			t.Fatalf("exit = %d, want 4 (not found)", code)
		}
		if want := "stderr| zai: no zai job matches \"261006-nope\" (/zai:board lists them)\n"; !strings.Contains(printed, want) {
			t.Errorf("stdout = %q, want it to hold %q", printed, want)
		}
		if !strings.HasSuffix(printed, "[exit 4]\n") {
			t.Errorf("stdout = %q, want it to end with the exit line", printed)
		}
	})

	t.Run("a command that is not the driver never frames", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("ZAI_STATE_DIR", filepath.Join(home, "state"))
		t.Setenv("PLUGIN_CORE_FRAMED_DRIVERS", "1")
		os.Unsetenv("CLAUDE_PLUGIN_ROOT")

		printed := captureStdout(t, func() int {
			var stdout, stderr bytes.Buffer
			return run([]string{"zai", "cli", "--help"}, &stdout, &stderr)
		})

		if strings.Contains(printed, "[exit") || strings.Contains(printed, "stderr| ") {
			t.Errorf("stdout = %q, want no framing outside the driver", printed)
		}
	})
}

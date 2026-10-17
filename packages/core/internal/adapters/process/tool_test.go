package process

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestRunTool(t *testing.T) {
	t.Run("collects stdout, stderr and the exit code", func(t *testing.T) {
		t.Setenv(childModeEnv, "three-lines")
		result := RunTool(context.Background(), selfExe(t), nil, ToolOptions{})
		if result.Kind != ToolExited || !Succeeded(result) {
			t.Fatalf("result = %+v, want an exit 0", result)
		}
		if string(result.Stdout) != "one\ntwo\nthree" {
			t.Fatalf("stdout = %q, want one\ntwo\nthree", result.Stdout)
		}
		if len(result.Stderr) != 0 || result.Signal != "" {
			t.Fatalf("stderr = %q, signal = %q, want neither", result.Stderr, result.Signal)
		}
	})

	t.Run("a tool that cannot start is missing, not a throw", func(t *testing.T) {
		result := RunTool(context.Background(), "/nonexistent/tool-binary", nil, ToolOptions{})
		if result.Kind != ToolMissing || !strings.Contains(result.Message, "ENOENT") {
			t.Fatalf("result = %+v, want missing with ENOENT", result)
		}
		if Succeeded(result) {
			t.Fatal("succeeded(missing) = true, want false")
		}
	})

	t.Run("a start failure with no known errno keeps its cause", func(t *testing.T) {
		if got := spawnError("/x", errors.New("boom")); got.Error() != "boom" {
			t.Fatalf("spawnError = %q, want boom", got.Error())
		}
	})

	t.Run("feeds stdin and reports a failing exit", func(t *testing.T) {
		t.Setenv(childModeEnv, "upper-stdin")
		stdin := "hello"
		result := RunTool(context.Background(), selfExe(t), nil, ToolOptions{Stdin: &stdin})
		if result.Kind != ToolExited || result.Code == nil || *result.Code != 3 {
			t.Fatalf("result = %+v, want exit 3", result)
		}
		if string(result.Stdout) != "HELLO\n" {
			t.Fatalf("stdout = %q, want HELLO", result.Stdout)
		}
		if !strings.HasSuffix(string(result.Stderr), "END") || len(result.Stderr) != 5003 {
			t.Fatalf("stderr = %d bytes, want the 5003-byte tail", len(result.Stderr))
		}
	})

	t.Run("times out with SIGTERM", func(t *testing.T) {
		t.Setenv(childModeEnv, "sleep-forever")
		timeoutMs := int64(100)
		result := RunTool(context.Background(), selfExe(t), nil, ToolOptions{TimeoutMs: &timeoutMs})
		if result.Kind != ToolExited || result.Code != nil || result.Signal != "SIGTERM" {
			t.Fatalf("result = %+v, want a SIGTERM exit with no code", result)
		}
	})

	t.Run("kills the tool past its buffer limit", func(t *testing.T) {
		// The tool holds its output back and keeps running, so the kill cannot lose the race against a
		// quick clean exit.
		t.Setenv(childModeEnv, "lines-then-hold")
		limit := int64(4)
		result := RunTool(context.Background(), selfExe(t), nil, ToolOptions{MaxBuffer: &limit})
		if result.Kind != ToolExited || result.Signal != "SIGKILL" {
			t.Fatalf("result = %+v, want a SIGKILL exit", result)
		}
		if len(result.Stdout) != 0 {
			t.Fatalf("stdout = %q, want the over-limit chunk dropped", result.Stdout)
		}
	})
}

func TestRunToolSync(t *testing.T) {
	t.Setenv(childModeEnv, "three-lines")
	result := RunToolSync(context.Background(), selfExe(t), nil, ToolOptions{})
	if !Succeeded(result) {
		t.Fatalf("result = %+v, want an exit 0", result)
	}
}

func TestToolVersion(t *testing.T) {
	t.Run("is the first line of --version", func(t *testing.T) {
		t.Setenv(childModeEnv, "version-line")
		version, err := ToolVersion(context.Background(), selfExe(t), nil)
		if err != nil || version != "v1.2.3" {
			t.Fatalf("toolVersion = (%q, %v), want (v1.2.3, nil)", version, err)
		}
	})

	t.Run("prefix args come before --version", func(t *testing.T) {
		t.Setenv(childModeEnv, "version-line")
		version, err := ToolVersion(context.Background(), selfExe(t), []string{"anything"})
		if err != nil || version != "v1.2.3" {
			t.Fatalf("toolVersion = (%q, %v), want (v1.2.3, nil)", version, err)
		}
	})

	t.Run("a missing tool is an error", func(t *testing.T) {
		if _, err := ToolVersion(context.Background(), "/nonexistent/versioned-tool", nil); err == nil ||
			!strings.Contains(err.Error(), "ENOENT") {
			t.Fatalf("error = %v, want ENOENT", err)
		}
	})

	t.Run("a failing --version is an error", func(t *testing.T) {
		t.Setenv(childModeEnv, "fail-3")
		self := selfExe(t)
		_, err := ToolVersion(context.Background(), self, nil)
		if err == nil || err.Error() != "Command failed: "+self+" --version" {
			t.Fatalf("error = %v, want Command failed", err)
		}
	})

	t.Run("a silent --version is an error", func(t *testing.T) {
		t.Setenv(childModeEnv, "silent-ok")
		if _, err := ToolVersion(context.Background(), selfExe(t), nil); err == nil || err.Error() != "printed no version" {
			t.Fatalf("error = %v, want printed no version", err)
		}
	})
}

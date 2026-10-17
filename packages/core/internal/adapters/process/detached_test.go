package process

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStartDetached(t *testing.T) {
	t.Run("runs detached with stdout and stderr appended to the log", func(t *testing.T) {
		t.Setenv(childModeEnv, "three-lines")
		log := filepath.Join(t.TempDir(), "out.log")
		detached := StartDetached(selfExe(t), nil, DetachedOptions{LogFile: log})
		if detached.Pid <= 1 {
			t.Fatalf("pid = %d, want one above 1", detached.Pid)
		}
		waitFor(t, detached.Exited)
		content, err := os.ReadFile(log)
		if err != nil {
			t.Fatalf("read log: %v", err)
		}
		if string(content) != "one\ntwo\nthree" {
			t.Fatalf("log = %q, want one\ntwo\nthree", content)
		}
	})

	t.Run("discards output when the log cannot be opened", func(t *testing.T) {
		t.Setenv(childModeEnv, "three-lines")
		detached := StartDetached(selfExe(t), nil, DetachedOptions{LogFile: filepath.Join(t.TempDir(), "missing", "out.log")})
		if detached.Pid <= 1 {
			t.Fatalf("pid = %d, want the start to survive the bad log path", detached.Pid)
		}
		waitFor(t, detached.Exited)
	})

	t.Run("swallows a start failure", func(t *testing.T) {
		log := filepath.Join(t.TempDir(), "out.log")
		detached := StartDetached("/nonexistent/detached-binary", nil, DetachedOptions{LogFile: log})
		if detached.Pid != 0 {
			t.Fatalf("pid = %d, want 0 for a start that failed", detached.Pid)
		}
		// A failed start never reports exited.
		if detached.Exited() {
			t.Fatal("exited = true for a failed start, want false")
		}
		detached.Kill()
	})

	t.Run("kill ends a running child", func(t *testing.T) {
		t.Setenv(childModeEnv, "sleep-forever")
		detached := StartDetached(selfExe(t), nil, DetachedOptions{})
		if detached.Pid <= 1 {
			t.Fatalf("pid = %d", detached.Pid)
		}
		waitFor(t, func() bool { return IsAlive(detached.Pid) })
		detached.Kill()
		waitFor(t, detached.Exited)
	})
}

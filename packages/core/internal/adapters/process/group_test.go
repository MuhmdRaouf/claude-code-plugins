package process

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// runChild starts this binary in a child mode at the head of its own process group, waits for the
// child to announce itself ready, and returns it.
func runChild(t *testing.T, mode string) (*exec.Cmd, int64) {
	t.Helper()
	ready := filepath.Join(t.TempDir(), "ready")
	child := exec.Command(selfExe(t))
	child.Env = childEnv(mode, childReadyEnv+"="+ready)
	child.SysProcAttr = groupLeaderAttr()
	if err := child.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	t.Cleanup(func() {
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
	})
	waitFor(t, func() bool {
		_, err := os.Stat(ready)
		return err == nil
	})
	return child, int64(child.Process.Pid)
}

func TestIsAlive(t *testing.T) {
	t.Run("answers for this process and for one that has exited", func(t *testing.T) {
		if !IsAlive(int64(os.Getpid())) {
			t.Fatal("own pid is not alive")
		}
		child := exec.Command(selfExe(t))
		child.Env = childEnv("three-lines")
		if err := child.Run(); err != nil {
			t.Fatalf("child: %v", err)
		}
		if IsAlive(int64(child.Process.Pid)) {
			t.Fatalf("pid %d is alive after its exit", child.Process.Pid)
		}
	})

	t.Run("refuses pids that name no process", func(t *testing.T) {
		if IsAlive(0) || IsAlive(-1) {
			t.Fatal("0 and -1 must not be probed")
		}
	})
}

func TestSignalGroup(t *testing.T) {
	t.Run("refuses unsafe pids", func(t *testing.T) {
		for _, pid := range []int64{0, -1, 1, int64(os.Getpid())} {
			if SignalGroup(pid, syscall.SIGTERM) {
				t.Fatalf("signalGroup(%d) = true, want false", pid)
			}
		}
	})
}

func TestTerminateGroup(t *testing.T) {
	t.Run("refuses unsafe pids", func(t *testing.T) {
		TerminateGroup(context.Background(), 0, 10)
		TerminateGroup(context.Background(), -2, 10)
		TerminateGroup(context.Background(), 1, 10)
		TerminateGroup(context.Background(), int64(os.Getpid()), 10)
	})

	t.Run("escalates to SIGKILL when SIGTERM is ignored", func(t *testing.T) {
		child, pid := runChild(t, "ignore-term")
		waitDone := make(chan error, 1)
		go func() { waitDone <- child.Wait() }()
		TerminateGroup(context.Background(), pid, 200)
		<-waitDone
		if IsAlive(pid) {
			t.Fatalf("group %d survived termination", pid)
		}
	})

	t.Run("a cancelled context stops the wait", func(t *testing.T) {
		child, pid := runChild(t, "ignore-term")
		waitDone := make(chan error, 1)
		go func() { waitDone <- child.Wait() }()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		started := time.Now()
		TerminateGroup(ctx, pid, 60_000)
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("terminateGroup took %v despite a cancelled context", elapsed)
		}
		<-waitDone
		if IsAlive(pid) {
			t.Fatalf("group %d survived the post-grace SIGKILL", pid)
		}
	})
}

func TestExitSignalName(t *testing.T) {
	child := exec.Command(selfExe(t))
	child.Env = childEnv("three-lines")
	if err := child.Run(); err != nil {
		t.Fatalf("child: %v", err)
	}
	if got := exitSignalName(child.ProcessState); got != "" {
		t.Fatalf("exitSignalName of a clean exit = %q, want empty", got)
	}
}

func TestSignalName(t *testing.T) {
	if got := signalName(syscall.SIGTERM); got != "SIGTERM" {
		t.Fatalf("signalName(SIGTERM) = %q, want SIGTERM", got)
	}
	if got := signalName(syscall.SIGKILL); got != "SIGKILL" {
		t.Fatalf("signalName(SIGKILL) = %q, want SIGKILL", got)
	}
	if got := signalName(syscall.Signal(99)); got != "SIG99" {
		t.Fatalf("signalName(99) = %q, want SIG99", got)
	}
}

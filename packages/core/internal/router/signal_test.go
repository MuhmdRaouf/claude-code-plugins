package router

import (
	"os"
	"syscall"
	"testing"
)

// terminateSelf sends SIGTERM to the test binary, which the emergency's handler consumes.
func terminateSelf(t *testing.T) {
	t.Helper()
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
}

// killPid ends a worker child the front owns, the way a hung worker is ended: SIGKILL.
func killPid(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
}

// The front's worker fork: a kill names a signal, and an exit reports the signal that ended
// the worker.

package router

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// killProcess sends the signal to a worker process; a process already gone is not an error.
func killProcess(process *os.Process, signal string) {
	var unix syscall.Signal
	switch signal {
	case "SIGKILL":
		unix = syscall.SIGKILL
	case "SIGTERM":
		unix = syscall.SIGTERM
	default:
		_ = process.Kill()
		return
	}
	if err := process.Signal(unix); err != nil {
		// Already gone.
		_ = process.Kill()
	}
}

// signalPid sends the signal to one pid and reports whether a process is there to receive it:
// os.FindProcess always hands a process back, and a signal to one that is gone is a no-op.
func signalPid(pid int64, signal string) bool {
	target, _ := os.FindProcess(int(pid))
	killProcess(target, signal)
	return process.IsAlive(pid)
}

// exitOf is a worker's exit as the front reports it: the signal that ended it, or its code.
func exitOf(err error) (code int, signal string) {
	if err == nil {
		return 0, ""
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		return 1, ""
	}
	if waitStatus, ok := exitErr.Sys().(syscall.WaitStatus); ok && waitStatus.Signaled() {
		return -1, signalName(waitStatus.Signal())
	}
	return exitErr.ExitCode(), ""
}

// signalName is the signal's name as the supervision and exit lines write it.
func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	default:
		return fmt.Sprintf("signal %d", int(signal))
	}
}

// termSignalName is the delivered termination signal's name as the exit line writes it.
func termSignalName(signal os.Signal) string {
	if unix, ok := signal.(syscall.Signal); ok {
		return signalName(unix)
	}
	return fmt.Sprintf("%v", signal)
}

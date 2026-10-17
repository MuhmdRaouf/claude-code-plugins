// The process runtime's system layer: group creation, signalling, reaping and exit decoding.

package process

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// groupLeaderAttr puts the child at the head of its own process group, so a stop reaches every tool it
// started.
func groupLeaderAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// detachedAttr starts a child in its own session and group, outliving its caller: nothing that kills
// the caller's process tree reaches it.
func detachedAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func killOne(pid int64, signal syscall.Signal) error {
	return syscall.Kill(int(pid), signal)
}

func killGroup(pid int64, signal syscall.Signal) error {
	return syscall.Kill(-int(pid), signal)
}

// exitedPid reports whether the process has exited, reaping it when it has: the parent-side half of
// what Node's exitCode tracking did. ECHILD means someone already waited for it.
func exitedPid(pid int64) bool {
	var status syscall.WaitStatus
	reaped, err := syscall.Wait4(int(pid), &status, syscall.WNOHANG, nil)
	if err != nil {
		return true
	}
	return reaped == int(pid)
}

// termProcess is the timeout stop: SIGTERM, like Node's own timeout kill.
func termProcess(child *exec.Cmd) error {
	return child.Process.Signal(syscall.SIGTERM)
}

// stopGroup delivers a stop to the group pid leads. Unix reads how the leader ended off the wait
// status, so ended stays empty: the exit never needs the sender's word for it.
func stopGroup(pid int64, signal syscall.Signal) (delivered bool, ended string) {
	err := killGroup(pid, signal)
	return err == nil || lastErrnoIsEPerm(err), ""
}

// applyKilled folds the signal our own stop sent into a wait result. Unix keeps the wait status's
// truth: a leader that trapped SIGTERM and exited cleanly reports that code, not the signal.
func applyKilled(recorded string, code *int, signal string) (*int, string) {
	return code, signal
}

// exitSignalName names the signal that ended the process; "" when it was not a signal.
func exitSignalName(state *os.ProcessState) string {
	waitStatus, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !waitStatus.Signaled() {
		return ""
	}
	return signalName(waitStatus.Signal())
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP:  "SIGHUP",
	syscall.SIGINT:  "SIGINT",
	syscall.SIGQUIT: "SIGQUIT",
	syscall.SIGILL:  "SIGILL",
	syscall.SIGTRAP: "SIGTRAP",
	syscall.SIGABRT: "SIGABRT",
	syscall.SIGBUS:  "SIGBUS",
	syscall.SIGFPE:  "SIGFPE",
	syscall.SIGKILL: "SIGKILL",
	syscall.SIGUSR1: "SIGUSR1",
	syscall.SIGSEGV: "SIGSEGV",
	syscall.SIGUSR2: "SIGUSR2",
	syscall.SIGPIPE: "SIGPIPE",
	syscall.SIGALRM: "SIGALRM",
	syscall.SIGTERM: "SIGTERM",
	syscall.SIGCHLD: "SIGCHLD",
	syscall.SIGCONT: "SIGCONT",
	syscall.SIGSTOP: "SIGSTOP",
	syscall.SIGTSTP: "SIGTSTP",
	syscall.SIGTTIN: "SIGTTIN",
	syscall.SIGTTOU: "SIGTTOU",
}

// signalName is the signal's Node spelling; "SIG<n>" for one Node does not name.
func signalName(signal syscall.Signal) string {
	if name, ok := signalNames[signal]; ok {
		return name
	}
	return fmt.Sprintf("SIG%d", int(signal))
}

package process

import (
	"os"
	"os/exec"
	"syscall"
)

// Detached is a process started to outlive its caller, as the caller sees it.
type Detached struct {
	// Pid is 0 when the start failed.
	Pid int64
	// started: a failed start is not a process and never reports exited.
	started bool
}

// DetachedOptions are the options of StartDetached.
type DetachedOptions struct {
	// Env is the child's whole environment; nil inherits the caller's.
	Env []string
	// LogFile is where stdout and stderr are appended (0600); without it, or when it cannot be opened,
	// they are discarded.
	LogFile string
}

// StartDetached runs `command args` in its own session and group, no console window, not waited for: a
// start failure (a missing binary) is swallowed, and the caller learns about it only from what the
// process was meant to do.
func StartDetached(command string, args []string, options DetachedOptions) Detached {
	var out *os.File
	if options.LogFile != "" {
		if file, err := os.OpenFile(options.LogFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			out = file
		}
	}
	child := exec.Command(command, args...)
	child.SysProcAttr = detachedAttr()
	child.Env = options.Env
	// A nil Stdin/Stdout/Stderr gives the child /dev/null.
	if out != nil {
		child.Stdout = out
		child.Stderr = out
	}
	if err := child.Start(); err != nil {
		if out != nil {
			out.Close()
		}
		return Detached{}
	}
	// The child holds its own copy of the log descriptor.
	if out != nil {
		out.Close()
	}
	pid := int64(child.Process.Pid)
	child.Process.Release()
	return Detached{Pid: pid, started: true}
}

// Exited reports whether the process has exited.
func (d *Detached) Exited() bool {
	return d.started && exitedPid(d.Pid)
}

// Kill SIGKILLs the process; already gone is fine.
func (d *Detached) Kill() {
	if d.started {
		_ = killOne(d.Pid, syscall.SIGKILL)
	}
}

package process

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// The orphan launcher: the short-lived process SpawnOrphan runs so the real child's parent is
// never the caller. It is this binary itself in its `--orphan-launch` mode: it starts the command
// detached, says its pid and exits, so the command is reparented to PID 1 at once and no
// tree-kill of the caller (Claude Code cleaning up a background shell) can reach it.

// OrphanLaunch is the `--orphan-launch <log> <command> [args...]` entry: start command with stdout
// and stderr appended to log, print its pid, exit 0. Why not, on stderr, exit 1.
func OrphanLaunch(argv []string) int {
	if len(argv) < 2 {
		fmt.Fprintln(os.Stderr, "usage: --orphan-launch <log> <command> [args...]")
		return 2
	}
	log, command, args := argv[0], argv[1], argv[2:]
	if err := os.MkdirAll(filepath.Dir(log), 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "cannot open %s: %s\n", log, err.Error())
		return 1
	}
	fd, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot open %s: %s\n", log, err.Error())
		return 1
	}
	defer fd.Close()
	child := exec.Command(command, args...)
	child.SysProcAttr = detachedAttr()
	// stdin from /dev/null (exec's default), stdout and stderr on the log.
	child.Stdout = fd
	child.Stderr = fd
	if startErr := child.Start(); startErr != nil {
		fmt.Fprintf(os.Stderr, "cannot start %s: %s\n", command, spawnError(command, startErr))
		return 1
	}
	pid := child.Process.Pid // Release retires the handle and its pid, so read it first.
	fmt.Fprintln(os.Stdout, pid)
	child.Process.Release()
	// The exit is the point: the child loses its parent here and init buries it when it ends.
	return 0
}

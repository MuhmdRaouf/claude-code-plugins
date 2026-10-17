// The orphan start: a driver that must survive anything that kills the caller's process tree (Claude
// Code cleaning up a background shell). The orphaning is the launcher dance (see launch.go): a
// short-lived launcher spawns the real process detached (own session and process group, the process
// as its leader), says its pid and exits, so the process is reparented to PID 1 at once.
package process

import (
	"errors"
	"os"
	"os/exec"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// LaunchReply is what the start of an orphan reports.
type LaunchReply struct {
	// Err is set when the command could not run at all (a missing binary, a bad cwd).
	Err error
	// Status is the start's exit status; nil when there is none (killed by a signal or a timeout).
	Status *int
	Stdout string
	Stderr string
}

// LaunchedPid is the orphan's pid from the start's reply, or why there is none.
func LaunchedPid(command string, reply LaunchReply) (int64, error) {
	if reply.Err != nil {
		return 0, errors.New("cannot start " + command + ": " + reply.Err.Error())
	}
	stderr := strings.TrimSpace(reply.Stderr)
	if reply.Status == nil || *reply.Status != 0 {
		if stderr == "" {
			return 0, errors.New("cannot start " + command)
		}
		return 0, errors.New(stderr)
	}
	pid, ok := domain.ParsePid(reply.Stdout)
	if !ok {
		return 0, errors.New("cannot start " + command + ": no pid")
	}
	return pid, nil
}

// SpawnOrphan starts `command args` as an orphaned process-group leader with stdout and stderr appended
// to log, and returns its pid. The orphaning is the launcher dance above (see OrphanLaunch): the
// child's parent is the short-lived launcher, never the caller, and the launcher's pid reply is
// the answer here. The log's directory is created; a log that cannot be opened is an error the
// launcher reports.
func SpawnOrphan(command string, args []string, log string) (int64, error) {
	self, err := os.Executable()
	if err != nil {
		return 0, err
	}
	launcher := exec.Command(self, append([]string{"--orphan-launch", log, command}, args...)...)
	// The launcher lives for milliseconds in the caller's own group; its stdout is the pid, its
	// stderr the why-not.
	var stdout, stderr strings.Builder
	launcher.Stdout = &stdout
	launcher.Stderr = &stderr
	runErr := launcher.Run()
	reply := LaunchReply{Stdout: stdout.String(), Stderr: stderr.String()}
	if runErr == nil {
		status := 0
		reply.Status = &status
	} else {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			status := exitErr.ExitCode()
			reply.Status = &status
		} else {
			reply.Err = runErr
		}
	}
	return LaunchedPid(command, reply)
}

// Process and process-group signalling shared by the worker and ProcessControl.
package process

import (
	"context"
	"os"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
)

// pollInterval is how often a terminating group is probed for its last member.
const pollInterval = 25 * time.Millisecond

// killSettleMs: after SIGKILL only the kernel is left to act; this bounds the wait for a process stuck
// in an uninterruptible call.
const killSettleMs = 2_000

// IsAlive reports whether pid names a live process. Signal 0 probes existence; EPERM means it exists
// but belongs to someone else.
func IsAlive(pid int64) bool {
	if !namesOneProcess(pid) {
		return false
	}
	err := killOne(pid, 0)
	if err == nil {
		return true
	}
	// A process of ours that has exited but not been waited for still answers the probe, so the
	// caller has to keep reaping its children (exec.Cmd.Wait, the orphan's reaper).
	return lastErrnoIsEPerm(err)
}

// TerminateGroup SIGTERMs the group led by pid (started as its own group), resolving once no
// member is left. It returns the signal that ended the group's leader, or "" when no signal of
// ours did: the exit reporting reads it where a wait status cannot say, the way Node's close
// event reports the signal it killed with.
func TerminateGroup(ctx context.Context, pid int64, graceMs int64) string {
	if !isForeignGroupLeader(pid) {
		return ""
	}
	last := ""
	if delivered, ended := stopGroup(pid, syscall.SIGTERM); delivered {
		last = ended
	}
	if groupGoneWithin(ctx, pid, graceMs) {
		return last
	}
	if delivered, ended := stopGroup(pid, syscall.SIGKILL); delivered {
		last = ended
	}
	groupGoneWithin(ctx, pid, killSettleMs)
	return last
}

// groupGoneWithin polls the group until no member answers or the deadline passes.
func groupGoneWithin(ctx context.Context, pid int64, ms int64) bool {
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	for SignalGroup(pid, 0) {
		if time.Now().After(deadline) {
			return false
		}
		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
	return true
}

// SignalGroup signals the group pid leads (a no-op for 0, 1, negatives and our own pid); true when the
// group still had a member to signal.
func SignalGroup(pid int64, signal syscall.Signal) bool {
	if !isForeignGroupLeader(pid) {
		return false
	}
	err := killGroup(pid, signal)
	return err == nil || lastErrnoIsEPerm(err)
}

// isForeignGroupLeader: -1 would signal every process we own, and our own group would take this process
// down with it.
func isForeignGroupLeader(pid int64) bool {
	return namesOneProcess(pid) && pid != 1 && pid != int64(os.Getpid())
}

// namesOneProcess: kill() treats 0 and negatives as process groups (-1: every process we may signal),
// so only positive integers are safe to pass on.
func namesOneProcess(pid int64) bool {
	return pid > 0
}

// lastErrnoIsEPerm is the "exists but belongs to someone else" answer of a failed signal.
func lastErrnoIsEPerm(err error) bool {
	return err != nil && fsutil.ErrnoCode(err) == "EPERM"
}

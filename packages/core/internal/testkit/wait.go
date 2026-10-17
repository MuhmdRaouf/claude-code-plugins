package testkit

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Waiting in tests: Sleep for a fixed pause and Until for a condition. Inside a test prefer Until
// over a blind sleep.

// Sleep waits for ms to pass, returning the context's error when it is cancelled first.
func Sleep(ctx context.Context, ms int64) error {
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// UntilOptions shape a poll; the zero value asks for a condition that already holds.
type UntilOptions struct {
	// Give up after this long (default 10 s).
	TimeoutMs int64
	// Poll this often (default 10 ms).
	IntervalMs int64
	// What the error says when time runs out.
	Message string
}

// Until polls probe until it returns true; it returns an error after TimeoutMs with Message.
// A zero TimeoutMs or IntervalMs means the default.
func Until(t testing.TB, probe func() bool, opts UntilOptions) error {
	t.Helper()
	if opts.TimeoutMs == 0 {
		opts.TimeoutMs = 10_000
	}
	if opts.IntervalMs == 0 {
		opts.IntervalMs = 10
	}
	if opts.Message == "" {
		opts.Message = "condition not met"
	}
	deadline := time.Now().Add(time.Duration(opts.TimeoutMs) * time.Millisecond)
	for {
		if probe() {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("%s within %d ms", opts.Message, opts.TimeoutMs)
		}
		time.Sleep(time.Duration(opts.IntervalMs) * time.Millisecond)
	}
}

// UntilGone returns once process pid is gone; it fails after TimeoutMs like Until does.
func UntilGone(t testing.TB, pid int, opts UntilOptions) error {
	t.Helper()
	if opts.Message == "" {
		opts.Message = fmt.Sprintf("process %d still alive", pid)
	}
	return Until(t, func() bool { return !IsPidAlive(pid) }, opts)
}

// IsPidAlive reports whether pid names a live process (EPERM: alive, someone else's).
func IsPidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

// signalPid SIGTERMs pid, as Node's process.kill(pid, "SIGTERM") does.
func signalPid(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// PidMatches reports whether pid is still the process a test remembers starting: its command line
// names argsNeedle (an empty needle skips that check) and its parent is ppid (0 skips that check).
// The pid counter wraps, so a pid from a pidfile or a ps scan can name a different process by the
// time a test signals it; a pid that fails a check is not signalled. A gone pid matches nothing,
// and a ps that keeps failing matches nothing rather than guessing.
func PidMatches(pid int64, argsNeedle string, ppid int) bool {
	for attempt := 0; ; attempt++ {
		ps, err := exec.Command("ps", "-axo", "pid=,ppid=,args=").Output()
		if err == nil {
			for _, line := range strings.Split(string(ps), "\n") {
				fields := strings.Fields(strings.TrimSpace(line))
				if len(fields) < 3 {
					continue
				}
				rowPid, errPid := strconv.ParseInt(fields[0], 10, 64)
				rowPpid, errPpid := strconv.Atoi(fields[1])
				if errPid != nil || errPpid != nil || rowPid != pid {
					continue
				}
				if ppid != 0 && rowPpid != ppid {
					return false
				}
				return argsNeedle == "" || strings.Contains(strings.Join(fields[2:], " "), argsNeedle)
			}
			return false
		}
		if attempt >= 2 {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// PidInGroup reports whether pid still sits in process group pgid: the proof that a group a test
// is about to signal still holds a member the test itself put there. While such a member lives the
// group id cannot be handed to another process, so the signal reaches only the test's own group.
func PidInGroup(pid int64, pgid int64) bool {
	ps, err := exec.Command("ps", "-axo", "pid=,pgid=").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(ps), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 {
			continue
		}
		rowPid, errPid := strconv.ParseInt(fields[0], 10, 64)
		rowPgid, errPgid := strconv.ParseInt(fields[1], 10, 64)
		if errPid != nil || errPgid != nil {
			continue
		}
		if rowPid == pid {
			return rowPgid == pgid
		}
	}
	return false
}

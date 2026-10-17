package cli_test

import (
	"context"
	"errors"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
)

func TestUntilInterrupted(t *testing.T) {
	t.Run("passes the value and the error through while no signal arrives", func(t *testing.T) {
		got, err := cli.UntilInterrupted(func(ctx context.Context) (string, error) {
			if ctx.Err() != nil {
				return "", errors.New("cancelled before the work started")
			}
			return "done", nil
		})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != "done" {
			t.Fatalf("got = %q, want %q", got, "done")
		}
	})

	t.Run("carries an error from the work", func(t *testing.T) {
		_, err := cli.UntilInterrupted(func(context.Context) (string, error) {
			return "", errors.New("disk on fire")
		})
		if err == nil || err.Error() != "disk on fire" {
			t.Fatalf("err = %v, want disk on fire", err)
		}
	})
}

// The signal the follower catches: sent to this own test process, whose handler UntilInterrupted
// installed, so the run below ends without the test binary dying.
func TestUntilInterruptedCancelsOnSIGINT(t *testing.T) {
	go func() {
		time.Sleep(50 * time.Millisecond)
		if err := syscall.Kill(syscall.Getpid(), syscall.SIGINT); err != nil {
			t.Errorf("send SIGINT: %v", err)
		}
	}()
	deadline, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := cli.UntilInterrupted(func(signal context.Context) (string, error) {
		select {
		case <-signal.Done():
			return "interrupted", nil
		case <-deadline.Done():
			return "", deadline.Err()
		}
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "interrupted" {
		t.Fatalf("got = %q, want interrupted", got)
	}
}

package cli_test

// The runCli cases that interrupt a follower with a real signal, sent to this own test process
// whose handler UntilInterrupted installed.

import (
	"context"
	"os"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

func TestRunCliInterruptedFollower(t *testing.T) {
	t.Run("an interrupted follower only detaches: one line on how to wait or stop, exit 130, the job untouched", func(t *testing.T) {
		for _, signal := range []string{"SIGINT", "SIGTERM"} {
			world := fakedeps.FakeDeps(t)
			job := world.Store.Put(testkit.AJob(func(j *domain.Job) {
				j.ID = "j1"
				j.State = domain.JobStateRunning
				j.Attempts = []domain.Attempt{testkit.AnAttempt()}
			}))
			world.Store.HoldLock("j1", int64(os.Getpid()))
			cliAfterSleeps(&world, 2, func() {
				sendTestSignal(t, signal)
			})

			if code := cliRun(t, world, "wait", "j1"); code != cli.ExitInterrupted {
				t.Fatalf("%s: exit = %d, want 130", signal, code)
			}
			if len(world.Out.Lines) != 0 {
				t.Fatalf("%s: lines = %q", signal, world.Out.Lines)
			}
			want := []string{
				"zai job j1 keeps running detached: /zai:board shows it and can stop it, /zai:review j1 once it awaits review.",
			}
			if !reflect.DeepEqual(world.Out.Errors, want) {
				t.Fatalf("%s: errors = %q", signal, world.Out.Errors)
			}
			stored, err := world.Store.Get(context.Background(), "j1")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(stored, job) {
				t.Fatalf("%s: the job was touched", signal)
			}
			if terminated := world.Process.Terminated(); len(terminated) != 0 {
				t.Fatalf("%s: terminated = %v", signal, terminated)
			}
		}
	})

	t.Run("an interrupted multi-wait detaches every job: one line of advice, exit 130, no totals", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		for _, id := range []string{"j1", "j2"} {
			world.Store.Put(testkit.AJob(func(j *domain.Job) {
				j.ID = id
				j.State = domain.JobStateRunning
				j.Attempts = []domain.Attempt{testkit.AnAttempt()}
			}))
			world.Store.HoldLock(id, int64(os.Getpid()))
		}
		cliAfterSleeps(&world, 3, func() {
			sendTestSignal(t, "SIGINT")
		})

		if code := cliRun(t, world, "wait", "j1", "j2"); code != cli.ExitInterrupted {
			t.Fatalf("exit = %d, want 130", code)
		}
		if len(world.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		want := []string{
			"zai job j1 keeps running detached: /zai:board shows it and can stop it, /zai:review j1 once it awaits review.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("board --watch redraws the board every 2 s on a TTY until Ctrl-C; off a TTY it prints once", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		// The watch redraws on the test's clock: two released ticks are two redraws after the
		// first print, and the SIGINT ends the watch through the same clock, so the render
		// count cannot race the signal's asynchronous delivery.
		watch := &cliWatchClock{ManualClock: world.Clock, tick: make(chan struct{})}
		world.Deps.Clock = watch
		exited := make(chan cli.ExitCode, 1)
		go func() {
			exited <- withTTY(t, true, func() cli.ExitCode { return cliRun(t, world, "board", "--watch") })
		}()
		for ticks := 0; ticks < 2; ticks++ {
			select {
			case watch.tick <- struct{}{}:
			case code := <-exited:
				t.Fatalf("the watch ended after %d ticks: exit %d, errors %q", ticks, code, world.Out.Errors)
			}
		}
		sendTestSignal(t, "SIGINT")
		var code cli.ExitCode
		select {
		case code = <-exited:
		case <-time.After(10 * time.Second):
			t.Fatal("the watch did not end after SIGINT")
		}

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.Out.Lines) != 3 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		for _, board := range world.Out.Lines {
			if !regexp.MustCompile(`^KIND +ID`).MatchString(board) {
				t.Fatalf("board = %q", board)
			}
		}

		plain := fakedeps.FakeDeps(t)
		cliReviewable(t, plain)
		if code := withTTY(t, false, func() cli.ExitCode { return cliRun(t, plain, "board", "--watch") }); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(plain.Out.Lines) != 1 {
			t.Fatalf("lines = %q", plain.Out.Lines)
		}
	})
}

// cliWatchClock is the board watch's clock under the test's control: Sleep returns only for a
// released tick (one redraw, 2 s later on the manual clock) or for the cancelled interrupt
// context, so the renders are exactly the ticks the test drove.
type cliWatchClock struct {
	*fakes.ManualClock
	tick chan struct{}
}

func (c *cliWatchClock) Sleep(ctx context.Context, ms int64) error {
	select {
	case <-c.tick:
		c.Advance(ms)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sendTestSignal names one of the signals the tests send to this own process.
func sendTestSignal(t *testing.T, name string) {
	t.Helper()
	var signal syscall.Signal
	switch name {
	case "SIGINT":
		signal = syscall.SIGINT
	case "SIGTERM":
		signal = syscall.SIGTERM
	default:
		t.Fatalf("unknown signal %s", name)
	}
	if err := syscall.Kill(syscall.Getpid(), signal); err != nil {
		t.Errorf("send %s: %v", name, err)
	}
}

// TestCliSignalHandlersRemoved asserts the follower's handlers are gone once it ends: the next
// signal to this process would kill it, so this only checks the bookkeeping the package exposes
// (UntilInterrupted already stopped its own).
func TestCliSignalHandlersRemoved(t *testing.T) {
	world := fakedeps.FakeDeps(t)
	world.Store.Put(testkit.AJob(func(j *domain.Job) {
		j.ID = "j1"
		j.State = domain.JobStateRunning
		j.Attempts = []domain.Attempt{testkit.AnAttempt()}
	}))
	world.Store.HoldLock("j1", int64(os.Getpid()))
	cliAfterSleeps(&world, 2, func() { sendTestSignal(t, "SIGINT") })

	if code := cliRun(t, world, "wait", "j1"); code != cli.ExitInterrupted {
		t.Fatalf("exit = %d, want 130", code)
	}
	if strings.Contains(strings.Join(world.Out.Errors, "\n"), "unexpected") {
		t.Fatalf("errors = %q", world.Out.Errors)
	}
}

// TestCommandsSecondProviderInterrupted is the runCli-as-a-second-provider case that needs a
// real signal; its two siblings live in commands_test.go.
func TestCommandsSecondProviderInterrupted(t *testing.T) {
	t.Run("an interrupted wait detaches with the provider's own wait and stop", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, nil, fakedeps.FakeWorld{Provider: &testkit.AcmeProvider})
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		world.Store.HoldLock("j1", int64(os.Getpid()))
		sleeps := 0
		clock := world.Clock
		world.Deps.Clock = &cliHookClock{Clock: clock, before: func() {
			sleeps++
			if sleeps == 2 {
				sendTestSignal(t, "SIGINT")
			}
		}}

		if code := cliRun(t, world, "wait", "j1"); code != cli.ExitInterrupted {
			t.Fatalf("exit = %d, want 130", code)
		}
		want := []string{
			"acme job j1 keeps running detached: /acme:board shows it and can stop it, /acme:review j1 once it awaits review.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q, want %q", world.Out.Errors, want)
		}
	})
}

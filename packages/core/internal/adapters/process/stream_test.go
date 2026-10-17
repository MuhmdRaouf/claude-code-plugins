package process

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The suite re-executes this test binary as its children, with childModeEnv naming the role the
// child plays (runChildMode). No other runtime is ever started.
const childModeEnv = "PROCESS_TEST_CHILD"

// childDeadline bounds every child the tests start, so one that escapes its test's cleanup cannot linger.
const childDeadline = 60 * time.Second

// childReadyEnv names the file a signal-trapping child touches once its traps are set.
const childReadyEnv = "PROCESS_TEST_READY"

func TestMain(m *testing.M) {
	// The orphan launcher SpawnOrphan re-runs this test binary as (see OrphanLaunch).
	if len(os.Args) > 1 && os.Args[1] == "--orphan-launch" {
		os.Exit(OrphanLaunch(os.Args[2:]))
	}
	if mode := os.Getenv(childModeEnv); mode != "" {
		runChildMode(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// announceReady marks the readiness file: the signal traps are installed, so a test that SIGTERMs from
// now on observes the handler and not the default death.
func announceReady() {
	if path := os.Getenv(childReadyEnv); path != "" {
		if file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			file.Close()
		}
	}
}

// holdOpen keeps the child alive until its deadline.
func holdOpen() {
	time.Sleep(childDeadline)
}

func runChildMode(mode string) {
	switch mode {
	case "chunks":
		// "é" is split across two writes: the line reader must not tear it.
		os.Stdout.WriteString("one\ntw")
		os.Stdout.Write([]byte{0x6f, 0xc3})
		time.Sleep(20 * time.Millisecond)
		os.Stdout.Write([]byte{0xa9, 0x0a, 0x6c, 0x61, 0x73, 0x74})
	case "upper-stdin":
		input, _ := readAllStdin()
		os.Stderr.WriteString(strings.Repeat("x", 5000) + "END")
		os.Stdout.WriteString(strings.ToUpper(input) + "\n")
		os.Exit(3)
	case "three-lines":
		os.Stdout.WriteString("one\ntwo\nthree")
	case "lines-then-hold":
		os.Stdout.WriteString("one\ntwo\nthree")
		holdOpen()
	case "flood":
		// A kept line, then one unterminated line past any small budget, then silence.
		os.Stdout.WriteString("kept\n")
		os.Stdout.WriteString(strings.Repeat("x", 17))
		holdOpen()
	case "up-then-sleep":
		os.Stdout.WriteString("up\n")
		holdOpen()
	case "sleep-forever":
		holdOpen()
	case "sleep-for":
		// The portable `sleep`: the span comes from PROCESS_TEST_SLEEP_MS.
		ms, err := strconv.Atoi(os.Getenv("PROCESS_TEST_SLEEP_MS"))
		if err != nil || ms <= 0 {
			os.Exit(2)
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
	case "ignore-term":
		signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM)
		announceReady()
		holdOpen()
	case "grandchild-leader", "leaky-grandchild":
		// A leader that forks a sleeping grandchild into its (inherited) group, prints its pid, then exits.
		exe, err := os.Executable()
		if err != nil {
			os.Exit(1)
		}
		grandchild := exec.Command(exe)
		grandchild.Env = []string{childModeEnv + "=sleep-forever"}
		if mode == "leaky-grandchild" {
			// The leaky variant keeps the leader's stdout open after it exits.
			grandchild.Stdout = os.Stdout
			grandchild.Stderr = os.Stderr
		}
		if err := grandchild.Start(); err != nil {
			os.Exit(1)
		}
		os.Stdout.WriteString(strconv.Itoa(grandchild.Process.Pid))
		os.Exit(0)
	case "stderr-benign":
		os.Stderr.WriteString("Still starting after 10s — phase: discover\n")
		os.Stderr.WriteString("FATAL: boom\n")
		os.Exit(3)
	case "sigterm-log":
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM)
		announceReady()
		go func() {
			<-sig
			if file, err := os.OpenFile(os.Getenv("PROCESS_TEST_FILE"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				file.WriteString("term\n")
				file.Close()
			}
			// Record the arrival, then die of the SIGTERM itself so the exit keeps its real cause.
			signal.Reset(syscall.SIGTERM)
			_ = killOne(int64(os.Getpid()), syscall.SIGTERM)
		}()
		holdOpen()
	case "version-line":
		os.Stdout.WriteString("v1.2.3\nsecond line\n")
	case "silent-ok":
	case "fail-3":
		os.Exit(3)
	}
}

func readAllStdin() (string, error) {
	data := make([]byte, 0, 512)
	buf := make([]byte, 512)
	for {
		n, err := os.Stdin.Read(buf)
		data = append(data, buf[:n]...)
		if err != nil {
			return string(data), err
		}
	}
}

// childEnv is the whole environment a child mode needs. GOCOVERDIR comes along when the test run
// itself is covered, so the re-executed child stays silent on stderr instead of warning about it.
func childEnv(mode string, extra ...string) []string {
	env := append([]string{childModeEnv + "=" + mode}, extra...)
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		env = append(env, "GOCOVERDIR="+dir)
	}
	return env
}

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

// streamChild builds the run's child: this binary in a child mode, in a scratch cwd, stdout
// logged under it, stdin closed at once, a generous timeout.
func streamChild(t *testing.T, mode string, extraEnv ...string) (StreamCommand, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "logs", "out.log")
	stdin := ""
	timeoutMs := int64(30_000)
	graceMs := int64(1_000)
	return StreamCommand{
		Command:   selfExe(t),
		Args:      nil,
		Cwd:       dir,
		Env:       childEnv(mode, extraEnv...),
		Stdin:     &stdin,
		LogPath:   &logPath,
		TimeoutMs: &timeoutMs,
		GraceMs:   &graceMs,
	}, logPath
}

func collectLines(t *testing.T, lines <-chan string) []string {
	t.Helper()
	var all []string
	for line := range lines {
		all = append(all, line)
	}
	return all
}

func untilGone(t *testing.T, pid int64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for IsAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d still alive", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func killAndWait(t *testing.T, pid int64) {
	t.Helper()
	_ = killOne(pid, syscall.SIGKILL)
	untilGone(t, pid)
}

// grandchildPid reads the pid a grandchild-leader child printed as its only stdout line.
func grandchildPid(t *testing.T, lines []string) int64 {
	t.Helper()
	if len(lines) == 0 {
		t.Fatal("no grandchild pid on stdout")
	}
	pid, err := strconv.ParseInt(strings.TrimSpace(lines[0]), 10, 64)
	if err != nil || pid <= 1 {
		t.Fatalf("grandchild pid = %q, want an integer above 1", lines[0])
	}
	t.Cleanup(func() { _ = killOne(pid, syscall.SIGKILL) })
	return pid
}

func appendLine(path, line string) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	file.WriteString(line + "\n")
}

func exitCodeIs(exit ProcessExit, want int) bool {
	return exit.Code != nil && *exit.Code == want
}

func TestStartStreaming(t *testing.T) {
	t.Run("streams stdout line by line, logs it byte for byte, and keeps a last line without a newline", func(t *testing.T) {
		cmd, logPath := streamChild(t, "chunks")
		started, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		if got := collectLines(t, started.Lines); !reflect.DeepEqual(got, []string{"one", "twoé", "last"}) {
			t.Fatalf("lines = %q, want [one twoé last]", got)
		}
		exit := <-started.Exit
		if !exitCodeIs(exit, 0) || exit.Signal != "" || exit.StderrTail != "" || exit.Forced != "" {
			t.Fatalf("exit = %+v, want code 0, no signal, empty tail, unforced", exit)
		}
		log, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read log: %v", err)
		}
		if string(log) != "one\ntwoé\nlast" {
			t.Fatalf("log = %q, want %q", log, "one\ntwoé\nlast")
		}
	})

	t.Run("feeds stdin and keeps the tail of stderr", func(t *testing.T) {
		cmd, _ := streamChild(t, "upper-stdin")
		stdin := "hello"
		cmd.Stdin = &stdin
		started, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		if got := collectLines(t, started.Lines); !reflect.DeepEqual(got, []string{"HELLO"}) {
			t.Fatalf("lines = %q, want [HELLO]", got)
		}
		exit := <-started.Exit
		if !exitCodeIs(exit, 3) {
			t.Fatalf("exit code = %v, want 3", exit.Code)
		}
		if len(exit.StderrTail) != 4_000 {
			t.Fatalf("stderrTail length = %d, want 4000", len(exit.StderrTail))
		}
		if !strings.HasSuffix(exit.StderrTail, "xEND") {
			t.Fatalf("stderrTail = %q..., want it to end with xEND", exit.StderrTail[:40])
		}
	})

	t.Run("a binary that cannot start is an error, not a process", func(t *testing.T) {
		cmd, _ := streamChild(t, "three-lines")
		cmd.Command = "/nonexistent/worker-binary"
		_, err := StartStreaming(context.Background(), cmd, nil)
		if err == nil || !strings.Contains(err.Error(), "ENOENT") {
			t.Fatalf("error = %v, want it to name ENOENT", err)
		}
	})

	t.Run("a log that cannot be opened is an error before anything starts", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "file")
		if err := os.WriteFile(file, []byte(""), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd, _ := streamChild(t, "three-lines")
		underFile := filepath.Join(file, "out.log")
		cmd.LogPath = &underFile
		if _, err := StartStreaming(context.Background(), cmd, nil); err == nil || !strings.Contains(err.Error(), "cannot open log") {
			t.Fatalf("error = %v, want it to say cannot open log", err)
		}
		directory := t.TempDir()
		cmd.LogPath = &directory
		if _, err := StartStreaming(context.Background(), cmd, nil); err == nil || !strings.Contains(err.Error(), "cannot open log") {
			t.Fatalf("error = %v, want it to say cannot open log for a directory too", err)
		}
	})

	t.Run("past its timeout the group is terminated and the exit says forced timeout", func(t *testing.T) {
		cmd, _ := streamChild(t, "sleep-forever")
		timeoutMs := int64(100)
		cmd.TimeoutMs = &timeoutMs
		started, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-started.Exit
		if exit.Code != nil || exit.Signal != "SIGTERM" || exit.Forced != ForcedTimeout {
			t.Fatalf("exit = %+v, want no code, SIGTERM, forced timeout", exit)
		}
	})

	t.Run("interrupt terminates the group and the first reason wins", func(t *testing.T) {
		cmd, _ := streamChild(t, "up-then-sleep")
		started, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		if up := <-started.Lines; up != "up" {
			t.Fatalf("first line = %q, want up", up)
		}
		started.Interrupt(context.Background(), ForcedStopped, 1_000)
		started.Interrupt(context.Background(), ForcedTimeout, 1_000)
		exit := <-started.Exit
		if exit.Signal != "SIGTERM" || exit.Forced != ForcedStopped {
			t.Fatalf("exit = %+v, want SIGTERM, forced stopped", exit)
		}
	})
}

func engineCommand(t *testing.T, mode string, mutate func(*StreamCommand)) StreamCommand {
	t.Helper()
	graceMs := int64(60_000)
	cmd := StreamCommand{
		Command: selfExe(t),
		Cwd:     t.TempDir(),
		Env:     childEnv(mode),
		GraceMs: &graceMs,
	}
	if mutate != nil {
		mutate(&cmd)
	}
	return cmd
}

func TestStartStreamingAsAnEngineRunsIt(t *testing.T) {
	t.Run("does not signal the group after the engine has exited (its pid may be reused)", func(t *testing.T) {
		cmd := engineCommand(t, "sleep-for", func(cmd *StreamCommand) {
			cmd.Env = childEnv("sleep-for", "PROCESS_TEST_SLEEP_MS=200")
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		if !proc.Signal(syscall.SIGTERM) {
			t.Fatal("signal before exit = false, want true")
		}
		exit := <-proc.Exit
		if exit.Signal != "SIGTERM" {
			t.Fatalf("exit signal = %q, want SIGTERM (the group did take the signal)", exit.Signal)
		}
		if proc.Signal(syscall.SIGKILL) {
			t.Fatal("signal after exit = true, want false")
		}
	})

	t.Run("reports a start failure as a Result, not a throw", func(t *testing.T) {
		cmd := engineCommand(t, "", func(cmd *StreamCommand) {
			cmd.Command = "/no/such/binary"
			cmd.Env = []string{}
		})
		_, err := StartStreaming(context.Background(), cmd, nil)
		if err == nil || !strings.Contains(err.Error(), "ENOENT") {
			t.Fatalf("error = %v, want it to name ENOENT", err)
		}
	})

	t.Run(`the wall clock times the run out: the exit is forced "timeout" and the group dies`, func(t *testing.T) {
		cmd := engineCommand(t, "sleep-forever", func(cmd *StreamCommand) {
			graceMs := int64(500)
			timeoutMs := int64(250)
			cmd.GraceMs = &graceMs
			cmd.TimeoutMs = &timeoutMs
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		if exit.Forced != ForcedTimeout || exit.Code != nil || exit.Signal == "" {
			t.Fatalf("exit = %+v, want forced timeout, no code, a signal", exit)
		}
	})

	t.Run("interrupt runs the engine's own stop first, then SIGTERMs the group", func(t *testing.T) {
		order := filepath.Join(t.TempDir(), "order")
		ready := filepath.Join(t.TempDir(), "ready")
		cmd := engineCommand(t, "sigterm-log", func(cmd *StreamCommand) {
			cmd.Env = childEnv("sigterm-log", "PROCESS_TEST_FILE="+order, childReadyEnv+"="+ready)
			graceMs := int64(5_000)
			cmd.GraceMs = &graceMs
			cmd.Soft = func(ForcedReason) {
				appendLine(order, "soft")
				time.Sleep(200 * time.Millisecond)
			}
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		// The SIGTERM must find the trap installed, or the child dies before recording its arrival.
		waitFor(t, func() bool {
			_, err := os.Stat(ready)
			return err == nil
		})
		proc.Interrupt(context.Background(), ForcedStopped)
		exit := <-proc.Exit
		recorded, err := os.ReadFile(order)
		if err != nil {
			t.Fatalf("read order: %v", err)
		}
		wantOrder := "soft\nterm\n"
		if string(recorded) != wantOrder {
			t.Fatalf("order = %q, want %q", recorded, wantOrder)
		}
		if exit.Forced != ForcedStopped || exit.Signal != "SIGTERM" {
			t.Fatalf("exit = %+v, want forced stopped, SIGTERM", exit)
		}
	})

	t.Run("drains stdout even when nobody iterates the lines", func(t *testing.T) {
		cmd := engineCommand(t, "three-lines", nil)
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		if !exitCodeIs(exit, 0) {
			t.Fatalf("exit code = %v, want 0", exit.Code)
		}
		// Reading only after the run has ended still sees every line: nothing was left to backpressure.
		if seen := collectLines(t, proc.Lines); !reflect.DeepEqual(seen, []string{"one", "two", "three"}) {
			t.Fatalf("lines = %q, want [one two three]", seen)
		}
	})

	t.Run("terminates a leftover grandchild once the leader exits when the engine opts in", func(t *testing.T) {
		cmd := engineCommand(t, "grandchild-leader", func(cmd *StreamCommand) {
			graceMs := int64(2_000)
			cmd.GraceMs = &graceMs
			cmd.ReapGroupOnExit = true
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		grandchild := grandchildPid(t, collectLines(t, proc.Lines))
		// The run still ended on its own; only the group it left behind was cleaned up.
		if exit.Forced != "" || !exitCodeIs(exit, 0) {
			t.Fatalf("exit = %+v, want code 0, unforced", exit)
		}
		untilGone(t, grandchild)
	})

	t.Run("leaves a leftover grandchild alone on leader exit by default", func(t *testing.T) {
		cmd := engineCommand(t, "grandchild-leader", nil)
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		grandchild := grandchildPid(t, collectLines(t, proc.Lines))
		if exit.Forced != "" {
			t.Fatalf("exit = %+v, want unforced", exit)
		}
		// Old behaviour: the grandchild outlives the run, so the test cleans it up itself.
		if !IsAlive(grandchild) {
			t.Fatalf("grandchild %d is not alive, want it left alone", grandchild)
		}
		killAndWait(t, grandchild)
	})

	t.Run("keeps benign startup stderr out of the tail while still reporting every line", func(t *testing.T) {
		type heard struct {
			line   string
			benign bool
		}
		var seen []heard
		benignStart := regexp.MustCompile(`^Still starting after \d+s\b`)
		cmd := engineCommand(t, "stderr-benign", func(cmd *StreamCommand) {
			cmd.IsBenignStderr = func(line string) bool { return benignStart.MatchString(line) }
		})
		proc, err := StartStreaming(context.Background(), cmd, func(line string, benign bool) {
			seen = append(seen, heard{line, benign})
		})
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		if !exitCodeIs(exit, 3) {
			t.Fatalf("exit code = %v, want 3", exit.Code)
		}
		if exit.StderrTail != "FATAL: boom\n" {
			t.Fatalf("stderrTail = %q, want %q", exit.StderrTail, "FATAL: boom\n")
		}
		want := []heard{
			{"Still starting after 10s — phase: discover", true},
			{"FATAL: boom", false},
		}
		if !reflect.DeepEqual(seen, want) {
			t.Fatalf("stderr lines = %+v, want %+v", seen, want)
		}
	})
}

// Direct coverage of the supervision paths the engine e2e runs exercise only end to end.
func TestStartStreamingSupervision(t *testing.T) {
	t.Run("writes stdin line by line until it is closed", func(t *testing.T) {
		cmd := engineCommand(t, "upper-stdin", nil)
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		if !proc.Write("ab") || !proc.Write("cd") {
			t.Fatal("write before endInput = false, want true")
		}
		proc.EndInput()
		if proc.Write("ef") {
			t.Fatal("write after endInput = true, want false")
		}
		// Each Write appends its own newline, so the upper-casing echo answers line per line.
		if got := collectLines(t, proc.Lines); !reflect.DeepEqual(got, []string{"AB", "CD", ""}) {
			t.Fatalf("lines = %q, want [AB CD ]", got)
		}
		if exit := <-proc.Exit; !exitCodeIs(exit, 3) {
			t.Fatalf("exit code = %v, want 3", exit.Code)
		}
	})

	t.Run("refuses a write after the engine has exited", func(t *testing.T) {
		proc, err := StartStreaming(context.Background(), engineCommand(t, "three-lines", nil), nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		<-proc.Exit
		if proc.Write("late") {
			t.Fatal("write after exit = true, want false")
		}
	})

	t.Run("a write to an engine that exits without reading fails closed", func(t *testing.T) {
		proc, err := StartStreaming(context.Background(), engineCommand(t, "three-lines", nil), nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		// Keep writing until the pipe is full, so one write is in flight when the engine exits: that
		// write fails with EPIPE and stdin closes, and every later write is refused.
		deadline := time.Now().Add(10 * time.Second)
		for proc.Write("ignored") {
			if time.Now().After(deadline) {
				t.Fatal("write never failed after the engine's exit")
			}
		}
		if proc.Write("late") {
			t.Fatal("write after the failure = true, want false")
		}
		<-proc.Exit
	})

	t.Run("kills an engine that streams past the line budget with no newline", func(t *testing.T) {
		cmd := engineCommand(t, "flood", func(cmd *StreamCommand) {
			limit := int64(16)
			cmd.MaxLineBytes = &limit
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		exit := <-proc.Exit
		if got := collectLines(t, proc.Lines); len(got) != 1 || got[0] != "kept" {
			t.Fatalf("lines = %q, want [kept]", got)
		}
		if exit.Code != nil || exit.Signal != "SIGKILL" {
			t.Fatalf("exit = %+v, want a SIGKILL with no code", exit)
		}
	})

	t.Run("the soft stop is abandoned once the grace runs out", func(t *testing.T) {
		cmd := engineCommand(t, "sleep-forever", func(cmd *StreamCommand) {
			graceMs := int64(300)
			cmd.GraceMs = &graceMs
			cmd.Soft = func(ForcedReason) { time.Sleep(2 * time.Second) }
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		started := time.Now()
		proc.Interrupt(context.Background(), ForcedStopped)
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("interrupt took %v, want the grace (300ms) to end it, not the soft stop", elapsed)
		}
		if exit := <-proc.Exit; exit.Forced != ForcedStopped || exit.Signal != "SIGTERM" {
			t.Fatalf("exit = %+v, want forced stopped, SIGTERM", exit)
		}
	})

	t.Run("the engine exiting on its own ends the soft-stop wait", func(t *testing.T) {
		cmd := engineCommand(t, "three-lines", func(cmd *StreamCommand) {
			cmd.Soft = func(ForcedReason) { time.Sleep(5 * time.Second) }
		})
		proc, err := StartStreaming(context.Background(), cmd, nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		started := time.Now()
		proc.Interrupt(context.Background(), ForcedStopped)
		if elapsed := time.Since(started); elapsed > 2*time.Second {
			t.Fatalf("interrupt took %v, want the engine's own exit to end the wait, not the soft stop", elapsed)
		}
		if exit := <-proc.Exit; exit.Forced != ForcedStopped || !exitCodeIs(exit, 0) {
			t.Fatalf("exit = %+v, want code 0, forced stopped", exit)
		}
	})

	t.Run("drops the pipes when a grandchild holds them open after the leader exits", func(t *testing.T) {
		proc, err := StartStreaming(context.Background(), engineCommand(t, "leaky-grandchild", nil), nil)
		if err != nil {
			t.Fatalf("startStreaming: %v", err)
		}
		started := time.Now()
		exit := <-proc.Exit
		elapsed := time.Since(started)
		if elapsed < 300*time.Millisecond {
			t.Fatalf("exit after %v, want it to wait for the pipe drop (500ms)", elapsed)
		}
		if !exitCodeIs(exit, 0) {
			t.Fatalf("exit code = %v, want 0", exit.Code)
		}
		grandchildPid(t, collectLines(t, proc.Lines))
	})
}

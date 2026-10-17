// The watch card's scenes: the ensure hook checks health, not a bare connect — a front that is
// up but hung is replaced, a port another program holds is left alone, and every start leaves its
// trace in router.log. The worlds are the power-loss group's (a temp state root, a free port and
// the real service chain), run with CLAUDE_PLUGIN_DATA set as Claude Code runs hooks.
package router

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// watchHoldPortEnv names the port the hold-port child binds (its TestMain mode).
const watchHoldPortEnv = "ACME_TEST_HOLD_PORT"

// runHoldPortChild is the silent holder: it binds the port its env names, accepts every
// connection and never answers — a hung front or a foreign holder, as its argv decides.
func runHoldPortChild() {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", os.Getenv(watchHoldPortEnv)))
	if err != nil {
		fmt.Fprintln(os.Stderr, "hold-port: "+err.Error())
		os.Exit(3)
	}
	for {
		conn, err := listener.Accept()
		if err != nil {
			os.Exit(0)
		}
		// Hold the connection open and read nothing: the peer's deadline is the only end.
		go func() {
			buffer := make([]byte, 1)
			for {
				if _, err := conn.Read(buffer); err != nil {
					return
				}
			}
		}()
	}
}

// childEnv is the test process's environment plus extra entries, a repeated key's last value the
// only one the child sees.
func childEnv(extra ...string) []string {
	names := make(map[string]bool, len(extra))
	for _, entry := range extra {
		names[strings.SplitN(entry, "=", 2)[0]] = true
	}
	out := make([]string, 0, len(os.Environ())+len(extra))
	for _, entry := range os.Environ() {
		if !names[strings.SplitN(entry, "=", 2)[0]] {
			out = append(out, entry)
		}
	}
	return append(out, extra...)
}

// spawnDetachedChild runs this binary detached with the argv and TestMain mode env given, as the
// production chain spawns its children; the caller owns the pid (only it is signalled).
func spawnDetachedChild(t *testing.T, args []string, extraEnv ...string) int64 {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	detached := process.StartDetached(self, args, process.DetachedOptions{Env: childEnv(extraEnv...)})
	if detached.Pid == 0 {
		t.Fatal("the detached child never started")
	}
	t.Cleanup(func() { detached.Kill() })
	return detached.Pid
}

// newWatchWorld is a power-loss world with the hook's environment: CLAUDE_PLUGIN_DATA points at
// an empty plugin data dir, and no state may land in it.
func newWatchWorld(t *testing.T) *powerLossWorld {
	t.Helper()
	world := newPowerLossWorld(t)
	data := filepath.Join(world.root, "claude", "plugins", "data", "acme-plugin-cc-test")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	world.env["CLAUDE_PLUGIN_DATA"] = data
	world.dataDir = data
	return world
}

// routerLogText is the router log as written so far.
func (w *powerLossWorld) routerLogText(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(domain.NewStateLayout(w.state).RouterLog)
	if err != nil {
		return ""
	}
	return string(data)
}

// silentMark is the silence episode's first silent probe as recorded, when there is one.
func (w *powerLossWorld) silentMark(t *testing.T) (int64, bool) {
	t.Helper()
	data, err := os.ReadFile(domain.NewStateLayout(w.state).RouterSilent)
	if err != nil {
		return 0, false
	}
	ms, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0, false
	}
	return ms, true
}

// setSilentMark writes the episode's mark directly: the tests age an episode without sleeping
// through it.
func (w *powerLossWorld) setSilentMark(t *testing.T, ms int64) {
	t.Helper()
	if err := os.MkdirAll(w.state, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(domain.NewStateLayout(w.state).RouterSilent,
		[]byte(strconv.FormatInt(ms, 10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// hungFront seeds the scene the live incident left: our own front holds the port and never
// answers health.
func (w *powerLossWorld) hungFront(t *testing.T) int64 {
	t.Helper()
	w.seedSetupDone()
	pid := spawnDetachedChild(t, []string{"acme", "router", "run"},
		focusChildEnv+"=hold-port", watchHoldPortEnv+"="+strconv.Itoa(w.port))
	w.seedPidFile(pid)
	waitUntil(t, 3*time.Second, func() bool { return process.PortAnswers(context.Background(), w.port, 200) })
	return pid
}

// foreignHolder seeds the other silent scene: the port is held by a program that is not ours,
// and the pid record names it.
func (w *powerLossWorld) foreignHolder(t *testing.T) int64 {
	t.Helper()
	w.seedSetupDone()
	pid := spawnDetachedChild(t, []string{"hold-the-port"},
		focusChildEnv+"=hold-port", watchHoldPortEnv+"="+strconv.Itoa(w.port))
	w.seedPidFile(pid)
	waitUntil(t, 3*time.Second, func() bool { return process.PortAnswers(context.Background(), w.port, 200) })
	return pid
}

func TestEnsureHealth(t *testing.T) {
	t.Parallel()
	t.Run("a port that accepts but never answers is not up: no router of ours named, nothing started", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		holder := spawnDetachedChild(t, []string{"hold-the-port"},
			focusChildEnv+"=hold-port", watchHoldPortEnv+"="+strconv.Itoa(w.port))
		waitUntil(t, 3*time.Second, func() bool { return process.PortAnswers(context.Background(), w.port, 200) })

		began := time.Now()
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(silent holder, no record) = %q, want held", got)
		}
		if took := time.Since(began); took > 3*time.Second {
			t.Fatalf("ensure took %s, want it inside the 3 s hook budget", took)
		}
		if !process.IsAlive(holder) {
			t.Fatal("the silent holder did not survive the check")
		}
		if !strings.Contains(w.routerLogText(t), "left alone") {
			t.Fatalf("router.log = %q, want the left-alone line", w.routerLogText(t))
		}
	})

	t.Run("hung front: one silent probe marks the episode and replaces nothing", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.hungFront(t)

		began := time.Now()
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(first silent probe) = %q, want held: one slow second must not kill", got)
		}
		if took := time.Since(began); took > 3*time.Second {
			t.Fatalf("ensure took %s, want it inside the 3 s hook budget", took)
		}
		// The front still holds the port and the episode is marked with its first silent probe.
		if !process.PortAnswers(context.Background(), w.port, 200) {
			t.Fatal("the silent front lost its port on one probe")
		}
		first, ok := w.silentMark(t)
		if !ok || first < nowMs()-5000 || first > nowMs() {
			t.Fatalf("silent mark = (%d, %v), want a fresh one", first, ok)
		}
		episode := "did not answer health; replaced if still silent after 5 s"
		if got := strings.Count(w.routerLogText(t), episode); got != 1 {
			t.Fatalf("router.log has %d episode lines, want exactly one per episode", got)
		}
		// A second probe in the same episode neither kills nor repeats the line.
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(second silent probe) = %q, want held", got)
		}
		if !process.PortAnswers(context.Background(), w.port, 200) {
			t.Fatal("the silent front lost its port on the second probe")
		}
		if got := strings.Count(w.routerLogText(t), episode); got != 1 {
			t.Fatalf("router.log has %d episode lines after two probes, want one", got)
		}
	})

	t.Run("a front that answers between two silent probes clears the mark and is never killed", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		hung := w.hungFront(t)
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(silent) = %q, want held", got)
		}
		// Aged past the kill threshold: had the answer not cleared it, the next probe kills.
		w.setSilentMark(t, nowMs()-6000)

		// The front answers ours between the two probes: the mark must go.
		signalPid(hung, "SIGKILL")
		waitUntil(t, 3*time.Second, func() bool { return !process.PortAnswers(context.Background(), w.port, 200) })
		held := processHold(t, w.port, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router"}`))
		})
		if got := w.ensure(); got != EnsureUp {
			t.Fatalf("ensure(answering front) = %q, want up", got)
		}
		if _, ok := w.silentMark(t); ok {
			t.Fatal("the answer left the silence mark behind")
		}

		// Silent again: a fresh episode starts, and the aged mark the answer cleared kills nothing.
		held.close()
		next := spawnDetachedChild(t, []string{"acme", "router", "run"},
			focusChildEnv+"=hold-port", watchHoldPortEnv+"="+strconv.Itoa(w.port))
		w.seedPidFile(next)
		waitUntil(t, 3*time.Second, func() bool { return process.PortAnswers(context.Background(), w.port, 200) })
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(silent again) = %q, want held: the cleared mark must not kill", got)
		}
		if !process.PortAnswers(context.Background(), w.port, 200) {
			t.Fatal("the second silent front was killed by a mark its episode never wrote")
		}
	})

	t.Run("hung front: silence sustained past 5 s across two checks replaces the front", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		hung := w.hungFront(t)
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(first silent probe) = %q, want held", got)
		}
		// The episode began 6 s ago (the watchdog's ticks or the hooks' probes filled the time).
		w.setSilentMark(t, nowMs()-6000)

		began := time.Now()
		if got := w.ensure(); got != EnsureStarted {
			t.Fatalf("ensure(sustained silence) = %q, want started", got)
		}
		if took := time.Since(began); took > 3*time.Second {
			t.Fatalf("ensure took %s, want it inside the 3 s hook budget", took)
		}
		w.awaitHealth(began.Add(3 * time.Second))

		log := w.routerLogText(t)
		if !strings.Contains(log, fmt.Sprintf("hung front %d", hung)) {
			t.Fatalf("router.log = %q, want the start line naming hung front %d", log, hung)
		}
		if !strings.Contains(log, "SIGKILL") {
			t.Fatalf("router.log = %q, want the kill line", log)
		}
		if _, ok := w.silentMark(t); ok {
			t.Fatal("the replaced episode left its mark behind")
		}
		if data, err := os.ReadFile(filepath.Join(w.dataDir, "router.pid")); err == nil {
			t.Fatalf("the router's pid file landed in the plugin data dir (%s)", data)
		}
	})

	t.Run("a stale mark, older than 60 s, starts a new episode instead of killing", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.hungFront(t)
		w.setSilentMark(t, nowMs()-70000)

		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(stale mark) = %q, want held: a stale mark belongs to no live episode", got)
		}
		if !process.PortAnswers(context.Background(), w.port, 200) {
			t.Fatal("the silent front lost its port to a stale mark")
		}
		first, ok := w.silentMark(t)
		if !ok || first < nowMs()-5000 {
			t.Fatalf("silent mark = (%d, %v), want it rewritten fresh", first, ok)
		}
		if !strings.Contains(w.routerLogText(t), "replaced if still silent after 5 s") {
			t.Fatalf("router.log = %q, want the new episode's line", w.routerLogText(t))
		}
	})

	t.Run("foreign holder: the port is held by a program that is not ours, so ensure leaves it", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		holder := w.foreignHolder(t)

		began := time.Now()
		if got := w.ensure(); got != EnsureHeld {
			t.Fatalf("ensure(foreign holder) = %q, want held", got)
		}
		if took := time.Since(began); took > 3*time.Second {
			t.Fatalf("ensure took %s, want it inside the 3 s hook budget", took)
		}
		if !process.IsAlive(holder) {
			t.Fatal("the foreign holder did not survive the check")
		}
		if !strings.Contains(w.routerLogText(t), fmt.Sprintf("pid %d", holder)) {
			t.Fatalf("router.log = %q, want the held line naming pid %d", w.routerLogText(t), holder)
		}
	})

	t.Run("a failed start leaves its stderr and the ensure line in router.log", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		script := filepath.Join(w.root, "fail-start.sh")
		if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'start refused: no worker' >&2\nexit 1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if got := EnsureRouter(context.Background(), EnsureOptions{
			Name:         processAcme.Name,
			EnvPrefix:    processAcme.EnvPrefix,
			Display:      processAcme.Display,
			HealthPath:   processAcme.Router.HealthPath,
			DefaultPort:  processAcme.Router.Port,
			Env:          w.env,
			RouterScript: script,
			Node:         "/bin/sh",
		}); got != EnsureStarted {
			t.Fatalf("ensure(failing start) = %q, want started", got)
		}
		waitUntil(t, 3*time.Second, func() bool {
			log := w.routerLogText(t)
			return strings.Contains(log, "start refused: no worker") &&
				strings.Contains(log, "ensure: started router (reason: port closed)")
		})
	})

	t.Run("the session pid is the nearest ancestor that is not a shell or the launcher", func(t *testing.T) {
		t.Parallel()
		commands := map[int64]string{
			11: `/bin/sh -c sh "/plugins/zai/dist/run" zai.js setup --hook`,
			12: "/bin/zsh /plugins/zai/dist/run zai-ensure.js --hook",
			13: "/usr/local/bin/claude --session 7",
			14: "-zsh",
		}
		parents := map[int64]int64{11: 12, 12: 13, 13: 14}
		command := func(pid int64) (string, bool) {
			line, ok := commands[pid]
			return line, ok
		}
		parent := func(pid int64) (int64, bool) {
			next, ok := parents[pid]
			return next, ok
		}
		if got := sessionPidOf(11, parent, command); got != 13 {
			t.Fatalf("sessionPidOf = %d, want 13 (the claude process past the hook shell and the launcher)", got)
		}
		shells := map[int64]string{21: "sh -c true", 22: "/bin/bash", 23: "zsh"}
		shellParents := map[int64]int64{21: 22, 22: 23}
		if got := sessionPidOf(21, func(pid int64) (int64, bool) {
			next, ok := shellParents[pid]
			return next, ok
		}, func(pid int64) (string, bool) {
			line, ok := shells[pid]
			return line, ok
		}); got != 0 {
			t.Fatalf("sessionPidOf(all shells) = %d, want 0 (no session found)", got)
		}
		if got := sessionPidOf(31, func(int64) (int64, bool) { return 0, false }, func(int64) (string, bool) { return "", false }); got != 0 {
			t.Fatalf("sessionPidOf(unreadable) = %d, want 0", got)
		}
		if got := sessionPidOf(41, func(int64) (int64, bool) { return 0, false }, func(int64) (string, bool) {
			return "/usr/local/bin/claude", true
		}); got != 41 {
			t.Fatalf("sessionPidOf(claude parent) = %d, want 41", got)
		}
	})
}

// spawnFakeSession starts a stand-in for the Claude Code process the watchdog watches: this
// binary in its session-hang mode under a shell that reaps it, so killing it is observable (a
// killed child of the test process itself stays a zombie, and a zombie still answers the
// liveness probe). The shell exits once the session child dies. The session ends by itself
// within the mode's backstop window, and the group's kill-and-wait cleanup is registered before
// the first way this helper can fail, so no path — a failed or timed-out test included — leaks
// it past its test.
func spawnFakeSession(t *testing.T) int64 {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "session.pid")
	shell := process.StartDetached("/bin/sh", []string{"-c",
		`"` + self + `" fake-session & echo $! > "` + pidFile + `"; wait`},
		process.DetachedOptions{Env: childEnv(focusChildEnv + "=session-hang")})
	if shell.Pid == 0 {
		t.Fatal("the fake session's shell never started")
	}
	// The session child shares the shell's group, so the group's end takes it too — even before
	// the pid file names it.
	t.Cleanup(func() {
		process.TerminateGroup(context.Background(), shell.Pid, 3000)
	})
	// The file exists before the shell's echo fills it; only a non-empty read names a session.
	waitUntil(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(pidFile)
		return err == nil && strings.TrimSpace(string(data)) != ""
	})
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	sessionPid, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return sessionPid
}

// spawnWatchdog starts the real watchdog service (`acme router watch --session-pid <pid>`) under
// a reaping shell, with the world's environment; the answer is the watchdog's own pid. The
// watchdog's trace is router.log; its stdio is nothing.
func (w *powerLossWorld) spawnWatchdog(t *testing.T, sessionPid int64) int64 {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	w.watchdogSpawns++
	pidFile := filepath.Join(w.root, fmt.Sprintf("watchdog.%d.%d.pid", sessionPid, w.watchdogSpawns))
	env := append(environOf(w.env),
		powerLossChildEnv+"="+powerLossChildMode, powerLossChildState+"="+w.state)
	shell := process.StartDetached("/bin/sh", []string{"-c",
		`"` + self + `" acme router watch --session-pid ` + strconv.FormatInt(sessionPid, 10) +
			` & echo $! > "` + pidFile + `"; wait`},
		process.DetachedOptions{Env: env})
	if shell.Pid == 0 {
		t.Fatal("the watchdog's shell never started")
	}
	// The group's end takes the watchdog with its shell, even before the pid file names it.
	t.Cleanup(func() {
		process.TerminateGroup(context.Background(), shell.Pid, 3000)
	})
	waitUntil(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(pidFile)
		return err == nil && strings.TrimSpace(string(data)) != ""
	})
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	watchdogPid, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		signalPid(watchdogPid, "SIGKILL")
	})
	return watchdogPid
}

// awaitClaim waits until the watchdog holds the session's guard file: it is in its loop.
func (w *powerLossWorld) awaitClaim(t *testing.T, sessionPid, watchdogPid int64) {
	t.Helper()
	waitUntil(t, 3*time.Second, func() bool {
		holder, ok := pidNamedBy(watchPidFileOf(w.state, sessionPid))
		return ok && holder == watchdogPid
	})
}

func TestSessionWatchdog(t *testing.T) {
	t.Parallel()
	t.Run("restarts a front killed mid-turn, health answers again within 5 s", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		session := spawnFakeSession(t)
		watchdog := w.spawnWatchdog(t, session)
		w.awaitClaim(t, session, watchdog)

		// the start child writes the record once health answers, so it may trail the answer
		var record PidRecord
		waitUntil(t, 3*time.Second, func() bool {
			var ok bool
			record, ok = ReadPidFile(context.Background(), w.state)
			return ok
		})
		signalPid(record.Pid, "SIGKILL")
		began := time.Now()
		w.awaitHealth(began.Add(5 * time.Second))
		if !strings.Contains(w.routerLogText(t), "ensure: started router (reason: port closed)") {
			t.Fatalf("router.log = %q, want the watchdog's start line", w.routerLogText(t))
		}
	})

	t.Run("exits within 3 s of the session ending and leaves the router up", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		session := spawnFakeSession(t)
		watchdog := w.spawnWatchdog(t, session)
		w.awaitClaim(t, session, watchdog)

		signalPid(session, "SIGKILL")
		waitUntil(t, 3*time.Second, func() bool { return !process.IsAlive(watchdog) })
		if probe := ProbeRouter(context.Background(), w.port, processAcme, 200); probe.State != ProbeOurs {
			t.Fatalf("probe after the watchdog exited = %q, want ours", probe.State)
		}
		if _, err := os.Stat(watchPidFileOf(w.state, session)); !os.IsNotExist(err) {
			t.Fatalf("the watchdog left its guard file behind (stat err %v)", err)
		}
	})

	t.Run("a second watchdog for the same session bows out at once", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		session := spawnFakeSession(t)
		first := w.spawnWatchdog(t, session)
		w.awaitClaim(t, session, first)
		second := w.spawnWatchdog(t, session)

		waitUntil(t, 3*time.Second, func() bool { return !process.IsAlive(second) })
		if !process.IsAlive(first) {
			t.Fatal("the first watchdog did not survive the second one's claim")
		}
	})

	t.Run("exits when the router was retired for remove", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		session := spawnFakeSession(t)
		watchdog := w.spawnWatchdog(t, session)
		w.awaitClaim(t, session, watchdog)

		w.seedRetiredFile(powerLossDeadPid(t))
		waitUntil(t, 3*time.Second, func() bool { return !process.IsAlive(watchdog) })
		if probe := ProbeRouter(context.Background(), w.port, processAcme, 200); probe.State != ProbeOurs {
			t.Fatalf("probe after the watchdog retired-exit = %q, want ours", probe.State)
		}
	})

	t.Run("a hook's ensure entry also runs with CLAUDE_PLUGIN_DATA set: the router's state stays under ~/.agents", func(t *testing.T) {
		t.Parallel()
		w := newWatchWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		if data, err := os.ReadFile(filepath.Join(w.dataDir, "router.pid")); err == nil {
			t.Fatalf("the router's pid file landed in the plugin data dir (%s)", data)
		}
	})
}

func TestSleepWhileAlive(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		wait     time.Duration
		aliveFor int
		cancel   bool
		want     bool
		within   time.Duration
	}{
		{"a live session waits the whole interval", 300 * time.Millisecond, 100, false, true, time.Second},
		{"a session ending mid-wait ends it within a quarter second", 10 * time.Second, 1, false, false, time.Second},
		{"a cancelled context ends it at once", 10 * time.Second, 100, true, false, time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tt.cancel {
				cancel()
			}
			checks := 0
			began := time.Now()
			got := sleepWhileAlive(ctx, tt.wait, func() bool { checks++; return checks <= tt.aliveFor })
			if got != tt.want {
				t.Errorf("sleepWhileAlive = %v, want %v", got, tt.want)
			}
			if took := time.Since(began); took > tt.within {
				t.Errorf("sleepWhileAlive took %s, want under %s", took, tt.within)
			}
		})
	}
}

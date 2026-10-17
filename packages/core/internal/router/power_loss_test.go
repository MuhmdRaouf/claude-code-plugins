// The power-loss group: a power cut skips the router's shutdown and Claude's exit hook, so every
// record the last session left behind survives with no router running. One case per leftover, each
// building the leftover state in a temp state root and running the real ensure — the real detached
// start child, which spawns the real front, which forks the real worker — then asserting the
// router answers health again within the 3 s hook budget and ensure said "started".
package router

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// powerLossChildEnv turns this binary into the group's service child. The names carry the provider
// prefix so the start child's own spawns keep them through ChildEnv's filter, and the front's
// worker fork inherits its process environment in turn: every process the start path creates
// re-enters the mode.
const (
	powerLossChildEnv   = "ACME_TEST_SERVICE_CHILD"
	powerLossChildMode  = "power-loss-service"
	powerLossChildState = "ACME_TEST_SERVICE_STATE"
)

// runPowerLossServiceChild is the service child: argv `<bin> acme router <command>` (the service
// entry) or `<bin> acme passthrough` (the emergency), running the real entries against the state
// root the world set.
func runPowerLossServiceChild() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	service := len(os.Args) >= 4 && os.Args[1] == processAcme.Name && os.Args[2] == "router"
	passthrough := len(os.Args) == 3 && os.Args[1] == processAcme.Name && os.Args[2] == "passthrough"
	if !service && !passthrough {
		fail(fmt.Sprintf("power-loss child argv = %v", os.Args))
	}
	env := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	if passthrough {
		resolved := domain.ResolveProvider(processAcme, env)
		if err := RunEmergency(EmergencyProvider{
			Name:       resolved.Name,
			Display:    resolved.Display,
			EnvPrefix:  resolved.EnvPrefix,
			HealthPath: resolved.Router.HealthPath,
			Port:       resolved.Router.Port,
			Claim:      resolved.ModelClaim(),
		}, env, nil); err != nil {
			fail("power-loss passthrough: " + err.Error())
		}
		os.Exit(0)
	}
	self, err := os.Executable()
	if err != nil {
		fail("no executable: " + err.Error())
	}
	os.Exit(RouterService(RouterServiceOptions{
		Provider:  processAcme,
		StateRoot: os.Getenv(powerLossChildState),
		Script:    self,
		Env:       env,
		Argv:      os.Args[3:],
	}))
}

// powerLossWorld is one power-loss scene: a temp state root with its environment, a free port, and
// the start the ensure hook runs.
type powerLossWorld struct {
	t     *testing.T
	root  string
	state string
	port  int
	env   domain.EnvLookup
	start process.Detached
	// watchdogSpawns tells the watchdog spawns apart, so each reads its own pid file.
	watchdogSpawns int
	// dataDir is the plugin data dir the hook's environment carries, when the scene sets one.
	dataDir string
}

func newPowerLossWorld(t *testing.T) *powerLossWorld {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	port := freeRouterPort(t)
	env := domain.EnvLookup{
		"HOME":                  filepath.Join(root, "home"),
		"CLAUDE_CONFIG_DIR":     filepath.Join(root, "claude"),
		"RADAR_HOME":            filepath.Join(root, "radar"),
		"PROVIDER_ROUTERS_HOME": filepath.Join(root, "routers"),
		"PATH":                  os.Getenv("PATH"),
		"ACME_STATE_DIR":        state,
		"ACME_ROUTER_PORT":      strconv.Itoa(port),
		// Both upstreams point at a loopback port nothing listens on, so nothing the chain
		// forwards can leave the machine.
		"ACME_ROUTER_ANTHROPIC_URL": closedUpstream,
		"ACME_ROUTER_URL":           closedUpstream,
		"ACME_API_KEY":              "test-key",
		powerLossChildEnv:           powerLossChildMode,
		powerLossChildState:         state,
	}
	world := &powerLossWorld{t: t, root: root, state: state, port: port, env: env}
	t.Cleanup(world.stop)
	return world
}

// seedSetupDone leaves the mark the hooks act on.
func (w *powerLossWorld) seedSetupDone() {
	w.t.Helper()
	if err := os.WriteFile(filepath.Join(w.state, "setup-done"), []byte("true\n"), 0o600); err != nil {
		w.t.Fatal(err)
	}
}

// seedPidFile leaves the pid record a power loss would leave.
func (w *powerLossWorld) seedPidFile(pid int64) {
	w.t.Helper()
	if err := WritePidFile(context.Background(), w.state, PidRecord{
		Pid: pid, Port: int64(w.port), StartedAt: "t", Node: "/node", Version: "v",
		FrontVersion: 2, Mode: PidModeRouter, Token: "leftover",
	}); err != nil {
		w.t.Fatal(err)
	}
}

// seedRetiredFile leaves a retired router's record for a front that no longer runs.
func (w *powerLossWorld) seedRetiredFile(pid int64) {
	w.t.Helper()
	if err := writePidRecord(context.Background(), domain.NewStateLayout(w.state).RouterRetired, PidRecord{
		Pid: pid, Port: int64(w.port), StartedAt: "t", Node: "/node", Version: "v",
		FrontVersion: 2, Mode: PidModeRouter, Token: "leftover",
	}); err != nil {
		w.t.Fatal(err)
	}
}

// seedLock leaves the start lock with a holder's pid, aged as the scene needs.
func (w *powerLossWorld) seedLock(pid int64, age time.Duration) {
	w.t.Helper()
	lock := filepath.Join(w.state, "router.lock")
	if err := os.WriteFile(lock, []byte(strconv.FormatInt(pid, 10)+"\n"), 0o644); err != nil {
		w.t.Fatal(err)
	}
	if age != 0 {
		old := time.Now().Add(-age)
		if err := os.Chtimes(lock, old, old); err != nil {
			w.t.Fatal(err)
		}
	}
}

// ensure runs the hook's check with the real start: this binary detached in its `router start`
// mode, the spawn the production ensure entry makes.
func (w *powerLossWorld) ensure() EnsureStatus {
	return EnsureRouter(context.Background(), EnsureOptions{
		Name:         processAcme.Name,
		EnvPrefix:    processAcme.EnvPrefix,
		Display:      processAcme.Display,
		HealthPath:   processAcme.Router.HealthPath,
		DefaultPort:  processAcme.Router.Port,
		Env:          w.env,
		RouterScript: "acme-router.js",
		Start: func(node string, _ []string, childEnv domain.EnvLookup) {
			w.start = process.StartDetached(node, []string{processAcme.Name, "router", "start"},
				process.DetachedOptions{Env: environOf(childEnv), LogFile: filepath.Join(w.root, "start.log")})
		},
	})
}

// awaitHealth waits for our health on the port until the deadline.
func (w *powerLossWorld) awaitHealth(until time.Time) RouterHealth {
	w.t.Helper()
	for {
		probe := ProbeRouter(context.Background(), w.port, processAcme, 200)
		if probe.State == ProbeOurs {
			return probe.Health
		}
		if time.Now().After(until) {
			w.t.Fatalf("the router never answered health on port %d (last probe %s)", w.port, probe.State)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ensureRecovers asserts the whole recovery: ensure says started, returns inside the 3 s hook
// budget, and the router answers health within the same 3 s.
func (w *powerLossWorld) ensureRecovers() {
	w.t.Helper()
	began := time.Now()
	if status := w.ensure(); status != EnsureStarted {
		w.t.Fatalf("ensure = %q, want started", status)
	}
	if took := time.Since(began); took > 3*time.Second {
		w.t.Fatalf("ensure took %s, want it inside the 3 s hook budget", took)
	}
	w.awaitHealth(began.Add(3 * time.Second))
}

// stop ends what this world started: the router (its drain ends the worker) and a start child
// still stuck. The router is found by its own health answer on this port, so a pid from a file
// alone is never trusted or signalled.
func (w *powerLossWorld) stop() {
	var ours []int64
	if probe := ProbeRouter(context.Background(), w.port, processAcme, 200); probe.State == ProbeOurs && probe.Health.Pid != nil {
		signalPid(*probe.Health.Pid, "SIGTERM")
		ours = append(ours, *probe.Health.Pid)
	}
	if w.start.Pid != 0 && process.IsAlive(w.start.Pid) {
		signalPid(w.start.Pid, "SIGTERM")
		ours = append(ours, w.start.Pid)
	}
	waitUntil(w.t, 10*time.Second, func() bool {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(w.port)))
		if err != nil {
			return false
		}
		_ = listener.Close()
		return true
	})
	// The router logs its exit and writes its marker after the port closes, and its worker
	// drains after that. An exited child nobody reaped still probes alive, so the wait is
	// bounded and never fails; emptying the state root with retries is what keeps TempDir's
	// cleanup from meeting a file written mid-removal.
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if !slices.ContainsFunc(ours, process.IsAlive) {
			break
		}
	}
	waitUntil(w.t, 5*time.Second, func() bool { return os.RemoveAll(w.state) == nil })
}

// powerLossDeadPid returns the pid of a process that is already gone: the shape every record a
// power loss leaves behind names.
func powerLossDeadPid(t *testing.T) int64 {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(self, "-test.run", "^$")
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return int64(command.Process.Pid)
}

func TestPowerLoss(t *testing.T) {
	t.Parallel()
	t.Run("a pid file naming a live stranger: recovered without waiting on or killing it", func(t *testing.T) {
		t.Parallel()
		stranger := exec.Command("/bin/sleep", "30")
		stranger.Stdout, stranger.Stderr = io.Discard, io.Discard
		if err := stranger.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = stranger.Process.Kill(); _ = stranger.Wait() })
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		w.seedPidFile(int64(stranger.Process.Pid))
		w.ensureRecovers()
		if !process.IsAlive(int64(stranger.Process.Pid)) {
			t.Fatal("the stranger the pid file named did not survive the recovery")
		}
		// The starter rewrites the record once its own next poll sees the front; the record must
		// end up naming the new router, never the stranger.
		waitUntil(t, 3*time.Second, func() bool {
			record, ok := ReadPidFile(context.Background(), w.state)
			return ok && record.Pid != int64(stranger.Process.Pid)
		})
	})

	t.Run("a pid file naming a dead router", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		w.seedPidFile(powerLossDeadPid(t))
		w.ensureRecovers()
	})

	t.Run("a start lock left by a dead starter", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		// The lock's mtime is fresh: only its holder being gone may let the start through.
		w.seedLock(powerLossDeadPid(t), 0)
		w.ensureRecovers()
	})

	t.Run("a start lock naming a pid another program now runs, only seconds old", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		// The reboot reused the holder's pid moments ago: the live stranger is the holder in name
		// only, and waiting the full stale age would spend the 3 s hook budget three times over.
		stranger := processSpawnChild(t)
		t.Cleanup(func() { _ = stranger.Process.Kill(); _ = stranger.Wait() })
		w.seedLock(int64(stranger.Process.Pid), 4*time.Second)
		w.ensureRecovers()
		if !process.IsAlive(int64(stranger.Process.Pid)) {
			t.Fatal("the reused pid did not survive the recovery")
		}
	})

	t.Run("a start lock naming a pid another program now runs", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		// The reboot reused the holder's pid, and the lock is old, as any power loss's is. The
		// live stranger is the holder in name only: a pid alone is never trusted or signalled.
		stranger := processSpawnChild(t)
		w.seedLock(int64(stranger.Process.Pid), 11*time.Second)
		w.ensureRecovers()
		if !process.IsAlive(int64(stranger.Process.Pid)) {
			t.Fatal("the reused pid did not survive the recovery")
		}
	})

	t.Run("a retired record and handover leftovers of a front that no longer runs", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		w.seedRetiredFile(powerLossDeadPid(t))
		// The handover's leftover: the pid record still names the front it was handing over.
		w.seedPidFile(powerLossDeadPid(t))
		w.ensureRecovers()
	})

	t.Run("a half-written pid file", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		if err := os.WriteFile(filepath.Join(w.state, "router.pid"), []byte(`{"pid": 41, "por`), 0o600); err != nil {
			t.Fatal(err)
		}
		w.ensureRecovers()
	})

	t.Run("mid-session: a router killed outright is back before the next prompt", func(t *testing.T) {
		t.Parallel()
		w := newPowerLossWorld(t)
		w.seedSetupDone()
		w.ensureRecovers()
		waitUntil(t, 3*time.Second, func() bool {
			_, ok := ReadPidFile(context.Background(), w.state)
			return ok
		})
		record, ok := ReadPidFile(context.Background(), w.state)
		if !ok {
			t.Fatal("the recovered router left no pid record")
		}
		// The kill skips every shutdown path, so the scene is a power loss mid-session: the
		// record names a router that is gone and the next prompt's hook must bring it back.
		signalPid(record.Pid, "SIGKILL")
		waitUntil(t, 5*time.Second, func() bool { return !process.IsAlive(record.Pid) })
		w.ensureRecovers()
	})
}

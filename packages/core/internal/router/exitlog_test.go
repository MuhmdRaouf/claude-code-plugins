// The exit-log group: every exit a router process can see leaves one line in router.log and the
// logged-exit marker (`<state>/router.exit`, the pid of the process that left the line), and the
// next front start compares the marker with the pid record — a holder that is gone while no
// marker vouches for it died with no line (SIGKILL, the OS, a power loss), and the next start
// names it. The cases run the real front — the state root's own binary in its service entry —
// against temp state roots and free ports, signalling only processes the case started.
package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// exitLogHealth is the health answer's pids, the processes a case ends and watches.
type exitLogHealth struct {
	Pid       int64  `json:"pid"`
	WorkerPid *int64 `json:"workerPid"`
}

// exitLogHealthNow reads the health answer on the port.
func exitLogHealthNow(t *testing.T, port int) exitLogHealth {
	t.Helper()
	answer, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, processAcme.Router.HealthPath))
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		t.Fatal(err)
	}
	var health exitLogHealth
	if err := json.Unmarshal(text, &health); err != nil {
		t.Fatalf("health %q: %v", text, err)
	}
	return health
}

// newExitLogWorld is a temp world whose ensure starts the real front.
func newExitLogWorld(t *testing.T) *powerLossWorld {
	t.Helper()
	w := newPowerLossWorld(t)
	w.seedSetupDone()
	return w
}

// exitLogRecord waits for the starter's pid record: the start child writes it after its first
// health poll, so health can answer before the record exists.
func exitLogRecord(t *testing.T, w *powerLossWorld) PidRecord {
	t.Helper()
	waitUntil(t, 10*time.Second, func() bool {
		_, ok := ReadPidFile(context.Background(), w.state)
		return ok
	})
	record, ok := ReadPidFile(context.Background(), w.state)
	if !ok {
		t.Fatal("no pid record")
	}
	return record
}

// exitLogRouterLog is the router log's current text.
func exitLogRouterLog(t *testing.T, stateRoot string) string {
	t.Helper()
	data, err := os.ReadFile(domain.NewStateLayout(stateRoot).RouterLog)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// exitLogMarkIs asserts the marker names pid.
func exitLogMarkIs(t *testing.T, stateRoot string, pid int64) {
	t.Helper()
	marked, ok := exitMarkPid(stateRoot)
	if !ok || marked != pid {
		t.Fatalf("exit marker = %d (found %v), want pid %d", marked, ok, pid)
	}
}

// exitLogPortFree waits for the port to be bindable again.
func exitLogPortFree(t *testing.T, port int) {
	t.Helper()
	waitUntil(t, 10*time.Second, func() bool {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return false
		}
		_ = listener.Close()
		return true
	})
}

func TestExitLogHandover(t *testing.T) {
	t.Parallel()
	w := newExitLogWorld(t)
	w.ensureRecovers()
	record := exitLogRecord(t, w)
	answered, reached := control(context.Background(), w.port, processAcme.Router.HealthPath,
		record.Token, "handover", []byte("{}"), 2000)
	if !reached || answered.OK == nil || !*answered.OK {
		t.Fatalf("handover = %+v (reached %v)", answered, reached)
	}
	exitLogWaitGone(t, record.Pid)
	if want := "handover: stopped accepting; a new front takes the port"; !strings.Contains(exitLogRouterLog(t, w.state), want) {
		t.Fatalf("router.log has no %q", want)
	}
	exitLogMarkIs(t, w.state, record.Pid)
	w.ensureRecovers()
	if text := exitLogRouterLog(t, w.state); strings.Contains(text, "ended without an exit line") {
		t.Fatalf("the handover exit was named unlogged: %s", text)
	}
}

func TestExitLogRetire(t *testing.T) {
	t.Parallel()
	w := newExitLogWorld(t)
	w.env["ACME_ROUTER_TUNING"] = `{"retiredEveryMs":100,"retiredMaxMs":400}`
	w.ensureRecovers()
	record := exitLogRecord(t, w)
	RetireRouter(context.Background(), RetireOptions{StopOptions: StopOptions{
		Provider: processAcme, Env: w.env, StateRoot: w.state,
	}})
	exitLogWaitGone(t, record.Pid)
	text := exitLogRouterLog(t, w.state)
	if !strings.Contains(text, "retired: the plugin was removed") {
		t.Fatalf("router.log has no retirement line: %s", text)
	}
	if !strings.Contains(text, "; exiting") {
		t.Fatalf("router.log has no retirement exit line: %s", text)
	}
	// The record moved to router.retired at the retirement, so no running record can read a
	// marker: none is left behind.
	if _, ok := exitMarkPid(w.state); ok {
		t.Fatal("the retired exit left a marker beside no running record")
	}
}

func TestExitLogNamesUnloggedDeath(t *testing.T) {
	t.Parallel()
	w := newExitLogWorld(t)
	w.ensureRecovers()
	record := exitLogRecord(t, w)
	if !signalPid(record.Pid, "SIGKILL") {
		t.Fatal("the front was already gone")
	}
	exitLogWaitGone(t, record.Pid)
	w.ensureRecovers()
	want := fmt.Sprintf("router: the previous front %d ended without an exit line (killed by SIGKILL or the OS)", record.Pid)
	waitUntil(t, 5*time.Second, func() bool {
		return strings.Contains(exitLogRouterLog(t, w.state), want)
	})
}

func TestExitOnPanic(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	layout := domain.NewStateLayout(root)
	if err := os.MkdirAll(layout.RouterDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// The running shape: a pid record the marker can be read against.
	if err := WritePidFile(context.Background(), root, PidRecord{
		Pid: int64(os.Getpid()), Port: 1, Token: "t", Mode: PidModeRouter,
	}); err != nil {
		t.Fatal(err)
	}
	log := RotatingLog(layout.RouterLog, nil, 0)
	exited := 0
	crash := InstallCrashHandlers(RoleFront, root, "v", func(code int) { exited = code }, nil)
	func() {
		defer exitOnPanic("front", crash, log, root)()
		panic(errors.New("boom"))
	}()
	if exited != 1 {
		t.Fatalf("crash exit = %d, want 1", exited)
	}
	if text := exitLogRouterLog(t, root); !strings.Contains(text, "front: panic: boom") {
		t.Fatalf("router.log has no panic line: %s", text)
	}
	crashes, err := os.ReadFile(layout.CrashLog)
	if err != nil || !strings.Contains(string(crashes), "uncaught") {
		t.Fatalf("crash log = %q %v, want the uncaught entry", crashes, err)
	}
	exitLogMarkIs(t, root, int64(os.Getpid()))
}

func TestNoteUnloggedDeath(t *testing.T) {
	t.Parallel()
	dead := powerLossDeadPid(t)
	stranger := processSpawnChild(t)
	line := func(lines []string) string { return strings.Join(lines, "\n") }
	t.Run("no pid record: silent, the marker goes", func(t *testing.T) {
		root := t.TempDir()
		writeExitMark(context.Background(), root, dead)
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		if line(lines) != "" {
			t.Fatalf("lines = %q, want none", line(lines))
		}
		if _, ok := exitMarkPid(root); ok {
			t.Fatal("the marker survived a record-less state root")
		}
	})
	t.Run("a live holder: silent", func(t *testing.T) {
		root := t.TempDir()
		if err := WritePidFile(context.Background(), root, PidRecord{
			Pid: int64(stranger.Process.Pid), Port: 1, Token: "t", Mode: PidModeRouter,
		}); err != nil {
			t.Fatal(err)
		}
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		if line(lines) != "" {
			t.Fatalf("lines = %q, want none", line(lines))
		}
	})
	t.Run("a marker that vouches: silent", func(t *testing.T) {
		root := t.TempDir()
		if err := WritePidFile(context.Background(), root, PidRecord{
			Pid: dead, Port: 1, Token: "t", Mode: PidModeRouter,
		}); err != nil {
			t.Fatal(err)
		}
		writeExitMark(context.Background(), root, dead)
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		if line(lines) != "" {
			t.Fatalf("lines = %q, want none", line(lines))
		}
	})
	t.Run("no marker: the front is named", func(t *testing.T) {
		root := t.TempDir()
		if err := WritePidFile(context.Background(), root, PidRecord{
			Pid: dead, Port: 1, Token: "t", Mode: PidModeRouter,
		}); err != nil {
			t.Fatal(err)
		}
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		want := fmt.Sprintf("router: the previous front %d ended without an exit line (killed by SIGKILL or the OS)", dead)
		if line(lines) != want {
			t.Fatalf("lines = %q, want %q", line(lines), want)
		}
	})
	t.Run("a marker naming another front: the record's holder is named", func(t *testing.T) {
		root := t.TempDir()
		if err := WritePidFile(context.Background(), root, PidRecord{
			Pid: dead, Port: 1, Token: "t", Mode: PidModeRouter,
		}); err != nil {
			t.Fatal(err)
		}
		writeExitMark(context.Background(), root, dead+1)
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		want := fmt.Sprintf("router: the previous front %d ended without an exit line (killed by SIGKILL or the OS)", dead)
		if line(lines) != want {
			t.Fatalf("lines = %q, want %q", line(lines), want)
		}
	})
	t.Run("an emergency record: the passthrough is named", func(t *testing.T) {
		root := t.TempDir()
		if err := WritePidFile(context.Background(), root, PidRecord{
			Pid: dead, Port: 1, Token: "t", Mode: PidModeEmergency,
		}); err != nil {
			t.Fatal(err)
		}
		var lines []string
		noteUnloggedDeath(context.Background(), root, func(said string) { lines = append(lines, said) })
		want := fmt.Sprintf("router: the previous emergency passthrough %d ended without an exit line (killed by SIGKILL or the OS)", dead)
		if line(lines) != want {
			t.Fatalf("lines = %q, want %q", line(lines), want)
		}
	})
}

// ── the group's service child ────────────────────────────────────────────────────────────────────────────────────────

const (
	// exitLogChildEnv turns this binary into the exit-log group's child; the names carry the
	// provider prefix so the start path's spawns keep them through ChildEnv's filter.
	exitLogChildEnv   = "ACME_EXITLOG_CHILD"
	exitLogChildMode  = "exitlog-service"
	exitLogChildState = "ACME_EXITLOG_STATE"
)

// runExitLogChild is the group's child: argv `<bin> acme exitlog-starter` runs the real start
// path (StartRouter, the production detached spawn) and stays put, so a kill of the starter's
// whole process group ends only the starter while the router it started must live on; every
// other argv is the real router service (the front, the worker, the emergency), the shapes the
// start path's own spawns produce.
func runExitLogChild() {
	fail := func(what string) {
		fmt.Fprintln(os.Stderr, what)
		os.Exit(3)
	}
	starter := len(os.Args) == 3 && os.Args[1] == processAcme.Name && os.Args[2] == "exitlog-starter"
	service := len(os.Args) >= 4 && os.Args[1] == processAcme.Name && os.Args[2] == "router"
	passthrough := len(os.Args) == 3 && os.Args[1] == processAcme.Name && os.Args[2] == "passthrough"
	if !starter && !service && !passthrough {
		fail(fmt.Sprintf("exit-log child argv = %v", os.Args))
	}
	env := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	stateRoot := os.Getenv(exitLogChildState)
	self, err := os.Executable()
	if err != nil {
		fail("no executable: " + err.Error())
	}
	if starter {
		if _, err := StartRouter(context.Background(), StartOptions{
			Provider: processAcme, Env: env, StateRoot: stateRoot, Source: self, Node: self,
		}); err != nil {
			fail("exit-log start: " + err.Error())
		}
		for {
			time.Sleep(time.Hour)
		}
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
			fail("exit-log passthrough: " + err.Error())
		}
		os.Exit(0)
	}
	os.Exit(RouterService(RouterServiceOptions{
		Provider:  processAcme,
		StateRoot: stateRoot,
		Script:    self,
		Env:       env,
		Argv:      os.Args[3:],
	}))
}

// exitLogWaitGone waits for a process the case ended to be gone, reaping included.
func exitLogWaitGone(t *testing.T, pid int64) {
	t.Helper()
	waitUntil(t, 10*time.Second, func() bool { return !process.IsAlive(pid) })
}

func TestExitLogSignals(t *testing.T) {
	t.Parallel()
	send := map[string]func(int64){
		"SIGTERM": func(pid int64) {
			if !signalPid(pid, "SIGTERM") {
				t.Fatal("SIGTERM found no process")
			}
		},
		"SIGINT": func(pid int64) {
			if err := syscall.Kill(int(pid), syscall.SIGINT); err != nil {
				t.Fatal(err)
			}
		},
		"SIGHUP": func(pid int64) {
			if err := syscall.Kill(int(pid), syscall.SIGHUP); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name := range send {
		t.Run(name+": one line, then the workers ended and the port released", func(t *testing.T) {
			w := newExitLogWorld(t)
			w.ensureRecovers()
			record := exitLogRecord(t, w)
			health := exitLogHealthNow(t, w.port)
			if health.WorkerPid == nil {
				t.Fatal("health named no worker")
			}
			send[name](record.Pid)
			exitLogWaitGone(t, record.Pid)
			exitLogWaitGone(t, *health.WorkerPid)
			exitLogPortFree(t, w.port)
			if want := "front: exiting on " + name; !strings.Contains(exitLogRouterLog(t, w.state), want) {
				t.Fatalf("router.log has no %q: %s", want, exitLogRouterLog(t, w.state))
			}
			exitLogMarkIs(t, w.state, record.Pid)
			// A logged exit is never named an unlogged death by the next start.
			w.ensureRecovers()
			if text := exitLogRouterLog(t, w.state); strings.Contains(text, "ended without an exit line") {
				t.Fatalf("a logged exit was named unlogged: %s", text)
			}
		})
	}
}

// TestExitLogStopDuringStart proves a stop that lands while the front is still coming up is
// honoured through the normal shutdown: the exit line, the marker, the port released and the
// process gone — never swallowed by a signal registration that precedes the start.
func TestExitLogStopDuringStart(t *testing.T) {
	t.Parallel()
	w := newPowerLossWorld(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	files, err := CopyRouterFiles(context.Background(), self, w.state)
	if err != nil {
		t.Fatal(err)
	}
	childEnv := make(map[string]string, len(w.env)+3)
	for name, value := range w.env {
		childEnv[name] = value
	}
	delete(childEnv, powerLossChildEnv)
	delete(childEnv, powerLossChildState)
	childEnv[exitLogChildEnv] = exitLogChildMode
	childEnv[exitLogChildState] = w.state
	// The start holds open for 3 s after the signals are registered; the stop lands inside it.
	childEnv[processAcme.EnvPrefix+"_ROUTER_TUNING"] = `{"startDelayMs":3000}`
	child := process.StartDetached(files.Binary, []string{processAcme.Name, "router", "run"},
		process.DetachedOptions{
			Env:     environOf(childEnv),
			LogFile: domain.NewStateLayout(w.state).RouterLog,
		})
	if child.Pid == 0 {
		t.Fatal("the front never started")
	}
	t.Cleanup(func() { child.Kill() })
	// The marker is read against a pid record; the starter writes one once health answers, and
	// this stop lands before any health answer, so the record is the test's to seed.
	if err := WritePidFile(context.Background(), w.state, PidRecord{
		Pid: child.Pid, Port: int64(w.port), Token: "t", Mode: PidModeRouter,
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	if !signalPid(child.Pid, "SIGTERM") {
		t.Fatal("the front was already gone before the stop")
	}
	// The test process itself spawned this front, so its exit needs reaping to be seen.
	waitUntil(t, 10*time.Second, func() bool { return child.Exited() })
	exitLogPortFree(t, w.port)
	if want := "front: exiting on SIGTERM"; !strings.Contains(exitLogRouterLog(t, w.state), want) {
		t.Fatalf("router.log has no %q: %s", want, exitLogRouterLog(t, w.state))
	}
	exitLogMarkIs(t, w.state, child.Pid)
}

// TestExitLogDetachedFront proves the start path's router outlives its starter: the starter runs
// in a child process group, the whole group is killed, and the front — its own session since the
// spawn — still answers health with parent pid 1.
func TestExitLogDetachedFront(t *testing.T) {
	t.Parallel()
	w := newPowerLossWorld(t)
	childEnv := make(map[string]string, len(w.env)+2)
	for name, value := range w.env {
		childEnv[name] = value
	}
	// This group's child mode, not the power-loss one the world's env carries: the starter is
	// this test's own shape, and the router it starts re-enters this mode through the env below.
	delete(childEnv, powerLossChildEnv)
	delete(childEnv, powerLossChildState)
	childEnv[exitLogChildEnv] = exitLogChildMode
	childEnv[exitLogChildState] = w.state
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(self, processAcme.Name, "exitlog-starter")
	child.Env = environOf(childEnv)
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	started := filepath.Join(w.root, "starter.log")
	startLog, err := os.OpenFile(started, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	child.Stdout, child.Stderr = startLog, startLog
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	starter := int64(child.Process.Pid)
	waited := make(chan error, 1)
	t.Cleanup(func() {
		_ = syscall.Kill(-int(starter), syscall.SIGKILL)
		_ = syscall.Kill(int(starter), syscall.SIGKILL)
		select {
		case <-waited:
		default:
			_ = child.Wait()
		}
	})
	// Health ours, the pid record written and the start lock released: the starter's work is done.
	up := func() bool {
		if ProbeRouter(context.Background(), w.port, processAcme, 200).State != ProbeOurs {
			return false
		}
		if _, ok := ReadPidFile(context.Background(), w.state); !ok {
			return false
		}
		_, err := os.Stat(filepath.Join(w.state, "router.lock"))
		return err != nil
	}
	if !up() {
		deadline := time.Now().Add(30 * time.Second)
		for !up() {
			if time.Now().After(deadline) {
				trace, _ := os.ReadFile(started)
				t.Fatalf("the starter never brought the router up (starter log: %q)", trace)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	record, ok := ReadPidFile(context.Background(), w.state)
	if !ok {
		t.Fatal("no pid record")
	}
	// The whole starter group dies; the front is in its own session and must not feel it.
	if err := syscall.Kill(-int(starter), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waited <- child.Wait()
	exitLogWaitGone(t, starter)
	for probe := 0; probe < 3; probe++ {
		if ProbeRouter(context.Background(), w.port, processAcme, 200).State != ProbeOurs {
			t.Fatalf("probe %d after the group kill: the router did not survive its starter", probe)
		}
		time.Sleep(200 * time.Millisecond)
	}
	waitUntil(t, 10*time.Second, func() bool {
		parent, ok := parentPidOf(context.Background(), record.Pid)
		return ok && parent == 1
	})
}

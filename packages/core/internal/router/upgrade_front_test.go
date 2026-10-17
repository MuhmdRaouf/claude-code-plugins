// The upgrade group: a machine that still runs the released 0.0.1 plugin has its bundled front on
// the port (front protocol 2, the bun runtime) and the pid record that build's starter wrote. The
// Go start must take the port from that front without a gap that fails Claude requests, and never
// leave two fronts or none. Every case runs a real front child of protocol 2 — this binary in the
// installed build's shape: the argv its starter spawns (`<state>/router/<name>-router.js run`),
// the health body, the token-checked control endpoints, the pid record and the handover behaviour
// its bundle serves — then the real start paths against it, with a client asking the port for one
// answer every 50 ms throughout.
package router

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The protocol-2 front child's mode and configuration. The names carry the provider prefix so
// they survive the start path's ChildEnv filter; only the stub's own spawn sets them, so a front
// the start path spawns never lands in the mode by inheritance.
const (
	installedFrontChildEnv  = "ACME_TEST_INSTALLED_FRONT"
	installedFrontChildMode = "installed-front"
	installedFrontPortEnv   = "ACME_TEST_INSTALLED_FRONT_PORT"
	installedFrontStateEnv  = "ACME_TEST_INSTALLED_FRONT_STATE"
	installedFrontTokenEnv  = "ACME_TEST_INSTALLED_FRONT_TOKEN"
	installedFrontHungEnv   = "ACME_TEST_INSTALLED_FRONT_HUNG"
)

// installedFrontVersion is the installed build's bundle version, as its starter records it.
const installedFrontVersion = "0.0.1-bundled"

// installedFrontToken is the token the scene's pid record names.
const installedFrontToken = "protocol-2-token"

// runInstalledFrontChild is the protocol-2 front the installed build runs: it binds the port,
// writes the pid record its starter leaves (front protocol 2, its own runtime as the node), and
// answers the health body and the control endpoints the way that build's front does. Its
// handover answers first, leaves one line in the router log, stops accepting and ends once its
// sockets have drained; its hung mode accepts connections and never answers.
//
// What it mirrors, from the installed 0.0.1 bundle (dist/zai-router.js): the bundle front's
// health answer and control surface (health, control, handoverNow and drain — the token check,
// the loopback check, the connection-close on the handover answer), and its starter's pid record
// (pidRecord's fields and their order, written once the front answers health).
func runInstalledFrontChild() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	// The argv is the installed build's spawn shape: its runtime (this binary standing in for it)
	// with the copied bundle and `run` — the command line every ours-check reads.
	if len(os.Args) != 3 || filepath.Base(os.Args[1]) != processAcme.Name+"-router.js" || os.Args[2] != "run" {
		fail(fmt.Sprintf("installed front child argv = %v", os.Args))
	}
	port, err := strconv.Atoi(os.Getenv(installedFrontPortEnv))
	if err != nil || port <= 0 {
		fail("installed front child: no port")
	}
	state := os.Getenv(installedFrontStateEnv)
	token := os.Getenv(installedFrontTokenEnv)
	// No child of the group outlives a failed case.
	time.AfterFunc(2*time.Minute, func() { os.Exit(0) })
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		fail("installed front child: " + err.Error())
	}
	// The record the installed build's starter wrote once its front answered health.
	if err := writePidRecord(context.Background(), domain.NewStateLayout(state).RouterPid, PidRecord{
		Pid: int64(os.Getpid()), Port: int64(port), StartedAt: isoNow(), Node: os.Args[0],
		Version: installedFrontVersion, FrontVersion: 2, Mode: PidModeRouter, Token: token,
	}); err != nil {
		fail("installed front child: " + err.Error())
	}
	if os.Getenv(installedFrontHungEnv) == "1" {
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
	installedFrontServe(listener, state, token)
}

// installedFrontServe is the installed build's front: its health answer, its control surface, and
// its handover — answer, one log line, stop accepting, end once the sockets drained.
func installedFrontServe(listener net.Listener, state, token string) {
	log := RotatingLog(domain.NewStateLayout(state).RouterLog, nil, 0)
	var accepting atomic.Bool
	accepting.Store(true)
	var retired atomic.Bool
	exit := sync.OnceFunc(func() { os.Exit(0) })
	connections := TrackConnections(func(open int) {
		// The tracker runs this under its lock: the exit goes off its path.
		if !accepting.Load() && open == 0 {
			go exit()
		}
	})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.Copy(io.Discard, req.Body)
		path := req.URL.Path
		switch {
		case req.Method == http.MethodGet && path == processHealthPath:
			mode := "router"
			if retired.Load() {
				mode = "retired"
			}
			// The installed build's health body, its key order included.
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ok":true,"name":%q,"provider":%q,"mode":%q,"worker":"up","version":%q,"frontVersion":2,"pid":%d}`,
				processAcme.Name, processAcme.Display, mode, installedFrontVersion, os.Getpid())
		case strings.HasPrefix(path, processHealthPath+"/"):
			installedFrontControl(w, req, token, &retired, func() {
				log("handover: stopped accepting; a new front takes the port")
				accepting.Store(false)
				_ = listener.Close()
				connections.Drain()
				if connections.Size() == 0 {
					go exit()
				}
			})
		default:
			// The data path: the cases count connects, not bodies; this front answers itself.
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"front":2}`))
		}
	})}
	connections.Watch(server)
	_ = server.Serve(listener)
	// The listener is gone (a handover): end once the answers still going out are done.
	accepting.Store(false)
	connections.Drain()
	if connections.Size() == 0 {
		exit()
	}
	deadline := time.Now().Add(10 * time.Second)
	for connections.Size() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
}

// installedFrontControl is the installed build's control surface: loopback and the pid record's
// token only, and the actions that build serves (reload, handover, retire, adopt and key, each
// answered as that build answers it).
func installedFrontControl(w http.ResponseWriter, req *http.Request, token string, retired *atomic.Bool, handover func()) {
	if !loopbackRequest(req) || req.Header.Get(TokenHeader) != token {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprintf(w, `{"type":"error","error":{"type":"permission_error","message":%q}}`,
			processAcme.Name+" router: control refused")
		return
	}
	action := strings.TrimPrefix(req.URL.Path, processHealthPath+"/")
	switch fmt.Sprintf("%s %s", req.Method, action) {
	case "POST handover":
		w.Header().Set("Connection", "close")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
		handover()
	case "POST retire":
		already := retired.Swap(true)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"already":%t,"retiredAt":%q}`, already, isoNow())
	case "POST adopt", "POST reload":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	case "GET key":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"error":"` + NoWorker + `"}`))
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `{"type":"error","error":{"type":"not_found_error","message":%q}}`,
			processAcme.Name+" router: unknown control call")
	}
}

// upgradeWorld is one upgrade scene: a temp state root the installed build would have left (its
// copied bundle under router/, its setup marks) and the environment every child runs with.
type upgradeWorld struct {
	t     *testing.T
	root  string
	state string
	port  int
	env   domain.EnvLookup

	mu       sync.Mutex
	children []process.Detached
}

func newUpgradeWorld(t *testing.T) *upgradeWorld {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.MkdirAll(filepath.Join(state, "router"), 0o700); err != nil {
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
		// Both upstreams point at a loopback port nothing listens on: nothing the chain forwards
		// can leave the machine, and an answer through the new front is the closed upstream's
		// 502 — still an answer.
		"ACME_ROUTER_ANTHROPIC_URL": closedUpstream,
		"ACME_ROUTER_URL":           closedUpstream,
		"ACME_API_KEY":              "test-key",
		// The fronts the start paths spawn re-enter this binary's service child mode.
		powerLossChildEnv:   powerLossChildMode,
		powerLossChildState: state,
	}
	world := &upgradeWorld{t: t, root: root, state: state, port: port, env: env}
	t.Cleanup(world.stop)
	return world
}

// seedRouterScript leaves the copied bundle the installed build's starter put under router/.
func (w *upgradeWorld) seedRouterScript() {
	w.t.Helper()
	script := filepath.Join(w.state, "router", processAcme.Name+"-router.js")
	if err := os.WriteFile(script, []byte("#!/usr/bin/env bun\n// the installed build's copied bundle\n"), 0o755); err != nil {
		w.t.Fatal(err)
	}
}

// seedSetupDone leaves the mark the hooks act on.
func (w *upgradeWorld) seedSetupDone() {
	w.t.Helper()
	if err := os.WriteFile(filepath.Join(w.state, "setup-done"), []byte("true\n"), 0o600); err != nil {
		w.t.Fatal(err)
	}
}

// startStub starts the protocol-2 front the way its build's starter did: the runtime (this binary
// standing in for it) with the copied bundle and `run`, its output in the router log.
func (w *upgradeWorld) startStub(hung bool) process.Detached {
	w.t.Helper()
	self, err := os.Executable()
	if err != nil {
		w.t.Fatal(err)
	}
	argv := []string{filepath.Join(w.state, "router", processAcme.Name+"-router.js"), "run"}
	extra := []string{
		installedFrontChildEnv + "=" + installedFrontChildMode,
		installedFrontPortEnv + "=" + strconv.Itoa(w.port),
		installedFrontStateEnv + "=" + w.state,
		installedFrontTokenEnv + "=" + installedFrontToken,
	}
	if hung {
		extra = append(extra, installedFrontHungEnv+"=1")
	}
	detached := process.StartDetached(self, argv, process.DetachedOptions{
		Env: append(environOf(w.env), extra...), LogFile: domain.NewStateLayout(w.state).RouterLog,
	})
	if detached.Pid == 0 {
		w.t.Fatal("the protocol-2 front never started")
	}
	w.track(detached)
	return detached
}

// track records a process this world started for the cleanup's kill-and-wait.
func (w *upgradeWorld) track(child process.Detached) {
	w.mu.Lock()
	w.children = append(w.children, child)
	w.mu.Unlock()
}

// stop ends what this world started: any front still answering on the port first (it may be one a
// start child spawned, not one this world tracked), then every tracked child, killed and waited,
// so no process the group started outlives a failed case.
func (w *upgradeWorld) stop() {
	if probe := ProbeRouter(context.Background(), w.port, processAcme, 200); probe.State == ProbeOurs && probe.Health.Pid != nil {
		signalPid(*probe.Health.Pid, "SIGTERM")
	}
	w.mu.Lock()
	children := append([]process.Detached(nil), w.children...)
	w.mu.Unlock()
	for _, child := range children {
		child.Kill()
	}
	waitUntil(w.t, 10*time.Second, func() bool {
		for _, child := range children {
			if child.Pid != 0 && !child.Exited() {
				return false
			}
		}
		return true
	})
}

// sessionStart is the SessionStart path's start: the wiring the hook runs, with its 4 s budget
// and the state root's copied binary as the source.
func (w *upgradeWorld) sessionStart() (string, error) {
	self, err := os.Executable()
	if err != nil {
		w.t.Fatal(err)
	}
	return StartRouter(context.Background(), StartOptions{
		Provider:  processAcme,
		Env:       w.env,
		StateRoot: w.state,
		Source:    self,
		BudgetMs:  4000,
		Spawn:     w.spawnFront,
	})
}

// spawnFront is the start's spawn: the copied binary in the service child mode (the environment
// the start path builds already carries it), its output in the router log.
func (w *upgradeWorld) spawnFront(binary string, args []string, env map[string]string, logFile string) DetachedChild {
	detached := process.StartDetached(binary, args, process.DetachedOptions{Env: environOf(env), LogFile: logFile})
	w.track(detached)
	return detachedChild{inner: detached}
}

// ensureHook is the UserPromptSubmit path's check, its start child recorded for the cleanup.
func (w *upgradeWorld) ensureHook() EnsureStatus {
	return EnsureRouter(context.Background(), EnsureOptions{
		Name:         processAcme.Name,
		EnvPrefix:    processAcme.EnvPrefix,
		Display:      processAcme.Display,
		HealthPath:   processAcme.Router.HealthPath,
		DefaultPort:  processAcme.Router.Port,
		Env:          w.env,
		RouterScript: processAcme.Name + "-router.js",
		Start: func(node string, _ []string, childEnv domain.EnvLookup) {
			detached := process.StartDetached(node, []string{processAcme.Name, "router", "start"},
				process.DetachedOptions{Env: environOf(childEnv), LogFile: filepath.Join(w.root, "start.log")})
			w.track(detached)
		},
	})
}

// waitStubUp waits for the protocol-2 front's health: ours, protocol 2, its own pid.
func (w *upgradeWorld) waitStubUp(stub process.Detached) RouterHealth {
	w.t.Helper()
	return w.waitHealth(func(health RouterHealth) bool {
		return health.FrontVersion != nil && *health.FrontVersion == 2 &&
			health.Pid != nil && *health.Pid == stub.Pid
	})
}

// waitGoFrontUp waits for the Go front's health: ours, this protocol, serving as the router.
func (w *upgradeWorld) waitGoFrontUp() RouterHealth {
	w.t.Helper()
	return w.waitHealth(func(health RouterHealth) bool {
		return health.FrontVersion != nil && *health.FrontVersion == FrontVersion &&
			(health.Mode == nil || *health.Mode == "router")
	})
}

func (w *upgradeWorld) waitHealth(want func(RouterHealth) bool) RouterHealth {
	w.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe := ProbeRouter(context.Background(), w.port, processAcme, 200)
		if probe.State == ProbeOurs && want(probe.Health) {
			return probe.Health
		}
		if time.Now().After(deadline) {
			w.t.Fatalf("the front on port %d never answered the wanted health (last probe %s)", w.port, probe.State)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// awaitStubGone waits for the protocol-2 front's own end: a handover ends it once it drained.
func (w *upgradeWorld) awaitStubGone(stub process.Detached) {
	w.t.Helper()
	waitUntil(w.t, 10*time.Second, func() bool { return stub.Exited() })
}

// recordNow is the pid record as it stands.
func (w *upgradeWorld) recordNow() PidRecord {
	w.t.Helper()
	record, ok := ReadPidFile(context.Background(), w.state)
	if !ok {
		w.t.Fatalf("no pid record in %s", w.state)
	}
	return record
}

// assertHandoverLine checks the one line the replaced front leaves in the router log.
func (w *upgradeWorld) assertHandoverLine() {
	w.t.Helper()
	data, err := os.ReadFile(domain.NewStateLayout(w.state).RouterLog)
	if err != nil || !strings.Contains(string(data), "handover: stopped accepting; a new front takes the port") {
		w.t.Fatalf("router.log = %q %v, want the replaced front's handover line", data, err)
	}
}

// upgradeProbeMs is how often the client asks the port for one answer — the retry window the
// cases state: one probe interval is the most a handover may cost, and a hung front's replacement
// window is counted in these probes.
const upgradeProbeMs = 50

// upgradeHungWindowProbes is the stated replacement window for a hung front: it cannot hand the
// port over (it never answers), so the port is taken from it — refused connects may last the
// fresh start's span, which sits well under the start's own budget.
const upgradeHungWindowProbes = 40

// upgradeClient asks the port for one answer every upgradeProbeMs until it is stopped. What it
// counts is the only thing an upgrade may never cost Claude: connects nothing accepted — refused
// probes in a row. Timeouts and error statuses are answers of a working router (a stubbed front,
// a front waiting for its worker, a closed upstream's 502).
type upgradeClient struct {
	stop   chan struct{}
	done   chan struct{}
	client *http.Client

	mu      sync.Mutex
	refused int
}

func startUpgradeClient(port int) *upgradeClient {
	probes := &upgradeClient{
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
		client: &http.Client{Timeout: 750 * time.Millisecond, Transport: &http.Transport{DisableKeepAlives: true}},
	}
	go func() {
		defer close(probes.done)
		ticker := time.NewTicker(upgradeProbeMs * time.Millisecond)
		defer ticker.Stop()
		streak := 0
		for {
			select {
			case <-probes.stop:
				return
			case <-ticker.C:
			}
			if probes.ask(port) {
				streak = 0
				continue
			}
			streak++
			probes.mu.Lock()
			if streak > probes.refused {
				probes.refused = streak
			}
			probes.mu.Unlock()
		}
	}()
	return probes
}

// ask is one probe: false only when nothing accepted the connect.
func (c *upgradeClient) ask(port int) bool {
	request, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/messages", port),
		strings.NewReader(`{"model":"claude-sonnet-5-5","messages":[]}`))
	if err != nil {
		return true
	}
	answer, err := c.client.Do(request)
	if err != nil {
		text := err.Error()
		return !(strings.Contains(text, "connection refused") || strings.Contains(text, "ECONNREFUSED"))
	}
	_, _ = io.Copy(io.Discard, answer.Body)
	_ = answer.Body.Close()
	return true
}

// finish stops the probes and reports the longest run of refused connects.
func (c *upgradeClient) finish() int {
	close(c.stop)
	<-c.done
	c.client.CloseIdleConnections()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.refused
}

func TestUpgradeFromOldFront(t *testing.T) {
	t.Parallel()
	t.Run("setup replaces a healthy protocol-2 front without a refused connect", func(t *testing.T) {
		w := newUpgradeWorld(t)
		w.seedRouterScript()
		stub := w.startStub(false)
		w.waitStubUp(stub)
		client := startUpgradeClient(w.port)
		line, err := w.sessionStart()
		if err != nil {
			t.Fatalf("the session start failed: %v (%s)", err, line)
		}
		if !strings.Contains(line, "replaced an older front") {
			t.Fatalf("line = %q, want the handover onto the Go front", line)
		}
		health := w.waitGoFrontUp()
		w.awaitStubGone(stub)
		refused := client.finish()
		t.Logf("the handover cost %d refused probes (window %d ms)", refused, upgradeProbeMs)
		if refused > 1 {
			t.Fatalf("the client saw %d refused probes in a row, want at most the one %d ms retry window",
				refused, upgradeProbeMs)
		}
		record := w.recordNow()
		if record.Pid != *health.Pid || record.FrontVersion != FrontVersion || record.Mode != PidModeRouter {
			t.Fatalf("record = %+v, want the Go front (pid %d, protocol %d)", record, *health.Pid, FrontVersion)
		}
		w.assertHandoverLine()
	})

	t.Run("setup replaces a hung protocol-2 front inside its budget", func(t *testing.T) {
		w := newUpgradeWorld(t)
		w.seedRouterScript()
		stub := w.startStub(true)
		// The front accepts connects and never answers health.
		waitUntil(t, 5*time.Second, func() bool {
			return process.PortAnswers(context.Background(), w.port, 200)
		})
		client := startUpgradeClient(w.port)
		began := time.Now()
		line, err := w.sessionStart()
		if err != nil {
			t.Fatalf("the session start failed: %v (%s)", err, line)
		}
		if took := time.Since(began); took > 4*time.Second {
			t.Fatalf("the start took %s, want it inside the hook's 4 s budget", took)
		}
		w.waitGoFrontUp()
		w.awaitStubGone(stub)
		refused := client.finish()
		t.Logf("replacing the hung front cost %d refused probes (window %d ms)",
			refused, upgradeHungWindowProbes*upgradeProbeMs)
		// The detector is only trusted once it has seen the window it exists to count: the port
		// is nobody's between the kill and the fresh front's bind; the replacement itself is
		// asserted below.
		if refused < 1 {
			t.Fatal("the client never saw the port closed between the killed front and the fresh one")
		}
		if refused > upgradeHungWindowProbes {
			t.Fatalf("the client saw %d refused probes in a row, want at most the %d-probe replacement window",
				refused, upgradeHungWindowProbes)
		}
		record := w.recordNow()
		if record.FrontVersion != FrontVersion || record.Mode != PidModeRouter {
			t.Fatalf("record = %+v, want the Go front (protocol %d)", record, FrontVersion)
		}
	})

	t.Run("ensure leaves a healthy protocol-2 front alone; the next setup replaces it", func(t *testing.T) {
		w := newUpgradeWorld(t)
		w.seedRouterScript()
		w.seedSetupDone()
		stub := w.startStub(false)
		w.waitStubUp(stub)
		if status := w.ensureHook(); status != EnsureUp {
			t.Fatalf("ensure = %q, want up", status)
		}
		// No surprise replacement mid-session: the same front still answers, the record still
		// names it, and nothing was started — no copied binary, no second front.
		w.waitStubUp(stub)
		if stub.Exited() {
			t.Fatal("ensure ended the protocol-2 front")
		}
		if record := w.recordNow(); record.Pid != stub.Pid || record.FrontVersion != 2 {
			t.Fatalf("record = %+v, want the protocol-2 front untouched", record)
		}
		if _, err := os.Stat(filepath.Join(w.state, "router", routerBinaryName)); err == nil {
			t.Fatal("ensure copied a binary into the state root, want it to have started nothing")
		}
		line, err := w.sessionStart()
		if err != nil || !strings.Contains(line, "replaced an older front") {
			t.Fatalf("line = %q %v, want the handover onto the Go front", line, err)
		}
		w.waitGoFrontUp()
		w.awaitStubGone(stub)
		if record := w.recordNow(); record.FrontVersion != FrontVersion {
			t.Fatalf("record = %+v, want the Go front (protocol %d)", record, FrontVersion)
		}
		w.assertHandoverLine()
	})
}

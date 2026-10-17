// The router starter's cases. The starter copies this binary (always named plugin-core, mode
// 0755), so a plugin update or uninstall never deletes the running router's code. The
// spawns are `<state>/router/plugin-core <name> router run` and `<state>/router/plugin-core
// <name> passthrough`.
package router

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// processAcme is the suite's stand-in provider (its name matches no real plugin).
var processAcme = domain.DefineProvider(domain.ProviderSpec{
	Name:         "acme",
	Display:      "Acme Models",
	Slash:        "/acme:",
	AgentPrefix:  "acme:",
	BranchPrefix: "acme-jobs/",
	Harness:      "acme-harness",
	ArtifactsEnv: "ACME_OUT",
	EnvPrefix:    "ACME",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "big-model-9", Label: "Big Model 9"},
		domain.ModelTierFlash: {Tier: domain.ModelTierFlash, ID: "small-model-9", Label: "Small Model 9"},
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "big", domain.ModelTierFlash: "quick"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierMain,
	WorkerLabel: "acmebot",
	BaseURL:     "https://api.acme.test/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"ACME_API_KEY"},
	KeyFile:     "~/.config/acme/env",
	BillingURL:  "https://billing.example.test/top-up",
	KeysURL:     "https://keys.example.test/api-keys",
	Strip:       []string{"trace"},
	Caveats:     []string{"acme ignores the trace field"},
	Router: domain.ProviderRouter{
		Port:          18800,
		Label:         "test.acme-router",
		HealthPath:    "/acme-router/health",
		ModelPrefixes: []string{"big-", "small-"},
	},
})

const processHealthPath = "/acme-router/health"

// processHoldServer holds a port the way something on this machine would; the cleanup ends even
// its hung handlers.
type processHoldServer struct {
	server      *http.Server
	connections *Connections
}

func processHold(t *testing.T, port int, handler http.HandlerFunc) *processHoldServer {
	t.Helper()
	server := &http.Server{Handler: handler}
	connections := TrackConnections(func(int) {})
	connections.Watch(server)
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("hold %d: %v", port, err)
	}
	go func() { _ = server.Serve(listener) }()
	held := &processHoldServer{server: server, connections: connections}
	t.Cleanup(held.close)
	return held
}

func (h *processHoldServer) close() {
	h.connections.CloseAll()
	_ = h.server.Close()
}

// hungHandler never answers; only the connections' close ends it.
func hungHandler() (http.HandlerFunc, func()) {
	done := make(chan struct{})
	return func(w http.ResponseWriter, req *http.Request) {
		<-done
	}, func() { close(done) }
}

// ── the fake spawner ─────────────────────────────────────────────────────────────────────────────────────────────────

// processSpawnHow is what a spawned "router" does: listen, die at once, or never come up.
type processSpawnHow string

const (
	spawnOK     processSpawnHow = "ok"
	spawnDies   processSpawnHow = "dies"
	spawnSilent processSpawnHow = "silent"
)

// processControlCall is one control call the fake router received.
type processControlCall struct {
	action string
	body   string
}

// processFakeRouter is one "router" the fake spawner started: an in-process server answering
// health like a real one.
type processFakeRouter struct {
	pid    int64
	binary string
	args   []string
	env    map[string]string
	how    processSpawnHow

	mu       sync.Mutex
	mode     string
	version  string
	controls []processControlCall
	servers  []*processHoldServer
	killed   bool
}

func (f *processFakeRouter) healthBody() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fmt.Sprintf(`{"ok":true,"name":"acme","provider":"Acme Models","mode":%q,"version":%q,"frontVersion":%d,"pid":%d}`,
		f.mode, f.version, FrontVersion, f.pid)
}

func (f *processFakeRouter) recordControl(call processControlCall) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.controls = append(f.controls, call)
}

func (f *processFakeRouter) controlCalls() []processControlCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]processControlCall(nil), f.controls...)
}

func (f *processFakeRouter) setMode(mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode = mode
}

func (f *processFakeRouter) addServer(held *processHoldServer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.servers = append(f.servers, held)
}

func (f *processFakeRouter) closeServers() {
	f.mu.Lock()
	servers := f.servers
	f.servers = nil
	f.mu.Unlock()
	for _, held := range servers {
		held.close()
	}
}

// processFakeChild is the DetachedChild of a fake router: it "exits" when its behaviour says so
// or when it is killed.
type processFakeChild struct {
	fake *processFakeRouter
}

func (c processFakeChild) Pid() int64 { return c.fake.pid }

func (c processFakeChild) Exited() bool {
	c.fake.mu.Lock()
	defer c.fake.mu.Unlock()
	return c.fake.how == spawnDies || c.fake.killed
}

func (c processFakeChild) Kill() {
	c.fake.mu.Lock()
	c.fake.killed = true
	c.fake.mu.Unlock()
	c.fake.closeServers()
}

var processNextPid atomic.Int64

func init() { processNextPid.Store(900000) }

// processFakeSpawner runs no process: each "router" is an in-process server answering health like
// a real one.
type processFakeSpawner struct {
	t            *testing.T
	routerHow    processSpawnHow
	emergencyHow processSpawnHow
	version      string

	mu      sync.Mutex
	started []*processFakeRouter
}

func newProcessFakeSpawner(t *testing.T, routerHow, emergencyHow processSpawnHow, version string) *processFakeSpawner {
	return &processFakeSpawner{t: t, routerHow: routerHow, emergencyHow: emergencyHow, version: version}
}

func (s *processFakeSpawner) spawn(binary string, args []string, env map[string]string, logFile string) DetachedChild {
	emergency := len(args) > 1 && args[1] == "passthrough"
	how := s.routerHow
	mode := "router"
	if emergency {
		how = s.emergencyHow
		mode = "emergency"
	}
	fake := &processFakeRouter{
		pid:     processNextPid.Add(1),
		binary:  binary,
		args:    args,
		env:     env,
		how:     how,
		mode:    mode,
		version: s.version,
	}
	if s.version == "" {
		fake.version = "v-new"
	}
	s.mu.Lock()
	s.started = append(s.started, fake)
	s.mu.Unlock()
	if how == spawnOK {
		go s.listenAs(fake)
	}
	return processFakeChild{fake: fake}
}

func (s *processFakeSpawner) startedRouters() []*processFakeRouter {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*processFakeRouter(nil), s.started...)
}

// listenAs is the fake router's server: health, the control endpoints with the token, adopt
// binding the canonical port, handover closing the server.
func (s *processFakeSpawner) listenAs(fake *processFakeRouter) {
	port := envPortOf(fake.env, "ACME_ROUTER_LISTEN_PORT", "ACME_ROUTER_PORT")
	var handler http.HandlerFunc
	handler = func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		if req.URL.Path == processHealthPath {
			_, _ = w.Write([]byte(fake.healthBody()))
			return
		}
		action := strings.TrimPrefix(req.URL.Path, processHealthPath+"/")
		fake.recordControl(processControlCall{action: action, body: string(body)})
		if req.Header.Get(TokenHeader) != fake.env["ACME_ROUTER_TOKEN"] {
			w.WriteHeader(403)
			_, _ = w.Write([]byte("{}"))
			return
		}
		if action == "adopt" {
			ok := s.adoptPort(fake, handler)
			_, _ = w.Write([]byte(`{"ok":` + strconv.FormatBool(ok) + `}`))
			return
		}
		if action == "retire" {
			fake.setMode("retired")
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
		if action == "handover" {
			go fake.closeServers()
		}
	}
	held := processHold(s.t, port, handler)
	fake.addServer(held)
}

// adoptPort is the new front's half of a handover: bind the canonical port, retrying while the
// old one still holds it.
func (s *processFakeSpawner) adoptPort(fake *processFakeRouter, handler http.HandlerFunc) bool {
	canonical := envPortOf(fake.env, "ACME_ROUTER_PORT")
	for i := 0; i < 200; i++ {
		server := &http.Server{Handler: handler}
		connections := TrackConnections(func(int) {})
		connections.Watch(server)
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(canonical)))
		if err == nil {
			held := &processHoldServer{server: server, connections: connections}
			go func() { _ = server.Serve(listener) }()
			fake.addServer(held)
			s.t.Cleanup(held.close)
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// envPortOf reads the first env name that names a port.
func envPortOf(env map[string]string, names ...string) int {
	for _, name := range names {
		if raw, ok := env[name]; ok {
			if port, err := strconv.Atoi(raw); err == nil {
				return port
			}
		}
	}
	return 0
}

// ── the setup ────────────────────────────────────────────────────────────────────────────────────────────────────────

// processSetup is one case's scene: a temp root with a dist dir, a state root, a free port and
// the env that names it.
type processSetup struct {
	root     string
	dist     string
	state    string
	port     int
	env      domain.EnvLookup
	home     string
	settings string
}

func newProcessSetup(t *testing.T) *processSetup {
	t.Helper()
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, routerBinaryName), []byte("// router v1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	port, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	env := domain.EnvLookup{
		"HOME":                  filepath.Join(root, "home"),
		"PROVIDER_ROUTERS_HOME": filepath.Join(root, "routers"),
		"ACME_ROUTER_PORT":      strconv.Itoa(port),
	}
	return &processSetup{
		root:     root,
		dist:     dist,
		state:    filepath.Join(root, "state"),
		port:     port,
		env:      env,
		home:     env["HOME"],
		settings: adapters.ClaudeSettingsPath(env),
	}
}

func (s *processSetup) options(edit func(*StartOptions)) StartOptions {
	options := StartOptions{
		Provider:     processAcme,
		Env:          s.env,
		StateRoot:    s.state,
		Source:       filepath.Join(s.dist, routerBinaryName),
		Node:         "/node",
		BudgetMs:     6000,
		HealthWaitMs: 1500,
		Answers:      func(context.Context, int) bool { return false },
	}
	if edit != nil {
		edit(&options)
	}
	return options
}

// processPointSettingsAt writes Claude Code's settings with ANTHROPIC_BASE_URL and a kept var.
func processPointSettingsAt(t *testing.T, s *processSetup, url string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(s.home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	text, err := json.MarshalIndent(struct {
		Env struct {
			AnthropicBaseURL string `json:"ANTHROPIC_BASE_URL"`
			Other            string `json:"OTHER"`
		} `json:"env"`
	}{Env: struct {
		AnthropicBaseURL string `json:"ANTHROPIC_BASE_URL"`
		Other            string `json:"OTHER"`
	}{AnthropicBaseURL: url, Other: "kept"}}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.settings, append(text, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// processPointProxyAt writes Claude Code's settings with HTTPS_PROXY and a kept var.
func processPointProxyAt(t *testing.T, s *processSetup, url string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(s.home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	text, err := json.MarshalIndent(struct {
		Env struct {
			HTTPSProxy string `json:"HTTPS_PROXY"`
			Other      string `json:"OTHER"`
		} `json:"env"`
	}{Env: struct {
		HTTPSProxy string `json:"HTTPS_PROXY"`
		Other      string `json:"OTHER"`
	}{HTTPSProxy: url, Other: "kept"}}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.settings, append(text, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// processBaseUrlIn is the settings' env object.
func processBaseUrlIn(t *testing.T, s *processSetup) map[string]string {
	t.Helper()
	data, err := os.ReadFile(s.settings)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Env
}

// processSpawnChild starts this binary as a child that never exits on its own, its argv naming
// what a router of ours would run.
func processSpawnChild(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(self, args...)
	command.Env = append(os.Environ(), focusChildEnv+"=hang")
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	return command
}

// processAwaitExit waits for a child's exit and returns it as the front reads it.
func processAwaitExit(t *testing.T, command *exec.Cmd) (int, string) {
	t.Helper()
	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()
	select {
	case err := <-waited:
		code, signal := exitOf(err)
		return code, signal
	case <-time.After(5 * time.Second):
		t.Fatal("the child never exited")
		return 0, ""
	}
}

// runProcessRetiredChild is a real retired router: it answers health with mode "retired" and its
// own pid, and a SIGTERM closes it.
func runProcessRetiredChild() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	port, err := strconv.Atoi(os.Getenv("PROCESS_CHILD_PORT"))
	if err != nil {
		fail("bad PROCESS_CHILD_PORT: " + err.Error())
	}
	health := fmt.Sprintf(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"retired","pid":%d}`, os.Getpid())
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(health))
	})}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		fail("listen: " + err.Error())
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	go func() { _ = server.Serve(listener) }()
	fmt.Fprintln(os.Stdout, "up")
	// A stubborn child swallows the SIGTERM: the starter's wait for the port to free runs out.
	stubborn := os.Getenv("PROCESS_CHILD_STUBBORN") == "1"
	go func() {
		for range signals {
			if !stubborn {
				_ = server.Close()
				os.Exit(0)
			}
		}
	}()
	select {}
}

func TestRouterProcessPieces(t *testing.T) {
	t.Parallel()
	t.Run("copies the source binary only when it differs, and versions it by content", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "plugin-core")
		if err := os.WriteFile(source, []byte("one"), 0o755); err != nil {
			t.Fatal(err)
		}
		first, err := CopyRouterFiles(context.Background(), source, filepath.Join(root, "state"))
		if err != nil || first.Version != BundleVersion([]byte("one")) {
			t.Fatalf("first copy = %+v %v, want version %s", first, err, BundleVersion([]byte("one")))
		}
		copied := filepath.Join(root, "state", "router", routerBinaryName)
		before, err := os.Stat(copied)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := CopyRouterFiles(context.Background(), source, filepath.Join(root, "state")); err != nil {
			t.Fatal(err)
		}
		after, err := os.Stat(copied)
		if err != nil {
			t.Fatal(err)
		}
		if !after.ModTime().Equal(before.ModTime()) {
			t.Fatal("an unchanged binary was copied again")
		}
		if err := os.WriteFile(source, []byte("two"), 0o755); err != nil {
			t.Fatal(err)
		}
		second, err := CopyRouterFiles(context.Background(), source, filepath.Join(root, "state"))
		if err != nil || second.Version != BundleVersion([]byte("two")) {
			t.Fatalf("second copy = %+v %v, want version %s", second, err, BundleVersion([]byte("two")))
		}
		_, err = CopyRouterFiles(context.Background(), filepath.Join(root, "nope"), filepath.Join(root, "state2"))
		if err == nil || !strings.Contains(err.Error(), "copying the router") {
			t.Fatalf("a missing source = %v, want a copying error", err)
		}
		if got := BundleVersion([]byte("one")); !regexpHex12(got) {
			t.Fatalf("bundleVersion(%q) is not 12 hex digits", got)
		}
	})

	// The released plugin's shape: plugin-core lives only under AGENTS_CORE_HOME/<version>, so no
	// binary sits beside the bundles and the running executable is the copy's source.
	t.Run("copies the running executable when no source binary is injected", func(t *testing.T) {
		root := t.TempDir()
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile(self)
		if err != nil {
			t.Fatal(err)
		}
		files, err := CopyRouterFiles(context.Background(), "", filepath.Join(root, "state"))
		if err != nil {
			t.Fatalf("copying without a dist binary = %v, want the running executable copied", err)
		}
		got, err := os.ReadFile(filepath.Join(root, "state", "router", routerBinaryName))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) || files.Version != BundleVersion(want) {
			t.Fatal("the state copy is not the running executable")
		}
	})

	t.Run("recognises our health only by its name and provider", func(t *testing.T) {
		if _, ok := OurHealth(`{"ok":true,"name":"acme","provider":"Acme Models"}`, "acme", "Acme Models"); !ok {
			t.Fatal("our health was not recognised")
		}
		for _, body := range []string{
			`{"ok":true}`,
			`{"ok":true,"name":"kimi","provider":"Acme Models"}`,
			`null`,
			`<html>`,
		} {
			if _, ok := OurHealth(body, "acme", "Acme Models"); ok {
				t.Fatalf("ourHealth(%q) was recognised", body)
			}
		}
	})

	t.Run("probes: nothing, ours, someone else (any 200 is not enough), and a port that never answers", func(t *testing.T) {
		port, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		if probe := ProbeRouter(context.Background(), port, processAcme, 0); probe.State != ProbeNone {
			t.Fatalf("an empty port probes as %s", probe.State)
		}
		if processPortAnswers(port) {
			t.Fatal("the empty port answered")
		}
		processHold(t, port, func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router"}`))
			}
		})
		probe := ProbeRouter(context.Background(), port, processAcme, 0)
		if probe.State != ProbeOurs || probe.Health.Mode == nil || *probe.Health.Mode != "router" {
			t.Fatalf("our router probes as %+v", probe)
		}

		foreign, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		processHold(t, foreign, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte("hello"))
		})
		if probe := ProbeRouter(context.Background(), foreign, processAcme, 0); probe.State != ProbeForeign {
			t.Fatalf("a stranger probes as %+v", probe)
		}

		silent, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		handler, end := hungHandler()
		defer end()
		processHold(t, silent, handler)
		if probe := ProbeRouter(context.Background(), silent, processAcme, 0); probe.State != ProbeSilent {
			t.Fatalf("a silent port probes as %+v", probe)
		}

		refused, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		processHold(t, refused, func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models"}`))
		})
		if probe := ProbeRouter(context.Background(), refused, processAcme, 0); probe.State != ProbeForeign {
			t.Fatalf("a 404 probes as %+v, want foreign", probe)
		}
	})

	t.Run("passes the router what it needs and nothing else: state, key, proxies in any case (loopback exempt), CA files", func(t *testing.T) {
		env := ChildEnv(processAcme, domain.EnvLookup{
			"HOME":                "/h",
			"PATH":                "/bin",
			"https_proxy":         "http://p:1",
			"HTTP_PROXY":          "http://p:2",
			"No_Proxy":            "local",
			"NODE_EXTRA_CA_CERTS": "/ca.pem",
			"SSL_CERT_FILE":       "/cert.pem",
			"NODE_USE_ENV_PROXY":  "1",
			"ACME_API_KEY":        "k",
			"ACME_ROUTER_URL":     "http://x",
			"SECRET_OTHER":        "no",
		}, "/state", map[string]string{"ACME_ROUTER_TOKEN": "t"})
		want := map[string]string{
			"HOME":                "/h",
			"PATH":                "/bin",
			"https_proxy":         "http://p:1",
			"HTTP_PROXY":          "http://p:2",
			"NO_PROXY":            "local,127.0.0.1,localhost",
			"no_proxy":            "local,127.0.0.1,localhost",
			"NODE_EXTRA_CA_CERTS": "/ca.pem",
			"SSL_CERT_FILE":       "/cert.pem",
			"NODE_USE_ENV_PROXY":  "1",
			"ACME_API_KEY":        "k",
			"ACME_ROUTER_URL":     "http://x",
			"ACME_ROUTER_PORT":    "18800",
			"ACME_STATE_DIR":      "/state",
			"ACME_ROUTER_TOKEN":   "t",
		}
		if !reflect.DeepEqual(map[string]string(env), want) {
			t.Fatalf("childEnv = %v, want %v", map[string]string(env), want)
		}
	})

	t.Run("drops a proxy that names a plugin router and the CA set for it, keeps a corporate proxy and its CA", func(t *testing.T) {
		cases := []struct {
			name string
			env  domain.EnvLookup
		}{
			{"upper https", domain.EnvLookup{"HTTPS_PROXY": "http://127.0.0.1:18787"}},
			{"lower https", domain.EnvLookup{"https_proxy": "http://127.0.0.1:18787"}},
			{"http", domain.EnvLookup{"HTTP_PROXY": "http://localhost:18790"}},
			{"no scheme", domain.EnvLookup{"HTTPS_PROXY": "localhost:18790"}},
		}
		for _, tc := range cases {
			tc.env["NODE_EXTRA_CA_CERTS"] = "/ca.pem"
			env := ChildEnv(processAcme, tc.env, "/state", nil)
			for _, name := range []string{
				"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_EXTRA_CA_CERTS",
			} {
				if _, ok := env[name]; ok {
					t.Errorf("%s: ChildEnv kept %s (%v)", tc.name, name, env)
				}
			}
		}
		env := ChildEnv(processAcme, domain.EnvLookup{
			"HTTPS_PROXY":         "http://proxy.corp:3128",
			"NODE_EXTRA_CA_CERTS": "/ca.pem",
		}, "/state", nil)
		if env["HTTPS_PROXY"] != "http://proxy.corp:3128" || env["NODE_EXTRA_CA_CERTS"] != "/ca.pem" {
			t.Errorf("ChildEnv dropped a corporate proxy or its CA: %v", env)
		}
	})

	t.Run("reads a pid's command line, and calls it ours only when it runs one of our bundles", func(t *testing.T) {
		command, ok := CommandLineOf(context.Background(), int64(os.Getpid()))
		if !ok || !strings.Contains(command, filepath.Base(os.Args[0])) {
			t.Fatalf("commandLineOf(self) = %q %v", command, ok)
		}
		if _, ok := CommandLineOf(context.Background(), 1<<22+7); ok {
			t.Fatal("a pid that is not there has a command line")
		}
		type view struct {
			command string
			found   bool
			want    bool
		}
		for _, v := range []view{
			// A Go router of ours: this binary re-run as plugin-core.
			{command: "/state/router/plugin-core acme router run", found: true, want: true},
			{command: "/state/router/plugin-core acme passthrough", found: true, want: true},
			// A router of ours an earlier release ran (node with the copied bundle): still ours,
			// so a migration can stop it.
			{command: "node /s/router/acme-router.js run", found: true, want: true},
			{command: "node /s/router/acme-passthrough.js", found: true, want: true},
			// The installed build's front and worker on the bun runtime: the bundle path still
			// names us, whatever interpreter runs it.
			{command: "bun /s/router/acme-router.js run", found: true, want: true},
			{command: "bun /s/router/acme-router.js worker", found: true, want: true},
			{command: "bun /s/router/kimi-router.js worker", found: true, want: false},
			{command: "node /s/router/kimi-router.js run", found: true, want: false},
			{command: "/state/router/plugin-core kimi router run", found: true, want: false},
			{command: "", found: false, want: false},
		} {
			got := IsOurProcess(1, "acme", func(int64) (string, bool) { return v.command, v.found })
			if got != v.want {
				t.Fatalf("isOurProcess(%q) = %v, want %v", v.command, got, v.want)
			}
		}
	})

	t.Run("fails the copy when the state root or the router dir cannot be written", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "plugin-core")
		if err := os.WriteFile(source, []byte("one"), 0o755); err != nil {
			t.Fatal(err)
		}
		asFile := filepath.Join(root, "state")
		if err := os.WriteFile(asFile, []byte("not a dir"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := CopyRouterFiles(context.Background(), source, asFile); err == nil || !strings.Contains(err.Error(), "copying the router") {
			t.Fatalf("a state root that is a file = %v, want a copying error", err)
		}
		state := filepath.Join(root, "state2")
		if err := os.MkdirAll(filepath.Join(state, "router"), 0o700); err != nil {
			t.Fatal(err)
		}
		// chmod 0500 makes the dir unwritable.
		if err := os.Chmod(filepath.Join(state, "router"), 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(filepath.Join(state, "router"), 0o700) })
		if _, err := CopyRouterFiles(context.Background(), source, state); err == nil || !strings.Contains(err.Error(), "copying the router") {
			t.Fatalf("an unwritable router dir = %v, want a copying error", err)
		}
	})

	t.Run("reads a /proc cmdline as one line, and only when it is there", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "cmdline")
		if err := os.WriteFile(path, []byte("/bin/go\x00test\x00"), 0o644); err != nil {
			t.Fatal(err)
		}
		if line, ok := procCmdline(path); !ok || line != "/bin/go test " {
			t.Fatalf("procCmdline = %q %v", line, ok)
		}
		if _, ok := procCmdline(filepath.Join(root, "missing")); ok {
			t.Fatal("procCmdline found a file that is not there")
		}
	})

	t.Run("takes over a lock naming a reused pid once it is seconds old, and waits for a live holder of ours", func(t *testing.T) {
		// A live stranger: this binary hung in its child mode, its command line naming nothing of
		// this provider's — the shape a reused pid has.
		stranger := processSpawnChild(t)
		t.Cleanup(func() { _ = stranger.Process.Kill(); _ = stranger.Wait() })
		// A live setup holder: the command line the launcher execs (`plugin-core <name> cli setup`)
		// — a start from setup holds the lock in-process from a process that names no router.
		setupHolder := processSpawnChild(t, processAcme.Name, "cli", "setup")
		t.Cleanup(func() { _ = setupHolder.Process.Kill(); _ = setupHolder.Wait() })
		seeded := func(t *testing.T, pid int, age time.Duration) string {
			t.Helper()
			lock := filepath.Join(t.TempDir(), "router.lock")
			if err := os.WriteFile(lock, []byte(fmt.Sprintf("%d\n", pid)), 0o644); err != nil {
				t.Fatal(err)
			}
			stamp := time.Now().Add(-age)
			if err := os.Chtimes(lock, stamp, stamp); err != nil {
				t.Fatal(err)
			}
			return lock
		}
		// The reused pid is waited for only while the lock is fresh; at 4 s it is taken over.
		if takeLock(context.Background(), seeded(t, stranger.Process.Pid, 0), processAcme.Name, nil) {
			t.Fatal("a fresh lock was taken over")
		}
		if !takeLock(context.Background(), seeded(t, stranger.Process.Pid, 4*time.Second), processAcme.Name, nil) {
			t.Fatal("a lock naming a reused pid was not taken over")
		}
		// The live setup holder is waited for whatever its age under the stale limit: it may hold
		// the lock for a whole start (its health wait alone is seconds).
		if takeLock(context.Background(), seeded(t, setupHolder.Process.Pid, 4*time.Second), processAcme.Name, nil) {
			t.Fatal("a live setup holder's lock was taken over")
		}
		// A holder the command line cannot name is judged by age alone, the old rule.
		unreadable := func(int64) (string, bool) { return "", false }
		if takeLock(context.Background(), seeded(t, setupHolder.Process.Pid, 4*time.Second), processAcme.Name, unreadable) {
			t.Fatal("a lock whose holder cannot be identified was taken over before the stale age")
		}
		if !takeLock(context.Background(), seeded(t, setupHolder.Process.Pid, 11*time.Second), processAcme.Name, nil) {
			t.Fatal("a lock older than any start was not taken over")
		}
	})

	t.Run("takes the lock, refuses a fresh one, and takes over a stale, unreadable or dead one", func(t *testing.T) {
		lock := filepath.Join(t.TempDir(), "router.lock")
		if !takeLock(context.Background(), lock, processAcme.Name, nil) {
			t.Fatal("a fresh lock was not taken")
		}
		if takeLock(context.Background(), lock, processAcme.Name, nil) {
			t.Fatal("a fresh lock was taken twice")
		}
		// A lock whose holder is gone is taken over at once, whatever its age: a power loss
		// leaves it fresh with a pid that no longer runs.
		dead := filepath.Join(t.TempDir(), "router.lock")
		if err := os.WriteFile(dead, []byte(fmt.Sprintf("%d\n", powerLossDeadPid(t))), 0o644); err != nil {
			t.Fatal(err)
		}
		if !takeLock(context.Background(), dead, processAcme.Name, nil) {
			t.Fatal("a lock whose holder is dead was not taken over")
		}
		old := time.Now().Add(-60 * time.Second)
		if err := os.Chtimes(lock, old, old); err != nil {
			t.Fatal(err)
		}
		if !takeLock(context.Background(), lock, processAcme.Name, nil) {
			t.Fatal("a stale lock was not taken over")
		}
		// A dangling symlink: the create fails on a target that is there, the stat cannot follow
		// it, and no round succeeds.
		dir := t.TempDir()
		dangling := filepath.Join(dir, "router.lock")
		if err := os.Symlink(filepath.Join(dir, "gone"), dangling); err != nil {
			t.Fatal(err)
		}
		if takeLock(context.Background(), dangling, processAcme.Name, nil) {
			t.Fatal("a lock nobody can read was taken")
		}
		// A read-only dir blocks the lock's temp file only where unix modes exist.
		readOnly := t.TempDir()
		if err := os.Chmod(readOnly, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(readOnly, 0o700) })
		if takeLock(context.Background(), filepath.Join(readOnly, "router.lock"), processAcme.Name, nil) {
			t.Fatal("a lock in an unwritable dir was taken")
		}
	})

	t.Run("the default legacy runner runs a real command and reports a missing one", func(t *testing.T) {
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		run := legacyRunner(context.Background(), StartOptions{})
		if !run(self, []string{"-test.run", "^$"}) {
			t.Fatal("a command that exits 0 was reported failed")
		}
		if run(filepath.Join(t.TempDir(), "missing"), nil) {
			t.Fatal("a command that cannot start was reported successful")
		}
	})
}

// regexpHex12 reports whether text is 12 lowercase hex digits.
func regexpHex12(text string) bool {
	if len(text) != 12 {
		return false
	}
	for _, r := range text {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}

// processPortAnswers is portAnswers under the suite's 100 ms budget.
func processPortAnswers(port int) bool {
	return process.PortAnswers(context.Background(), port, 100)
}

func TestStartRouter(t *testing.T) {
	t.Parallel()
	t.Run("starts a fresh router, waits for its health and writes the pid file", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = fake.spawn
			// A tight budget: the health wait is capped by it, not only by its own default.
			o.BudgetMs = 2000
		}))
		if err != nil {
			t.Fatal(err)
		}
		first := fake.startedRouters()[0]
		want := fmt.Sprintf("running on http://127.0.0.1:%d (pid %d)", s.port, first.pid)
		if line != want {
			t.Fatalf("line = %q, want %q", line, want)
		}
		if first.binary != filepath.Join(s.state, "router", routerBinaryName) ||
			!reflect.DeepEqual(first.args, []string{"acme", "router", "run"}) {
			t.Fatalf("spawned %s %v", first.binary, first.args)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Pid != first.pid || record.Port != int64(s.port) || record.Mode != PidModeRouter ||
			record.Node != "/node" || record.Token != first.env["ACME_ROUTER_TOKEN"] {
			t.Fatalf("record = %+v, want pid %d port %d mode router", record, first.pid, s.port)
		}
		if _, err := os.Stat(filepath.Join(s.state, "router.lock")); !os.IsNotExist(err) {
			t.Fatalf("the lock survived: %v", err)
		}
	})

	t.Run("finds it already running at this version and does nothing", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, BundleVersion([]byte("// router v1\n")))
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn })); err != nil {
			t.Fatal(err)
		}
		again, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
		if err != nil {
			t.Fatal(err)
		}
		if want := fmt.Sprintf("running on http://127.0.0.1:%d (already running)", s.port); again != want {
			t.Fatalf("line = %q, want %q", again, want)
		}
		if got := len(fake.startedRouters()); got != 1 {
			t.Fatalf("%d routers were started", got)
		}
	})

	t.Run("hot-updates an older router over its control endpoint without restarting it", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "old")
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn })); err != nil {
			t.Fatal(err)
		}
		updated, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
		if err != nil || !strings.Contains(updated, "without closing the port") {
			t.Fatalf("updated = %q %v", updated, err)
		}
		if got := len(fake.startedRouters()); got != 1 {
			t.Fatalf("%d routers were started", got)
		}
		version := BundleVersion([]byte("// router v1\n"))
		want := []processControlCall{{
			action: "reload",
			body: marshalCompact(struct {
				Exec    string `json:"exec"`
				Version string `json:"version"`
			}{Exec: filepath.Join(s.state, "router", routerBinaryName), Version: version}),
		}}
		if got := fake.startedRouters()[0].controlCalls(); !reflect.DeepEqual(got, want) {
			t.Fatalf("controls = %+v, want %+v", got, want)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Version != version {
			t.Fatalf("record = %+v, want version %s", record, version)
		}
	})

	t.Run("takes over a front of another protocol by the handover, never a reload", func(t *testing.T) {
		s := newProcessSetup(t)
		var mu sync.Mutex
		var actions []string
		var server *http.Server
		server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			_, _ = io.Copy(io.Discard, req.Body)
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router","version":"oldfront","frontVersion":2}`))
				return
			}
			action := strings.TrimPrefix(req.URL.Path, processHealthPath+"/")
			mu.Lock()
			actions = append(actions, action)
			mu.Unlock()
			switch action {
			case "reload":
				// A front of another protocol must never be asked this: its answer is yes, so the
				// test fails on the call itself.
				_, _ = w.Write([]byte(`{"ok":true}`))
			case "handover":
				_, _ = w.Write([]byte(`{"ok":true}`))
				go func() { _ = server.Close() }()
			default:
				_, _ = w.Write([]byte("{}"))
			}
		})}
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port)))
		if err != nil {
			t.Fatal(err)
		}
		go func() { _ = server.Serve(listener) }()
		t.Cleanup(func() { _ = server.Close() })
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), s.state, PidRecord{
			Pid: 1, Port: int64(s.port), StartedAt: "t", Node: "n", Version: "oldfront",
			FrontVersion: 2, Mode: PidModeRouter, Token: "x",
		}); err != nil {
			t.Fatal(err)
		}
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
		if err != nil || !strings.Contains(line, "replaced an older front") {
			t.Fatalf("line = %q %v, want the handover onto a fresh front", line, err)
		}
		mu.Lock()
		defer mu.Unlock()
		if !reflect.DeepEqual(actions, []string{"handover"}) {
			t.Fatalf("the old front was called with %q, want the handover only (never a reload)", actions)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Pid != fake.startedRouters()[0].pid {
			t.Fatalf("record = %+v, want the fresh front", record)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}
	})

	t.Run("cannot update a router without its pid file, or when it refuses", func(t *testing.T) {
		s := newProcessSetup(t)
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(fmt.Sprintf(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router","version":"old","frontVersion":%d}`, FrontVersion)))
				return
			}
			_, _ = w.Write([]byte("{}"))
		})
		line, err := StartRouter(context.Background(), s.options(nil))
		if err != nil || !strings.Contains(line, "no pid file") {
			t.Fatalf("line = %q %v, want no pid file", line, err)
		}
		if err := WritePidFile(context.Background(), s.state, PidRecord{
			Pid: 1, Port: int64(s.port), StartedAt: "t", Node: "n", Version: "old",
			FrontVersion: 2, Mode: PidModeRouter, Token: "x",
		}); err != nil {
			t.Fatal(err)
		}
		line, err = StartRouter(context.Background(), s.options(nil))
		if err != nil || !strings.Contains(line, "refused") {
			t.Fatalf("line = %q %v, want refused", line, err)
		}
	})

	t.Run("falls back to the emergency passthrough when the router dies at start, and errs when both do", func(t *testing.T) {
		s := newProcessSetup(t)
		processPointSettingsAt(t, s, fmt.Sprintf("http://127.0.0.1:%d", s.port))
		fake := newProcessFakeSpawner(t, spawnDies, spawnOK, "")
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
		if err != nil || !strings.Contains(line, "as the emergency passthrough") {
			t.Fatalf("line = %q %v", line, err)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Mode != PidModeEmergency {
			t.Fatalf("record = %+v, want the emergency mode", record)
		}
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{
			"ANTHROPIC_BASE_URL": fmt.Sprintf("http://127.0.0.1:%d", s.port),
			"OTHER":              "kept",
		}) {
			t.Fatalf("the base URL was touched: %v", env)
		}

		both := newProcessSetup(t)
		processPointSettingsAt(t, both, fmt.Sprintf("http://127.0.0.1:%d", both.port))
		var lines []string
		failed, err := StartRouter(context.Background(), both.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnSilent, spawnDies, "").spawn
			o.Say = func(line string) { lines = append(lines, line) }
		}))
		if err == nil || !strings.Contains(err.Error(), "neither did the emergency passthrough") {
			t.Fatalf("line = %q %v, want both failed", failed, err)
		}
		// Nothing of ours holds the port: Claude Code must not keep pointing at it.
		if env := processBaseUrlIn(t, both); !reflect.DeepEqual(env, map[string]string{"OTHER": "kept"}) {
			t.Fatalf("the base URL survived: %v", env)
		}
		if !strings.Contains(strings.Join(lines, "\n"), "the router could not start") {
			t.Fatalf("say lines = %q", lines)
		}
	})

	t.Run("goes straight to the emergency passthrough when the source binary cannot be copied", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		missing := filepath.Join(s.root, "missing", routerBinaryName)
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = fake.spawn
			o.Source = missing
		}))
		started := fake.startedRouters()
		if len(started) != 1 ||
			// The passthrough spawns the source itself: in production the running executable.
			started[0].binary != missing ||
			!reflect.DeepEqual(started[0].args, []string{"acme", "passthrough"}) {
			t.Fatalf("spawned %+v", started)
		}
		if err != nil || !strings.Contains(line, "emergency passthrough") {
			t.Fatalf("line = %q %v", line, err)
		}
	})

	t.Run("hands the port from the emergency passthrough to a fresh router, or keeps it when the new one fails", func(t *testing.T) {
		s := newProcessSetup(t)
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnDies, spawnOK, "").spawn
		})); err != nil {
			t.Fatal(err)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Mode != PidModeEmergency {
			t.Fatalf("record = %+v, want the emergency mode", record)
		}
		failing, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnDies, spawnOK, "").spawn
		}))
		if err != nil || !strings.Contains(failing, "the running one stays") {
			t.Fatalf("line = %q %v", failing, err)
		}
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		handed, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
		if err != nil || !strings.Contains(handed, "replaced the emergency passthrough") {
			t.Fatalf("line = %q %v", handed, err)
		}
		fresh := fake.startedRouters()[0]
		record, ok = ReadPidFile(context.Background(), s.state)
		if !ok || record.Mode != PidModeRouter || record.Pid != fresh.pid {
			t.Fatalf("record = %+v, want the fresh router (pid %d)", record, fresh.pid)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}
	})

	t.Run("leaves a port someone else holds alone, says so, and takes the base URL off it", func(t *testing.T) {
		s := newProcessSetup(t)
		processPointSettingsAt(t, s, fmt.Sprintf("http://127.0.0.1:%d", s.port))
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte("squatter"))
		})
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "held by another program") {
			t.Fatalf("line = %q %v, want held by another program", line, err)
		}
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{"OTHER": "kept"}) {
			t.Fatalf("the base URL survived: %v", env)
		}
	})

	t.Run("replaces our own router when it hangs, and leaves a silent stranger alone", func(t *testing.T) {
		s := newProcessSetup(t)
		handler, end := hungHandler()
		defer end()
		processHold(t, s.port, handler)
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "does not answer") {
			t.Fatalf("line = %q %v, want does not answer", line, err)
		}

		hung := newProcessSetup(t)
		silent := processHold(t, hung.port, handler)
		child := processSpawnChild(t, "acme", "router", "run")
		time.Sleep(100 * time.Millisecond)
		if err := os.MkdirAll(hung.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), hung.state, PidRecord{
			Pid: int64(child.Process.Pid), Port: int64(hung.port), StartedAt: "t", Node: "n",
			Version: "v", FrontVersion: 2, Mode: PidModeRouter, Token: "x",
		}); err != nil {
			t.Fatal(err)
		}
		// The silent server keeps the port for the whole start, so the outcome does not
		// depend on when it lets go.
		line, err = StartRouter(context.Background(), hung.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		silent.close()
		_, signal := processAwaitExit(t, child)
		if signal != "SIGKILL" {
			t.Fatalf("the hung router ended with %q, want SIGKILL", signal)
		}
		// Killing our hung router does not free the port: the silent server holding it is
		// not ours.
		if err == nil || !strings.Contains(err.Error(), "held by another program") {
			t.Fatalf("line = %q %v, want held by another program", line, err)
		}
	})

	t.Run("sweeps the atomic-write temps a crash left, never a fresh one", func(t *testing.T) {
		s := newProcessSetup(t)
		routerDir := filepath.Join(s.state, "router")
		if err := os.MkdirAll(routerDir, 0o700); err != nil {
			t.Fatal(err)
		}
		plant := func(path string, age time.Duration) {
			t.Helper()
			if err := os.WriteFile(path, []byte("leftover"), 0o600); err != nil {
				t.Fatal(err)
			}
			stamp := time.Now().Add(-age)
			if err := os.Chtimes(path, stamp, stamp); err != nil {
				t.Fatal(err)
			}
		}
		// Both temp shapes a crash leaves behind, in both swept dirs: a write temp
		// (`<target>.tmp-<pid>-<rand>`) and a create-exclusive temp (`<target>.<rand>.tmp`).
		staleWrite := filepath.Join(s.state, "router.pid.tmp-411-0000000000")
		staleExclusive := filepath.Join(s.state, "router.lock.0000000000.tmp")
		staleBinary := filepath.Join(routerDir, "plugin-core.tmp-413-0000000000")
		plant(staleWrite, 120*time.Second)
		plant(staleExclusive, 120*time.Second)
		plant(staleBinary, 120*time.Second)
		freshWrite := filepath.Join(s.state, "router.pid.tmp-421-0000000000")
		freshBinary := filepath.Join(routerDir, "plugin-core.tmp-422-0000000000")
		plant(freshWrite, 0)
		plant(freshBinary, 0)
		plant(filepath.Join(s.state, "setup-done"), 120*time.Second)
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err != nil {
			t.Fatal(err)
		}
		for _, gone := range []string{staleWrite, staleExclusive, staleBinary} {
			if _, err := os.Stat(gone); !os.IsNotExist(err) {
				t.Fatalf("a stale temp survived the start: %s", gone)
			}
		}
		for _, kept := range []string{freshWrite, freshBinary, filepath.Join(s.state, "setup-done")} {
			if _, err := os.Stat(kept); err != nil {
				t.Fatalf("the start removed a file it did not own: %s", kept)
			}
		}
	})

	t.Run("starts exactly one router when two starts race, and takes over a stale lock", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			go func() {
				_, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn }))
				results <- err
			}()
		}
		if err := <-results; err != nil {
			t.Fatal(err)
		}
		if err := <-results; err != nil {
			t.Fatal(err)
		}
		if got := len(fake.startedRouters()); got != 1 {
			t.Fatalf("%d routers were started, want 1", got)
		}

		stale := newProcessSetup(t)
		if err := os.MkdirAll(stale.state, 0o700); err != nil {
			t.Fatal(err)
		}
		lock := filepath.Join(stale.state, "router.lock")
		if err := os.WriteFile(lock, []byte("1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-60 * time.Second)
		if err := os.Chtimes(lock, old, old); err != nil {
			t.Fatal(err)
		}
		if _, err := StartRouter(context.Background(), stale.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("waits for the starter that holds a fresh lock, and errs if it never brings the router up", func(t *testing.T) {
		s := newProcessSetup(t)
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		// This test process is alive on every platform, so the lock's holder stands in for a
		// live starter.
		if err := os.WriteFile(filepath.Join(s.state, "router.lock"),
			[]byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.BudgetMs = 100
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "holds the lock") {
			t.Fatalf("err = %v, want holds the lock", err)
		}
	})

	t.Run("hands a port with an older front and no pid record to nobody, and says so", func(t *testing.T) {
		s := newProcessSetup(t)
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router","version":"x","frontVersion":0}`))
				return
			}
			_, _ = w.Write([]byte("{}"))
		})
		line, err := StartRouter(context.Background(), s.options(nil))
		if err != nil || !strings.Contains(line, "no pid file to hand it over with") {
			t.Fatalf("line = %q %v, want no pid file to hand it over with", line, err)
		}
	})

	t.Run("errs when a handover's adopt cannot take the port", func(t *testing.T) {
		s := newProcessSetup(t)
		// An older front that ignores the handover call, so the canonical port never frees for
		// the new front to adopt.
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router","version":"x","frontVersion":0}`))
				return
			}
			_, _ = w.Write([]byte("{}"))
		})
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), s.state, PidRecord{
			Pid: 1, Port: int64(s.port), StartedAt: "t", Node: "n", Version: "v",
			FrontVersion: 0, Mode: PidModeRouter, Token: "x",
		}); err != nil {
			t.Fatal(err)
		}
		_, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.BudgetMs = 20000
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "handing "+fmt.Sprintf("http://127.0.0.1:%d", s.port)+" over to a new router failed") {
			t.Fatalf("err = %v, want the handover failure", err)
		}
	})

	t.Run("errs when the state root cannot be made or the pid record cannot be written", func(t *testing.T) {
		asFile := newProcessSetup(t)
		if err := os.WriteFile(asFile.state, []byte("not a dir"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := StartRouter(context.Background(), asFile.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err == nil {
			t.Fatal("a state root that is a file started a router")
		}

		s := newProcessSetup(t)
		if err := os.MkdirAll(filepath.Join(s.state, "router.pid"), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err == nil {
			t.Fatal("a pid record that cannot be written started a router")
		}
	})

	t.Run("retires a legacy service once the new router answers on the same port", func(t *testing.T) {
		s := newProcessSetup(t)
		launchAgents := filepath.Join(s.home, "Library", "LaunchAgents")
		if err := os.MkdirAll(launchAgents, 0o755); err != nil {
			t.Fatal(err)
		}
		plist := filepath.Join(launchAgents, "test.acme-router.plist")
		if err := os.WriteFile(plist, []byte("<plist/>"), 0o644); err != nil {
			t.Fatal(err)
		}
		var commands []string
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
			o.UID = 501
			o.Run = func(bin string, args []string) bool {
				commands = append(commands, bin+" "+strings.Join(args, " "))
				return true
			}
		}))
		if err != nil || !strings.Contains(line, "replaced the old launchd service") {
			t.Fatalf("line = %q %v", line, err)
		}
		if !reflect.DeepEqual(commands, []string{"launchctl bootout gui/501/test.acme-router"}) {
			t.Fatalf("commands = %q", commands)
		}
		if _, err := os.Stat(plist); !os.IsNotExist(err) {
			t.Fatalf("the plist survived: %v", err)
		}

		kept := newProcessSetup(t)
		units := filepath.Join(kept.home, ".config", "systemd", "user")
		if err := os.MkdirAll(units, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(units, "test.acme-router.service"), []byte("[Unit]"), 0o644); err != nil {
			t.Fatal(err)
		}
		failed, err := StartRouter(context.Background(), kept.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnDies, spawnDies, "").spawn
			o.Run = func(string, []string) bool { return true }
		}))
		if err == nil || !strings.Contains(err.Error(), "kept the old systemd service") {
			t.Fatalf("line = %q %v, want kept the old systemd service", failed, err)
		}
	})
}

func TestRouterProcessSettingsGuard(t *testing.T) {
	t.Parallel()
	t.Run("takes the proxy keys off another plugin's router that is dead and unregistered, or repoints them at a live one", func(t *testing.T) {
		s := newProcessSetup(t)
		processPointProxyAt(t, s, "http://127.0.0.1:18791")
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{"OTHER": "kept"}) {
			t.Fatalf("the dead router's proxy survived: %v", env)
		}

		live, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		processHold(t, live, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"name":"kimi"}`))
		})
		processPointProxyAt(t, s, "http://127.0.0.1:18791")
		if err := SaveRegistryEntry(context.Background(), s.env, RegisteredRouter{
			Name: "kimi", Port: int64(live), ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: "t",
		}); err != nil {
			t.Fatal(err)
		}
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{
			"HTTPS_PROXY": fmt.Sprintf("http://127.0.0.1:%d", live),
			"OTHER":       "kept",
		}) {
			t.Fatalf("the proxy = %v, want the live peer", env)
		}
	})

	t.Run("never touches a proxy that is not a plugin router, nor one a registered or answering router owns", func(t *testing.T) {
		s := newProcessSetup(t)
		processPointProxyAt(t, s, "http://proxy.corp:3128")
		GuardSettings(context.Background(), s.options(nil), false)
		if env := processBaseUrlIn(t, s); env["HTTPS_PROXY"] != "http://proxy.corp:3128" {
			t.Fatalf("the user's own proxy was touched: %v", env)
		}
		processPointProxyAt(t, s, "http://127.0.0.1:18790")
		GuardSettings(context.Background(), s.options(func(o *StartOptions) {
			o.Answers = func(context.Context, int) bool { return true }
		}), true)
		if env := processBaseUrlIn(t, s); env["HTTPS_PROXY"] != "http://127.0.0.1:18790" {
			t.Fatalf("an answering router's proxy was touched: %v", env)
		}
		if err := SaveRegistryEntry(context.Background(), s.env, RegisteredRouter{
			Name: "minimax", Port: 18790, ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: "t",
		}); err != nil {
			t.Fatal(err)
		}
		processPointProxyAt(t, s, "http://127.0.0.1:18790")
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); env["HTTPS_PROXY"] != "http://127.0.0.1:18790" {
			t.Fatalf("a registered router's proxy was touched: %v", env)
		}
		own := fmt.Sprintf("http://127.0.0.1:%d", s.port)
		processPointProxyAt(t, s, own)
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); env["HTTPS_PROXY"] != own {
			t.Fatalf("our own router's proxy was touched: %v", env)
		}
	})

	t.Run("takes the base URL off another plugin's router that is dead and unregistered, or repoints it at a live one", func(t *testing.T) {
		s := newProcessSetup(t)
		processPointSettingsAt(t, s, "http://127.0.0.1:18791")
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{"OTHER": "kept"}) {
			t.Fatalf("the dead router's URL survived: %v", env)
		}

		live, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		processHold(t, live, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"name":"kimi"}`))
		})
		processPointSettingsAt(t, s, "http://127.0.0.1:18791")
		if err := SaveRegistryEntry(context.Background(), s.env, RegisteredRouter{
			Name: "kimi", Port: int64(live), ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: "t",
		}); err != nil {
			t.Fatal(err)
		}
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); !reflect.DeepEqual(env, map[string]string{
			"ANTHROPIC_BASE_URL": fmt.Sprintf("http://127.0.0.1:%d", live),
			"OTHER":              "kept",
		}) {
			t.Fatalf("the base URL = %v, want the live peer", env)
		}
	})

	t.Run("never touches a base URL that is not a plugin router, nor a registered or answering one", func(t *testing.T) {
		s := newProcessSetup(t)
		GuardSettings(context.Background(), s.options(nil), false)
		processPointSettingsAt(t, s, "https://my-proxy.example")
		GuardSettings(context.Background(), s.options(nil), false)
		if env := processBaseUrlIn(t, s); env["ANTHROPIC_BASE_URL"] != "https://my-proxy.example" {
			t.Fatalf("the user's proxy was touched: %v", env)
		}
		processPointSettingsAt(t, s, "http://127.0.0.1:18790")
		GuardSettings(context.Background(), s.options(func(o *StartOptions) {
			o.Answers = func(context.Context, int) bool { return true }
		}), true)
		if env := processBaseUrlIn(t, s); env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:18790" {
			t.Fatalf("an answering router was touched: %v", env)
		}
		if err := SaveRegistryEntry(context.Background(), s.env, RegisteredRouter{
			Name: "minimax", Port: 18790, ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: "t",
		}); err != nil {
			t.Fatal(err)
		}
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:18790" {
			t.Fatalf("a registered router was touched: %v", env)
		}
		processPointSettingsAt(t, s, fmt.Sprintf("http://127.0.0.1:%d", s.port))
		GuardSettings(context.Background(), s.options(nil), true)
		if env := processBaseUrlIn(t, s); env["ANTHROPIC_BASE_URL"] != fmt.Sprintf("http://127.0.0.1:%d", s.port) {
			t.Fatalf("our own router was touched: %v", env)
		}
	})
}

func TestRouterProcessStopStatusKey(t *testing.T) {
	t.Parallel()
	t.Run("stops only a pid that runs our bundle; a stale record just goes", func(t *testing.T) {
		s := newProcessSetup(t)
		if line := StopRouter(context.Background(), StopOptions{Provider: processAcme, Env: s.env, StateRoot: s.state}); line != "stopped (was not running)" {
			t.Fatalf("line = %q", line)
		}
		child := processSpawnChild(t)
		record := PidRecord{
			Pid: int64(child.Process.Pid), Port: int64(s.port), StartedAt: "t", Node: "n",
			Version: "v", FrontVersion: 2, Mode: PidModeRouter, Token: "x",
		}
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		line := StopRouter(context.Background(), StopOptions{Provider: processAcme, Env: s.env, StateRoot: s.state})
		if !strings.Contains(line, "is not our router") {
			t.Fatalf("line = %q", line)
		}
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		line = StopRouter(context.Background(), StopOptions{
			Provider: processAcme, Env: s.env, StateRoot: s.state,
			CommandLine: func(int64) (string, bool) { return "/state/router/plugin-core acme router run", true },
		})
		if want := fmt.Sprintf("stopped (pid %d)", child.Process.Pid); line != want {
			t.Fatalf("line = %q, want %q", line, want)
		}
		_, signal := processAwaitExit(t, child)
		if signal != "SIGTERM" {
			t.Fatalf("the child ended with %q, want SIGTERM", signal)
		}
		record.Pid = 1<<22 + 7
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		line = StopRouter(context.Background(), StopOptions{
			Provider: processAcme, Env: s.env, StateRoot: s.state,
			CommandLine: func(int64) (string, bool) { return "/state/router/plugin-core acme router run", true },
		})
		if line != "stopped (was not running)" {
			t.Fatalf("line = %q, want stopped (was not running)", line)
		}
		if _, ok := ReadPidFile(context.Background(), s.state); ok {
			t.Fatal("the pid record survived the stop")
		}
	})

	t.Run("reports the status line for each state of the port", func(t *testing.T) {
		s := newProcessSetup(t)
		up, line := RouterStatus(context.Background(), processAcme, s.env)
		if up || line != fmt.Sprintf("acme-router not running on http://127.0.0.1:%d; this session does not use it", s.port) {
			t.Fatalf("status = %v %q", up, line)
		}
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == processHealthPath {
				_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"emergency"}`))
			}
		})
		env := domain.EnvLookup{}
		for name, value := range s.env {
			env[name] = value
		}
		env["ANTHROPIC_BASE_URL"] = fmt.Sprintf("http://127.0.0.1:%d", s.port)
		up, line = RouterStatus(context.Background(), processAcme, env)
		if !up || line != fmt.Sprintf("acme-router running (emergency) on http://127.0.0.1:%d; this session uses it", s.port) {
			t.Fatalf("status = %v %q", up, line)
		}
		other := newProcessSetup(t)
		processHold(t, other.port, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte("x"))
		})
		_, line = RouterStatus(context.Background(), processAcme, other.env)
		if !strings.Contains(line, "port held by another program") {
			t.Fatalf("status = %q", line)
		}
	})

	t.Run("asks the running router whether it can read the key", func(t *testing.T) {
		s := newProcessSetup(t)
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0); err == nil || err.Error() != "no router is running" {
			t.Fatalf("err = %v, want no router is running", err)
		}
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), s.state, PidRecord{
			Pid: 1, Port: int64(s.port), StartedAt: "t", Node: "n", Version: "v",
			FrontVersion: 2, Mode: PidModeRouter, Token: "tok",
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0); err == nil || err.Error() != "the router did not answer the key check" {
			t.Fatalf("err = %v, want the router did not answer the key check", err)
		}
		// One server answers the key check the way each phase wants: a literal answer, a router
		// whose worker is still starting, and one that never gets one.
		var mu sync.Mutex
		phase, asked := 0, 0
		answer := `{"ok":true,"source":"ACME_API_KEY"}`
		processHold(t, s.port, func(w http.ResponseWriter, req *http.Request) {
			if got := req.Header.Get(TokenHeader); got != "tok" {
				w.WriteHeader(403)
				_, _ = w.Write([]byte("{}"))
				return
			}
			mu.Lock()
			current := answer
			switch phase {
			case 1:
				// A router just started has no worker yet: the check waits for it, up to its budget.
				asked++
				current = fmt.Sprintf(`{"ok":false,"error":%q}`, NoWorker)
				if asked >= 3 {
					current = `{"ok":true,"source":"ACME_API_KEY"}`
				}
			case 2:
				current = fmt.Sprintf(`{"ok":false,"error":%q}`, NoWorker)
			case 3:
				current = "not json"
			}
			mu.Unlock()
			_, _ = w.Write([]byte(current))
		})
		if source, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0); err != nil || source != "ACME_API_KEY" {
			t.Fatalf("key check = %q %v", source, err)
		}
		mu.Lock()
		phase, answer = 0, `{"ok":false,"error":"no_key"}`
		mu.Unlock()
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0); err == nil || err.Error() != "no_key" {
			t.Fatalf("err = %v, want no_key", err)
		}
		mu.Lock()
		answer = `{"ok":false}`
		mu.Unlock()
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0); err == nil || err.Error() != "the router cannot read the key" {
			t.Fatalf("err = %v, want the router cannot read the key", err)
		}
		mu.Lock()
		phase, asked, answer = 1, 0, ""
		mu.Unlock()
		if source, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 8000); err != nil || source != "ACME_API_KEY" {
			t.Fatalf("key check = %q %v", source, err)
		}
		mu.Lock()
		count := asked
		phase = 2
		mu.Unlock()
		if count != 3 {
			t.Fatalf("asked %d times, want 3", count)
		}
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 250); err == nil || err.Error() != NoWorker {
			t.Fatalf("err = %v, want %q", err, NoWorker)
		}
		mu.Lock()
		phase = 3
		mu.Unlock()
		if _, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 250); err == nil || err.Error() != "the router did not answer the key check" {
			t.Fatalf("err = %v, want the router did not answer the key check", err)
		}
	})
}

func TestRouterProcessFreePort(t *testing.T) {
	t.Parallel()
	t.Run("finds a free loopback port", func(t *testing.T) {
		port, err := FreePort()
		if err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Fatal(err)
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	})
}

// processOursCommandLine is the ours check's stand-in: a router of ours on any engine.
func processOursCommandLine(int64) (string, bool) {
	return "/state/router/plugin-core acme router run", true
}

// processRetireOptions is the retire branch's own options.
func processRetireOptions(s *processSetup) RetireOptions {
	return RetireOptions{StopOptions: StopOptions{
		Provider: processAcme, Env: s.env, StateRoot: s.state, CommandLine: processOursCommandLine,
	}}
}

func processRetiredLine(pid int64) string {
	return fmt.Sprintf("retired (pid %d): keeps Claude working in open sessions, exits when they close", pid)
}

func TestRouterProcessRetiringOnRemove(t *testing.T) {
	t.Parallel()
	t.Run("tells the running router to retire, moves its record aside, and a second remove is a no-op", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn })); err != nil {
			t.Fatal(err)
		}
		if err := SaveRegistryEntry(context.Background(), s.env, RegisteredRouter{
			Name: "acme", Port: int64(s.port), ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: "t",
		}); err != nil {
			t.Fatal(err)
		}
		pid := fake.startedRouters()[0].pid
		options := processRetireOptions(s)
		if line := RetireRouter(context.Background(), options); line != processRetiredLine(pid) {
			t.Fatalf("line = %q, want %q", line, processRetiredLine(pid))
		}
		if calls := fake.startedRouters()[0].controlCalls(); len(calls) != 1 || calls[0].action != "retire" {
			t.Fatalf("controls = %+v, want one retire", calls)
		}
		if _, ok := ReadPidFile(context.Background(), s.state); ok {
			t.Fatal("the running record survived the retire")
		}
		retired, ok := ReadRetiredFile(context.Background(), s.state)
		if !ok || retired.Pid != pid {
			t.Fatalf("retired record = %+v, want pid %d", retired, pid)
		}
		if got := ReadRegistry(s.env); len(got) != 0 {
			t.Fatalf("registry = %+v, want empty", got)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}

		if line := RetireRouter(context.Background(), options); line != processRetiredLine(pid) {
			t.Fatalf("a second remove = %q, want %q", line, processRetiredLine(pid))
		}
		if calls := fake.startedRouters()[0].controlCalls(); len(calls) != 1 {
			t.Fatalf("controls = %+v, want one retire only", calls)
		}

		// The retired router's own exit takes its record, but never another process's.
		ClearRetiredRecord(context.Background(), s.state, 1)
		if retired, ok := ReadRetiredFile(context.Background(), s.state); !ok || retired.Pid != pid {
			t.Fatalf("retired record = %+v, want pid %d", retired, pid)
		}
		ClearRetiredRecord(context.Background(), s.state, pid)
		if _, ok := ReadRetiredFile(context.Background(), s.state); ok {
			t.Fatal("the retired record survived its router's exit")
		}
	})

	t.Run("a later setup takes the port over from the retired router by a handover", func(t *testing.T) {
		s := newProcessSetup(t)
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err != nil {
			t.Fatal(err)
		}
		if line := RetireRouter(context.Background(), processRetireOptions(s)); !strings.HasPrefix(line, "retired (pid ") {
			t.Fatalf("line = %q", line)
		}
		fresh := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		taken, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fresh.spawn }))
		if err != nil || !strings.Contains(taken, "replaced a retired router") {
			t.Fatalf("line = %q %v", taken, err)
		}
		if _, ok := ReadRetiredFile(context.Background(), s.state); ok {
			t.Fatal("the retired record survived the handover")
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Pid != fresh.startedRouters()[0].pid {
			t.Fatalf("record = %+v, want the fresh router", record)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}
	})

	t.Run("hands the port over by the pid record when the retired file is gone", func(t *testing.T) {
		s := newProcessSetup(t)
		fake := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fake.spawn })); err != nil {
			t.Fatal(err)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok {
			t.Fatal("no pid record")
		}
		if line := RetireRouter(context.Background(), processRetireOptions(s)); !strings.HasPrefix(line, "retired (pid ") {
			t.Fatalf("line = %q", line)
		}
		// The retired file goes (an older release's cleanup, say), leaving only the record.
		RemoveRetiredFile(s.state)
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		fresh := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		taken, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fresh.spawn }))
		if err != nil || !strings.Contains(taken, "replaced a retired router") {
			t.Fatalf("line = %q %v", taken, err)
		}
		if _, ok := ReadRetiredFile(context.Background(), s.state); ok {
			t.Fatal("the retired record survived the handover")
		}
	})

	t.Run("errs when a retired router of ours without any record will not stop", func(t *testing.T) {
		// The record-less retired router is recognised by its command line.
		s := newProcessSetup(t)
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(self, "acme", "router", "run")
		child.Env = append(os.Environ(),
			focusChildEnv+"=retired",
			"PROCESS_CHILD_PORT="+strconv.Itoa(s.port),
			"PROCESS_CHILD_STUBBORN=1",
		)
		stdout, err := child.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		child.Stderr = io.Discard
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = child.Process.Kill() })
		reader := bufio.NewReader(stdout)
		if up, err := reader.ReadString('\n'); err != nil || strings.TrimSpace(up) != "up" {
			_ = child.Process.Kill()
			t.Fatalf("the retired child said %q %v", up, err)
		}
		line, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.BudgetMs = 100
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "did not stop") {
			_ = child.Process.Kill()
			t.Fatalf("line = %q %v, want did not stop", line, err)
		}
		_ = child.Process.Kill()
		processAwaitExit(t, child)
	})

	t.Run("errs when the new router will not start, and the retired one keeps the port", func(t *testing.T) {
		s := newProcessSetup(t)
		if _, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
		})); err != nil {
			t.Fatal(err)
		}
		if line := RetireRouter(context.Background(), processRetireOptions(s)); !strings.HasPrefix(line, "retired (pid ") {
			t.Fatalf("line = %q", line)
		}
		taken, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnDies, spawnDies, "").spawn
		}))
		if err == nil || !strings.Contains(err.Error(), "a retired router holds the port") {
			t.Fatalf("line = %q %v, want a retired router holds the port", taken, err)
		}
		if _, ok := ReadRetiredFile(context.Background(), s.state); !ok {
			t.Fatal("the retired record was dropped anyway")
		}
		broken, err := StartRouter(context.Background(), s.options(func(o *StartOptions) {
			o.Spawn = newProcessFakeSpawner(t, spawnOK, spawnOK, "").spawn
			o.Source = filepath.Join(s.root, "missing", routerBinaryName)
		}))
		if err == nil || !strings.Contains(err.Error(), "a retired router holds") {
			t.Fatalf("line = %q %v, want a retired router holds", broken, err)
		}
	})

	t.Run("stops instead for the emergency passthrough, when the call fails, or when nothing runs", func(t *testing.T) {
		s := newProcessSetup(t)
		base := StopOptions{Provider: processAcme, Env: s.env, StateRoot: s.state, CommandLine: processOursCommandLine}
		if line := RetireRouter(context.Background(), RetireOptions{StopOptions: base}); line != "stopped (was not running)" {
			t.Fatalf("line = %q", line)
		}
		record := PidRecord{
			Pid: 1<<22 + 9, Port: int64(s.port), StartedAt: "t", Node: "n", Version: "v",
			FrontVersion: 2, Mode: PidModeRouter, Token: "x",
		}
		if err := os.MkdirAll(s.state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		record.Mode = PidModeEmergency
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		if line := RetireRouter(context.Background(), RetireOptions{StopOptions: base}); !strings.HasPrefix(line, "stopped") {
			t.Fatalf("emergency line = %q", line)
		}
		// Nothing answers the retire call on the port.
		record.Mode = PidModeRouter
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		if line := RetireRouter(context.Background(), RetireOptions{StopOptions: base}); !strings.HasPrefix(line, "stopped") {
			t.Fatalf("unreachable line = %q", line)
		}
		if err := WritePidFile(context.Background(), s.state, record); err != nil {
			t.Fatal(err)
		}
		if line := RetireRouter(context.Background(), RetireOptions{StopOptions: StopOptions{
			Provider: processAcme, Env: s.env, StateRoot: s.state,
			CommandLine: func(int64) (string, bool) { return "vim", true },
		}}); !strings.Contains(line, "is not our router") {
			t.Fatalf("line = %q", line)
		}
		if _, ok := ReadPidFile(context.Background(), s.state); ok {
			t.Fatal("the pid record survived the stop")
		}
	})

	t.Run("without a record, stops a retired router of ours and starts fresh; leaves a stranger alone", func(t *testing.T) {
		// The ours-half of this case is the record-less identification again.
		s := newProcessSetup(t)
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(self, "acme", "router", "run")
		child.Env = append(os.Environ(),
			focusChildEnv+"=retired",
			"PROCESS_CHILD_PORT="+strconv.Itoa(s.port),
		)
		stdout, err := child.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		child.Stderr = io.Discard
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = child.Process.Kill() })
		reader := bufio.NewReader(stdout)
		if up, err := reader.ReadString('\n'); err != nil || strings.TrimSpace(up) != "up" {
			_ = child.Process.Kill()
			t.Fatalf("the retired child said %q %v", up, err)
		}
		fresh := newProcessFakeSpawner(t, spawnOK, spawnOK, "")
		taken, err := StartRouter(context.Background(), s.options(func(o *StartOptions) { o.Spawn = fresh.spawn }))
		if err != nil {
			_ = child.Process.Kill()
			t.Fatal(err)
		}
		if want := fmt.Sprintf("running on http://127.0.0.1:%d (pid %d)", s.port, fresh.startedRouters()[0].pid); taken != want {
			_ = child.Process.Kill()
			t.Fatalf("line = %q, want %q", taken, want)
		}
		processAwaitExit(t, child)

		other := newProcessSetup(t)
		processHold(t, other.port, func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"retired","pid":1}`))
		})
		line, err := StartRouter(context.Background(), other.options(nil))
		if err == nil || !strings.Contains(err.Error(), "cannot be identified") {
			t.Fatalf("line = %q %v, want cannot be identified", line, err)
		}
	})
}

// The chaos suite: real router processes — front, forked worker, emergency
// passthrough, all of them this test binary re-executed through the chaos child mode — on an
// ephemeral port, with a fake Anthropic and a fake provider upstream, and a fault injected in each
// case. The invariant every case checks: a `claude-*` request issued during or right after the
// fault gets the fake Anthropic's exact bytes, streaming and not. Only the provider's own models
// may fail, and then with an Anthropic-shaped error.
//
// The suite lives in the external test package because case s) drives cli.RemoveRouting, and cli
// imports this package. The child half (the mode TestMain dispatches to) lives in
// chaos_child_test.go, package router, with its own copy of the provider spec.
package router_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakeclaude"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// chaosHealthPath is the chaos provider's health path; chaosTokenHeaderName mirrors the router's
// TokenHeader constant (unexported there).
const chaosHealthPath = "/chaos-router/health"
const chaosTokenHeaderName = "x-provider-router-token"

// chaosChildEnvName mirrors focusChildEnv and the child mode names of chaos_child_test.go (package
// router; the two packages cannot share declarations).
const chaosChildEnvName = "FRONT_FOCUS_CHILD"
const chaosChildModeName = "chaos-service"
const chaosChildStateName = "CHAOS_CHILD_STATE"

// chaosProviderSpec is the chaos provider: no name shared with any plugin, every port set by
// env. It must stay in step with chaosChildProvider in chaos_child_test.go.
func chaosProviderSpec() domain.Provider {
	return domain.DefineProvider(domain.ProviderSpec{
		Name:         "chaos",
		Display:      "Chaos Models",
		Slash:        "/chaos:",
		AgentPrefix:  "chaos:",
		BranchPrefix: "chaos/",
		Harness:      "chaos",
		ArtifactsEnv: "CHAOS_ARTIFACTS",
		EnvPrefix:    "CHAOS",
		Catalog: map[domain.ModelTier]domain.ModelRef{
			domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "chaos-big", Label: "Chaos Big"},
			domain.ModelTierFlash: {Tier: domain.ModelTierFlash, ID: "chaos-small", Label: "Chaos Small"},
		},
		TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "big", domain.ModelTierFlash: "small"},
		DefaultTier: map[domain.Mode]domain.ModelTier{
			domain.ModeEdit:     domain.ModelTierMain,
			domain.ModeExec:     domain.ModelTierFlash,
			domain.ModeReadonly: domain.ModelTierFlash,
		},
		PingTier:    domain.ModelTierFlash,
		WorkerLabel: "claude",
		BaseURL:     "http://127.0.0.1:9/anthropic",
		Auth:        domain.AuthBearer,
		KeyEnv:      []string{"CHAOS_API_KEY"},
		KeyFile:     "~/.config/chaos/env",
		BillingURL:  "https://billing.example.test/top-up",
		KeysURL:     "https://keys.example.test/api-keys",
		Router: domain.ProviderRouter{
			Port:          9,
			Label:         "test.chaos-router",
			HealthPath:    chaosHealthPath,
			ModelPrefixes: []string{"chaos-"},
		},
	})
}

// chaosSentinel is the provider key every case runs with: a value that must never appear in
// anything the router writes or answers.
func chaosSentinel(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return "KEY-SENTINEL-" + hex.EncodeToString(raw)
}

// ── the fake Anthropic and the fake provider ───────────────────────────────────────────────────────────────────────

const chaosJSONAnswer = `{"id":"msg_chaos","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}`

var chaosSSEEvents = []string{
	"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_chaos\"}}\n\n",
	"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"o\"}}\n\n",
	"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"k\"}}\n\n",
	"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
}

const chaosSSEAnswer = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_chaos\"}}\n\n" +
	"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"o\"}}\n\n" +
	"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"k\"}}\n\n" +
	"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

// chaosExpectedFor is what the fake Anthropic answers a body with: a long body's size and hash,
// else the fixed message or stream.
func chaosExpectedFor(body string) string {
	if len(body) > 1024*1024 {
		sum := sha256.Sum256([]byte(body))
		return fmt.Sprintf(`{"bytes":%d,"sha256":"%s"}`, len(body), hex.EncodeToString(sum[:]))
	}
	var parsed struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal([]byte(body), &parsed)
	if parsed.Stream {
		return chaosSSEAnswer
	}
	return chaosJSONAnswer
}

// chaosFake is one local upstream: the server, its url, and the requests it was handed.
type chaosFake struct {
	server *httptest.Server
	url    string
	host   string

	mu     sync.Mutex
	count  int
	hang   bool
	tricky bool
}

func (f *chaosFake) requests() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.count
}

// port is the fake's loopback port.
func (f *chaosFake) port() int {
	parsed, err := url.Parse(f.url)
	if err != nil {
		return 0
	}
	port, _ := strconv.Atoi(parsed.Port())
	return port
}

func (f *chaosFake) addRequest() {
	f.mu.Lock()
	f.count++
	f.mu.Unlock()
}

// chaosStream writes the fake's stream: the fixed events, or `ticks` events `slowMs` apart when
// the body asks for them.
func chaosStream(w http.ResponseWriter, r *http.Request, parsed map[string]any) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	events := chaosSSEEvents
	if ticks, ok := parsed["ticks"].(float64); ok {
		events = make([]string, int(ticks))
		for i := range events {
			events[i] = fmt.Sprintf("data: {\"tick\":%d}\n\n", i)
		}
	}
	gap := 5
	if slow, ok := parsed["slowMs"].(float64); ok && slow > 0 {
		gap = int(slow)
	}
	for _, event := range events {
		if _, err := io.WriteString(w, event); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		select {
		case <-time.After(time.Duration(gap) * time.Millisecond):
		case <-r.Context().Done():
			return
		}
	}
}

// chaosParseBody is the request body as JSON, an empty object for a long body or garbage.
func chaosParseBody(body []byte) map[string]any {
	parsed := map[string]any{}
	if len(body) <= 1024*1024 {
		_ = json.Unmarshal(body, &parsed)
	}
	return parsed
}

// newChaosAnthropic is the fake Anthropic. A stream request whose body carries `ticks` streams that
// many events `slowMs` apart instead of the fixed answer; `keepAliveMs` shortens how long it keeps
// an idle connection. The server always listens on 127.0.0.1; `urlHost` is the host its url names
// (127.0.0.2 proves the proxy rule: not the exempt 127.0.0.1, and nothing listens on .2, so only
// the proxy — which dials 127.0.0.1 whatever host it is asked for — can reach the fake).
func newChaosAnthropic(t *testing.T, keepAliveMs int, urlHost string) *chaosFake {
	t.Helper()
	fake := &chaosFake{}
	fake.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fake.addRequest()
		parsed := chaosParseBody(body)
		if parsed["stream"] == true {
			chaosStream(w, r, parsed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(chaosExpectedFor(string(body))))
	}))
	if keepAliveMs > 0 {
		fake.server.Config.IdleTimeout = time.Duration(keepAliveMs) * time.Millisecond
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fake.server.Listener = listener
	fake.server.Start()
	t.Cleanup(fake.server.Close)
	port := listener.Addr().(*net.TCPAddr).Port
	fake.host = urlHost
	fake.url = fmt.Sprintf("http://%s:%d", urlHost, port)
	return fake
}

// chaosSlowStream is a slow stream's request body: `ticks` events, `slowMs` apart.
func chaosSlowStream(ticks, slowMs int) string {
	return fmt.Sprintf(`{"model":"claude-sonnet-5-5","stream":true,"ticks":%d,"slowMs":%d,"messages":[]}`, ticks, slowMs)
}

// newChaosProvider is the fake provider: answers its model, or hangs when `hang` is set.
func newChaosProvider(t *testing.T, hang bool) *chaosFake {
	t.Helper()
	fake := &chaosFake{hang: hang}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		fake.addRequest()
		if hang {
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"provider":true}`))
	}))
	t.Cleanup(fake.server.Close)
	fake.url = fake.server.URL + "/anthropic"
	return fake
}

// newChaosTrickyProvider is a provider that misbehaves the way the request body's `mode` asks,
// quoting the key it was sent wherever it can: a 401 or a 429 or a 500 echoing the Authorization
// header, malformed JSON, a reset, silence.
func newChaosTrickyProvider(t *testing.T) *chaosFake {
	t.Helper()
	fake := &chaosFake{tricky: true}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fake.addRequest()
		mode := ""
		if parsed := chaosParseBody(body); parsed != nil {
			if text, ok := parsed["mode"].(string); ok {
				mode = text
			}
		}
		echoed := fmt.Sprintf(`{"error":{"message":"bad %s"}}`, r.Header.Get("Authorization"))
		switch mode {
		case "echo401":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			_, _ = w.Write([]byte(echoed))
		case "echo429":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(429)
			_, _ = w.Write([]byte(echoed))
		case "echo500":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(500)
			_, _ = w.Write([]byte(r.Header.Get("Authorization")))
		case "reset":
			panic(http.ErrAbortHandler)
		case "hang":
			<-r.Context().Done()
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			_, _ = w.Write([]byte("{not json"))
		}
	}))
	t.Cleanup(fake.server.Close)
	fake.url = fake.server.URL + "/anthropic"
	return fake
}

// chaosFilesUnder is every file under a directory, recursively.
func chaosFilesUnder(t *testing.T, dir string) []string {
	t.Helper()
	var found []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			found = append(found, chaosFilesUnder(t, path)...)
			continue
		}
		found = append(found, path)
	}
	return found
}

// ── clients ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// chaosAnswer is one request's answer.
type chaosAnswer struct {
	status int
	body   string
}

// chaosSend is one request on the rig's shared client (or the given one); every request carries a
// deadline, so a wedged router fails the case instead of hanging it. It fails on a connection error
// or a cut stream. One pooled-connection transient is retried once: a connection the router closed
// while idle (a handover, a retire, a drain) never carried the request, and retrying it is what
// Claude Code's client does with connection errors — so the case's clients ride the pool without
// noticing a front being swapped under them.
func chaosSend(r *chaosRig, body string, client *http.Client) (chaosAnswer, error) {
	if client == nil {
		client = r.client
	}
	answer, err := chaosSendOnce(r.port, body, client)
	if err != nil && strings.Contains(err.Error(), "http: server closed idle connection") {
		answer, err = chaosSendOnce(r.port, body, client)
	}
	return answer, err
}

func chaosSendOnce(port int, body string, client *http.Client) (chaosAnswer, error) {
	request, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/messages?beta=true", port), strings.NewReader(body))
	if err != nil {
		return chaosAnswer{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer caller-oauth")
	answer, err := client.Do(request)
	if err != nil {
		return chaosAnswer{}, err
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		return chaosAnswer{status: answer.StatusCode}, err
	}
	return chaosAnswer{status: answer.StatusCode, body: string(text)}, nil
}

// chaosModelBody is one request body for a model.
func chaosModelBody(model string, stream bool) string {
	return fmt.Sprintf(`{"model":%q,"stream":%t,"messages":[]}`, model, stream)
}

// chaosExpectClaude asserts that a claude request comes back as the fake Anthropic's exact bytes.
func chaosExpectClaude(t *testing.T, r *chaosRig, stream bool, client *http.Client) {
	t.Helper()
	answer, err := chaosSend(r, chaosModelBody("claude-sonnet-5-5", stream), client)
	want := chaosJSONAnswer
	if stream {
		want = chaosSSEAnswer
	}
	if err != nil || answer.status != 200 || answer.body != want {
		t.Fatalf("claude request = %d %.200q %v, want 200 %.80q", answer.status, answer.body, err, want)
	}
}

func chaosExpectClaudeBoth(t *testing.T, r *chaosRig) {
	t.Helper()
	chaosExpectClaude(t, r, false, nil)
	chaosExpectClaude(t, r, true, nil)
}

// chaosUntil polls check every 50 ms until it holds, failing the test at the deadline with the
// last failure.
func chaosUntil[T any](t *testing.T, ms time.Duration, check func() (T, error)) T {
	t.Helper()
	deadline := time.Now().Add(ms)
	var last error
	for {
		value, err := check()
		if err == nil {
			return value
		}
		last = err
		if time.Now().After(deadline) {
			t.Fatalf("chaos: gave up after %s: %v", ms, last)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ── the rig: one router per case, in its own temp dir, killed afterwards ───────────────────────────────────────────

// chaosHealth is the front's health answer.
type chaosHealth struct {
	OK           bool   `json:"ok"`
	Mode         string `json:"mode"`
	Worker       string `json:"worker"`
	Version      string `json:"version"`
	Pid          int64  `json:"pid"`
	WorkerPid    *int64 `json:"workerPid"`
	FrontVersion int64  `json:"frontVersion"`
}

// chaosRigOptions is what a test changes about the rig: env overrides, a tuning knob override,
// another provider fake, or dropping the key.
type chaosRigOptions struct {
	env      map[string]string
	dropKey  bool
	tuning   map[string]any
	provider *chaosFake
}

// chaosRig is one router in its own temp home, with its fakes and its child pids.
type chaosRig struct {
	t         *testing.T
	dir       string
	dist      string
	state     string
	port      int
	env       domain.EnvLookup
	anthropic *chaosFake
	provider  *chaosFake
	sentinel  string
	// client is the one shared keep-alive client every request of the case rides (the load
	// generator, the health polls, the probes): a fresh connection per request runs a loaded
	// machine out of local ports, every closed one pinning its port through TIME_WAIT. The pool
	// holds every parallel client (20 in the load cases) plus the polls beside them.
	client *http.Client

	pidsMu sync.Mutex
	pids   map[int64]bool
	loads  []*chaosLoad
	// children are the router processes the rig's own starts spawned; their Exited reaps, so a
	// front that exited shows as gone (kill(pid, 0) alone would keep seeing the zombie).
	children []router.DetachedChild
}

// chaosSelfBinary is this test binary, the dist copy's source and the wrappers' target.
func chaosSelfBinary(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return self
}

// chaosSpawn is the production detached spawn with the chaos child mode added to the child's
// environment (the internal chaosSpawn's twin, for the parent's side of the rig).
func (r *chaosRig) chaosSpawn(binary string, args []string, env map[string]string, logFile string) router.DetachedChild {
	merged := make(map[string]string, len(env)+3)
	for name, value := range env {
		merged[name] = value
	}
	merged[chaosChildEnvName] = chaosChildModeName
	merged[chaosChildStateName] = r.state
	child := process.StartDetached(binary, args, process.DetachedOptions{
		Env:     chaosEnvSlice(merged),
		LogFile: logFile,
	})
	detached := chaosDetached{inner: child}
	r.pidsMu.Lock()
	r.children = append(r.children, detached)
	r.pidsMu.Unlock()
	return detached
}

// childGone reports whether the router process the rig spawned with this pid has exited, reaping
// it: an exited child of this process stays a zombie until then, and kill(pid, 0) still sees it.
func (r *chaosRig) childGone(pid int64) bool {
	r.pidsMu.Lock()
	children := append([]router.DetachedChild(nil), r.children...)
	r.pidsMu.Unlock()
	for _, child := range children {
		if child.Pid() == pid {
			return child.Exited()
		}
	}
	return !process.IsAlive(pid)
}

// chaosEnvSlice is an env map as a child's environment slice.
func chaosEnvSlice(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for name, value := range env {
		out = append(out, name+"="+value)
	}
	return out
}

// chaosDetached is a started detached child as the starter's DetachedChild.
type chaosDetached struct {
	inner process.Detached
}

func (c chaosDetached) Pid() int64   { return c.inner.Pid }
func (c chaosDetached) Exited() bool { return c.inner.Exited() }
func (c chaosDetached) Kill()        { c.inner.Kill() }

// newChaosRig builds the rig: the temp home, the dist copy of this binary, both fakes, and the
// explicit environment every child of the case runs with.
func newChaosRig(t *testing.T, options chaosRigOptions) *chaosRig {
	t.Helper()
	dir := t.TempDir()
	dist := filepath.Join(dir, "dist")
	state := filepath.Join(dir, "state")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	r := &chaosRig{
		t:         t,
		dir:       dir,
		dist:      dist,
		state:     state,
		anthropic: newChaosAnthropic(t, 0, "127.0.0.1"),
		provider:  options.provider,
		sentinel:  chaosSentinel(t),
		pids:      map[int64]bool{},
		client: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        64,
				MaxIdleConnsPerHost: 32,
				IdleConnTimeout:     60 * time.Second,
			},
			Timeout: 90 * time.Second,
		},
	}
	if r.provider == nil {
		r.provider = newChaosProvider(t, false)
	}
	self := chaosSelfBinary(t)
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "plugin-core"), data, 0o755); err != nil {
		t.Fatal(err)
	}
	port, err := router.FreePort()
	if err != nil {
		t.Fatal(err)
	}
	r.port = port
	tuning := map[string]any{
		"heartbeatMs":  250,
		"hangMs":       4000,
		"exitWindowMs": 10_000,
		"degradedMs":   3000,
		"startMs":      10_000,
		"startWaitMs":  20_000,
	}
	for name, value := range options.tuning {
		tuning[name] = value
	}
	tuningJSON, err := json.Marshal(tuning)
	if err != nil {
		t.Fatal(err)
	}
	r.env = domain.EnvLookup{
		"PATH":                       os.Getenv("PATH"),
		"HOME":                       filepath.Join(dir, "home"),
		"CHAOS_STATE_DIR":            state,
		"CHAOS_ROUTER_PORT":          strconv.Itoa(port),
		"CHAOS_ROUTER_ANTHROPIC_URL": r.anthropic.url,
		"CHAOS_ROUTER_URL":           r.provider.url,
		"CHAOS_API_KEY":              r.sentinel,
		"PROVIDER_ROUTERS_HOME":      filepath.Join(dir, "routers"),
		"RADAR_HOME":                 filepath.Join(dir, "radar"),
		"CHAOS_ROUTER_TUNING":        string(tuningJSON),
	}
	if options.dropKey {
		delete(r.env, "CHAOS_API_KEY")
	}
	for name, value := range options.env {
		r.env[name] = value
	}
	t.Cleanup(r.stop)
	return r
}

// routerRunPattern is what every front of this rig looks like on the process list: the state
// dir's own copy of the router binary in its run mode. The temp dir in it is unique to this rig,
// so a pgrep -f sweep on it can only match processes this test started.
func (r *chaosRig) routerRunPattern() string {
	return filepath.Join(r.state, "router", "plugin-core") + " chaos router run"
}

// stop ends everything the rig started: the load generators, then every router pid the case saw
// (the front is its own process-group leader; its workers share the group), then any router the
// rig never recorded — a handover's new front, a front a setup or remove command started after the
// last health poll — swept by the rig's own pattern, then the client's pooled connections.
func (r *chaosRig) stop() {
	for _, load := range r.snapshotLoads() {
		load.stop()
	}
	for pid := range r.snapshotPids() {
		chaosKillGroup(r.t, pid)
	}
	r.client.CloseIdleConnections()
	chaosKillMatching(r.t, r.routerRunPattern())
}

func (r *chaosRig) addPid(pid int64) {
	if pid == 0 {
		return
	}
	r.pidsMu.Lock()
	r.pids[pid] = true
	r.pidsMu.Unlock()
}

func (r *chaosRig) snapshotPids() map[int64]bool {
	r.pidsMu.Lock()
	defer r.pidsMu.Unlock()
	out := make(map[int64]bool, len(r.pids))
	for pid := range r.pids {
		out[pid] = true
	}
	return out
}

func (r *chaosRig) addLoad(load *chaosLoad) {
	r.pidsMu.Lock()
	r.loads = append(r.loads, load)
	r.pidsMu.Unlock()
}

func (r *chaosRig) snapshotLoads() []*chaosLoad {
	r.pidsMu.Lock()
	defer r.pidsMu.Unlock()
	return append([]*chaosLoad(nil), r.loads...)
}

// health reads the router's health answer, or the error of asking. The poll rides the rig's shared
// client (a 2 s deadline per ask), so polling opens no connections of its own.
func (r *chaosRig) health() (chaosHealth, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d%s", r.port, chaosHealthPath), nil)
	if err != nil {
		return chaosHealth{}, err
	}
	answer, err := r.client.Do(request)
	if err != nil {
		return chaosHealth{}, err
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	if err != nil {
		return chaosHealth{}, err
	}
	var parsed chaosHealth
	if err := json.Unmarshal(text, &parsed); err != nil {
		return chaosHealth{}, fmt.Errorf("health %q: %w", text, err)
	}
	r.addPid(parsed.Pid)
	return parsed, nil
}

// healthNow is the health answer, failing the test when there is none.
func (r *chaosRig) healthNow() chaosHealth {
	r.t.Helper()
	health, err := r.health()
	if err != nil {
		r.t.Fatalf("health: %v", err)
	}
	return health
}

// start brings the router up the way setup and the hooks do.
func (r *chaosRig) start() (string, error) {
	line, err := router.StartRouter(context.Background(), router.StartOptions{
		Provider:     chaosProviderSpec(),
		Env:          r.env,
		StateRoot:    r.state,
		Source:       filepath.Join(r.dist, "plugin-core"),
		Node:         chaosSelfBinary(r.t),
		BudgetMs:     30_000,
		HealthWaitMs: 20_000,
		Spawn:        r.chaosSpawn,
	})
	if record, ok := router.ReadPidFile(context.Background(), r.state); ok {
		r.addPid(record.Pid)
	}
	return line, err
}

// workerUp waits until the router has a listening worker other than `not`.
func (r *chaosRig) workerUp(not int64) chaosHealth {
	r.t.Helper()
	return chaosUntil(r.t, 15*time.Second, func() (chaosHealth, error) {
		health, err := r.health()
		if err != nil {
			return chaosHealth{}, err
		}
		if health.Worker != "up" || health.WorkerPid == nil || *health.WorkerPid == not {
			return chaosHealth{}, fmt.Errorf("worker %s %d", health.Worker, health.WorkerPid)
		}
		return health, nil
	})
}

// writeDistScript rewrites the dist bundle: new bytes that still run this binary, changing with
// `extra`, so a rewrite is a new bundle version while the worker it forks still runs this binary.
func (r *chaosRig) writeDistScript(extra string) {
	r.t.Helper()
	bundle := chaosBundleBytes(r.t, extra)
	if err := os.WriteFile(filepath.Join(r.dist, "plugin-core"), bundle, 0o755); err != nil {
		r.t.Fatal(err)
	}
}

// corruptStateScript breaks the copied worker script in the state root the way a bundle corrupted
// by an update is broken: the file runs and fails at once (the bundle is one binary, so the
// failure is a shell that exits non-zero).
func (r *chaosRig) corruptStateScript() {
	r.t.Helper()
	path := filepath.Join(r.state, "router", "plugin-core")
	if err := os.Remove(path); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nthis is not javascript {{{\n"), 0o755); err != nil {
		r.t.Fatal(err)
	}
}

// upRig starts the router and waits for its worker, proving the front and the worker both run the
// suite's bundle.
func chaosUpRig(t *testing.T, options chaosRigOptions) *chaosRig {
	t.Helper()
	r := newChaosRig(t, options)
	line, err := r.start()
	if err != nil {
		t.Fatalf("start: %v (%s)", err, line)
	}
	up := r.workerUp(0)
	// The matrix is real: the front and the worker it forked both run the copied bundle.
	for _, pid := range []int64{up.Pid, deref(up.WorkerPid)} {
		chaosProveBundleProcess(t, pid)
	}
	return r
}

func deref(pid *int64) int64 {
	if pid == nil {
		return 0
	}
	return *pid
}

// ── the load generator ─────────────────────────────────────────────────────────────────────────────────────────────

// chaosLoadStats is what a load run counted.
type chaosLoadStats struct {
	ok     int
	failed int
	errors []string
}

// chaosLoad is clients hammering claude requests until stopped, counting answers that are not the
// exact bytes. With `retries`, a connection refused or reset before any answer is retried that
// many times, 10 ms apart, as Claude Code's client does with backoff (a listener that closes
// resets the connections still in its backlog): only one that outlasts them counts. A budget in
// attempts, not in wall-clock time, so a loaded machine slows the clients and the router alike.
type chaosLoad struct {
	rig     *chaosRig
	retries int
	paceMs  int
	running chan struct{}
	once    sync.Once
	wg      sync.WaitGroup

	mu    sync.Mutex
	stats chaosLoadStats
}

// newLoad starts `clients` parallel request loops.
func (r *chaosRig) newLoad(clients, retries, paceMs int) *chaosLoad {
	load := &chaosLoad{rig: r, retries: retries, paceMs: paceMs, running: make(chan struct{})}
	for i := 0; i < clients; i++ {
		stream := i%2 == 1
		load.wg.Add(1)
		go func() {
			defer load.wg.Done()
			for {
				select {
				case <-load.running:
					return
				default:
				}
				if failure := load.attempt(stream); failure != "" {
					load.mu.Lock()
					load.stats.failed++
					load.stats.errors = append(load.stats.errors, failure)
					load.mu.Unlock()
				} else {
					load.mu.Lock()
					load.stats.ok++
					load.mu.Unlock()
				}
				if load.paceMs > 0 {
					time.Sleep(time.Duration(load.paceMs) * time.Millisecond)
				}
			}
		}()
	}
	r.addLoad(load)
	return load
}

// attempt is one request's failure, or "" when it got the exact bytes.
func (l *chaosLoad) attempt(stream bool) string {
	for n := 0; ; n++ {
		answer, err := chaosSend(l.rig, chaosModelBody("claude-sonnet-5-5", stream), nil)
		if err != nil {
			// A reset before any answer, as Claude Code retries it. The kernel says "connection
			// refused" and "connection reset by peer".
			message := err.Error()
			reset := strings.Contains(message, "connection refused") ||
				strings.Contains(message, "connection reset by peer") ||
				strings.Contains(message, "EOF")
			if reset && n < l.retries {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return message
		}
		want := chaosJSONAnswer
		if stream {
			want = chaosSSEAnswer
		}
		if answer.status == 200 && answer.body == want {
			return ""
		}
		return fmt.Sprintf("%d %.120s", answer.status, answer.body)
	}
}

// stop ends the loops and returns their counts.
func (l *chaosLoad) stop() chaosLoadStats {
	l.once.Do(func() { close(l.running) })
	l.wg.Wait()
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stats
}

// ── spool helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

// chaosSpoolHealth is the router health lines in the rig's radar spool.
func chaosSpoolHealth(t *testing.T, radarHome string) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, file := range chaosFilesUnder(t, filepath.Join(radarHome, "spool")) {
		text, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(text), "\n") {
			if line == "" {
				continue
			}
			var parsed map[string]any
			if json.Unmarshal([]byte(line), &parsed) != nil {
				continue
			}
			if parsed["kind"] == "router.event" {
				lines = append(lines, parsed)
			}
		}
	}
	return lines
}

// chaosRemovedBody is the refusal a retired router answers the provider's models with.
const chaosRemovedBody = `{"type":"error","error":{"type":"invalid_request_error","message":` +
	`"Chaos Models was removed: restart Claude Code to stop using its router"}}`

// chaosWaitPidGone waits until a killed pid is no longer alive. A SIGKILL the kernel has not
// delivered yet leaves the worker able to take, forward and ack one more request, and a request
// whose worker acked it before dying answers 502 — so a case that kills a worker and then asserts
// the very next requests succeed must first see the death it caused.
func chaosWaitPidGone(t *testing.T, pid int64) {
	t.Helper()
	if pid == 0 {
		return
	}
	chaosUntil(t, 10*time.Second, func() (bool, error) {
		if process.IsAlive(pid) {
			return false, fmt.Errorf("pid %d still alive", pid)
		}
		return true, nil
	})
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────────────────────────────

func TestChaosClaudeRequestsGetAnthropicsExactBytes(t *testing.T) {
	t.Parallel()
	t.Run("a) SIGKILL the worker mid-stream: that stream may fail, the next requests succeed", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		chaosExpectClaudeBoth(t, r)
		before := r.healthNow()
		streaming := chaosSendAsync(t, r, chaosSlowStream(20, 200))
		time.Sleep(600 * time.Millisecond)
		chaosKillPid(t, deref(before.WorkerPid))
		chaosWaitPidGone(t, deref(before.WorkerPid))
		cut := streaming()
		// Cut mid-stream: the client sees the stream end early (or an error), never a hang and
		// never the whole stream.
		events := len(strings.Split(strings.TrimSpace(cut.answer.body), "\n\n"))
		if cut.err == nil && events >= 20 {
			t.Fatalf("the cut stream delivered %d events whole", events)
		}
		chaosExpectClaudeBoth(t, r)
		after := r.workerUp(deref(before.WorkerPid))
		if deref(after.WorkerPid) == deref(before.WorkerPid) {
			t.Fatalf("worker pid = %d after the kill", deref(after.WorkerPid))
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("b) SIGKILL the worker 10 times in a row under 20 parallel clients", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{tuning: map[string]any{"degradedMs": 2000}})
		traffic := r.newLoad(20, 0, 0)
		killed := int64(0)
		for kill := 0; kill < 10; kill++ {
			time.Sleep(150 * time.Millisecond)
			now := r.healthNow()
			if now.WorkerPid != nil {
				chaosKillPid(t, *now.WorkerPid)
				chaosWaitPidGone(t, *now.WorkerPid)
				killed = *now.WorkerPid
			}
			chaosExpectClaudeBoth(t, r)
		}
		stats := traffic.stop()
		if killed == 0 {
			t.Fatal("no worker was ever killed")
		}
		if stats.ok <= 100 {
			t.Fatalf("ok = %d, want more than 100", stats.ok)
		}
		// Only requests already talking to Anthropic when their worker died may fail.
		if stats.failed > stats.ok/10 {
			t.Fatalf("failed = %d of ok = %d", stats.failed, stats.ok)
		}
		r.workerUp(0)
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("c) block the worker's event loop: the front kills it and a fresh worker serves the request", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		before := r.healthNow()
		// SIGSTOP freezes the worker exactly like a blocked event loop: no heartbeat, nothing
		// answered.
		chaosStopPid(t, deref(before.WorkerPid))
		chaosExpectClaude(t, r, false, nil)
		// The front's own record says why: the frozen worker's heartbeat stopped and it was killed.
		chaosUntil(t, 10*time.Second, func() (string, error) {
			text, err := os.ReadFile(filepath.Join(r.state, "router", "router.log"))
			if err != nil {
				return "", err
			}
			if !strings.Contains(string(text), "(hung); killing it") {
				return "", fmt.Errorf("log = %q", text)
			}
			return string(text), nil
		})
		after := r.healthNow()
		if deref(after.WorkerPid) == deref(before.WorkerPid) {
			t.Fatalf("worker pid = %d, want a fresh one", deref(after.WorkerPid))
		}
		chaosExpectClaude(t, r, true, nil)
	})

	t.Run("d) a worker crash loop puts the front in degraded mode, then it recovers after the window", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{tuning: map[string]any{"degradedMs": 4000}})
		for kill := 0; kill < 3; kill++ {
			now := r.workerUp(0)
			chaosKillPid(t, deref(now.WorkerPid))
			// The wait is until the killed worker is no longer the health's worker: a gone
			// worker (nil) counts, so the wait ends as soon as the front degrades too.
			chaosUntil(t, 10*time.Second, func() (bool, error) {
				health, err := r.health()
				if err != nil {
					return false, err
				}
				if health.WorkerPid != nil && *health.WorkerPid == deref(now.WorkerPid) {
					return false, fmt.Errorf("same worker %d", deref(now.WorkerPid))
				}
				return true, nil
			})
		}
		chaosUntil(t, 10*time.Second, func() (string, error) {
			health, err := r.health()
			if err != nil {
				return "", err
			}
			if health.Mode != "degraded" {
				return "", fmt.Errorf("mode = %s", health.Mode)
			}
			return health.Mode, nil
		})
		chaosExpectClaudeBoth(t, r)
		provider, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || provider.status != 503 {
			t.Fatalf("provider request = %d %v, want 503", provider.status, err)
		}
		var refused struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(provider.body), &refused); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(refused.Error.Message,
			"degraded after repeated crashes; Claude models still work. Run /chaos:setup.") {
			t.Fatalf("the degraded 503 = %q", refused.Error.Message)
		}
		recovered := chaosUntil(t, 20*time.Second, func() (chaosHealth, error) {
			health, err := r.health()
			if err != nil {
				return chaosHealth{}, err
			}
			if health.Mode != "router" || health.Worker != "up" {
				return chaosHealth{}, fmt.Errorf("mode = %s worker = %s", health.Mode, health.Worker)
			}
			return health, nil
		})
		if recovered.Mode != "router" {
			t.Fatalf("recovered mode = %s", recovered.Mode)
		}
		chaosExpectClaudeBoth(t, r)
		answer, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("provider request after recovery = %d %v, want 200", answer.status, err)
		}
	})

	t.Run("e) SIGKILL the front: ensure brings the router back within one prompt", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		before := r.healthNow()
		chaosKillGroup(t, before.Pid)
		chaosUntil(t, 10*time.Second, func() (bool, error) {
			if _, err := r.health(); err == nil {
				return false, fmt.Errorf("still up")
			}
			return true, nil
		})
		started := time.Now()
		ensured := router.EnsureRouter(context.Background(), router.EnsureOptions{
			Name:         "chaos",
			EnvPrefix:    "CHAOS",
			Display:      "Chaos Models",
			HealthPath:   chaosHealthPath,
			DefaultPort:  r.port,
			Env:          r.env,
			RouterScript: filepath.Join(r.dist, "plugin-core"),
			// The dist copy is both the runtime and the script, and the child re-enters the
			// chaos child mode.
			Node: filepath.Join(r.dist, "plugin-core"),
			Start: func(node string, _ []string, env domain.EnvLookup) {
				merged := make(map[string]string, len(env)+3)
				for name, value := range env {
					merged[name] = value
				}
				merged[chaosChildEnvName] = chaosChildModeName
				merged[chaosChildStateName] = r.state
				process.StartDetached(node, []string{"chaos", "router", "start"},
					process.DetachedOptions{Env: chaosEnvSlice(merged)})
			},
		})
		ensureTook := time.Since(started)
		if ensured != router.EnsureStarted {
			t.Fatalf("ensure = %q, want started", ensured)
		}
		back := r.workerUp(0)
		// The hook never waits for the router: it is back before the router it started is even up.
		if elapsed := time.Since(started); ensureTook >= elapsed-ensureTook {
			t.Fatalf("ensure took %s of %s", ensureTook, elapsed)
		}
		if back.Pid == before.Pid {
			t.Fatalf("front pid = %d, want a new one", back.Pid)
		}
		chaosExpectClaudeBoth(t, r)
		again := router.EnsureRouter(context.Background(), router.EnsureOptions{
			Name:         "chaos",
			EnvPrefix:    "CHAOS",
			Display:      "Chaos Models",
			HealthPath:   chaosHealthPath,
			DefaultPort:  r.port,
			Env:          r.env,
			RouterScript: filepath.Join(r.dist, "plugin-core"),
			Node:         chaosSelfBinary(t),
			Start:        func(string, []string, domain.EnvLookup) {},
		})
		if again != router.EnsureUp {
			t.Fatalf("second ensure = %q, want up", again)
		}
	})

	t.Run("f) a corrupt worker bundle means degraded; a corrupt router bundle means the emergency passthrough; repair hands back", func(t *testing.T) {
		t.Parallel()
		// Both breaks sit in unix mechanisms: a corrupt bundle runs and dies at once (a shell
		// script the kernel starts), and the router-bundle break is a chmod 0500 on the router
		// dir.
		// The main model is overridden to an id outside the chaos- prefix: every process must still
		// claim it.
		r := chaosUpRig(t, chaosRigOptions{env: map[string]string{"CHAOS_MODEL_MAIN": "odd-model-7"}})
		if answer, err := chaosSend(r, chaosModelBody("odd-model-7", false), nil); err != nil ||
			answer.status != 200 || answer.body != `{"provider":true}` {
			t.Fatalf("odd model = %d %q %v", answer.status, answer.body, err)
		}
		if answer, err := chaosSend(r, chaosModelBody("other-vendor-1", false), nil); err != nil ||
			answer.status != 200 || answer.body != chaosJSONAnswer {
			t.Fatalf("claude model = %d %q %v", answer.status, answer.body, err)
		}
		registry, err := os.ReadFile(filepath.Join(r.dir, "routers", "chaos.json"))
		if err != nil {
			t.Fatal(err)
		}
		var registered struct {
			CatalogIds []string `json:"catalogIds"`
		}
		if err := json.Unmarshal(registry, &registered); err != nil {
			t.Fatal(err)
		}
		if !contains(registered.CatalogIds, "odd-model-7") {
			t.Fatalf("registered catalog ids = %q", registered.CatalogIds)
		}
		before := r.healthNow()
		r.corruptStateScript()
		chaosKillPid(t, deref(before.WorkerPid))
		chaosUntil(t, 15*time.Second, func() (string, error) {
			health, err := r.health()
			if err != nil {
				return "", err
			}
			if health.Mode != "degraded" {
				return "", fmt.Errorf("mode = %s", health.Mode)
			}
			return health.Mode, nil
		})
		chaosExpectClaudeBoth(t, r)
		if answer, err := chaosSend(r, chaosModelBody("chaos-big", false), nil); err != nil || answer.status != 503 {
			t.Fatalf("provider model while degraded = %d %v, want 503", answer.status, err)
		}
		if answer, err := chaosSend(r, chaosModelBody("odd-model-7", false), nil); err != nil || answer.status != 503 {
			t.Fatalf("odd model while degraded = %d %v, want 503", answer.status, err)
		}
		if answer, err := chaosSend(r, chaosModelBody("other-vendor-1", false), nil); err != nil ||
			answer.status != 200 || answer.body != chaosJSONAnswer {
			t.Fatalf("claude model while degraded = %d %q %v", answer.status, answer.body, err)
		}

		// The router bundle broken beyond installing (the bundle is one binary shared by the
		// front and the emergency, so the break is an install that cannot write it): a fresh
		// start falls back to the emergency passthrough, which runs straight from the dist copy.
		chaosKillGroup(t, before.Pid)
		time.Sleep(200 * time.Millisecond)
		routerDir := filepath.Join(r.state, "router")
		if err := os.Chmod(routerDir, 0o500); err != nil {
			t.Fatal(err)
		}
		emergency, emergencyErr := r.start()
		if emergencyErr != nil || !strings.Contains(emergency, "emergency passthrough") {
			t.Fatalf("emergency start = %q %v", emergency, emergencyErr)
		}
		status := r.healthNow()
		if !status.OK || status.Mode != "emergency" {
			t.Fatalf("emergency health = %+v", status)
		}
		chaosExpectClaudeBoth(t, r)
		refused, err := chaosSend(r, chaosModelBody("chaos-small", false), nil)
		if err != nil || refused.status != 503 {
			t.Fatalf("provider model in emergency = %d %v, want 503", refused.status, err)
		}
		if !strings.Contains(refused.body, "Run /chaos:setup.") {
			t.Fatalf("the emergency 503 = %q", refused.body)
		}
		if answer, err := chaosSend(r, chaosModelBody("odd-model-7", false), nil); err != nil || answer.status != 503 {
			t.Fatalf("odd model in emergency = %d %v, want 503", answer.status, err)
		}
		if answer, err := chaosSend(r, chaosModelBody("other-vendor-1", false), nil); err != nil ||
			answer.status != 200 || answer.body != chaosJSONAnswer {
			t.Fatalf("claude model in emergency = %d %q %v", answer.status, answer.body, err)
		}

		// Repaired: the next start hands the port from the emergency passthrough back to the main
		// router. The gap is counted in refused connects by a client that tries every 5 ms, not in
		// wall-clock time, so a loaded machine that slows the router slows the prober with it.
		if err := os.Chmod(routerDir, 0o700); err != nil {
			t.Fatal(err)
		}
		probing := make(chan struct{})
		var proberMu sync.Mutex
		refusedRun, longestRefusedRun := 0, 0
		go func() {
			defer close(probing)
			for {
				select {
				case <-probing:
					return
				default:
				}
				conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", r.port), 500*time.Millisecond)
				ok := err == nil
				if ok {
					_ = conn.Close()
				}
				proberMu.Lock()
				if ok {
					refusedRun = 0
				} else {
					refusedRun++
				}
				if refusedRun > longestRefusedRun {
					longestRefusedRun = refusedRun
				}
				proberMu.Unlock()
				time.Sleep(5 * time.Millisecond)
			}
		}()
		back, backErr := r.start()
		probing <- struct{}{}
		<-probing
		if backErr != nil || !strings.Contains(back, "replaced the emergency passthrough") {
			t.Fatalf("repair start = %q %v", back, backErr)
		}
		proberMu.Lock()
		longest := longestRefusedRun
		proberMu.Unlock()
		if longest > 20 {
			t.Fatalf("the handover refused %d consecutive connects", longest)
		}
		main := r.workerUp(0)
		if main.Mode != "router" {
			t.Fatalf("mode after repair = %s", main.Mode)
		}
		chaosExpectClaudeBoth(t, r)
		if answer, err := chaosSend(r, chaosModelBody("chaos-small", false), nil); err != nil || answer.status != 200 {
			t.Fatalf("provider model after repair = %d %v, want 200", answer.status, err)
		}
		if answer, err := chaosSend(r, chaosModelBody("odd-model-7", false), nil); err != nil ||
			answer.status != 200 || answer.body != `{"provider":true}` {
			t.Fatalf("odd model after repair = %d %q %v", answer.status, answer.body, err)
		}
	})

	t.Run("g) a hot update to a new worker script under load fails zero requests and never closes the port", func(t *testing.T) {
		t.Parallel()
		// The update replaces the state's copied bundle while the front and the worker still run
		// it.
		r := chaosUpRig(t, chaosRigOptions{})
		before := r.healthNow()
		traffic := r.newLoad(20, 0, 0)
		time.Sleep(300 * time.Millisecond)
		r.writeDistScript("# a new version")
		updated, updateErr := r.start()
		if updateErr != nil || !strings.Contains(updated, "without closing the port") {
			t.Fatalf("hot update = %q %v", updated, updateErr)
		}
		after := r.workerUp(deref(before.WorkerPid))
		time.Sleep(500 * time.Millisecond)
		stats := traffic.stop()
		if len(stats.errors) != 0 {
			t.Fatalf("the update failed requests: %q", stats.errors)
		}
		if stats.ok <= 20 {
			t.Fatalf("ok = %d, want more than 20", stats.ok)
		}
		if after.Pid != before.Pid {
			t.Fatalf("front pid = %d, want the running %d", after.Pid, before.Pid)
		}
		if after.Version == before.Version {
			t.Fatalf("version = %s, want a new one", after.Version)
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("g') a front with another protocol is replaced by a handover no retrying client notices", func(t *testing.T) {
		t.Parallel()
		r := newChaosRig(t, chaosRigOptions{tuning: map[string]any{"frontVersion": 0}})
		if line, err := r.start(); err != nil {
			t.Fatalf("start = %q %v", line, err)
		}
		old := r.workerUp(0)
		// Clients retry a refused connection up to 30 times, 10 ms apart: the handover's gap must
		// fit in that.
		traffic := r.newLoad(4, 30, 0)
		// The next start speaks the current protocol: the running front must hand over.
		r.env["CHAOS_ROUTER_TUNING"] = `{"heartbeatMs":250,"hangMs":4000,"startWaitMs":20000}`
		handed, handedErr := r.start()
		if handedErr != nil || !strings.Contains(handed, "replaced an older front") {
			t.Fatalf("handover = %q %v", handed, handedErr)
		}
		// The old front still finishes its open connections, so wait for the new one to answer.
		fresh := chaosUntil(t, 15*time.Second, func() (chaosHealth, error) {
			health, err := r.health()
			if err != nil {
				return chaosHealth{}, err
			}
			if health.Worker != "up" || health.Pid == old.Pid {
				return chaosHealth{}, fmt.Errorf("still the old front %d", health.Pid)
			}
			return health, nil
		})
		if fresh.Pid == old.Pid {
			t.Fatalf("front pid = %d, want a new one", fresh.Pid)
		}
		time.Sleep(300 * time.Millisecond)
		stats := traffic.stop()
		if len(stats.errors) != 0 {
			t.Fatalf("the handover failed requests: %q", stats.errors)
		}
		if stats.ok <= 4 {
			t.Fatalf("ok = %d, want more than 4", stats.ok)
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("h) a port squatted by a foreign server: nothing is killed and the base URL is unpointed", func(t *testing.T) {
		t.Parallel()
		r := newChaosRig(t, chaosRigOptions{})
		squatter := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("I am somebody else"))
		})}
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", r.port))
		if err != nil {
			t.Fatal(err)
		}
		go func() { _ = squatter.Serve(listener) }()
		t.Cleanup(func() { _ = squatter.Close() })
		settings := adapters.ClaudeSettingsPath(r.env)
		if err := os.MkdirAll(filepath.Dir(settings), 0o755); err != nil {
			t.Fatal(err)
		}
		squatterURL := fmt.Sprintf("http://127.0.0.1:%d", r.port)
		settingsJSON := fmt.Sprintf(`{"env":{"ANTHROPIC_BASE_URL":%q,"KEEP":"1"}}`, squatterURL)
		if err := os.WriteFile(settings, []byte(settingsJSON+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := r.start(); err == nil || !strings.Contains(err.Error(), "held by another program") {
			t.Fatalf("start over a squatted port = %v", err)
		}
		text, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(text, &after); err != nil {
			t.Fatalf("settings after the guard = %q: %v", text, err)
		}
		want := map[string]any{"env": map[string]any{"KEEP": "1"}}
		if !reflect.DeepEqual(after, want) {
			t.Fatalf("settings after the guard = %q, want %v", text, want)
		}
		answer, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/anything", r.port))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(answer.Body)
		answer.Body.Close()
		if string(body) != "I am somebody else" {
			t.Fatalf("the squatter = %q", body)
		}
	})

	t.Run("i) a missing key or a hung key lookup never touches claude-*; the provider answers 400 or 503", func(t *testing.T) {
		t.Parallel()
		missing := chaosUpRig(t, chaosRigOptions{dropKey: true})
		noKey, err := chaosSend(missing, chaosModelBody("chaos-big", false), nil)
		if err != nil || noKey.status != 400 {
			t.Fatalf("provider without a key = %d %v, want 400", noKey.status, err)
		}
		if !strings.Contains(noKey.body, "Chaos Models key refused or missing: run /chaos:setup") {
			t.Fatalf("the 400 = %q", noKey.body)
		}
		chaosExpectClaudeBoth(t, missing)

		hung := newChaosRig(t, chaosRigOptions{dropKey: true})
		if err := os.MkdirAll(filepath.Join(hung.dir, "home", ".config", "chaos"), 0o755); err != nil {
			t.Fatal(err)
		}
		chaosMkfifo(t, filepath.Join(hung.dir, "home", ".config", "chaos", "env"))
		if line, err := hung.start(); err != nil {
			t.Fatalf("start = %q %v", line, err)
		}
		hung.workerUp(0)
		pending := chaosSendChan(t, hung, chaosModelBody("chaos-big", false))
		// Claude traffic is served while the provider request still waits on its key.
		chaosExpectClaudeBoth(t, hung)
		select {
		case <-pending:
			t.Fatal("the provider request settled before its key budget ran out")
		default:
		}
		var timedOut chaosPending
		select {
		case timedOut = <-pending:
		case <-time.After(30 * time.Second):
			t.Fatal("the hung key lookup never settled")
		}
		if timedOut.err != nil || timedOut.answer.status != 503 {
			t.Fatalf("the hung key = %d %v, want 503", timedOut.answer.status, timedOut.err)
		}
		if !strings.Contains(timedOut.answer.body, "key timed out") {
			t.Fatalf("the 503 = %q", timedOut.answer.body)
		}
	})

	t.Run("j) a provider upstream that is down or hangs never touches claude-*", func(t *testing.T) {
		t.Parallel()
		hanging := newChaosProvider(t, true)
		r := chaosUpRig(t, chaosRigOptions{provider: hanging, tuning: map[string]any{"idleMs": 2000}})
		pending := chaosSendAsync(t, r, chaosModelBody("chaos-big", false))
		chaosExpectClaudeBoth(t, r)
		timedOut := pending()
		if timedOut.err != nil || timedOut.answer.status != 504 {
			t.Fatalf("the hanging provider = %d %v, want 504", timedOut.answer.status, timedOut.err)
		}
		gone, err := router.FreePort()
		if err != nil {
			t.Fatal(err)
		}
		down := chaosUpRig(t, chaosRigOptions{
			env: map[string]string{"CHAOS_ROUTER_URL": fmt.Sprintf("http://127.0.0.1:%d/anthropic", gone)},
		})
		answer, err := chaosSend(down, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 502 {
			t.Fatalf("the down provider = %d %v, want 502", answer.status, err)
		}
		chaosExpectClaudeBoth(t, down)
	})

	t.Run("k) a dead peer router fails only that peer's models", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		peerPort, err := router.FreePort()
		if err != nil {
			t.Fatal(err)
		}
		if err := router.SaveRegistryEntry(context.Background(), r.env, router.RegisteredRouter{
			Name:          "deadpeer",
			Port:          int64(peerPort),
			ModelPrefixes: []string{"peer-"},
			CatalogIds:    []string{},
			UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			t.Fatal(err)
		}
		// The peer lookup re-reads the registry at most every 5 s.
		peer := chaosUntil(t, 10*time.Second, func() (chaosAnswer, error) {
			answer, err := chaosSend(r, chaosModelBody("peer-model", false), nil)
			if err != nil {
				return answer, err
			}
			if answer.status != 502 {
				return answer, fmt.Errorf("status %d", answer.status)
			}
			return answer, nil
		})
		if !strings.Contains(peer.body, "/deadpeer:setup") {
			t.Fatalf("the peer 502 = %q", peer.body)
		}
		chaosExpectClaudeBoth(t, r)
		answer, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("provider model = %d %v, want 200", answer.status, err)
		}
	})

	t.Run("l) keep-alive reuse across the upstream's keepAliveTimeout never reaches the client as ECONNRESET", func(t *testing.T) {
		t.Parallel()
		edgy := newChaosAnthropic(t, 300, "127.0.0.1")
		r := chaosUpRig(t, chaosRigOptions{
			env: map[string]string{"CHAOS_ROUTER_ANTHROPIC_URL": edgy.url},
		})
		agent := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 2, IdleConnTimeout: 60 * time.Second},
			Timeout: 90 * time.Second}
		for i := 0; i < 25; i++ {
			chaosExpectClaude(t, r, i%2 == 0, agent)
			// Land each reuse right around the upstream closing its idle socket.
			time.Sleep(time.Duration(280+(i%5)*10) * time.Millisecond)
		}
	})

	t.Run("m) a 30 MiB request body goes through byte for byte", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		big := `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"` +
			strings.Repeat("x", 30*1024*1024) + `"}]}`
		answer, err := chaosSend(r, big, nil)
		if err != nil || answer.status != 200 || answer.body != chaosExpectedFor(big) {
			t.Fatalf("big body = %d %.80q %v", answer.status, answer.body, err)
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("n) a long stream is never cut: 12 s of events, six times the idle timeout", func(t *testing.T) {
		t.Parallel()
		// Only silence ends a request (here 2 s, in production 10 min); a stream that keeps talking
		// runs as long as it needs, however many idle windows it spans.
		r := chaosUpRig(t, chaosRigOptions{tuning: map[string]any{"idleMs": 2000}})
		started := time.Now()
		answer, err := chaosSend(r, chaosSlowStream(24, 500), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("the long stream = %d %v", answer.status, err)
		}
		if events := len(strings.Split(strings.TrimSpace(answer.body), "\n\n")); events != 24 {
			t.Fatalf("the stream delivered %d events, want 24", events)
		}
		if time.Since(started) < 11_500*time.Millisecond {
			t.Fatalf("the stream took %s, want at least 11.5 s", time.Since(started))
		}
	})

	t.Run("o) upstream requests go through the caller's proxy (CONNECT, or forwarding on Bun 1.3); loopback never does", func(t *testing.T) {
		t.Parallel()
		// A proxy that tunnels CONNECT and forwards absolute-form requests, the two ways clients use
		// one, to 127.0.0.1 whatever host it is asked for. The fake Anthropic is named 127.0.0.2:
		// still loopback for the https rule, but not the router's own 127.0.0.1, which is exempt
		// from every proxy (and nothing listens on .2, so only the proxy works).
		var seenMu sync.Mutex
		var seen []string
		// One forwarding client for the whole proxy, never through a proxy of its own.
		forwardClient := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 60 * time.Second}
		proxyHandler := func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodConnect {
				seenMu.Lock()
				seen = append(seen, r.Host)
				seenMu.Unlock()
				hijacker, ok := w.(http.Hijacker)
				if !ok {
					w.WriteHeader(500)
					return
				}
				client, _, err := hijacker.Hijack()
				if err != nil {
					return
				}
				defer client.Close()
				_, port, _ := net.SplitHostPort(r.Host)
				upstream, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", port))
				if err != nil {
					return
				}
				defer upstream.Close()
				_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
				go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
				<-done
				return
			}
			// An absolute-form request: forward it to the target's port on this machine.
			target, err := url.Parse(r.RequestURI)
			if err != nil {
				w.WriteHeader(400)
				return
			}
			seenMu.Lock()
			seen = append(seen, target.Host)
			seenMu.Unlock()
			forward, err := http.NewRequest(r.Method,
				fmt.Sprintf("http://127.0.0.1:%s%s", target.Port(), target.Path), r.Body)
			if err != nil {
				w.WriteHeader(400)
				return
			}
			forward.Header = r.Header.Clone()
			answer, err := forwardClient.Do(forward)
			if err != nil {
				panic(http.ErrAbortHandler)
			}
			defer answer.Body.Close()
			for name, values := range answer.Header {
				for _, value := range values {
					w.Header().Add(name, value)
				}
			}
			w.WriteHeader(answer.StatusCode)
			_, _ = io.Copy(w, answer.Body)
		}
		proxy := httptest.NewServer(http.HandlerFunc(proxyHandler))
		defer proxy.Close()
		anthropic := newChaosAnthropic(t, 0, "127.0.0.2")
		r := chaosUpRig(t, chaosRigOptions{env: map[string]string{
			"HTTP_PROXY":                 proxy.URL,
			"CHAOS_ROUTER_ANTHROPIC_URL": anthropic.url,
		}})
		chaosExpectClaudeBoth(t, r)
		want := fmt.Sprintf("%s:%d", anthropic.host, anthropic.port())
		seenMu.Lock()
		defer seenMu.Unlock()
		if !contains(seen, want) {
			t.Fatalf("the proxy saw %q, want %s", seen, want)
		}
		// Front to worker is loopback: nothing of it reached the proxy.
		for _, authority := range seen {
			if authority != want {
				t.Fatalf("the proxy saw %q among %q", authority, seen)
			}
		}
	})

	t.Run("p) a full disk for the crash log, the router log and the spool: requests are still served", func(t *testing.T) {
		t.Parallel()
		r := newChaosRig(t, chaosRigOptions{})
		// Every log path is a directory or sits under a file: each write fails like ENOSPC would.
		if err := os.MkdirAll(filepath.Join(r.state, "router-crash.log"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(r.state, "router", "router.log"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(r.dir, "radar"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(r.dir, "radar", "spool"), []byte("not a directory"), 0o644); err != nil {
			t.Fatal(err)
		}
		if line, err := r.start(); err != nil {
			t.Fatalf("start = %q %v", line, err)
		}
		before := r.workerUp(0)
		chaosExpectClaudeBoth(t, r)
		chaosKillPid(t, deref(before.WorkerPid))
		r.workerUp(deref(before.WorkerPid))
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("q) two hooks starting the router at once start exactly one", func(t *testing.T) {
		t.Parallel()
		r := newChaosRig(t, chaosRigOptions{})
		starts := make(chan int, 2)
		go func() {
			line, err := r.start()
			if err != nil {
				t.Errorf("first start: %v (%s)", err, line)
			}
			starts <- 0
		}()
		go func() {
			line, err := r.start()
			if err != nil {
				t.Errorf("second start: %v (%s)", err, line)
			}
			starts <- 1
		}()
		<-starts
		<-starts
		up := r.workerUp(0)
		time.Sleep(500 * time.Millisecond)
		pattern := r.routerRunPattern()
		if running := chaosProcessesRunning(t, pattern); running != 1 {
			t.Fatalf("%d router processes run (%s)", running, pattern)
		}
		record, ok := router.ReadPidFile(context.Background(), r.state)
		if !ok || record.Pid != up.Pid {
			t.Fatalf("pid file = %+v ok = %t, want pid %d", record, ok, up.Pid)
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("r) budget-status.json churning, a FIFO, garbage or stale: a stop refuses only the provider, nothing else ever breaks", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{})
		statusFile := filepath.Join(r.dir, "radar", "budget-status.json")
		stopped := func(stopped []string, updatedAt int64) string {
			raw, _ := json.Marshal(map[string]any{
				"version":   1,
				"updatedAt": updatedAt,
				"stopped":   stopped,
				"spend":     []any{},
			})
			return string(raw)
		}
		if err := os.MkdirAll(filepath.Join(r.dir, "radar"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(r.dir, "radar", "budgets.json"), []byte(`{"version":1,"budgets":[{"id":"b","scope":"provider:chaos","period":"month","limitUsd":1,"action":"stop"}]}`), 0o644); err != nil {
			t.Fatal(err)
		}
		// The worker has read no status yet, so this one counts at once.
		if err := os.WriteFile(statusFile, []byte(stopped([]string{"provider:chaos"}, time.Now().UnixMilli())), 0o644); err != nil {
			t.Fatal(err)
		}
		refused, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || refused.status != 400 {
			t.Fatalf("the stopped budget = %d %v, want 400", refused.status, err)
		}
		var message struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(refused.body), &message); err != nil {
			t.Fatal(err)
		}
		if want := "Chaos Models budget reached for this month: raise or lift it in the Radar dashboard (/huddle:open)"; message.Error.Message != want {
			t.Fatalf("the 400 = %q, want %q", message.Error.Message, want)
		}
		chaosExpectClaudeBoth(t, r)
		before := r.healthNow()

		// Chaos: the file rewritten (half-written, a FIFO, garbage, a directory, stale) under 20
		// paced claude clients.
		clients := r.newLoad(20, 0, 50)
		breakers := []func(t *testing.T){
			func(t *testing.T) {
				chaosWriteFile(t, statusFile, stopped([]string{"total"}, time.Now().UnixMilli())[:20])
			},
			func(t *testing.T) { chaosWriteFile(t, statusFile, "\x00garbage") },
			func(t *testing.T) {
				_ = os.RemoveAll(statusFile)
				chaosMkfifo(t, statusFile)
			},
			func(t *testing.T) {
				_ = os.RemoveAll(statusFile)
				if err := os.MkdirAll(statusFile, 0o755); err != nil {
					t.Fatal(err)
				}
			},
			func(t *testing.T) {
				_ = os.RemoveAll(statusFile)
				chaosWriteFile(t, statusFile, stopped([]string{"total"}, time.Now().UnixMilli()))
			},
		}
		churnUntil := time.Now().Add(3000 * time.Millisecond)
		for i := 0; time.Now().Before(churnUntil); i++ {
			breakers[i%len(breakers)](t)
			time.Sleep(25 * time.Millisecond)
		}
		_ = os.RemoveAll(statusFile)
		chaosMkfifo(t, statusFile)
		// The cached reading expires; the FIFO left there must not block the worker's next read.
		time.Sleep(5500 * time.Millisecond)
		answer, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("provider request past the churn = %d %v, want 200", answer.status, err)
		}
		stats := clients.stop()
		if stats.failed != 0 {
			t.Fatalf("the churn failed %d claude requests: %q", stats.failed, stats.errors)
		}
		if stats.ok <= 20 {
			t.Fatalf("ok = %d, want more than 20", stats.ok)
		}
		// The same worker served it all: no read ever hung its event loop.
		if now := r.healthNow(); deref(now.WorkerPid) != deref(before.WorkerPid) {
			t.Fatalf("worker pid = %d, want the same %d", deref(now.WorkerPid), deref(before.WorkerPid))
		}

		// A stale stop stops nothing; a fresh one does again.
		_ = os.Remove(statusFile)
		chaosWriteFile(t, statusFile, stopped([]string{"provider:chaos"}, time.Now().UnixMilli()-11*60_000))
		time.Sleep(5500 * time.Millisecond)
		answer, err = chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("the stale stop = %d %v, want 200", answer.status, err)
		}
		chaosWriteFile(t, statusFile, stopped([]string{"total"}, time.Now().UnixMilli()))
		time.Sleep(5500 * time.Millisecond)
		answer, err = chaosSend(r, chaosModelBody("chaos-small", false), nil)
		if err != nil || answer.status != 400 {
			t.Fatalf("the fresh total stop = %d %v, want 400", answer.status, err)
		}
		chaosExpectClaudeBoth(t, r)

		// Radar heard about both stops, each once, and every refusal.
		var healthLines []string
		for _, line := range chaosSpoolHealth(t, r.env["RADAR_HOME"]) {
			healthLines = append(healthLines, fmt.Sprintf("%v %v %v", line["event"], line["reason"], line["model"]))
		}
		want := []string{
			"budget_stop provider:chaos budget reached for this month chaos-big",
			"refusal budget: provider:chaos chaos-big",
			"budget_stop total budget reached for this period chaos-small",
			"refusal budget: total chaos-small",
		}
		if len(healthLines) != len(want) {
			t.Fatalf("health lines = %q, want %q", healthLines, want)
		}
		for i := range want {
			if healthLines[i] != want[i] {
				t.Fatalf("health line %d = %q, want %q", i, healthLines[i], want[i])
			}
		}
	})

	t.Run("the provider key never leaks: no log, crash log, spool, ledger, health, control answer or error body holds it", func(t *testing.T) {
		t.Parallel()
		r := chaosUpRig(t, chaosRigOptions{provider: newChaosTrickyProvider(t), tuning: map[string]any{"idleMs": 1500}})
		var answers []string
		provider := func(mode string) (chaosAnswer, error) {
			body := fmt.Sprintf(`{"model":"chaos-big","mode":%q,"messages":[]}`, mode)
			answer, err := chaosSend(r, body, nil)
			answers = append(answers, answer.body)
			return answer, err
		}
		// The key is a sentinel the provider fake quotes back in every failure it can produce.
		if answer, err := provider("echo401"); err != nil || answer.status != 400 {
			t.Fatalf("echo401 = %d %v, want 400", answer.status, err)
		}
		if answer, err := provider("echo429"); err != nil || answer.status != 429 {
			t.Fatalf("echo429 = %d %v, want 429", answer.status, err)
		}
		if answer, err := provider("echo500"); err != nil || answer.status != 500 {
			t.Fatalf("echo500 = %d %v, want 500", answer.status, err)
		}
		if answer, err := provider("badjson"); err != nil || answer.status != 200 {
			t.Fatalf("badjson = %d %v, want 200", answer.status, err)
		}
		if answer, err := provider("reset"); err != nil || answer.status != 502 {
			t.Fatalf("reset = %d %v, want 502", answer.status, err)
		}
		if answer, err := provider("hang"); err != nil || answer.status != 504 {
			t.Fatalf("hang = %d %v, want 504", answer.status, err)
		}
		// A worker killed while a provider request is in flight, and the request it cut.
		before := r.healthNow()
		sent := r.provider.requests()
		cut := make(chan error, 1)
		go func() {
			_, err := provider("hang")
			cut <- err
		}()
		chaosUntil(t, 5*time.Second, func() (bool, error) {
			if r.provider.requests() == sent {
				return false, fmt.Errorf("not sent yet")
			}
			return true, nil
		})
		chaosKillPid(t, deref(before.WorkerPid))
		select {
		case <-cut:
		case <-time.After(10 * time.Second):
			t.Fatal("the cut provider request never settled")
		}
		after := r.workerUp(deref(before.WorkerPid))
		chaosExpectClaudeBoth(t, r)
		// Health, the key check (it names the key's source, never the key) and the processes'
		// command lines.
		healthRaw, err := json.Marshal(after)
		if err != nil {
			t.Fatal(err)
		}
		answers = append(answers, string(healthRaw))
		record, ok := router.ReadPidFile(context.Background(), r.state)
		if !ok {
			t.Fatal("no pid record")
		}
		client := &http.Client{Timeout: 5 * time.Second}
		check, err := http.NewRequest(http.MethodGet,
			fmt.Sprintf("http://127.0.0.1:%d%s/key", r.port, chaosHealthPath), nil)
		if err != nil {
			t.Fatal(err)
		}
		check.Header.Set(chaosTokenHeaderName, record.Token)
		keyAnswer, err := client.Do(check)
		if err != nil {
			t.Fatal(err)
		}
		keyBody, _ := io.ReadAll(keyAnswer.Body)
		keyAnswer.Body.Close()
		if !strings.Contains(string(keyBody), `"ok":true`) {
			t.Fatalf("the key check = %q", keyBody)
		}
		answers = append(answers, string(keyBody))
		for _, pid := range []int64{after.Pid, deref(after.WorkerPid)} {
			if command, ok := router.CommandLineOf(context.Background(), pid); ok {
				answers = append(answers, command)
			}
		}
		for _, answer := range answers {
			if strings.Contains(answer, r.sentinel) {
				t.Fatalf("an answer holds the key: %.200q", answer)
			}
		}
		// Every file the router wrote: its log, crash log, pid file, ledger, registry entry and
		// Radar's spool.
		var written []string
		for _, path := range chaosFilesUnder(t, r.dir) {
			if !strings.HasPrefix(path, r.dist+string(filepath.Separator)) {
				written = append(written, path)
			}
		}
		mustExist := []string{
			filepath.Join(r.state, "router", "router.log"),
			filepath.Join(r.state, "router.pid"),
			filepath.Join(r.state, "router-crash.log"),
		}
		for _, path := range mustExist {
			if !contains(written, path) {
				t.Fatalf("%s was never written (of %q)", path, written)
			}
		}
		spoolSeen := false
		for _, path := range written {
			if strings.HasPrefix(path, filepath.Join(r.dir, "radar", "spool")) {
				spoolSeen = true
			}
			text, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(text), r.sentinel) {
				t.Fatalf("%s holds the key", path)
			}
		}
		if !spoolSeen {
			t.Fatalf("no spool file was written (of %q)", written)
		}
		// The health events the faults produced are in the spool, metadata only.
		var events []string
		var keySets [][]string
		for _, line := range chaosSpoolHealth(t, r.env["RADAR_HOME"]) {
			events = append(events, fmt.Sprintf("%v", line["event"]))
			keys := make([]string, 0, len(line))
			for key := range line {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			keySets = append(keySets, keys)
		}
		for _, want := range []string{"refusal", "rate_limited", "restart"} {
			if !contains(events, want) {
				t.Fatalf("health events = %q, want %s", events, want)
			}
		}
		for _, keys := range keySets {
			if strings.Join(keys, ",") != "event,kind,model,plugin,reason,ts" {
				t.Fatalf("a health line's keys = %q", keys)
			}
		}
	})

	t.Run("s) setup --remove under claude load: the router retires, zero client fails, the provider gets the 400", func(t *testing.T) {
		t.Parallel()
		// The case drives the real retireRouter, so a retired front answers the load.
		r := chaosUpRig(t, chaosRigOptions{})
		settings := adapters.ClaudeSettingsPath(r.env)
		if err := os.MkdirAll(filepath.Dir(settings), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(settings, []byte(fmt.Sprintf(
			`{"env":{"ANTHROPIC_BASE_URL":%q}}`+"\n", fmt.Sprintf("http://127.0.0.1:%d", r.port))), 0o644); err != nil {
			t.Fatal(err)
		}
		before := r.healthNow()
		deps := cli.SetupDeps{
			Provider:     chaosProviderSpec(),
			Env:          r.env,
			StateRoot:    r.state,
			BundlePath:   filepath.Join(r.dist, "chaos.js"),
			Out:          &fakes.RecordingOutput{},
			SettingsPath: settings,
			EngineConfig: adapters.CreateFsEngineConfig(r.state),
			LoadKey: func(context.Context) (ports.ProviderKey, error) {
				return ports.ProviderKey{}, errors.New("missing")
			},
			EnsureRouter: func(context.Context) (string, error) { return "unused", nil },
			RetireRouter: func(ctx context.Context) (string, error) {
				return router.RetireRouter(ctx, router.RetireOptions{StopOptions: router.StopOptions{
					Provider: chaosProviderSpec(), Env: r.env, StateRoot: r.state,
				}}), nil
			},
			RouterKey: func(context.Context) (string, error) { return "unused", nil },
		}
		clients := r.newLoad(20, 0, 50)
		time.Sleep(500 * time.Millisecond)
		removed := cli.RemoveRouting(context.Background(), deps)
		wantLine := fmt.Sprintf(
			"retired (pid %d): keeps Claude working in open sessions, exits when they close", before.Pid)
		if !removed.Router.OK || removed.Router.Value != wantLine {
			t.Fatalf("removed router = %+v, want %q", removed.Router, wantLine)
		}
		settingsText, err := os.ReadFile(settings)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(settingsText), "ANTHROPIC_BASE_URL") {
			t.Fatalf("settings after remove = %q", settingsText)
		}
		time.Sleep(1500 * time.Millisecond)
		refused, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || refused.status != 400 {
			t.Fatalf("the provider past the remove = %d %v, want 400", refused.status, err)
		}
		if strings.TrimSpace(refused.body) != chaosRemovedBody {
			t.Fatalf("the 400 = %q, want %q", refused.body, chaosRemovedBody)
		}
		stats := clients.stop()
		if len(stats.errors) != 0 {
			t.Fatalf("the remove failed requests: %q", stats.errors)
		}
		if stats.ok <= 20 {
			t.Fatalf("ok = %d, want more than 20", stats.ok)
		}

		// The same front stays up, retired, its worker drained; a second remove changes nothing.
		after := r.healthNow()
		if after.Mode != "retired" || after.Pid != before.Pid {
			t.Fatalf("health after remove = %+v, want retired pid %d", after, before.Pid)
		}
		chaosUntil(t, 10*time.Second, func() (bool, error) {
			if process.IsAlive(deref(before.WorkerPid)) {
				return false, fmt.Errorf("worker still running")
			}
			return true, nil
		})
		if !process.IsAlive(before.Pid) {
			t.Fatal("the retired front died")
		}
		if _, ok := router.ReadPidFile(context.Background(), r.state); ok {
			t.Fatal("the pid file survived the retirement")
		}
		if retired, ok := router.ReadRetiredFile(context.Background(), r.state); !ok || retired.Pid != before.Pid {
			t.Fatalf("the retired record = %+v ok = %t", retired, ok)
		}
		again := cli.RemoveRouting(context.Background(), deps)
		if again.Router.Value != removed.Router.Value {
			t.Fatalf("a second remove = %q, want %q", again.Router.Value, removed.Router.Value)
		}
		chaosExpectClaudeBoth(t, r)
		if lines := chaosSpoolHealth(t, r.env["RADAR_HOME"]); len(lines) != 1 || lines[0]["event"] != "restart" {
			t.Fatalf("health lines = %q, want one restart", lines)
		}

		// Setup again takes the port over from the retired router without closing it.
		restarted, restartErr := r.start()
		if restartErr != nil || !strings.Contains(restarted, "replaced a retired router") {
			t.Fatalf("setup again = %q %v", restarted, restartErr)
		}
		fresh := r.workerUp(0)
		if fresh.Mode != "router" {
			t.Fatalf("mode after setup again = %s", fresh.Mode)
		}
		if fresh.Pid == before.Pid {
			t.Fatalf("front pid = %d, want a new one", fresh.Pid)
		}
		answer, err := chaosSend(r, chaosModelBody("chaos-big", false), nil)
		if err != nil || answer.status != 200 {
			t.Fatalf("provider after setup again = %d %v, want 200", answer.status, err)
		}
		chaosExpectClaudeBoth(t, r)
	})

	t.Run("uninstall under claude load: the plugin root goes, settings come back, the router retires, then cleans up and exits", func(t *testing.T) {
		t.Parallel()
		r := newChaosRig(t, chaosRigOptions{tuning: map[string]any{
			"watchEveryMs":   200,
			"retiredEveryMs": 200,
			"retiredMaxMs":   6000,
		}})
		configDir := filepath.Join(r.dir, "home", ".claude")
		if err := os.MkdirAll(filepath.Join(configDir, "plugins"), 0o755); err != nil {
			t.Fatal(err)
		}
		installed := filepath.Join(configDir, "plugins", "installed_plugins.json")
		if err := os.WriteFile(installed, []byte(
			`{"version":2,"plugins":{"chaos-plugin-cc@test":[{"scope":"user"}]}}`), 0o644); err != nil {
			t.Fatal(err)
		}
		settings := adapters.ClaudeSettingsPath(r.env)
		original := "{\n  \"theme\": \"dark\"\n}\n"
		if err := os.WriteFile(settings, []byte(original), 0o644); err != nil {
			t.Fatal(err)
		}
		if line, err := r.start(); err != nil {
			t.Fatalf("start = %q %v", line, err)
		}
		up := r.workerUp(0)
		// What setup would have recorded: the base URL it pointed at the router, and the agent model
		// it replaced. The agent files sit outside the deleted plugin root here, as a disabled
		// plugin's do.
		if err := os.WriteFile(settings, []byte(fmt.Sprintf(
			`{"env":{"ANTHROPIC_BASE_URL":%q},"theme":"dark"}`+"\n",
			fmt.Sprintf("http://127.0.0.1:%d", r.port))), 0o644); err != nil {
			t.Fatal(err)
		}
		agents := filepath.Join(r.dir, "agents")
		if err := os.MkdirAll(agents, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(agents, "chaos-big.md"),
			[]byte("---\nname: chaos-big\nmodel: chaos-big\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		agentsRecorded := router.NewLedgerAgents()
		agentsRecorded.Set("chaos-big", ptr("opus"))
		agentsDir := agents
		if err := router.WriteLedger(context.Background(),
			domain.NewStateLayout(r.state).Ledger, router.Ledger{
				Version:      1,
				Plugin:       "chaos",
				RouterURL:    fmt.Sprintf("http://127.0.0.1:%d", r.port),
				SettingsPath: settings,
				Settings: adapters.SettingsUndo{
					OptionsAdded:      []string{},
					AvailableAppended: []string{},
					CreatedEnv:        true,
				},
				Keystore:    router.LedgerKeystore{Created: false},
				RouterFiles: []string{filepath.Join(r.state, "router")},
				Agents:      agentsRecorded,
				AgentsDir:   &agentsDir,
				StateRoot:   r.state,
			}); err != nil {
			t.Fatal(err)
		}
		// An open Claude Code session from before the uninstall: a process named `claude` (a copy
		// of the fake claude binary), so the retired router has a session to wait for on a machine
		// that runs no Claude Code, such as CI. The link carries the platform's executable
		// extension: CreateProcess runs a copy only by one.
		fakeClaudeName := "claude"
		fakeClaude := filepath.Join(r.dir, "bin", fakeClaudeName)
		if err := os.MkdirAll(filepath.Join(r.dir, "bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		chaosSymlink(t, fakeclaude.Build(t), fakeClaude)
		session := exec.Command(fakeClaude)
		session.Env = []string{"FAKE_CLAUDE_SCENARIO=sleep", "PATH=" + r.env["PATH"]}
		if err := session.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Process.Kill() })
		time.Sleep(1100 * time.Millisecond)
		clients := r.newLoad(20, 0, 50)
		time.Sleep(300 * time.Millisecond)
		// Uninstalled from /plugin: Claude Code drops the entry and deletes the plugin's own
		// directory.
		if err := os.WriteFile(installed, []byte(`{"version":2,"plugins":{}}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(r.dist); err != nil {
			t.Fatal(err)
		}
		chaosUntil(t, 10*time.Second, func() (string, error) {
			text, err := os.ReadFile(settings)
			if err != nil {
				return "", err
			}
			if string(text) != original {
				return "", fmt.Errorf("settings not restored yet: %q", text)
			}
			return string(text), nil
		})
		chaosUntil(t, 10*time.Second, func() (string, error) {
			health, err := r.health()
			if err != nil {
				return "", err
			}
			if health.Mode != "retired" {
				return "", fmt.Errorf("mode = %s", health.Mode)
			}
			return health.Mode, nil
		})
		agentText, err := os.ReadFile(filepath.Join(agents, "chaos-big.md"))
		if err != nil {
			t.Fatal(err)
		}
		if string(agentText) != "---\nname: chaos-big\nmodel: opus\n---\n" {
			t.Fatalf("the agent after the uninstall = %q", agentText)
		}
		time.Sleep(1000 * time.Millisecond)
		refused, err := chaosSend(r, chaosModelBody("chaos-small", false), nil)
		if err != nil || refused.status != 400 {
			t.Fatalf("the provider past the uninstall = %d %v, want 400", refused.status, err)
		}
		if strings.TrimSpace(refused.body) != chaosRemovedBody {
			t.Fatalf("the 400 = %q, want %q", refused.body, chaosRemovedBody)
		}
		stats := clients.stop()
		if len(stats.errors) != 0 {
			t.Fatalf("the uninstall failed requests: %q", stats.errors)
		}
		if stats.ok <= 20 {
			t.Fatalf("ok = %d, want more than 20", stats.ok)
		}
		if !process.IsAlive(up.Pid) {
			t.Fatal("the front died before its cap")
		}

		// Past the cap (6 s here, 7 days in production) the retired router removes its files and
		// exits: the cleanup takes the whole directory.
		chaosUntil(t, 20*time.Second, func() (bool, error) {
			left, err := chaosRouterLeftovers(r)
			if err != nil {
				return false, err
			}
			if len(left) == 0 {
				return true, nil
			}
			return false, fmt.Errorf("the router directory still holds %q", left)
		})
		chaosUntil(t, 10*time.Second, func() (bool, error) {
			if !r.childGone(up.Pid) {
				return false, fmt.Errorf("still running")
			}
			return true, nil
		})
		if lines := chaosSpoolHealth(t, r.env["RADAR_HOME"]); len(lines) != 1 || lines[0]["event"] != "restart" {
			t.Fatalf("health lines = %q, want one restart", lines)
		}
	})
}

// chaosRouterLeftovers lists what the state's router directory still holds; a directory that is
// gone is an empty list, so the uninstall finale's check works for both platforms' shapes.
func chaosRouterLeftovers(r *chaosRig) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(r.state, "router"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

// chaosSendAsync sends on its own goroutine; the returned func awaits the answer with a deadline.
type chaosPending struct {
	answer chaosAnswer
	err    error
}

func chaosSendChan(t *testing.T, r *chaosRig, body string) <-chan chaosPending {
	t.Helper()
	out := make(chan chaosPending, 1)
	go func() {
		answer, err := chaosSend(r, body, nil)
		out <- chaosPending{answer: answer, err: err}
	}()
	return out
}

func chaosSendAsync(t *testing.T, r *chaosRig, body string) func() chaosPending {
	t.Helper()
	out := chaosSendChan(t, r, body)
	return func() chaosPending {
		select {
		case pending := <-out:
			return pending
		case <-time.After(30 * time.Second):
			t.Fatal("the request never answered")
			return chaosPending{}
		}
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func ptr(text string) *string { return &text }

// chaosWriteFile writes one file, failing the test when it cannot.
func chaosWriteFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// chaosKillPid SIGKILLs one pid (a worker), gone already being fine.
func chaosKillPid(t *testing.T, pid int64) {
	t.Helper()
	if pid == 0 {
		return
	}
	_ = syscall.Kill(int(pid), syscall.SIGKILL)
}

// chaosStopPid SIGSTOPs one pid: a worker frozen exactly like a blocked event loop.
func chaosStopPid(t *testing.T, pid int64) {
	t.Helper()
	if pid == 0 {
		return
	}
	if err := syscall.Kill(int(pid), syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
}

// chaosKillGroup SIGKILLs a process group (the front leads one; its workers share it), falling
// back to the pid alone, gone already being fine.
func chaosKillGroup(t *testing.T, pid int64) {
	t.Helper()
	if pid == 0 {
		return
	}
	if err := syscall.Kill(-int(pid), syscall.SIGKILL); err == nil {
		return
	}
	_ = syscall.Kill(int(pid), syscall.SIGKILL)
}

// chaosProcessesRunning counts the processes whose full command line matches the pattern.
func chaosProcessesRunning(t *testing.T, pattern string) int {
	t.Helper()
	return len(chaosPidsMatching(t, pattern))
}

// chaosPidsMatching is every live pid whose full command line matches the pattern.
func chaosPidsMatching(t *testing.T, pattern string) []int64 {
	t.Helper()
	answer, err := exec.Command("pgrep", "-f", regexp.QuoteMeta(pattern)).Output()
	if err != nil {
		return nil
	}
	var pids []int64
	for _, line := range strings.Split(strings.TrimSpace(string(answer)), "\n") {
		pid, err := strconv.ParseInt(line, 10, 64)
		if err != nil || pid == 0 {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

// chaosKillMatching ends every process whose full command line matches the pattern, each as its
// whole process group, and returns only once none is left: a posted SIGKILL is a request, not a
// death, and a caller that counts processes right after (the rig's stop, the case's proof) must
// not see one still dying. A process that outlasts the wait is a real leak and fails the test.
// The pattern carries a rig's own temp path, so only processes this test started can match.
func chaosKillMatching(t *testing.T, pattern string) {
	t.Helper()
	for _, pid := range chaosPidsMatching(t, pattern) {
		chaosKillGroup(t, pid)
	}
	chaosUntil(t, 10*time.Second, func() (bool, error) {
		if left := chaosProcessesRunning(t, pattern); left != 0 {
			return false, fmt.Errorf("%d processes matching %q still alive", left, pattern)
		}
		return true, nil
	})
}

// chaosMkfifo makes a named pipe, skipping where mkfifo does not exist.
func chaosMkfifo(t *testing.T, path string) {
	t.Helper()
	mkfifo, err := exec.LookPath("mkfifo")
	if err != nil {
		t.Skipf("no mkfifo on this platform: %v", err)
	}
	if err := exec.Command(mkfifo, path).Run(); err != nil {
		t.Fatal(err)
	}
}

// chaosSymlink links one path to a target.
func chaosSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// chaosProveBundleProcess proves a router pid runs the suite's copied bundle by its command line:
// the first argument is the bundle's own path.
func chaosProveBundleProcess(t *testing.T, pid int64) {
	t.Helper()
	command, ok := router.CommandLineOf(context.Background(), pid)
	if !ok {
		t.Fatalf("no command line for %d", pid)
	}
	if first, _, _ := strings.Cut(command, " "); filepath.Base(first) != "plugin-core" {
		t.Fatalf("pid %d runs %q", pid, command)
	}
}

// chaosBundleBytes is the dist bundle's new bytes: this binary behind a shell wrapper whose bytes
// change with `extra`, so a rewrite is a new version while it still runs this binary.
func chaosBundleBytes(t *testing.T, extra string) []byte {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\n%s\nexec %q \"$@\"\n", extra, self)
	return []byte(script)
}

// TestChaosStopSweepsUnrecordedRouters proves the rig's stop ends a router the rig never recorded
// (a front a handover or a setup command started after the last health poll): such a front runs in
// its own session, so nothing but the sweep ends it, and it holds its port and its temp dir
// forever.
func TestChaosStopSweepsUnrecordedRouters(t *testing.T) {
	t.Parallel()
	var pattern string
	var spawned process.Detached
	t.Run("a router the rig never recorded", func(t *testing.T) {
		r := newChaosRig(t, chaosRigOptions{})
		files, err := router.CopyRouterFiles(context.Background(),
			filepath.Join(r.dist, "plugin-core"), r.state)
		if err != nil {
			t.Fatal(err)
		}
		port, err := router.FreePort()
		if err != nil {
			t.Fatal(err)
		}
		// The env a start hands a front, with none of the rig's bookkeeping: this is the front a
		// handover or a setup command starts that no health poll ever names.
		env := map[string]string{}
		for name, value := range r.env {
			env[name] = value
		}
		env["CHAOS_ROUTER_PORT"] = strconv.Itoa(port)
		env[chaosChildEnvName] = chaosChildModeName
		env[chaosChildStateName] = r.state
		spawned = process.StartDetached(files.Binary, []string{"chaos", "router", "run"},
			process.DetachedOptions{Env: chaosEnvSlice(env)})
		if spawned.Pid == 0 {
			t.Fatal("the unrecorded router never started")
		}
		pattern = r.routerRunPattern()
		// It is a live router: it answers health on its port.
		probe := &http.Client{Timeout: 2 * time.Second}
		chaosUntil(t, 10*time.Second, func() (bool, error) {
			answer, err := probe.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, chaosHealthPath))
			if err != nil {
				return false, err
			}
			defer answer.Body.Close()
			_, _ = io.ReadAll(answer.Body)
			return answer.StatusCode == 200, nil
		})
		// The subtest ends here; the rig's stop runs as its cleanup.
	})
	// The test ends its own process even when the sweep does not, so a failing run leaves nothing
	// behind.
	t.Cleanup(func() { chaosKillGroup(t, int64(spawned.Pid)) })
	_ = spawned.Exited()
	if left := chaosProcessesRunning(t, pattern); left != 0 {
		t.Fatalf("%d routers the rig never recorded survived its stop (%s)", left, pattern)
	}
}

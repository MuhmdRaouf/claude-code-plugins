package fakedeps

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// Direct tests of the support tail (writeAgents, FakeHost, fakeDeps) and its stand-ins, which
// the app and CLI suites reuse.

// aSpec is one run of the worker against a log under a temp dir.
func aSpec(logPath string) ports.WorkerSpec {
	return ports.WorkerSpec{
		Cwd:     "/repo",
		Model:   domain.ModelRef{Tier: domain.ModelTierMain, ID: "glm-5.3", Label: "GLM 5.3"},
		Access:  ports.AccessWrite,
		Prompt:  "Rename `foo` to `bar` everywhere.",
		Session: ports.WorkerSession{Kind: ports.SessionKindNew, Key: "s-1"},
		LogPath: logPath,
	}
}

// drain reads a run's events until its stream ends.
func drain(t *testing.T, run ports.WorkerRun) []domain.WorkerEvent {
	t.Helper()
	var events []domain.WorkerEvent
	for event := range run.Events() {
		events = append(events, event)
	}
	return events
}

func TestFakeDeps(t *testing.T) {
	ctx := context.Background()

	t.Run("builds the Deps over the same fakes", func(t *testing.T) {
		f := FakeDeps(t)
		deps := f.Deps
		if deps.Worker != ports.Worker(f.Worker) {
			t.Error("Worker is not the scripted worker")
		}
		if deps.Store != ports.JobStore(f.Store) {
			t.Error("Store is not the memory store")
		}
		if deps.Git != ports.Git(f.Git) {
			t.Error("Git is not the fake git")
		}
		if deps.Gates != ports.GateRunner(f.Gates) {
			t.Error("Gates is not the fake gates")
		}
		if deps.Limiter != ports.LimiterStore(f.Limiter) {
			t.Error("Limiter is not the fake limiter")
		}
		if deps.Semaphore != ports.Semaphore(f.Semaphore) {
			t.Error("Semaphore is not the fake semaphore")
		}
		if deps.Clock != ports.Clock(f.Clock) {
			t.Error("Clock is not the manual clock")
		}
		if deps.Ids != ports.Ids(f.Ids) {
			t.Error("Ids is not the fake ids")
		}
		if deps.Process != ports.ProcessControl(f.Process) {
			t.Error("Process is not the fake process control")
		}
		if deps.Out != ports.Output(f.Out) {
			t.Error("Out is not the recording output")
		}
		if deps.Files != f.Files || deps.EngineConfig != f.EngineConfig {
			t.Error("Files and EngineConfig are not the fakes' own")
		}
		if f.Spool == nil {
			t.Error("Spool is not wired")
		}
		if deps.Engines != nil {
			t.Error("Engines is set, want none until a test wires one")
		}
	})

	t.Run("roots everything under a fresh temp dir", func(t *testing.T) {
		first, second := FakeDeps(t), FakeDeps(t)
		if first.Root == "" || first.Root == second.Root {
			t.Errorf("roots = %q and %q, want two fresh temp dirs", first.Root, second.Root)
		}
		if !strings.HasPrefix(first.Store.Paths("j1").Dir, first.Root) {
			t.Errorf("job dir %s is not under %s", first.Store.Paths("j1").Dir, first.Root)
		}
		if first.Deps.Host.StateRoot != first.Root {
			t.Errorf("StateRoot = %q, want %s", first.Deps.Host.StateRoot, first.Root)
		}
	})

	t.Run("wires the reference provider, the fixed config and the limiter defaults", func(t *testing.T) {
		f := FakeDeps(t)
		if !reflect.DeepEqual(f.Deps.Provider, testkit.ReferenceProvider) {
			t.Error("Provider is not the reference provider")
		}
		want := app.Config{Limiter: domain.DEFAULT_LIMITER, Prompt: domain.DefaultLimits, StopGraceMs: 100}
		if f.Deps.Config != want {
			t.Errorf("Config = %+v, want %+v", f.Deps.Config, want)
		}
	})

	t.Run("ships the plugin's agents on sonnet beside the bundle", func(t *testing.T) {
		f := FakeDeps(t)
		bundle := filepath.Join(f.Root, "plugin", "dist", "zai.js")
		if f.Deps.BundlePath != bundle {
			t.Errorf("BundlePath = %q, want %s", f.Deps.BundlePath, bundle)
		}
		for _, agent := range []string{"glm-5.3", "glm-5.3-flash"} {
			text, err := os.ReadFile(filepath.Join(f.Root, "plugin", "agents", agent+".md"))
			if err != nil {
				t.Fatalf("read agent %s: %v", agent, err)
			}
			if string(text) != "model: sonnet\n" {
				t.Errorf("agent %s = %q, want model: sonnet", agent, text)
			}
		}
	})

	t.Run("puts HOME under the root and passes the env through", func(t *testing.T) {
		f := FakeDepsIn(t, map[string]string{"ZAI_API_KEY": "sk-test", "RADAR_HOME": "/tmp/radar"}, FakeWorld{})
		if got := f.Deps.Env["HOME"]; got != filepath.Join(f.Root, "home") {
			t.Errorf("HOME = %q, want the one under the root", got)
		}
		if f.Deps.Env["ZAI_API_KEY"] != "sk-test" || f.Deps.Env["RADAR_HOME"] != "/tmp/radar" {
			t.Errorf("Env = %v, want the caller's values kept", f.Deps.Env)
		}
	})

	t.Run("an explicit HOME always wins", func(t *testing.T) {
		f := FakeDepsIn(t, map[string]string{"HOME": "/sandbox/home"}, FakeWorld{})
		if got := f.Deps.Env["HOME"]; got != "/sandbox/home" {
			t.Errorf("HOME = %q, want the explicit one", got)
		}
	})

	t.Run("the default worker completes a run", func(t *testing.T) {
		f := FakeDeps(t)
		run, err := f.Worker.Start(ctx, aSpec(filepath.Join(t.TempDir(), "attempt-1.jsonl")))
		if err != nil {
			t.Fatal(err)
		}
		events := drain(t, run)
		if len(events) != 3 || events[0].Kind != domain.WorkerEventInit ||
			events[1].Kind != domain.WorkerEventAssistantText || events[2].Kind != domain.WorkerEventResult {
			t.Fatalf("events = %+v, want init, assistant_text, result", events)
		}
		if exit := run.Wait(); exit.Code == nil || *exit.Code != 0 {
			t.Errorf("exit = %+v, want code 0", exit)
		}
	})

	t.Run("the spool reader reads the env's RADAR_HOME", func(t *testing.T) {
		radar := t.TempDir()
		f := FakeDepsIn(t, map[string]string{"RADAR_HOME": radar}, FakeWorld{})
		spoolDir := filepath.Join(radar, "spool")
		if err := os.MkdirAll(spoolDir, 0o755); err != nil {
			t.Fatal(err)
		}
		today := time.Now().Format("2006-01-02")
		line := `{"ts":"2026-10-06T00:00:00.000Z","event":"route","plugin":"zai","model":"glm-5.3","route":"provider","status":200}`
		if err := os.WriteFile(filepath.Join(spoolDir, today+".jsonl"), []byte(line+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		events := f.Deps.Spool.Events(time.Now().UnixMilli(), 1)
		if len(events) != 1 {
			t.Fatalf("events = %+v, want the spooled route", events)
		}
		if route, ok := events[0].(domain.RouteEvent); !ok || route.Plugin != "zai" || route.Status != 200 {
			t.Errorf("event = %+v, want zai's route event", events[0])
		}
	})

	t.Run("a world swaps the provider, the dialect and the host", func(t *testing.T) {
		acme := testkit.AcmeProvider
		dialect := fakes.EVENT_DIALECT
		dialect.Caps = ports.WorkerCapabilities{WorkerTerms: testkit.AcmeWorker}
		world := FakeWorld{
			Provider: &acme,
			Dialect:  &dialect,
			Host: func(root string) *FakeHost {
				host := NewFakeHost(root)
				host.Router = "running on http://127.0.0.1:19999 (pid 7)"
				return host
			},
		}
		f := FakeDepsIn(t, nil, world)

		if f.Deps.Provider.Name != "acme" {
			t.Errorf("Provider = %q, want acme", f.Deps.Provider.Name)
		}
		if got := f.Deps.BundlePath; !strings.HasSuffix(got, "acme.js") {
			t.Errorf("BundlePath = %q, want acme's", got)
		}
		agent, err := os.ReadFile(filepath.Join(f.Root, "plugin", "agents", "big-model-9.md"))
		if err != nil || string(agent) != "model: sonnet\n" {
			t.Errorf("acme's main agent = %q (%v), want sonnet", agent, err)
		}
		if got := f.Worker.Caps(); !reflect.DeepEqual(got, dialect.Caps) {
			t.Errorf("Caps = %+v, want the world dialect's", got)
		}
		line, err := f.Deps.Host.EnsureRouter(ctx)
		if err != nil || line != "running on http://127.0.0.1:19999 (pid 7)" {
			t.Errorf("EnsureRouter() = %q, %v, want the world host's line", line, err)
		}
		if !f.Process.IsAlive(int64(os.Getpid())) {
			t.Error("the worker and the host share the fake process control")
		}
	})
}

func TestFakeHost(t *testing.T) {
	ctx := context.Background()

	t.Run("reports the router running on the reference provider's port", func(t *testing.T) {
		host := NewFakeHost("/tmp/state")
		line, err := host.HostInfo().EnsureRouter(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if line != "running on http://127.0.0.1:18787 (pid 4242)" {
			t.Errorf("EnsureRouter() = %q, want the reference provider's port", line)
		}
	})

	t.Run("carries the claude-shaped host facts", func(t *testing.T) {
		info := NewFakeHost("/tmp/state").HostInfo()
		if info.StateRoot != "/tmp/state" {
			t.Errorf("StateRoot = %q", info.StateRoot)
		}
		if info.WorkerBin != "/usr/local/bin/claude" {
			t.Errorf("WorkerBin = %q", info.WorkerBin)
		}
		if info.Runtime != "bun 1.3.14 (/usr/local/bin/bun)" {
			t.Errorf("Runtime = %q", info.Runtime)
		}
		if version, err := info.WorkerVersion(ctx); err != nil || version != "2.1.289 (Claude Code)" {
			t.Errorf("WorkerVersion() = %q, %v", version, err)
		}
		key, err := info.LoadKey(ctx)
		if err != nil || key != (ports.ProviderKey{Value: "zai-test-key", Source: "ZAI_API_KEY"}) {
			t.Errorf("LoadKey() = %+v, %v", key, err)
		}
		if line, err := info.RetireRouter(ctx); err != nil || line != "stopped (was not running)" {
			t.Errorf("RetireRouter() = %q, %v", line, err)
		}
		if source, err := info.RouterKey(ctx); err != nil || source != "ZAI_API_KEY" {
			t.Errorf("RouterKey() = %q, %v", source, err)
		}
		if info.KeyEntry != nil {
			t.Error("KeyEntry is set, want absent until a key-page test sets one")
		}
	})

	t.Run("answers read the fields a test overrides", func(t *testing.T) {
		host := NewFakeHost("/tmp/state")
		host.VersionErr = errString("claude not found")
		host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key"}
		host.RouterErr = errString("launchd refused")
		host.RouterRetireErr = errString("still serving")
		host.RouterKeyErr = errString("no key in the store")
		info := host.HostInfo()

		if _, err := info.WorkerVersion(ctx); err == nil || err.Error() != "claude not found" {
			t.Errorf("WorkerVersion() error = %v", err)
		}
		if _, err := info.LoadKey(ctx); err == nil || err.Error() != "no Z.ai key" {
			t.Errorf("LoadKey() error = %v, want the worker error", err)
		}
		if _, err := info.EnsureRouter(ctx); err == nil || err.Error() != "launchd refused" {
			t.Errorf("EnsureRouter() error = %v", err)
		}
		if _, err := info.RetireRouter(ctx); err == nil || err.Error() != "still serving" {
			t.Errorf("RetireRouter() error = %v", err)
		}
		if _, err := info.RouterKey(ctx); err == nil || err.Error() != "no key in the store" {
			t.Errorf("RouterKey() error = %v", err)
		}
	})

	t.Run("extra checks report the key line as zai does", func(t *testing.T) {
		checks := NewFakeHost("/tmp/state").HostInfo().ExtraChecks(ctx)
		want := []app.SetupCheck{{
			Label:  "key",
			Result: app.StringResult{OK: true, Value: "ZAI_API_KEY"},
			Text:   "present (ZAI_API_KEY)",
		}}
		if !reflect.DeepEqual(checks, want) {
			t.Errorf("ExtraChecks() = %+v, want %+v", checks, want)
		}
	})

	t.Run("extra checks describe a key that did not load", func(t *testing.T) {
		host := NewFakeHost("/tmp/state")
		host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key"}
		checks := host.HostInfo().ExtraChecks(ctx)
		want := []app.SetupCheck{{
			Label:  "key",
			Result: app.StringResult{Error: "no Z.ai key"},
			Text:   "MISSING: no Z.ai key",
		}}
		if !reflect.DeepEqual(checks, want) {
			t.Errorf("ExtraChecks() = %+v, want %+v", checks, want)
		}
	})

	t.Run("names another provider's port", func(t *testing.T) {
		host := NewFakeHost("/tmp/state", testkit.AcmeProvider)
		line, err := host.HostInfo().EnsureRouter(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if line != "running on http://127.0.0.1:18800 (pid 4242)" {
			t.Errorf("EnsureRouter() = %q, want acme's port", line)
		}
	})
}

// errString is a Result's error arm as a plain error.
func errString(text string) error { return &stringError{text} }

type stringError struct{ text string }

func (e *stringError) Error() string { return e.text }

func TestWriteAgents(t *testing.T) {
	root := t.TempDir()

	t.Run("writes the tier agents beside the bundle on sonnet", func(t *testing.T) {
		bundle := filepath.Join(root, "a", "plugin", "dist", "zai.js")
		WriteAgents(bundle, testkit.ReferenceProvider)
		for _, agent := range []string{"glm-5.3", "glm-5.3-flash"} {
			text, err := os.ReadFile(filepath.Join(root, "a", "plugin", "agents", agent+".md"))
			if err != nil {
				t.Fatalf("read agent %s: %v", agent, err)
			}
			if string(text) != "model: sonnet\n" {
				t.Errorf("agent %s = %q, want model: sonnet", agent, text)
			}
		}
	})

	t.Run("takes another model", func(t *testing.T) {
		bundle := filepath.Join(root, "b", "plugin", "dist", "zai.js")
		WriteAgents(bundle, testkit.ReferenceProvider, "glm-5.3")
		text, err := os.ReadFile(filepath.Join(root, "b", "plugin", "agents", "glm-5.3.md"))
		if err != nil {
			t.Fatal(err)
		}
		if string(text) != "model: glm-5.3\n" {
			t.Errorf("agent = %q, want model: glm-5.3", text)
		}
	})

	t.Run("panics when the agents dir cannot be made", func(t *testing.T) {
		plugin := filepath.Join(root, "c", "plugin")
		if err := os.MkdirAll(plugin, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(plugin, "agents"), []byte("in the way\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if recover() == nil {
				t.Error("WriteAgents should panic when the agents dir cannot be made")
			}
		}()
		WriteAgents(filepath.Join(plugin, "dist", "zai.js"), testkit.ReferenceProvider)
	})

	t.Run("panics when an agent file cannot be written", func(t *testing.T) {
		agents := filepath.Join(root, "d", "plugin", "agents")
		if err := os.MkdirAll(filepath.Join(agents, "glm-5.3.md"), 0o755); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if recover() == nil {
				t.Error("WriteAgents should panic when an agent file cannot be written")
			}
		}()
		WriteAgents(filepath.Join(root, "d", "plugin", "dist", "zai.js"), testkit.ReferenceProvider)
	})
}

func TestReferenceStateRoot(t *testing.T) {
	t.Run("is zai's rule", func(t *testing.T) {
		want := adapters.StateRootRule{EnvVar: "ZAI_STATE_DIR", DataPrefix: "zai-", XdgName: "zai"}
		if ReferenceStateRoot != want {
			t.Errorf("ReferenceStateRoot = %+v, want %+v", ReferenceStateRoot, want)
		}
		if got := adapters.NewStateRootRule(providers.Zai); got != ReferenceStateRoot {
			t.Errorf("NewStateRootRule(zai) = %+v, want the reference rule", got)
		}
	})
}

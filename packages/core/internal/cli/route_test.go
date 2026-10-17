package cli_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// routedEnv is the ANTHROPIC_BASE_URL of a session Claude Code routes through this plugin's router.
const routedEnv = "http://127.0.0.1:18787"

const retiredLine = "retired (pid 4242): keeps Claude working in open sessions, exits when they close"

func strPtr(text string) *string { return &text }

// agentMd is an agent file as the plugin ships it: sonnet until setup rewrites the line.
func agentMd(name string) string {
	return "---\nname: " + name + "\nmodel: sonnet\n---\n\nYou are a " + name + " worker.\n"
}

func shippedAgents(t *testing.T, root string) {
	t.Helper()
	dir := filepath.Join(root, "plugin", "agents")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	for _, name := range []string{"glm-5.3", "glm-5.3-flash", "omp", "opencode", "pi", "zcode"} {
		if err := os.WriteFile(filepath.Join(dir, name+".md"), []byte(agentMd(name)), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func agentText(t *testing.T, root, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "plugin", "agents", name+".md"))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

// harness is the setup wiring's slice, over recorded stubs, the shipped agents and a sandboxed
// HOME in a temp root.
type harness struct {
	root string
	env  map[string]string

	out *fakes.RecordingOutput
	// Each pair holds one wiring answer and its error: the key check, the router line, the
	// router's key check, and the retire.
	key          ports.ProviderKey
	keyErr       *ports.WorkerError
	router       string
	routerErr    error
	routerKey    string
	routerKeyErr error
	retired      string
	retireErr    error

	keyCalls    int
	ensureCalls int
	retireCalls int
}

func newHarness(t *testing.T, env map[string]string) *harness {
	t.Helper()
	root := testkit.TempDir(t, "core-route-")
	shippedAgents(t, root)
	return &harness{
		root:      root,
		env:       env,
		out:       &fakes.RecordingOutput{},
		key:       ports.ProviderKey{Value: "test-key", Source: "ZAI_API_KEY"},
		router:    "running on http://127.0.0.1:18787 (pid 4242)",
		routerKey: "ZAI_API_KEY",
		retired:   retiredLine,
	}
}

func (h *harness) fullEnv() domain.EnvLookup {
	env := domain.EnvLookup{
		"HOME":                  filepath.Join(h.root, "home"),
		"PROVIDER_ROUTERS_HOME": filepath.Join(h.root, "routers"),
	}
	for name, value := range h.env {
		env[name] = value
	}
	return env
}

func (h *harness) bundlePath() string {
	return filepath.Join(h.root, "plugin", "dist", "zai.js")
}

func (h *harness) deps() cli.SetupDeps {
	return cli.SetupDeps{
		Provider:     testkit.ReferenceProvider,
		Env:          h.fullEnv(),
		StateRoot:    h.root,
		BundlePath:   h.bundlePath(),
		Out:          h.out,
		SettingsPath: adapters.ClaudeSettingsPath(h.fullEnv()),
		EngineConfig: adapters.CreateFsEngineConfig(h.root),
		LoadKey: func(context.Context) (ports.ProviderKey, error) {
			h.keyCalls++
			if h.keyErr != nil {
				return ports.ProviderKey{}, h.keyErr
			}
			return h.key, nil
		},
		EnsureRouter: func(context.Context) (string, error) {
			h.ensureCalls++
			return h.router, h.routerErr
		},
		RetireRouter: func(context.Context) (string, error) {
			h.retireCalls++
			return h.retired, h.retireErr
		},
		RouterKey: func(context.Context) (string, error) {
			return h.routerKey, h.routerKeyErr
		},
	}
}

// healthyServer is a loopback server that answers one plugin router's health path the way a router
// does, on an OS-picked 127.0.0.1 port.
func healthyServer(t *testing.T, healthPath string) int {
	t.Helper()
	name := strings.TrimSuffix(strings.Split(healthPath, "/")[1], "-router")
	display := name
	if name == "zai" {
		display = "Z.ai GLM"
	}
	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "name": name, "provider": display})
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return listener.Addr().(*net.TCPAddr).Port
}

func settingsOf(t *testing.T, h *harness) map[string]any {
	t.Helper()
	data, err := os.ReadFile(h.deps().SettingsPath)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("parse settings: %v", err)
	}
	return parsed
}

func envOf(t *testing.T, settings map[string]any) map[string]any {
	t.Helper()
	env, _ := settings["env"].(map[string]any)
	return env
}

// jsonValue is a JSON literal as the parsed value toEqual compares against.
func jsonValue(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return value
}

func TestSetupDoneRecord(t *testing.T) {
	t.Run("round-trips, and clearing removes it", func(t *testing.T) {
		root := testkit.TempDir(t, "core-route-")
		if cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone = true, want false")
		}
		cli.RecordSetupDone(root)
		if !cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone = false after recording, want true")
		}
		cli.ClearSetupDone(root)
		if cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone = true after clearing, want false")
		}
	})

	t.Run("reads a legacy route file: provider counts, sonnet and garbage do not", func(t *testing.T) {
		root := testkit.TempDir(t, "core-route-")
		mark := filepath.Join(root, "route")
		for _, text := range []string{"sonnet\n", "provider-ish\n"} {
			if err := os.WriteFile(mark, []byte(text), 0o644); err != nil {
				t.Fatalf("write mark: %v", err)
			}
			if cli.ReadSetupDone(root) {
				t.Fatalf("readSetupDone(%q) = true, want false", text)
			}
		}
		if err := os.WriteFile(mark, []byte("provider\n"), 0o644); err != nil {
			t.Fatalf("write mark: %v", err)
		}
		if !cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone(provider) = false, want true")
		}
	})

	t.Run("recording replaces the legacy file with the mark", func(t *testing.T) {
		root := testkit.TempDir(t, "core-route-")
		if err := os.WriteFile(filepath.Join(root, "route"), []byte("provider\n"), 0o644); err != nil {
			t.Fatalf("write mark: %v", err)
		}

		cli.RecordSetupDone(root)

		if !cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone = false, want true")
		}
		// rmSync(..., { force: true }): gone already is fine.
		if err := os.Remove(filepath.Join(root, "route")); err != nil && !os.IsNotExist(err) {
			t.Fatalf("remove legacy mark: %v", err)
		}
		if !cli.ReadSetupDone(root) {
			t.Fatal("readSetupDone = false without the legacy file, want true")
		}
		if got := domain.NewStateLayout(root).SetupDone; got != filepath.Join(root, "setup-done") {
			t.Fatalf("setupDone path = %q, want %q", got, filepath.Join(root, "setup-done"))
		}
	})
}

func TestApplyAgentModels(t *testing.T) {
	t.Run("rewrites both agents' model lines to the provider's catalog ids", func(t *testing.T) {
		h := newHarness(t, nil)

		got := cli.ApplyAgentModels(context.Background(), h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsProvider, domain.EnvLookup{})

		want := cli.AgentsResult{OK: true, Value: []cli.AgentModel{
			{Tier: "main", Agent: "glm-5.3", Model: "glm-5.3", Changed: true, Before: strPtr("sonnet")},
			{Tier: "flash", Agent: "glm-5.3-flash", Model: "glm-5.3-flash", Changed: true, Before: strPtr("sonnet")},
		}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("applyAgentModels = %+v, want %+v", got, want)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		if text := agentText(t, h.root, "glm-5.3-flash"); !strings.Contains(text, "model: glm-5.3-flash") {
			t.Fatalf("glm-5.3-flash agent = %q, want a model: glm-5.3-flash line", text)
		}
	})

	t.Run("honours the model env overrides, per tier", func(t *testing.T) {
		h := newHarness(t, nil)

		cli.ApplyAgentModels(context.Background(), h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsProvider, domain.EnvLookup{
			"ZAI_MODEL_MAIN":  "glm-5.5",
			"ZAI_MODEL_FLASH": "glm-5.5-flash",
		})

		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.5") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.5 line", text)
		}
		if text := agentText(t, h.root, "glm-5.3-flash"); !strings.Contains(text, "model: glm-5.5-flash") {
			t.Fatalf("glm-5.3-flash agent = %q, want a model: glm-5.5-flash line", text)
		}
	})

	t.Run("sonnet restores the shipped default on both agents", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyAgentModels(ctx, h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsProvider, domain.EnvLookup{})

		cli.ApplyAgentModels(ctx, h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsSonnet, domain.EnvLookup{})

		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
		if text := agentText(t, h.root, "glm-5.3-flash"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3-flash agent = %q, want a model: sonnet line", text)
		}
	})

	t.Run("names a missing agent file", func(t *testing.T) {
		h := newHarness(t, nil)
		if err := os.Remove(filepath.Join(h.root, "plugin", "agents", "glm-5.3-flash.md")); err != nil {
			t.Fatalf("remove agent: %v", err)
		}

		got := cli.ApplyAgentModels(context.Background(), h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsProvider, domain.EnvLookup{})

		if got.OK || !strings.Contains(got.Error, "glm-5.3-flash.md: not found") {
			t.Fatalf("applyAgentModels = %+v, want error containing %q", got, "glm-5.3-flash.md: not found")
		}
	})

	t.Run("names an agent without a model line", func(t *testing.T) {
		h := newHarness(t, nil)
		if err := os.WriteFile(filepath.Join(h.root, "plugin", "agents", "glm-5.3.md"),
			[]byte("---\nname: glm-5.3\n---\nno model\n"), 0o644); err != nil {
			t.Fatalf("write agent: %v", err)
		}

		got := cli.ApplyAgentModels(context.Background(), h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsProvider, domain.EnvLookup{})

		if got.OK || !strings.Contains(got.Error, "glm-5.3.md: no model: line") {
			t.Fatalf("applyAgentModels = %+v, want error containing %q", got, "glm-5.3.md: no model: line")
		}
	})

	t.Run("leaves an agent that already has the wanted model alone (a read-only file survives)", func(t *testing.T) {
		h := newHarness(t, nil)
		for _, name := range []string{"glm-5.3", "glm-5.3-flash"} {
			if err := os.Chmod(filepath.Join(h.root, "plugin", "agents", name+".md"), 0o444); err != nil {
				t.Fatalf("chmod %s: %v", name, err)
			}
		}

		got := cli.ApplyAgentModels(context.Background(), h.bundlePath(), testkit.ReferenceProvider, cli.AgentModelsSonnet, domain.EnvLookup{})

		if !got.OK {
			t.Fatalf("applyAgentModels = %+v, want ok", got)
		}
	})
}

func TestModelsReportLine(t *testing.T) {
	t.Run("names each model alone while the agent named after it runs it, else the agent and what it runs", func(t *testing.T) {
		shipped := cli.AgentModel{Tier: "main", Agent: "glm-5.3", Model: "glm-5.3", Changed: false}
		sonnet := cli.AgentModel{Tier: "flash", Agent: "glm-5.3-flash", Model: "sonnet", Changed: true}

		flash := sonnet
		flash.Model = "glm-5.3-flash"
		if got := cli.AgentText(cli.AgentsResult{OK: true, Value: []cli.AgentModel{shipped, flash}}); got != "glm-5.3, glm-5.3-flash" {
			t.Fatalf("agentText = %q, want %q", got, "glm-5.3, glm-5.3-flash")
		}
		moved := shipped
		moved.Model = "glm-5.5"
		if got := cli.AgentText(cli.AgentsResult{OK: true, Value: []cli.AgentModel{moved, sonnet}}); got != "glm-5.3 → glm-5.5, glm-5.3-flash → sonnet" {
			t.Fatalf("agentText = %q, want %q", got, "glm-5.3 → glm-5.5, glm-5.3-flash → sonnet")
		}
		if got := cli.AgentText(cli.AgentsResult{Error: "glm-5.3.md: not found"}); got != "FAILED: glm-5.3.md: not found" {
			t.Fatalf("agentText = %q, want %q", got, "FAILED: glm-5.3.md: not found")
		}
	})
}

func TestBaseUrlReport(t *testing.T) {
	t.Run("is ok when ANTHROPIC_BASE_URL points at this plugin's router", func(t *testing.T) {
		ok, text := cli.BaseUrlReport(testkit.ReferenceProvider, domain.EnvLookup{"ANTHROPIC_BASE_URL": routedEnv})

		if !ok {
			t.Fatal("ok = false, want true")
		}
		if !strings.Contains(text, "zai router (http://127.0.0.1:18787)") {
			t.Fatalf("text = %q, want it to name the zai router url", text)
		}
	})

	t.Run("names the other plugin when it points at another router", func(t *testing.T) {
		ok, text := cli.BaseUrlReport(testkit.ReferenceProvider, domain.EnvLookup{"ANTHROPIC_BASE_URL": "http://127.0.0.1:18788"})

		if ok {
			t.Fatal("ok = true, want false")
		}
		if !strings.Contains(text, "kimi plugin's router") {
			t.Fatalf("text = %q, want it to name the kimi plugin", text)
		}
		if !strings.Contains(text, "run /zai:setup to point Claude Code at the zai router") {
			t.Fatalf("text = %q, want it to name the setup command", text)
		}
	})

	t.Run("says unset or elsewhere when it points nowhere known, and follows the router port override", func(t *testing.T) {
		_, text := cli.BaseUrlReport(testkit.ReferenceProvider, domain.EnvLookup{})
		if !strings.Contains(text, "unset or elsewhere") {
			t.Fatalf("text = %q, want it to say unset or elsewhere", text)
		}
		if !strings.Contains(text, "run /zai:setup to point Claude Code at the zai router") {
			t.Fatalf("text = %q, want it to name the setup command", text)
		}
		ok, _ := cli.BaseUrlReport(testkit.ReferenceProvider, domain.EnvLookup{
			"ZAI_ROUTER_PORT":    "19000",
			"ANTHROPIC_BASE_URL": "http://127.0.0.1:19000",
		})
		if !ok {
			t.Fatal("ok = false with the port override matching, want true")
		}
	})

	t.Run("never asks for an export, whatever the base URL points at", func(t *testing.T) {
		envs := []domain.EnvLookup{
			{"ANTHROPIC_BASE_URL": routedEnv},
			{"ANTHROPIC_BASE_URL": "http://127.0.0.1:18788"},
			{"ANTHROPIC_BASE_URL": "http://127.0.0.1:9999"},
			{},
		}
		for _, env := range envs {
			_, text := cli.BaseUrlReport(testkit.ReferenceProvider, env)
			if strings.Contains(text, "export") {
				t.Fatalf("BaseUrlReport(%v) = %q, want no line that asks for an export", env, text)
			}
		}
	})
}

func TestApplyRouting(t *testing.T) {
	t.Run("starts the router, announces it in the registry, merges settings and rewrites the agents", func(t *testing.T) {
		h := newHarness(t, nil)

		applied := cli.ApplyRouting(context.Background(), h.deps())

		if !applied.Router.OK || !applied.Settings.OK || !applied.Agents.OK {
			t.Fatalf("applied = %+v, want router, settings and agents ok", applied)
		}
		if h.ensureCalls != 1 {
			t.Fatalf("ensureCalls = %d, want 1", h.ensureCalls)
		}
		registryRaw, err := os.ReadFile(filepath.Join(h.root, "routers", "zai.json"))
		if err != nil {
			t.Fatalf("read registry entry: %v", err)
		}
		var registry map[string]any
		if err := json.Unmarshal(registryRaw, &registry); err != nil {
			t.Fatalf("parse registry entry: %v", err)
		}
		if registry["name"] != "zai" || registry["port"] != float64(18787) {
			t.Fatalf("registry entry = %v, want zai on 18787", registry)
		}
		if got, want := registry["catalogIds"], []any{"glm-5.3", "glm-5.3-flash"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("catalogIds = %v, want %v", got, want)
		}
		caPath, _ := envOf(t, settingsOf(t, h))["NODE_EXTRA_CA_CERTS"].(string)
		want := jsonValue(t, fmt.Sprintf(`{
			"modelPicker": {
				"options": [
					{"model": "glm-5.3", "label": "GLM 5.3", "behavesAs": "claude-opus-5-5"},
					{"model": "glm-5.3-flash", "label": "GLM 5.3 Flash", "behavesAs": "claude-opus-5-5"}
				]
			},
			"env": {"HTTPS_PROXY": "http://127.0.0.1:18787", "NODE_EXTRA_CA_CERTS": %q,
				"NO_PROXY": "localhost,127.0.0.1", "ENABLE_TOOL_SEARCH": "true"},
			"modelSettings": {
				"glm-5.3": {"effortLevel": "xhigh"},
				"glm-5.3-flash": {"effortLevel": "xhigh"}
			}
		}`, caPath))
		if got := settingsOf(t, h); !reflect.DeepEqual(got, want) {
			t.Fatalf("settings = %v, want %v", got, want)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		if !cli.ReadSetupDone(h.root) {
			t.Fatal("readSetupDone = false, want true")
		}
	})

	t.Run("writes the three proxy keys and no base URL, with the CA file at the path written", func(t *testing.T) {
		h := newHarness(t, nil)

		applied := cli.ApplyRouting(context.Background(), h.deps())

		if !applied.Settings.OK {
			t.Fatalf("settings = %+v, want ok", applied.Settings)
		}
		env := envOf(t, settingsOf(t, h))
		if got := env["HTTPS_PROXY"]; got != routedEnv {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, routedEnv)
		}
		if got := env["NO_PROXY"]; got != "localhost,127.0.0.1" {
			t.Fatalf("NO_PROXY = %v, want the loopback entries", got)
		}
		if _, has := env["ANTHROPIC_BASE_URL"]; has {
			t.Fatal("settings keep ANTHROPIC_BASE_URL, want proxy mode without it")
		}
		if got := env["ENABLE_TOOL_SEARCH"]; got != "true" {
			t.Fatalf("ENABLE_TOOL_SEARCH = %v, want true", got)
		}
		caPath, _ := env["NODE_EXTRA_CA_CERTS"].(string)
		caPEM, err := os.ReadFile(caPath)
		if err != nil {
			t.Fatalf("read the CA file the merge wrote: %v", err)
		}
		if !strings.HasPrefix(string(caPEM), "-----BEGIN CERTIFICATE-----") {
			t.Fatalf("NODE_EXTRA_CA_CERTS = %q, want a PEM certificate file", caPath)
		}
		if lines := applied.Settings.Value; len(lines) == 0 || lines[len(lines)-2] != "pointed HTTPS_PROXY at "+routedEnv {
			t.Fatalf("settings lines = %q, want the proxy set reported before tool search", lines)
		}
	})

	t.Run("takes a pre-existing plugin-router base URL out when proxy mode takes over", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		if err := os.MkdirAll(filepath.Dir(h.deps().SettingsPath), 0o755); err != nil {
			t.Fatalf("mkdir settings dir: %v", err)
		}
		if err := os.WriteFile(h.deps().SettingsPath,
			[]byte(`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18788"}}`), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}

		applied := cli.ApplyRouting(ctx, h.deps())

		if !applied.Settings.OK {
			t.Fatalf("settings = %+v, want ok", applied.Settings)
		}
		env := envOf(t, settingsOf(t, h))
		if _, has := env["ANTHROPIC_BASE_URL"]; has {
			t.Fatal("the plugin-router base URL survived proxy mode")
		}
		if got := env["HTTPS_PROXY"]; got != routedEnv {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, routedEnv)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
	})

	t.Run("still merges settings when the router cannot start, keeps the agents on Sonnet, and records nothing", func(t *testing.T) {
		h := newHarness(t, nil)
		h.routerErr = errors.New("spawn failed")

		applied := cli.ApplyRouting(context.Background(), h.deps())

		if applied.Router.OK || applied.Router.Error != "spawn failed" {
			t.Fatalf("router = %+v, want the spawn failed error", applied.Router)
		}
		if !applied.Settings.OK {
			t.Fatalf("settings = %+v, want ok", applied.Settings)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
		if cli.ReadSetupDone(h.root) {
			t.Fatal("readSetupDone = true, want false")
		}
		if _, err := os.Stat(filepath.Join(h.root, "routers", "zai.json")); !os.IsNotExist(err) {
			t.Fatal("registry entry exists, want none")
		}
	})
}

func TestRemoveRouting(t *testing.T) {
	t.Run("takes the plugin's own entries out, restores sonnet, retires the router and clears the record", func(t *testing.T) {
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())

		removed := cli.RemoveRouting(ctx, h.deps())

		if !removed.Router.OK || removed.Router.Value != retiredLine {
			t.Fatalf("router = %+v, want %q", removed.Router, retiredLine)
		}
		if h.retireCalls != 1 {
			t.Fatalf("retireCalls = %d, want 1", h.retireCalls)
		}
		if got := settingsOf(t, h); !reflect.DeepEqual(got, map[string]any{}) {
			t.Fatalf("settings = %v, want an empty object", got)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
		if cli.ReadSetupDone(h.root) {
			t.Fatal("readSetupDone = true, want false")
		}
		if _, err := os.Stat(filepath.Join(h.root, "routers", "zai.json")); !os.IsNotExist(err) {
			t.Fatal("registry entry exists, want none")
		}
	})

	t.Run("puts each agent's model back as it was before setup, from the ledger, not Sonnet", func(t *testing.T) {
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		dir := filepath.Join(h.root, "plugin", "agents")
		if err := os.WriteFile(filepath.Join(dir, "glm-5.3.md"), []byte(strings.Replace(agentMd("glm-5.3"), "model: sonnet", "model: opus", 1)), 0o644); err != nil {
			t.Fatalf("write agent: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "glm-5.3-flash.md"), []byte("---\nname: glm-5.3-flash\nmodel: haiku\n---\n"), 0o644); err != nil {
			t.Fatalf("write agent: %v", err)
		}
		cli.ApplyRouting(ctx, h.deps())
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3\n") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		// A second run (a plugin update reset the file to the shipped one) never overwrites the
		// first record.
		if err := os.WriteFile(filepath.Join(dir, "glm-5.3.md"), []byte(agentMd("glm-5.3")), 0o644); err != nil {
			t.Fatalf("write agent: %v", err)
		}
		cli.ApplyRouting(ctx, h.deps())
		ledger, ok := router.ReadLedger(ctx, domain.NewStateLayout(h.root).Ledger)
		if !ok || ledger.Agents == nil {
			t.Fatalf("ledger agents = %+v, want the recorded models", ledger.Agents)
		}
		wantAgents := map[string]*string{"glm-5.3": strPtr("opus"), "glm-5.3-flash": strPtr("haiku")}
		if got := strings.Join(ledger.Agents.Names(), ","); got != "glm-5.3,glm-5.3-flash" {
			t.Fatalf("ledger agents order = %q, want the recorded one", got)
		}
		for name, want := range wantAgents {
			got, has := ledger.Agents.Get(name)
			if !has || *got != *want {
				t.Fatalf("ledger agent %s = %v, want %v", name, got, want)
			}
		}

		removed := cli.RemoveRouting(ctx, h.deps())

		if removed.Restored != cli.AgentSourceLedger {
			t.Fatalf("restored = %q, want ledger", removed.Restored)
		}
		if got, want := agentText(t, h.root, "glm-5.3"), strings.Replace(agentMd("glm-5.3"), "model: sonnet", "model: opus", 1); got != want {
			t.Fatalf("glm-5.3 agent = %q, want %q", got, want)
		}
		if got, want := agentText(t, h.root, "glm-5.3-flash"), "---\nname: glm-5.3-flash\nmodel: haiku\n---\n"; got != want {
			t.Fatalf("glm-5.3-flash agent = %q, want %q", got, want)
		}
		wantText := "restored to their models before setup (glm-5.3: opus, glm-5.3-flash: haiku, omp: sonnet, opencode: sonnet, pi: sonnet, zcode: sonnet)"
		if got := cli.RestoredAgentText(removed); got != wantText {
			t.Fatalf("restoredAgentText = %q, want %q", got, wantText)
		}
	})

	t.Run("leaves an agent setup never changed as it is, and falls back to the shipped default without a ledger", func(t *testing.T) {
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		path := domain.NewStateLayout(h.root).Ledger
		ledger, ok := router.ReadLedger(ctx, path)
		if !ok {
			t.Fatal("no ledger after applyRouting")
		}
		ledger.Agents = router.NewLedgerAgents()
		ledger.Agents.Set("glm-5.3", nil)
		if err := router.WriteLedger(ctx, path, ledger); err != nil {
			t.Fatalf("write ledger: %v", err)
		}
		if err := os.WriteFile(filepath.Join(h.root, "plugin", "agents", "glm-5.3-flash.md"),
			[]byte(strings.Replace(agentMd("glm-5.3-flash"), "sonnet", "custom", 1)), 0o644); err != nil {
			t.Fatalf("write agent: %v", err)
		}

		removed := cli.RemoveRouting(ctx, h.deps())

		if text := agentText(t, h.root, "glm-5.3"); strings.Contains(text, "model:") {
			t.Fatalf("glm-5.3 agent = %q, want no model: line", text)
		}
		if text := agentText(t, h.root, "glm-5.3-flash"); !strings.Contains(text, "model: custom") {
			t.Fatalf("glm-5.3-flash agent = %q, want a model: custom line", text)
		}
		wantText := "restored to their models before setup (glm-5.3: (none), glm-5.3-flash: custom, omp: sonnet, opencode: sonnet, pi: sonnet, zcode: sonnet)"
		if got := cli.RestoredAgentText(removed); got != wantText {
			t.Fatalf("restoredAgentText = %q, want %q", got, wantText)
		}

		old := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		cli.ApplyRouting(ctx, old.deps())
		if err := os.Remove(domain.NewStateLayout(old.root).Ledger); err != nil {
			t.Fatalf("remove ledger: %v", err)
		}
		fallback := cli.RemoveRouting(ctx, old.deps())
		if fallback.Restored != cli.AgentSourceDefault {
			t.Fatalf("restored = %q, want default", fallback.Restored)
		}
		if text := agentText(t, old.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
		wantFallback := "set to the shipped default (glm-5.3: sonnet, glm-5.3-flash: sonnet, omp: sonnet, opencode: sonnet, pi: sonnet, zcode: sonnet)"
		if got := cli.RestoredAgentText(fallback); got != wantFallback {
			t.Fatalf("restoredAgentText = %q, want %q", got, wantFallback)
		}
		if err := os.Remove(filepath.Join(old.root, "plugin", "agents", "glm-5.3.md")); err != nil {
			t.Fatalf("remove agent: %v", err)
		}
		if got := cli.RestoredAgentText(cli.RemoveRouting(ctx, old.deps())); !strings.Contains(got, "FAILED: ") {
			t.Fatalf("restoredAgentText = %q, want it to say FAILED", got)
		}
	})

	t.Run("repoints HTTPS_PROXY at the other live registered router when one answers", func(t *testing.T) {
		port := healthyServer(t, "/kimi-router/health")
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		if err := router.SaveRegistryEntry(ctx, h.fullEnv(), router.RegisteredRouter{
			Name:          "kimi",
			Port:          int64(port),
			ModelPrefixes: []string{"kimi-"},
			CatalogIds:    []string{"kimi-k3"},
			UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			t.Fatalf("save registry entry: %v", err)
		}
		cli.ApplyRouting(ctx, h.deps())

		cli.RemoveRouting(ctx, h.deps())

		settings := settingsOf(t, h)
		want := fmt.Sprintf("http://127.0.0.1:%d", port)
		if got := envOf(t, settings)["HTTPS_PROXY"]; got != want {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, want)
		}
		if _, has := settings["modelPicker"]; has {
			t.Fatal("modelPicker survives remove, want it gone")
		}
	})

	t.Run("puts settings.json back byte for byte: setup's ledger is undone, empty containers included", func(t *testing.T) {
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		path := h.deps().SettingsPath
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir settings dir: %v", err)
		}
		before := "{\n  \"enabledPlugins\": { \"zai-plugin-cc@muhmdraouf\": true },\n  \"theme\": \"dark\"\n}\n"
		if err := os.WriteFile(path, []byte(before), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}
		cli.ApplyRouting(ctx, h.deps())
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read settings: %v", err)
		}
		if string(after) == before {
			t.Fatal("applyRouting left settings.json unchanged, want the merge's write")
		}

		cli.RemoveRouting(ctx, h.deps())

		restored, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read settings: %v", err)
		}
		if string(restored) != before {
			t.Fatalf("settings.json = %q, want the original %q", restored, before)
		}
	})

	t.Run("without a ledger (a setup from before it), takes the provider's entries out all the same", func(t *testing.T) {
		h := newHarness(t, map[string]string{"ANTHROPIC_BASE_URL": routedEnv})
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		if err := os.Remove(domain.NewStateLayout(h.root).Ledger); err != nil {
			t.Fatalf("remove ledger: %v", err)
		}

		cli.RemoveRouting(ctx, h.deps())

		// No ledger, so what setup added is not on record: the entries go by their ids, and the
		// tool-search flag and the effort levels cannot be told from ones the user set, so they
		// stay. NO_PROXY stays too: it may hold the user's own entries.
		want := jsonValue(t, `{
			"modelPicker": {"options": []},
			"env": {"ENABLE_TOOL_SEARCH": "true", "NO_PROXY": "localhost,127.0.0.1"},
			"modelSettings": {
				"glm-5.3": {"effortLevel": "xhigh"},
				"glm-5.3-flash": {"effortLevel": "xhigh"}
			}
		}`)
		if got := settingsOf(t, h); !reflect.DeepEqual(got, want) {
			t.Fatalf("settings = %v, want %v", got, want)
		}
	})
}

func TestRoutingHook(t *testing.T) {
	t.Run("does nothing without the setupDone mark", func(t *testing.T) {
		h := newHarness(t, nil)

		if got := cli.RoutingHook(context.Background(), h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if len(h.out.Lines) != 0 {
			t.Fatalf("lines = %q, want none", h.out.Lines)
		}
		if h.keyCalls != 0 {
			t.Fatalf("keyCalls = %d, want 0", h.keyCalls)
		}
	})

	t.Run("re-applies silently when nothing needs repairing", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if len(h.out.Lines) != 0 {
			t.Fatalf("lines = %q, want none", h.out.Lines)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
	})

	t.Run("starts the session watchdog once the router is up", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.out.Lines = nil
		var watched []int64
		deps := h.deps()
		deps.StartWatchdog = func(_ context.Context, sessionPid int64) { watched = append(watched, sessionPid) }

		if got := cli.RoutingHook(ctx, deps); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if len(watched) != 1 {
			t.Fatalf("watchdog starts = %v, want exactly one (one per session)", watched)
		}
	})

	t.Run("starts no watchdog when the router cannot start", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.routerErr = errors.New("spawn failed")
		h.out.Lines = nil
		var watched []int64
		deps := h.deps()
		deps.StartWatchdog = func(_ context.Context, sessionPid int64) { watched = append(watched, sessionPid) }

		if got := cli.RoutingHook(ctx, deps); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if len(watched) != 0 {
			t.Fatalf("watchdog starts = %v, want none", watched)
		}
	})

	t.Run("repairs agents an update reset to sonnet, silently", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		shippedAgents(t, h.root)
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		if len(h.out.Lines) != 0 {
			t.Fatalf("lines = %q, want none", h.out.Lines)
		}
	})

	t.Run("keeps the agents on the provider and takes the proxy keys off when the router cannot start", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.routerErr = errors.New("spawn failed")
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		env := envOf(t, settingsOf(t, h))
		for _, key := range []string{"HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "ANTHROPIC_BASE_URL"} {
			if _, has := env[key]; has {
				t.Fatalf("settings keep %s, want it removed", key)
			}
		}
		// NO_PROXY may hold the user's own entries, so a removal leaves it.
		if got := env["NO_PROXY"]; got != "localhost,127.0.0.1" {
			t.Fatalf("NO_PROXY = %v, want it left in place", got)
		}
		want := []string{`{"systemMessage":"zai: the zai router could not start, so the zai agents cannot reach Z.ai GLM this session. Run /zai:setup to see why."}`}
		if !reflect.DeepEqual(h.out.Lines, want) {
			t.Fatalf("lines = %q, want %q", h.out.Lines, want)
		}
	})

	t.Run("a proxy of the user's own in the hook's environment keeps base-URL mode", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		if err := os.WriteFile(h.deps().SettingsPath, []byte("{}"), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}
		if h.env == nil {
			h.env = map[string]string{}
		}
		h.env["HTTPS_PROXY"] = "http://proxy.corp:3128"
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		env := envOf(t, settingsOf(t, h))
		if got := env["ANTHROPIC_BASE_URL"]; got != routedEnv {
			t.Fatalf("ANTHROPIC_BASE_URL = %v, want %q (base-URL mode)", got, routedEnv)
		}
		if _, has := env["HTTPS_PROXY"]; has {
			t.Fatal("settings keep HTTPS_PROXY, want none beside the user's own environment proxy")
		}
	})

	t.Run("a lowercase https_proxy in the hook's environment counts too", func(t *testing.T) {
		h := newHarness(t, map[string]string{"https_proxy": "http://proxy.corp:3128"})
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		if err := os.WriteFile(h.deps().SettingsPath, []byte("{}"), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}
		h.out.Lines = nil

		cli.RoutingHook(ctx, h.deps())

		env := envOf(t, settingsOf(t, h))
		if got := env["ANTHROPIC_BASE_URL"]; got != routedEnv {
			t.Fatalf("ANTHROPIC_BASE_URL = %v, want %q (base-URL mode)", got, routedEnv)
		}
		if _, has := env["HTTPS_PROXY"]; has {
			t.Fatal("settings keep HTTPS_PROXY, want none beside the user's own lowercase proxy")
		}
	})

	t.Run("keeps the agents on the provider, saying there is no key, even with the router up", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.keyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai GLM key: export ZAI_API_KEY"}
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
		want := []string{`{"systemMessage":"zai: no Z.ai GLM key found, so the zai agents cannot reach Z.ai GLM. Run /zai:setup to enter it."}`}
		if !reflect.DeepEqual(h.out.Lines, want) {
			t.Fatalf("lines = %q, want %q", h.out.Lines, want)
		}
	})

	t.Run("keeps the proxy keys on another live router when one deserves them", func(t *testing.T) {
		port := healthyServer(t, "/kimi-router/health")
		h := newHarness(t, nil)
		ctx := context.Background()
		if err := router.SaveRegistryEntry(ctx, h.fullEnv(), router.RegisteredRouter{
			Name:          "kimi",
			Port:          int64(port),
			ModelPrefixes: []string{"kimi-"},
			CatalogIds:    []string{"kimi-k3"},
			UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			t.Fatalf("save registry entry: %v", err)
		}
		cli.ApplyRouting(ctx, h.deps())
		h.routerErr = errors.New("spawn failed")
		h.out.Lines = nil

		cli.RoutingHook(ctx, h.deps())

		want := fmt.Sprintf("http://127.0.0.1:%d", port)
		if got := envOf(t, settingsOf(t, h))["HTTPS_PROXY"]; got != want {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, want)
		}
	})
}

func TestLedgerMarkerAgentsGate(t *testing.T) {
	t.Run("records what setup changed in the ledger, and the installed marker in the plugin's own data dir", func(t *testing.T) {
		data := filepath.Join(testkit.TempDir(t, "core-route-data-"), "zai-plugin-cc-muhmdraouf")
		h := newHarness(t, map[string]string{"CLAUDE_PLUGIN_DATA": data})

		cli.ApplyRouting(context.Background(), h.deps())

		ledger, ok := router.ReadLedger(context.Background(), domain.NewStateLayout(h.root).Ledger)
		if !ok {
			t.Fatal("no ledger after applyRouting")
		}
		if ledger.Plugin != "zai" ||
			ledger.RouterURL != routedEnv ||
			ledger.SettingsPath != h.deps().SettingsPath ||
			ledger.Settings.BaseURLBefore != nil ||
			ledger.Settings.ProxyBefore != nil ||
			!reflect.DeepEqual(ledger.Settings.OptionsAdded, []string{"glm-5.3", "glm-5.3-flash"}) ||
			!ledger.Settings.CreatedEnv || !ledger.Settings.CreatedProxy ||
			ledger.Keystore.Created ||
			ledger.Marker == nil || *ledger.Marker != filepath.Join(data, "installed") {
			t.Fatalf("ledger = %+v", ledger)
		}
		if _, err := os.Stat(filepath.Join(data, "installed")); err != nil {
			t.Fatalf("installed marker: %v", err)
		}
	})

	t.Run("writes no marker into another plugin's data dir", func(t *testing.T) {
		data := filepath.Join(testkit.TempDir(t, "core-route-data-"), "huddle-muhmdraouf")
		h := newHarness(t, map[string]string{"CLAUDE_PLUGIN_DATA": data})

		cli.ApplyRouting(context.Background(), h.deps())

		ledger, ok := router.ReadLedger(context.Background(), domain.NewStateLayout(h.root).Ledger)
		if !ok {
			t.Fatal("no ledger after applyRouting")
		}
		if ledger.Marker != nil {
			t.Fatalf("marker = %q, want none", *ledger.Marker)
		}
		if _, err := os.Stat(data); !os.IsNotExist(err) {
			t.Fatal("data dir exists, want it untouched")
		}
	})

	t.Run("keeps the agents on Sonnet when the base URL is the user's own proxy", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		if err := os.MkdirAll(filepath.Join(h.root, "home", ".claude"), 0o755); err != nil {
			t.Fatalf("mkdir .claude: %v", err)
		}
		if err := os.WriteFile(h.deps().SettingsPath,
			[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example"}}`), 0o644); err != nil {
			t.Fatalf("write settings: %v", err)
		}

		applied := cli.ApplyRouting(ctx, h.deps())

		if !applied.Settings.OK {
			t.Fatalf("settings = %+v, want ok", applied.Settings)
		}
		if len(applied.Settings.Value) != 5 {
			t.Fatalf("settings lines = %q, want five", applied.Settings.Value)
		}
		if text := applied.Settings.Value[4]; !strings.Contains(text, "your own proxy") {
			t.Fatalf("fifth settings line = %q, want it to name the user's own proxy", text)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
	})

	t.Run("says the provider is not ready when the running router cannot read the key, and keeps the agents on Sonnet", func(t *testing.T) {
		h := newHarness(t, nil)
		h.routerKeyErr = errors.New("no_key")

		applied := cli.ApplyRouting(context.Background(), h.deps())

		if applied.Router.OK {
			t.Fatal("router = ok, want the not-ready error")
		}
		if want := "but it cannot read the Z.ai GLM key (no_key): Z.ai GLM models are not ready"; !strings.Contains(applied.Router.Error, want) {
			t.Fatalf("router error = %q, want it to contain %q", applied.Router.Error, want)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
			t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line", text)
		}
		// The router itself runs, so the hooks keep it alive: setup counts as done.
		if !cli.ReadSetupDone(h.root) {
			t.Fatal("readSetupDone = false, want true")
		}
	})

	t.Run("re-applies setup, in one user message, once a plugin disabled and cleaned up is enabled again", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		layout := domain.NewStateLayout(h.root)
		ledgerRaw, err := os.ReadFile(layout.Ledger)
		if err != nil {
			t.Fatalf("read ledger: %v", err)
		}
		// What the router's cleanup leaves after a disable.
		cli.ClearSetupDone(h.root)
		if err := os.Remove(layout.Ledger); err != nil {
			t.Fatalf("remove ledger: %v", err)
		}
		if err := os.WriteFile(layout.DisabledLedger, ledgerRaw, 0o600); err != nil {
			t.Fatalf("write disabled ledger: %v", err)
		}
		if err := os.Remove(h.deps().SettingsPath); err != nil {
			t.Fatalf("remove settings: %v", err)
		}
		h.out.Lines = nil

		if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
			t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
		}

		want := []string{`{"systemMessage":"zai: enabled again and set up again; restart Claude Code to route through the zai router."}`}
		if !reflect.DeepEqual(h.out.Lines, want) {
			t.Fatalf("lines = %q, want %q", h.out.Lines, want)
		}
		if got := envOf(t, settingsOf(t, h))["HTTPS_PROXY"]; got != routedEnv {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, routedEnv)
		}
		if !cli.ReadSetupDone(h.root) {
			t.Fatal("readSetupDone = false, want true")
		}
		if _, err := os.Stat(layout.DisabledLedger); !os.IsNotExist(err) {
			t.Fatal("disabled ledger survives the re-enable, want it gone")
		}
		if _, ok := router.ReadLedger(ctx, layout.Ledger); !ok {
			t.Fatal("no ledger after the re-enable")
		}
	})

	t.Run("a missing key leaves the router and the proxy keys alone, and says so at every session start", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		h.keyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key"}
		h.out.Lines = nil

		cli.RoutingHook(ctx, h.deps())
		cli.RoutingHook(ctx, h.deps())

		if got := envOf(t, settingsOf(t, h))["HTTPS_PROXY"]; got != routedEnv {
			t.Fatalf("HTTPS_PROXY = %v, want %q", got, routedEnv)
		}
		message := `{"systemMessage":"zai: no Z.ai GLM key found, so the zai agents cannot reach Z.ai GLM. Run /zai:setup to enter it."}`
		if want := []string{message, message}; !reflect.DeepEqual(h.out.Lines, want) {
			t.Fatalf("lines = %q, want %q", h.out.Lines, want)
		}
		if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: glm-5.3") {
			t.Fatalf("glm-5.3 agent = %q, want a model: glm-5.3 line", text)
		}
	})

	t.Run("setup --remove takes the ledger away, so the router has nothing left to undo", func(t *testing.T) {
		h := newHarness(t, nil)
		ctx := context.Background()
		cli.ApplyRouting(ctx, h.deps())
		layout := domain.NewStateLayout(h.root)
		if err := os.WriteFile(layout.DisabledLedger, []byte("{}"), 0o600); err != nil {
			t.Fatalf("write disabled ledger: %v", err)
		}

		cli.RemoveRouting(ctx, h.deps())

		if _, err := os.Stat(layout.Ledger); !os.IsNotExist(err) {
			t.Fatal("ledger survives remove, want it gone")
		}
		if _, err := os.Stat(layout.DisabledLedger); !os.IsNotExist(err) {
			t.Fatal("disabled ledger survives remove, want it gone")
		}
	})

	t.Run("knows its own router's health from any other 200", func(t *testing.T) {
		own := healthyServer(t, "/zai-router/health")
		if !cli.RouterUp(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{"ZAI_ROUTER_PORT": fmt.Sprint(own)}) {
			t.Fatal("routerUp = false on our own health answer, want true")
		}
		other := healthyServer(t, "/kimi-router/health")
		if cli.RouterUp(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{"ZAI_ROUTER_PORT": fmt.Sprint(other)}) {
			t.Fatal("routerUp = true on another plugin's health answer, want false")
		}
	})
}

func TestAgentsDir(t *testing.T) {
	root := testkit.TempDir(t, "core-route-")
	bundle := filepath.Join(root, "plugin", "dist", "zai.js")
	if got, want := cli.AgentsDir(bundle), filepath.Join(root, "plugin", "agents"); got != want {
		t.Fatalf("agentsDir = %q, want %q", got, want)
	}
}

func TestRecordEngineAgentBefore(t *testing.T) {
	ctx := context.Background()
	bare := testkit.TempDir(t, "core-route-")
	// Without a ledger there is nothing to record into.
	cli.RecordEngineAgentBefore(ctx, bare, domain.EngineToolOmp, true, strPtr("opus"))
	if _, ok := router.ReadLedger(ctx, domain.NewStateLayout(bare).Ledger); ok {
		t.Fatal("ledger appears without setup, want none")
	}

	h := newHarness(t, nil)
	cli.ApplyRouting(ctx, h.deps())
	path := domain.NewStateLayout(h.root).Ledger

	// An unchanged line is never recorded.
	cli.RecordEngineAgentBefore(ctx, h.root, domain.EngineToolOmp, false, strPtr("opus"))

	cli.RecordEngineAgentBefore(ctx, h.root, domain.EngineToolOmp, true, strPtr("sonnet"))
	ledger, ok := router.ReadLedger(ctx, path)
	if !ok || ledger.Agents == nil {
		t.Fatalf("ledger agents = %+v, want omp recorded", ledger.Agents)
	}
	if got, has := ledger.Agents.Get("omp"); !has || got == nil || *got != "sonnet" {
		t.Fatalf("omp = %v, want sonnet", got)
	}

	// A later run never overwrites the first record.
	cli.RecordEngineAgentBefore(ctx, h.root, domain.EngineToolOmp, true, strPtr("opus"))
	again, _ := router.ReadLedger(ctx, path)
	if got, has := again.Agents.Get("omp"); !has || got == nil || *got != "sonnet" {
		t.Fatalf("omp = %v, want the first record (sonnet)", got)
	}
}

func TestNewSetupDeps(t *testing.T) {
	f := fakedeps.FakeDeps(t)

	deps := cli.NewSetupDeps(f.Deps)

	if deps.Provider.Name != f.Deps.Provider.Name {
		t.Fatalf("provider = %q, want %q", deps.Provider.Name, f.Deps.Provider.Name)
	}
	if deps.StateRoot != f.Root {
		t.Fatalf("stateRoot = %q, want %q", deps.StateRoot, f.Root)
	}
	if deps.BundlePath != f.Deps.BundlePath {
		t.Fatalf("bundlePath = %q, want %q", deps.BundlePath, f.Deps.BundlePath)
	}
	if deps.Out != f.Out {
		t.Fatal("out is not the deps output")
	}
	if want := adapters.ClaudeSettingsPath(domain.EnvLookup(f.Deps.Env)); deps.SettingsPath != want {
		t.Fatalf("settingsPath = %q, want %q", deps.SettingsPath, want)
	}
	line, err := deps.EnsureRouter(context.Background())
	if err != nil || line != f.Host.Router {
		t.Fatalf("ensureRouter = %q, %v; want %q", line, err, f.Host.Router)
	}
	if _, err := deps.RouterKey(context.Background()); err != nil {
		t.Fatalf("routerKey: %v", err)
	}
}

// corruptSettings replaces the settings file with text no JSON parser reads.
func corruptSettings(t *testing.T, h *harness) {
	t.Helper()
	if err := os.WriteFile(h.deps().SettingsPath, []byte("not json"), 0o644); err != nil {
		t.Fatalf("write settings: %v", err)
	}
}

func TestApplyRoutingSettingsUnparsable(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	cli.ApplyRouting(ctx, h.deps())
	corruptSettings(t, h)
	h.out.Lines = nil

	applied := cli.ApplyRouting(ctx, h.deps())

	if applied.Settings.OK || applied.Settings.Error == "" {
		t.Fatalf("settings = %+v, want the unparsable settings error", applied.Settings)
	}
	if text := agentText(t, h.root, "glm-5.3"); !strings.Contains(text, "model: sonnet") {
		t.Fatalf("glm-5.3 agent = %q, want a model: sonnet line (the base URL cannot be read)", text)
	}

	if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
		t.Fatalf("routingHook = %d, want %d even with unparsable settings", got, cli.ExitOK)
	}
	if len(h.out.Lines) != 0 {
		t.Fatalf("lines = %q, want none", h.out.Lines)
	}
}

func TestRemoveRoutingSettingsUnparsable(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	cli.ApplyRouting(ctx, h.deps())
	if err := os.Remove(domain.NewStateLayout(h.root).Ledger); err != nil {
		t.Fatalf("remove ledger: %v", err)
	}
	corruptSettings(t, h)

	removed := cli.RemoveRouting(ctx, h.deps())

	if removed.Settings.OK || removed.Settings.Error == "" {
		t.Fatalf("settings = %+v, want the unparsable settings error", removed.Settings)
	}
}

func TestRouterUpFailures(t *testing.T) {
	ctx := context.Background()
	// A port nothing listens on any more: the health check cannot even connect.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	dead := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	if cli.RouterUp(ctx, testkit.ReferenceProvider, domain.EnvLookup{"ZAI_ROUTER_PORT": fmt.Sprint(dead)}) {
		t.Fatal("routerUp = true on a dead port, want false")
	}

	// A 200-less answer is not ours either.
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	alive, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(alive) }()
	t.Cleanup(func() { _ = server.Close() })
	if cli.RouterUp(ctx, testkit.ReferenceProvider, domain.EnvLookup{"ZAI_ROUTER_PORT": fmt.Sprint(alive.Addr().(*net.TCPAddr).Port)}) {
		t.Fatal("routerUp = true on a 404, want false")
	}
}

func TestInstalledMarkerUnwritable(t *testing.T) {
	root := testkit.TempDir(t, "core-route-data-")
	occupied := filepath.Join(root, "zai-occupied")
	if err := os.WriteFile(occupied, []byte("x"), 0o644); err != nil {
		t.Fatalf("write occupied: %v", err)
	}
	h := newHarness(t, map[string]string{"CLAUDE_PLUGIN_DATA": occupied})

	cli.ApplyRouting(context.Background(), h.deps())

	ledger, ok := router.ReadLedger(context.Background(), domain.NewStateLayout(h.root).Ledger)
	if !ok {
		t.Fatal("no ledger after applyRouting")
	}
	if ledger.Marker != nil {
		t.Fatalf("marker = %q, want none (the data dir is a file)", *ledger.Marker)
	}
}

func TestKeyInStore(t *testing.T) {
	// The label check only runs when the platform store exists for this env, which needs HOME to
	// be the login account's home. CLAUDE_CONFIG_DIR and PROVIDER_ROUTERS_HOME keep every read and
	// write inside the sandbox; the store itself is only asked for its label, so no OS tool runs.
	account, err := user.Current()
	if err != nil || account.HomeDir == "" {
		t.Skipf("no login account entry: %v", err)
	}
	sandbox := func() map[string]string {
		return map[string]string{
			"HOME":                  account.HomeDir,
			"CLAUDE_CONFIG_DIR":     filepath.Join(testkit.TempDir(t, "core-route-config-"), "claude"),
			"PROVIDER_ROUTERS_HOME": filepath.Join(testkit.TempDir(t, "core-route-routers-"), "routers"),
		}
	}
	store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup(sandbox()), keystore.PlatformOptions{})
	if store == nil {
		t.Skip("no platform key store for the login home")
	}
	ctx := context.Background()

	// A key from the environment is not one setup put in the store.
	h := newHarness(t, sandbox())
	cli.ApplyRouting(ctx, h.deps())
	ledger, ok := router.ReadLedger(ctx, domain.NewStateLayout(h.root).Ledger)
	if !ok {
		t.Fatal("no ledger after applyRouting")
	}
	if ledger.Keystore.Created {
		t.Fatal("keystore.created = true with an env key, want false")
	}

	// One whose source is the store's own label is.
	h2 := newHarness(t, sandbox())
	h2.key = ports.ProviderKey{Value: "test-key", Source: store.Label()}
	cli.ApplyRouting(ctx, h2.deps())
	ledger2, ok := router.ReadLedger(ctx, domain.NewStateLayout(h2.root).Ledger)
	if !ok {
		t.Fatal("no ledger after applyRouting")
	}
	if !ledger2.Keystore.Created {
		t.Fatal("keystore.created = false with the store's own key, want true")
	}
}

func TestReEnableRouterFailed(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	cli.ApplyRouting(ctx, h.deps())
	layout := domain.NewStateLayout(h.root)
	ledgerRaw, err := os.ReadFile(layout.Ledger)
	if err != nil {
		t.Fatalf("read ledger: %v", err)
	}
	cli.ClearSetupDone(h.root)
	if err := os.Remove(layout.Ledger); err != nil {
		t.Fatalf("remove ledger: %v", err)
	}
	if err := os.WriteFile(layout.DisabledLedger, ledgerRaw, 0o600); err != nil {
		t.Fatalf("write disabled ledger: %v", err)
	}
	h.routerErr = errors.New("spawn failed")
	h.out.Lines = nil

	if got := cli.RoutingHook(ctx, h.deps()); got != cli.ExitOK {
		t.Fatalf("routingHook = %d, want %d", got, cli.ExitOK)
	}
	want := []string{`{"systemMessage":"zai: enabled again, but the zai router could not start; run /zai:setup to see why."}`}
	if !reflect.DeepEqual(h.out.Lines, want) {
		t.Fatalf("lines = %q, want %q", h.out.Lines, want)
	}
}

func TestRoutingHookRepairsSettings(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	cli.ApplyRouting(ctx, h.deps())
	// A plugin update rewrote settings.json without our entries; the hook re-applies them.
	if err := os.WriteFile(h.deps().SettingsPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	h.out.Lines = nil

	cli.RoutingHook(ctx, h.deps())

	env := envOf(t, settingsOf(t, h))
	if got := env["HTTPS_PROXY"]; got != routedEnv {
		t.Fatalf("HTTPS_PROXY = %v, want it re-applied (%q)", got, routedEnv)
	}
	if _, has := env["ANTHROPIC_BASE_URL"]; has {
		t.Fatal("settings keep ANTHROPIC_BASE_URL, want proxy mode without it")
	}
	if len(h.out.Lines) != 0 {
		t.Fatalf("lines = %q, want none", h.out.Lines)
	}
}

func TestRouterUpTruncatedBody(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				// A header promising a body the answer never delivers.
				_, _ = c.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort"))
				_ = c.Close()
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port
	if cli.RouterUp(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{"ZAI_ROUTER_PORT": fmt.Sprint(port)}) {
		t.Fatal("routerUp = true on a truncated body, want false")
	}
}

func TestRoutingHookThroughRunCli(t *testing.T) {
	t.Run("is the session-start re-apply; without the setupDone mark it stays silent", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		shippedAgents(t, world.Root)

		code := cli.RunCli(context.Background(), []string{"setup", "--hook"}, world.Deps, "/repo")

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
	})

	t.Run("never pings the provider: a session start spends no tokens", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		shippedAgents(t, world.Root)
		cli.RecordSetupDone(world.Root)

		code := cli.RunCli(context.Background(), []string{"setup", "--hook"}, world.Deps, "/repo")

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if specs := world.Worker.Specs(); len(specs) != 0 {
			t.Fatalf("the worker ran %d specs, want 0", len(specs))
		}
	})
}

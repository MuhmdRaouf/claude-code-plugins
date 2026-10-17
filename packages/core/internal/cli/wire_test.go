package cli_test

// The wire suite: the composition every plugin's cli is, over the reference provider.

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakeclaude"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// wireSandbox is a sandboxed environment: HOME points at a temp dir, so the key file lookup never
// reaches the real one.
func wireSandbox(t *testing.T, extra map[string]string) map[string]string {
	t.Helper()
	home := testkit.TempDir(t, "core-wire-")
	env := map[string]string{
		"HOME":          home,
		"PATH":          os.Getenv("PATH"),
		"ZAI_STATE_DIR": filepath.Join(home, "state"),
	}
	for name, value := range extra {
		env[name] = value
	}
	return env
}

// wired is Wire over the sandbox, its driver stand-in this test binary.
func wired(t *testing.T, provider domain.Provider, env map[string]string, out ports.Output, bundlePath string) app.Deps {
	t.Helper()
	return cli.Wire(context.Background(), cli.WireOptions{
		Provider:   provider,
		Env:        domain.EnvLookup(env),
		Executable: engineFakeBin(t),
		BundlePath: bundlePath,
		Out:        out,
	})
}

func TestWireStateRoot(t *testing.T) {
	t.Run("state root: the provider's env var, else ~/.agents — $CLAUDE_PLUGIN_DATA never picks it", func(t *testing.T) {
		zaiData := "/home/me/.claude/plugins/data/zai-plugin-cc-muhmdraouf"
		cases := []struct {
			provider domain.Provider
			env      map[string]string
			want     string
		}{
			{testkit.ReferenceProvider, map[string]string{"ZAI_STATE_DIR": "/explicit", "CLAUDE_PLUGIN_DATA": zaiData, "HOME": "/home/me"}, "/explicit"},
			// Claude Code sets CLAUDE_PLUGIN_DATA only for hooks; taking it as the root split the
			// hooks' state from setup's, so every caller resolves ~/.agents whatever it holds.
			{testkit.ReferenceProvider, map[string]string{"CLAUDE_PLUGIN_DATA": zaiData, "XDG_STATE_HOME": "/xdg", "HOME": "/home/me"}, filepath.Join("/home/me", ".agents", "zai")},
			// XDG_STATE_HOME does not pick the root; the migration looks there for old state
			// instead. The joined wants go through filepath.Join, which answers in the
			// platform's own separators.
			{testkit.ReferenceProvider, map[string]string{"XDG_STATE_HOME": "/xdg", "HOME": "/home/me"}, filepath.Join("/home/me", ".agents", "zai")},
			{testkit.ReferenceProvider, map[string]string{"HOME": "/home/me"}, filepath.Join("/home/me", ".agents", "zai")},
			// The rule is the provider's own names, not zai's: acme keeps $ACME_STATE_DIR and ~/.agents/acme.
			{testkit.AcmeProvider, map[string]string{"ZAI_STATE_DIR": "/explicit", "HOME": "/home/me"}, filepath.Join("/home/me", ".agents", "acme")},
			{testkit.AcmeProvider, map[string]string{"ACME_STATE_DIR": "/acme-explicit", "HOME": "/home/me"}, "/acme-explicit"},
		}
		for _, test := range cases {
			if got := adapters.StateRoot(context.Background(), test.provider, domain.EnvLookup(test.env)); got != test.want {
				t.Errorf("stateRoot(%s, %v) = %s, want %s", test.provider.Name, test.env, got, test.want)
			}
		}
	})

	t.Run("ignores a $CLAUDE_PLUGIN_DATA that belongs to another plugin (it leaks into every Bash tool call)", func(t *testing.T) {
		want := filepath.Join("/home/me", ".agents", "zai")
		for _, other := range []string{
			"/home/me/.claude/plugins/data/grok-build-xai-grok-build",
			"/data",
			"/x/zaiplugin-y",
		} {
			env := map[string]string{"CLAUDE_PLUGIN_DATA": other, "HOME": "/home/me"}
			if got := adapters.StateRoot(context.Background(), testkit.ReferenceProvider, domain.EnvLookup(env)); got != want {
				t.Errorf("stateRoot with CLAUDE_PLUGIN_DATA %s = %s, want %s", other, got, want)
			}
		}
	})
}

func TestWire(t *testing.T) {
	t.Run("the limiter config is the default whatever the env says: ZAI_MAX_CONCURRENCY caps via the limiter state submit writes", func(t *testing.T) {
		deps := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{"ZAI_MAX_CONCURRENCY": "3"}), &fakes.RecordingOutput{}, "/zai.js")
		if deps.Config.Limiter != domain.DEFAULT_LIMITER {
			t.Errorf("limiter config = %+v, want the default", deps.Config.Limiter)
		}
		got := deps.Limiter.Limit(context.Background(), 0)
		want := ports.LimiterLevels{Cap: domain.DEFAULT_LIMITER.DefaultMax, Max: domain.DEFAULT_LIMITER.DefaultMax}
		if got != want {
			t.Errorf("limit = %+v, want %+v", got, want)
		}
	})

	t.Run("creates the state root and its claude-home config dir mode 0700, tightening an existing one", func(t *testing.T) {
		env := wireSandbox(t, nil)
		root := env["ZAI_STATE_DIR"]
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(root, 0o755); err != nil {
			t.Fatal(err)
		}

		deps := wired(t, testkit.ReferenceProvider, env, &fakes.RecordingOutput{}, "/zai.js")

		if deps.Host.StateRoot != root {
			t.Fatalf("state root = %s, want %s", deps.Host.StateRoot, root)
		}
		if mode := fileMode(t, root); mode != 0o700 {
			t.Errorf("state root mode = %o, want 700", mode)
		}
		if mode := fileMode(t, filepath.Join(root, "claude-home")); mode != 0o700 {
			t.Errorf("claude-home mode = %o, want 700", mode)
		}
		if deps.Config.StopGraceMs != 10_000 {
			t.Errorf("stop grace = %d ms, want 10000", deps.Config.StopGraceMs)
		}
	})

	t.Run("env overrides reach the jobs' catalog and endpoint, never the plugin's own names", func(t *testing.T) {
		asShipped := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js")
		overridden := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{
			"ZAI_MODEL_MAIN":  "glm-5.5",
			"ZAI_MODEL_FLASH": "glm-5.5-flash",
			"ZAI_BASE_URL":    "https://override.example/api/anthropic",
		}), &fakes.RecordingOutput{}, "/zai.js")

		if got := asShipped.Provider.Catalog[domain.ModelTierMain].ID; got != "glm-5.3" {
			t.Errorf("shipped main model = %s, want glm-5.3", got)
		}
		if got := asShipped.Provider.BaseURL; got != "https://api.z.ai/api/anthropic" {
			t.Errorf("shipped base URL = %s", got)
		}
		if got := overridden.Provider.Catalog[domain.ModelTierMain].ID; got != "glm-5.5" {
			t.Errorf("overridden main model = %s, want glm-5.5", got)
		}
		if got := overridden.Provider.Catalog[domain.ModelTierFlash].ID; got != "glm-5.5-flash" {
			t.Errorf("overridden flash model = %s, want glm-5.5-flash", got)
		}
		if got := overridden.Provider.BaseURL; got != "https://override.example/api/anthropic" {
			t.Errorf("overridden base URL = %s", got)
		}
		if got := overridden.Provider.Name; got != "zai" {
			t.Errorf("overridden name = %s, want zai", got)
		}
		wantAgents := map[domain.ModelTier]string{domain.ModelTierMain: "glm-5.3", domain.ModelTierFlash: "glm-5.3-flash"}
		if got := overridden.Provider.Agents; !reflect.DeepEqual(got, wantAgents) {
			t.Errorf("overridden agents = %v, want %v", got, wantAgents)
		}
	})

	t.Run("host reports the worker binary's version, or why it cannot run", func(t *testing.T) {
		fake := fakeclaude.Build(t)
		working := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{"ZAI_CLAUDE_BIN": fake}), &fakes.RecordingOutput{}, "/zai.js")
		missing := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{"ZAI_CLAUDE_BIN": "/nonexistent/claude"}), &fakes.RecordingOutput{}, "/zai.js")

		if working.Host.WorkerBin != fake {
			t.Errorf("worker bin = %s, want the fake", working.Host.WorkerBin)
		}
		version, err := working.Host.WorkerVersion(context.Background())
		if err != nil || version != "2.1.289 (Claude Code, fake)" {
			t.Errorf("worker version = (%q, %v), want the fake's line", version, err)
		}
		if _, err := missing.Host.WorkerVersion(context.Background()); err == nil || !strings.Contains(err.Error(), "ENOENT") {
			t.Errorf("missing worker version error = %v, want ENOENT", err)
		}
		if got := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js").Host.WorkerBin; got != "claude" {
			t.Errorf("default worker bin = %s, want claude", got)
		}
		// The binary's env name is the provider's own prefix, not zai's.
		acmeEnv := wireSandbox(t, map[string]string{"ACME_CLAUDE_BIN": fake})
		delete(acmeEnv, "ZAI_STATE_DIR")
		acme := wired(t, testkit.AcmeProvider, acmeEnv, &fakes.RecordingOutput{}, "/acme.js")
		if acme.Host.WorkerBin != fake {
			t.Errorf("acme worker bin = %s, want the fake", acme.Host.WorkerBin)
		}
	})

	t.Run("key source names the env var or the key file, never the key; no key is the loader's error", func(t *testing.T) {
		fromEnv := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{"ZAI_API_KEY": "sk-zai-secret"}), &fakes.RecordingOutput{}, "/zai.js")
		none := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js")

		want := []app.SetupCheck{{
			Label:  "key",
			Result: app.StringResult{OK: true, Value: "ZAI_API_KEY"},
			Text:   "present (ZAI_API_KEY)",
		}}
		if got := fromEnv.Host.ExtraChecks(context.Background()); !reflect.DeepEqual(got, want) {
			t.Errorf("extra checks = %+v, want %+v", got, want)
		}
		checks := none.Host.ExtraChecks(context.Background())
		if len(checks) != 1 || checks[0].Result.OK {
			t.Fatalf("extra checks = %+v, want the key's failure", checks)
		}
		if !strings.Contains(checks[0].Result.Error, "no Z.ai GLM key: run /zai:setup") ||
			strings.Contains(checks[0].Result.Error, "export") {
			t.Errorf("key error = %q", checks[0].Result.Error)
		}
		if !strings.Contains(checks[0].Text, "MISSING: no Z.ai GLM key: run /zai:setup") {
			t.Errorf("key text = %q", checks[0].Text)
		}
	})

	t.Run("host.loadKey resolves through the same loader as the worker: env key, else the key file, else the error", func(t *testing.T) {
		fromEnv := wired(t, testkit.ReferenceProvider, wireSandbox(t, map[string]string{"ZAI_API_KEY": "sk-zai-secret"}), &fakes.RecordingOutput{}, "/zai.js")
		loaded, err := fromEnv.Host.LoadKey(context.Background())
		if err != nil {
			t.Fatalf("loadKey: %v", err)
		}
		if loaded.Source != "ZAI_API_KEY" {
			t.Errorf("key source = %s, want ZAI_API_KEY", loaded.Source)
		}
		if loaded.Value != "sk-zai-secret" {
			t.Errorf("key value = %s, want the env key", loaded.Value)
		}
		if _, err := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js").Host.LoadKey(context.Background()); err == nil {
			t.Error("loadKey with no key anywhere = nil error")
		}
	})

	// The executable the start copies from is not there and the pinned port has nothing on it:
	// copying it fails, and so does the emergency passthrough beside it, so the start reports both.
	t.Run("host.ensureRouter reports the start failure, without leaving the sandbox", func(t *testing.T) {
		deps := cli.Wire(context.Background(), cli.WireOptions{
			Provider:   testkit.ReferenceProvider,
			Env:        domain.EnvLookup(wireSandbox(t, map[string]string{"ZAI_ROUTER_PORT": "18999"})),
			Executable: filepath.Join(t.TempDir(), "missing", "plugin-core"),
			BundlePath: "/zai.js",
			Out:        &fakes.RecordingOutput{},
		})
		_, err := deps.Host.EnsureRouter(context.Background())
		if err == nil || !strings.Contains(err.Error(), "no such file or directory") {
			t.Fatalf("ensureRouter error = %v, want the missing router copy", err)
		}
	})

	t.Run("passes the output port and the environment through", func(t *testing.T) {
		out := &fakes.RecordingOutput{}
		deps := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), out, "/zai.js")

		deps.Out.Line("hello")

		if !reflect.DeepEqual(out.Lines, []string{"hello"}) {
			t.Errorf("lines = %v, want [hello]", out.Lines)
		}
		if deps.Env["ZAI_STATE_DIR"] != deps.Host.StateRoot {
			t.Errorf("env state dir = %s, want %s", deps.Env["ZAI_STATE_DIR"], deps.Host.StateRoot)
		}
	})

	t.Run("spawnDriver runs the given bundle as `drive <id>` with its log in the job's dir", func(t *testing.T) {
		t.Setenv(engineChildEnv, "driver")
		bundle := filepath.Join(testkit.TempDir(t, "core-driver-"), "driver.mjs")
		if err := os.WriteFile(bundle, []byte("// the driver stand-in\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		deps := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, bundle)
		id := deps.Ids.JobID()

		pid := deps.Process.SpawnDriver(id)
		if err := testkit.Until(t, func() bool { return !deps.Process.IsAlive(pid) },
			testkit.UntilOptions{TimeoutMs: 20_000, Message: "the driver did not exit"}); err != nil {
			t.Fatal(err)
		}

		log, err := os.ReadFile(deps.Store.Paths(id).DriverLog)
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(log)) != "driver up" {
			t.Fatalf("driver log = %q, want %q", string(log), "driver up")
		}
	})

	// The binary's own interface is `plugin-core <provider> cli <args...>`; the driver is the
	// same binary re-entered with `<provider> cli drive <id>`, and any other argv shape is a
	// usage error the driver would die on.
	t.Run("spawnDriver starts the binary as `<provider> cli drive <id>`", func(t *testing.T) {
		t.Setenv(engineChildEnv, "driver-argv")
		deps := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js")
		id := "261006-argv1"

		pid := deps.Process.SpawnDriver(id)
		if err := testkit.Until(t, func() bool { return !deps.Process.IsAlive(pid) },
			testkit.UntilOptions{TimeoutMs: 20_000, Message: "the driver did not exit"}); err != nil {
			t.Fatal(err)
		}

		log, err := os.ReadFile(deps.Store.Paths(id).DriverLog)
		if err != nil {
			t.Fatal(err)
		}
		if want := "zai cli drive " + id; strings.TrimSpace(string(log)) != want {
			t.Fatalf("driver argv = %q, want %q", string(log), want)
		}
	})
}

// fileMode is a file's permission bits.
func fileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

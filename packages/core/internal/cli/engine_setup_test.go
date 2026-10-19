package cli_test

// The engine-setup suite: the engine flags of `setup` over real engine workers whose tools
// are this test binary's fake children.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

// engineSetupPong is the notes report every answering fake gives.
const engineSetupPong = `{"summary":"pong","findings":[],"open_items":[]}`

// engineSetupWorld is the plain-setup fakes plus real engine workers over the fake tool
// children of this binary, on a PATH of their own that resolves nothing.
type engineSetupWorld struct {
	fakes fakedeps.Fakes
	deps  engineSetupDeps
	// bin is the wrapper scripts' directory (each tool's reported binary); testbin is this
	// test binary the wrappers exec.
	bin     string
	testbin string
}

// engineSetupDeps is the deps the run takes (the fakes' with the engines wired in).
type engineSetupDeps = fakedeps.Fakes

// engineSetupBinEnv is the override naming a tool's binary under the provider's prefix.
func engineSetupBinEnv(provider domain.Provider, tool domain.EngineTool) string {
	return provider.EnvPrefix + "_" + strings.ToUpper(string(tool)) + "_BIN"
}

// engineSetupWrapper writes the tool's wrapper script: a configured one exec's this binary's
// fake child; an unconfigured one answers --version and stops the way a tool with no login stops.
func engineSetupWrapper(t *testing.T, dir string, tool domain.EngineTool, bin string, unconfigured bool) string {
	t.Helper()
	var body string
	if unconfigured {
		body = "[ \"$1\" = \"--version\" ] && { echo \"" + string(tool) + " 1.0.0\"; exit 0; }\necho \"No API key found for any provider. Log in first.\" >&2\nexit 1\n"
	} else if tool == domain.EngineToolOpencode {
		body = "[ \"$1\" = \"--version\" ] && { echo 1.18.34; exit 0; }\n" + engineSetupExec(bin, tool)
	} else {
		body = engineSetupExec(bin, tool)
	}
	file := filepath.Join(dir, string(tool))
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return file
}

// engineSetupExec is the exec line that runs the fake child in its tool's role.
func engineSetupExec(bin string, tool domain.EngineTool) string {
	return "CLI_ENGINE_CHILD=" + string(tool) + " exec \"" + bin + "\" \"$@\"\n"
}

// engineSetupAppBundle builds the desktop app's install layout: the bundled CLI, its built-in
// provider config, and the GUI executable — a script that starts the GUI and dies unless it was
// run as plain node, and otherwise runs this binary's fake zcode child.
func engineSetupAppBundle(t *testing.T, testbin string) (script, exe, config string) {
	t.Helper()
	root := testkit.TempDir(t, "engine-gui-")
	contents := filepath.Join(root, "ZCode.app", "Contents")
	script = filepath.Join(contents, "Resources", "glm", "zcode.cjs")
	config = filepath.Join(contents, "Resources", "config", "provider", "zcode-builtin.json")
	exe = filepath.Join(contents, "MacOS", "ZCode")
	for _, file := range []string{script, config} {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("// the bundled CLI\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	runner := "#!/bin/sh\n" +
		"[ \"$ELECTRON_RUN_AS_NODE\" = \"1\" ] || { echo \"Unable to find helper app\" >&2; exit 1; }\n" +
		engineSetupExec(testbin, domain.EngineToolZcode)
	if err := os.WriteFile(exe, []byte(runner), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, exe, config
}

// engineSetupNew builds the world with every tool on PATH: the configured ones answer, the rest
// stop the way a tool with no login stops.
func engineSetupNew(t *testing.T, provider *domain.Provider, configured ...domain.EngineTool) engineSetupWorld {
	t.Helper()
	return engineSetupWith(t, provider, domain.ENGINE_TOOLS, configured)
}

// engineSetupWith builds the world: only `present`'s tools are on PATH, `configured` of them
// answer their smoke run. The tools are this test binary's fake children behind wrapper scripts
// on a PATH of their own; a temp HOME keeps every tool setup away from the real user's.
func engineSetupWith(t *testing.T, provider *domain.Provider, present, configured []domain.EngineTool) engineSetupWorld {
	t.Helper()
	if provider == nil {
		reference := testkit.ReferenceProvider
		provider = &reference
	}
	bin := engineSetupFakeBin(t)
	path := testkit.TempDir(t, "engine-bin-")
	env := map[string]string{
		"PATH": path,
		"HOME": testkit.TempDir(t, "engine-home-"),
		// A developer machine may have the desktop app installed; its bundled script must not
		// be the zcode this suite reports (the override wins wherever a tool is present).
		"ZCODE_CLI": "zcode",
	}
	childTool := domain.EngineToolOmp
	isConfigured := func(tool domain.EngineTool) bool {
		for _, wanted := range configured {
			if wanted == tool {
				return true
			}
		}
		return false
	}
	for _, tool := range present {
		// The wrapper goes in as the tool's explicit binary: Go's exec resolves a bare name
		// against the parent's PATH, never the child's, so a name would reach the developer's
		// own tools instead of the fake.
		env[engineSetupBinEnv(*provider, tool)] = engineSetupWrapper(t, path, tool, bin, !isConfigured(tool))
	}
	for _, tool := range configured {
		childTool = tool
		for name, value := range engineSetupScenario(tool) {
			env[name] = value
		}
	}
	env[engineChildEnv] = string(childTool)
	world := fakedeps.FakeDepsIn(t, env, fakedeps.FakeWorld{Provider: provider})
	if fixture := world.Deps.Env["FAKE_OPENCODE_FIXTURE"]; fixture != "" {
		world.Deps.Env["FAKE_OPENCODE_FIXTURE"] = filepath.Join(testkit.ModuleRoot(t), fixture)
	}
	world.Deps.Engines = cli.EngineWorkers(cli.EngineWireOptions{
		Provider:    world.Deps.Provider,
		Env:         domain.EnvLookup(world.Deps.Env),
		StopGraceMs: 2_000,
	})
	// The engine children run in the state root (the smoke run's cwd); the marker go.mod keeps
	// the testkit's module-root walk from failing there before TestMain dispatches the role.
	// Nothing reads it.
	_ = os.WriteFile(filepath.Join(world.Deps.Host.StateRoot, "go.mod"),
		[]byte("module fake.engine.child\n"), 0o644)
	// The wrapper agents the plugin ships, sonnet until an enable rewrites them.
	for _, tool := range domain.ENGINE_TOOLS {
		agents := filepath.Join(cli.AgentsDir(world.Deps.BundlePath), string(tool)+".md")
		if err := os.MkdirAll(filepath.Dir(agents), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(agents, []byte("---\nname: "+string(tool)+"\nmodel: sonnet\n---\nbody\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return engineSetupWorld{fakes: world, deps: world, bin: path, testbin: bin}
}

// engineSetupFakeBin is the fake behind every wrapper: this test binary, re-executed in child
// mode.
func engineSetupFakeBin(t *testing.T) string {
	t.Helper()
	bin, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	return bin
}

// engineSetupScenario is the env that makes the fake tool answer its smoke run.
func engineSetupScenario(tool domain.EngineTool) map[string]string {
	scenario := map[string]string{}
	switch tool {
	case domain.EngineToolOmp:
		scenario["FAKE_OMP_FINAL_TEXT"] = engineSetupPong
	case domain.EngineToolPi:
		scenario["FAKE_PI_FINAL_TEXT"] = engineSetupPong
	case domain.EngineToolOpencode:
		scenario["FAKE_OPENCODE_FIXTURE"] = filepath.Join("testdata", "engines", "opencode", "happy.jsonl")
	}
	return scenario
}

// engineSetupRun runs the CLI over the world's deps.
func engineSetupRun(t *testing.T, world engineSetupWorld, args ...string) cli.ExitCode {
	t.Helper()
	return cli.RunCli(context.Background(), args, world.deps.Deps, "/repo")
}

// engineSetupAgentModel is the model the tool's wrapper agent names now.
func engineSetupAgentModel(t *testing.T, world engineSetupWorld, tool string) string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), tool+".md"))
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^model: (.*)$`).FindStringSubmatch(string(text))
	if match == nil {
		return ""
	}
	return match[1]
}

// engineSetupLastJSON is the last JSON document on stdout.
func engineSetupLastJSON(t *testing.T, world engineSetupWorld) map[string]any {
	t.Helper()
	lines := world.fakes.Out.Lines
	if len(lines) == 0 {
		t.Fatal("no JSON on stdout")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, lines[len(lines)-1])
	}
	return parsed
}

// engineSetupSmokeLine is the smoke line of a tool that answered.
func engineSetupSmokeLine(tool domain.EngineTool) *regexp.Regexp {
	on := ""
	if tool == domain.EngineToolOmp || tool == domain.EngineToolPi {
		on = " on zai/glm-5\\.3"
	}
	return regexp.MustCompile(`^ok: ` + string(tool) + ` answered` + on + ` \(` + string(tool) + `'s own numbers: \d+ turns?, \$[\d.]+\)$`)
}

// engineSetupEnginesPath is the state root's engines.json.
func engineSetupEnginesPath(world engineSetupWorld) string {
	return domain.NewStateLayout(world.fakes.Root).Engines
}

func TestSetupEngineCheck(t *testing.T) {
	for _, tool := range domain.ENGINE_TOOLS {
		t.Run(string(tool)+": plain setup's report plus binary, version and a smoke run of the tool as it is; nothing enabled", func(t *testing.T) {
			world := engineSetupNew(t, nil, tool)

			code := engineSetupRun(t, world, "setup", "--engine-check", string(tool), "--json")
			report := map[string]any{}
			if len(world.fakes.Out.Lines) > 0 {
				report = engineSetupLastJSON(t, world)
			}
			if code != cli.ExitOK || report["engine"] == nil {
				t.Fatalf("exit = %d; engine = %v\nlines = %q\nstderr = %q", code, report["engine"], world.fakes.Out.Lines, world.fakes.Out.Errors)
			}
			if report["ready"] != true {
				t.Fatalf("ready = %v\n%s", report["ready"], world.fakes.Out.Text())
			}
			key := report["key"].(map[string]any)
			if key["ok"] != true || key["value"] != "ZAI_API_KEY" {
				t.Fatalf("key = %v", key)
			}
			router, hasRouter := report["router"].(map[string]any)
			if !hasRouter || router["ok"] != true {
				names := make([]string, 0, len(report))
				for name := range report {
					names = append(names, name)
				}
				sort.Strings(names)
				t.Fatalf("router = %v; keys = %q; doc = %s", report["router"], names, world.fakes.Out.Lines[len(world.fakes.Out.Lines)-1])
			}
			engine := report["engine"].(map[string]any)
			if engine["engine"] != string(tool) || engine["ready"] != true {
				t.Fatalf("engine = %v", engine)
			}
			binary := engine["binary"].(map[string]any)
			if binary["ok"] != true || binary["value"] != filepath.Join(world.bin, string(tool)) {
				t.Fatalf("binary = %v", binary)
			}
			version := engine["version"].(map[string]any)
			if version["ok"] != true {
				t.Fatalf("version = %v", version)
			}
			smoke := engine["smoke"].(map[string]any)
			if smoke["ok"] != true || !engineSetupSmokeLine(tool).MatchString(smoke["value"].(string)) {
				t.Fatalf("smoke = %v", smoke)
			}
			if engine["watcher"] != nil {
				t.Fatalf("watcher = %v", engine["watcher"])
			}
			watchers := engine["watchers"].(map[string]any)
			if watchers["provider"] != "GLM 5.3 (Z.ai GLM)" || watchers["sonnet"] != "Claude Sonnet" {
				t.Fatalf("watchers = %v", watchers)
			}
			// The check changes nothing about the engine.
			if _, err := os.Stat(engineSetupEnginesPath(world)); err == nil {
				t.Fatal("engines.json was written")
			}
			if model := engineSetupAgentModel(t, world, string(tool)); model != "sonnet" {
				t.Fatalf("agent model = %q", model)
			}
		})
	}

	t.Run("prints plain setup's report, then the engine's lines and the current watcher", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		adapters.CreateFsEngineConfig(world.fakes.Root).Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolOmp: {Watcher: domain.WatcherSonnet, Version: "omp/18.6.1", Path: "omp"},
			},
		})

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.fakes.Out.Text()
		if !strings.HasPrefix(text, "zai setup: ready.") {
			t.Fatalf("report =\n%s", text)
		}
		for _, want := range []string{
			"zai setup: omp engine",
			"  binary:  " + filepath.Join(world.bin, "omp"),
			"  version: omp/18.6.1",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("%q missing from\n%s", want, text)
			}
		}
		if !regexp.MustCompile(`\n {2}smoke: {3}ok: omp answered on zai/glm-5\.3 \(omp's own numbers: \d+ turns?, \$[\d.]+\)\n`).MatchString(text) {
			t.Fatalf("smoke line missing from\n%s", text)
		}
		if !strings.HasSuffix(text, "  watcher: Claude Sonnet (current)\nready") {
			t.Fatalf("report =\n%s", text)
		}
	})

	for _, tool := range domain.ENGINE_TOOLS {
		t.Run(string(tool)+" not logged in or configured fails its smoke line, telling the user to set the tool up, exit 6", func(t *testing.T) {
			world := engineSetupNew(t, nil)

			if code := engineSetupRun(t, world, "setup", "--engine-check", string(tool), "--json"); code != cli.ExitNotReady {
				t.Fatalf("exit = %d, want 6", code)
			}
			report := engineSetupLastJSON(t, world)
			if report["ready"] != false {
				t.Fatalf("ready = %v", report["ready"])
			}
			engine := report["engine"].(map[string]any)
			for _, line := range []string{"binary", "version"} {
				check := engine[line].(map[string]any)
				if check["ok"] != true {
					t.Fatalf("%s = %v", line, check)
				}
			}
			smoke := engine["smoke"].(map[string]any)
			if smoke["ok"] != false {
				t.Fatalf("smoke = %v", smoke)
			}
			if !regexp.MustCompile(`; run ` + string(tool) + ` once and log in / configure it; the plugin uses it as it is$`).MatchString(smoke["error"].(string)) {
				t.Fatalf("smoke error = %v", smoke["error"])
			}
			if _, err := os.Stat(engineSetupEnginesPath(world)); err == nil {
				t.Fatal("engines.json was written")
			}
		})
	}

	t.Run("every provider checks every tool the same way: qwen-like providers included", func(t *testing.T) {
		world := engineSetupNew(t, &testkit.AcmeProvider, domain.EngineToolPi)

		if code := engineSetupRun(t, world, "setup", "--engine-check", "pi", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		report := engineSetupLastJSON(t, world)
		if report["ready"] != true {
			t.Fatalf("ready = %v\n%s", report["ready"], world.fakes.Out.Text())
		}
		engine := report["engine"].(map[string]any)
		if smoke := engine["smoke"].(map[string]any); smoke["ok"] != true {
			t.Fatalf("smoke = %v", smoke)
		}
	})

	t.Run("a tool missing from PATH fails its binary line and exits 6", func(t *testing.T) {
		world := engineSetupWith(t, nil, nil, nil)

		if code := engineSetupRun(t, world, "setup", "--engine-check", "opencode", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		report := engineSetupLastJSON(t, world)
		engine := report["engine"].(map[string]any)
		binary := engine["binary"].(map[string]any)
		if binary["ok"] != false || binary["error"] != "opencode is not on PATH" {
			t.Fatalf("binary = %v", binary)
		}
		version := engine["version"].(map[string]any)
		if version["ok"] != false || version["error"] != "not run: no binary" {
			t.Fatalf("version = %v", version)
		}
		smoke := engine["smoke"].(map[string]any)
		if smoke["ok"] != false || smoke["error"] != "not run: fix the lines above first" {
			t.Fatalf("smoke = %v", smoke)
		}
	})

	t.Run("the smoke run needs nothing of the provider's, but the check is ready only once plain setup is", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		world.fakes.Host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"}

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		report := engineSetupLastJSON(t, world)
		if report["ready"] != false {
			t.Fatalf("ready = %v", report["ready"])
		}
		key := report["key"].(map[string]any)
		if key["ok"] != false {
			t.Fatalf("key = %v", key)
		}
		engine := report["engine"].(map[string]any)
		if engine["ready"] != false {
			t.Fatalf("engine ready = %v", engine["ready"])
		}
		if binary := engine["binary"].(map[string]any); binary["ok"] != true {
			t.Fatalf("binary = %v", binary)
		}
		if smoke := engine["smoke"].(map[string]any); smoke["ok"] != true {
			t.Fatalf("smoke = %v", smoke)
		}
	})

	t.Run("an explicit binary path must be an executable file", func(t *testing.T) {
		found := cli.FindBinary("/nonexistent/omp", "")
		if found.OK || found.Error != "/nonexistent/omp is not an executable file" {
			t.Fatalf("findBinary = %+v", found)
		}
	})
}

func TestSetupEngines(t *testing.T) {
	t.Run("reads what the setup menu asks from and changes nothing: setup not run, every tool found, none enabled", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.ENGINE_TOOLS...)

		if code := engineSetupRun(t, world, "setup", "--engines", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		report := engineSetupLastJSON(t, world)
		if report["setup"] != false {
			t.Fatalf("setup = %v", report["setup"])
		}
		engines := report["engines"].([]any)
		if len(engines) != len(domain.ENGINE_TOOLS) {
			t.Fatalf("engines = %v", engines)
		}
		for i, tool := range domain.ENGINE_TOOLS {
			entry := engines[i].(map[string]any)
			if entry["engine"] != string(tool) {
				t.Fatalf("engine = %v", entry)
			}
			binary := entry["binary"].(map[string]any)
			if binary["ok"] != true || binary["value"] != filepath.Join(world.bin, string(tool)) {
				t.Fatalf("binary = %v", binary)
			}
			if entry["watcher"] != nil {
				t.Fatalf("watcher = %v", entry["watcher"])
			}
		}
		if _, err := os.Stat(engineSetupEnginesPath(world)); err == nil {
			t.Fatal("engines.json was written")
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "sonnet" {
			t.Fatalf("agent model = %q", model)
		}
	})

	t.Run("names the recorded watchers and a missing binary", func(t *testing.T) {
		world := engineSetupWith(t, &testkit.AcmeProvider,
			[]domain.EngineTool{domain.EngineToolOmp}, []domain.EngineTool{domain.EngineToolOmp})
		cli.RecordSetupDone(world.fakes.Root)
		adapters.CreateFsEngineConfig(world.fakes.Root).Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolOmp: {Watcher: domain.WatcherProvider, Version: "1", Path: "omp"},
			},
		})

		if code := engineSetupRun(t, world, "setup", "--engines", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		report := engineSetupLastJSON(t, world)
		if report["setup"] != true {
			t.Fatalf("setup = %v", report["setup"])
		}
		engines := report["engines"].([]any)
		want := []map[string]any{
			{"engine": "omp", "binary": map[string]any{"ok": true, "value": filepath.Join(world.bin, "omp")}, "watcher": "provider"},
			{"engine": "opencode", "binary": map[string]any{"ok": false, "error": "opencode is not on PATH"}, "watcher": nil},
			{"engine": "pi", "binary": map[string]any{"ok": false, "error": "pi is not on PATH"}, "watcher": nil},
			{"engine": "zcode", "binary": map[string]any{"ok": false, "error": "zcode is not on PATH"}, "watcher": nil},
		}
		if !reflect.DeepEqual(engines, []any{want[0], want[1], want[2], want[3]}) {
			got, _ := json.Marshal(engines)
			expected, _ := json.Marshal([]any{want[0], want[1], want[2], want[3]})
			t.Fatalf("engines =\n%s\nwant\n%s", got, expected)
		}

		if code := engineSetupRun(t, world, "setup", "--engines"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		last := world.fakes.Out.Lines[len(world.fakes.Out.Lines)-1]
		wantText := strings.Join([]string{
			"acme setup: done",
			"  omp:      installed (" + filepath.Join(world.bin, "omp") + "); enabled, watched by Big Model 9 (Acme Models)",
			"  opencode: not found: opencode is not on PATH; not enabled",
			"  pi:       not found: pi is not on PATH; not enabled",
			"  zcode:    not found: zcode is not on PATH; not enabled",
		}, "\n")
		if last != wantText {
			t.Fatalf("status =\n%s\nwant\n%s", last, wantText)
		}
	})

	t.Run("prints that setup has not run yet", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolPi)
		adapters.CreateFsEngineConfig(world.fakes.Root).Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolPi: {Watcher: domain.WatcherSonnet, Version: "1", Path: "pi"},
			},
		})

		if code := engineSetupRun(t, world, "setup", "--engines"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.fakes.Out.Lines[len(world.fakes.Out.Lines)-1]
		if first := strings.SplitN(text, "\n", 2)[0]; first != "zai setup: not run yet" {
			t.Fatalf("status = %q", text)
		}
		if !strings.Contains(text, "; enabled, watched by Claude Sonnet") {
			t.Fatalf("status = %q", text)
		}
	})
}

func TestSetupEngineEnable(t *testing.T) {
	t.Run("enables a readable app-bundled ZCode script without an executable bit", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolZcode)
		// The desktop app's layout: a readable glm/zcode.cjs without an executable bit, run by
		// the app's own executable three directories up — here a script that re-runs this
		// binary's fake zcode child, so no real node ever starts.
		root := testkit.TempDir(t, "engine-app-")
		if err := os.MkdirAll(filepath.Join(root, "Resources", "glm"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "MacOS"), 0o755); err != nil {
			t.Fatal(err)
		}
		script := filepath.Join(root, "Resources", "glm", "zcode.cjs")
		if err := os.WriteFile(script, []byte("// the bundled CLI\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		app := filepath.Join(root, "MacOS", "ZCode")
		runner := "#!/bin/sh\nCLI_ENGINE_CHILD=zcode exec \"" + world.testbin + "\" \"$@\"\n"
		if err := os.WriteFile(app, []byte(runner), 0o755); err != nil {
			t.Fatal(err)
		}
		world.deps.Deps.Env[engineSetupBinEnv(world.deps.Deps.Provider, domain.EngineToolZcode)] = script
		world.deps.Deps.Engines = cli.EngineWorkers(cli.EngineWireOptions{
			Provider:    world.deps.Deps.Provider,
			Env:         domain.EnvLookup(world.deps.Deps.Env),
			StopGraceMs: 100,
		})

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "zcode", "--watcher", "provider"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0; errors = %q", code, world.fakes.Out.Errors)
		}
		config := adapters.CreateFsEngineConfig(world.fakes.Root).Read()
		setting, ok := config.Engines[domain.EngineToolZcode]
		if !ok {
			t.Fatalf("engines = %v", config.Engines)
		}
		want := domain.EngineSetting{Watcher: domain.WatcherProvider, Version: "zcode 0.16.1", Path: script}
		if setting != want {
			t.Fatalf("setting = %+v, want %+v", setting, want)
		}
		if model := engineSetupAgentModel(t, world, "zcode"); model != "glm-5.3" {
			t.Fatalf("agent model = %q", model)
		}
	})

	t.Run("enables zcode whose binary is a symlink to the desktop app's GUI executable", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolZcode)
		script, exe, config := engineSetupAppBundle(t, world.testbin)
		// `zcode` on the tool's PATH is a symlink to the GUI executable; the CLI is the bundle's
		// script, and the config is what that CLI cannot find on its own. The tool's binary
		// override names the symlink, the way the PATH find would.
		link := filepath.Join(world.bin, "zcode")
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(exe, link); err != nil {
			t.Fatal(err)
		}
		world.deps.Deps.Env["FAKE_ZCODE_ENV_LOG"] = filepath.Join(testkit.TempDir(t, "engine-env-"), "env.json")
		world.deps.Deps.Engines = cli.EngineWorkers(cli.EngineWireOptions{
			Provider:    world.deps.Deps.Provider,
			Env:         domain.EnvLookup(world.deps.Deps.Env),
			StopGraceMs: 100,
		})

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "zcode", "--watcher", "provider"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0; errors = %q", code, world.fakes.Out.Errors)
		}
		setting, ok := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines[domain.EngineToolZcode]
		if !ok {
			t.Fatal("zcode was not recorded")
		}
		// The recorded binary is the bundle's script, and the version ran through it: the GUI
		// executable refuses to answer anything without ELECTRON_RUN_AS_NODE.
		want := domain.EngineSetting{Watcher: domain.WatcherProvider, Version: "zcode 0.16.1", Path: script}
		if setting != want {
			t.Fatalf("setting = %+v, want %+v", setting, want)
		}
		// The check's smoke run reaches the tool the same way: as plain node, config named.
		if code := engineSetupRun(t, world, "setup", "--engine-check", "zcode"); code != cli.ExitOK {
			t.Fatalf("check exit = %d, want 0; errors = %q", code, world.fakes.Out.Errors)
		}
		data, err := os.ReadFile(world.deps.Deps.Env["FAKE_ZCODE_ENV_LOG"])
		if err != nil {
			t.Fatal(err)
		}
		var childEnv map[string]string
		if err := json.Unmarshal(data, &childEnv); err != nil {
			t.Fatal(err)
		}
		if childEnv["ELECTRON_RUN_AS_NODE"] != "1" {
			t.Fatalf("ELECTRON_RUN_AS_NODE = %q, want 1", childEnv["ELECTRON_RUN_AS_NODE"])
		}
		if childEnv["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] != config {
			t.Fatalf("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = %q, want %s",
				childEnv["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"], config)
		}
	})

	t.Run("finds the bundle's CLI when no engines are wired", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolZcode)
		script, exe, _ := engineSetupAppBundle(t, world.testbin)
		link := filepath.Join(world.bin, "zcode")
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(exe, link); err != nil {
			t.Fatal(err)
		}
		// The lookup goes through the PATH entry alone: no override, no engines.
		world.deps.Deps.Env["ZCODE_CLI"] = ""
		world.deps.Deps.Env[engineSetupBinEnv(world.deps.Deps.Provider, domain.EngineToolZcode)] = ""
		world.deps.Deps.Engines = nil

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "zcode", "--watcher", "provider"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0; errors = %q", code, world.fakes.Out.Errors)
		}
		setting, ok := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines[domain.EngineToolZcode]
		if !ok {
			t.Fatal("zcode was not recorded")
		}
		if setting.Path != script || setting.Version != "zcode 0.16.1" {
			t.Fatalf("setting = %+v, want the bundle's script at zcode 0.16.1", setting)
		}
	})

	t.Run("records the engine and its watcher and points the wrapper agent at the watcher's model; rerunning switches", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		adapters.CreateFsEngineConfig(world.fakes.Root).Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolPi: {Watcher: domain.WatcherSonnet, Version: "1", Path: "pi"},
			},
		})

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "omp", "--watcher", "provider"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if last := world.fakes.Out.Lines[len(world.fakes.Out.Lines)-1]; last !=
			"zai: omp enabled; zai:omp runs on glm-5.3 (watcher: GLM 5.3 (Z.ai GLM))" {
			t.Fatalf("line = %q", last)
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "glm-5.3" {
			t.Fatalf("agent model = %q", model)
		}
		engines := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines
		if got := engines[domain.EngineToolOmp]; got != (domain.EngineSetting{
			Watcher: domain.WatcherProvider, Version: "omp/18.6.1", Path: filepath.Join(world.bin, "omp"),
		}) {
			t.Fatalf("omp = %+v", got)
		}
		if _, has := engines[domain.EngineToolPi]; !has {
			t.Fatalf("engines = %v", engines)
		}

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "omp", "--watcher", "sonnet", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		report := engineSetupLastJSON(t, world)
		want := map[string]any{
			"engine":  "omp",
			"enabled": true,
			"watcher": "sonnet",
			"agent":   "zai:omp",
			"model":   "sonnet",
		}
		if !reflect.DeepEqual(report, want) {
			t.Fatalf("report = %v, want %v", report, want)
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "sonnet" {
			t.Fatalf("agent model = %q", model)
		}
		engines = adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines
		if engines[domain.EngineToolOmp].Watcher != domain.WatcherSonnet {
			t.Fatalf("omp = %+v", engines[domain.EngineToolOmp])
		}
		if _, has := engines[domain.EngineToolPi]; !has {
			t.Fatalf("engines = %v", engines)
		}
	})

	t.Run("refuses a tool that is not installed, writing nothing (exit 6)", func(t *testing.T) {
		present := []domain.EngineTool{domain.EngineToolOmp, domain.EngineToolOpencode}
		world := engineSetupWith(t, &testkit.AcmeProvider, present, present)

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "pi", "--watcher", "sonnet"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if !reflect.DeepEqual(world.fakes.Out.Errors, []string{"acme: cannot enable pi: pi is not on PATH"}) {
			t.Fatalf("errors = %q", world.fakes.Out.Errors)
		}
		if _, err := os.Stat(engineSetupEnginesPath(world)); err == nil {
			t.Fatal("engines.json was written")
		}
	})

	usageCases := []struct {
		args    []string
		message string
	}{
		{[]string{"--engine-check", "cursor"}, "--engine-check takes omp, opencode, pi or zcode"},
		{[]string{"--engine-enable", "cursor", "--watcher", "sonnet"}, "--engine-enable takes omp, opencode, pi or zcode"},
		{[]string{"--engine-enable", "omp"}, "--engine-enable needs --watcher provider or --watcher sonnet"},
		{[]string{"--engine-enable", "omp", "--watcher", "opus"}, "--engine-enable needs --watcher provider or --watcher sonnet"},
		{[]string{"--watcher", "sonnet"}, "--watcher goes with --engine-enable"},
		{[]string{"--engines", "--engine-check", "omp"}, "--engines takes no other setup flag"},
		{[]string{"--engines", "--engine-enable", "omp", "--watcher", "sonnet"}, "--engines takes no other setup flag"},
		{[]string{"--engines", "--watcher", "sonnet"}, "--engines takes no other setup flag"},
	}
	for _, tt := range usageCases {
		t.Run("setup "+strings.Join(tt.args, " ")+" is a usage error", func(t *testing.T) {
			world := engineSetupNew(t, nil)

			if code := engineSetupRun(t, world, append([]string{"setup"}, tt.args...)...); code != cli.ExitUsage {
				t.Fatalf("exit = %d, want 2", code)
			}
			if world.fakes.Out.Errors[0] != "zai: "+tt.message {
				t.Fatalf("error = %q", world.fakes.Out.Errors[0])
			}
		})
	}
}

func TestSetupRemoveEngines(t *testing.T) {
	t.Run("clears the enabled engines and puts the wrapper agent back on its model before setup", func(t *testing.T) {
		world := engineSetupNew(t, nil)
		if code := engineSetupRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		// The wrapper agent as an older install left it: not the shipped sonnet, so only the
		// ledger can put it back.
		agent := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "omp.md")
		if err := os.WriteFile(agent, []byte("---\nname: omp\nmodel: haiku\n---\nbody\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "omp", "--watcher", "provider"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "glm-5.3" {
			t.Fatalf("agent model = %q", model)
		}
		ledger, ok := router.ReadLedger(context.Background(), domain.NewStateLayout(world.fakes.Root).Ledger)
		if !ok {
			t.Fatal("no ledger")
		}
		if got, has := ledger.Agents.Get("omp"); !has || got == nil || *got != "haiku" {
			t.Fatalf("ledger agents = %v", ledger.Agents)
		}
		if _, has := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines[domain.EngineToolOmp]; !has {
			t.Fatal("omp was not enabled")
		}

		removed := cli.RemoveRouting(context.Background(), cli.NewSetupDeps(world.deps.Deps))

		if !removed.Agents.OK {
			t.Fatalf("agents = %+v", removed.Agents)
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "haiku" {
			t.Fatalf("agent model = %q", model)
		}
		if engines := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines; len(engines) != 0 {
			t.Fatalf("engines = %v", engines)
		}
	})
}

func TestSetupHookReappliesWatchers(t *testing.T) {
	// hookWorld is the world with the recorded watchers and the main agent's model set.
	hookWorld := func(t *testing.T, mainModel string) engineSetupWorld {
		world := engineSetupNew(t, nil, domain.EngineToolOmp, domain.EngineToolPi)
		main := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "glm-5.3.md")
		if err := os.WriteFile(main, []byte("model: "+mainModel+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		adapters.CreateFsEngineConfig(world.fakes.Root).Write(domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolOmp: {Watcher: domain.WatcherProvider, Version: "1", Path: "omp"},
				domain.EngineToolPi:  {Watcher: domain.WatcherSonnet, Version: "1", Path: "pi"},
			},
		})
		return world
	}

	t.Run("a plugin update reset the agent files: the provider watcher goes back to the provider's model", func(t *testing.T) {
		world := hookWorld(t, "glm-5.3")
		pi := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "pi.md")
		if err := os.WriteFile(pi, []byte("model: glm-5.3\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		if code := engineSetupRun(t, world, "setup", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		for tool, want := range map[string]string{"omp": "glm-5.3", "pi": "sonnet", "opencode": "sonnet"} {
			if model := engineSetupAgentModel(t, world, tool); model != want {
				t.Fatalf("%s model = %q, want %q", tool, model, want)
			}
		}
		// Repairs are silent: nothing for Claude's context, nothing for the user.
		if len(world.fakes.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.fakes.Out.Lines)
		}

		if code := engineSetupRun(t, world, "setup", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.fakes.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.fakes.Out.Lines)
		}
	})

	t.Run("while the main agent runs on Sonnet (no router), a provider watcher runs on Sonnet too", func(t *testing.T) {
		world := hookWorld(t, "sonnet")
		omp := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "omp.md")
		if err := os.WriteFile(omp, []byte("model: glm-5.3\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		if code := engineSetupRun(t, world, "setup", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if model := engineSetupAgentModel(t, world, "omp"); model != "sonnet" {
			t.Fatalf("agent model = %q", model)
		}
	})

	t.Run("a config from before engines (no file, or one it cannot read) changes nothing", func(t *testing.T) {
		world := engineSetupNew(t, nil)
		if code := engineSetupRun(t, world, "setup", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if err := os.WriteFile(engineSetupEnginesPath(world), []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		if code := engineSetupRun(t, world, "setup", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.fakes.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.fakes.Out.Lines)
		}
		if engines := adapters.CreateFsEngineConfig(world.fakes.Root).Read().Engines; len(engines) != 0 {
			t.Fatalf("engines = %v", engines)
		}
	})
}

func TestSetupHookRepairOrder(t *testing.T) {
	t.Run("the repair line follows engines.json's own key order, not the canonical one", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp, domain.EngineToolPi)
		main := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "glm-5.3.md")
		if err := os.WriteFile(main, []byte("model: glm-5.3\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// Both wrapper agents were reset to the wrong model, so both are repaired; the file
		// records pi before omp.
		for tool, model := range map[domain.EngineTool]string{
			domain.EngineToolOmp: "sonnet",
			domain.EngineToolPi:  "glm-5.3",
		} {
			agent := filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), string(tool)+".md")
			if err := os.WriteFile(agent, []byte("model: "+model+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(engineSetupEnginesPath(world), []byte(`{
  "engines": {
    "pi": {"watcher": "sonnet", "version": "1", "path": "pi"},
    "omp": {"watcher": "provider", "version": "1", "path": "omp"}
  }
}
`), 0o644); err != nil {
			t.Fatal(err)
		}

		code := cli.WithEngineHook(context.Background(), world.deps.Deps,
			func(context.Context) cli.ExitCode { return cli.ExitOK })

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.fakes.Out.Lines) != 1 {
			t.Fatalf("lines = %q", world.fakes.Out.Lines)
		}
		want := "zai: repaired — zai:pi → sonnet, zai:omp → glm-5.3"
		if got := world.fakes.Out.Lines[0]; got != want {
			t.Fatalf("repair line = %q, want %q", got, want)
		}
	})
}

func TestSetupEngineEdgeLines(t *testing.T) {
	t.Run("without wired engines the smoke line says to fix the lines above first", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		// The engines go missing (a host this process cannot build workers on); the binary and
		// the version still answer.
		world.deps.Deps.Engines = nil

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		engine := engineSetupLastJSON(t, world)["engine"].(map[string]any)
		for _, line := range []string{"binary", "version"} {
			check := engine[line].(map[string]any)
			if check["ok"] != true {
				t.Fatalf("%s = %v", line, check)
			}
		}
		smoke := engine["smoke"].(map[string]any)
		if smoke["ok"] != false || smoke["error"] != "not run: fix the lines above first" {
			t.Fatalf("smoke = %v", smoke)
		}
	})

	t.Run("a tool whose --version fails names the failure on its version line", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		broken := filepath.Join(world.bin, "omp")
		if err := os.WriteFile(broken, []byte("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 1\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		engine := engineSetupLastJSON(t, world)["engine"].(map[string]any)
		version := engine["version"].(map[string]any)
		if version["ok"] != false {
			t.Fatalf("version = %v", version)
		}
	})

	t.Run("a worker that fails outside its contract is described as a start failure", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		plain := &plainErrorWorker{}
		world.deps.Deps.Engines = &app.EngineWorkers{
			Worker: func(domain.EngineTool) ports.Worker { return plain },
			Bin:    world.deps.Deps.Engines.Bin,
		}

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		engine := engineSetupLastJSON(t, world)["engine"].(map[string]any)
		smoke := engine["smoke"].(map[string]any)
		if smoke["ok"] != false || !strings.Contains(smoke["error"].(string), "cannot start claude: ") {
			t.Fatalf("smoke = %v", smoke)
		}
	})

	t.Run("enabling a tool whose wrapper agent file is missing says so, exit 6", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		if err := os.Remove(filepath.Join(cli.AgentsDir(world.deps.Deps.BundlePath), "omp.md")); err != nil {
			t.Fatal(err)
		}

		if code := engineSetupRun(t, world, "setup", "--engine-enable", "omp", "--watcher", "sonnet"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if len(world.fakes.Out.Errors) == 0 || !strings.Contains(world.fakes.Out.Errors[0], "cannot enable omp: ") {
			t.Fatalf("errors = %q", world.fakes.Out.Errors)
		}
	})

	t.Run("the engine check passes the base run's error lines through to the real stderr", func(t *testing.T) {
		world := engineSetupNew(t, nil, domain.EngineToolOmp)
		world.fakes.Host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"}
		entry := &engineSetupKeyEntry{}
		world.deps.Deps.Host.KeyEntry = entry
		world.fakes.Host.KeyEntry = entry

		if code := engineSetupRun(t, world, "setup", "--engine-check", "omp", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if joined := strings.Join(world.fakes.Out.Errors, "\n"); !strings.Contains(joined, "key: cannot open the key page") {
			t.Fatalf("errors = %q", world.fakes.Out.Errors)
		}
	})
}

// plainErrorWorker is a worker whose start fails outside the worker contract, as a broken adapter
// does.
type plainErrorWorker struct{}

func (w *plainErrorWorker) Caps() ports.WorkerCapabilities  { return testkit.ReferenceCaps }
func (w *plainErrorWorker) Preflight(context.Context) error { return nil }
func (w *plainErrorWorker) Start(context.Context, ports.WorkerSpec) (ports.WorkerRun, error) {
	return nil, errors.New("the bridge is not built")
}
func (w *plainErrorWorker) Dispose(context.Context) error         { return nil }
func (w *plainErrorWorker) ParseLine(string) []domain.WorkerEvent { return nil }

// engineSetupKeyEntry is the key-page fake whose page cannot start.
type engineSetupKeyEntry struct{}

func (e *engineSetupKeyEntry) Store(context.Context) ports.KeyStore {
	return testkit.NewMemoryKeyStore("", "", "")
}
func (e *engineSetupKeyEntry) Check(context.Context, string) ports.KeyVerdict {
	return ports.KeyVerdictAccepted
}
func (e *engineSetupKeyEntry) OpenPage(context.Context) (string, error) {
	return "", errOf("cannot start the key page")
}
func (e *engineSetupKeyEntry) PageOpen(context.Context, string) bool { return false }
func (e *engineSetupKeyEntry) RemoveFromFile(context.Context, string) bool {
	return true
}

package cli_test

// The engine-wire suite: the delegation engines wired over the reference provider, driven
// through the app's drive and reaper against the fake engines this test binary re-executes
// itself as.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// notesReport is the notes report every finishing fake answers with.
const notesReport = `{"summary":"pong","findings":[],"open_items":[]}`

// engineScenario is one fake's two environments: the one that finishes a run with a notes report,
// and the one that hangs until it is stopped.
type engineScenario struct {
	finishes map[string]string
	hangs    map[string]string
}

// engineFakes is the fakes table: per engine, the env that makes the fake finish and the env
// that makes it hang. The bin is always this test binary, its role chosen by CLI_ENGINE_CHILD.
var engineFakes = map[domain.EngineTool]engineScenario{
	domain.EngineToolZcode: {
		finishes: map[string]string{},
		hangs:    map[string]string{"FAKE_ZCODE_HANG": "1"},
	},
	domain.EngineToolOmp: {
		finishes: map[string]string{"FAKE_OMP_FINAL_TEXT": notesReport},
		hangs:    map[string]string{"FAKE_OMP_SCENARIO": "sleep"},
	},
	domain.EngineToolPi: {
		finishes: map[string]string{"FAKE_PI_FINAL_TEXT": notesReport},
		hangs:    map[string]string{"FAKE_PI_SCENARIO": "sleep"},
	},
	domain.EngineToolOpencode: {
		finishes: map[string]string{
			"FAKE_OPENCODE_FIXTURE": filepath.Join("testdata", "engines", "opencode", "happy.jsonl"),
		},
		hangs: map[string]string{
			"FAKE_OPENCODE_FIXTURE": filepath.Join("testdata", "engines", "opencode", "happy.jsonl"),
			"FAKE_OPENCODE_HANG":    "1",
		},
	},
}

// engineFakeBin is the fake every engine runs as: this test binary, re-executed in child mode.
func engineFakeBin(t *testing.T) string {
	t.Helper()
	bin, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	return bin
}

// engineChildCwd marks a directory an engine child runs in: this binary's own testkit/fakes init
// walks up from its working directory to the module's go.mod, and the child runs in the job's
// workspace, so a marker go.mod keeps that walk from failing before TestMain dispatches the role.
// Nothing reads the marker.
func engineChildCwd(dir string) string {
	_ = os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module fake.engine.child\n"), 0o644)
	return dir
}

// engineRealProcess is the real liveness and group termination, with no driver.
type engineRealProcess struct{}

func (engineRealProcess) IsAlive(pid int64) bool { return process.IsAlive(pid) }

func (engineRealProcess) TerminateGroup(ctx context.Context, pid int64, graceMs int64) error {
	process.TerminateGroup(ctx, pid, graceMs)
	return nil
}

func (engineRealProcess) SpawnDriver(string) int64 {
	panic("no driver in this test")
}

// engineWorld is real engine workers over the fakes, the scenario passed the way a brief
// passes env: by name.
func engineWorld(t *testing.T, tool domain.EngineTool, scenario map[string]string) (fakedeps.Fakes, app.Deps) {
	t.Helper()
	env := map[string]string{}
	for name, value := range scenario {
		env[name] = value
	}
	env["PATH"] = os.Getenv("PATH")
	env[engineChildEnv] = string(tool)
	env["ZAI_"+strings.ToUpper(string(tool))+"_BIN"] = engineFakeBin(t)
	if tool == domain.EngineToolOpencode {
		env["FAKE_OPENCODE_FIXTURE"] = filepath.Join(testkit.ModuleRoot(t), env["FAKE_OPENCODE_FIXTURE"])
	}
	world := fakedeps.FakeDepsIn(t, env, fakedeps.FakeWorld{}, []fakes.WorkerScript{}...)
	engines := cli.EngineWorkers(cli.EngineWireOptions{
		Provider:    testkit.ReferenceProvider,
		Env:         domain.EnvLookup(world.Deps.Env),
		StopGraceMs: 2_000,
	})
	world.Deps.Engines = engines
	world.Deps.Process = engineRealProcess{}
	return world, world.Deps
}

// engineJob is a readonly notes job on the engine in a real directory, every scenario variable
// passed through brief env.
func engineJob(t *testing.T, world fakedeps.Fakes, tool domain.EngineTool, scenario map[string]string) domain.Job {
	t.Helper()
	repo := engineChildCwd(testkit.TempDir(t, "engine-repo-"))
	paths := world.Store.Paths("j1")
	if err := os.MkdirAll(paths.Artifacts, 0o755); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(scenario))
	for name := range scenario {
		names = append(names, name)
	}
	engine := tool
	return world.Store.Put(testkit.AJob(func(j *domain.Job) {
		j.ID = "j1"
		j.Brief = testkit.ABrief(func(b *domain.Brief) {
			b.Engine = &engine
			b.Mode = domain.ModeReadonly
			b.Model = domain.ModelTierFlash
			b.Scope = []string{}
			b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportNotes}
			b.Retries = domain.Retries{Fix: 0, Infra: 0}
			b.Env = names
			b.TimeoutMs = 60_000
		})
		j.Workspace = domain.Workspace{RepoRoot: repo, BaseSha: strings.Repeat("b", 40), ArtifactsDir: paths.Artifacts}
	}))
}

// enginePidOnceRunning waits for the engine's own pid record, the only place the pid of a started
// engine is known (ports.WorkerRun carries none).
func enginePidOnceRunning(t *testing.T, file string) int64 {
	t.Helper()
	var pid int64
	if err := testkit.Until(t, func() bool {
		recorded, ok := adapters.ReadEnginePid(file)
		if ok {
			pid = recorded
			return true
		}
		return false
	}, testkit.UntilOptions{TimeoutMs: 20_000, Message: "the engine never recorded its pid"}); err != nil {
		t.Fatal(err)
	}
	return pid
}

// engineKillGroup ends a group this test started, only while its leader is still the child it
// recorded (testkit.PidMatches before any signal to a pid read from a file).
func engineKillGroup(t *testing.T, pid int64, graceMs int64) {
	t.Helper()
	if !engineGroupAlive(pid) || !testkit.PidMatches(pid, "", os.Getpid()) {
		return
	}
	process.TerminateGroup(context.Background(), pid, graceMs)
}

func TestEngineWireDrive(t *testing.T) {
	for _, tool := range domain.ENGINE_TOOLS {
		t.Run("the "+string(tool)+" engine, as the user set it up, through the fake", func(t *testing.T) {
			scenario := engineFakes[tool]
			t.Run("drives a job to review on the engine; afterwards no engine process is left and the pid is forgotten", func(t *testing.T) {
				world, deps := engineWorld(t, tool, scenario.finishes)
				job := engineJob(t, world, tool, scenario.finishes)

				driven, err := app.Drive(context.Background(), deps, job.ID)
				if err != nil {
					t.Fatalf("drive: %v", err)
				}
				if driven.State != domain.JobStateAwaitingReview {
					t.Fatalf("state = %s, want awaiting_review", driven.State)
				}
				attempt := driven.Attempts[0]
				if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeCompleted {
					t.Fatalf("outcome = %+v, want completed", attempt.Outcome)
				}
				if attempt.Usage == nil || attempt.Usage.Turns <= 0 {
					t.Fatalf("usage = %+v, want turns > 0", attempt.Usage)
				}
				// The model is the tool's own report: omp and pi name theirs, opencode's and
				// zcode's run output names none.
				var want *string
				if tool == domain.EngineToolOmp || tool == domain.EngineToolPi {
					reported := "zai/glm-5.3"
					want = &reported
				}
				if got := attempt.Usage.Model; (got == nil) != (want == nil) || (got != nil && *got != *want) {
					t.Fatalf("usage model = %v, want %v", got, want)
				}
				if _, err := os.Stat(world.Store.Paths(job.ID).EnginePid); err == nil {
					t.Fatal("the engine's pid record is still there")
				}
				if got := len(world.Worker.Specs()); got != 0 {
					t.Fatalf("the scripted worker ran %d specs, want 0", got)
				}
			})

			t.Run("a stop mid-run ends the job and kills the engine's whole process group", func(t *testing.T) {
				world, deps := engineWorld(t, tool, scenario.hangs)
				job := engineJob(t, world, tool, scenario.hangs)
				ctx, cancel := context.WithCancel(context.Background())
				type driven struct {
					job domain.Job
					err error
				}
				done := make(chan driven, 1)
				go func() {
					job, err := app.Drive(ctx, deps, job.ID)
					done <- driven{job, err}
				}()
				pid := enginePidOnceRunning(t, world.Store.Paths(job.ID).EnginePid)
				cancel()
				select {
				case result := <-done:
					if result.err != nil {
						t.Fatalf("drive: %v", result.err)
					}
					if verdict := result.job.Attempts[0].Verdict; verdict == nil || *verdict != domain.VerdictStopped {
						t.Fatalf("verdict = %v, want stopped", verdict)
					}
				case <-time.After(60 * time.Second):
					t.Fatal("the drive did not end")
				}
				if err := testkit.Until(t, func() bool { return !engineGroupAlive(pid) },
					testkit.UntilOptions{TimeoutMs: 10_000, Message: "the engine's process group is still alive"}); err != nil {
					engineKillGroup(t, pid, 500)
					t.Fatal(err)
				}
			})

			t.Run("after the driver died, the cleanup pass kills the engine's process group", func(t *testing.T) {
				world, deps := engineWorld(t, tool, scenario.hangs)
				job := engineJob(t, world, tool, scenario.hangs)
				worker := deps.Engines.Worker(tool)
				started, err := worker.Start(context.Background(), ports.WorkerSpec{
					Cwd:       job.Workspace.RepoRoot,
					Model:     testkit.ReferenceProvider.Catalog[domain.ModelTierFlash],
					Access:    ports.AccessReadonly,
					Prompt:    "Wait.",
					Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-7000-8000-0000000000d1"},
					Report:    app.BuiltinContract(domain.BuiltinReportNotes),
					AddDirs:   []string{},
					PassEnv:   scenario.hangs,
					TimeoutMs: 60_000,
					LogPath:   world.Store.Paths(job.ID).AttemptLog(1),
				})
				if err != nil {
					t.Fatalf("the %s worker did not start: %v", tool, err)
				}
				file := world.Store.Paths(job.ID).EnginePid
				pid := enginePidOnceRunning(t, file)
				t.Cleanup(func() { engineKillGroup(t, pid, 500) })
				// The driver that held the job is gone: its pid is in the lock file, but nothing
				// answers to it.
				world.Store.HoldLock(job.ID, 1<<22+12_345)

				app.ReapOrphanEngines(context.Background(), deps, []domain.Job{job})
				started.Wait()

				if err := testkit.Until(t, func() bool { return !engineGroupAlive(pid) },
					testkit.UntilOptions{TimeoutMs: 10_000, Message: "the engine's process group is still alive"}); err != nil {
					t.Fatal(err)
				}
				if _, ok := adapters.ReadEnginePid(file); ok {
					t.Fatal("the engine's pid record is still there")
				}
			})
		})
	}
}

// engineRecorders is the scenario plus a recorder of the tool's argv and environment, per fake.
func engineRecorders(t *testing.T, tool domain.EngineTool, dir string) map[string]string {
	t.Helper()
	prefix := "FAKE_" + strings.ToUpper(string(tool))
	scenario := map[string]string{}
	for name, value := range engineFakes[tool].finishes {
		if name == "FAKE_OPENCODE_FIXTURE" {
			value = filepath.Join(testkit.ModuleRoot(t), value)
		}
		scenario[name] = value
	}
	scenario[prefix+"_ARGV_LOG"] = filepath.Join(dir, "argv.json")
	scenario[prefix+"_ENV_LOG"] = filepath.Join(dir, "env.json")
	return scenario
}

func TestEngineWorkersTools(t *testing.T) {
	t.Run("every provider offers all four tools the same way", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, map[string]string{"ACME_OMP_BIN": "/opt/omp"}, fakedeps.FakeWorld{Provider: &testkit.AcmeProvider}, []fakes.WorkerScript{}...)
		engines := cli.EngineWorkers(cli.EngineWireOptions{
			Provider:    testkit.AcmeProvider,
			Env:         domain.EnvLookup(world.Deps.Env),
			StopGraceMs: 100,
		})

		names := make([]string, 0, len(domain.ENGINE_TOOLS))
		for _, tool := range domain.ENGINE_TOOLS {
			names = append(names, string(engines.Worker(tool).Caps().Name))
		}
		want := "omp-rpc, opencode, pi-rpc, zcode"
		if got := strings.Join(names, ", "); got != want {
			t.Fatalf("caps names = %s, want %s", got, want)
		}
		if got := engines.Bin(domain.EngineToolOmp); got != "/opt/omp" {
			t.Fatalf("omp bin = %s, want /opt/omp", got)
		}
		if got := engines.Bin(domain.EngineToolOpencode); got != "opencode" {
			t.Fatalf("opencode bin = %s, want opencode", got)
		}
	})

	for _, tool := range domain.ENGINE_TOOLS {
		t.Run(string(tool)+" gets no provider key, base URL, model or config of the plugin's", func(t *testing.T) {
			dir := engineChildCwd(testkit.TempDir(t, "engine-env-"))
			parent := map[string]string{
				"PATH":                 os.Getenv("PATH"),
				"HOME":                 dir,
				"OPENROUTER_API_KEY":   "users-own-key",
				"ZAI_API_KEY":          "plugin-provider-key",
				"ZAI_BASE_URL":         testkit.ReferenceProvider.BaseURL,
				"ZAI_MODEL_MAIN":       "glm-9",
				"ANTHROPIC_BASE_URL":   "http://127.0.0.1:18787",
				"ANTHROPIC_AUTH_TOKEN": "router-token",
				"CLAUDECODE":           "1",
				"ZAI_" + strings.ToUpper(string(tool)) + "_BIN": engineFakeBin(t),
				engineChildEnv: string(tool),
			}
			engines := cli.EngineWorkers(cli.EngineWireOptions{
				Provider:    testkit.ReferenceProvider,
				Env:         domain.EnvLookup(parent),
				StopGraceMs: 500,
			})
			worker := engines.Worker(tool)
			if err := worker.Preflight(context.Background()); err != nil {
				t.Fatalf("preflight: %v", err)
			}
			started, err := worker.Start(context.Background(), ports.WorkerSpec{
				Cwd:       dir,
				Model:     testkit.ReferenceProvider.Catalog[domain.ModelTierMain],
				Access:    ports.AccessWrite,
				Prompt:    "Hi.",
				Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-7000-8000-0000000000d2"},
				Report:    app.BuiltinContract(domain.BuiltinReportNotes),
				AddDirs:   []string{},
				PassEnv:   withRecorderKey(engineRecorders(t, tool, dir)),
				TimeoutMs: 30_000,
				LogPath:   filepath.Join(dir, "attempt-1.jsonl"),
			})
			if err != nil {
				t.Fatalf("%s did not start: %v", tool, err)
			}
			for range started.Events() {
				// drained
			}
			started.Wait()

			argvText, err := os.ReadFile(filepath.Join(dir, "argv.json"))
			if err != nil {
				t.Fatal(err)
			}
			envText, err := os.ReadFile(filepath.Join(dir, "env.json"))
			if err != nil {
				t.Fatal(err)
			}
			var argv []string
			if json.Unmarshal(argvText, &argv) != nil {
				t.Fatalf("argv.json is not a JSON array: %s", argvText)
			}
			var env map[string]string
			if json.Unmarshal(envText, &env) != nil {
				t.Fatalf("env.json is not a JSON object: %s", envText)
			}
			if env["HOME"] != dir {
				t.Errorf("HOME = %q, want %q", env["HOME"], dir)
			}
			if env["OPENROUTER_API_KEY"] != "users-own-key" {
				t.Errorf("OPENROUTER_API_KEY = %q, want the user's own key", env["OPENROUTER_API_KEY"])
			}
			for _, name := range testkit.ReferenceProvider.KeyEnv {
				if _, has := env[name]; has {
					t.Errorf("%s reached the engine", name)
				}
			}
			var routed []string
			for name := range env {
				if strings.HasPrefix(name, "ZAI_") || strings.HasPrefix(name, "ANTHROPIC_") {
					routed = append(routed, name)
				}
			}
			if len(routed) > 0 {
				t.Errorf("the engine saw routing variables: %s", strings.Join(routed, ", "))
			}
			wire := string(argvText) + string(envText)
			for _, leak := range []string{"plugin-provider-key", "brief-supplied", "api.z.ai", "18787", "glm-5.3", "glm-9"} {
				if strings.Contains(wire, leak) {
					t.Errorf("the wire carries %q", leak)
				}
			}
			for _, flag := range []string{"--model", "-m"} {
				for _, arg := range argv {
					if arg == flag {
						t.Errorf("argv carries %s", flag)
					}
				}
			}
			// No per-process config of the tool's: nothing written beside the attempt log.
			if _, err := os.Stat(filepath.Join(dir, "engine")); err == nil {
				t.Error("an engine config dir was written beside the attempt log")
			}
		})
	}
}

// withRecorderKey adds the brief-supplied provider key, which must never reach the engine.
func withRecorderKey(recorders map[string]string) map[string]string {
	withKey := make(map[string]string, len(recorders)+1)
	for name, value := range recorders {
		withKey[name] = value
	}
	withKey["ZAI_API_KEY"] = "brief-supplied"
	return withKey
}

// engineGroupAlive reports whether any member of the group led by pid is still there.
func engineGroupAlive(pid int64) bool {
	err := syscall.Kill(-int(pid), 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

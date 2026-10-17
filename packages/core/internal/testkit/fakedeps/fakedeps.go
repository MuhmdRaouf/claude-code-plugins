// Package fakedeps builds a full fake app.Deps over the testkit fakes (writeAgents, FakeHost,
// Fakes, FakeWorld, fakeDeps). Unit tests of app/ and cli/ run on these; the job directories
// (stop file, progress.json, attempt logs) live under a real temp dir so the app's file
// sidecars work.
package fakedeps

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// ReferenceStateRoot is the reference provider's state-root rule (core's testing
// REFERENCE_STATE_ROOT). It lives here, not beside ReferenceProvider in package testkit: that
// package cannot import adapters, whose own internal tests import testkit (a test import cycle).
var ReferenceStateRoot = adapters.StateRootRule{
	EnvVar:     "ZAI_STATE_DIR",
	DataPrefix: "zai-",
	XdgName:    "zai",
}

// WriteAgents writes the agents beside the bundle, `model: sonnet` as the plugin ships them, so
// setup's rewrite has something to hit.
func WriteAgents(bundlePath string, provider domain.Provider, model ...string) {
	modelID := "sonnet"
	if len(model) > 0 {
		modelID = model[0]
	}
	dir := filepath.Join(filepath.Dir(bundlePath), "..", "agents")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	for _, tier := range []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash} {
		agent := filepath.Join(dir, provider.Agents[tier]+".md")
		if err := os.WriteFile(agent, []byte("model: "+modelID+"\n"), 0o644); err != nil {
			panic(err)
		}
	}
}

// FakeHost is a claude-shaped host with one extra check, the key line, as zai reports it. Every
// answer reads the fields at call time, so a test overrides them after the Deps is built.
type FakeHost struct {
	StateRoot string
	provider  domain.Provider

	WorkerBin string
	Runtime   string
	// Version and VersionErr are one result: the value or the error.
	Version    string
	VersionErr error
	// Key and KeyErr are one result: the key or the worker error.
	Key    ports.ProviderKey
	KeyErr *ports.WorkerError
	// Router and RouterErr are one result: the line or the error.
	Router    string
	RouterErr error
	// RouterRetire and RouterRetireErr are one result: the line or the error.
	RouterRetire    string
	RouterRetireErr error
	// KeyEntry is absent by default: setup only reports the key. Tests of the key page set a fake.
	KeyEntry ports.KeyEntry
	// RouterKey and RouterKeyErr are one result: the variable's name or the error.
	RouterKey    string
	RouterKeyErr error
}

// NewFakeHost answers zai's defaults over the state root; another provider changes the router
// line's port.
func NewFakeHost(stateRoot string, provider ...domain.Provider) *FakeHost {
	theProvider := testkit.ReferenceProvider
	if len(provider) > 0 {
		theProvider = provider[0]
	}
	return &FakeHost{
		StateRoot:    stateRoot,
		provider:     theProvider,
		WorkerBin:    "/usr/local/bin/claude",
		Runtime:      "bun 1.3.14 (/usr/local/bin/bun)",
		Version:      "2.1.289 (Claude Code)",
		Key:          ports.ProviderKey{Value: "zai-test-key", Source: "ZAI_API_KEY"},
		Router:       "running on " + domain.RouterBaseURL(theProvider, domain.EnvLookup{}) + " (pid 4242)",
		RouterRetire: "stopped (was not running)",
		RouterKey:    "ZAI_API_KEY",
	}
}

// HostInfo is the same host as the app's Deps takes.
func (h *FakeHost) HostInfo() app.HostInfo {
	return app.HostInfo{
		StateRoot: h.StateRoot,
		WorkerBin: h.WorkerBin,
		Runtime:   h.Runtime,
		WorkerVersion: func(context.Context) (string, error) {
			return h.Version, h.VersionErr
		},
		LoadKey: func(context.Context) (ports.ProviderKey, error) {
			if h.KeyErr != nil {
				return ports.ProviderKey{}, h.KeyErr
			}
			return h.Key, nil
		},
		EnsureRouter: func(context.Context) (string, error) {
			return h.Router, h.RouterErr
		},
		RetireRouter: func(context.Context) (string, error) {
			return h.RouterRetire, h.RouterRetireErr
		},
		KeyEntry: h.KeyEntry,
		RouterKey: func(context.Context) (string, error) {
			return h.RouterKey, h.RouterKeyErr
		},
		ExtraChecks: h.ExtraChecks,
	}
}

// ExtraChecks is the key line, as zai reports it: the key's source when it loaded, the described
// error when it did not.
func (h *FakeHost) ExtraChecks(ctx context.Context) []app.SetupCheck {
	source, loadErr := adapters.KeySource(h.Key, h.KeyErr)
	if loadErr == nil {
		return []app.SetupCheck{{
			Label:  "key",
			Result: app.StringResult{OK: true, Value: source},
			Text:   "present (" + source + ")",
		}}
	}
	described := app.DescribeWorkerError(h.provider, *loadErr)
	return []app.SetupCheck{{
		Label:  "key",
		Result: app.StringResult{Error: described},
		Text:   "MISSING: " + described,
	}}
}

// Fakes is every fake plus the Deps over them, with the files, engine config and spool the
// returned object carries.
type Fakes struct {
	Root         string
	Store        *fakes.MemoryStore
	Files        ports.JobFiles
	EngineConfig ports.EngineConfigStore
	Spool        ports.RouteSpool
	Git          *fakes.FakeGit
	Gates        *fakes.FakeGates
	Worker       *fakes.ScriptedWorker
	Limiter      *fakes.FakeLimiter
	Semaphore    *fakes.FakeSemaphore
	Clock        *fakes.ManualClock
	Ids          *fakes.FakeIds
	Process      *fakes.FakeProcess
	Out          *fakes.RecordingOutput
	Host         *FakeHost
	Deps         app.Deps
}

// FakeWorld is what a plugin's own fakes swap in: its provider, its worker's dialect and its host.
type FakeWorld struct {
	Provider *domain.Provider
	Dialect  *fakes.WorkerDialect
	Host     func(root string) *FakeHost
}

// FakeDeps builds a Deps over fresh fakes rooted in a temp dir; the worker plays one completing
// script (the last one repeats).
func FakeDeps(t testing.TB, scripts ...fakes.WorkerScript) Fakes {
	return FakeDepsIn(t, nil, FakeWorld{}, scripts...)
}

// FakeDepsIn is FakeDeps with the env and the world fakeDeps takes: env lands in Deps.Env and the
// spool reader (an explicit HOME always wins), world swaps the provider, the dialect and the host.
func FakeDepsIn(t testing.TB, env map[string]string, world FakeWorld, scripts ...fakes.WorkerScript) Fakes {
	root := testkit.TempDir(t, "core-app-")
	provider := testkit.ReferenceProvider
	if world.Provider != nil {
		provider = *world.Provider
	}
	processes := fakes.NewFakeProcess()
	// A HOME under the temp root, so anything that would touch ~/.claude or ~/.agents stays in the
	// sandbox; an explicit HOME always wins.
	fullEnv := make(map[string]string, len(env)+1)
	for name, value := range env {
		fullEnv[name] = value
	}
	if _, explicit := fullEnv["HOME"]; !explicit {
		fullEnv["HOME"] = filepath.Join(root, "home")
	}
	if scripts == nil {
		scripts = []fakes.WorkerScript{fakes.Completes()}
	}
	dialect := fakes.EVENT_DIALECT
	if world.Dialect != nil {
		dialect = *world.Dialect
	}
	host := NewFakeHost(root, provider)
	if world.Host != nil {
		host = world.Host(root)
	}

	store := fakes.NewMemoryStore(root)
	files := adapters.CreateFsJobFiles(root)
	engineConfig := adapters.CreateFsEngineConfig(root)
	git := fakes.NewFakeGit()
	gates := fakes.NewFakeGates()
	worker := fakes.NewScriptedWorkerInDialect(dialect, t, processes, scripts...)
	limiter := fakes.NewFakeLimiter()
	semaphore := fakes.NewFakeSemaphore()
	clock := fakes.NewManualClock()
	ids := fakes.NewFakeIds()
	out := &fakes.RecordingOutput{}

	bundlePath := filepath.Join(root, "plugin", "dist", provider.Name+".js")
	// A freshly installed plugin ships its agents on Sonnet; setup's wiring is what moves them to
	// the provider.
	WriteAgents(bundlePath, provider)

	deps := app.Deps{
		Worker:       worker,
		Git:          git,
		Gates:        gates,
		Store:        store,
		Files:        files,
		EngineConfig: engineConfig,
		Spool:        spool.CreateSpoolReader(fullEnv),
		Semaphore:    semaphore,
		Limiter:      limiter,
		Clock:        clock,
		Ids:          ids,
		Process:      processes,
		Out:          out,
		Host:         host.HostInfo(),
		BundlePath:   bundlePath,
		Provider:     provider,
		Env:          fullEnv,
		Config:       app.Config{Limiter: domain.DEFAULT_LIMITER, Prompt: domain.DefaultLimits, StopGraceMs: 100},
	}
	return Fakes{
		Root:         root,
		Store:        store,
		Files:        files,
		EngineConfig: engineConfig,
		Spool:        deps.Spool,
		Git:          git,
		Gates:        gates,
		Worker:       worker,
		Limiter:      limiter,
		Semaphore:    semaphore,
		Clock:        clock,
		Ids:          ids,
		Process:      processes,
		Out:          out,
		Host:         host,
		Deps:         deps,
	}
}

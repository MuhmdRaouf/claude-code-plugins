// The composition every plugin's cli is: real adapters over the provider's state root, handed to
// the CLI.
package cli

import (
	"context"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/authpage"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
)

// wireStopGraceMs is between SIGTERM and SIGKILL when a run is stopped.
const wireStopGraceMs int64 = 10_000

// wirePrivate is a directory only the owner reads.
const wirePrivate os.FileMode = 0o700

// WireOptions shape Wire.
type WireOptions struct {
	Provider domain.Provider
	Env      domain.EnvLookup
	// Executable is this binary (os.Executable() in cmd): the detached driver re-runs it with
	// BundlePath, and the router start copies it into the state root.
	Executable string
	// BundlePath is this plugin's CLI bundle: the detached driver re-runs it as `drive <id>`, and
	// the agents sit beside it.
	BundlePath string
	Out        ports.Output
}

// wirePrivateDir creates dir (mode 0700), tightening one that already exists.
func wirePrivateDir(path string) string {
	_ = os.MkdirAll(path, wirePrivate)
	_ = os.Chmod(path, wirePrivate)
	return path
}

// Wire builds real adapters over the provider's state root (and its claude-home config dir), both
// created mode 0700.
func Wire(ctx context.Context, options WireOptions) app.Deps {
	provider, env := options.Provider, options.Env
	root := wirePrivateDir(adapters.StateRoot(ctx, provider, env))
	configDir := wirePrivateDir(domain.NewStateLayout(root).ClaudeHome)
	bin := env[provider.EnvPrefix+"_CLAUDE_BIN"]
	if bin == "" {
		bin = "claude"
	}
	key := func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError) {
		return adapters.LoadKey(ctx, provider, env, provider.KeyFile,
			keystore.PlatformKeyStore(provider, env, keystore.PlatformOptions{}))
	}
	hostKey := func(ctx context.Context) (ports.ProviderKey, error) {
		loaded, err := key(ctx)
		if err != nil {
			return ports.ProviderKey{}, err
		}
		return loaded, nil
	}
	clock := ports.Clock(adapters.CreateSystemClock())
	pins := PinsOf(env)
	if pins.NowMS != 0 {
		clock = adapters.CreateFixedClock(pins.NowMS)
	}
	ids := adapters.CreateIds()
	if pins.SequentialIDs {
		ids = adapters.CreateSequentialIDs(root, clock)
	}
	store := adapters.CreateFsStore(root, process.IsAlive)
	config := app.Config{
		Limiter:     domain.DEFAULT_LIMITER,
		Prompt:      domain.DefaultLimits,
		StopGraceMs: wireStopGraceMs,
	}
	limiter := adapters.CreateFsLimiter(root, config.Limiter)
	// Env overrides (model ids, endpoint, region) reach the jobs, as they reach the router: the
	// catalog the app and the worker read is the resolved one, while names, labels and the key
	// loader stay the shipped provider's.
	resolved := domain.ResolveProvider(provider, env)
	gates := ports.GateRunner(adapters.CreateShellGates(provider.Name))
	if pins.NowMS != 0 {
		// The pinned session zeroes gate durations for the golden transcript: the wall clock
		// they measure with stays real, only what is printed is pinned.
		gates = zeroedGates{gates}
	}
	return app.Deps{
		Worker: adapters.NewClaudeHeadlessWorker(adapters.ClaudeHeadlessOptions{
			Provider:    resolved,
			Bin:         bin,
			ConfigDir:   configDir,
			LoadKey:     key,
			ParentEnv:   env,
			StopGraceMs: wireStopGraceMs,
		}),
		Engines:      EngineWorkers(EngineWireOptions{Provider: resolved, Env: env, StopGraceMs: wireStopGraceMs}),
		Git:          adapters.CreateGitCli(provider.Name),
		Gates:        gates,
		Store:        store,
		Files:        adapters.CreateFsJobFiles(root),
		EngineConfig: adapters.CreateFsEngineConfig(root),
		Spool:        spool.CreateSpoolReader(env),
		Semaphore: adapters.CreateFsSemaphore(root,
			func(ctx context.Context) (int, error) {
				return limiter.Capacity(ctx, clock.Now()), nil
			},
			process.IsAlive, clock.Sleep, clock.Now),
		Limiter: limiter,
		Clock:   clock,
		Ids:     ids,
		Process: adapters.CreateProcessControl(options.Executable, provider.Name,
			func(id string) string { return store.Paths(id).DriverLog }),
		Out: options.Out,
		Host: app.HostInfo{
			StateRoot: root,
			WorkerBin: bin,
			Runtime:   runtimeOf(pins),
			WorkerVersion: func(ctx context.Context) (string, error) {
				return process.ToolVersion(ctx, bin, nil)
			},
			LoadKey: hostKey,
			EnsureRouter: func(ctx context.Context) (string, error) {
				if pins.RouterLine != "" {
					return pins.RouterLine, nil
				}
				// The router start copies this binary into the state root: after the release the
				// plugin's only plugin-core is the running one, never one beside the bundles.
				return router.StartRouter(ctx, router.StartOptions{
					Provider:  provider,
					Env:       env,
					StateRoot: root,
					Source:    options.Executable,
					BudgetMs:  4000,
					Say:       options.Out.Line,
				})
			},
			RetireRouter: func(ctx context.Context) (string, error) {
				return router.RetireRouter(ctx, router.RetireOptions{StopOptions: router.StopOptions{
					Provider: provider, Env: env, StateRoot: root,
				}}), nil
			},
			StartWatchdog: func(ctx context.Context, sessionPid int64) {
				router.StartSessionWatchdog(provider, env, sessionPid)
			},
			RouterKey: func(ctx context.Context) (string, error) {
				if pins.RouterKey != "" {
					return pins.RouterKey, nil
				}
				return router.RouterKeyCheck(ctx, provider, env, root, 0)
			},
			ExtraChecks: func(ctx context.Context) []app.SetupCheck {
				loaded, err := key(ctx)
				var source string
				if err == nil {
					source = loaded.Source
				}
				return []app.SetupCheck{KeyCheck(provider, source, err)}
			},
			KeyEntry: authpage.CreateKeyEntry(authpage.KeyEntryOptions{
				Provider: resolved,
				Env:      env,
			}),
		},
		BundlePath: options.BundlePath,
		Provider:   resolved,
		Env:        env,
		Config:     config,
	}
}

// KeyCheck is the `key` setup line: where the provider's key comes from (an env name or the key
// file path), never the key itself.
func KeyCheck(provider domain.Provider, source string, sourceErr *ports.WorkerError) app.SetupCheck {
	if sourceErr == nil {
		return app.SetupCheck{
			Label:  "key",
			Result: app.StringResult{OK: true, Value: source},
			Text:   "present (" + source + ")",
		}
	}
	described := app.DescribeWorkerError(provider, *sourceErr)
	return app.SetupCheck{
		Label:  "key",
		Result: app.StringResult{Error: described},
		Text:   "MISSING: " + described,
	}
}

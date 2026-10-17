// The router bundle's entry: `plugin-core <name> router run | worker | start | stop | status`.
// `run` is the front (it forks the worker by re-executing this binary), `start` brings the router
// up the way setup and the hooks do, `stop` and `status` are for people. No service manager: the
// plugin starts one detached process and its hooks bring it back. Process glue only; the logic
// lives in front.go, worker.go, process.go and uninstall.go, and the chaos suite runs this file
// for real.
package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// RouterServiceOptions is what the router entry needs.
type RouterServiceOptions struct {
	// Provider is whose router this is: port, health path, model ids, strip list and endpoint all
	// come from it.
	Provider domain.Provider
	// StateRoot is the plugin's state root; the router's copies and log live under
	// `<stateRoot>/router`. Empty resolves it from the environment the way the plugin entry does.
	StateRoot string
	// Script is this binary: the front forks it as the worker, and `start` copies it into the
	// state root.
	Script string
	Env    domain.EnvLookup
	// Argv is the command line after the entry name: Argv[0] is the command, the rest its arguments.
	Argv []string
	// Out receives the entry's lines; nil is os.Stdout. Err the usage error; nil is os.Stderr.
	Out io.Writer
	Err io.Writer
	// Spawn starts the router the `start` command runs; nil is the production detached spawn.
	Spawn SpawnDetached
	// Exit ends the process from the paths that own it (the front's done callback, the worker's
	// drain); nil is os.Exit.
	Exit func(code int)
}

// serviceTuning is the knobs the chaos suite shrinks (`${envPrefix}_ROUTER_TUNING`, JSON);
// production never sets it.
type serviceTuning struct {
	HeartbeatMs    int64   `json:"heartbeatMs"`
	HangMs         int64   `json:"hangMs"`
	ExitWindowMs   int64   `json:"exitWindowMs"`
	DegradeExits   int     `json:"degradeExits"`
	DegradedMs     int64   `json:"degradedMs"`
	RssLimitMb     float64 `json:"rssLimitMb"`
	StartMs        int64   `json:"startMs"`
	WaitWorkerMs   int64   `json:"waitWorkerMs"`
	AckWaitMs      int64   `json:"ackWaitMs"`
	DrainMs        int64   `json:"drainMs"`
	KeyCheckMs     int64   `json:"keyCheckMs"`
	BodyLimit      int64   `json:"bodyLimit"`
	IdleMs         int64   `json:"idleMs"`
	FrontVersion   *int    `json:"frontVersion"`
	StartWaitMs    int64   `json:"startWaitMs"`
	WatchEveryMs   int64   `json:"watchEveryMs"`
	RetiredEveryMs int64   `json:"retiredEveryMs"`
	RetiredMaxMs   *int64  `json:"retiredMaxMs"`
	// StartDelayMs holds the front's start open after its signals are registered, so a test can
	// stop it mid-start; production never sets it.
	StartDelayMs int64 `json:"startDelayMs"`
}

// serviceTuningOf parses the tuning knob; anything unparsable is no tuning at all.
func serviceTuningOf(provider domain.Provider, env domain.EnvLookup) serviceTuning {
	var tuning serviceTuning
	if raw, ok := env[provider.EnvPrefix+"_ROUTER_TUNING"]; ok {
		_ = json.Unmarshal([]byte(raw), &tuning)
	}
	return tuning
}

// knobsOf is the tuning as the front's knobs (a zero field takes its default).
func knobsOf(tuning serviceTuning) FrontKnobs {
	return FrontKnobs{
		HeartbeatMs:  tuning.HeartbeatMs,
		HangMs:       tuning.HangMs,
		ExitWindowMs: tuning.ExitWindowMs,
		DegradeExits: tuning.DegradeExits,
		DegradedMs:   tuning.DegradedMs,
		RssLimitMb:   tuning.RssLimitMb,
		StartMs:      tuning.StartMs,
		WaitWorkerMs: tuning.WaitWorkerMs,
		AckWaitMs:    tuning.AckWaitMs,
		DrainMs:      tuning.DrainMs,
		KeyCheckMs:   tuning.KeyCheckMs,
		BodyLimit:    tuning.BodyLimit,
	}
}

// serviceCleanupJobs removes decided jobs' worktrees and branches; undecided ones are listed in
// LEFT-BEHIND.md.
func serviceCleanupJobs(ctx context.Context, options RouterServiceOptions) {
	var left []LeftBehind
	// The state root may already be gone with the plugin's data dir; nothing is left to clean.
	defer func() { _ = recover() }()
	git := adapters.CreateGitCli(options.Provider.Name)
	for _, job := range adapters.CreateFsStore(options.StateRoot, process.IsAlive).List(ctx, ports.ListFilter{}) {
		decided := job.State == domain.JobStateAccepted || job.State == domain.JobStateDiscarded
		switch {
		case decided && job.Workspace.Worktree != nil && job.Workspace.Branch != nil:
			_ = git.RemoveWorktree(ctx, job.Workspace.RepoRoot, *job.Workspace.Worktree, *job.Workspace.Branch)
		case !decided:
			left = append(left, LeftBehind{ID: job.ID, Worktree: job.Workspace.Worktree})
		}
	}
	WriteLeftBehind(options.StateRoot, options.Provider.Name, left)
}

// restoreLedgerAgents puts the agents setup changed back on the models the ledger recorded before
// it, when their files are still there (a disabled plugin keeps them; an uninstall has already
// deleted them). The agents are walked in the order they were recorded, the ledger's own order.
func restoreLedgerAgents(ctx context.Context, ledger Ledger) []string {
	if ledger.Agents == nil || ledger.AgentsDir == nil {
		return nil
	}
	var restored []string
	for _, agent := range ledger.Agents.Names() {
		model, _ := ledger.Agents.Get(agent)
		written, err := adapters.WriteModelLine(ctx, filepath.Join(*ledger.AgentsDir, agent+".md"), model)
		if err != nil || !written {
			continue
		}
		named := "(none)"
		if model != nil {
			named = *model
		}
		restored = append(restored, agent+": "+named)
	}
	return restored
}

// serviceUninstallActions is what the uninstall watch does on this machine: settings, registry,
// the router's own files, decided jobs. closeLog is the front's log off switch, flipped just
// before the router files go (closableLog); nil leaves the log open.
func serviceUninstallActions(ctx context.Context, options RouterServiceOptions, note func(line string), closeLog func()) UninstallActions {
	provider, env, stateRoot := options.Provider, options.Env, options.StateRoot
	layout := domain.NewStateLayout(stateRoot)
	return UninstallActions{
		Presence: func(ledger Ledger) Presence {
			return PluginPresence(provider.Name, adapters.ClaudeConfigDir(env), ledger.Marker, nil)
		},
		Undo: func(ledger Ledger) error {
			var live []string
			for _, entry := range LiveRouters(ctx, env, provider.Name, nil) {
				live = append(live, fmt.Sprintf("http://127.0.0.1:%d", entry.Port))
			}
			lines, err := adapters.UndoProviderSettings(ctx, ledger.SettingsPath, provider.Name,
				ledger.Settings, ledger.RouterURL, live)
			switch {
			case err != nil:
				note("plugin removed: " + err.Error())
			case len(lines) == 0:
				note("plugin removed: settings already clean")
			default:
				note("plugin removed: " + strings.Join(lines, "; "))
			}
			if agents := restoreLedgerAgents(ctx, ledger); len(agents) > 0 {
				note(fmt.Sprintf("plugin removed: agents restored (%s)", strings.Join(agents, ", ")))
			}
			_ = os.Remove(layout.SetupDone)
			return nil
		},
		Remove: func(ledger Ledger, disabled bool) error {
			RemoveRegistryEntry(env, provider.Name)
			// The OS keystore item goes only when this plugin's setup put it there.
			if ledger.Keystore.Created {
				if store := keystore.PlatformKeyStore(provider, env, keystore.PlatformOptions{}); store != nil {
					_ = store.Remove(ctx)
				}
			}
			serviceCleanupJobs(ctx, options)
			// Nothing may open the router log past this point: the directory goes next.
			if closeLog != nil {
				closeLog()
			}
			RemoveRouterFiles(stateRoot)
			return nil
		},
	}
}

// closableLog is one log line writer behind an off switch. The retiring front closes its router
// log before RemoveRouterFiles: the write and the close share one lock, so a line in flight lands
// before it and no line opens a new file behind the removal.
func closableLog(log func(line string)) (write func(line string), off func()) {
	var mu sync.Mutex
	closed := false
	write = func(line string) {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return
		}
		log(line)
	}
	off = func() {
		mu.Lock()
		defer mu.Unlock()
		closed = true
	}
	return write, off
}

// releaseSpawnedLog frees the front's own handles on the router log: the starter spawns the router
// with stdout and stderr appending to that very file (StartDetached), and the handles live until the
// process ends. The retiring front points
// both streams at the null device and closes the old ones just before it removes the router's
// files — nothing prints any more, and the panic paths already go to the crash log. The answer is
// whether both old streams were closed.
func releaseSpawnedLog(stdout, stderr *os.File) bool {
	return releaseSpawnedLogWith(func() (*os.File, error) {
		return os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	}, stdout, stderr)
}

// releaseSpawnedLogWith is releaseSpawnedLog over an injected null-device opener, so its failure
// is testable on any platform.
func releaseSpawnedLogWith(openNull func() (*os.File, error), stdout, stderr *os.File) bool {
	null, err := openNull()
	if err != nil {
		return false
	}
	os.Stdout, os.Stderr = null, null
	return errors.Join(stdout.Close(), stderr.Close()) == nil
}

// serviceRun is `run`: the front, until it is handed over, stopped or retired away.
func serviceRun(ctx context.Context, options RouterServiceOptions) int {
	provider, env, stateRoot := options.Provider, options.Env, options.StateRoot
	exit := options.Exit
	if exit == nil {
		exit = os.Exit
	}
	port := domain.RouterPort(provider, env)
	script, err := os.ReadFile(options.Script)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read "+options.Script+": "+err.Error())
		return 1
	}
	version := BundleVersion(script)
	layout := domain.NewStateLayout(stateRoot)
	log, closeLog := closableLog(RotatingLog(layout.RouterLog, nil, 0))
	// The last router's death is named before this one takes over: a pid record whose holder is
	// gone while no exit marker vouches for a logged exit is a death nobody could write a line
	// for (SIGKILL, the OS, a power loss).
	noteUnloggedDeath(ctx, stateRoot, log)
	note := func(line string) {
		log(line)
		event := line
		LogCrash(stateRoot, CrashEntry{Role: RoleFront, Version: version, Event: &event}, nil, 0)
	}
	crash := InstallCrashHandlers(RoleFront, stateRoot, version, nil, nil)
	defer exitOnPanic("front", crash, log, stateRoot)()
	tuning := serviceTuningOf(provider, env)
	events := spool.CreateSpoolWriter(env, log, nil)
	anthropic, err := url.Parse(envOrDefault(env, provider.EnvPrefix+"_ROUTER_ANTHROPIC_URL", "https://api.anthropic.com"))
	if err != nil {
		note("cannot listen: " + err.Error())
		return 1
	}
	var reasonMu sync.Mutex
	reason := "handover"
	var front *Front
	front = CreateFront(FrontOptions{
		Name:       provider.Name,
		Display:    provider.Display,
		HealthPath: provider.Router.HealthPath,
		Claim:      domain.ResolveProvider(provider, env).ModelClaim(),
		Port:       port,
		ListenPort: portFromEnv(env, provider.EnvPrefix+"_ROUTER_LISTEN_PORT", port),
		Anthropic:  anthropic,
		Env:        ProxyEnv(env),
		// Proxy mode: the CA lives next to the state root (~/.agents/ca), shared by every plugin's
		// router, so CONNECT api.anthropic.com can be decrypted and routed.
		CADir:   layout.CA,
		Version: version,
		FrontVersion: func() *int {
			if tuning.FrontVersion == nil {
				return nil
			}
			value := *tuning.FrontVersion
			return &value
		}(),
		Token:  envOrDefault(env, provider.EnvPrefix+"_ROUTER_TOKEN", randomToken()),
		Exec:   options.Script,
		Knobs:  knobsOf(tuning),
		IdleMs: tuning.IdleMs,
		Watch: func() *FrontWatch {
			base := serviceUninstallActions(ctx, options, note, closeLog)
			return CreateUninstallWatch(UninstallWatchOptions{
				StateRoot: stateRoot,
				Actions: UninstallActions{
					Presence: base.Presence,
					Undo:     base.Undo,
					Remove: func(ledger Ledger, disabled bool) error {
						reasonMu.Lock()
						reason = "uninstall"
						reasonMu.Unlock()
						// The forked workers hold the router log as their inherited stderr, and the
						// front's own stdout and stderr are the same file, so everything that holds
						// it is ended or freed before the removal.
						front.EndWorkers(5 * time.Second)
						releaseSpawnedLog(os.Stdout, os.Stderr)
						return base.Remove(ledger, disabled)
					},
				},
				EveryMs: tuning.WatchEveryMs,
			})
		}(),
		Peers:  CreatePeerLookup(env, provider.Name, nil),
		Events: events,
		RetiredWatch: &RetiredWatch{
			EveryMs: orDefault(tuning.RetiredEveryMs, domain.RetiredCheckMs),
			Exit: func(retiredAt int64) (bool, error) {
				processes, ok := process.ProcessList(ctx, nil)
				input := domain.RetiredExitInput{RetiredAt: retiredAt, Now: time.Now().UnixMilli()}
				if ok {
					input.Processes = &processes
				}
				input.MaxMs = tuning.RetiredMaxMs
				return domain.RetiredExit(input) == domain.RetiredActionExit, nil
			},
		},
		OnRetire: func() { RemoveRegistryEntry(env, provider.Name) },
		Note:     note,
		Log:      log,
		MarkExit: func() { markLoggedExit(stateRoot) },
		Done: func() {
			if front.Status().Mode == "retired" {
				// A retired front already wrote its one spool line, and its registry entry is gone.
				ClearRetiredRecord(ctx, stateRoot, int64(os.Getpid()))
				exit(0)
			}
			events(domain.RouterEvent{
				Ts: isoNow(), Event: domain.EventRouter, Plugin: provider.Name,
				Port: int64(port), State: domain.RouterStateStop, Version: spool.SpoolVersion,
			})
			reasonMu.Lock()
			why := reason
			reasonMu.Unlock()
			if why == "stop" {
				RemoveRegistryEntry(env, provider.Name)
			}
			exit(0)
		},
	})
	// Registered before the front starts, so a stop that lands while it comes up is still logged:
	// the starter writes the pid record once health answers, and health can answer before this
	// process reached a registration placed after the start. SIGHUP is caught like SIGTERM — a
	// session's end must not take the router down unlogged.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	started := make(chan struct{})
	go func() {
		got := <-signals
		log(fmt.Sprintf("front: exiting on %s", termSignalName(got)))
		reasonMu.Lock()
		reason = "stop"
		reasonMu.Unlock()
		// A start still running finishes first — a failed one ends this process on its own — and
		// the stop is then honoured through the normal shutdown, never lost to a drain that
		// raced the start.
		<-started
		front.Drain()
	}()
	if tuning.StartDelayMs > 0 {
		time.Sleep(time.Duration(tuning.StartDelayMs) * time.Millisecond)
	}
	if _, err := front.Start(); err != nil {
		note("cannot listen: " + err.Error())
		return 1
	}
	close(started)
	// Announce ourselves to the other plugins' routers once listening, so nobody forwards to a
	// closed port.
	pid := int64(os.Getpid())
	_ = SaveRegistryEntry(ctx, env, RegistryEntryFor(provider, env, &pid))
	events(domain.RouterEvent{
		Ts: isoNow(), Event: domain.EventRouter, Plugin: provider.Name,
		Port: int64(port), State: domain.RouterStateStart, Version: spool.SpoolVersion,
	})
	log(fmt.Sprintf("%s-router listening on %s (version %s)", provider.Name, domain.RouterBaseURL(provider, env), version))
	// The front owns the process from here: the worker serves until its front retires it.
	select {}
}

// serviceWorkerOf is `worker`: the entry the front forks, with the token the fork handed over.
func serviceWorkerOf(options RouterServiceOptions) int {
	provider, env, stateRoot := options.Provider, options.Env, options.StateRoot
	script, err := os.ReadFile(options.Script)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read "+options.Script+": "+err.Error())
		return 1
	}
	tuning := serviceTuningOf(provider, env)
	stdout := &lockedWriter{writer: os.Stdout}
	exit := options.Exit
	if exit == nil {
		exit = os.Exit
	}
	RunWorker(WorkerOptions{
		Provider:    provider,
		Env:         env,
		StateRoot:   stateRoot,
		Version:     BundleVersion(script),
		LogFile:     domain.NewStateLayout(stateRoot).RouterLog,
		Token:       envOrDefault(env, WorkerTokenEnv, ""),
		HeartbeatMs: tuning.HeartbeatMs,
		IdleMs:      tuning.IdleMs,
	}, os.Stdin, stdout.line, exit)
	return 0
}

// lockedWriter is one writer at a time: the worker's IPC lines and nothing else share stdout.
type lockedWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

func (w *lockedWriter) line(text string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, _ = io.WriteString(w.writer, text+"\n")
}

// RouterService runs one router command; the returned number is the process exit code.
func RouterService(options RouterServiceOptions) int {
	ctx := context.Background()
	if options.StateRoot == "" {
		options.StateRoot = adapters.ResolveStateRoot(ctx, options.Env, adapters.StateRootRule{
			EnvVar:     options.Provider.EnvPrefix + "_STATE_DIR",
			DataPrefix: options.Provider.Name + "-",
			XdgName:    options.Provider.Name,
		}, stderrLog)
	}
	command := ""
	if len(options.Argv) > 0 {
		command = options.Argv[0]
	}
	switch command {
	case "run":
		return serviceRun(ctx, options)
	case "worker":
		return serviceWorkerOf(options)
	case "start":
		return serviceStart(ctx, options)
	case "watch":
		return serviceWatch(ctx, options)
	case "stop":
		return serviceStop(ctx, options)
	case "status":
		return serviceStatus(ctx, options)
	default:
		errOut := options.Err
		if errOut == nil {
			errOut = os.Stderr
		}
		fmt.Fprintln(errOut, "usage: "+options.Provider.Name+"-router run | start | stop | status")
		return 2
	}
}

// serviceStart is `start`: bring the router up the way setup and the hooks do.
func serviceStart(ctx context.Context, options RouterServiceOptions) int {
	out := options.Out
	if out == nil {
		out = os.Stdout
	}
	tuning := serviceTuningOf(options.Provider, options.Env)
	line, err := StartRouter(ctx, StartOptions{
		Provider:     options.Provider,
		Env:          options.Env,
		StateRoot:    options.StateRoot,
		Source:       options.Script,
		Spawn:        options.Spawn,
		HealthWaitMs: tuning.StartWaitMs,
		Say: func(said string) {
			fmt.Fprintln(out, said)
		},
	})
	if err != nil {
		fmt.Fprintf(out, "%s-router start failed: %s\n", options.Provider.Name, err.Error())
		return 1
	}
	fmt.Fprintf(out, "%s-router %s\n", options.Provider.Name, line)
	return 0
}

// serviceWatch is `watch --session-pid <pid>`: the session watchdog (watch.go), one detached
// process the SessionStart hook starts after the router is up. Every stop is exit 0; a command
// line naming no session pid is a usage error.
func serviceWatch(ctx context.Context, options RouterServiceOptions) int {
	sessionPid := int64(0)
	argv := options.Argv[1:]
	if len(argv) == 2 && argv[0] == "--session-pid" {
		if pid, err := strconv.ParseInt(argv[1], 10, 64); err == nil {
			sessionPid = pid
		}
	}
	if sessionPid <= 0 {
		errOut := options.Err
		if errOut == nil {
			errOut = os.Stderr
		}
		fmt.Fprintln(errOut, "usage: "+options.Provider.Name+"-router watch --session-pid <pid>")
		return 2
	}
	WatchSession(ctx, WatchOptions{
		Provider:   options.Provider,
		Env:        options.Env,
		StateRoot:  options.StateRoot,
		SessionPid: sessionPid,
	})
	return 0
}

// serviceStop is `stop`: for people.
func serviceStop(ctx context.Context, options RouterServiceOptions) int {
	out := options.Out
	if out == nil {
		out = os.Stdout
	}
	line := StopRouter(ctx, StopOptions{
		Provider:  options.Provider,
		Env:       options.Env,
		StateRoot: options.StateRoot,
	})
	fmt.Fprintf(out, "%s-router %s\n", options.Provider.Name, line)
	return 0
}

// serviceStatus is `status`: what runs on the port, and whether this session uses it.
func serviceStatus(ctx context.Context, options RouterServiceOptions) int {
	out := options.Out
	if out == nil {
		out = os.Stdout
	}
	up, line := RouterStatus(ctx, options.Provider, options.Env)
	fmt.Fprintln(out, line)
	if up {
		return 0
	}
	return 1
}

// EnsureEntry is the ensure bundle's entry: the hooks' check that the router is still there,
// spawning this binary in its router start mode. The start
// child's output appends to the router log, so a start that fails leaves its trace. It never
// prints and never fails (a hook must never fail a prompt).
func EnsureEntry(provider domain.Provider, env domain.EnvLookup) {
	defer func() { _ = recover() }()
	_ = EnsureRouter(context.Background(),
		ensureOptionsFor(provider, env, stateRootOf(provider.Name, provider.EnvPrefix, env)))
}

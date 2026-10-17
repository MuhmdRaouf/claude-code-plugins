// `ensure`: the hooks' check that the router is still there, so one that died or hung mid-session
// is back before the next prompt, subagent or tool call. It must cost nothing when all is well:
// one health GET (1 s), and only when the router does not answer it does it act. A port nothing
// holds starts the router; a front of ours that accepts but never answers is replaced only once
// its silence has lasted 5 s (one slow second never kills); anything else on the port is left
// alone. Every start appends the child's output to router.log and leaves one line naming why it
// went out. It never prints, and it never throws (the plugin entry exits 0 whatever happens), and
// it stays inside the 3 s hook budget.
package router

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// EnsureOptions is what one ensure check needs.
type EnsureOptions struct {
	// Name is the plugin's short name and EnvPrefix its env prefix, e.g. zai / ZAI.
	Name        string
	EnvPrefix   string
	DefaultPort int
	// Display and HealthPath are the provider's own, so the health answer must be this plugin's
	// router; a bare connect or another program's 200 is not "up".
	Display    string
	HealthPath string
	Env        domain.EnvLookup
	// RouterScript is the router bundle beside this one, run as `start`.
	RouterScript string
	Node         string
	ConnectMs    int64
	// Start starts the router; tests record the call instead. A nil Start runs a real detached
	// start whose output appends to the router log.
	Start func(node string, args []string, env domain.EnvLookup)
}

// EnsureStatus is what one ensure check found: "up" when the router answers health, "skipped"
// when this plugin was never set up, "started" when a start went out, "held" when another
// program holds the port and was left alone.
type EnsureStatus string

const (
	EnsureUp      EnsureStatus = "up"
	EnsureSkipped EnsureStatus = "skipped"
	EnsureStarted EnsureStatus = "started"
	EnsureHeld    EnsureStatus = "held"
)

// EnsureRouter checks the router is still there and brings it back when it is not.
func EnsureRouter(ctx context.Context, options EnsureOptions) EnsureStatus {
	root := stateRootOf(options.Name, options.EnvPrefix, options.Env)
	layout := domain.NewStateLayout(root)
	if !existsFile(layout.SetupDone) && !existsFile(layout.RouterPid) {
		return EnsureSkipped
	}
	port := portFromEnv(options.Env, options.EnvPrefix+"_ROUTER_PORT", options.DefaultPort)
	connectMs := options.ConnectMs
	if connectMs == 0 {
		connectMs = 100
	}
	log := ensureLog(layout)
	provider := domain.Provider{
		Name:    options.Name,
		Display: options.Display,
		Router:  domain.ProviderRouter{HealthPath: options.HealthPath},
	}
	switch ProbeRouter(ctx, port, provider, connectMs).State {
	case ProbeOurs:
		removeSilentMark(layout)
		return EnsureUp
	case ProbeSilent:
		// Something accepts but never answers: our own front hung, or a program that is not
		// ours. Only the first is ever replaced, and only once its silence is sustained: one
		// slow second (a machine waking, a loaded one) must not cost every in-flight response.
		// The pid record plus the command line tell the two apart, exactly as the start path's
		// own silent-port rule does.
		record, hasRecord := ReadPidFile(ctx, root)
		if hasRecord && record.Port == int64(port) && IsOurProcess(record.Pid, options.Name, nil) {
			return silentFront(ctx, options, layout, log, record.Pid, port)
		}
		if hasRecord {
			log(fmt.Sprintf("ensure: port %d accepts but never answers and pid %d is not our router; left alone",
				port, record.Pid))
		} else {
			log(fmt.Sprintf("ensure: port %d accepts but never answers; no router of ours holds it, left alone", port))
		}
		return EnsureHeld
	case ProbeForeign:
		log(fmt.Sprintf("ensure: port %d is held by another program; left alone", port))
		return EnsureHeld
	}
	removeSilentMark(layout)
	startRouter(options, layout, log, "port closed")
	return EnsureStarted
}

// silentMarkKillMs is how long our front's silence must be sustained before ensure replaces it.
const silentMarkKillMs = 5000

// silentMarkStaleMs is how old an episode's mark may be before it belongs to no live episode (a
// watcher that crashed, a laptop that slept): a new episode starts instead of a kill.
const silentMarkStaleMs = 60000

// silentFront is one silent probe of our own front: the first of an episode marks it and says one
// line, later probes hold, and only a probe that finds the episode at least silentMarkKillMs old
// kills the front and starts a fresh one. The mark lives in `<state>/router.silent`, so the hooks'
// probes and the watchdog's ticks fill the same episode.
func silentFront(ctx context.Context, options EnsureOptions, layout domain.StateLayout,
	log func(string), pid int64, port int) EnsureStatus {
	first, has := readSilentMark(layout)
	now := nowMs()
	switch {
	case !has || now-first > silentMarkStaleMs:
		writeSilentMark(ctx, layout, now)
		log(fmt.Sprintf("ensure: our router on :%d did not answer health; replaced if still silent after %d s",
			port, silentMarkKillMs/1000))
		return EnsureHeld
	case now-first >= silentMarkKillMs:
		removeSilentMark(layout)
		log(fmt.Sprintf("ensure: SIGKILL hung front %d: our router holds port %d and has not answered health for %d ms",
			pid, port, now-first))
		signalPid(pid, "SIGKILL")
		waitPortFreed(ctx, port)
		startRouter(options, layout, log, fmt.Sprintf("hung front %d", pid))
		return EnsureStarted
	}
	// Sustained silence so far, under the kill age: the episode already has its one line.
	return EnsureHeld
}

// readSilentMark is the running silence episode's first silent probe, in unix ms; false when
// there is no mark or it does not parse, and a new episode starts.
func readSilentMark(layout domain.StateLayout) (int64, bool) {
	data, err := os.ReadFile(layout.RouterSilent)
	if err != nil {
		return 0, false
	}
	ms, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || ms <= 0 {
		return 0, false
	}
	return ms, true
}

// writeSilentMark starts a silence episode at ms, atomically.
func writeSilentMark(ctx context.Context, layout domain.StateLayout, ms int64) {
	_, _ = fsutil.WriteFileAtomic(ctx, layout.RouterSilent,
		[]byte(strconv.FormatInt(ms, 10)+"\n"), fsutil.WriteOptions{})
}

// removeSilentMark ends the silence episode: the router answered, the port closed, or a fresh
// start went out.
func removeSilentMark(layout domain.StateLayout) {
	_ = os.Remove(layout.RouterSilent)
}

// stateRootOf resolves the state root the one way every caller does: $<P>_STATE_DIR, else
// ~/.agents/<name>; never the plugin data dir.
func stateRootOf(name, envPrefix string, env domain.EnvLookup) string {
	return adapters.ResolveStateRoot(context.Background(), env, adapters.StateRootRule{
		EnvVar:     envPrefix + "_STATE_DIR",
		DataPrefix: name + "-",
		XdgName:    name,
	}, stderrLog)
}

// waitPortFreed waits for a killed front's listener to leave the port: a start fired while the
// kernel still accepts on the dead socket would find the port silent and refuse it.
func waitPortFreed(ctx context.Context, port int) {
	deadline := time.Now().Add(time.Second)
	for process.PortAnswers(ctx, port, 100) {
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ensureLog is the ensure lines' writer into the rotating router log. A plugin whose check runs
// is a set-up plugin (the mark or the pid record was there), so its router directory may be
// brought back for the record; a removed plugin never reaches a write at all.
func ensureLog(layout domain.StateLayout) func(string) {
	if err := os.MkdirAll(layout.RouterDir, 0o700); err != nil {
		return func(string) {}
	}
	return RotatingLog(layout.RouterLog, nil, 0)
}

// ensureOptionsFor is the ensure check the service entries share — the ensure bundle's entry and
// the session watchdog's per-tick check — over one resolved state root. The start spawns this
// binary in its `router start` mode, the start child's output appending to the router log.
func ensureOptionsFor(provider domain.Provider, env domain.EnvLookup, root string) EnsureOptions {
	return EnsureOptions{
		Name:         provider.Name,
		EnvPrefix:    provider.EnvPrefix,
		Display:      provider.Display,
		HealthPath:   provider.Router.HealthPath,
		DefaultPort:  provider.Router.Port,
		Env:          env,
		RouterScript: provider.Name + "-router.js",
		Start: func(node string, _ []string, childEnv domain.EnvLookup) {
			_ = process.StartDetached(node, []string{provider.Name, "router", "start"},
				process.DetachedOptions{
					Env: environOf(childEnv), LogFile: domain.NewStateLayout(root).RouterLog,
				})
		},
	}
}

// startRouter fires the detached start and leaves the one line naming why it went out; the
// child's own stdout and stderr append to the router log, so a start that fails leaves its trace.
func startRouter(options EnsureOptions, layout domain.StateLayout, log func(string), reason string) {
	node := options.Node
	if node == "" {
		// The binary running this code.
		if executable, err := os.Executable(); err == nil {
			node = executable
		}
	}
	start := options.Start
	if start == nil {
		start = func(node string, args []string, env domain.EnvLookup) {
			process.StartDetached(node, args, process.DetachedOptions{
				Env: environOf(env), LogFile: layout.RouterLog,
			})
		}
	}
	start(node, []string{options.RouterScript, "start"}, options.Env)
	log("ensure: started router (reason: " + reason + ")")
}

func existsFile(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// environOf is the env map as a child's environment slice.
func environOf(env domain.EnvLookup) []string {
	out := make([]string, 0, len(env))
	for name, value := range env {
		out = append(out, name+"="+value)
	}
	return out
}

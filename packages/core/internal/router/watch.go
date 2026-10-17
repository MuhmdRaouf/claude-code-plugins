// The session watchdog: `plugin-core <name> router watch --session-pid <pid>`, one detached
// process per Claude Code session, started by the SessionStart hook after the router is up. Once
// ANTHROPIC_BASE_URL points at the router, a router that dies or hangs mid-turn cuts Claude off —
// the very request that would ask Claude to fix it goes through the dead router — so the watchdog
// runs the ensure check every 2 s and brings the router back within seconds, until the session
// process itself is gone, the router is retired for a remove, or the plugin is no longer set up.
// A front that accepts but never answers is replaced once its silence has lasted 5 s (ensure.go's
// mark), so about three ticks. No OS service: it is a plain child the hook started, and the
// router start lock keeps several sessions' watchdogs from starting two routers. One watchdog
// serves one session: each claims a guard file under the state root, and a later one for the same
// session (a resume, a compact) bows out at once when the holder is still alive.
package router

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// WatchEveryMs is how often the watchdog runs the ensure check.
const WatchEveryMs = 2000

// sessionShells are the programs the hook chain runs through: Claude Code wraps each hook command
// in a shell, and the plugin's launcher `sh …/dist/run` execs the binary. A login shell's argv0
// carries a leading dash, so the name is stripped of it. Treat as read-only.
var sessionShells = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "mksh": true,
	"ash": true, "fish": true, "csh": true, "tcsh": true, "cmd": true, "powershell": true,
	"pwsh": true,
}

// sessionPidOf walks the ancestor chain from start and answers the first process that is neither
// a shell nor the plugin's launcher — the Claude Code process running the session the hook serves.
// The hook chain is claude → the hook's shell (`sh -c 'sh …/dist/run <bundle>.js … --hook'`) →
// this binary, the launcher having exec'd it, so the walk skips the shells and the launcher and
// stops at claude. A chain it cannot read, or one with no such ancestor (0), answers no session,
// and no watchdog starts: the hooks remain the recovery.
func sessionPidOf(start int64, parent func(int64) (int64, bool), command func(int64) (string, bool)) int64 {
	current := start
	for range 12 {
		line, ok := command(current)
		if !ok || strings.TrimSpace(line) == "" {
			return 0
		}
		if !sessionShellLine(line) {
			return current
		}
		next, ok := parent(current)
		if !ok || next <= 0 {
			return 0
		}
		current = next
	}
	return 0
}

// sessionShellLine is one ancestor the hook chain runs through: a shell, or the plugin's
// launcher (`sh …/<plugin>/dist/run <bundle>.js …`).
func sessionShellLine(line string) bool {
	if strings.Contains(line, "/dist/run ") || strings.HasSuffix(strings.TrimSpace(line), "/dist/run") {
		return true
	}
	first := strings.Fields(line)
	if len(first) == 0 {
		return true
	}
	name := strings.TrimPrefix(filepath.Base(first[0]), "-")
	return sessionShells[name]
}

// SessionPid is the Claude Code process running the session this hook serves: the nearest
// ancestor that is neither a shell nor the launcher (sessionPidOf's walk). 0 when no such
// ancestor can be identified, as where ps cannot say — no watchdog starts there.
func SessionPid(ctx context.Context) int64 {
	return sessionPidOf(int64(os.Getppid()),
		func(pid int64) (int64, bool) { return parentPidOf(ctx, pid) },
		func(pid int64) (string, bool) { return CommandLineOf(ctx, pid) })
}

// watchPidFileOf is the session's watchdog guard, one file per session under the state root.
func watchPidFileOf(root string, sessionPid int64) string {
	return filepath.Join(root, fmt.Sprintf("watch.%d", sessionPid))
}

// liveWatchdogAt says whether the guard file's holder is a watchdog of this plugin that still
// runs: the pid alone is never enough, and its command line must name this plugin's watch entry.
func liveWatchdogAt(ctx context.Context, path, name string) bool {
	holder, ok := pidNamedBy(path)
	if !ok || !process.IsAlive(holder) {
		return false
	}
	line, read := CommandLineOf(ctx, holder)
	return read && strings.Contains(line, name+" router watch")
}

// StartSessionWatchdog starts the session watchdog for the Claude Code process whose pid is
// sessionPid, unless a live one already serves that session. A pid of 0 (no session found)
// starts nothing: the hooks remain the recovery. The child is detached and silent — its trace is
// router.log.
func StartSessionWatchdog(provider domain.Provider, env domain.EnvLookup, sessionPid int64) {
	defer func() { _ = recover() }()
	if sessionPid <= 0 {
		return
	}
	ctx := context.Background()
	root := stateRootOf(provider.Name, provider.EnvPrefix, env)
	if liveWatchdogAt(ctx, watchPidFileOf(root, sessionPid), provider.Name) {
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	_ = process.StartDetached(self, []string{provider.Name, "router", "watch", "--session-pid",
		strconv.FormatInt(sessionPid, 10)}, process.DetachedOptions{Env: environOf(env)})
}

// WatchDecision is why a watchdog stopped.
type WatchDecision string

const (
	WatchSessionGone WatchDecision = "session-gone"
	WatchRetired     WatchDecision = "retired"
	WatchRemoved     WatchDecision = "removed"
	WatchCancelled   WatchDecision = "cancelled"
	WatchDuplicate   WatchDecision = "duplicate"
)

// WatchOptions is what one watchdog needs.
type WatchOptions struct {
	Provider   domain.Provider
	Env        domain.EnvLookup
	StateRoot  string
	SessionPid int64
	EveryMs    int64
	// Alive is the session liveness probe; nil is process.IsAlive.
	Alive func(pid int64) bool
}

// WatchSession is the watchdog's loop: claim the session, then every EveryMs (2 s when 0) run
// the ensure check and bring the router back when it is down or hung, until one of the exits.
// Every exit leaves one line in router.log.
func WatchSession(ctx context.Context, o WatchOptions) WatchDecision {
	root := o.StateRoot
	if root == "" {
		root = stateRootOf(o.Provider.Name, o.Provider.EnvPrefix, o.Env)
	}
	log := ensureLog(domain.NewStateLayout(root))
	path := watchPidFileOf(root, o.SessionPid)
	if !claimWatch(ctx, path, o.Provider.Name, log) {
		return WatchDuplicate
	}
	defer func() { _ = os.Remove(path) }()
	alive := o.Alive
	if alive == nil {
		alive = process.IsAlive
	}
	ensure := ensureOptionsFor(o.Provider, o.Env, root)
	every := time.Duration(orDefault(o.EveryMs, WatchEveryMs)) * time.Millisecond
	for {
		if !alive(o.SessionPid) {
			log(fmt.Sprintf("watchdog: session %d is gone", o.SessionPid))
			return WatchSessionGone
		}
		if _, ok := ReadRetiredFile(ctx, root); ok {
			log("watchdog: the router is retired for a remove; stopping")
			return WatchRetired
		}
		if EnsureRouter(ctx, ensure) == EnsureSkipped {
			log("watchdog: the plugin is no longer set up; stopping")
			return WatchRemoved
		}
		if !sleepWhileAlive(ctx, every, func() bool { return alive(o.SessionPid) }) && ctx.Err() != nil {
			return WatchCancelled
		}
	}
}

// watchAliveMs is how often the wait between ensure checks looks at the session, so a session
// that ends mid-wait is noticed within a quarter second instead of after the whole interval.
const watchAliveMs = 250

// sleepWhileAlive waits for d, returning early (false) once ctx ends or alive stops holding.
func sleepWhileAlive(ctx context.Context, d time.Duration, alive func() bool) bool {
	deadline := time.Now().Add(d)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return true
		}
		step := min(left, watchAliveMs*time.Millisecond)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(step):
		}
		if !alive() {
			return false
		}
	}
}

// claimWatch takes the session's guard file (atomic create). A holder that still runs a
// watchdog of this plugin bows the new one out; one that is gone — a crash, a power loss, a pid
// reused by another program — is replaced at once, its pid never signalled.
func claimWatch(ctx context.Context, path, name string, log func(string)) bool {
	for attempt := 0; attempt < 2; attempt++ {
		created, err := adapters.CreateExclusive(ctx, path, fmt.Sprintf("%d\n", os.Getpid()))
		if err != nil {
			return false
		}
		if created {
			return true
		}
		if liveWatchdogAt(ctx, path, name) {
			return false
		}
		_ = os.Remove(path)
	}
	return false
}

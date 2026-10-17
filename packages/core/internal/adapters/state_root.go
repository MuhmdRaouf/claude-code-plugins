package adapters

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// UninstallMarkerName is the one file the plugin keeps in its Claude Code data dir on purpose:
// Claude Code deletes the dir's contents on uninstall, and the router's uninstall watch reads the
// marker by the path the ledger recorded, so it never moves with the state.
const UninstallMarkerName = "installed"

// StateRootRule says where one provider keeps its state: an explicit env var, else ~/.agents.
type StateRootRule struct {
	// The variable that names the root outright, e.g. ZAI_STATE_DIR.
	EnvVar string
	// $CLAUDE_PLUGIN_DATA is looked into for leftover state only when its basename starts with
	// this (the provider's catalogue entry).
	DataPrefix string
	// The dir name under ~/.agents (an older XDG one moves over there).
	XdgName string
}

// ResolveStateRoot resolves the state root: $<EnvVar>, else ~/.agents/<XdgName> — one root for
// every caller (hooks, commands, the router). Claude Code sets $CLAUDE_PLUGIN_DATA only for
// hooks, so the root never depends on it: hooks, setup and the router must find the same files.
// State found in the provider's own data dir moves over once, as does an old
// $XDG_STATE_HOME/<XdgName> or ~/.local/state/<XdgName>. Claude Code leaks one plugin's
// CLAUDE_PLUGIN_DATA into every Bash tool call, so a foreign one is never read: the plugin would
// walk another plugin's data dir.
func ResolveStateRoot(ctx context.Context, env domain.EnvLookup, rule StateRootRule, log func(line string)) string {
	if explicit, ok := env[rule.EnvVar]; ok && explicit != "" {
		return explicit
	}
	MigrateStateDir(ctx, rule.XdgName, env, log)
	MigratePluginDataState(ctx, env, rule, log)
	return AgentsStateDir(env, rule.XdgName)
}

// MigratePluginDataState moves state found in the provider's own Claude Code data dir into
// ~/.agents, the same way the XDG dir moves: every top-level entry the agents dir lacks
// renames over, nothing an agent dir already has is ever overwritten, and a concurrent migrator's
// ENOENT/EEXIST is not a failure. The uninstall marker stays where Claude Code deletes it, and
// the data dir itself is never removed — Claude Code owns it. Never fails: what cannot move
// stays for the next start to retry, at the cost of one line on the log.
func MigratePluginDataState(ctx context.Context, env domain.EnvLookup, rule StateRootRule, log func(line string)) {
	data := env["CLAUDE_PLUGIN_DATA"]
	if data == "" || !strings.HasPrefix(nodeBasename(data), rule.DataPrefix) {
		return
	}
	to := AgentsStateDir(env, rule.XdgName)
	if data == to || !exists(data) {
		return
	}
	if err := os.MkdirAll(to, 0o700); err != nil {
		log(fmt.Sprintf("state migrate: cannot create %s (%s); %s's state stays in %s",
			to, fsutil.ErrorMessage(err), rule.XdgName, data))
		return
	}
	moveEntries(rule.XdgName, data, to, keepInDataDir, log)
}

// keepInDataDir is the data-dir entry that never moves: the uninstall marker, which the router's
// watch reads where the ledger recorded it and Claude Code deletes on uninstall.
func keepInDataDir(entry string) bool {
	return entry == UninstallMarkerName
}

// NewStateRootRule derives every provider's rule from its own names: $<envPrefix>_STATE_DIR, its
// `<name>-…` data dir, `<name>`.
func NewStateRootRule(provider domain.Provider) StateRootRule {
	return StateRootRule{
		EnvVar:     provider.EnvPrefix + "_STATE_DIR",
		DataPrefix: provider.Name + "-",
		XdgName:    provider.Name,
	}
}

// StateRoot is a provider's state root (see ResolveStateRoot).
func StateRoot(ctx context.Context, provider domain.Provider, env domain.EnvLookup) string {
	return ResolveStateRoot(ctx, env, NewStateRootRule(provider), stderrLog)
}

// nodeBasename is Node's basename: everything after the last separator, so a path ending in one
// has no name and "" has none either — no trailing-slash rescue the way path/filepath.Base
// rescues one.
func nodeBasename(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

// stderrLog is the default log (stderr).
func stderrLog(line string) {
	fmt.Fprintln(os.Stderr, line)
}

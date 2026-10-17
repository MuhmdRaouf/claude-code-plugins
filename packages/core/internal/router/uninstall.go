// Uninstall restores everything. Claude Code has no uninstall or disable hook, so the router — which outlives the
// plugin — watches for it: every 10 s it reads Claude Code's own bookkeeping, and after two consecutive "gone"
// answers (an update rewrites these very files, so one is not enough) it undoes what the ledger says setup did and the
// front retires: it keeps passing Claude requests through for the sessions that still hold its URL, and once those
// sessions are gone (or 7 days have passed) it removes its own files and exits. Disabling cleans up the same way, but
// keeps the ledger as `ledger.disabled.json` so re-enabling re-applies setup without a command.
package router

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Presence is whether the plugin is still installed: present (installed and enabled in some
// scope), disabled (installed but turned off everywhere it is installed), absent (not installed,
// or its data dir — and with it the marker — is gone) or unknown (the files cannot be read).
type Presence string

const (
	PresencePresent  Presence = "present"
	PresenceDisabled Presence = "disabled"
	PresenceAbsent   Presence = "absent"
	PresenceUnknown  Presence = "unknown"
)

// ReadText reads a file's text, false when it cannot be read.
type ReadText func(path string) (string, bool)

// readText is the production reader.
func readText(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

// parseObjectOf is the text as a JSON object, nil when there is no text or it is not one.
func parseObjectOf(text string, present bool) *jsonNode {
	if !present {
		return nil
	}
	node := parseBodyNode([]byte(text))
	if !node.isObject() {
		return nil
	}
	return node
}

// nodeText is a node's string value, "" when it is not a string (a nil node included).
func nodeText(node *jsonNode) string {
	if node != nil && node.kind == jsonString {
		return node.str
	}
	return ""
}

// scopeFiles is the settings files that hold a scope's `enabledPlugins`.
func scopeFiles(configDir string, install *jsonNode) []string {
	project := nodeText(install.get("projectPath"))
	scope := nodeText(install.get("scope"))
	switch {
	case scope == "project" && project != "":
		return []string{filepath.Join(project, ".claude", "settings.json")}
	case scope == "local" && project != "":
		return []string{filepath.Join(project, ".claude", "settings.local.json")}
	default:
		return []string{filepath.Join(configDir, "settings.json")}
	}
}

// enabledIn is whether one scope's settings leave the plugin on. A plugin with no
// `enabledPlugins` entry follows its `defaultEnabled`, which defaults to true and which these
// plugins never set (Claude Code docs: settings-reference "enabledPlugins: A plugin with no entry
// at any scope falls back to its defaultEnabled value"; manifest-reference "defaultEnabled …
// Defaults to true"). An unreadable file says nothing, so it counts as the default too.
func enabledIn(files []string, key string, read ReadText) bool {
	for _, file := range files {
		enabled := parseObjectOf(read(file)).get("enabledPlugins")
		if value := enabled.get(key); value != nil && value.kind == jsonBool && !value.boolean {
			return false
		}
	}
	return true
}

// PluginPresence is whether `<name>-plugin-cc@<marketplace>` is still installed and enabled, from
// installed_plugins.json, the scopes' enabledPlugins and the `installed` marker in the plugin's
// data dir. A nil read is the production reader.
func PluginPresence(name string, configDir string, marker *string, read ReadText) Presence {
	if read == nil {
		read = readText
	}
	installed := parseObjectOf(read(filepath.Join(configDir, "plugins", "installed_plugins.json")))
	if installed == nil {
		return PresenceUnknown
	}
	plugins := installed
	if value := installed.get("plugins"); value != nil && value.kind != jsonNull {
		// The candidate is stringified and parsed back as a record, so anything but an object
		// lands on the empty object.
		plugins = parseObjectOf(marshalNode(value), true)
		if plugins == nil {
			plugins = &jsonNode{kind: jsonObject, fields: map[string]*jsonNode{}}
		}
	}
	var keys []string
	for _, key := range plugins.keys {
		if strings.HasPrefix(key, name+"-plugin-cc@") {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return PresenceAbsent
	}
	if marker != nil {
		if _, ok := read(*marker); !ok {
			return PresenceAbsent
		}
	}
	for _, key := range keys {
		for _, install := range installsOf(plugins.get(key)) {
			if enabledIn(scopeFiles(configDir, install), key, read) {
				return PresencePresent
			}
		}
	}
	return PresenceDisabled
}

// installsOf is one plugin key's installs, each as an object (a malformed one counts as a
// user-scope install).
func installsOf(value *jsonNode) []*jsonNode {
	list := []*jsonNode{{kind: jsonObject, fields: map[string]*jsonNode{}}}
	if value != nil && value.kind == jsonArray {
		list = value.items
	}
	out := make([]*jsonNode, 0, len(list))
	for _, install := range list {
		if install.isObject() {
			out = append(out, install)
		} else {
			out = append(out, &jsonNode{kind: jsonObject, fields: map[string]*jsonNode{}})
		}
	}
	return out
}

// UninstallActions is what the watch does once the plugin is gone; production wires the settings,
// the registry, the keystore and the jobs.
type UninstallActions struct {
	// Undo is step 1: take this plugin's entries out of settings.json and put the base URL back.
	Undo func(ledger Ledger) error
	// Remove is step 3, when the retired front exits: everything else this plugin left outside its
	// own directory; disabled says whether a disable (not an uninstall) is being cleaned up.
	Remove   func(ledger Ledger, disabled bool) error
	Presence func(ledger Ledger) Presence
}

// UninstallWatchOptions is what one uninstall watch needs.
type UninstallWatchOptions struct {
	StateRoot string
	Actions   UninstallActions
	EveryMs   int64
}

// uninstallWatch is the watch's own state. The front runs its ticks one at a time, so nothing
// here needs a lock.
type uninstallWatch struct {
	stateRoot string
	actions   UninstallActions
	// known is the ledger kept in memory: Claude Code deletes the plugin's data dir (often the
	// state root) on uninstall.
	known  *Ledger
	gone   int
	undone Presence
}

// tick is one watch tick: "stay", or "retire" once the plugin is gone and its settings restored.
func (w *uninstallWatch) tick() (string, error) {
	if w.undone != "" {
		return "retire", nil
	}
	layout := domain.NewStateLayout(w.stateRoot)
	if ledger, ok := ReadLedger(context.Background(), layout.Ledger); ok {
		w.known = &ledger
	}
	if w.known == nil {
		return "stay", nil
	}
	if err := w.watchPresence(w.known); err != nil {
		return "", err
	}
	if w.undone == "" {
		return "stay", nil
	}
	return "retire", nil
}

// watchPresence counts consecutive gone answers; the second one undoes the settings and sets the
// ledger aside.
func (w *uninstallWatch) watchPresence(ledger *Ledger) error {
	presence := w.actions.Presence(*ledger)
	if presence == PresenceAbsent || presence == PresenceDisabled {
		w.gone++
	} else {
		w.gone = 0
	}
	if w.gone < 2 {
		return nil
	}
	if err := w.actions.Undo(*ledger); err != nil {
		return err
	}
	w.undone = presence
	layout := domain.NewStateLayout(w.stateRoot)
	if presence == PresenceDisabled {
		if err := WriteLedger(context.Background(), layout.DisabledLedger, *ledger); err != nil {
			return err
		}
	}
	RemoveLedger(layout.Ledger)
	return nil
}

// cleanup is what the watch does when the retired front exits: remove what is left, unless setup
// ran again since (a new ledger on disk).
func (w *uninstallWatch) cleanup() error {
	if w.known == nil || w.undone == "" {
		return nil
	}
	if _, ok := ReadLedger(context.Background(), domain.NewStateLayout(w.stateRoot).Ledger); ok {
		return nil
	}
	return w.actions.Remove(*w.known, w.undone == PresenceDisabled)
}

// CreateUninstallWatch is the front's uninstall watch (see the header). Nothing happens without a
// ledger: a router setup never recorded has nothing to undo.
func CreateUninstallWatch(options UninstallWatchOptions) *FrontWatch {
	everyMs := options.EveryMs
	if everyMs == 0 {
		everyMs = 10_000
	}
	w := &uninstallWatch{stateRoot: options.StateRoot, actions: options.Actions}
	return &FrontWatch{EveryMs: everyMs, Tick: w.tick, Cleanup: w.cleanup}
}

// LeftBehind is a job the cleanup must leave alone, and where its work sits.
type LeftBehind struct {
	ID       string
	Worktree *string
}

// WriteLeftBehind writes `<state>/LEFT-BEHIND.md` naming the undecided jobs and their worktrees,
// so nothing of value is lost silently. Nothing is written when there are none.
func WriteLeftBehind(stateRoot string, name string, jobs []LeftBehind) {
	if len(jobs) == 0 {
		return
	}
	lines := make([]string, 0, len(jobs)+5)
	lines = append(lines,
		"# Left behind by the "+name+" plugin",
		"",
		"The plugin was removed while these jobs were still waiting for a decision. Their work is still on disk:",
		"")
	for _, job := range jobs {
		if job.Worktree != nil {
			lines = append(lines, "- "+job.ID+": "+*job.Worktree)
		} else {
			lines = append(lines, "- "+job.ID)
		}
	}
	lines = append(lines, "")
	_ = os.WriteFile(domain.NewStateLayout(stateRoot).LeftBehind, []byte(strings.Join(lines, "\n")), 0o600)
}

// RemoveRouterFiles removes the router files under the state root: the copies, the pid files, the
// lock. The retiring front also ends its workers, frees its own stdio hold on the router log
// (releaseSpawnedLog) and closes the log's line writer (closableLog) before calling this.
func RemoveRouterFiles(stateRoot string) {
	layout := domain.NewStateLayout(stateRoot)
	removeHeldLog(layout.RouterLog)
	for _, path := range []string{layout.RouterDir, layout.RouterPid, layout.RouterRetired,
		layout.RouterSilent, layout.RouterExit, layout.RouterLock} {
		_ = os.RemoveAll(path)
	}
}

// heldLogAttempts × heldLogPause bounds the router log's sharing-violation retry: the honest
// holders are ended first (the front ends its workers and frees its own stdio), so this passes at
// most a router process still tearing down.
const (
	heldLogAttempts = 40
	heldLogPause    = 25 * time.Millisecond
)

// removeHeldLog deletes the router log, retrying while the delete answers EBUSY: the starter
// spawns the router processes with their stdout and stderr on this very file (process.go), so a
// process still ending can hold the delete back. Best effort like the removal around it.
func removeHeldLog(path string) {
	removeHeldLogWith(os.Remove, path)
}

// removeHeldLogWith is removeHeldLog over an injected delete, so the retry itself is testable on
// any platform.
func removeHeldLogWith(remove func(string) error, path string) {
	for attempt := 0; ; attempt++ {
		err := remove(path)
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return
		}
		if fsutil.ErrnoCode(err) != "EBUSY" || attempt >= heldLogAttempts {
			return
		}
		time.Sleep(heldLogPause)
	}
}

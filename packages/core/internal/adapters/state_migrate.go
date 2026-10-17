package adapters

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The one-time move of a machine-wide state dir from the XDG state home (~/.local/state) into
// ~/.agents, run whenever a default root is resolved for use: it costs one Stat when there is
// nothing to move, and several processes running it at once stay safe because every entry moves
// by one atomic rename and an entry the new dir already has is never overwritten — it stays
// behind in the old dir.

// LegacyStateDir is where state lived before ~/.agents: $XDG_STATE_HOME/<name>, else
// ~/.local/state/<name>.
func LegacyStateDir(env domain.EnvLookup, name string) string {
	if xdg, ok := env["XDG_STATE_HOME"]; ok {
		return filepath.Join(xdg, name)
	}
	return filepath.Join(homeDir(env), ".local", "state", name)
}

// AgentsStateDir is where it lives now: ~/.agents/<name>.
func AgentsStateDir(env domain.EnvLookup, name string) string {
	return filepath.Join(homeDir(env), ".agents", name)
}

// homeDir is $HOME, else the OS's idea of the user's home (Node's homedir()); an unreadable home
// is the empty string, so the joins below stay relative rather than failing.
func homeDir(env domain.EnvLookup) string {
	if home, ok := env["HOME"]; ok {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// lostRace reports an error another migrator caused: its own rename won that entry, so ours
// losing it is not a failure.
func lostRace(err error) bool {
	switch fsutil.ErrnoCode(err) {
	case "ENOENT", "EEXIST", "ENOTEMPTY":
		return true
	default:
		return false
	}
}

// occupied reports whether anything at all sits at path — a broken symlink counts, Lstat never
// follows one.
func occupied(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// exists reports whether path is there, following a symlink (Stat, not Lstat).
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// entriesOf lists the dir's top-level entries, or nil when it cannot be read (another migrator
// removed it already).
func entriesOf(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// MigrateStateDir moves name's state from LegacyStateDir to AgentsStateDir when the old dir
// exists: the new dir is created mode 0700 and every top-level entry it lacks is renamed into it —
// never merged, never overwritten, symlinks moved as the links they are. A concurrent migrator's
// ENOENT/EEXIST is ignored; any other failure leaves everything in place for the next start to
// retry, at the cost of one line on the log. The old dir is removed only once nothing is left in
// it; otherwise the log names what stayed behind. Never fails.
func MigrateStateDir(ctx context.Context, name string, env domain.EnvLookup, log func(line string)) {
	from := LegacyStateDir(env, name)
	to := AgentsStateDir(env, name)
	if from == to || !exists(from) {
		return
	}
	if err := os.MkdirAll(to, 0o700); err != nil {
		log(fmt.Sprintf("state migrate: cannot create %s (%s); %s's state stays in %s",
			to, fsutil.ErrorMessage(err), name, from))
		return
	}
	if moveEntries(name, from, to, nil, log) {
		return // the move failed: everything stays for the next start
	}
	settleOldDir(from, to, log)
}

// moveEntries renames every entry the new dir lacks, except those keep says stay put (nil moves
// everything); it reports whether a failure that is not a lost race stopped the move.
func moveEntries(name, from, to string, keep func(string) bool, log func(line string)) bool {
	for _, entry := range entriesOf(from) {
		if keep != nil && keep(entry) {
			continue
		}
		if occupied(filepath.Join(to, entry)) {
			continue // the new dir's entry wins; this one stays in the old dir
		}
		if err := os.Rename(filepath.Join(from, entry), filepath.Join(to, entry)); err != nil {
			if lostRace(err) {
				continue
			}
			log(fmt.Sprintf("state migrate: cannot move %s (%s); %s's state stays in %s",
				filepath.Join(from, entry), fsutil.ErrorMessage(err), name, from))
			return true
		}
	}
	return false
}

// settleOldDir removes the old dir once it is empty; otherwise one line names what stayed behind
// and why.
func settleOldDir(from, to string, log func(line string)) {
	left := entriesOf(from)
	if left == nil {
		return // another migrator removed the old dir as we finished
	}
	if len(left) == 0 {
		// Another process removed or refilled it under us; the next start retries.
		_ = os.Remove(from)
		return
	}
	log(fmt.Sprintf("state migrate: %s left in %s because %s already had entries of those names",
		strings.Join(left, ", "), from, to))
}

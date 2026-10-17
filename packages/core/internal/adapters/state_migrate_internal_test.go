package adapters

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The state migration's scenarios, as an internal test so the unexported move machinery is
// covered too. The router-dependent cases (radarHome, routersHome) live with the registry's
// tests; this file never imports internal/router.

// migrateWorld is a home with an XDG state home and an old state dir for name, all inside one
// temp dir.
type migrateWorld struct {
	home  string
	xdg   string
	old   string
	fresh string
	env   domain.EnvLookup
	lines []string
	log   func(line string)
}

func newMigrateWorld(t *testing.T, name string, entries map[string]string) *migrateWorld {
	t.Helper()
	home := t.TempDir()
	xdg := filepath.Join(home, "xdg-state")
	old := filepath.Join(xdg, name)
	for entry, content := range entries {
		file := filepath.Join(old, entry)
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(file), err)
		}
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatalf("seed %s: %v", file, err)
		}
	}
	w := &migrateWorld{
		home:  home,
		xdg:   xdg,
		old:   old,
		fresh: filepath.Join(home, ".agents", name),
		env:   domain.EnvLookup{"HOME": home, "XDG_STATE_HOME": xdg},
	}
	w.log = func(line string) { w.lines = append(w.lines, line) }
	return w
}

func readWorldFile(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(text)
}

// mustBeGone fails when path is still there.
func mustBeGone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s still exists (stat err %v)", path, err)
	}
}

func TestMigrateStateDir(t *testing.T) {
	t.Run("a fresh install: no old dir, nothing created and nothing logged", func(t *testing.T) {
		w := newMigrateWorld(t, "acme", nil)
		MigrateStateDir(t.Context(), "acme", w.env, w.log)
		mustBeGone(t, filepath.Join(w.home, ".agents"))
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
	})

	t.Run("a full move: every entry lands in ~/.agents, the old dir is removed, the new dir keeps mode 0700", func(t *testing.T) {
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}", "jobs/a": "job a"})
		if err := os.MkdirAll(filepath.Join(w.old, "router"), 0o700); err != nil {
			t.Fatalf("mkdir the old router dir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(w.old, "router", "router.log"), []byte("log\n"), 0o600); err != nil {
			t.Fatalf("seed router.log: %v", err)
		}
		if err := os.WriteFile(filepath.Join(w.home, "outside.txt"), []byte("outside\n"), 0o600); err != nil {
			t.Fatalf("seed outside.txt: %v", err)
		}
		if err := os.Symlink(filepath.Join(w.home, "outside.txt"), filepath.Join(w.old, "latest-link")); err != nil {
			t.Fatalf("symlink latest-link: %v", err)
		}

		MigrateStateDir(t.Context(), "acme", w.env, w.log)

		if got := readWorldFile(t, filepath.Join(w.fresh, "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want %q", got, "{}")
		}
		if got := readWorldFile(t, filepath.Join(w.fresh, "jobs", "a")); got != "job a" {
			t.Fatalf("jobs/a = %q, want %q", got, "job a")
		}
		if got := readWorldFile(t, filepath.Join(w.fresh, "router", "router.log")); got != "log\n" {
			t.Fatalf("router.log = %q, want %q", got, "log\n")
		}
		// A symlink moves as the link it is: still pointing out of the dir, whose target is
		// never touched.
		info, err := os.Lstat(filepath.Join(w.fresh, "latest-link"))
		if err != nil {
			t.Fatalf("lstat latest-link: %v", err)
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			t.Fatal("latest-link moved as something other than a symlink")
		}
		if got := readWorldFile(t, filepath.Join(w.fresh, "latest-link")); got != "outside\n" {
			t.Fatalf("latest-link reads %q, want %q", got, "outside\n")
		}
		if got := readWorldFile(t, filepath.Join(w.home, "outside.txt")); got != "outside\n" {
			t.Fatalf("outside.txt = %q, want %q", got, "outside\n")
		}
		mustBeGone(t, w.old)
		fresh, err := os.Stat(w.fresh)
		if err != nil {
			t.Fatalf("stat %s: %v", w.fresh, err)
		}
		if fresh.Mode().Perm() != 0o700 {
			t.Fatalf("new dir mode = %o, want 700", fresh.Mode().Perm())
		}
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
	})

	t.Run("a partial move: an entry the new dir already has is left in the old dir, never overwritten", func(t *testing.T) {
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "old ledger", "jobs/a": "job a"})
		if err := os.MkdirAll(w.fresh, 0o700); err != nil {
			t.Fatalf("mkdir the new dir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(w.fresh, "ledger.json"), []byte("new ledger"), 0o600); err != nil {
			t.Fatalf("seed the new ledger: %v", err)
		}

		MigrateStateDir(t.Context(), "acme", w.env, w.log)

		if got := readWorldFile(t, filepath.Join(w.fresh, "ledger.json")); got != "new ledger" {
			t.Fatalf("new ledger.json = %q, want it untouched", got)
		}
		if got := readWorldFile(t, filepath.Join(w.fresh, "jobs", "a")); got != "job a" {
			t.Fatalf("jobs/a = %q, want %q", got, "job a")
		}
		if got := readWorldFile(t, filepath.Join(w.old, "ledger.json")); got != "old ledger" {
			t.Fatalf("old ledger.json = %q, want it left behind", got)
		}
		if _, err := os.Stat(w.old); err != nil {
			t.Fatalf("the old dir is gone: %v", err)
		}
		if len(w.lines) != 1 || !containsAll(w.lines[0], "ledger.json left in", w.old) {
			t.Fatalf("logged %v, want one line naming ledger.json left in %s", w.lines, w.old)
		}
	})

	t.Run("a second run is a no-op: the old dir is gone, the moved state is untouched, nothing is logged", func(t *testing.T) {
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		MigrateStateDir(t.Context(), "acme", w.env, w.log)
		MigrateStateDir(t.Context(), "acme", w.env, w.log)
		if got := readWorldFile(t, filepath.Join(w.fresh, "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want %q", got, "{}")
		}
		mustBeGone(t, w.old)
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
	})

	t.Run("a failed move keeps everything in the old dir, logs one line, and the next start retries it", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}", "jobs/a": "job a"})
		if err := os.MkdirAll(w.fresh, 0o700); err != nil {
			t.Fatalf("mkdir the new dir: %v", err)
		}
		if err := os.Chmod(w.fresh, 0o500); err != nil {
			t.Fatalf("chmod the new dir: %v", err)
		}

		MigrateStateDir(t.Context(), "acme", w.env, w.log)
		if len(w.lines) != 1 || !containsAll(w.lines[0], "cannot move") {
			t.Fatalf("logged %v, want one cannot-move line", w.lines)
		}
		if got := readWorldFile(t, filepath.Join(w.old, "ledger.json")); got != "{}" {
			t.Fatalf("old ledger.json = %q, want it kept", got)
		}
		if got := readWorldFile(t, filepath.Join(w.old, "jobs", "a")); got != "job a" {
			t.Fatalf("old jobs/a = %q, want it kept", got)
		}

		if err := os.Chmod(w.fresh, 0o700); err != nil {
			t.Fatalf("chmod the new dir back: %v", err)
		}
		MigrateStateDir(t.Context(), "acme", w.env, w.log) // the next start moves what stayed behind
		if got := readWorldFile(t, filepath.Join(w.fresh, "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want %q", got, "{}")
		}
		if got := readWorldFile(t, filepath.Join(w.fresh, "jobs", "a")); got != "job a" {
			t.Fatalf("jobs/a = %q, want %q", got, "job a")
		}
		mustBeGone(t, w.old)
		if len(w.lines) != 1 {
			t.Fatalf("logged %v, want the one earlier line only", w.lines)
		}
	})

	t.Run("a new root that cannot be created leaves the old state alone and still logs one line", func(t *testing.T) {
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		if err := os.WriteFile(filepath.Join(w.home, ".agents"), []byte("a file, not a dir"), 0o600); err != nil {
			t.Fatalf("seed the blocking file: %v", err)
		}

		MigrateStateDir(t.Context(), "acme", w.env, w.log)

		if got := readWorldFile(t, filepath.Join(w.old, "ledger.json")); got != "{}" {
			t.Fatalf("old ledger.json = %q, want it kept", got)
		}
		if len(w.lines) != 1 || !containsAll(w.lines[0], "cannot create") {
			t.Fatalf("logged %v, want one cannot-create line", w.lines)
		}
	})

	t.Run("without XDG_STATE_HOME the old dir is still found at ~/.local/state", func(t *testing.T) {
		home := t.TempDir()
		old := filepath.Join(home, ".local", "state", "acme")
		if err := os.MkdirAll(old, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", old, err)
		}
		if err := os.WriteFile(filepath.Join(old, "ledger.json"), []byte("{}"), 0o600); err != nil {
			t.Fatalf("seed the old ledger: %v", err)
		}
		env := domain.EnvLookup{"HOME": home}
		if got := LegacyStateDir(env, "acme"); got != old {
			t.Fatalf("legacyStateDir = %q, want %q", got, old)
		}
		want := filepath.Join(home, ".agents", "acme")
		if got := AgentsStateDir(env, "acme"); got != want {
			t.Fatalf("agentsStateDir = %q, want %q", got, want)
		}

		var lines []string
		MigrateStateDir(t.Context(), "acme", env, func(line string) { lines = append(lines, line) })

		if got := readWorldFile(t, filepath.Join(home, ".agents", "acme", "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want %q", got, "{}")
		}
		mustBeGone(t, old)
	})

	t.Run("an old dir that is the new dir moves nothing and logs nothing", func(t *testing.T) {
		// XDG_STATE_HOME pointing at ~/.agents makes both ends of the move the same path.
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		w.env["XDG_STATE_HOME"] = filepath.Join(w.home, ".agents")
		w.old = LegacyStateDir(w.env, "acme")
		if err := os.MkdirAll(w.old, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", w.old, err)
		}
		if err := os.WriteFile(filepath.Join(w.old, "ledger.json"), []byte("kept"), 0o600); err != nil {
			t.Fatalf("seed the ledger: %v", err)
		}

		MigrateStateDir(t.Context(), "acme", w.env, w.log)

		if got := readWorldFile(t, filepath.Join(w.old, "ledger.json")); got != "kept" {
			t.Fatalf("ledger.json = %q, want %q", got, "kept")
		}
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
	})
}

func TestLegacyAndAgentsStateDir(t *testing.T) {
	t.Run("XDG_STATE_HOME names the old root outright", func(t *testing.T) {
		env := domain.EnvLookup{"HOME": "/h", "XDG_STATE_HOME": "/xdg"}
		if got := LegacyStateDir(env, "acme"); got != filepath.Join("/xdg", "acme") {
			t.Fatalf("legacyStateDir = %q, want %q", got, filepath.Join("/xdg", "acme"))
		}
		if got := AgentsStateDir(env, "acme"); got != filepath.Join("/h", ".agents", "acme") {
			t.Fatalf("agentsStateDir = %q, want %q", got, filepath.Join("/h", ".agents", "acme"))
		}
	})
}

func TestHomeDir(t *testing.T) {
	t.Run("takes HOME from the env map, empty or not", func(t *testing.T) {
		if got := homeDir(domain.EnvLookup{"HOME": ""}); got != "" {
			t.Fatalf("homeDir(empty HOME) = %q, want empty", got)
		}
	})

	t.Run("falls back to the process home when the map has no HOME", func(t *testing.T) {
		t.Setenv("HOME", "/process-home")
		if got := homeDir(domain.EnvLookup{}); got != "/process-home" {
			t.Fatalf("homeDir(no map HOME) = %q, want /process-home", got)
		}
	})

	t.Run("is empty when no home can be named", func(t *testing.T) {
		t.Setenv("HOME", "/restored-later")
		if err := os.Unsetenv("HOME"); err != nil {
			t.Fatalf("unsetenv HOME: %v", err)
		}
		if got := homeDir(domain.EnvLookup{}); got != "" {
			t.Fatalf("homeDir(no HOME anywhere) = %q, want empty", got)
		}
	})
}

func TestMigrateHelpers(t *testing.T) {
	t.Run("occupied counts a broken symlink", func(t *testing.T) {
		dir := t.TempDir()
		broken := filepath.Join(dir, "broken")
		if err := os.Symlink(filepath.Join(dir, "nowhere"), broken); err != nil {
			t.Fatalf("symlink broken: %v", err)
		}
		if !occupied(broken) {
			t.Fatal("a broken symlink counts as unoccupied")
		}
	})

	t.Run("occupied is false only for a missing path", func(t *testing.T) {
		dir := t.TempDir()
		present := filepath.Join(dir, "file")
		if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
			t.Fatalf("seed file: %v", err)
		}
		if !occupied(present) {
			t.Fatal("a file counts as unoccupied")
		}
		if occupied(filepath.Join(dir, "gone")) {
			t.Fatal("a missing path counts as occupied")
		}
	})

	t.Run("entriesOf is nil for a dir it cannot read", func(t *testing.T) {
		if got := entriesOf(filepath.Join(t.TempDir(), "gone")); got != nil {
			t.Fatalf("entriesOf(missing) = %v, want nil", got)
		}
	})

	t.Run("entriesOf lists the top-level names", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"b", "a", "nested"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
				t.Fatalf("seed %s: %v", name, err)
			}
		}
		want := []string{"a", "b", "nested"}
		if got := entriesOf(dir); !slices.Equal(got, want) {
			t.Fatalf("entriesOf = %v, want %v", got, want)
		}
	})

	t.Run("lostRace is only another migrator's errno", func(t *testing.T) {
		for _, errno := range []syscall.Errno{syscall.ENOENT, syscall.EEXIST, syscall.ENOTEMPTY} {
			if !lostRace(errno) {
				t.Fatalf("lostRace(%v) = false, want true", errno)
			}
		}
		if lostRace(syscall.EACCES) {
			t.Fatal("lostRace(EACCES) = true, want false")
		}
		if lostRace(errors.New("not an errno")) {
			t.Fatal("lostRace(plain error) = true, want false")
		}
	})
}

func TestSettleOldDir(t *testing.T) {
	t.Run("removes the old dir once it is empty", func(t *testing.T) {
		from := t.TempDir()
		var lines []string
		log := func(line string) { lines = append(lines, line) }
		settleOldDir(from, t.TempDir(), log)
		mustBeGone(t, from)
		if len(lines) != 0 {
			t.Fatalf("logged %v, want nothing", lines)
		}
	})

	t.Run("logs what stays behind and why", func(t *testing.T) {
		from := t.TempDir()
		if err := os.WriteFile(filepath.Join(from, "ledger.json"), []byte("old"), 0o600); err != nil {
			t.Fatalf("seed the leftover: %v", err)
		}
		to := t.TempDir()
		var lines []string
		settleOldDir(from, to, func(line string) { lines = append(lines, line) })
		if _, err := os.Stat(from); err != nil {
			t.Fatalf("the old dir was removed despite a leftover: %v", err)
		}
		if len(lines) != 1 || !containsAll(lines[0], "ledger.json left in", from, to) {
			t.Fatalf("logged %v, want one line naming the leftover, %s and %s", lines, from, to)
		}
	})

	t.Run("is silent when the old dir is already gone", func(t *testing.T) {
		var lines []string
		settleOldDir(filepath.Join(t.TempDir(), "gone"), t.TempDir(), func(line string) { lines = append(lines, line) })
		if len(lines) != 0 {
			t.Fatalf("logged %v, want nothing", lines)
		}
	})
}

func TestMoveEntries(t *testing.T) {
	t.Run("a destination that vanished mid-move is a lost race, not a failure", func(t *testing.T) {
		// Another migrator removed the destination between the listing and the rename: every
		// rename fails ENOENT, which is a race to skip, so nothing is logged and nothing moves.
		w := newMigrateWorld(t, "acme", map[string]string{"ledger.json": "{}", "jobs/a": "job a"})
		gone := filepath.Join(t.TempDir(), "nowhere")
		if stopped := moveEntries("acme", w.old, gone, nil, w.log); stopped {
			t.Fatal("a vanished destination stopped the move")
		}
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
		if got := readWorldFile(t, filepath.Join(w.old, "ledger.json")); got != "{}" {
			t.Fatalf("old ledger.json = %q, want it kept", got)
		}
	})
}

// containsAll reports whether text contains every part, in order-independent fashion.
func containsAll(text string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(text, part) {
			return false
		}
	}
	return true
}

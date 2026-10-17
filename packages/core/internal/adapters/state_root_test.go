package adapters

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The state-root rule's cases: inputs and expected outputs. The providers are reference
// fixtures; only the names a rule reads are filled in.

var referenceProvider = domain.Provider{Name: "zai", EnvPrefix: "ZAI"}

var acmeProvider = domain.Provider{Name: "acme", EnvPrefix: "ACME"}

// referenceStateRoot is the reference provider's state-root rule.
var referenceStateRoot = StateRootRule{EnvVar: "ZAI_STATE_DIR", DataPrefix: "zai-", XdgName: "zai"}

var acmeStateRoot = StateRootRule{EnvVar: "ACME_STATE_DIR", DataPrefix: "acme-plugin-", XdgName: "acme"}

// quietLog keeps the migration's error lines off the test output; these cases assert roots only.
func quietLog(string) {}

func TestResolveStateRoot(t *testing.T) {
	t.Run("zai: its env var, else ~/.agents/zai, with or without CLAUDE_PLUGIN_DATA", func(t *testing.T) {
		assertStateRoots(t, referenceStateRoot, "ZAI_STATE_DIR", "/data/zai-plugin-cc-m", "zai")
	})

	t.Run("a second provider: its env var, else ~/.agents/<name>, with or without CLAUDE_PLUGIN_DATA", func(t *testing.T) {
		assertStateRoots(t, acmeStateRoot, "ACME_STATE_DIR", "/data/acme-plugin-m", "acme")
	})

	t.Run("never reads another provider's env var or data dir", func(t *testing.T) {
		zaiOwn := domain.EnvLookup{
			"ZAI_STATE_DIR":      "/zai",
			"CLAUDE_PLUGIN_DATA": "/data/zai-plugin-cc-m",
			"HOME":               "/h",
		}
		acmeOwn := domain.EnvLookup{
			"ACME_STATE_DIR":     "/acme",
			"CLAUDE_PLUGIN_DATA": "/data/acme-plugin-m",
			"HOME":               "/h",
		}

		if got := ResolveStateRoot(t.Context(), zaiOwn, acmeStateRoot, quietLog); got != filepath.Join("/h", ".agents", "acme") {
			t.Fatalf("resolveStateRoot(zai's world, acme rule) = %q, want %q", got, filepath.Join("/h", ".agents", "acme"))
		}
		if got := ResolveStateRoot(t.Context(), acmeOwn, referenceStateRoot, quietLog); got != filepath.Join("/h", ".agents", "zai") {
			t.Fatalf("resolveStateRoot(acme's world, reference rule) = %q, want %q", got, filepath.Join("/h", ".agents", "zai"))
		}
	})

	t.Run("stateRootRule derives each provider's rule from its own names", func(t *testing.T) {
		if got := NewStateRootRule(referenceProvider); got != referenceStateRoot {
			t.Fatalf("stateRootRule(reference) = %+v, want %+v", got, referenceStateRoot)
		}
		want := StateRootRule{EnvVar: "ACME_STATE_DIR", DataPrefix: "acme-", XdgName: "acme"}
		if got := NewStateRootRule(acmeProvider); got != want {
			t.Fatalf("stateRootRule(acme) = %+v, want %+v", got, want)
		}
	})
}

// assertStateRoots is the shared body of the it.each rows: the env var wins, then ~/.agents —
// CLAUDE_PLUGIN_DATA never picks the root, because Claude Code sets it only for hooks and the
// hooks must find the setup-done and pid files setup and the router wrote (XDG_STATE_HOME no
// longer picks the root either; the migrations look there for old state instead).
func assertStateRoots(t *testing.T, rule StateRootRule, envVar, own, name string) {
	t.Helper()
	agents := filepath.Join("/h", ".agents", name)
	cases := []struct {
		env  domain.EnvLookup
		want string
	}{
		{
			domain.EnvLookup{envVar: "/explicit", "CLAUDE_PLUGIN_DATA": own, "HOME": "/h"},
			"/explicit",
		},
		{
			domain.EnvLookup{"CLAUDE_PLUGIN_DATA": own, "XDG_STATE_HOME": "/xdg", "HOME": "/h"},
			agents,
		},
		{
			domain.EnvLookup{"XDG_STATE_HOME": "/xdg", "HOME": "/h"},
			agents,
		},
		{
			domain.EnvLookup{"HOME": "/h"},
			agents,
		},
	}
	for _, tc := range cases {
		if got := ResolveStateRoot(t.Context(), tc.env, rule, quietLog); got != tc.want {
			t.Fatalf("resolveStateRoot(%v) = %q, want %q", tc.env, got, tc.want)
		}
	}
}

func TestStateRoot(t *testing.T) {
	t.Run("derives the rule and resolves the root for a whole provider", func(t *testing.T) {
		if got := StateRoot(t.Context(), referenceProvider, domain.EnvLookup{"ZAI_STATE_DIR": "/explicit"}); got != "/explicit" {
			t.Fatalf("stateRoot(reference) = %q, want %q", got, "/explicit")
		}
		if got := StateRoot(t.Context(), acmeProvider, domain.EnvLookup{"HOME": "/h"}); got != filepath.Join("/h", ".agents", "acme") {
			t.Fatalf("stateRoot(acme) = %q, want %q", got, filepath.Join("/h", ".agents", "acme"))
		}
	})

	t.Run("a data dir named without a slash leaves the root at ~/.agents too", func(t *testing.T) {
		env := domain.EnvLookup{"CLAUDE_PLUGIN_DATA": "zai-plugin-m", "HOME": "/h"}
		if got := ResolveStateRoot(t.Context(), env, referenceStateRoot, quietLog); got != filepath.Join("/h", ".agents", "zai") {
			t.Fatalf("resolveStateRoot(relative own data dir) = %q, want %q", got, filepath.Join("/h", ".agents", "zai"))
		}
	})
}

// newDataWorld is a home whose provider's own Claude Code data dir holds entries, for the
// data-dir migration's cases.
func newDataWorld(t *testing.T, entries map[string]string) (home, data string, env domain.EnvLookup) {
	t.Helper()
	home = t.TempDir()
	data = filepath.Join(home, "claude", "plugins", "data", "zai-plugin-cc-m")
	for entry, content := range entries {
		file := filepath.Join(data, entry)
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(file), err)
		}
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatalf("seed %s: %v", file, err)
		}
	}
	return home, data, domain.EnvLookup{"HOME": home, "CLAUDE_PLUGIN_DATA": data}
}

func TestMigratePluginDataState(t *testing.T) {
	t.Run("moves state the agents dir lacks, once, and never removes the data dir", func(t *testing.T) {
		home, data, env := newDataWorld(t, map[string]string{
			"setup-done":        "true\n",
			"ledger.json":       "{}",
			"jobs/a":            "job a",
			"router/router.log": "log\n",
			UninstallMarkerName: "installed by setup\n",
			"claude-home/.keep": "",
		})
		var lines []string
		log := func(line string) { lines = append(lines, line) }
		fresh := filepath.Join(home, ".agents", "zai")
		if got := ResolveStateRoot(t.Context(), env, referenceStateRoot, log); got != fresh {
			t.Fatalf("resolveStateRoot = %q, want %q", got, fresh)
		}
		moved := map[string]string{
			"setup-done":        "true\n",
			"ledger.json":       "{}",
			"jobs/a":            "job a",
			"router/router.log": "log\n",
		}
		for entry, want := range moved {
			text, err := os.ReadFile(filepath.Join(fresh, entry))
			if err != nil {
				t.Fatalf("read %s: %v", entry, err)
			}
			if string(text) != want {
				t.Fatalf("%s = %q, want %q", entry, text, want)
			}
		}
		if _, err := os.Stat(filepath.Join(fresh, "claude-home")); err != nil {
			t.Fatalf("claude-home did not move: %v", err)
		}
		text, err := os.ReadFile(filepath.Join(data, UninstallMarkerName))
		if err != nil || string(text) != "installed by setup\n" {
			t.Fatalf("the uninstall marker moved or changed: %q %v", text, err)
		}
		if _, err := os.Stat(filepath.Join(fresh, UninstallMarkerName)); !os.IsNotExist(err) {
			t.Fatal("the uninstall marker was copied into the agents dir")
		}
		if _, err := os.Stat(data); err != nil {
			t.Fatalf("the data dir did not survive: %v", err)
		}
		if len(lines) != 0 {
			t.Fatalf("logged %v, want nothing", lines)
		}

		ResolveStateRoot(t.Context(), env, referenceStateRoot, log) // once: the second pass finds nothing new
		if len(lines) != 0 {
			t.Fatalf("logged %v on the second pass, want nothing", lines)
		}
		if _, err := os.Stat(data); err != nil {
			t.Fatalf("the data dir did not survive the second pass: %v", err)
		}
	})

	t.Run("an entry the agents dir already has stays in the data dir, never overwritten", func(t *testing.T) {
		home, data, env := newDataWorld(t, map[string]string{"ledger.json": "data ledger"})
		fresh := filepath.Join(home, ".agents", "zai")
		if err := os.MkdirAll(fresh, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fresh, "ledger.json"), []byte("agents ledger"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := ResolveStateRoot(t.Context(), env, referenceStateRoot, quietLog); got != fresh {
			t.Fatalf("resolveStateRoot = %q, want %q", got, fresh)
		}
		if text, err := os.ReadFile(filepath.Join(fresh, "ledger.json")); err != nil || string(text) != "agents ledger" {
			t.Fatalf("the agents ledger = %q %v, want it untouched", text, err)
		}
		if text, err := os.ReadFile(filepath.Join(data, "ledger.json")); err != nil || string(text) != "data ledger" {
			t.Fatalf("the data-dir ledger = %q %v, want it left behind", text, err)
		}
	})

	t.Run("a data dir that belongs to another plugin is never read", func(t *testing.T) {
		home := t.TempDir()
		data := filepath.Join(home, "claude", "plugins", "data", "huddle-muhmdraouf")
		if err := os.MkdirAll(filepath.Join(data, "jobs"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(data, "jobs", "a"), []byte("another plugin's"), 0o600); err != nil {
			t.Fatal(err)
		}
		env := domain.EnvLookup{"HOME": home, "CLAUDE_PLUGIN_DATA": data}
		fresh := filepath.Join(home, ".agents", "zai")
		if got := ResolveStateRoot(t.Context(), env, referenceStateRoot, quietLog); got != fresh {
			t.Fatalf("resolveStateRoot = %q, want %q", got, fresh)
		}
		if _, err := os.Stat(filepath.Join(fresh, "jobs")); !os.IsNotExist(err) {
			t.Fatal("another plugin's data dir was read")
		}
	})

	t.Run("a data dir that is the agents dir moves nothing", func(t *testing.T) {
		home := t.TempDir()
		same := filepath.Join(home, ".agents", "acme")
		if err := os.MkdirAll(same, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(same, "ledger.json"), []byte("kept"), 0o600); err != nil {
			t.Fatal(err)
		}
		// A rule whose data-dir prefix matches the agents dir's own name, so from and to coincide.
		rule := StateRootRule{EnvVar: "ACME_STATE_DIR", DataPrefix: "acme", XdgName: "acme"}
		env := domain.EnvLookup{"HOME": home, "CLAUDE_PLUGIN_DATA": same}
		var lines []string
		log := func(line string) { lines = append(lines, line) }
		if got := ResolveStateRoot(t.Context(), env, rule, log); got != same {
			t.Fatalf("resolveStateRoot = %q, want %q", got, same)
		}
		if text, err := os.ReadFile(filepath.Join(same, "ledger.json")); err != nil || string(text) != "kept" {
			t.Fatalf("ledger.json = %q %v, want kept", text, err)
		}
		if len(lines) != 0 {
			t.Fatalf("logged %v, want nothing", lines)
		}
	})
}

func TestStderrLog(t *testing.T) {
	t.Run("writes the line to stderr", func(t *testing.T) {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
		oldStderr := os.Stderr
		os.Stderr = writer
		stderrLog("state migrate: a line")
		os.Stderr = oldStderr
		if err := writer.Close(); err != nil {
			t.Fatalf("close the pipe's writer: %v", err)
		}
		text, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read the pipe: %v", err)
		}
		if string(text) != "state migrate: a line\n" {
			t.Fatalf("stderrLog wrote %q, want %q", text, "state migrate: a line\n")
		}
	})
}

func TestNodeBasename(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"/home/u/.claude/plugins/data/zai-muhmdraouf", "zai-muhmdraouf"},
		{"/a/b/", ""},
		{"", ""},
		{"zai-x", "zai-x"},
	}
	for _, c := range cases {
		if got := nodeBasename(c.path); got != c.want {
			t.Errorf("nodeBasename(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

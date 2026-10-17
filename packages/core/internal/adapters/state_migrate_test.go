// The router-dependent cases of the state migration: the default roots that move old state over
// (resolveStateRoot, radarHome, routersHome). The MigrateStateDir scenarios themselves are
// state_migrate_internal_test.go's.
package adapters_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
)

// A rule like zai's, under a name no other test uses.
var migrateRule = adapters.StateRootRule{EnvVar: "ACME_STATE_DIR", DataPrefix: "acme-plugin-", XdgName: "acme"}

// migrateWorld is a world with HOME, XDG_STATE_HOME and an old state dir for name inside one temp
// dir.
type migrateWorld struct {
	home  string
	xdg   string
	old   string
	fresh string
	env   domain.EnvLookup
	lines []string
	log   func(line string)
}

func newWorld(t *testing.T, name string, entries map[string]string) *migrateWorld {
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
		fresh: adapters.AgentsStateDir(domain.EnvLookup{"HOME": home}, name),
		env:   domain.EnvLookup{"HOME": home, "XDG_STATE_HOME": xdg},
	}
	w.log = func(line string) { w.lines = append(w.lines, line) }
	return w
}

func worldText(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(text)
}

func worldHas(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false
	}
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return true
}

func TestTheDefaultRootsMigrateTheOldStateOnce(t *testing.T) {
	t.Run("resolveStateRoot: ~/.agents/<name>, with XDG_STATE_HOME only where the migration looks for old state", func(t *testing.T) {
		w := newWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		if got := adapters.ResolveStateRoot(t.Context(), w.env, migrateRule, w.log); got != w.fresh {
			t.Fatalf("resolveStateRoot = %q, want %q", got, w.fresh)
		}
		if got := worldText(t, filepath.Join(w.fresh, "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want it moved", got)
		}
		if worldHas(t, w.old) {
			t.Fatal("the old dir survived the move")
		}
		if len(w.lines) != 0 {
			t.Fatalf("logged %v, want nothing", w.lines)
		}
	})

	t.Run("an explicit env var skips the migrations entirely; the plugin's own data dir pins nothing", func(t *testing.T) {
		withEnv := newWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		pinned := domain.EnvLookup{}
		for key, value := range withEnv.env {
			pinned[key] = value
		}
		pinned["ACME_STATE_DIR"] = "/explicit"
		if got := adapters.ResolveStateRoot(t.Context(), pinned, migrateRule, withEnv.log); got != "/explicit" {
			t.Fatalf("resolveStateRoot(env var) = %q, want /explicit", got)
		}
		if worldHas(t, withEnv.fresh) {
			t.Fatal("the migration ran despite the explicit env var")
		}
		if !worldHas(t, withEnv.old) {
			t.Fatal("the old dir did not survive the skipped migration")
		}

		withData := newWorld(t, "acme", map[string]string{"ledger.json": "{}"})
		withData.env["CLAUDE_PLUGIN_DATA"] = "/data/acme-plugin-muhmdraouf"
		if got := adapters.ResolveStateRoot(t.Context(), withData.env, migrateRule, withData.log); got != withData.fresh {
			t.Fatalf("resolveStateRoot(own data dir) = %q, want %q", got, withData.fresh)
		}
		if got := worldText(t, filepath.Join(withData.fresh, "ledger.json")); got != "{}" {
			t.Fatalf("ledger.json = %q, want it moved", got)
		}
		if worldHas(t, withData.old) {
			t.Fatal("the old dir survived the move")
		}
	})

	t.Run("radarHome moves an old radar dir over; both homes' env overrides skip the migration", func(t *testing.T) {
		radar := newWorld(t, "radar", map[string]string{"port": "1234\n"})
		if got := spool.RadarHome(radar.env); got != filepath.Join(radar.home, ".agents", "radar") {
			t.Fatalf("radarHome = %q, want the ~/.agents one", got)
		}
		if got := worldText(t, filepath.Join(radar.home, ".agents", "radar", "port")); got != "1234\n" {
			t.Fatalf("the radar port file = %q, want it moved", got)
		}
		if worldHas(t, radar.old) {
			t.Fatal("the old radar dir survived the move")
		}
		pinned := domain.EnvLookup{}
		for key, value := range radar.env {
			pinned[key] = value
		}
		pinned["RADAR_HOME"] = "/pin"
		if got := spool.RadarHome(pinned); got != "/pin" {
			t.Fatalf("radarHome(RADAR_HOME) = %q, want /pin", got)
		}

		routers := newWorld(t, "provider-routers", map[string]string{"zai.json": "{}\n"})
		if got := router.RoutersHome(routers.env, routers.log); got != filepath.Join(routers.home, ".agents", "provider-routers") {
			t.Fatalf("routersHome = %q, want the ~/.agents one", got)
		}
		if got := worldText(t, filepath.Join(routers.home, ".agents", "provider-routers", "zai.json")); got != "{}\n" {
			t.Fatalf("the zai entry = %q, want it moved", got)
		}
		pinnedRouters := domain.EnvLookup{}
		for key, value := range routers.env {
			pinnedRouters[key] = value
		}
		pinnedRouters["PROVIDER_ROUTERS_HOME"] = "/own"
		if got := router.RoutersHome(pinnedRouters, nil); got != "/own" {
			t.Fatalf("routersHome(PROVIDER_ROUTERS_HOME) = %q, want /own", got)
		}
	})
}
